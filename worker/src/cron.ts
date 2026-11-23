import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { Failure, cause, requireValue } from './errors.js';
import { decision, encode, identifier, integer, object, text, type ObjectValue, type Value } from './json.js';
import { prepareMedia, finishMedia } from './media.js';
import { job as validateJob } from './protocol.js';
import { Worker } from './worker.js';
import { presenceTimeoutMs } from './transport.js';

const interval = 60_000;
const pullAttemptWindow = 15_000;
const checkerHistoryLimit = 32;
const tickFile = 'cron-tick.json';
const occurrenceFile = 'cron-occurrence.json';
const claimFile = 'cron-claim.json';
const terminalNativeStates = ['completed', 'failed', 'cancelled'];
const nativeStates = ['queued', 'running', 'unobservable', ...terminalNativeStates];
const guardedProducerMode = 'guarded';
const producerWrapper = fileURLToPath(new URL('../setup/producer.sh', import.meta.url));

function time(value: Value | undefined): number {
  const date = text(value);
  requireValue(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(date) && Number.isFinite(Date.parse(date)), 'utc_time_required');
  return Date.parse(date);
}

function iso(value: number): string { return new Date(value).toISOString(); }

function shell(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

function nativeStatus(value: Value | undefined): string {
  const status = text(value);
  if (status === 'succeeded') return 'completed';
  requireValue(nativeStates.includes(status), 'invalid_native_status');
  return status;
}

function nativeExecution(value: Value): { job: string; run: string; status: string } {
  const record = object(value);
  return { job: identifier(record.native_job_id), run: identifier(record.native_run_id), status: nativeStatus(record.status) };
}

function fencedResult(error: unknown): boolean {
  return error instanceof Failure &&
    (error.code === 'broker_rejected' || error.code === 'media_transfer_rejected') && error.fields.reason === 'stale_assignment';
}

function absentMediaResult(error: unknown): boolean {
  return error instanceof Failure && (['media_output_missing', 'media_temporary_directory_missing', 'media_generation_not_started', 'invalid_media_output'].includes(error.code) ||
    (error.code === 'media_transfer_rejected' && ['invalid_media_format', 'invalid_artifact_type', 'media_too_large', 'artifact_digest_mismatch', 'trial_fixture_mismatch'].includes(String(error.fields.reason))));
}

function invalidDecision(error: unknown): boolean {
  return error instanceof Failure && error.code === 'broker_rejected' && String(error.fields.route).endsWith('/decisions') &&
    ['duplicate_tool_call_id', 'invalid_final_decision', 'invalid_tool_decision', 'invalid_tool_arguments', 'unknown_tool', 'context_too_large'].includes(String(error.fields.reason));
}

type ProcessIdentity = { boot: string; start: string; running: boolean } | { boot: string; missing: true };
export async function processIdentity(pid: number): Promise<ProcessIdentity | undefined> {
  let boot: string;
  try {
    boot = (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim();
    if (!/^[a-f0-9-]{36}$/.test(boot)) return undefined;
  } catch {
    return undefined;
  }
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).trim().split(/ +/);
    if (!/^[0-9]+$/.test(fields[19] ?? '')) return undefined;
    return { boot, start: fields[19], running: fields[0] !== 'Z' && fields[0] !== 'X' };
  } catch (error) {
    if (cause(error) === 'ENOENT') return { boot, missing: true };
    return undefined;
  }
}

export class Cron {
  constructor(readonly worker: Worker, readonly inspectProcess = processIdentity) {}

  get state() { return this.worker.state; }
  private async read(name: string): Promise<ObjectValue | undefined> { return this.worker.readRecord(this.state, name); }
  private async save(name: string, value: ObjectValue): Promise<void> { await this.state.write(name, encode(value)); }
  private async install(): Promise<ObjectValue> {
    const saved = await this.read('cron-installation.json');
    requireValue(saved, 'checker_registration_unverified');
    return saved;
  }

  private correlation(claim: ObjectValue): ObjectValue {
    return { job_id: claim.job_id, claim_id: claim.claim_id, operation_id: claim.operation_id, generation: claim.generation,
      launch_id: claim.launch_id, native_job_id: claim.native_job_id ?? null, native_run_id: claim.native_run_id ?? null,
      checker_job_id: claim.checker_job_id, sequence: claim.sequence, pull_run_id: claim.pull_run_id, claimed_at: claim.claimed_at, deadline_at: claim.deadline_at,
      observing_checker_run_id: claim.observing_checker_run_id ?? null, observed_at: claim.observed_at ?? null };
  }

