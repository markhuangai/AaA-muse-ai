import { statfs } from 'node:fs/promises';
import { digest, type Filter } from './diagnostics.js';
import { Failure, cause, requireValue } from './errors.js';
import { encode, identifier, integer, object, text, type ObjectValue, type Value } from './json.js';
import type { Worker } from './worker.js';

export const hookOpFile = 'hook-op.json';
const resultLimit = 512 * 1024;
const envelopeLimit = 768 * 1024;

export function controlGrant(raw: Value, kind?: 'operation' | 'task') {
  const grant = object(raw);
  requireValue(/^[a-f0-9]{32}$/.test(text(grant.id)) && grant.operation_id === grant.id &&
    identifier(grant.claim_id) && integer(grant.generation) > 0 && Number.isFinite(Date.parse(text(grant.claimed_at))) &&
    Date.parse(text(grant.deadline_at)) >= Date.parse(text(grant.claimed_at)), 'invalid_hook_control_grant');
  requireValue(kind !== 'operation' || grant.kind === 'doctor' || grant.kind === 'diagnostics_export', 'invalid_worker_op');
  return grant;
}

export function controlContext(entry: ObjectValue) {
  return { operation_id: entry.operation_id, claim_id: entry.claim_id, generation: entry.generation,
    launch_id: entry.launch_id, checker_job_id: entry.checker_job_id, wake_invocation_id: entry.wake_invocation_id };
}

export function terminalControl(error: unknown, ...reasons: string[]) {
  return error instanceof Failure && error.fields.http_status === 409 && reasons.includes(String(error.fields.reason));
}

export class HookOps {
  constructor(readonly worker: Worker, readonly disk = statfs) {}
  get state() { return this.worker.state; }

  async saveGrant(raw: Value, pull: ObjectValue) {
    const grant = controlGrant(raw, 'operation');
    await this.state.withLock('cron', async () => {
      requireValue(!await this.worker.readRecord(this.state, hookOpFile), 'pull_grant_conflict');
      await this.state.write(hookOpFile, encode({ ...grant, pull_sequence: pull.sequence,
        pull_occurrence: pull.checker_run_id, submission_id: this.state.sys.uuid() }));
    });
  }

  async doctor(): Promise<ObjectValue> {
    await this.state.check(this.state.root, true);
    const space = await this.disk(this.state.root, { bigint: true });
    const registration = await this.worker.readRecord(this.state, 'hook-installation.json');
    const health = await this.worker.readRecord(this.state, 'hook-tick-health.json');
    const installation = await this.worker.readRecord(this.state, 'installation.json');
    return { worker_id: this.worker.config.worker_id, version: this.worker.productVersion, state_permissions: 'verified',
      available_bytes: String(space.bavail * space.bsize), hook_confirmed: !!registration,
      ...(registration && { prompt_contract: registration.hook_prompt_version }),
      ...(health && { last_tick_at: health.last_tick_at, last_outcome: health.last_outcome }),
      ...(installation && { detector_sha256: installation.detector_sha256, skill_sha256: installation.skill_sha256 }) };
  }

  private async diagnosticResult(params: ObjectValue) {
    const filter: Filter = {};
    for (const field of ['operation_id', 'request_id'] as const) {
      if (params[field] !== undefined) filter[field] = identifier(params[field]);
    }
    for (const field of ['since', 'until'] as const) {
      if (params[field] !== undefined) filter[field] = text(params[field]);
    }
    const maxBytes = params.max_bytes === undefined ? resultLimit : integer(params.max_bytes);
    return this.worker.logger.capture.exportBounded(filter, params.decode !== false, maxBytes, text(params.cursor ?? ''), this.worker.logger.redactor);
  }

  async recover(op: ObjectValue): Promise<string> {
    const transport = await this.worker.load();
    const details = { ...controlContext(op), worker_op_id: op.id, op_kind: op.kind, deadline_at: op.deadline_at, submission_id: op.submission_id };
    let pending = op.pending_result === undefined ? undefined : object(op.pending_result);
    if (!pending) {
      const started = this.state.sys.now();
      const input: ObjectValue = { protocol_version: 1, submission_id: op.submission_id, claim_id: op.claim_id, generation: op.generation };
      try {
        requireValue(started < Date.parse(text(op.deadline_at)), 'worker_op_deadline_exceeded');
        const result = op.kind === 'doctor' ? await this.doctor() : await this.diagnosticResult(object(op.params ?? {}));
        input.outcome = 'succeeded';
        input.result = result;
        requireValue(Buffer.byteLength(encode(result)) <= (op.kind === 'doctor' ? 64 * 1024 : resultLimit) &&
          Buffer.byteLength(encode(input)) <= envelopeLimit, 'worker_op_result_too_large');
      } catch (error) {
        const observed = cause(error);
        input.outcome = 'failed';
        input.reason = /^[a-zA-Z0-9_-]{1,100}$/.test(observed) ? observed : 'worker_op_failed';
        delete input.result;
        await this.worker.logger.log('WARN', 'hook.op_failed', { ...details, reason: input.reason, duration_ms: this.state.sys.now() - started });
      }
      pending = input;
      await this.state.withLock('cron', () => this.state.write(hookOpFile, encode({ ...op, pending_result: input })));
    }
    const request = encode(pending);
    const result = pending.result === undefined ? undefined : object(pending.result);
    const serialized = result === undefined ? undefined : encode(result);
    const delivery = { ...details, result_bytes: serialized === undefined ? 0 : Buffer.byteLength(serialized),
      ...(serialized === undefined ? {} : { result_sha256: digest(serialized) }),
      ...(result && op.kind === 'diagnostics_export' && { captures: result.captures, complete: result.complete,
        truncated: result.truncated, omissions: result.omissions, next_cursor: result.next_cursor }) };
    try {
      const reply = await transport.request(`/api/v1/worker/ops/${identifier(op.id)}/result`, 'POST', request,
        delivery, 1, 3_000, {}, { omitInputLog: op.kind === 'diagnostics_export' });
      requireValue(reply.data.id === op.id && reply.data.held === false, 'worker_op_result_response_mismatch');
    } catch (error) {
      if (!terminalControl(error, 'stale_assignment', 'worker_op_already_terminal')) throw error;
      await this.worker.logger.log('WARN', 'hook.op_result_terminal', { ...details, reason: (error as Failure).fields.reason });
    }
    await this.worker.logger.log('INFO', 'hook.op_completed', { ...delivery, outcome: pending.outcome });
    await this.state.withLock('cron', () => this.state.remove(hookOpFile));
    return 'worker_op_settled';
  }
}
