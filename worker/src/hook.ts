import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Cron, iso, processIdentity, time } from './cron.js';
import type { CronUpdate } from './cron-update.js';
import { Failure, cause, requireValue } from './errors.js';
import { agentTasksHeader, hookInstallation, hookTaskCapability } from './hook-setup.js';
import { HookOps, hookOpFile } from './hook-ops.js';
import { HookTasks, hookTaskFile } from './hook-task.js';
import { encode, identifier, integer, object, text, type ObjectValue } from './json.js';
import { prepareMedia } from './media.js';
import { job as validateJob } from './protocol.js';
import { updateContract } from './update-archive.js';
import { weeklyUsageHeaders } from './weekly-usage.js';

const claimFile = 'cron-claim.json';
const tickFile = 'cron-tick.json';
export const tickHealthFile = 'hook-tick-health.json';
const usageIntervalMs = 45_000;
const run = promisify(execFile);

export type Action = { kind: 'silent' | 'wake'; reason: string; payload?: ObjectValue };
export type Tick = { checker_job_id: string; checker_run_id: string; scheduled_at: string; entered_at: string };
export type EmitHook = (runtime: string, action: Action) => Promise<string>;

export const emitHook: EmitHook = async (runtime, action) => {
  const args = ['-c', 'set -euo pipefail; source "$1" >&2; declare -F silent wake >/dev/null; action=$2; shift 2; "$action" "$@"',
    'aaa-muse-hook', runtime, action.kind, action.reason];
  if (action.payload) args.push(encode(action.payload));
  try {
    return (await run('bash', args, { maxBuffer: 8192, timeout: 5000, killSignal: 'SIGKILL' })).stdout;
  } catch (error) {
    const exit = (error as { code?: unknown }).code;
    throw new Failure('hook_runtime_failed', { action: action.kind, cause: cause(error),
      exit_code: typeof exit === 'number' ? exit : null, runtime_output_omitted: true,
      corrective_action: 'Inspect the exact managed hook and its runtime log in the main Muse chat.' });
  }
};

function silent(reason: string): Action { return { kind: 'silent', reason }; }

function terminalRefusal(error: unknown): boolean {
  return error instanceof Failure && error.code === 'broker_rejected' && error.fields.reason === 'hook_claim_terminal';
}

function wireRun(invocation: string): string { return identifier('event-hook-' + invocation); }

export async function bootIdentity(pid: number): Promise<string> {
  const process = await processIdentity(pid);
  requireValue(process, 'hook_boot_identity_unavailable');
  return process.boot;
}

export class HookRunner {
  constructor(readonly claims: Cron, readonly updater: CronUpdate, readonly emit: EmitHook = emitHook, readonly boot = bootIdentity,
    readonly ops = new HookOps(claims.worker), readonly tasks = new HookTasks(claims.worker)) {}

  get worker() { return this.claims.worker; }
  get state() { return this.worker.state; }

  private read(name: string) { return this.worker.readRecord(this.state, name); }
  private save(name: string, value: Record<string, unknown>) { return this.state.write(name, encode(value)); }

