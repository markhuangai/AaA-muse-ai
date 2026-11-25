import { iso, time } from './cron.js';
import { requireValue } from './errors.js';
import { controlContext, controlGrant, terminalControl } from './hook-ops.js';
import type { Action, Tick } from './hook.js';
import { encode, identifier, integer, object, parse, text, type ObjectValue, type Value } from './json.js';
import { weeklyUsageHeaders } from './weekly-usage.js';
import type { Worker } from './worker.js';

export const hookTaskFile = 'hook-task.json';
const taskTextLimit = 128 * 1024;

export class HookTasks {
  constructor(readonly worker: Worker) {}
  get state() { return this.worker.state; }
  private read() { return this.worker.readRecord(this.state, hookTaskFile); }
  private save(task: ObjectValue) { return this.state.write(hookTaskFile, encode(task)); }

  async saveGrant(raw: Value, pull: ObjectValue): Promise<void> {
    const task = controlGrant(raw, 'task');
    await this.state.withLock('cron', async () => {
      requireValue(!await this.read(), 'pull_grant_conflict');
      await this.save({ ...task, launch_id: this.state.sys.uuid(), checker_job_id: pull.checker_job_id,
        wake_invocation_id: pull.checker_run_id, pull_occurrence: pull.checker_run_id, pull_sequence: pull.sequence });
    });
  }

  private route(task: ObjectValue, action: string) {
    return `/api/v1/worker/agent-tasks/${identifier(task.id)}/${action}`;
  }

  private fields(task: ObjectValue) {
    return { ...controlContext(task), agent_task_id: task.id };
  }

  private claim(task: ObjectValue) {
    return { protocol_version: 1, claim_id: task.claim_id, generation: task.generation };
  }

  private nativeRun(task: ObjectValue) { return 'event-hook-' + identifier(task.wake_invocation_id); }

  private settlement(task: ObjectValue, reason: string): ObjectValue {
    return { ...this.claim(task), launch_id: task.launch_id, submission_id: this.state.sys.uuid(),
      native_job_id: task.checker_job_id, native_run_id: this.nativeRun(task), reason, verified_start: true };
  }

  private async markUnstarted(task: ObjectValue) {
    task.failure = this.settlement(task, 'launch_not_authorized');
    await this.save(task);
  }

  private async settle(task: ObjectValue): Promise<Action> {
    const failure = object(task.failure);
    const transport = await this.worker.load();
    try {
      const reply = await transport.request(this.route(task, 'interrupt'), 'POST', encode(failure),
        { ...this.fields(task), submission_id: failure.submission_id }, 1);
      requireValue(reply.data.id === task.id && reply.data.held === false, 'agent_task_settlement_mismatch');
    } catch (error) {
      if (!terminalControl(error, 'stale_assignment')) throw error;
    }
    await this.worker.logger.log('INFO', 'hook.task_settled', { ...this.fields(task), ...failure });
    await this.state.remove(hookTaskFile);
    return { kind: 'silent', reason: 'background_task_settled' };
  }

  async active(tick: Tick, capability: Record<string, string>, usage?: ObjectValue): Promise<Action> {
    return this.state.withLock('cron', async () => {
      const task = await this.read();
      requireValue(task && task.checker_job_id === tick.checker_job_id, 'invalid_hook_control_grant');
      if (task.pending_result && !task.receipt && !task.failure && !task.delivery_block) {
        await this.replayResult(task);
      }
      if (task.failure) return await this.settle(task);
      if (!task.wake_attempted_at) {
        if (!task.binding_intent && this.state.sys.now() >= time(task.deadline_at)) {
          await this.markUnstarted(task);
          return await this.settle(task);
        }
        return this.beforeWake(task, tick);
      }
      if (tick.checker_run_id !== task.wake_invocation_id) {
        const transport = await this.worker.load();
        const holdReason = task.pending_result ? 'result_delivery_unobservable' : 'native_observation_pending';
        await transport.request(this.route(task, 'presence'), 'POST', encode({
          ...this.claim(task), checker_job_id: tick.checker_job_id, checker_run_id: tick.checker_run_id,
          scheduled_at: tick.scheduled_at, hold_reason: holdReason,
        }), this.fields(task), 1, 2000, { ...capability, ...weeklyUsageHeaders(usage) });
      }
      return { kind: 'silent', reason: 'background_task_active' };
    });
  }