  private checkerIDs(claim: ObjectValue, current?: Value): (Value | undefined)[] {
    return [claim.checker_job_id, claim.checker_run_id, claim.pull_run_id, claim.observing_checker_run_id, current,
      ...(Array.isArray(claim.checker_runs) ? claim.checker_runs : [])];
  }

  private async deliveryBlock(claim: ObjectValue): Promise<string | undefined> {
    if (!claim.result_delivery) return;
    const saved = object(claim.result_delivery);
    const identity = await this.inspectProcess(integer(saved.pid));
    if (!identity || identity.boot !== saved.boot || (!('missing' in identity) && identity.start !== saved.start)) return 'result_delivery_unobservable';
    if (!('missing' in identity) && identity.running) return 'result_delivery_active';
  }

  private verifiedStop(claim: ObjectValue): boolean {
    if (!terminalNativeStates.includes(String(claim.native_status)) || !claim.observed_at || !claim.observing_checker_run_id || !claim.native_job_id) return false;
    const checkerIDs = this.checkerIDs(claim);
    if (checkerIDs.includes(claim.native_job_id)) return false;
    if (!claim.native_run_id) return claim.native_status === 'cancelled' && claim.native_never_started === true && !claim.start_requested_at;
    return claim.native_run_id !== claim.native_job_id && !checkerIDs.includes(claim.native_run_id);
  }

  private async stoppedBlock(claim: ObjectValue): Promise<ObjectValue | undefined> {
    const delivery = await this.deliveryBlock(claim);
    if (delivery) return { cause: delivery };
    for (const value of Array.isArray(claim.producers) ? claim.producers : []) {
      const producer = object(value);
      if (!producer.pid) {
        if (claim.producer_mode === guardedProducerMode && producer.mode === guardedProducerMode) continue;
        return { cause: 'producer_launch_unobservable', producer_id: producer.producer_id };
      }
      const identity = await this.inspectProcess(integer(producer.pid));
      if (!identity || identity.boot !== producer.boot || (!('missing' in identity) && (identity.start !== producer.start || identity.running))) {
        return { cause: 'producer_still_active_or_unobservable', producer_id: producer.producer_id };
      }
    }
  }

  private definition(claim: ObjectValue, installation: ObjectValue): ObjectValue {
    const command = text(installation.command);
    const launch = identifier(claim.launch_id);
    const intent = `${command} cron-producer-intent --launch-id ${shell(launch)}`;
    const producer = claim.producer_mode === guardedProducerMode
      ? `Keep foreground work in this run and wait for it to finish. Foreground work requires no producer intent. If a finite VM-local producer must outlive this run, reserve it using ${intent}. Use only the returned producer_command argument array followed by the producer executable and its arguments. The executable must stay alive until all of its work is finished. If the wrapper refuses authorization, do not run the producer.`
      : `Prefer foreground work. Before launching any finite process that could outlive this agent, obtain a durable producer ID using ${intent}. After launch record that producer ID and the exact PID with cron-producer. Do not detach work if this guard is unavailable.`;
    const prompt = `This finite work run must not pull another broker job or change any schedule. Obtain your own native one-time job ID. Run ${command} cron-start --launch-id ${shell(launch)} --native-job-id followed by that exact ID. If the start is not authorized, finish without doing work. Use only the returned brief for this claim. For text and tools use decision-submit with strict JSON; only the calling client executes any proposed client tool. For media use the private supplied destination and media-finish after verifying the file. ${producer} Return only a short outcome without the request, credentials, file paths or output. Do not redo a rejected or uncertain start.`;
    return { goal_id: installation.goal_id, reference: launch, due_at: claim.due_at, kind: 'agent', prompt };
  }

  private lookup(claim: ObjectValue, installation: ObjectValue): ObjectValue {
    const history = claim.native_status && claim.native_job_id && claim.native_run_id ? {
      native_job_id: claim.native_job_id, native_run_id: claim.native_run_id,
      instruction: 'If the schedule is gone, scope native run history to this job ID. Report only the exact terminal execution as top-level execution with matches: [].',
    } : undefined;
    return { lookup: claim.due_at ? this.definition(claim, installation) : null, ...(history ? { history_lookup: history } : {}) };
  }

  async prepare(input: ObjectValue): Promise<ObjectValue> {
    const installation = await this.install();
    return this.state.withLock('cron', async () => {
      const claim = await this.read(claimFile);
      requireValue(claim && claim.claim_id === identifier(input.claim_id) && claim.launch_id === identifier(input.launch_id), 'stale_native_launch');
      if (claim.due_at) return { outcome: 'recovery_pending', ...this.correlation(claim), lookup: this.definition(claim, installation) };
      const due = time(input.due_at);
      requireValue(due >= this.state.sys.now() && due < time(claim.deadline_at), 'native_due_outside_deadline');
      claim.due_at = input.due_at;
      await this.save(claimFile, claim);
      await this.worker.logger.log('INFO', 'cron.launch_intent', { ...this.correlation(claim), due_at: claim.due_at });
      return { outcome: 'register', ...this.correlation(claim), work: this.definition(claim, installation) };
    });
  }

