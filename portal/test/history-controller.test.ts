import { expect, test } from 'vitest';
import { APIError } from '../src/api';
import { PortalController } from '../src/controller';
import { HistoryController } from '../src/history-controller';
import type { RequestDetail } from '../src/history-api';
import { Reports } from '../src/reports';
import { TestAPI, TestSystem, deferred, settle } from './helpers';
import { conversationID, detail, entry, execution, requestID, summary } from './history-fixtures';

function fixture() {
  const system = new TestSystem(), api = new TestAPI(system), session = { valid: true, denied: 0 };
  const reports = new Reports(api);
  const controller = new HistoryController(api, system, reports, () => session.valid, () => { session.denied++; session.valid = false; controller.reset(); });
  return { system, api, session, controller };
}
async function active() { const f = fixture(); f.controller.activate(); await settle(); return f; }

test('activation and subscription run real history state only while authorized', async () => {
  const f = fixture(); let changes = 0; const unsubscribe = f.controller.subscribe(() => changes++);
  await f.controller.refresh(); await f.controller.filter(''); await f.controller.select(requestID); await f.controller.page('list', 'first'); await f.controller.cancel(requestID); f.controller.renderFailed();
  expect(f.api.historyCalls.list).toBe(0); expect(f.controller.canCancel()).toBe(false);
  f.controller.activate(); f.controller.activate(); await settle();
  expect(f.api.historyCalls.list).toBe(1); expect(f.controller.snapshot().list.value?.items[0].id).toBe(requestID); expect(changes).toBeGreaterThan(0);
  unsubscribe(); const before = changes; f.controller.reset(); expect(changes).toBe(before);
  f.session.valid = false; f.controller.activate(); await settle(); await f.system.advance(30_000); expect(f.api.historyCalls.list).toBe(1); f.controller.reset();
});
test('bounded list pages keep cursor history and filters independent of selected request', async () => {
  const f = await active(); const calls: string[] = [];
  f.api.requestsWork = async (conversation, cursor) => { calls.push(`${conversation}:${cursor}`); return { value: { items: [summary()], ...(cursor === 'last' ? {} : { next_cursor: cursor ? 'last' : 'older' }) }, requestID: 'paged' }; };
  await f.controller.refresh(); await f.controller.page('list', 'previous'); await f.controller.page('list', 'next');
  expect(f.controller.snapshot().list.cursor).toBe('older');
  await f.controller.page('list', 'next'); await f.controller.page('list', 'next'); expect(f.controller.snapshot().list.back).toEqual(['', 'older']);
  await f.controller.page('list', 'previous'); expect(f.controller.snapshot().list.cursor).toBe('older');
  await f.controller.page('list', 'first'); expect(f.controller.snapshot().list.back).toEqual([]);
  await f.controller.filter('bad id'); expect(f.controller.snapshot().list.message).toContain('conversation ID');
  await f.controller.filter(`  ${conversationID}  `); expect(calls.at(-1)).toBe(conversationID + ':'); expect(f.controller.snapshot().selectedID).toBe('');
  await f.controller.select('bad id'); expect(f.controller.snapshot().list.message).toBe('Enter a valid request ID.');
  await f.controller.filter(''); expect(f.controller.snapshot().conversation).toBe(''); f.controller.reset();
});
test('timeline pages preserve linkage and refresh only the anchored page', async () => {
  const f = await active(); const cursors: string[] = [];
  f.api.timelineWork = async (conversation, cursor) => { expect(conversation).toBe(conversationID); cursors.push(cursor); return { value: { items: [entry(cursor ? 50 : 0)], ...(cursor ? {} : { next_cursor: 'next-events' }) }, requestID: 'events' }; };
  await f.controller.select(requestID); expect(f.controller.canCancel()).toBe(true);
  await f.controller.page('timeline', 'previous'); await f.controller.refresh(false); expect(cursors).toEqual(['']);
  await f.controller.page('timeline', 'next'); expect(f.controller.snapshot().timeline.value?.items[0].sequence).toBe(50);
  await f.controller.refresh(false); expect(cursors.at(-1)).toBe('next-events');
  await f.controller.page('timeline', 'previous'); await f.controller.page('timeline', 'next'); await f.controller.page('timeline', 'first');
  expect(f.controller.snapshot().selectedID).toBe(requestID); expect(f.controller.snapshot().timeline.cursor).toBe('');
  await f.controller.select(''); expect(f.controller.snapshot().detail.value).toBeNull(); await f.controller.page('timeline', 'first'); f.controller.reset();
});
test('older list pages do not shift under polling and stale snapshots retain their data', async () => {
  const f = await active();
  f.api.requestsWork = async () => ({ value: { items: [summary()], next_cursor: 'older' }, requestID: 'list' });
  await f.controller.refresh(); await f.controller.page('list', 'next'); const count = f.api.historyCalls.list;
  await f.system.advance(30_000); expect(f.api.historyCalls.list).toBe(count);
  await f.system.visibility(false); await f.system.advance(30_001);
  expect(f.controller.snapshot().list.stale).toBe(true); expect(f.controller.snapshot().list.value?.items).toHaveLength(1);
  expect(f.api.reports.some(report => report.cause === 'stale_data')).toBe(true);
  await f.system.visibility(true); expect(f.api.historyCalls.list).toBe(count);
  await f.controller.refresh(); expect(f.api.historyCalls.list).toBe(count + 1); f.controller.reset();
});
test('filter, selection and request sequences reject superseded results with safe correlation', async () => {
  const f = await active();
  const oldList = deferred<{ value: { items: ReturnType<typeof summary>[] }; requestID: string }>();
  f.api.requestsWork = () => oldList.promise; const refresh = f.controller.refresh();
  f.api.requestsWork = async () => ({ value: { items: [] }, requestID: 'new-list' }); await f.controller.filter(conversationID);
  oldList.resolve({ value: { items: [summary()] }, requestID: 'old-list' }); await refresh;
  expect(f.controller.snapshot().list.value?.items).toEqual([]);
  const oldDetail = deferred<{ value: RequestDetail; requestID: string }>(); f.api.detailWork = () => oldDetail.promise;
  const read = f.controller.select(requestID); await f.controller.select(''); oldDetail.resolve({ value: detail(), requestID: 'old-detail' }); await read;
  expect(f.controller.snapshot().detail.value).toBeNull();
  expect(f.api.reports.filter(report => report.cause === 'obsolete_response')).toHaveLength(2);
  const data = JSON.stringify(f.api.reports); expect(data).not.toContain('Exact input'); expect(data).not.toContain('<img'); f.controller.reset();
});
test('obsolete failures cannot replace a newer successful page', async () => {
  const f = await active(); const old = deferred<never>(); f.api.requestsWork = () => old.promise; const reading = f.controller.refresh();
  f.api.requestsWork = async () => ({ value: { items: [] }, requestID: 'fresh-list' }); await f.controller.refresh();
  old.reject(new APIError('request_timeout')); await reading;
  expect(f.controller.snapshot().list.requestID).toBe('fresh-list'); expect(f.controller.snapshot().list.stale).toBe(false); f.controller.reset();
});
test.each([[404, 'history_not_found', 'not found'], [400, 'invalid_cursor', 'cursor'], [200, 'invalid_response', 'invalid'], [503, 'service_unavailable', 'Could not'], [0, 'request_timeout', 'Could not'], [403, 'request_failed', 'Could not']])('read failures preserve safe causes and visible uncertainty (%s %s)', async (status, cause, message) => {
  const f = await active(); f.api.requestsWork = async () => { throw new APIError(String(cause), Number(status), 'failed-http'); };
  await f.controller.refresh(); expect(f.controller.snapshot().list.message).toContain(String(message)); expect(f.controller.snapshot().list.stale).toBe(true); expect(f.controller.snapshot().list.value?.items).toHaveLength(1);
  expect(f.api.reports.at(-1)?.request_id).toBe('failed-http'); f.controller.reset();
});
test('plain failures and missing current names remain explicit; invalid sessions clear all history', async () => {
  const f = await active(); f.api.workersWork = async () => { throw new Error('private network exception'); }; f.api.detailWork = async () => { throw new Error('private render payload'); };
  await f.controller.select(requestID); await f.controller.refresh(); expect(f.controller.snapshot().namesStale).toBe(true); expect(f.controller.snapshot().detail.stale).toBe(true);
  expect(JSON.stringify(f.api.reports)).not.toContain('private');
  f.api.workersWork = async () => { throw new APIError('unauthorized', 401); }; await f.controller.refresh(); expect(f.session.denied).toBe(1); expect(f.controller.snapshot().list.value).toBeNull();
  const g = await active(); g.api.requestsWork = async () => { throw new APIError('unauthorized', 401); }; await g.controller.refresh(); expect(g.session.denied).toBe(1);
});
test('late results and name failures after reset cannot restore the previous session', async () => {
  const f = await active(), oldList = deferred<never>(), oldNames = deferred<never>();
  f.api.requestsWork = () => oldList.promise; f.api.workersWork = () => oldNames.promise;
  const pending = f.controller.refresh(); f.controller.reset(); oldList.reject(new Error('old')); oldNames.reject(new Error('old')); await pending;
  expect(f.controller.snapshot().list.message).toBe(''); expect(f.api.reports).toEqual([]);
  const g = await active(), delayed = deferred<{ value: { items: ReturnType<typeof summary>[] }; requestID: string }>();
  g.api.requestsWork = () => delayed.promise; const reading = g.controller.refresh(); g.controller.reset(); delayed.resolve({ value: { items: [summary()] }, requestID: 'old' }); await reading;
  expect(g.controller.snapshot().list.value).toBeNull();
});
test('confirmed cancellation uses immutable identity, one submission and authoritative reconciliation', async () => {
  const f = await active(); let state = detail(); const submissions: string[] = [];
  f.api.detailWork = async () => ({ value: state, requestID: 'detail-now' });
  f.api.cancelWork = async (id, submission) => { expect(id).toBe(requestID); submissions.push(submission); state = { ...detail('cancelled'), execution: { ...execution('cancelled'), remote_outcome: 'unknown' }, assignment: { held: true } }; return { value: state.execution, requestID: 'cancel-committed' }; };
  await f.controller.select(requestID); await f.controller.cancel('different'); expect(submissions).toEqual([]);
  await f.controller.cancel(requestID); expect(submissions).toHaveLength(1); expect(f.controller.snapshot().detail.value?.execution.remote_outcome).toBe('unknown');
  expect(f.controller.snapshot().actionMessage).toContain('Remote execution stopping is not guaranteed'); expect(f.controller.canCancel()).toBe(false); expect(f.controller.snapshot().pending).toBe(false);
  await f.controller.cancel(requestID); expect(submissions).toHaveLength(1); f.controller.reset();
});
test('pending cancellation fences old reads and blocks selection or duplicate mutations', async () => {
  const f = await active(); await f.controller.select(requestID);
  const pending = deferred<{ value: ReturnType<typeof execution>; requestID: string }>(); f.api.cancelWork = () => pending.promise;
  const cancel = f.controller.cancel(requestID); const calls = { ...f.api.historyCalls };
  await f.controller.refresh(); await f.controller.select(''); await f.controller.filter(''); await f.controller.page('list', 'first'); await f.controller.cancel(requestID);
  expect(f.controller.snapshot().selectedID).toBe(requestID); expect(f.api.historyCalls).toEqual(calls);
  f.controller.reset(); pending.resolve({ value: execution('cancelled'), requestID: 'old-cancel' }); await cancel; expect(f.controller.snapshot().actionMessage).toBe('');
});
test.each([[0, 'request_failed'], [0, 'request_timeout'], [200, 'invalid_response'], [409, 'experiment_already_completed'], [503, 'service_unavailable']])('failed cancellation remains unconfirmed or rejected without automatic retry (%s %s)', async (status, cause) => {
  const f = await active(); await f.controller.select(requestID); f.api.cancelWork = async () => { throw new APIError(String(cause), Number(status), 'cancel-http'); };
  await f.controller.cancel(requestID); expect(f.api.historyCalls.cancel).toBe(1); expect(f.controller.canCancel()).toBe(false); expect(f.controller.snapshot().detail.stale).toBe(true);
  const rejected = Number(status) >= 400 && Number(status) < 500;
  expect(f.controller.snapshot().unconfirmed).toBe(!rejected); expect(f.controller.snapshot().actionMessage).toContain(rejected ? 'rejected cancellation' : 'could not be confirmed');
  if (!rejected) { expect(f.api.reports.at(-1)?.event).toBe('portal.cancel_result'); await f.controller.refresh(); expect(f.controller.snapshot().actionMessage).toContain('Current server state'); }
  f.controller.reset();
});
test('cancel denial, plain errors and late rejected responses obey session fencing', async () => {
  const f = await active(); await f.controller.select(requestID); f.api.cancelWork = async () => { throw new Error('private transport cause'); };
  await f.controller.cancel(requestID); expect(f.controller.snapshot().unconfirmed).toBe(true); await f.controller.refresh();
  f.api.cancelWork = async () => { throw new APIError('unauthorized', 401); }; await f.controller.cancel(requestID); expect(f.session.denied).toBe(1);
  const g = await active(); await g.controller.select(requestID); const delay = deferred<never>(); g.api.cancelWork = () => delay.promise;
  const pending = g.controller.cancel(requestID); g.controller.reset(); delay.reject(new Error('old')); await pending; expect(g.controller.snapshot().actionMessage).toBe('');
});
test('history render reports identify the actual history source and no payload content', async () => {
  const f = await active(); f.controller.renderFailed(); await settle(); expect(f.api.reports.at(-1)?.request_id).toBe('history-list');
  await f.controller.select(requestID); f.controller.renderFailed(); await settle();
  expect(f.api.reports.at(-1)).toMatchObject({ event: 'portal.render_failed', component: 'history', request_id: 'history-detail', request_record_id: requestID, expected_state: 'rendered', observed_state: 'failed' }); f.controller.reset();
});
test('logout records pending history abandonment before revoking session authority', async () => {
  const system = new TestSystem(), api = new TestAPI(system), portal = new PortalController(api, system);
  portal.navigate('requests'); await portal.login('not-retained'); await settle();
  const pending = deferred<{ value: { items: ReturnType<typeof summary>[] }; requestID: string }>();
  api.requestsWork = () => pending.promise; const read = portal.history.refresh();
  const report = deferred<void>(); api.reportWork = () => report.promise;
  const logout = portal.logout(); await settle();
  expect(api.credential).not.toBeNull(); expect(api.logoutCalls).toBe(0);
  expect(api.reports.at(-1)).toMatchObject({ event: 'portal.history_load_failed', cause: 'obsolete_response', query_kind: 'requests' });
  expect(portal.history.snapshot().list.value).toBeNull();
  report.resolve(); await logout; expect(api.credential).toBeNull(); expect(api.logoutCalls).toBe(1);
  pending.resolve({ value: { items: [summary()] }, requestID: 'abandoned-source' }); await read;
  expect(portal.history.snapshot().list.value).toBeNull(); portal.dispose();
});
test('portal login activates history independently of delayed settings; navigation/logout/expiry remove authority', async () => {
  const system = new TestSystem(), api = new TestAPI(system), controller = new PortalController(api, system), delayed = deferred<{ value: ReturnType<typeof import('./helpers').settings>; requestID: string }>();
  controller.navigate('requests'); api.settingsWork = () => delayed.promise; const login = controller.login('not-retained'); await settle(); expect(controller.history.snapshot().list.value?.items).toHaveLength(1);
  controller.renderFailed(); await settle(); expect(api.reports.at(-1)?.component).toBe('history');
  delayed.resolve({ value: (await import('./helpers')).settings(), requestID: 'settings' }); await login;
  await controller.history.select(requestID); controller.navigate('settings'); expect(controller.history.snapshot().detail.value).toBeNull();
  controller.navigate('requests'); await settle(); await controller.logout(); expect(controller.history.snapshot().list.value).toBeNull();
  await controller.login('not-retained'); await system.advance(1_800_001); expect(controller.snapshot().phase).toBe('login'); expect(controller.history.snapshot().list.value).toBeNull(); controller.dispose();
});
