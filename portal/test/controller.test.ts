import { expect, test } from 'vitest';
import { APIError } from '../src/api';
import { PortalController, browserSystem } from '../src/controller';
import { TestAPI, TestSystem, deferred, settings, settle, token } from './helpers';

const fixture = () => { const system = new TestSystem(); const api = new TestAPI(system); return { system, api, controller: new PortalController(api, system) }; };

test('login, periodic refresh, visibility, absolute expiry and logout change real controller state', async () => {
  const { system, api, controller } = fixture();
  let updates = 0; const unsubscribe = controller.subscribe(() => { updates++; });
  await controller.refresh(); expect(api.settingsCalls).toBe(0);
  await controller.login('password');
  expect(controller.snapshot().phase).toBe('authenticated');
  expect(controller.snapshot().settings?.public_origin).toBe('https://muse.example.test');
  expect(JSON.stringify(controller.snapshot()).includes(token)).toBe(false);
  expect(api.credential === token).toBe(true);
  await system.advance(30_000); expect(api.settingsCalls).toBe(2);
  await system.visibility(false); await system.advance(60_000);
  expect(controller.snapshot().stale).toBe(true);
  expect(api.reports.some(value => value.cause === 'stale_data')).toBe(true);
  await system.visibility(true); expect(controller.snapshot().stale).toBe(false);
  const firstExpiry = controller.snapshot().expiresAt;
  await system.advance(1_710_000);
  expect(system.now()).toBe(firstExpiry);
  expect(controller.snapshot().phase).toBe('login');
  expect(api.credential).toBeNull();
  expect(system.timers.size).toBe(0);
  await controller.login('password'); await controller.logout();
  expect(controller.snapshot().message).toBe('Signed out.');
  expect(controller.snapshot().settings).toBeNull();
  expect(api.logoutCalls).toBe(1);
  expect(updates).toBeGreaterThan(5);
  unsubscribe(); controller.dispose();
  expect(system.listeners.size).toBe(0);
});

test('failed login and refresh show actionable states without retaining credentials', async () => {
  for (const error of [new APIError('unauthorized', 401), new APIError('throttled', 429, 'request-limit', 12), new APIError('throttled', 429), new Error('private failure')]) {
    const { api, controller } = fixture(); api.loginWork = async () => { throw error; };
    await controller.login('password');
    expect(controller.snapshot().phase).toBe('login');
    expect(controller.snapshot().message.length).toBeGreaterThan(0);
    expect(api.credential).toBeNull(); controller.dispose();
  }
  const { api, controller } = fixture();
  await controller.login('password');
  for (const error of [new APIError('request_timeout', 0, 'request-timeout'), new APIError('service_unavailable', 503, 'request-down'), new Error('untrusted error')]) {
    api.settingsWork = async () => { throw error; };
    await controller.refresh();
    expect(controller.snapshot().stale).toBe(true);
    expect(controller.snapshot().settings).not.toBeNull();
  }
  expect(api.reports.map(value => value.cause)).toEqual(['request_timeout', 'service_unavailable', 'request_failed']);
  api.settingsWork = async () => ({ value: { ...settings(), build: { revision: 'b'.repeat(40), dirty: false } }, requestID: 'request-new-build' });
  await controller.refresh(); expect(controller.snapshot().message).toContain('build changed');
  expect(api.reports.at(-1)?.cause).toBe('build_mismatch');
  api.settingsWork = async () => { throw new APIError('unauthorized', 401); };
  await controller.refresh(); expect(controller.snapshot().phase).toBe('login');
  controller.dispose();
});

test('logout and a new authentication generation discard late successes and failures', async () => {
  const { api, controller } = fixture();
  const login = deferred<{ session_token: string; expires_at: string }>();
  api.loginWork = () => login.promise;
  const pendingLogin = controller.login('password');
  await controller.logout();
  login.resolve({ session_token: token, expires_at: '2026-11-13T00:30:00Z' });
  await pendingLogin; expect(controller.snapshot().phase).toBe('login'); expect(api.credential).toBeNull();
  const lateLogin = deferred<{ session_token: string; expires_at: string }>(); api.loginWork = () => lateLogin.promise;
  const denied = controller.login('password'); await controller.logout(); lateLogin.reject(new Error('late failure')); await denied;
  api.loginWork = async () => ({ session_token: token, expires_at: '2026-11-13T00:30:00Z' });
  await controller.login('password');
  const response = deferred<{ value: ReturnType<typeof settings>; requestID: string }>(); api.settingsWork = () => response.promise;
  const pending = controller.refresh(); const duplicate = controller.refresh();
  await duplicate; await controller.logout(); response.resolve({ value: settings(), requestID: 'obsolete' }); await pending;
  expect(controller.snapshot().settings).toBeNull();
  api.settingsWork = async () => ({ value: settings(), requestID: 'current' }); await controller.login('password');
  const failure = deferred<{ value: ReturnType<typeof settings>; requestID: string }>(); api.settingsWork = () => failure.promise;
  const failed = controller.refresh(); await controller.logout(); failure.reject(new Error('late')); await failed;
  expect(controller.snapshot().message).toBe('Signed out.');
  controller.dispose();
});