  async check(input: ObjectValue): Promise<ObjectValue> {
    const installation = await this.install();
    requireValue(identifier(input.checker_job_id) === installation.checker_job_id, 'foreign_checker_job');
    const occurrence = identifier(input.checker_run_id);
    const scheduled = time(input.scheduled_at);
    const entered = this.state.sys.now();
    const attempt = this.state.sys.uuid();
    const tick = { checker_job_id: input.checker_job_id, checker_run_id: occurrence, scheduled_at: iso(scheduled), entered_at: iso(entered) };
    const planned = await this.state.withLock('cron', async () => {
      requireValue(scheduled <= entered, 'checker_time_not_yet_due');
      const previous = await this.read(occurrenceFile);
      if (entered - scheduled >= interval || (previous && (previous.checker_run_id === occurrence || scheduled <= time(previous.scheduled_at)))) return { outcome: 'coalesced' } as const;
      await this.save(occurrenceFile, tick);
      const active = await this.read(claimFile);
      if (active) {
        const history = Array.isArray(active.checker_runs) ? active.checker_runs : [];
        active.checker_runs = [...history.filter(run => run !== occurrence), occurrence].slice(-checkerHistoryLimit);
        await this.save(claimFile, active);
      }
      if (active?.failure) return { outcome: 'settle', active } as const;
      if (active && !active.due_at && entered >= time(active.deadline_at)) {
        active.failure = { protocol_version: 1, submission_id: this.state.sys.uuid(), claim_id: active.claim_id, generation: active.generation,
          launch_id: active.launch_id, native_job_id: '', native_run_id: '', reason: 'launch_not_authorized' };
        await this.save(claimFile, active);
        return { outcome: 'settle', active } as const;
      }
      if (active) return { outcome: 'active', active } as const;
      const prior = await this.read(tickFile);
      if (prior?.pending) {
        const pending = object(prior.pending);
        if (prior.attempt_started_at && entered - time(prior.attempt_started_at) < pullAttemptWindow) {
          return { outcome: 'coalesced', cause: 'pull_attempt_in_flight' } as const;
        }
        await this.save(tickFile, { ...prior, attempt, attempt_started_at: tick.entered_at });
        return { outcome: 'pull', pending } as const;
      }
      const sequence = (prior ? integer(prior.sequence) : 0) + 1;
      const pending: ObjectValue = { protocol_version: 1, sequence, checker_job_id: input.checker_job_id, checker_run_id: occurrence,
        scheduled_at: iso(scheduled), entered_at: iso(entered), media_jobs: true, prompt_wav: true };
      await this.save(tickFile, { sequence, scheduled_at: pending.scheduled_at, attempt, attempt_started_at: tick.entered_at, pending });
      return { outcome: 'pull', pending } as const;
    });
    if (planned.outcome === 'settle') return { ...tick, ...await this.settle(planned.active, object(planned.active.failure), occurrence) };
    if (planned.outcome === 'active') {
      const { active } = planned;
      if (this.verifiedStop(active)) {
        const recovery = await this.finishStopped(active, occurrence);
        if (recovery.outcome === 'recovery_pending') await this.reportPresence(active, tick, recovery.cause);
        return { ...tick, ...recovery, lookup: null };
      }
      const delivery = await this.deliveryBlock(active);
      const outcome = delivery === 'result_delivery_active' ? 'running' : delivery ? 'recovery_pending' :
        !active.due_at ? 'prepare' : active.native_lookup_pending ? 'recovery_pending' :
          active.native_status === 'running' ? 'running' : active.native_status === 'queued' ? 'queued' : 'recovery_pending';
      const result = { ...tick, ...this.correlation(active), outcome, cause: delivery ?? null };
      await this.worker.logger.log(delivery === 'result_delivery_unobservable' ? 'WARN' : 'DEBUG', 'cron.check', result);
      await this.reportPresence(active, tick, delivery ?? (outcome === 'recovery_pending' ? 'native_observation_pending' : undefined));
      return { ...result, ...this.lookup(active, installation) };
    }
    if (planned.outcome !== 'pull') {
      await this.worker.logger.log('DEBUG', 'cron.check', { ...tick, outcome: planned.outcome, cause: planned.cause });
      return { ...tick, outcome: planned.outcome };
    }
    try {
      const transport = await this.worker.load();
      const { pending } = planned;
      const pull = { ...tick, sequence: pending.sequence, pull_run_id: pending.checker_run_id, pull_scheduled_at: pending.scheduled_at, pull_entered_at: pending.entered_at };
      const reply = await transport.request('/api/v1/worker/pull', 'POST', encode(pending), pull, 1);
      return await this.state.withLock('cron', async () => {
        const stored = await this.read(tickFile);
        requireValue(stored?.attempt === attempt, 'poll_owner_changed');
        let result: ObjectValue = { ...pull, outcome: 'idle' };
        if (reply.data.job !== null) {
          const grant = object(reply.data.job);
          identifier(grant.job_id); identifier(grant.claim_id); identifier(grant.operation_id);
          requireValue(integer(grant.generation) > 0 && time(grant.deadline_at) >= time(grant.claimed_at), 'invalid_work_grant');
          const current = await this.read(claimFile);
          const claim: ObjectValue = current ?? { ...grant, launch_id: this.state.sys.uuid(), producer_mode: guardedProducerMode, ...pull };
          requireValue(claim.claim_id === grant.claim_id, 'pull_grant_conflict');
          if (!current) await this.save(claimFile, claim);
          result = { ...pull, ...this.correlation(claim), outcome: claim.due_at ? 'recovery_pending' : 'prepare', lookup: claim.due_at ? this.definition(claim, installation) : null };
        }
        await this.save(tickFile, { sequence: stored.sequence, scheduled_at: stored.scheduled_at });
        await this.worker.logger.log(result.outcome === 'idle' ? 'DEBUG' : 'INFO', 'cron.pull_observed', { ...result, lookup: undefined, request_id: reply.requestId });
        return result;
      });
    } catch (error) {
      await this.state.withLock('cron', async () => {
        const stored = await this.read(tickFile);
        if (stored?.attempt !== attempt) return;
        await this.save(tickFile, { sequence: stored.sequence, scheduled_at: stored.scheduled_at, pending: object(stored.pending) });
      });
      throw error;
    }
  }