  async check(env: Record<string, string | undefined>): Promise<string> {
    const runtime = env.HATCH_HOOK_RUNTIME;
    requireValue(runtime, 'hook_runtime_required');
    const registration = await this.read(hookInstallation);
    if (!registration) {
      await this.worker.logger.log('DEBUG', 'hook.check', { outcome: 'registration_unverified' });
      return this.emit(runtime, silent('registration_unverified'));
    }
    const hookID = identifier(env.HATCH_HOOK_ID);
    const invocation = identifier(env.HATCH_HOOK_INVOCATION_ID);
    wireRun(invocation);
    requireValue(registration.hook_id === hookID, 'foreign_hook', { expected_hook_id: registration.hook_id, observed_hook_id: hookID });
    let release;
    try { release = await this.state.lock('hook', false); }
    catch (error) {
      if (cause(error) !== 'subscriber_already_running') throw error;
      await this.worker.logger.log('DEBUG', 'hook.check', { hook_id: hookID, invocation_id: invocation, outcome: 'tick_in_flight' });
      return this.emit(runtime, silent('tick_in_flight'));
    }
    try {
      const last = await this.read(tickHealthFile);
      if (last?.invocation_id === invocation && last.last_outcome !== 'checking' && last.last_outcome !== 'check_failed') {
        return this.emit(runtime, silent('occurrence_replayed'));
      }
      const started = this.state.sys.now();
      const scheduled = Math.max(started, last?.scheduled_at ? time(last.scheduled_at) + 1 : started);
      const health = { hook_id: hookID, invocation_id: invocation, last_tick_at: iso(started), last_success_at: last?.last_success_at,
        scheduled_at: scheduled > started ? last?.scheduled_at : iso(scheduled), boot_id: await this.boot(this.state.sys.pid) };
      await this.save(tickHealthFile, { ...health, last_outcome: 'checking' });
      try {
        const tick = { checker_job_id: hookID, checker_run_id: invocation, scheduled_at: iso(scheduled), entered_at: iso(started) };
        const action = scheduled > started ? silent('clock_regressed') : await this.tick(tick, health.boot_id);
        if (action.reason === 'clock_regressed') await this.worker.logger.log('WARN', 'hook.clock_regressed', { ...health, entered_at: tick.entered_at });
        const output = await this.emit(runtime, action);
        await this.save(tickHealthFile, { ...health, last_outcome: action.reason,
          last_success_at: action.reason === 'clock_regressed' ? last?.last_success_at : iso(this.state.sys.now()) });
        await this.worker.logger.log(action.kind === 'wake' ? 'INFO' : 'DEBUG', 'hook.check', { ...health, ...action.payload,
          outcome: action.reason, duration_ms: this.state.sys.now() - started });
        return output;
      } catch (error) {
        await this.save(tickHealthFile, { ...health, last_outcome: 'check_failed', cause: cause(error) });
        throw error;
      }
    } finally { await release(); }
  }

  private async tick(tick: Tick, boot: string): Promise<Action> {
    const recovered = await this.updater.recover();
    if (recovered) return silent(text(recovered.outcome));
    const op = await this.read(hookOpFile);
    if (op) {
      await this.clearControlPull(op);
      return silent(await this.ops.recover(op));
    }
    const active = await this.read(claimFile);
    if (active) return this.active(active, tick);
    const capability = await hookTaskCapability(this.worker);
    const task = await this.read(hookTaskFile);
    if (task) {
      await this.clearControlPull(task);
      const saved = await this.read(tickFile) ?? {};
      const usage = await this.usage(saved, tick);
      if (usage) await this.save(tickFile, { ...saved, last_usage_at: usage.observed_at });
      return this.tasks.active(tick, capability, usage);
    }
    const saved = await this.read(tickFile) ?? {};
    const { pending, usage } = await this.pendingPull(saved, tick);
    const transport = await this.worker.load();
    const reply = await transport.request('/api/v1/worker/pull', 'POST', encode(pending), { ...pending, ...tick, pull_run_id: pending.checker_run_id,
      ...(usage ? { weekly_usage: usage } : {}) }, 1, 10_000,
    { ...await this.updater.contactHeaders(), ...weeklyUsageHeaders(usage), ...capability, 'X-Muse-Worker-Hook-Proof': '1' });
    const offers = [reply.data.job ?? undefined, reply.data.update, reply.data.worker_op, reply.data.agent_task];
    requireValue(offers.filter(offer => offer !== undefined).length <= 1, 'invalid_hook_pull_offer');
    if (reply.data.worker_op !== undefined) {
      await this.ops.saveGrant(reply.data.worker_op, pending);
      await this.clearPull(pending);
      const op = await this.read(hookOpFile);
      requireValue(op, 'invalid_hook_control_grant');
      return silent(await this.ops.recover(op));
    }
    if (reply.data.agent_task !== undefined) {
      requireValue(capability[agentTasksHeader] === '1', 'hook_prompt_unverified');
      await this.tasks.saveGrant(reply.data.agent_task, pending);
      await this.clearPull(pending);
      return this.tasks.active(tick, capability);
    }
    if (reply.data.job !== null) {
      requireValue(reply.data.update === undefined, 'invalid_update_offer');
      const grant = object(reply.data.job);
      const claimID = identifier(grant.claim_id);
      identifier(grant.job_id); identifier(grant.operation_id);
      requireValue(claimID.startsWith('hook-') && integer(grant.generation) > 0 && time(grant.deadline_at) >= time(grant.claimed_at),
        'invalid_hook_grant', { claim_id: claimID, request_id: reply.requestId });
      const claim = { ...grant, launch_id: this.state.sys.uuid(), producer_mode: 'guarded', execution_mode: updateContract,
        wake_hook_id: tick.checker_job_id, wake_invocation_id: pending.checker_run_id, boot_id: boot,
        checker_job_id: pending.checker_job_id, pull_run_id: pending.checker_run_id, sequence: pending.sequence };
      await this.state.withLock('cron', async () => {
        requireValue(!await this.read(claimFile), 'pull_grant_conflict');
        await this.save(claimFile, claim);
      });
      await this.worker.logger.log('INFO', 'hook.claim_observed', { ...this.claims.correlation(claim), request_id: reply.requestId,
        invocation_id: tick.checker_run_id });
      await this.clearPull(pending);
      return this.beforeWake(claim, tick);
    }
    await this.clearPull(pending);
    if (reply.data.update) return silent(text((await this.updater.offer(reply.data.update, transport, reply.requestId)).outcome));
    return silent('idle');
  }