test('expiry, first-load failure, unconfirmed logout and render reports preserve useful evidence', async () => {
  const { api, controller, system } = fixture();
  api.loginWork = async () => ({ session_token: token, expires_at: new Date(system.now()).toISOString() });
  await controller.login('password'); expect(controller.snapshot().phase).toBe('login');
  api.loginWork = async () => ({ session_token: token, expires_at: new Date(system.now() + 1_800_000).toISOString() });
  api.settingsWork = async () => { throw new APIError('service_unavailable', 503); };
  await controller.login('password');
  expect(controller.snapshot().lastGood).toBeNull(); expect(controller.snapshot().loading).toBe(false);
  controller.renderFailed(); await settle();
  expect(api.reports.at(-1)?.event).toBe('portal.render_failed');
  expect(api.reports.at(-1)?.last_good_at).toBeNull();
  api.logoutWork = async () => { throw new Error('private response'); };
  await controller.logout(); expect(controller.snapshot().message).toContain('could not be confirmed');
  controller.renderFailed();
  api.logoutWork = async () => { throw new APIError('unauthorized', 401); };
  await controller.logout(); expect(controller.snapshot().message).toBe('Signed out.');
  api.settingsWork = async () => ({ value: settings(), requestID: 'latest' }); await controller.login('password');
  controller.renderFailed(); await settle(); expect(api.reports.at(-1)?.last_good_at).not.toBeNull();
  system.time += 1_800_000; await controller.refresh(); expect(controller.snapshot().phase).toBe('login');
  controller.dispose();
});

test('late logout failure does not overwrite a new session and browser visibility adapters detach', async () => {
  const { api, controller } = fixture(); await controller.login('password');
  const result = deferred<void>(); api.logoutWork = () => result.promise;
  const pending = controller.logout(); await controller.login('password'); result.reject(new Error('late logout')); await pending;
  expect(controller.snapshot().phase).toBe('authenticated'); controller.dispose();
  let events = 0; const stop = browserSystem.watchVisibility(() => { events++; });
  document.dispatchEvent(new Event('visibilitychange')); stop(); document.dispatchEvent(new Event('visibilitychange'));
  expect(events).toBe(1); expect(typeof browserSystem.visible()).toBe('boolean');
  expect(browserSystem.id().length).toBeGreaterThan(0); expect(browserSystem.now()).toBeGreaterThan(0);
});

test('freshness follows a delayed response timestamp, including suspended timers on visibility return', async () => {
  for (const suspendTimers of [false, true]) {
    const { system, api, controller } = fixture();
    const initial = deferred<{ value: ReturnType<typeof settings>; requestID: string }>();
    api.settingsWork = () => initial.promise;
    const pending = controller.login('password'); await settle();
    await system.advance(9000);
    initial.resolve({ value: settings(), requestID: 'delayed-success' }); await pending;
    const lastGood = controller.snapshot().lastGood!;
    await system.visibility(false);
    await system.advance(59_999);
    expect(controller.snapshot().stale).toBe(false);
    if (suspendTimers) {
      system.time += 2;
      const next = deferred<{ value: ReturnType<typeof settings>; requestID: string }>();
      api.settingsWork = () => next.promise;
      await system.visibility(true);
      expect(controller.snapshot().loading).toBe(true);
      expect(controller.snapshot().stale).toBe(true);
      next.resolve({ value: settings(), requestID: 'fresh-after-resume' }); await settle();
    } else {
      await system.advance(1);
      expect(system.now() - lastGood).toBe(60_000);
      expect(controller.snapshot().stale).toBe(true);
    }
    expect(api.reports.some(value => value.cause === 'stale_data' && value.last_good_at === new Date(lastGood).toISOString())).toBe(true);
    controller.dispose();
  }
});