  private async reportPresence(claim: ObjectValue, tick: ObjectValue, reason?: Value): Promise<void> {
    const details = { ...this.correlation(claim), ...tick, hold_reason: reason ?? null };
    const input = { protocol_version: 1, claim_id: claim.claim_id, generation: claim.generation, checker_job_id: tick.checker_job_id,
      checker_run_id: tick.checker_run_id, scheduled_at: tick.scheduled_at, hold_reason: reason };
    const route = `/api/v1/worker/jobs/${identifier(claim.job_id)}/presence`;
    try {
      const transport = await this.worker.load();
      const reply = await transport.request(route, 'POST', encode(input), details, 1, presenceTimeoutMs);
      requireValue(typeof reply.data.recorded === 'boolean', 'invalid_presence_reply', { request_id: reply.requestId });
      time(reply.data.received_at);
      await this.worker.logger.log('DEBUG', 'cron.presence_observed', { ...details, request_id: reply.requestId, recorded: reply.data.recorded, received_at: reply.data.received_at });
    } catch (error) {
      const fields = error instanceof Failure ? error.fields : {};
      const unsupported = fields.http_status === 404 && fields.reason === 'not_found';
      await this.worker.logger.log(unsupported ? 'DEBUG' : 'WARN', 'cron.presence_unavailable', {
        ...details, ...fields, route, cause: cause(error), outcome: unsupported ? 'unsupported_by_broker' : 'contact_unconfirmed',
      });
    }
  }

