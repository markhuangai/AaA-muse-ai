import { afterEach, expect, test, vi } from 'vitest';
import { APIError, BrowserAPI, schedule } from '../src/api';
import { settings, token } from './helpers';

afterEach(() => vi.unstubAllGlobals());
const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(value), { status, headers: { 'X-Request-Id': 'request-api', ...headers } });

test('the real API adapter confines credentials to JSON login and authorized same-origin headers', async () => {
  const calls: { path: string; options: RequestInit }[] = [];
  const fetcher = (async (path, options) => {
    calls.push({ path: String(path), options: options! });
    if (String(path).endsWith('/login')) return json({ session_token: token, expires_at: '2026-11-13T00:30:00Z' });
    if (String(path).endsWith('/settings')) return json(settings());
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  const api = new BrowserAPI(fetcher);
  const login = await api.login('password-canary', 'login-operation', signal());
  expect(login.session_token === token).toBe(true);
  expect(JSON.parse(calls[0].options.body as string).password === 'password-canary').toBe(true);
  expect(new Headers(calls[0].options.headers).has('Authorization')).toBe(false);
  api.setSession(login.session_token);
  const result = await api.settings('settings-operation', signal());
  expect(result.value).toEqual(settings());
  expect(result.requestID).toBe('request-api');
  expect(new Headers(calls[1].options.headers).get('Authorization') === `Bearer ${token}`).toBe(true);
  await api.report({ event: 'portal.state_stale', build: 'development', component: 'settings', cause: 'request_failed', request_id: 'request-api', operation_id: 'settings-operation', expected_state: 'fresh', observed_state: 'stale', last_good_at: null, duration_ms: 0, attempt: 1, omitted_reports: 0 }, signal());
  await api.logout('logout-operation', signal());
  api.setSession(null);
  await api.settings('new-operation', signal());
  expect(new Headers(calls[4].options.headers).has('Authorization')).toBe(false);
  expect(calls.every(call => call.path.startsWith('/api/v1/portal/') && call.options.credentials === 'omit' && call.options.cache === 'no-store' && call.options.redirect === 'error')).toBe(true);
  expect(calls.every(call => !call.path.includes(token) && !call.path.includes('password-canary'))).toBe(true);
  vi.stubGlobal('fetch', fetcher);
  expect((await new BrowserAPI().settings('default-api', signal())).value.ready).toBe(true);
});

test('invalid responses and HTTP failures expose only safe causes and bounded retry metadata', async () => {
  for (const data of [null, [], {}, { session_token: 'bad', expires_at: 'invalid' }, { session_token: token, expires_at: 'invalid' }]) {
    const api = new BrowserAPI((async () => json(data)) as typeof fetch);
    await expect(api.login('not-logged', 'operation', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
  }
  const invalidSettings = new BrowserAPI((async () => json({ ...settings(), capabilities: [1] })) as typeof fetch);
  await expect(invalidSettings.settings('operation', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
  const invalidJSON = new BrowserAPI((async () => new Response('{')) as typeof fetch);
  await expect(invalidJSON.settings('operation', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
  for (const [status, causeCode, retry, expectedRetry] of [[401, 'unauthorized', 'bad', 0], [429, 'throttled', '99999', 3600], [503, 'service_unavailable', '-1', 0], [400, 'request_failed', '60', 60]] as const) {
    const api = new BrowserAPI((async () => json({ error: 'private upstream detail' }, status, { 'Retry-After': retry })) as typeof fetch);
    await expect(api.settings('operation', signal())).rejects.toMatchObject({ status, causeCode, requestID: 'request-api', retryAfter: expectedRetry });
  }
});

test('network failure, timeout and cancellation run through the real abort and cleanup path', async () => {
  const bad = new BrowserAPI((async () => { throw new Error('private network detail'); }) as typeof fetch);
  await expect(bad.settings('operation', signal())).rejects.toMatchObject({ causeCode: 'request_failed', message: 'request_failed' });
  let fire = () => {};
  let stopped = 0;
  const waiting = ((_: unknown, options: RequestInit) => new Promise<Response>((_, reject) => {
    if (options.signal?.aborted) reject(new Error('aborted'));
    options.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
  })) as typeof fetch;
  const api = new BrowserAPI(waiting, callback => { fire = callback; return () => { stopped++; }; });
  const request = api.settings('operation', signal());
  fire();
  await expect(request).rejects.toMatchObject({ causeCode: 'request_timeout' });
  expect(stopped).toBe(1);
  const abort = new AbortController(); abort.abort();
  await expect(api.settings('operation', abort.signal)).rejects.toMatchObject({ causeCode: 'request_aborted' });
  const second = new AbortController();
  const pending = api.settings('operation', second.signal); second.abort();
  await expect(pending).rejects.toMatchObject({ causeCode: 'request_aborted' });
  expect(stopped).toBe(3);
  expect(new APIError('safe').status).toBe(0);
  await new Promise<void>(resolve => schedule(resolve, 0));
});
