import type { Execution, RequestDetail, RequestSummary, TimelineEntry } from '../src/history-api';

export const requestID = '1'.repeat(32), conversationID = '2'.repeat(32), workerID = 'a'.repeat(32);
export const execution = (state = 'queued'): Execution => ({ id: requestID, worker_id: workerID, state, remote_outcome: 'not_started', created_at: '2026-11-13T00:00:00Z', deadline_at: '2026-11-13T00:30:00Z', current_job_id: '3'.repeat(32) });
export const summary = (id = requestID): RequestSummary => ({ id, kind: 'native', conversation_id: conversationID, session_id: 'session-a', worker_id: workerID, state: 'queued', created_at: '2026-11-13T00:00:00Z', client_id: 'client-a', provenance: 'recorded', response_id: 'resp_' + id });
export const detail = (state = 'queued'): RequestDetail => ({ kind: 'native', execution: execution(state), request: { id: requestID, conversation_id: conversationID, client_id: 'client-a', session_id: 'session-a', response_id: 'resp_' + requestID, reassign_allowed: false,
  input: { messages: [{ type: 'message', role: 'user', text: '<img src=x onerror="window.__unsafe=1">\nExact input' }], tools: [{ name: 'read_file', parameters: { type: 'object' } }] } },
  assignment: { id: '3'.repeat(32), generation: 1, connection_generation: 2, held: false },
  delivery: { kind: 'full', receipt_id: '3'.repeat(32), base_receipt_id: '', messages: [], tools: [] } });
export const entry = (sequence = 0): TimelineEntry => ({ sequence, time: '2026-11-13T00:00:00Z', kind: 'history.item', level: 'INFO', request_id: requestID, item: { source: 'client_provided', item: { type: 'message', text: 'Exact input' } }, details: { item_id: 'history-item' } });
