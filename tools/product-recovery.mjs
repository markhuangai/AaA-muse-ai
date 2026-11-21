import { identifier, instant, need, same } from './qualification-evidence.mjs';

const after = (time, boundary) => Date.parse(time) > Date.parse(boundary);
const before = (time, boundary) => Date.parse(time) <= Date.parse(boundary);

function comparableStatus(status) {
  if (!status.configuration || !Object.hasOwn(status.configuration, 'client_keys')) return status;
  const keys = status.configuration.client_keys;
  need(keys === '[REDACTED]' || keys && typeof keys === 'object' && !Array.isArray(keys) && Object.values(keys).every(value => value === '[REDACTED]'), 'broker_status_not_redacted');
  return { ...status, configuration: { ...status.configuration, client_keys: '[REDACTED]' } };
}

export function brokerBoundary(report, broker, item) {
  const checkpoint = report.checkpoints?.broker, cycle = report.cycles.find(value => value.id === checkpoint?.cycle_id);
  need(cycle?.turns?.length === 3 && cycle.outcome === 'passed', 'pending_broker_cycle_required');
  const [pending, continued, replay] = cycle.turns;
  need(identifier(checkpoint.pending_call_id) && checkpoint.pending_call_id === cycle.call_id && checkpoint.completed_request_id === continued.operation_id &&
    pending.operation_id !== continued.operation_id && continued.operation_id === replay.operation_id && cycle.client_tool_executions === 1, 'broker_tool_continuation_identity_required');
  need(instant(checkpoint.prepared_at) && instant(checkpoint.resumed_at) && before(pending.finished_at, checkpoint.prepared_at) && before(checkpoint.resumed_at, continued.started_at), 'broker_checkpoint_order_required');
  need(item?.operation_ids?.includes(pending.operation_id) && item.operation_ids.includes(continued.operation_id) && item.call_id === cycle.call_id &&
    item.session_id === cycle.session_id && item.conversation_id === pending.conversation_id && item.worker_ids?.length === 1 && item.worker_ids[0] === pending.worker_id &&
    continued.worker_id === pending.worker_id && continued.session_id === pending.session_id && continued.conversation_id === pending.conversation_id, 'broker_case_scope_required');
  const action = report.observations.find(entry => entry.kind === 'product_case' && entry.case_id === 'recovery.broker-tool-wait' &&
    entry.worker_ids?.length === 1 && entry.worker_ids[0] === pending.worker_id && entry.operation_ids?.includes(pending.operation_id) &&
    before(checkpoint.prepared_at, entry.time) && before(entry.time, checkpoint.resumed_at));
  need(action, 'scoped_owner_broker_action_required');
  const statuses = [];
  // Server response logging can follow client receipt; the owner action bounds the pre-restart response.
  for (const [side, earliest, latest] of [['before', pending.finished_at, action.time], ['after', action.time, checkpoint.resumed_at]]) {
    const status = checkpoint[side + '_status'], instance = checkpoint[side + '_instance'];
    need(identifier(instance) && status?.instance_id === instance && status.ready === true && same(status.build, report.status_receipt.build), 'broker_status_identity_required');
    const event = broker.find(event => {
      if (event.msg !== 'request.exchange' || event.route !== '/api/v1/admin/status' || event.role !== 'management' || event.status !== 200 || event.instance_id !== instance ||
        !before(earliest, event.time) || !before(event.time, latest)) return false;
      try { return same(comparableStatus(JSON.parse(event.response)), comparableStatus(status)); } catch { return false; }
    });
    need(event, 'authenticated_broker_status_required');
    statuses.push(event);
  }
  need(checkpoint.before_instance !== checkpoint.after_instance, 'new_broker_process_required');
  const startup = broker.find(event => event.msg === 'recovery.started' && event.instance_id === checkpoint.after_instance && after(event.time, action.time) && before(event.time, statuses[1].time));
  need(startup, 'post_action_broker_start_required');
  need(broker.some(event => event.msg === 'decision.accepted' && event.instance_id === checkpoint.before_instance && event.operation_id === pending.operation_id &&
    event.job_id === pending.job_id && event.worker_id === pending.worker_id && event.decision_type === 'tool_call' && event.call_id === cycle.call_id && before(event.time, checkpoint.prepared_at)), 'authenticated_pending_tool_required');
  need(broker.some(event => event.msg === 'recovery.restored' && event.instance_id === checkpoint.after_instance && event.operation_id === pending.operation_id &&
    event.job_id === pending.job_id && event.conversation_id === pending.conversation_id && event.pinned_worker_id === pending.worker_id && event.pending_call_id === cycle.call_id &&
    !after(startup.time, event.time) && before(event.time, statuses[1].time)), 'authenticated_pending_tool_restoration_required');
  need(broker.some(event => event.msg === 'decision.accepted' && event.instance_id === checkpoint.after_instance && event.operation_id === continued.operation_id &&
    event.job_id === continued.job_id && event.worker_id === continued.worker_id && event.decision_type === 'final' && before(checkpoint.resumed_at, event.time)), 'authenticated_resumed_tool_required');
  return checkpoint;
}

