import { requireValue } from './errors.js';
import { identifier, integer, object, text, type ObjectValue, type Value } from './json.js';

export function version(value: Value | undefined): void { requireValue(integer(value) === 1, 'unsupported_protocol_version'); }
export function job(value: ObjectValue, workerId: string, jobId: string): ObjectValue {
  version(value.protocol_version);
  requireValue(identifier(value.id) === jobId && identifier(value.worker_id) === workerId, 'job_owner_mismatch');
  identifier(value.conversation_id); identifier(value.experiment_id);
  requireValue(['queued', 'claimed', 'accepted', 'cancelled', 'interrupted'].includes(text(value.state)), 'invalid_job_state');
  requireValue(Number.isFinite(Date.parse(text(value.deadline_at))), 'invalid_job_deadline');
  integer(value.generation);
  const context = object(value.context);
  identifier(context.receipt_id);
  requireValue(['full', 'delta'].includes(text(context.kind)) && Array.isArray(context.messages) && Array.isArray(context.tools), 'invalid_context');
  integer(context.history_count); integer(context.base_prefix);
  requireValue(/^[a-f0-9]{64}$/.test(text(context.canonical_sha256)), 'invalid_context_hash');
  if (context.kind === 'delta') { identifier(context.base_receipt_id); requireValue(/^[a-f0-9]{64}$/.test(text(context.base_sha256)), 'invalid_context_base'); }
  if (value.state === 'claimed') {
    identifier(value.lease_id); identifier(value.connection_id);
    requireValue(integer(value.generation) > 0 && integer(value.connection_generation) > 0 && value.held === true, 'invalid_assignment');
  }
  return value;
}
export function correlation(j: ObjectValue): Record<string, Value> {
  const context = object(j.context);
  return { worker_id: j.worker_id, operation_id: j.experiment_id, conversation_id: j.conversation_id, job_id: j.id, generation: j.generation, connection_id: j.connection_id, connection_generation: j.connection_generation, context_receipt_id: context.receipt_id, context_kind: context.kind, base_receipt_id: context.base_receipt_id ?? '', deadline_at: j.deadline_at };
}

export function connection(value: ObjectValue): void {
  version(value.protocol_version);
  identifier(value.connection_id);
  requireValue(integer(value.connection_generation) > 0, 'invalid_connection_generation');
}