  async start(launch: string, nativeJob: string): Promise<ObjectValue> {
    const transport = await this.worker.load();
    const claim = await this.state.withLock('cron', async () => {
      const saved = await this.read(claimFile);
      requireValue(saved?.launch_id === identifier(launch) && (!saved.native_job_id || saved.native_job_id === identifier(nativeJob)), 'stale_native_launch');
      requireValue(!this.checkerIDs(saved).includes(nativeJob), 'native_job_id_is_checker_id');
      requireValue(saved.due_at && !saved.start_requested_at && !saved.receipt && !saved.failure && !terminalNativeStates.includes(String(saved.native_status)), 'work_already_started');
      saved.native_job_id = identifier(nativeJob);
      saved.start_requested_at = iso(this.state.sys.now());
      await this.save(claimFile, saved);
      return saved;
    });
    const workID = identifier(claim.job_id);
    await this.worker.logger.log('INFO', 'cron.work_start_requested', { ...this.correlation(claim), start_requested_at: claim.start_requested_at });
    const reply = await transport.request(`/api/v1/worker/jobs/${workID}/start`, 'POST', encode({ protocol_version: 1, claim_id: claim.claim_id, generation: claim.generation, launch_id: launch, native_job_id: nativeJob }), this.correlation(claim), 1);
    const brief = validateJob(reply.data, identifier(this.worker.config.worker_id), workID);
    requireValue(brief.lease_id === claim.claim_id && integer(brief.generation) === integer(claim.generation) && brief.native_job_id === nativeJob && brief.launch_id === launch, 'work_start_response_mismatch');
    await this.state.withLock('cron', async () => {
      const saved = await this.read(claimFile);
      requireValue(saved?.claim_id === claim.claim_id && !saved.failure && !saved.receipt && !this.verifiedStop(saved), 'stale_native_launch');
      saved.brief = brief;
      await this.save(claimFile, saved);
    });
    await this.worker.logger.log('INFO', 'cron.work_started', { ...this.correlation(claim), started_at: brief.started_at, request_id: reply.requestId });
    if (brief.media) return { outcome: 'authorized', ...await prepareMedia(this.worker, transport, brief) };
    return { outcome: 'authorized', job_id: workID, operation_id: claim.operation_id, context: brief.context };
  }

  async producerIntent(launch: string): Promise<ObjectValue> {
    return this.state.withLock('cron', async () => {
      const claim = await this.read(claimFile);
      requireValue(claim?.launch_id === identifier(launch) && claim.brief && !claim.receipt && !claim.failure && !claim.pending_result &&
        !this.verifiedStop(claim), 'stale_native_launch');
      const producers = Array.isArray(claim.producers) ? claim.producers : [];
      requireValue(producers.length < 16, 'producer_limit_reached');
      const guarded = claim.producer_mode === guardedProducerMode;
      const intent = { producer_id: this.state.sys.uuid(), intended_at: iso(this.state.sys.now()), ...(guarded ? { mode: guardedProducerMode } : {}) };
      const installation = guarded ? await this.read('installation.json') : undefined;
      const producerCommand = guarded ? ['sh', producerWrapper, text(installation?.launcher), launch, intent.producer_id] : undefined;
      claim.producers = [...producers, intent];
      await this.save(claimFile, claim);
      await this.worker.logger.log('INFO', 'cron.producer_intent', { ...this.correlation(claim), ...intent });
      return { outcome: 'producer_intent_saved', ...intent, ...(producerCommand ? { producer_command: producerCommand } : {}) };
    });
  }

  async producer(launch: string, producerID: string, pid: number, guarded = false): Promise<ObjectValue> {
    identifier(producerID);
    requireValue(Number.isSafeInteger(pid) && pid > 0, 'invalid_producer_pid');
    const identity = await this.inspectProcess(pid);
    requireValue(identity && !('missing' in identity) && identity.running, 'producer_identity_unavailable');
    return this.state.withLock('cron', async () => {
      const claim = await this.read(claimFile);
      requireValue(claim?.launch_id === identifier(launch) && claim.brief && !claim.receipt && !claim.failure, 'stale_native_launch');
      const known = Array.isArray(claim.producers) ? claim.producers.map(object) : [];
      const intent = known.find(record => record.producer_id === producerID);
      const details = { ...this.correlation(claim), producer_id: producerID, pid };
      requireValue((claim.producer_mode === guardedProducerMode) === guarded && (intent?.mode === guardedProducerMode) === guarded,
        'producer_guard_required', details);
      if (guarded) requireValue(!this.verifiedStop(claim) && !claim.pending_result && !intent?.pid, 'producer_launch_fenced', details);
      requireValue(intent && (!intent.pid || (intent.pid === pid && intent.boot === identity.boot && intent.start === identity.start)), 'producer_intent_mismatch');
      const record = { ...intent, pid, boot: identity.boot, start: identity.start };
      claim.producers = known.map(prior => prior === intent ? record : prior);
      await this.save(claimFile, claim);
      await this.worker.logger.log('INFO', 'cron.producer_registered', { ...this.correlation(claim), producer: record });
      return { outcome: 'producer_recorded', ...this.correlation(claim) };
    });
  }

  async submit(id: string, input?: string): Promise<ObjectValue> {
    await this.state.withLock('cron', async () => {
      const current = await this.read(claimFile);
      requireValue(current?.job_id === id && current.brief && !current.failure, 'assignment_not_active');
      const brief = object(current.brief);
      requireValue(input === undefined ? brief.media : !brief.media, 'result_type_mismatch');
      const pending: ObjectValue = input === undefined ? { kind: 'media' } : { kind: 'decision', input: encode(decision(input, object(brief.context).tools)) };
      requireValue(!current.pending_result || encode(current.pending_result) === encode(pending), 'pending_submission_conflict');
      if (!current.pending_result) {
        current.pending_result = pending;
        await this.save(claimFile, current);
      }
    });
    return await this.replayResult(id);
  }

