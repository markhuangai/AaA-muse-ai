import { identifier, same } from './qualification-evidence.mjs';

const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const reference = value => typeof value === 'string' && value.trim().length > 0;

export function nativeTurnObserved(entry, events = [], decision) {
  if (identifier(entry?.native_conversation_id)) return entry.native_execution === undefined;
  const run = entry?.native_execution;
  if (entry?.native_conversation_id !== null || run?.kind !== 'background_agent' || !uuid(run.agent_id) ||
    !['completed_notified', 'completed_noop'].includes(run.status) || !['shutdown', 'completed'].includes(run.agent_status) || run.session_id !== null || !reference(run.source_ref) ||
    !identifier(entry.worker_id) || !identifier(entry.job_id) || !Array.isArray(events) ||
    !decision || !['final', 'tool_call'].includes(decision.type)) return false;
  const invocation = typeof entry.native_invocation_id === 'string' ? entry.native_invocation_id.replace(/^event-hook:/, '') : undefined;
  if (!uuid(invocation) || run.run_id !== 'event-hook:' + invocation || !Array.isArray(run.commands) || run.commands.length !== 2) return false;
  const actions = ['job-show', 'decision-submit'];
  const ids = [entry.context_command_id, entry.decision_command_id];
  if (!ids.every(identifier) || ids[0] === ids[1]) return false;
  const commands = actions.map(action => run.commands.find(command => command?.action === action));
  if (!commands.every((command, index) => command?.agent_id === run.agent_id && command.job_id === entry.job_id && command.command_id === ids[index] &&
    identifier(command.call_id) && Number.isSafeInteger(command.tool_call_item_id) && command.tool_call_item_id > 0 &&
    Number.isSafeInteger(command.tool_output_item_id) && command.tool_output_item_id > 0 &&
    command.call_names_job_id === true && command.output_success === true && command.worker_command_id_matches_captured === true)) return false;
  if (new Set(commands.map(command => command.call_id)).size !== 2 ||
    new Set(commands.flatMap(command => [command.tool_call_item_id, command.tool_output_item_id])).size !== 4) return false;
  const matching = (event, command) => event?.worker_id === entry.worker_id && event.job_id === entry.job_id && event.command_id === command;
  return events.some(event => matching(event, ids[0]) && event.msg === 'worker.context') &&
    events.some(event => matching(event, ids[1]) && event.msg === 'worker.decision_input' && event.input_complete === true && same(event.input, decision)) &&
    events.some(event => matching(event, ids[1]) && event.msg === 'worker.operation_accepted' && event.operation === 'decision');
}
