import { expect, test, vi } from 'vitest';
import { APIError } from '../src/api';
import { PortalController } from '../src/controller';
import { Reports } from '../src/reports';
import { browserCopy, WorkersController } from '../src/worker-controller';
import { TestAPI, TestSystem, deferred, enrollment, settle, worker } from './helpers';

function fixture() {
  const system = new TestSystem(); const api = new TestAPI(system); const reports = new Reports(api);
  let permitted = true; let denials = 0; const copied: string[] = [];
  const controller = new WorkersController(api, system, reports, () => permitted, () => { denials++; controller.reset(); }, async text => { copied.push(text); });
  return { system, api, reports, controller, copied, deny: () => { permitted = false; }, denials: () => denials };
}

test('worker lifecycle keeps freshness independent and clears authority on session end or navigation', async () => {
  const { controller, system, api, deny } = fixture();
  await controller.refresh(); expect(api.workersCalls).toBe(0);
  controller.activate(); controller.activate(); await settle();
  expect(controller.snapshot().workers?.[0].id).toBe(worker().id);
  controller.select('unknown'); expect(controller.snapshot().selectedID).toBe('');
  controller.select(worker().id); expect(controller.snapshot().selectedID).toBe(worker().id);
  await system.advance(30_000); expect(api.workersCalls).toBe(2);
  await system.visibility(false); await system.advance(60_000);
  expect(controller.snapshot().stale).toBe(true);
  expect(api.reports.some(report => report.cause === 'stale_data' && report.request_sequence! > 0)).toBe(true);
  await controller.mutate('rename', worker().id, 'Ignored'); expect(controller.snapshot().pending).toBe('');
  await system.visibility(true); expect(controller.snapshot().stale).toBe(false);
  api.workersWork = async () => ({ value: [], requestID: 'empty-list' }); await controller.refresh();
  expect(controller.snapshot().selectedID).toBe('');
  deny(); await system.advance(30_000); await controller.refresh();
  controller.reset(); expect(system.timers.size).toBe(0); expect(system.listeners.size).toBe(0);
  expect(controller.snapshot().workers).toBeNull();
});

test('late list results cannot overwrite newer reads or mutations and report their ordering evidence', async () => {
  const { controller, api } = fixture(); controller.activate(); await settle();
  const old = deferred<{ value: ReturnType<typeof worker>[]; requestID: string }>(); api.workersWork = () => old.promise;
  const pending = controller.refresh();
  const renamed = worker(worker().id, 'Accepted trimmed name');
  api.renameWork = async () => ({ value: renamed, requestID: 'accepted-rename' });
  controller.select(worker().id);
  await controller.mutate('rename', worker().id, '  requested  ');
  expect(controller.snapshot().workers?.[0].name).toBe(renamed.name);
  old.resolve({ value: [worker()], requestID: 'obsolete-list' }); await pending; await settle();
  expect(controller.snapshot().workers?.[0].name).toBe(renamed.name);
  expect(api.reports.at(-1)).toMatchObject({ cause: 'obsolete_response', request_id: 'obsolete-list', accepted_sequence: 3, request_sequence: 2, latest_sequence: 3 });
  const failure = deferred<{ value: ReturnType<typeof worker>[]; requestID: string }>(); api.workersWork = () => failure.promise;
  const olderFailure = controller.refresh();
  api.workersWork = async () => ({ value: [renamed], requestID: 'new-list' }); await controller.refresh();
  failure.reject(new APIError('service_unavailable', 503, 'old-error')); await olderFailure;
  expect(controller.snapshot().stale).toBe(false); expect(controller.snapshot().requestID).toBe('new-list');
  await controller.mutate('revoke', worker().id); expect(controller.snapshot().workers?.[0].revoked_at).not.toBeNull();
  expect(controller.snapshot().actionMessage).toContain('server confirmed revocation');
  controller.reset();
});