  private async replayResult(id: string): Promise<ObjectValue> {
    const planned = await this.state.withLock('cron', async () => {
      const current = await this.read(claimFile);
      requireValue(current?.job_id === id && current.brief && current.pending_result && !current.failure, 'assignment_not_active');
      if (current.receipt) return { current, outcome: 'accepted' } as const;
      const blocked = await this.deliveryBlock(current);
      if (blocked) return { current, outcome: 'recovery_pending', cause: blocked } as const;
      const pid = this.state.sys.pid;
      const identity = await this.inspectProcess(pid);
      requireValue(identity && !('missing' in identity) && identity.running, 'result_delivery_identity_unavailable');
      const attempt = this.state.sys.uuid();
      current.result_delivery = { attempt, pid, boot: identity.boot, start: identity.start };
      await this.save(claimFile, current);
      return { current, outcome: 'deliver', attempt } as const;
    });
    const { current } = planned;
    if (planned.outcome !== 'deliver') return { ...this.correlation(current), outcome: planned.outcome, cause: planned.cause ?? null };
    const brief = object(current.brief);
    const pending = object(current.pending_result);
    let receipt: ObjectValue | undefined;
    try {
      await this.worker.logger.log('DEBUG', 'cron.result_delivery_started', { ...this.correlation(current), delivery: current.result_delivery, kind: pending.kind });
      const delivered = pending.kind === 'media' ? await finishMedia(this.worker, id, brief) : await this.worker.submit(id, text(pending.input), brief);
      requireValue(delivered.accepted === true, 'terminal_receipt_unverified');
      receipt = delivered;
    } finally {
      await this.state.withLock('cron', async () => {
        const saved = await this.read(claimFile);
        requireValue(saved?.claim_id === current.claim_id && saved.result_delivery && object(saved.result_delivery).attempt === planned.attempt, 'stale_native_launch');
        if (receipt) saved.receipt = receipt;
        delete saved.result_delivery;
        await this.save(claimFile, saved);
      });
    }
    await this.worker.logger.log('INFO', 'cron.receipt_observed', { ...this.correlation(current), outcome: 'accepted' });
    return { outcome: 'accepted', ...this.correlation(current) };
  }

  private async settle(active: ObjectValue, settlement: ObjectValue, occurrence?: string): Promise<ObjectValue> {
    const details: ObjectValue = { ...this.correlation(active), settling_checker_run_id: occurrence ?? active.observing_checker_run_id ?? null };
    const transport = await this.worker.load();
    const { data: receipt, requestId } = await transport.request(`/api/v1/worker/jobs/${identifier(details.job_id)}/interrupt`, 'POST', encode(settlement), details, 1);
    requireValue(receipt.job_id === details.job_id && receipt.claim_id === details.claim_id && ['accepted', 'interrupted', 'cancelled'].includes(text(receipt.state)), 'terminal_receipt_unverified');
    await this.state.withLock('cron', async () => {
      const current = await this.read(claimFile);
      if (current?.claim_id !== details.claim_id) {
        const previous = await this.read('cron-last-receipt.json');
        requireValue(previous?.claim_id === details.claim_id && previous.settlement_id === settlement.submission_id, 'stale_native_observation');
        return;
      }
      requireValue(object(current.failure).submission_id === settlement.submission_id, 'stale_native_observation');
      await this.save('cron-last-receipt.json', { ...details, receipt, settlement_id: settlement.submission_id, settled_at: iso(this.state.sys.now()) });
      const tick = await this.read(tickFile);
      if (tick?.pending && tick.sequence === current.sequence) {
        requireValue(object(tick.pending).checker_run_id === current.pull_run_id, 'poll_grant_conflict');
        await this.save(tickFile, { sequence: tick.sequence, scheduled_at: tick.scheduled_at });
      }
      if (current.brief && object(current.brief).media) {
        const spool = await (await this.state.child('media')).child(identifier(details.job_id));
        await spool.withLock('prepare', () => spool.remove('progress.json'));
      }
      await this.state.remove(claimFile);
    });
    await this.worker.logger.log('INFO', 'cron.work_settled', { ...details, outcome: 'terminal_receipt', receipt_state: receipt.state, request_id: requestId });
    return { ...details, outcome: 'settled' };
  }