  private async pendingPull(saved: ObjectValue, tick: Tick): Promise<{ pending: ObjectValue; usage?: ObjectValue }> {
    if (saved.pending) return { pending: object(saved.pending), usage: saved.weekly_usage ? object(saved.weekly_usage) : undefined };
    const sequence = (saved.sequence === undefined ? 0 : integer(saved.sequence)) + 1;
    const pending = { protocol_version: 1, sequence, ...tick, media_jobs: true, prompt_wav: true };
    const usage = await this.usage(saved, tick);
    await this.save(tickFile, { sequence, scheduled_at: tick.scheduled_at, pending, weekly_usage: usage,
      last_usage_at: usage?.observed_at ?? saved.last_usage_at });
    return { pending, usage };
  }

  private async usage(saved: ObjectValue, tick: Tick): Promise<ObjectValue | undefined> {
    const lastUsage = saved.last_usage_at ? time(saved.last_usage_at) : 0;
    const settled = await this.read('cron-last-receipt.json');
    if (lastUsage && this.state.sys.now() - lastUsage < usageIntervalMs &&
        !(settled && time(settled.settled_at) >= lastUsage)) return;
    const usage = await this.claims.weeklyUsage(tick);
    if (usage && time(usage.observed_at) >= time(tick.scheduled_at)) return usage;
  }

  private async clearControlPull(entry: ObjectValue): Promise<void> {
    const saved = await this.read(tickFile);
    if (saved?.pending && integer(saved.sequence) === integer(entry.pull_sequence)) {
      const pending = object(saved.pending);
      requireValue(pending.checker_run_id === entry.pull_occurrence, 'poll_grant_conflict');
      await this.clearPull(pending);
    }
  }

  private async clearPull(pending: ObjectValue): Promise<void> {
    const saved = await this.read(tickFile);
    requireValue(saved && integer(saved.sequence) === integer(pending.sequence) && encode(saved.pending) === encode(pending), 'poll_owner_changed');
    await this.save(tickFile, { sequence: saved.sequence, scheduled_at: saved.scheduled_at, last_usage_at: saved.last_usage_at });
  }

  private async reviseBeforeWake(previous: ObjectValue, change: ObjectValue): Promise<ObjectValue> {
    return this.state.withLock('cron', async () => {
      const claim = await this.read(claimFile);
      requireValue(claim && claim.claim_id === previous.claim_id && integer(claim.generation) === integer(previous.generation) &&
        claim.launch_id === previous.launch_id && claim.wake_invocation_id === previous.wake_invocation_id &&
        encode(claim.binding_intent ?? null) === encode(previous.binding_intent ?? null) &&
        !claim.wake_attempted_at && !claim.start_requested_at && !claim.failure, 'hook_wake_uncertain', this.claims.correlation(previous));
      const updated = { ...claim, ...change };
      await this.save(claimFile, updated);
      return updated;
    });
  }