test('unconfirmed mutations retain explicit outcomes without optimism or automatic retries', async () => {
  const { controller, api } = fixture(); controller.activate(); await settle();
  for (const [error, expected] of [
    [new APIError('invalid_worker_name', 400, 'name-error'), '1–100 Unicode'],
    [new APIError('request_failed', 403, 'denied-action'), 'denied'],
    [new APIError('worker_not_found', 404), 'not found'],
    [new APIError('request_failed', 409), 'rejected'],
    [new APIError('request_timeout', 0, 'uncertain-timeout'), 'may have completed'],
    [new Error('private detail'), 'may have completed'],
  ] as const) {
    await controller.refresh(); api.renameWork = async () => { throw error; };
    await controller.mutate('rename', worker().id, 'Requested name');
    expect(controller.snapshot().workers?.[0].name).toBe(worker().name);
    expect(controller.snapshot().actionMessage).toContain(expected);
  }
  expect(JSON.stringify(api.reports).includes('private detail')).toBe(false);
  await controller.refresh();
  const pending = deferred<{ value: ReturnType<typeof worker>; requestID: string }>(); api.revokeWork = () => pending.promise;
  const mutation = controller.mutate('revoke', worker().id);
  const calls = api.workersCalls; await controller.refresh(); controller.select(''); await controller.mutate('rename', worker().id, 'Ignored');
  expect(api.workersCalls).toBe(calls);
  controller.reset(); pending.resolve({ value: worker(), requestID: 'late-revoke' }); await mutation;
  expect(controller.snapshot().workers).toBeNull();
});

test('refresh failures and denial retain the last snapshot and never reuse ended-session responses', async () => {
  const { controller, system, api, denials } = fixture(); controller.activate(); await settle();
  for (const error of [new APIError('request_timeout'), new APIError('service_unavailable', 503, 'outage'), new APIError('request_failed', 403), new Error('private')]) {
    api.workersWork = async () => { throw error; }; await controller.refresh();
    expect(controller.snapshot().workers).not.toBeNull(); expect(controller.snapshot().stale).toBe(true);
  }
  const late = deferred<{ value: ReturnType<typeof worker>[]; requestID: string }>(); api.workersWork = () => late.promise;
  const read = controller.refresh(); controller.reset(); controller.activate();
  controller.reset(); late.resolve({ value: [worker()], requestID: 'late' }); await read; await settle();
  expect(controller.snapshot().workers).toBeNull();
  api.workersWork = async () => { throw new APIError('unauthorized', 401); }; controller.activate(); await settle();
  expect(denials()).toBe(1); expect(system.timers.size).toBe(0);
  api.workersWork = async () => ({ value: [worker()], requestID: 'fresh' }); controller.activate(); await settle();
  api.revokeWork = async () => { throw new APIError('unauthorized', 401); }; await controller.mutate('revoke', worker().id);
  expect(denials()).toBe(2);
});

test('enrollment copy, replacement, absolute expiry and suspended timers expose no stale setup text', async () => {
  const { controller, api, copied, system } = fixture();
  await controller.createEnrollment('prompt'); expect(controller.snapshot().enrollment).toBeNull();
  controller.activate(); await settle(); await controller.createEnrollment('prompt');
  await controller.copyEnrollment(); expect(copied[0] === enrollment().setup_prompt).toBe(true);
  expect(controller.snapshot().enrollmentMessage).toContain('Copied');
  const pending = deferred<{ value: ReturnType<typeof enrollment>; requestID: string }>(); api.enrollmentWork = () => pending.promise;
  const creating = controller.createEnrollment('code'); expect(controller.snapshot().enrollment).toBeNull();
  await controller.createEnrollment('prompt');
  pending.resolve({ value: enrollment('code'), requestID: 'code-issued' }); await creating;
  await controller.copyEnrollment(); expect(copied[1] === enrollment('code').enrollment_code).toBe(true);
  system.time += 900_000; await controller.copyEnrollment();
  expect(copied).toHaveLength(2); expect(controller.snapshot().enrollment).toBeNull(); expect(controller.snapshot().enrollmentMessage).toContain('expired');
  api.enrollmentWork = async kind => ({ value: { ...enrollment(kind), expires_at: new Date(system.now()+1000).toISOString() }, requestID: 'next-enrollment' });
  await controller.createEnrollment('prompt'); await system.advance(1000); expect(controller.snapshot().enrollment).toBeNull();
  await controller.copyEnrollment();
  await controller.createEnrollment('prompt'); system.time += 1001; await system.visibility(false); expect(controller.snapshot().enrollment).toBeNull();
  expect(JSON.stringify(api.reports).includes('muse_enroll_')).toBe(false); controller.reset();
});

