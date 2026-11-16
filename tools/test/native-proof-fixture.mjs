export function backgroundTurn(entry, events, serial, decision) {
  const agent = '10000000-0000-4000-8000-' + String(serial).padStart(12, '0');
  const invocation = '20000000-0000-4000-8000-' + String(serial).padStart(12, '0');
  const context = events.find(event => event.msg === 'worker.context' && event.job_id === entry.job_id);
  entry.worker_id ??= context.worker_id;
  entry.native_conversation_id = null;
  entry.native_invocation_id = invocation;
  entry.context_command_id = 'context-' + entry.job_id;
  entry.decision_command_id = 'decision-' + entry.job_id;
  context.command_id = entry.context_command_id;
  const link = { worker_id: entry.worker_id, job_id: entry.job_id, command_id: entry.decision_command_id };
  events.push({ ...link, msg: 'worker.decision_input', input_complete: true, input: decision }, { ...link, msg: 'worker.operation_accepted', operation: 'decision' });
  entry.native_execution = {
    kind: 'background_agent', run_id: 'event-hook:' + invocation, agent_id: agent, status: 'completed_notified', agent_status: 'shutdown', session_id: null,
    source_ref: 'synthetic-native-execution-receipts', commands: ['job-show', 'decision-submit'].map((action, index) => ({
      action, agent_id: agent, job_id: entry.job_id, command_id: index ? entry.decision_command_id : entry.context_command_id,
      call_id: 'native-call-' + serial + '-' + index, tool_call_item_id: serial * 4 + index * 2 + 1, tool_output_item_id: serial * 4 + index * 2 + 2,
      call_names_job_id: true, output_success: true, worker_command_id_matches_captured: true,
    })),
  };
  return entry;
}
