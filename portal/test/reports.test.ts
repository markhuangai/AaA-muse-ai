import { expect, test } from 'vitest';
import { APIError, type BrowserReport } from '../src/api';
import { Reports } from '../src/reports';
import { TestAPI, TestSystem, deferred, settle } from './helpers';

const report = (): Omit<BrowserReport, 'build' | 'omitted_reports'> => ({ event: 'portal.state_stale', component: 'settings', cause: 'request_failed', request_id: '', operation_id: 'operation', expected_state: 'fresh', observed_state: 'stale', last_good_at: null, duration_ms: 0, attempt: 1 });

test('reports bound the queue, preserve omissions, and send complete allowlisted reports', async () => {
  const api = new TestAPI(new TestSystem()); const reports = new Reports(api);
  const first = deferred<void>(); let calls = 0;
  api.reportWork = async () => { if (++calls === 1) await first.promise; };
  for (let i = 0; i < 25; i++) reports.add(report());
  await reports.flush(); expect(api.reports).toHaveLength(1);
  first.resolve(); await settle(); await reports.flush();
  expect(api.reports).toHaveLength(20);
  expect(api.reports[1].omitted_reports).toBe(5);
  expect(api.reports.every(value => value.build === 'development' && value.event === 'portal.state_stale')).toBe(true);
  reports.clear();
});

test('temporary failure retains memory-only reports; unauthorized reporting clears them', async () => {
  const api = new TestAPI(new TestSystem()); const reports = new Reports(api);
  api.reportWork = async () => { throw new Error('untrusted network details'); };
  reports.add(report()); await settle();
  api.reportWork = async () => {}; await reports.flush();
  expect(api.reports).toHaveLength(2);
  api.reportWork = async () => { throw new APIError('unauthorized', 401); };
  reports.add(report()); await settle();
  api.reportWork = async () => {}; await reports.flush();
  expect(api.reports).toHaveLength(3);
});

test('clearing a session fences pending report successes and failures', async () => {
  for (const fail of [false, true]) {
    const api = new TestAPI(new TestSystem()); const reports = new Reports(api);
    const pending = deferred<void>(); api.reportWork = () => pending.promise;
    reports.add(report()); reports.clear();
    api.reportWork = async () => {}; reports.add(report());
    if (fail) pending.reject(new Error('old session')); else pending.resolve();
    await settle(); await reports.flush(); expect(api.reports).toHaveLength(2);
  }
});