test('enrollment errors, expired responses, logout races and clipboard failures remain explicit', async () => {
  const { controller, api, system, reports, denials } = fixture(); controller.activate(); await settle();
  for (const [error, message] of [[new APIError('worker_package_unconfigured', 503, 'pin-error'), 'Configure the worker package'], [new APIError('request_failed', 403), 'denied'], [new Error('private detail'), 'could not be confirmed']] as const) {
    api.enrollmentWork = async () => { throw error; }; await controller.createEnrollment('prompt');
    expect(controller.snapshot().enrollment).toBeNull(); expect(controller.snapshot().enrollmentMessage).toContain(message);
  }
  api.enrollmentWork = async kind => ({ value: enrollment(kind), requestID: 'issued' });
  const broken = new WorkersController(api, system, reports, () => true, () => {}, async () => { throw new Error('private clipboard'); });
  broken.activate(); await settle(); await broken.createEnrollment('prompt'); await broken.copyEnrollment();
  expect(broken.snapshot().enrollmentMessage).toContain('copy it manually'); broken.reset();
  const delayedCopy = deferred<void>(); const copying = new WorkersController(api, system, reports, () => true, () => {}, () => delayedCopy.promise);
  copying.activate(); await settle(); await copying.createEnrollment('code'); const copy = copying.copyEnrollment(); copying.reset(); delayedCopy.resolve(); await copy;
  expect(copying.snapshot().enrollment).toBeNull();
  const late = deferred<{ value: ReturnType<typeof enrollment>; requestID: string }>(); api.enrollmentWork = () => late.promise;
  const pending = controller.createEnrollment('prompt'); controller.reset(); late.reject(new Error('late')); await pending;
  expect(controller.snapshot().enrollment).toBeNull();
  controller.activate(); await settle(); api.enrollmentWork = async () => { throw new APIError('unauthorized', 401); }; await controller.createEnrollment('code'); expect(denials()).toBe(1);
  vi.stubGlobal('navigator', { clipboard: undefined }); await expect(browserCopy('text')).rejects.toThrow('clipboard_unavailable');
  let actual = ''; vi.stubGlobal('navigator', { clipboard: { writeText: async (text: string) => { actual = text; } } }); await browserCopy('exact text'); expect(actual).toBe('exact text'); vi.unstubAllGlobals();
});

test('portal ownership activates the worker page and clears it across logout, expiry and navigation', async () => {
  const system = new TestSystem(); const api = new TestAPI(system); const portal = new PortalController(api, system);
  portal.navigate('workers'); await portal.login('password'); await settle();
  expect(portal.workers.snapshot().workers).not.toBeNull(); await portal.workers.createEnrollment('code');
  portal.navigate('settings'); expect(portal.workers.snapshot().enrollment).toBeNull(); portal.navigate('settings');
  portal.navigate('workers'); await settle(); await portal.logout(); expect(portal.workers.snapshot().workers).toBeNull();
  await portal.login('password'); await settle(); system.time += 1_800_000; await portal.workers.refresh();
  expect(portal.snapshot().phase).toBe('login'); expect(portal.workers.snapshot().enrollment).toBeNull(); portal.dispose();
});

test('worker enrollment is active after authentication while an independent settings request is delayed', async () => {
  const system = new TestSystem(); const api = new TestAPI(system); const portal = new PortalController(api, system);
  const settings = deferred<Awaited<ReturnType<TestAPI['settings']>>>();
  api.settingsWork = () => settings.promise;
  portal.navigate('workers'); const login = portal.login('password'); await settle();
  expect(portal.snapshot().phase).toBe('authenticated'); expect(portal.snapshot().loading).toBe(true);
  expect(portal.workers.snapshot().workers?.[0].id).toBe(worker().id);
  await portal.workers.createEnrollment('code'); expect(portal.workers.snapshot().enrollment?.enrollment_id).toBe(enrollment('code').enrollment_id);
  settings.reject(new APIError('service_unavailable', 503)); await login;
  expect(portal.snapshot().stale).toBe(true); expect(portal.workers.snapshot().stale).toBe(false);
  portal.dispose();
});