  async observe(input: ObjectValue): Promise<ObjectValue> {
    const installation = await this.install();
    const observation = await this.state.withLock<{ active: ObjectValue; outcome: string; cause?: string }>('cron', async () => {
      const active = await this.read(claimFile);
      requireValue(active?.claim_id === input.claim_id && active.launch_id === input.launch_id, 'stale_native_observation');
      const tick = await this.read(occurrenceFile);
      const occurrence = identifier(input.checker_run_id);
      const details = { ...this.correlation(active), checker_run_id: occurrence };
      requireValue(tick && identifier(input.checker_job_id) === tick.checker_job_id && occurrence === tick.checker_run_id, 'stale_observing_occurrence', details);
      const observedAt = time(input.observed_at);
      requireValue(observedAt >= Math.max(time(active.claimed_at), time(tick.entered_at)) && (!active.observed_at || observedAt >= time(active.observed_at)) &&
        observedAt <= this.state.sys.now(), 'stale_native_observation', details);
      const checkerIDs = this.checkerIDs(active, occurrence);
      const matches = input.matches;
      requireValue(Array.isArray(matches), 'native_lookup_matches_required');
      const pending = async (cause: string) => {
        if (!active.native_lookup_pending) {
          active.native_lookup_pending = true;
          await this.save(claimFile, active);
        }
        return { active, outcome: 'recovery_pending', cause };
      };
      if (input.registration_rejection !== undefined) {
        if (matches.length || input.execution !== undefined) return pending('native_registration_ambiguous');
        const rejected = object(input.registration_rejection);
        const expected = this.definition(active, installation);
        requireValue(rejected.outcome === 'not_created' && identifier(rejected.native_operation_id) &&
          Object.keys(expected).every(key => rejected[key] === expected[key]), 'native_non_delivery_unverified');
        requireValue(!active.native_job_id && !active.native_run_id && !active.start_requested_at && !active.failure, 'native_registration_already_delivered');
        const prior = this.correlation(active);
        delete active.due_at;
        active.launch_id = this.state.sys.uuid();
        active.observed_at = input.observed_at;
        active.observing_checker_run_id = occurrence;
        await this.save(claimFile, active);
        await this.worker.logger.log('WARN', 'cron.native_registration_rejected', { ...prior, next_launch_id: active.launch_id, native_operation_id: rejected.native_operation_id });
        return { active, outcome: 'prepare' };
      }
      if (matches.length > 1) return pending('native_registration_ambiguous');
      const found = matches.length === 1 ? object(matches[0]) : undefined;
      const nested = found?.execution === undefined ? undefined : nativeExecution(found.execution);
      const separate = input.execution === undefined ? undefined : nativeExecution(input.execution);
      const execution = nested ?? separate;
      await this.worker.logger.log('DEBUG', 'cron.native_evidence', {
        ...details, observed_at: input.observed_at, match_count: matches.length,
        definition_status: found?.status, nested_execution_status: nested && object(found?.execution).status,
        separate_execution_status: separate && object(input.execution).status, nested, separate,
      });
      if (nested && separate && (nested.job !== separate.job || nested.run !== separate.run || nested.status !== separate.status)) {
        return pending('native_execution_record_mismatch');
      }
      let jobID: string;
      let status: string;
      if (found) {
        const expected = this.definition(active, installation);
        requireValue(Object.keys(expected).every(key => found[key] === expected[key]), 'native_definition_mismatch', details);
        jobID = identifier(found.native_job_id);
        status = nativeStatus(found.status);
        requireValue(!active.native_job_id || active.native_job_id === jobID, 'native_job_mismatch', details);
      } else {
        if (!execution || !active.native_status || execution.job !== active.native_job_id || execution.run !== active.native_run_id ||
          !terminalNativeStates.includes(execution.status)) return pending('native_registration_unobservable');
        jobID = execution.job;
        status = execution.status;
      }
      if (checkerIDs.includes(jobID)) return pending('native_job_id_is_checker_id');
      if (execution) {
        if (execution.job !== jobID || execution.status !== status || found?.execution_never_started === true) return pending('native_execution_record_mismatch');
        if (execution.run === jobID) return pending('native_execution_id_is_job_id');
        if (checkerIDs.includes(execution.run)) return pending('native_execution_id_is_checker_id');
        requireValue(!active.native_run_id || active.native_run_id === execution.run, 'native_execution_mismatch', details);
      }
      requireValue(!terminalNativeStates.includes(String(active.native_status)) || active.native_status === status, 'superseded_native_status', details);
      const confirmedUnstarted = status === 'cancelled' && found?.execution_never_started === true && !active.native_run_id && !active.start_requested_at;
      if ((status === 'running' || terminalNativeStates.includes(status)) && !execution && !confirmedUnstarted) return pending('native_execution_unobservable');
      if (this.verifiedStop(active)) return { active, outcome: 'settle' };
      active.native_job_id = jobID;
      if (execution) active.native_run_id = execution.run;
      if (confirmedUnstarted) active.native_never_started = true;
      delete active.native_lookup_pending;
      active.native_status = status;
      active.observed_at = input.observed_at;
      active.observing_checker_run_id = occurrence;
      await this.save(claimFile, active);
      if (terminalNativeStates.includes(status)) {
        await this.worker.logger.log(status === 'failed' ? 'WARN' : 'INFO', 'cron.native_observation', {
          ...this.correlation(active), outcome: 'confirmed_stopped', native_status: status, execution_never_started: confirmedUnstarted,
          evidence_source: found ? (nested ? 'definition_and_nested_execution' : separate ? 'definition_and_execution' : 'cancelled_before_start') : 'bound_run_history',
        });
        return { active, outcome: 'settle' };
      }
      return { active, outcome: status === 'unobservable' ? 'recovery_pending' : status };
    });
    if (observation.outcome === 'settle') return this.finishStopped(observation.active, identifier(input.checker_run_id));
    const result = { ...this.correlation(observation.active), checker_run_id: identifier(input.checker_run_id), outcome: observation.outcome,
      ...(observation.cause ? { cause: observation.cause } : {}) };
    await this.worker.logger.log(observation.cause ? 'WARN' : 'DEBUG', 'cron.native_observation', { ...result, observed_at: input.observed_at });
    return result;
  }