  private async beforeWake(claim: ObjectValue, tick: Tick): Promise<Action> {
    requireValue(!claim.wake_attempted_at && !claim.start_requested_at, 'hook_wake_uncertain');
    if (this.state.sys.now() >= time(claim.deadline_at)) return this.expiredBeforeWake(claim, tick);
    const work = identifier(claim.job_id);
    const route = `/api/v1/worker/jobs/${work}/bind`;
    if (claim.binding_intent || claim.wake_invocation_id !== tick.checker_run_id) {
      const transport = await this.worker.load();
      // Finish an ambiguous binding before advancing to the current invocation.
      while (claim.binding_intent || claim.wake_invocation_id !== tick.checker_run_id) {
        const binding = claim.binding_intent ? object(claim.binding_intent) : {
          protocol_version: 1, submission_id: this.state.sys.uuid(), claim_id: claim.claim_id, generation: claim.generation,
          checker_job_id: tick.checker_job_id, previous_invocation_id: claim.wake_invocation_id, invocation_id: tick.checker_run_id,
        };
        claim = await this.reviseBeforeWake(claim, { binding_intent: binding });
        let reply;
        try { reply = await transport.request(route, 'POST', encode(binding), this.claims.correlation(claim), 1); }
        catch (error) {
          if (terminalRefusal(error)) return this.expiredBeforeWake(claim, tick);
          throw error;
        }
        requireValue(reply.data.job_id === work && reply.data.claim_id === claim.claim_id && reply.data.invocation_id === binding.invocation_id,
          'hook_binding_response_mismatch');
        claim = await this.reviseBeforeWake(claim, { wake_invocation_id: binding.invocation_id, binding_intent: null });
        await this.worker.logger.log('INFO', 'hook.binding_observed', { ...this.claims.correlation(claim), previous_invocation: binding.previous_invocation_id,
          request_id: reply.requestId, submission_id: binding.submission_id });
      }
    }
    if (this.state.sys.now() >= time(claim.deadline_at)) return this.expiredBeforeWake(claim, tick);
    claim = await this.reviseBeforeWake(claim, { wake_attempted_at: iso(this.state.sys.now()) });
    await this.worker.logger.log('INFO', 'hook.wake_intent', { ...this.claims.correlation(claim), emitted: 'unconfirmed', wake_attempted_at: claim.wake_attempted_at });
    return { kind: 'wake', reason: 'work_claimed', payload: { kind: 'inference', claim_id: claim.claim_id, launch_id: claim.launch_id, job_id: work,
      expected_run_id: 'event-hook:' + identifier(claim.wake_invocation_id) } };
  }

  private settlement(claim: ObjectValue, reason: string): ObjectValue {
    const unstarted = reason === 'launch_not_authorized';
    return { protocol_version: 1, submission_id: this.state.sys.uuid(), claim_id: claim.claim_id, generation: claim.generation,
      launch_id: claim.launch_id, native_job_id: unstarted ? '' : claim.wake_hook_id,
      native_run_id: unstarted ? '' : wireRun(identifier(claim.wake_invocation_id)), reason, verified_start: true };
  }

  private async expiredBeforeWake(claim: ObjectValue, tick: Tick): Promise<Action> {
    const settlement = this.settlement(claim, 'launch_not_authorized');
    const held = await this.reviseBeforeWake(claim, { failure: settlement });
    await this.claims.settle(held, settlement, tick.checker_run_id);
    return silent('work_settled');
  }

  private async active(claim: ObjectValue, tick: Tick): Promise<Action> {
    requireValue(claim.execution_mode === updateContract && claim.wake_hook_id === tick.checker_job_id &&
      identifier(claim.claim_id).startsWith('hook-'), 'invalid_hook_claim');
    const poll = await this.read(tickFile);
    if (poll?.pending && integer(poll.sequence) === integer(claim.sequence)) {
      const pending = object(poll.pending);
      requireValue(pending.checker_run_id === claim.pull_run_id && pending.checker_job_id === claim.wake_hook_id, 'poll_grant_conflict');
      await this.clearPull(pending);
    }
    if (!claim.wake_attempted_at && !claim.failure) return this.beforeWake(claim, tick);
    if (claim.pending_result && !claim.receipt && !claim.result_refusal && !claim.failure && !await this.claims.deliveryBlock(claim)) {
      await this.claims.replayResult(identifier(claim.job_id));
    }
    const status = await this.state.withLock('cron', async () => {
      const current = await this.read(claimFile);
      requireValue(current?.claim_id === claim.claim_id, 'stale_native_launch');
      const block = await this.claims.stoppedBlock(current);
      if (!block && (current.failure || object(current.receipt ?? {}).accepted === true)) {
        if (!current.failure) {
          current.failure = this.settlement(current, 'execution_confirmed_stopped');
          await this.save(claimFile, current);
        }
        return { current, settle: true };
      }
      return { current, holdReason: block?.cause };
    });
    if (status.settle) {
      await this.claims.settle(status.current, object(status.current.failure), tick.checker_run_id);
      return silent('work_settled');
    }
    if (tick.checker_run_id !== status.current.wake_invocation_id) {
      const saved = await this.read(tickFile) ?? {};
      const usage = await this.usage(saved, tick);
      if (usage) await this.save(tickFile, { ...saved, last_usage_at: usage.observed_at });
      const reason = status.holdReason ?? (this.state.sys.now() >= time(status.current.deadline_at) ? 'native_observation_pending' : undefined);
      await this.claims.reportPresence(status.current, tick, reason, usage, false);
    }
    return silent('claim_active');
  }

