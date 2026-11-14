import { expect, test } from 'vitest';
import { BrowserAPI } from '../src/api';
import { historyCursor, historyID, isDetail, isExecution, isHistoryPage, isSummary, isTimelineEntry, parseRecordedJSON } from '../src/history-api';
import { conversationID, detail, entry, execution, requestID, summary } from './history-fixtures';
import { token } from './helpers';

const signal = () => new AbortController().signal;
test('recorded JSON preserves admitted numeric values through the actual history transport', async () => {
  const raw = '{"large":9007199254740993,"fraction":0.123456789012345678901,"exponent":1e400,"safe":42,"array":[true,null,"text"]}';
  expect(JSON.stringify(parseRecordedJSON(raw))).toBe(raw);
  const snapshot = JSON.stringify(detail()).replace('"input":{', '"input":{"numeric_fixture":' + raw + ',');
  const api = new BrowserAPI((async () => new Response(snapshot)) as typeof fetch);
  expect(JSON.stringify((await api.requestDetail(requestID, 'op-numeric', signal())).value.request.input)).toContain(raw);
  expect(() => parseRecordedJSON('{')).toThrow();
});
function adapter(data: unknown, status = 200) {
  const calls: { path: string; options: RequestInit }[] = [];
  const api = new BrowserAPI((async (path, options) => { calls.push({ path: String(path), options: options! }); return new Response(JSON.stringify(data), { status, headers: { 'X-Request-Id': 'history-http' } }); }) as typeof fetch);
  api.setSession(token);
  return { api, calls };
}
test('history boundaries validate admitted projections, cursors and optional legacy fields', () => {
  expect(historyID('bad id')).toBe(false); expect(historyID('a'.repeat(101))).toBe(false); expect(historyCursor('a'.repeat(1025))).toBe(false);
  expect(isSummary(summary())).toBe(true); expect(isSummary({ ...summary(), client_id: null, session_id: null, worker_id: null, response_id: null, reason: null, kind: 'legacy' })).toBe(true);
  for (const patch of [{ id: 'bad id' }, { created_at: 'bad' }, { state: 1 }, { reason: 3 }, { client_id: 2 }, { response_id: 'bad id' }, { provenance: null }, { kind: 'unknown' }]) expect(isSummary({ ...summary(), ...patch })).toBe(false);
  expect(isExecution(execution())).toBe(true); expect(isExecution({ ...execution(), worker_id: null, current_job_id: '', reason: null })).toBe(true);
  for (const patch of [{ deadline_at: 'bad' }, { remote_outcome: null }, { current_job_id: 'bad id' }, { reason: {} }]) expect(isExecution({ ...execution(), ...patch })).toBe(false);
  expect(isDetail(detail())).toBe(true); expect(isDetail({ ...detail(), kind: 'legacy', assignment: null, delivery: null, history: [] })).toBe(true);
  for (const patch of [{ request: null }, { assignment: [] }, { delivery: 1 }, { history: [null] }, { execution: { ...execution(), id: 'different' } }]) expect(isDetail({ ...detail(), ...patch })).toBe(false);
  expect(isTimelineEntry(entry())).toBe(true); expect(isTimelineEntry({ ...entry(), time: null, level: null, request_id: null, item: null, details: null })).toBe(true);
  for (const patch of [{ sequence: -1 }, { sequence: 0.2 }, { time: 'bad' }, { kind: null }, { details: [] }, { item: 1 }, { level: 3 }, { request_id: 'bad id' }]) expect(isTimelineEntry({ ...entry(), ...patch })).toBe(false);
  expect(isHistoryPage({ items: [] }, isSummary)).toBe(true); expect(isHistoryPage({ items: Array.from({ length: 51 }, () => summary()) }, isSummary)).toBe(false);
  expect(isHistoryPage({ items: [], next_cursor: '' }, isSummary)).toBe(false);
});
test('real adapter uses bounded management reads and existing cancellation with distinct session authority', async () => {
  const list = adapter({ items: [summary()], next_cursor: 'cursor_1' });
  expect((await list.api.requests(conversationID, 'cursor_0', 'op-list', signal())).requestID).toBe('history-http');
  const url = new URL(list.calls[0].path, 'https://example.test');
  expect(url.pathname).toBe('/api/v1/admin/requests'); expect(Object.fromEntries(url.searchParams)).toEqual({ limit: '50', conversation_id: conversationID, cursor: 'cursor_0' });
  await adapter({ items: [] }).api.requests('', '', 'op-empty', signal());
  const one = adapter(detail()); expect((await one.api.requestDetail(requestID, 'op-detail', signal())).value).toEqual(detail());
  expect(one.calls[0].path).toBe('/api/v1/admin/requests/' + requestID);
  const timeline = adapter({ items: [entry()], next_cursor: 'more' });
  await timeline.api.timeline(conversationID, 'before', 'op-events', signal());
  expect(timeline.calls[0].path).toContain(`/conversations/${conversationID}/timeline?limit=50&cursor=before`);
  await adapter({ items: [] }).api.timeline(conversationID, '', 'op-events', signal());
  const cancel = adapter(execution('cancelled')); await cancel.api.cancelRequest(requestID, 'submission-1', 'op-cancel', signal());
  expect(cancel.calls[0].path).toBe(`/api/v1/admin/experiments/${requestID}/cancel`);
  expect(JSON.parse(cancel.calls[0].options.body as string)).toEqual({ protocol_version: 1, submission_id: 'submission-1' });
  for (const call of [...list.calls, ...one.calls, ...timeline.calls, ...cancel.calls]) {
    expect(new Headers(call.options.headers).get('Authorization')).toBe('Bearer ' + token);
    expect(call.options.credentials).toBe('omit'); expect(call.options.cache).toBe('no-store'); expect(call.path).not.toContain(token);
  }
});
test('real adapter rejects mismatched, duplicated, oversized and malformed history instead of silently dropping it', async () => {
  for (const value of [{ items: [summary(), summary()] }, { items: [summary()], next_cursor: 'bad cursor' }, { items: [{ ...summary(), conversation_id: 'wrong' }] }]) await expect(adapter(value).api.requests(conversationID, '', 'op', signal())).rejects.toMatchObject({ causeCode: 'invalid_response', requestID: 'history-http' });
  for (const value of [null, { ...detail(), request: { ...detail().request, id: 'different' }, execution: { ...execution(), id: 'different' } }]) await expect(adapter(value).api.requestDetail(requestID, 'op', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
  for (const value of [{ items: [entry(2), entry(1)] }, { items: [entry(), entry()] }, {}]) await expect(adapter(value).api.timeline(conversationID, '', 'op', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
  for (const value of [{}, { ...execution(), id: 'different' }]) await expect(adapter(value).api.cancelRequest(requestID, 'submit', 'op', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
  const blocked = adapter({});
  for (const operation of [() => blocked.api.requests('bad id', '', 'op', signal()), () => blocked.api.requests('', 'bad cursor', 'op', signal()), () => blocked.api.requestDetail('bad id', 'op', signal()), () => blocked.api.timeline('bad id', '', 'op', signal()), () => blocked.api.timeline(conversationID, 'bad cursor', 'op', signal()), () => blocked.api.cancelRequest('bad', 'submit', 'op', signal()), () => blocked.api.cancelRequest(requestID, 'bad id', 'op', signal())]) await expect(operation()).rejects.toThrow();
  expect(blocked.calls).toHaveLength(0);
  for (const [code, status] of [['history_not_found', 404], ['invalid_cursor', 400], ['experiment_already_completed', 409], ['inference_not_found', 404], ['submission_conflict', 409]] as const) await expect(adapter({ error: code }, status).api.requestDetail(requestID, 'op', signal())).rejects.toMatchObject({ causeCode: code, status });
});