  private async beforeWake(task: ObjectValue, tick: Tick): Promise<Action> {
    if (task.binding_intent || task.wake_invocation_id !== tick.checker_run_id) {
      const transport = await this.worker.load();
      while (task.binding_intent || task.wake_invocation_id !== tick.checker_run_id) {
        const binding = task.binding_intent ? object(task.binding_intent) : {
          ...this.claim(task), submission_id: this.state.sys.uuid(), checker_job_id: tick.checker_job_id,
          previous_invocation_id: task.wake_invocation_id, invocation_id: tick.checker_run_id,
        };
        task.binding_intent = binding;
        await this.save(task);
        try {
          const reply = await transport.request(this.route(task, 'bind'), 'POST', encode(binding),
            { ...this.fields(task), submission_id: binding.submission_id, previous_invocation: binding.previous_invocation_id }, 1);
          requireValue(reply.data.task_id === task.id && reply.data.claim_id === task.claim_id &&
            reply.data.invocation_id === binding.invocation_id, 'hook_binding_response_mismatch');
          task.wake_invocation_id = binding.invocation_id;
          delete task.binding_intent;
          await this.save(task);
          await this.worker.logger.log('INFO', 'hook.task_binding_observed', { ...this.fields(task),
            request_id: reply.requestId, submission_id: binding.submission_id, previous_invocation: binding.previous_invocation_id });
          if (this.state.sys.now() >= time(task.deadline_at)) break;
        } catch (error) {
          if (!terminalControl(error, 'hook_claim_terminal')) throw error;
          await this.markUnstarted(task);
          return await this.settle(task);
        }
      }
    }
    if (this.state.sys.now() >= time(task.deadline_at)) {
      await this.markUnstarted(task);
      return await this.settle(task);
    }
    task.wake_attempted_at = iso(this.state.sys.now());
    await this.save(task);
    await this.worker.logger.log('INFO', 'hook.task_wake_intent', { ...this.fields(task), wake_attempted_at: task.wake_attempted_at });
    return { kind: 'wake', reason: 'background_task', payload: { kind: 'background_task', task_id: task.id,
      claim_id: task.claim_id, launch_id: task.launch_id, expected_run_id: 'event-hook:' + identifier(task.wake_invocation_id) } };
  }

  private async current(launch: string, run: string) {
    const task = await this.read();
    requireValue(task && task.launch_id === launch && task.wake_attempted_at, 'stale_hook_launch');
    requireValue(run === 'event-hook:' + identifier(task.wake_invocation_id), 'hook_run_mismatch', this.fields(task));
    return task;
  }

  async start(launch: string, run: string): Promise<ObjectValue> {
    const task = await this.state.withLock('cron', async () => {
      const active = await this.current(launch, run);
      requireValue(!active.start_requested_at && !active.failure, 'work_already_started', this.fields(active));
      active.start_requested_at = iso(this.state.sys.now());
      await this.save(active);
      return active;
    });
    const transport = await this.worker.load();
    let reply;
    try {
      reply = await transport.request(this.route(task, 'start'), 'POST', encode({
        ...this.claim(task), launch_id: task.launch_id, native_job_id: task.checker_job_id,
        verification: { reference: task.claim_id, native_job_id: task.checker_job_id, native_run_id: this.nativeRun(task), status: 'running' },
      }), this.fields(task), 1);
    } catch (error) {
      if (terminalControl(error, 'hook_claim_terminal')) await this.state.withLock('cron', async () => this.markUnstarted(await this.current(launch, run)));
      throw error;
    }
    const { data } = reply;
    requireValue(data.id === task.id && data.worker_id === this.worker.config.worker_id && data.state === 'running' &&
      object(data.claim).claim_id === task.claim_id && integer(object(data.claim).generation) === integer(task.generation) &&
      Buffer.byteLength(text(data.prompt)) > 0 && Buffer.byteLength(text(data.prompt)) <= 32768 && Number.isFinite(time(data.started_at)),
    'agent_task_start_response_mismatch', this.fields(task));
    await this.state.withLock('cron', async () => {
      const active = await this.current(launch, run);
      requireValue(!active.started_at && !active.failure, 'stale_hook_launch');
      active.started_at = data.started_at;
      await this.save(active);
    });
    await this.worker.logger.log('INFO', 'hook.task_started', { ...this.fields(task), started_at: data.started_at, request_id: reply.requestId });
    return { outcome: 'authorized', task_id: data.id, prompt: data.prompt, title: data.title, deadline_at: data.deadline_at };
  }

