import { browserTransport } from './browser-transport.mjs';
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectTaste } from './taste.mjs';

const fixture = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--fixture') + 1], 'utf8'));
const transport = browserTransport(fixture.origin);
const secrets = [];
const receipt = { source_sha: fixture.source_sha, outcome: 'failed', cases: [], diagnostics: [], screenshots: [], design: [] };
const save = (name, value) => writeFileSync(join(fixture.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const passed = (name, details = {}) => receipt.cases.push({ case: name, outcome: 'passed', ...details });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser;

async function screenshot(page, name) {
  const text = await page.locator('body').innerText();
  expect(![fixture.password, ...secrets].some(secret => text.includes(secret))).toBe(true);
  receipt.design.push(await inspectTaste(page, fixture.directory, name.replace('.png', '')));
  await page.screenshot({ path: join(fixture.directory, name), fullPage: true });
  receipt.screenshots.push(name);
}

async function login(page) {
  await page.getByLabel('Portal password').fill(fixture.password);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/login' && response.status() === 200);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const session = await (await response).json();
  secrets.push(session.session_token); save('browser-session-secrets.json', secrets);
  expect(/^muse_portal_[A-Za-z0-9_-]{43}$/.test(session.session_token)).toBe(true);
  await expect(page.getByRole('heading', { name: 'Service settings', exact: true })).toBeVisible();
  return session;
}

async function authenticated(page) {
  await expect(page.getByLabel('Redacted effective YAML')).toContainText('[REDACTED]');
  await expect(page.getByText(fixture.source_sha, { exact: true })).toBeVisible();
}

async function emptyStorage(page, context) {
  const stores = await page.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage),
    databases: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map(value => value.name) : [],
    caches: typeof caches === 'undefined' ? [] : await caches.keys(), workers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0 }));
  expect(stores).toEqual({ local: [], session: [], databases: [], caches: [], workers: 0 });
  expect((await context.cookies()).length).toBe(0);
}

async function reportResponse(page, event) {
  const response = await page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/events' && response.status() === 204 && response.request().postDataJSON().event === event);
  const data = response.request().postDataJSON();
  expect(data.build).toBe(fixture.source_sha);
  expect(JSON.stringify(data).includes(fixture.password)).toBe(false);
  receipt.diagnostics.push({ operation_id: data.operation_id, event: data.event, cause: data.cause });
  return data;
}

async function viewports() {
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 1440 ? 900 : width === 768 ? 1024 : 844 }, serviceWorkers: 'block' });
    const page = await context.newPage();
    const origins = new Set(); page.on('request', request => origins.add(new URL(request.url()).origin));
    await page.goto(transport.origin);
    await expect(page.getByRole('heading', { name: 'Service access' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await screenshot(page, `login-${width}.png`);
    if (width === 1440) {
      await page.getByLabel('Portal password').fill('wrong-browser-password');
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(page.getByText('Password not accepted. Try again.')).toBeVisible();
      expect(await page.getByLabel('Portal password').inputValue()).toBe('');
    }
    await login(page); await authenticated(page); await page.evaluate(() => document.fonts.ready);
    await expect(page.locator('pre')).toContainText('<img src=x');
    expect(await page.evaluate(() => window.__unsafe === undefined && document.querySelector('pre img') === null)).toBe(true);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect(await page.evaluate(() => document.fonts.check('14px Geist') && document.fonts.check('12px "Geist Mono"'))).toBe(true);
    await screenshot(page, `settings-${width}.png`);
    await emptyStorage(page, context);
    await page.route('**/api/v1/portal/settings', route => route.abort('failed'));
    const diagnostic = reportResponse(page, 'portal.state_stale');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('Could not refresh settings. Check the connection and retry.')).toBeVisible();
    await diagnostic;
    await screenshot(page, `error-${width}.png`);
    await page.unroute('**/api/v1/portal/settings');
    await page.getByRole('button', { name: 'Refresh', exact: true }).click();
    await expect(page.getByText('Current snapshot')).toBeVisible();
    const render = reportResponse(page, 'portal.render_failed');
    await page.evaluate(message => window.dispatchEvent(new ErrorEvent('error', { message })), `private-browser-detail-${fixture.password}`);
    await render;
    expect([...origins]).toEqual([new URL(transport.origin).origin]);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Service access' })).toBeVisible();
    passed('portal.browser_viewport', { width, same_origin: true, unsafe_text_is_text: true, persistent_credentials: false });
    await context.close();
  }
}