  private async stoppedClaim(proof: ObjectValue): Promise<ObjectValue> {
    const saved = await this.read(claimFile);
    const fields = ['claim_id', 'generation', 'launch_id', 'native_job_id', 'native_run_id', 'native_status', 'observed_at', 'observing_checker_run_id'];
    requireValue(saved && this.verifiedStop(saved) && fields.every(field => encode(saved[field]) === encode(proof[field])), 'stale_native_observation', this.correlation(proof));
    return saved;
  }

  private async finishStopped(proof: ObjectValue, occurrence: string): Promise<ObjectValue> {
    const details = { ...this.correlation(proof), settling_checker_run_id: occurrence, native_status: proof.native_status };
    const blocked = async (reason: ObjectValue): Promise<ObjectValue> => {
      const result = { ...details, ...reason, outcome: 'recovery_pending' };
      await this.worker.logger.log('WARN', 'cron.recovery_pending', result);
      return result;
    };
    const { current, initialBlock } = await this.state.withLock('cron', async () => {
      const current = await this.stoppedClaim(proof);
      return { current, initialBlock: await this.stoppedBlock(current) };
    });
    if (initialBlock) return blocked(initialBlock);
    if (current.failure) return this.settle(current, object(current.failure), occurrence);
    if (!current.receipt && (current.pending_result || (current.brief && object(current.brief).media))) {
      const jobID = identifier(current.job_id);
      try {
        const replay = current.pending_result ? await this.replayResult(jobID) : await this.submit(jobID);
        if (replay.outcome !== 'accepted') return blocked({ cause: replay.cause });
      } catch (error) {
        if (!fencedResult(error) && !absentMediaResult(error) && !invalidDecision(error)) throw error;
        await this.worker.logger.log('WARN', 'cron.saved_result_unavailable', { ...details, cause: cause(error), ...(error instanceof Failure ? error.fields : {}) });
      }
    }
    const plan = await this.state.withLock('cron', async () => {
      const saved = await this.stoppedClaim(proof);
      const reason = await this.stoppedBlock(saved);
      if (reason) return { reason };
      if (!saved.failure) {
        saved.failure = { protocol_version: 1, submission_id: this.state.sys.uuid(), claim_id: saved.claim_id, generation: saved.generation,
          launch_id: saved.launch_id, native_job_id: saved.native_job_id, native_run_id: saved.native_run_id ?? '',
          reason: saved.native_never_started ? 'native_cancelled_before_start' : 'execution_confirmed_stopped' };
        await this.save(claimFile, saved);
        const unused = (Array.isArray(saved.producers) ? saved.producers : []).map(object).filter(producer => !producer.pid);
        if (unused.length) await this.worker.logger.log('INFO', 'cron.unused_producers_retired', { ...details, producer_ids: unused.map(producer => producer.producer_id) });
      }
      return { settlement: object(saved.failure) };
    });
    if (plan.reason) return blocked(plan.reason);
    return this.settle(proof, plan.settlement, occurrence);
  }
}