  private result(task: ObjectValue, outcome: string, resultText: string, reason: string, summary: string): ObjectValue {
    requireValue(Buffer.byteLength(resultText) <= taskTextLimit && (outcome !== 'completed' || resultText.length > 0) &&
      Array.from(summary).length <= 1000, 'invalid_agent_task_result');
    const redact = this.worker.logger.redactor;
    const safe = redact.text(resultText), safeSummary = redact.text(summary);
    requireValue(Buffer.byteLength(safe) <= taskTextLimit && Array.from(safeSummary).length <= 1000, 'invalid_agent_task_result');
    return { ...this.claim(task), submission_id: this.state.sys.uuid(), launch_id: task.launch_id, outcome,
      result_text: safe, summary: safeSummary, ...(reason ? { reason } : {}) };
  }

  private async replayResult(task: ObjectValue) {
    const pending = object(task.pending_result);
    const transport = await this.worker.load();
    try {
      const reply = await transport.request(this.route(task, 'result'), 'POST', encode(pending),
        { ...this.fields(task), submission_id: pending.submission_id }, 1);
      requireValue(reply.data.id === task.id && reply.data.held === true && reply.data.state === pending.outcome, 'agent_task_result_response_mismatch');
      task.receipt = { request_id: reply.requestId, state: reply.data.state };
    } catch (error) {
      if (!terminalControl(error, 'stale_assignment')) throw error;
    }
    task.failure = this.settlement(task, 'execution_confirmed_stopped');
    await this.save(task);
    await this.worker.logger.log('INFO', 'hook.task_result_observed', { ...this.fields(task),
      submission_id: pending.submission_id, outcome: pending.outcome, accepted: !!task.receipt });
    return { outcome: task.receipt ? 'accepted' : 'settlement_saved', task_id: task.id };
  }

  async finish(id: string, raw: string) {
    const output = object(parse(raw));
    requireValue(Object.keys(output).every(key => ['result_text', 'summary'].includes(key)), 'invalid_agent_task_result');
    return this.state.withLock('cron', async () => {
      const task = await this.read();
      requireValue(task?.id === id && task.started_at && !task.failure && !task.pending_result && !task.receipt && !task.delivery_block, 'agent_task_finish_uncertain');
      task.pending_result = this.result(task, 'completed', text(output.result_text), '', text(output.summary ?? ''));
      await this.save(task);
      return this.replayResult(task);
    });
  }

  async abort(launch: string, run: string, reason: string, summary: string) {
    requireValue(reason === 'execution_failed' || reason === 'execution_refused', 'invalid_hook_abort_reason');
    return this.state.withLock('cron', async () => {
      const task = await this.current(launch, run);
      if (task.failure) return { outcome: 'abort_saved', task_id: task.id };
      requireValue(!task.receipt && !task.pending_result && !task.delivery_block &&
        (!task.start_requested_at || task.started_at), 'hook_task_abort_uncertain');
      if (task.started_at) {
        task.pending_result = this.result(task, reason === 'execution_refused' ? 'refused' : 'failed', '', reason, summary);
      } else {
        task.failure = this.settlement(task, 'execution_confirmed_stopped');
      }
      await this.save(task);
      await this.worker.logger.log('WARN', 'hook.task_abort_saved', { ...this.fields(task), reason, started: !!task.started_at });
      return task.pending_result ? this.replayResult(task) : { outcome: 'abort_saved', task_id: task.id };
    });
  }
}