export function replacementBoundary(workers, originalID, replacementID) {
  const original = workers.find(worker => worker.id === originalID), replacement = workers.find(worker => worker.id === replacementID);
  need(original?.connection_status === 'offline' && original.work_status === 'unknown' && original.current_job === null && original.waiting_for_client_tool === 0,
    'original_worker_must_be_confirmed_offline_without_held_work');
  need(replacement?.connection_status === 'online' && replacement.work_status === 'idle' && replacement.current_job === null && replacement.waiting_for_client_tool === 0,
    'healthy_replacement_worker_required');
}

export function recoveryBoundary(report, id, workers, { probe = true, item } = {}) {
  const observed = report.observations.find(entry => entry.kind === 'product_case' && entry.case_id === id);
  need(observed?.worker_ids?.length === 1 && instant(observed.action_at), 'scoped_recovery_action_required');
  const workerID = observed.worker_ids[0], setup = report.observations.find(entry => entry.kind === 'setup_ended' && entry.worker_id === workerID);
  need(setup && identifier(setup.hook_id) && identifier(setup.setup_id) && setup.hook_path && observed.hook_id === setup.hook_id && observed.hook_path === setup.hook_path, 'retained_recovery_hook_required');
  need(identifier(observed.before_connection_id) && observed.before_connection_generation > 0, 'prior_recovery_connection_required');
  if (id === 'recovery.refresh') {
    const approval = report.observations.find(entry => entry.kind === 'refresh_approval' && entry.worker_id === workerID && entry.hook_id === setup.hook_id && entry.owner === true && entry.destructive === false && entry.scope);
    const performed = report.observations.find(entry => entry.kind === 'refresh_performed' && entry.worker_id === workerID && entry.hook_id === setup.hook_id && entry.scope === approval?.scope && entry.time === observed.action_at && after(entry.time, approval?.time));
    need(performed, 'approved_scoped_refresh_sequence_required');
  }
  const connected = report.observations.find(entry => entry.kind === (id === 'recovery.refresh' ? 'refresh_reconnected' : 'worker_reconnected') && entry.worker_id === workerID &&
    entry.hook_id === setup.hook_id && entry.hook_path === setup.hook_path && after(entry.time, observed.action_at) && entry.consumer_count === 1 && entry.state_mode === '0700' && entry.key_file_mode === '0600' &&
    entry.reinstalled === false && entry.reenrolled === false && entry.manual_message === false && identifier(entry.connection_id) && entry.connection_id !== observed.before_connection_id && entry.connection_generation > observed.before_connection_generation);
  need(connected, 'observed_recovery_connection_required');
  const started = workers.find(event => event.msg === 'setup.subscriber_started' && event.worker_id === workerID && event.setup_id === setup.setup_id && event.pid > 0 && after(event.time, observed.action_at) && before(event.time, connected.time));
  need(started, 'post_action_subscriber_start_required');
  const supervisor = workers.find(event => event.msg === 'worker.supervision_started' && event.worker_id === workerID && event.pid === started.pid && after(event.time, observed.action_at) && before(event.time, connected.time));
  need(supervisor && workers.some(event => event.msg === 'worker.connected' && event.worker_id === workerID && event.instance_id === supervisor.instance_id && event.connection_id === connected.connection_id && event.connection_generation === connected.connection_generation && after(event.time, observed.action_at) && before(event.time, connected.time)), 'authenticated_recovered_subscriber_required');
  need(!workers.some(event => event.msg === 'setup.assets' && event.worker_id === workerID && after(event.time, observed.action_at) && before(event.time, connected.time)), 'recovery_must_not_reinstall');
  if (probe) need(workers.some(event => event.msg === 'worker.context' && event.worker_id === workerID && item?.operation_ids?.includes(event.operation_id) &&
    event.connection_id === connected.connection_id && event.connection_generation === connected.connection_generation && after(event.time, connected.time)), 'probe_on_recovered_connection_required');
  return { worker_id: workerID, hook_id: setup.hook_id, hook_path: setup.hook_path, action_at: observed.action_at, reconnected_at: connected.time,
    connection_id: connected.connection_id, connection_generation: connected.connection_generation, before_connection_id: observed.before_connection_id, before_connection_generation: observed.before_connection_generation };
}