  private async current(launch: string, runID: string): Promise<ObjectValue> {
    const active = await this.read(claimFile);
    requireValue(active?.execution_mode === updateContract && active.launch_id === identifier(launch) && active.wake_attempted_at,
      'stale_hook_launch', { launch_id: launch });
    const invocation = identifier(active.wake_invocation_id);
    requireValue(runID === 'event-hook:' + invocation, 'hook_run_mismatch', { ...this.claims.correlation(active), expected_run_id: 'event-hook:' + invocation,
      observed_run_id: /^event-hook:[A-Za-z0-9_-]{1,89}$/.test(runID) ? runID : null, corrective_action: 'Use the actual wake run ID for this claim.' });
    return active;
  }

  async start(launch: string, runID: string): Promise<ObjectValue> {
    const claim = await this.state.withLock('cron', async () => {
      const active = await this.current(launch, runID);
      requireValue(!active.start_requested_at && !active.failure, 'work_already_started', this.claims.correlation(active));
      active.start_requested_at = iso(this.state.sys.now());
      active.native_job_id = active.wake_hook_id;
      active.native_run_id = wireRun(identifier(active.wake_invocation_id));
      await this.save(claimFile, active);
      return active;
    });
    const id = identifier(claim.job_id);
    const transport = await this.worker.load();
    const details = this.claims.correlation(claim);
    let reply;
    try {
      reply = await transport.request(`/api/v1/worker/jobs/${id}/start`, 'POST', encode({
        protocol_version: 1, claim_id: claim.claim_id, generation: claim.generation, launch_id: launch, native_job_id: claim.native_job_id,
        verification: { reference: claim.claim_id, native_job_id: claim.native_job_id, native_run_id: claim.native_run_id, status: 'running' },
      }), details, 1);
    } catch (error) {
      if (terminalRefusal(error)) await this.state.withLock('cron', async () => {
        const active = await this.current(launch, runID);
        active.failure = this.settlement(active, 'launch_not_authorized');
        await this.save(claimFile, active);
      });
      throw error;
    }
    const brief = validateJob(reply.data, identifier(this.worker.config.worker_id), id);
    requireValue(brief.lease_id === claim.claim_id && integer(brief.generation) === integer(claim.generation) &&
      brief.native_job_id === claim.native_job_id && brief.launch_id === launch && brief.state === 'claimed', 'work_start_response_mismatch', details);
    await this.state.withLock('cron', async () => {
      const active = await this.current(launch, runID);
      requireValue(!active.failure && !active.brief, 'stale_hook_launch', details);
      active.brief = brief;
      await this.save(claimFile, active);
    });
    await this.worker.logger.log('INFO', 'hook.work_started', { ...details, started_at: brief.started_at, request_id: reply.requestId });
    return brief.media ? { outcome: 'authorized', ...await prepareMedia(this.worker, transport, brief) } :
      { outcome: 'authorized', job_id: id, operation_id: claim.operation_id, context: brief.context };
  }

  async abort(launch: string, runID: string, reason: string): Promise<ObjectValue> {
    requireValue(['execution_failed', 'execution_refused'].includes(reason), 'invalid_hook_abort_reason');
    return this.state.withLock('cron', async () => {
      const claim = await this.current(launch, runID);
      const details = this.claims.correlation(claim);
      if (claim.failure) return { outcome: 'abort_saved', ...details };
      requireValue(!claim.receipt && (!claim.pending_result || claim.result_refusal) && (!claim.start_requested_at || claim.brief),
        'hook_abort_uncertain', details);
      const block = await this.claims.stoppedBlock(claim);
      requireValue(!block, 'hook_abort_producer_active', { ...details, ...block });
      claim.failure = this.settlement(claim, 'execution_confirmed_stopped');
      await this.save(claimFile, claim);
      await this.worker.logger.log('WARN', 'hook.abort_saved', { ...details, abort_reason: reason, settlement: claim.failure });
      return { outcome: 'abort_saved', ...details };
    });
  }
}
