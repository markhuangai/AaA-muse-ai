import { browserTransport } from './browser-transport.mjs';
import { chromium, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectTaste } from './taste.mjs';
import { browserSessionHeaders, checkBrowserSession } from './session.mjs';

const fixture = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--fixture') + 1], 'utf8'));
const transport = browserTransport(fixture.origin);
const secrets = [];
const receipt = { source_sha: fixture.source_sha, outcome: 'failed', cases: [], diagnostics: [], session_store_diagnostics: [], screenshots: [], design: [] };
const save = (name, value) => writeFileSync(join(fixture.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const passed = (name, details = {}) => receipt.cases.push({ case: name, outcome: 'passed', ...details });
const wait = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser;

async function screenshot(page, name) {
  const text = await page.locator('body').innerText();
  expect(![fixture.password, ...secrets].some(secret => text.includes(secret))).toBe(true);
  receipt.design.push(await inspectTaste(page, fixture.directory, name.replace('.png', '')));
  await page.screenshot({ path: join(fixture.directory, name), fullPage: true, animations: 'disabled' });
  receipt.screenshots.push(name);
}

async function login(page, remember = false) {
  await expect(page.getByRole('checkbox', { name: 'Remember me' })).not.toBeChecked();
  if (remember) await page.getByRole('checkbox', { name: 'Remember me' }).check();
  await page.getByLabel('Portal password').fill(fixture.password);
  const response = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/login' && response.status() === 200);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const session = await checkBrowserSession(page, await response, remember);
  secrets.push(session.value); save('browser-session-secrets.json', secrets);
  await expect(page.getByRole('heading', { name: 'Service settings', exact: true })).toBeVisible();
  return session;
}

async function authenticated(page) {
  await expect(page.getByLabel('Redacted effective YAML')).toContainText('[REDACTED]');
  await expect(page.getByText(fixture.source_sha, { exact: true })).toBeVisible();
}

async function privateStorage(page, context, signedIn = true) {
  const stores = await page.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage),
    databases: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map(value => value.name) : [],
    caches: typeof caches === 'undefined' ? [] : await caches.keys(), workers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0 }));
  expect(stores).toEqual({ local: [], session: [], databases: [], caches: [], workers: 0 });
  expect((await context.cookies()).length).toBe(signedIn ? 1 : 0);
  expect(await page.evaluate(() => document.cookie)).toBe('');
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
    await page.emulateMedia({ colorScheme: 'light' });
    const origins = new Set(); page.on('request', request => origins.add(new URL(request.url()).origin));
    await page.goto(transport.origin);
    await expect(page.getByRole('heading', { name: 'Service access' })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await screenshot(page, `login-${width}.png`);
    const canvas = () => page.locator('html').evaluate(node => getComputedStyle(node).backgroundColor);
    const light = await canvas();
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(canvas).not.toBe(light);
    await screenshot(page, `login-dark-${width}.png`);
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
    await screenshot(page, `settings-dark-${width}.png`);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(canvas).toBe(light);
    await screenshot(page, `settings-${width}.png`);
    await privateStorage(page, context);
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
    await page.getByLabel('Appearance').selectOption('dark');
    await page.reload();
    await authenticated(page);
    await expect(page.getByLabel('Appearance')).toHaveValue('dark');
    expect(await page.locator('html').evaluate(node => getComputedStyle(node).colorScheme)).toBe('dark');
    expect(await page.evaluate(() => Object.entries(localStorage))).toEqual([['muse-portal-appearance', 'dark']]);
    await page.getByLabel('Appearance').selectOption('system');
    expect([...origins]).toEqual([new URL(transport.origin).origin]);
    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(page.getByRole('heading', { name: 'Service access' })).toBeVisible();
    passed('portal.browser_viewport', { width, same_origin: true, unsafe_text_is_text: true, live_system_theme: true, persistent_credentials: false });
    await context.close();
  }
}

async function lifecycle() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const page = await context.newPage();
  await page.goto(`${transport.origin}/settings`);
  const first = await login(page); await authenticated(page);
  await page.reload(); await authenticated(page);
  const otherTab = await context.newPage();
  await otherTab.goto(transport.origin); await authenticated(otherTab);
  passed('portal.reload_and_new_tab_restore_session');
  const logout = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/logout' && response.status() === 204);
  await page.getByRole('button', { name: 'Sign out' }).click();
  await logout;
  await expect(page.getByText('Signed out.', { exact: true })).toBeVisible();
  await expect(otherTab.getByRole('heading', { name: 'Service access' })).toBeVisible({ timeout: 5000 });
  await otherTab.close();
  expect((await page.request.get(`${fixture.origin}/api/v1/portal/session`, { headers: browserSessionHeaders(first, fixture.origin) })).status()).toBe(401);
  await privateStorage(page, context, false);
  passed('portal.logout_invalidates_server_session_and_other_tabs');
  await context.addCookies([first]);
  const denied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/session' && response.status() === 401);
  await page.reload();
  const rejected = await denied;
  await expect(page.getByText('Your session ended. Sign in again.')).toBeVisible();
  await expect(page.getByText(rejected.headers()['x-request-id'], { exact: true })).toBeVisible();
  await expect(page.getByText(rejected.request().headers()['x-portal-operation-id'], { exact: true })).toBeVisible();
  const unconfirmed = await login(page); await authenticated(page);
  const hiddenTab = await context.newPage();
  await hiddenTab.goto(transport.origin); await authenticated(hiddenTab);
  await hiddenTab.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.route('**/api/v1/portal/logout', async route => {
    const committed = await transport.fetch(route);
    expect(committed.status()).toBe(204);
    await route.abort('failed');
  });
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page.getByText(/Sign-out could not be confirmed/)).toBeVisible();
  await expect(page.getByLabel('Redacted effective YAML')).toHaveCount(0);
  await expect(hiddenTab.getByLabel('Redacted effective YAML')).toHaveCount(0);
  await expect(hiddenTab.getByRole('button', { name: 'Retry sign-out' })).toBeVisible();
  await page.unroute('**/api/v1/portal/logout');
  await page.getByRole('button', { name: 'Retry sign-out' }).click();
  await expect(page.getByText('Signed out.', { exact: true })).toBeVisible();
  await expect(hiddenTab.getByLabel('Portal password')).toBeVisible();
  await hiddenTab.close();
  expect((await page.request.get(`${fixture.origin}/api/v1/portal/session`, { headers: browserSessionHeaders(unconfirmed, fixture.origin) })).status()).toBe(401);
  passed('portal.unconfirmed_logout_can_be_retried', { committed_response_lost: true, hidden_tab_private_view_cleared: true });
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
  await login(page, true); await authenticated(page);
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
  await page.reload(); await authenticated(page);
  passed('portal.remembered_session_survives_broker_restart', { readiness_attempts: attempts, transport_interruptions: transportInterruptions });
  await context.close();
}