async function lifecycle() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(`${transport.origin}/settings`);
  const first = await login(page); await authenticated(page);
  await page.reload(); await expect(page.getByRole('heading', { name: 'Service access' })).toBeVisible();
  expect((await page.request.get(`${fixture.origin}/api/v1/portal/settings`)).status()).toBe(401);
  expect((await page.request.get(`${fixture.origin}/api/v1/portal/settings`, { headers: { Authorization: `Bearer ${first.session_token}` } })).status()).toBe(200);
  passed('portal.reload_forgets_browser_session');
  const loggedOut = await login(page); await authenticated(page);
  const logout = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/logout' && response.status() === 204);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await logout;
  await expect(page.getByText('Signed out.', { exact: true })).toBeVisible();
  expect((await page.request.get(`${fixture.origin}/api/v1/portal/settings`, { headers: { Authorization: `Bearer ${loggedOut.session_token}` } })).status()).toBe(401);
  passed('portal.logout_invalidates_server_session');
  const unconfirmed = await login(page); await authenticated(page);
  await page.route('**/api/v1/portal/logout', route => route.abort('failed'));
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText('Signed out in this browser. Server sign-out could not be confirmed.')).toBeVisible();
  await emptyStorage(page, context);
  await page.unroute('**/api/v1/portal/logout');
  expect((await page.request.post(`${fixture.origin}/api/v1/portal/logout`, { headers: { Authorization: `Bearer ${unconfirmed.session_token}` } })).status()).toBe(204);
  passed('portal.unconfirmed_logout_is_explicit');
  await login(page); await authenticated(page);
  let release; let observed; let finished;
  const gate = new Promise(resolve => { release = resolve; });
  const seen = new Promise(resolve => { observed = resolve; });
  const done = new Promise(resolve => { finished = resolve; });
  await page.route('**/api/v1/portal/settings', async route => {
    const response = await transport.fetch(route); observed(); await gate;
    try { await route.fulfill({ response }); }
    catch (error) { if (!route.request().failure()) throw error; }
    finally { finished(); }
  });
  await page.getByRole('button', { name: 'Refresh', exact: true }).click(); await seen;
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByRole('heading', { name: 'Service access' })).toBeVisible();
  release(); await done;
  expect(await page.getByRole('heading', { name: 'Service settings', exact: true }).count()).toBe(0);
  await page.unroute('**/api/v1/portal/settings');
  passed('portal.late_response_is_fenced_after_logout');
  const restarted = await login(page); await authenticated(page);
  const info = JSON.parse(execFileSync('docker', ['inspect', fixture.container], { encoding: 'utf8' }))[0];
  expect(info.Config.Labels['io.aaa-muse.test-owner']).toBe(fixture.owner);
  execFileSync('docker', ['restart', fixture.container], { stdio: 'pipe' });
  const deadline = Date.now() + 30_000;
  let ready = false;
  let attempts = 0;
  let transportInterruptions = 0;
  while (Date.now() < deadline) {
    attempts++;
    try { ready = (await page.request.get(`${fixture.origin}/readyz`, { timeout: 2000 })).status() === 200; }
    catch (error) {
      if (!/ECONNREFUSED|ECONNRESET|socket hang up|Timeout|timeout|closed|reset|connect/i.test(String(error))) throw error;
      transportInterruptions++;
    }
    if (ready) break; await wait(100);
  }
  expect(ready).toBe(true);
  expect((await page.request.get(`${fixture.origin}/api/v1/portal/settings`, { headers: { Authorization: `Bearer ${restarted.session_token}` } })).status()).toBe(401);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByText('Your session ended. Sign in again.')).toBeVisible();
  passed('portal.restart_invalidates_session', { readiness_attempts: attempts, transport_interruptions: transportInterruptions });
  await context.close();
}

async function expiryAndDeadline() {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage();
  await page.clock.install(); await page.goto(transport.origin); await login(page); await authenticated(page);
  await page.clock.fastForward(1_800_001);
  await expect(page.getByText('Your session ended. Sign in again.')).toBeVisible();
  await emptyStorage(page, context); passed('portal.browser_absolute_expiry', { server_lifetime_seconds: 1800, browser_clock_controlled: true });
  await context.close();
  const second = await browser.newContext({ serviceWorkers: 'block' }); const delayed = await second.newPage();
  await delayed.clock.install(); await delayed.goto(transport.origin); await login(delayed); await authenticated(delayed);
  let release; const gate = new Promise(resolve => { release = resolve; });
  await delayed.route('**/api/v1/portal/settings', async route => { await gate; try { await route.abort('failed'); } catch (error) { if (!route.request().failure()) throw error; } });
  const diagnostic = reportResponse(delayed, 'portal.state_stale');
  await delayed.getByRole('button', { name: 'Refresh', exact: true }).click(); await delayed.clock.fastForward(10_001);
  await expect(delayed.getByText('Could not refresh settings. Check the connection and retry.')).toBeVisible();
  const evidence = await diagnostic; expect(evidence.cause).toBe('request_timeout');
  release(); await second.close(); passed('portal.browser_request_deadline', { deadline_ms: 10000 });
}

async function clientKeyAndOriginFlows() {
  const secure = await chromium.launch({ headless: true });
  const saved = [];
  const [first, second] = fixture.key_origins;
  const open = async (width, origin) => {
    const context = await secure.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block',
      ignoreHTTPSErrors: true, permissions: ['clipboard-read', 'clipboard-write'] });
    const page = await context.newPage();
    await page.goto(origin);
    const session = await login(page);
    return { page, context, session };
  };
  const prompt = async (page, origin) => {
    await page.getByRole('link', { name: 'Workers', exact: true }).click();
    const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/setup-prompts');
    await page.getByRole('button', { name: 'Generate setup prompt' }).click();
    const response = await pending;
    expect(response.status()).toBe(201);
    expect(response.request().postDataJSON()).toEqual({ origin });
    const data = await response.json();
    secrets.push(data.setup_prompt.match(/muse_enroll_[A-Za-z0-9_-]{43}/)[0]);
    save('browser-session-secrets.json', secrets);
    expect(data.setup_prompt).toContain(`origin='${origin}'`);
  };
  try {
    for (const width of [1440, 768, 390]) {
      const { page, context } = await open(width, first);
      const input = page.getByLabel('Key', { exact: true });
      const nameInput = page.getByLabel('Name', { exact: true });
      await page.getByRole('button', { name: 'Generate', exact: true }).click();
      const generated = await input.inputValue();
      expect(/^aaa_muse_ai_[a-f0-9]{64}$/.test(generated)).toBe(true);
      await expect(input).toHaveAttribute('type', 'text');
      await page.getByRole('button', { name: 'Copy key', exact: true }).click();
      await expect(page.getByText('Copied.', { exact: true })).toBeVisible();
      expect((await page.evaluate(() => navigator.clipboard.readText())) === generated).toBe(true);
      const create = async (name, key) => {
        secrets.push(key);
        save('browser-session-secrets.json', secrets);
        await nameInput.fill(name);
        expect((await input.inputValue()) === key).toBe(true);
        const saveButton = page.getByRole('button', { name: 'Save client key' });
        await expect(saveButton).toBeEnabled();
        const [response] = await Promise.all([
          page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/client-keys'),
          saveButton.click(),
        ]);
        expect(response.status()).toBe(201);
        expect(await response.json()).toEqual({ name });
        await expect(input).toHaveValue('');
        await expect(nameInput).toHaveValue('');
        await expect(page.getByRole('button', { name: 'Copy key', exact: true })).toHaveCount(0);
        await expect(page.getByRole('list', { name: 'Saved client keys' })).toContainText(name);
        for (const origin of [second, first]) {
          const result = await context.request.get(origin + '/v1/models', { headers: { Authorization: 'Bearer ' + key } });
          expect(result.status()).toBe(200);
        }
        saved.push({ name, key });
        save('browser-client-key-secrets.json', saved);
      };
      await create('Browser client ' + width, generated);
      if (width === 1440) {
        await expect(page.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
        const supplied = 'controlled-manual-client-value';
        await input.fill(supplied);
        await expect(input).toHaveAttribute('type', 'password');
        await create('Manual client', supplied);
      }
      await emptyStorage(page, context);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
      await screenshot(page, `client-keys-${width}.png`);
      if (width === 1440) await prompt(page, first);
      await context.close();
    }
    const sibling = await open(390, second);
    await prompt(sibling.page, second);
    await sibling.context.close();
    passed('portal.browser_client_keys_and_origins', { widths: [1440, 768, 390], first_request_authentication: true, https_origins: 2 });
  } finally { await secure.close(); }
}

async function httpSetupExplanation() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  try {
    const page = await context.newPage();
    await page.goto(transport.origin);
    await login(page);
    await page.getByRole('link', { name: 'Workers', exact: true }).click();
    await page.getByRole('button', { name: 'Generate setup prompt' }).click();
    await expect(page.getByText('Open the portal over HTTPS to generate a setup prompt.')).toBeVisible();
    await expect(page.getByLabel('Complete setup prompt')).toHaveCount(0);
    passed('portal.http_setup_explanation');
  } finally { await context.close(); }
}

try {
  browser = await chromium.launch({ headless: true, args: transport.args });
  await viewports(); await lifecycle(); await expiryAndDeadline(); await httpSetupExplanation(); await clientKeyAndOriginFlows();
  receipt.outcome = 'passed';
  save('browser-receipt.json', receipt);
  console.log(JSON.stringify({ case: 'portal.browser_conformance', outcome: 'passed', cases: receipt.cases.length, screenshots: receipt.screenshots.length }));
} catch (error) {
  let detail = String(error?.stack || error).replace(/muse_(?:portal|worker|enroll)_[A-Za-z0-9_-]{43}/g, '[REDACTED]');
  for (const value of [fixture.password, ...secrets]) detail = detail.split(value).join('[REDACTED]');
  writeFileSync(join(fixture.directory, 'browser-failure.txt'), detail, { mode: 0o600 });
  save('browser-receipt.json', receipt);
  console.error('Built-image browser conformance failed; inspect private browser-failure evidence.');
  process.exitCode = 1;
} finally { if (browser) await browser.close(); }