async function persistentProfiles() {
  for (const remember of [false, true]) {
    const directory = mkdtempSync(join(fixture.directory, 'chromium-profile-'));
    const start = () => chromium.launchPersistentContext(directory, { headless: true, args: transport.args, serviceWorkers: 'block' });
    let profile = await start();
    try {
      const first = profile.pages()[0] ?? await profile.newPage();
      await first.goto(transport.origin);
      if (remember) {
        await first.emulateMedia({ colorScheme: 'light' });
        await first.getByLabel('Appearance').selectOption('dark');
      }
      await login(first, remember);
      await profile.close();
      profile = await start();
      const returning = profile.pages()[0] ?? await profile.newPage();
      await returning.emulateMedia({ colorScheme: 'light', reducedMotion: 'reduce' });
      await returning.goto(transport.origin);
      if (remember) {
        await authenticated(returning);
        await expect(returning.getByLabel('Appearance')).toHaveValue('dark');
        expect(await returning.locator('html').evaluate(node => getComputedStyle(node).colorScheme)).toBe('dark');
        expect(await returning.evaluate(() => [Object.entries(localStorage), Object.keys(sessionStorage)])).toEqual([[['muse-portal-appearance', 'dark']], []]);
        expect(await returning.locator('main').evaluate(node => node.getAnimations().length)).toBe(0);
      } else {
        await expect(returning.getByLabel('Portal password')).toBeVisible();
        await privateStorage(returning, profile, false);
      }
      passed('portal.chromium_profile_relaunch', { remember_me: remember, actual_browser_shutdown: true });
    } finally { await profile.close(); }
  }
}

async function sessionStoreOutage() {
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage();
  try {
    await page.goto(transport.origin);
    await login(page);
    const database = JSON.parse(execFileSync('docker', ['inspect', fixture.database], { encoding: 'utf8' }))[0];
    expect(database.Config.Labels['io.aaa-muse.test-owner']).toBe(fixture.owner);
    const sql = input => execFileSync('docker', ['exec', '-i', '--user', '10001:10001', fixture.database,
      'sqlite3', '-bail', '-batch', '-cmd', '.timeout 4000', '/var/lib/aaa-muse-ai/state/broker.sqlite3'],
    { input, stdio: ['pipe', 'pipe', 'pipe'] });
    sql('ALTER TABLE aaa_portal_grants RENAME TO hidden_aaa_portal_grants;');
    try {
      const failure = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/session' && response.status() === 503);
      await page.reload();
      await expect(page.getByRole('button', { name: 'Retry session check' })).toBeVisible();
      await expect(page.getByLabel('Portal password')).toHaveCount(0);
      await expect(page.getByLabel('Redacted effective YAML')).toHaveCount(0);
      const response = await failure;
      const operation = response.request().headers()['x-portal-operation-id'];
      const request = response.headers()['x-request-id'];
      await expect(page.getByText(operation, { exact: true })).toBeVisible();
      await expect(page.getByText(request, { exact: true })).toBeVisible();
      receipt.session_store_diagnostics.push({ operation_id: operation, request_id: request });
    } finally {
      sql('ALTER TABLE hidden_aaa_portal_grants RENAME TO aaa_portal_grants;');
    }
    await page.getByRole('button', { name: 'Retry session check' }).click();
    await authenticated(page);
    passed('portal.browser_session_check_retries_real_sqlite_outage');
  } finally { await context.close(); }
}

async function sessionDurationAndDeadline() {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage();
  await page.clock.install(); await page.goto(transport.origin); await login(page); await authenticated(page);
  await page.clock.fastForward(1_800_001);
  await authenticated(page);
  await privateStorage(page, context); passed('portal.no_browser_logout_timer', { elapsed_clock_ms: 1_800_001 });
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
      await privateStorage(page, context);
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
  await viewports(); await lifecycle(); await persistentProfiles(); await sessionStoreOutage(); await sessionDurationAndDeadline();
  await httpSetupExplanation(); await clientKeyAndOriginFlows();
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
