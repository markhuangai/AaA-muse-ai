import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectTaste } from './taste.mjs';

const fixture = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--fixture') + 1], 'utf8'));
const secrets = [];
const receipt = { source_sha: fixture.source_sha, outcome: 'failed', cases: [], diagnostics: [], screenshots: [], design: [] };
const save = (name, value) => writeFileSync(join(fixture.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const passed = (name, details = {}) => receipt.cases.push({ case: name, outcome: 'passed', ...details });
const remember = secret => { secrets.push(secret); save(`worker-browser-secrets-${fixture.phase}.json`, secrets); };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser;

async function control(path, { method = 'GET', key, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(fixture.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

async function login(page) {
  await page.goto(`${fixture.origin}/workers`);
  await page.getByLabel('Portal password').fill(fixture.password);
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/login' && response.status() === 200);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const session = await (await pending).json(); remember(session.session_token);
  await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh workers', exact: true })).toBeEnabled();
  return session;
}

async function privateStorage(page, context) {
  const actual = await page.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage),
    databases: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
    caches: typeof caches === 'undefined' ? [] : await caches.keys(), workers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0 }));
  expect(actual).toEqual({ local: [], session: [], databases: 0, caches: [], workers: 0 });
  expect((await context.cookies()).length).toBe(0);
}

async function screenshot(page, kind, width) {
  expect(await page.locator('[data-sensitive]').count()).toBe(0);
  const text = await page.locator('body').innerText();
  expect([fixture.password, ...secrets].some(secret => text.includes(secret))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const name = `workers-${kind}-${width}.png`;
  await page.screenshot({ path: join(fixture.directory, name), fullPage: true });
  receipt.design.push(await inspectTaste(page, fixture.directory, name.replace('.png', '')));
  receipt.screenshots.push(name);
}

async function openWorker(page, id) {
  await page.locator('tbody tr').filter({ hasText: id }).getByRole('button').click();
  await expect(page.getByRole('region', { name: 'Worker detail' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2 }).first()).toBeFocused();
}

async function action(page, path, invoke, status = 200) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() !== 'GET');
  await invoke(); const response = await pending;
  expect(response.status()).toBe(status);
  const data = await response.json();
  receipt.diagnostics.push({ request_id: response.headers()['x-request-id'], event: 'portal.worker_action', status,
  });
  return { response, data };
}

async function report(page, cause) {
  const response = await page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/events' && response.status() === 204 &&
    response.request().postDataJSON().event === 'portal.worker_state_stale' && response.request().postDataJSON().cause === cause);
  const data = response.request().postDataJSON();
  expect(data.build).toBe(fixture.source_sha);
  expect([fixture.password, ...secrets].some(secret => JSON.stringify(data).includes(secret))).toBe(false);
  receipt.diagnostics.push({ operation_id: data.operation_id, event: data.event, cause });
  return data;
}

async function emptyViews() {
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: 'block' }); const page = await context.newPage();
    await login(page); await expect(page.getByText(/No workers are registered/)).toBeVisible();
    await screenshot(page, 'empty', width); await privateStorage(page, context);
    passed('portal.workers_empty', { width }); await context.close();
  }
}

async function viewports() {
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] }); const page = await context.newPage();
    const origins = new Set(); const telemetry = []; page.on('request', request => {
      origins.add(new URL(request.url()).origin);
      if (new URL(request.url()).pathname === '/api/v1/portal/events') telemetry.push(request.postData() || '');
    });
    const session = await login(page);
    const row = id => page.locator('tbody tr').filter({ hasText: id });
    await expect(row(fixture.workers.offline_id)).toContainText('Offline');
    expect(await page.evaluate(() => window.__unsafe === undefined && document.querySelector('tbody img') === null)).toBe(true);
    await expect(row(fixture.workers.transport_id)).toContainText('Online');
    await expect(row(fixture.workers.transport_id)).toContainText('Not yet qualified');
    await expect(row(fixture.workers.busy_id)).toContainText('Busy');
    await expect(row(fixture.workers.waiting_id)).toContainText('1 client-tool waits');
    await expect(row(fixture.workers.stale_id)).toContainText('Stale qualification');
    await screenshot(page, 'list', width);
    await openWorker(page, fixture.workers.busy_id);
    await expect(page.getByText(fixture.workers.busy_job_id, { exact: true })).toBeVisible();
    await expect(page.getByText('Controlled software evidence').first()).toBeVisible();
    await expect(page.getByText('Not reported', { exact: true })).toBeVisible();
    await expect(page.getByText('Not independently observed', { exact: true })).toBeVisible();
    const acceptedName = `Research agent ${width} 名称`;
    await page.getByLabel('Display name', { exact: true }).fill(`  ${acceptedName}  `);
    const renamed = await action(page, `/api/v1/admin/workers/${fixture.workers.busy_id}`, () => page.getByRole('button', { name: 'Save name', exact: true }).click());
    expect(renamed.data.id).toBe(fixture.workers.busy_id); expect(renamed.data.name).toBe(acceptedName);
    expect(renamed.data.current_job.job_id).toBe(fixture.workers.busy_job_id);
    await expect(page.getByRole('heading', { name: acceptedName, exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Refresh workers' }).click();
    await expect(page.getByRole('button', { name: 'Refresh workers' })).toBeEnabled();
    await expect(page.getByRole('heading', { name: acceptedName, exact: true })).toBeVisible();
    await page.getByLabel('Display name', { exact: true }).fill('   ');
    const invalid = await action(page, `/api/v1/admin/workers/${fixture.workers.busy_id}`, () => page.getByRole('button', { name: 'Save name', exact: true }).click(), 400);
    await expect(page.getByText(/Name not accepted/)).toBeVisible(); await expect(page.getByText(invalid.response.headers()['x-request-id'], { exact: true })).toBeVisible();
    await screenshot(page, 'detail', width);
    await page.getByRole('button', { name: 'All workers', exact: true }).click(); await expect(row(fixture.workers.busy_id)).toContainText(acceptedName);
    const generated = await action(page, '/api/v1/admin/setup-prompts', () => page.getByRole('button', { name: 'Generate setup prompt' }).click(), 201);
    const code = generated.data.setup_prompt.match(/muse_enroll_[A-Za-z0-9_-]{43}/)?.[0]; expect(!!code).toBe(true); remember(code);
    const text = page.getByLabel('Complete setup prompt', { exact: true });
    expect((await text.inputValue()) === generated.data.setup_prompt).toBe(true);
    expect(generated.data.worker_package.version).toBe(fixture.pin.version); expect(generated.data.worker_package.sha256).toBe(fixture.pin.sha256);
    expect(generated.data.setup_prompt.includes('hooks.list') && generated.data.setup_prompt.includes('hooks.add') && generated.data.setup_prompt.includes('supported-refresh recovery') && generated.data.setup_prompt.includes('sha256sum')).toBe(true);
    expect((Date.parse(generated.data.expires_at) - Date.parse(generated.data.created_at)) / 1000).toBe(900);
    await page.getByRole('button', { name: 'Copy complete prompt' }).click();
    await expect(page.getByText('Copied. Keep this single-use enrollment private.')).toBeVisible();
    expect((await page.evaluate(() => navigator.clipboard.readText())) === generated.data.setup_prompt).toBe(true);
    await page.evaluate(() => { Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw new Error('controlled clipboard denial'); } } }); });
    await page.getByRole('button', { name: 'Copy complete prompt' }).click(); await expect(page.getByText(/Clipboard access failed/)).toBeVisible();
    await page.getByRole('button', { name: 'Select text', exact: true }).click(); await expect(text).toBeFocused();
    expect(await text.evaluate(element => element.selectionEnd - element.selectionStart) === generated.data.setup_prompt.length).toBe(true);
    const enrolled = await control('/api/v1/worker/enroll', { method: 'POST', body: { enrollment_code: code } });
    expect(enrolled.response.status).toBe(201); remember(enrolled.data.credential);
    expect((await control('/api/v1/worker/enroll', { method: 'POST', body: { enrollment_code: code } })).response.status).toBe(409);
    await page.getByLabel('Enrollment format').selectOption('code');
    const token = await action(page, '/api/v1/admin/enrollments', () => page.getByRole('button', { name: 'Generate enrollment code' }).click(), 201);
    remember(token.data.enrollment_code); expect((await page.getByLabel('Single-use enrollment code').inputValue()) === token.data.enrollment_code).toBe(true);
    expect(await text.count()).toBe(0);
    await privateStorage(page, context);
    await page.getByRole('link', { name: 'Settings', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Service settings' })).toBeVisible();
    await page.goBack(); await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible();
    expect(await page.locator('[data-sensitive]').count()).toBe(0);
    await page.goForward(); await expect(page.getByRole('heading', { name: 'Service settings' })).toBeVisible();
    await page.getByRole('link', { name: 'Workers', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Refresh workers' })).toBeEnabled();
    await openWorker(page, enrolled.data.worker.id);
    await page.getByRole('button', { name: 'Revoke worker', exact: true }).focus(); await page.keyboard.press('Enter');
    const dialog = page.getByRole('dialog', { name: 'Revoke this worker?' }); await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    expect((await control('/api/v1/worker/status', { key: enrolled.data.credential })).response.status).toBe(200);
    await page.getByRole('button', { name: 'Revoke worker', exact: true }).click(); await screenshot(page, 'revoke', width);
    const revoked = await action(page, `/api/v1/admin/workers/${enrolled.data.worker.id}/revoke`, () => dialog.getByRole('button', { name: 'Confirm revocation' }).click());
    expect(!!revoked.data.revoked_at).toBe(true); await expect(page.getByText(/server confirmed revocation/)).toBeVisible();
    expect((await control('/api/v1/worker/status', { key: enrolled.data.credential })).response.status).toBe(401);
    const retained = await control('/api/v1/admin/workers', { key: session.session_token });
    expect(retained.data.workers.some(worker => worker.id === enrolled.data.worker.id && worker.revoked_at)).toBe(true);
    expect(telemetry.every(value => !secrets.some(secret => value.includes(secret)))).toBe(true);
    expect([...origins]).toEqual([new URL(fixture.origin).origin]);
    passed('portal.workers_actions', { width, accepted_rename: true, identity_and_assignment_preserved: true, full_prompt: true, single_use: true, confirmed_revocation: true, keyboard: true, persistent_credentials: false });
    await context.close();
  }
}

async function orderingAndUncertainty() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' }); const page = await context.newPage();
  const session = await login(page); await openWorker(page, fixture.workers.busy_id);
  let release, seen; const gate = new Promise(resolve => { release = resolve; }); const observed = new Promise(resolve => { seen = resolve; });
  await page.route('**/api/v1/admin/workers', async route => { const response = await route.fetch(); seen(); await gate; await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Refresh workers' }).click(); await observed;
  await page.getByLabel('Display name', { exact: true }).fill('Newest accepted name');
  await action(page, `/api/v1/admin/workers/${fixture.workers.busy_id}`, () => page.getByRole('button', { name: 'Save name', exact: true }).click());
  const stale = report(page, 'obsolete_response'); release(); await stale;
  await expect(page.getByRole('heading', { name: 'Newest accepted name', exact: true })).toBeVisible(); await page.unroute('**/api/v1/admin/workers');
  let committedRequestID = '';
  await page.route(`**/api/v1/admin/workers/${fixture.workers.busy_id}`, async route => { const response = await route.fetch(); committedRequestID = response.headers()['x-request-id']; await route.abort('failed'); });
  await page.getByLabel('Display name', { exact: true }).fill('Committed before response loss');
  const failure = report(page, 'request_failed'); await page.getByRole('button', { name: 'Save name', exact: true }).click(); await failure;
  receipt.diagnostics.push({ request_id: committedRequestID, event: 'worker.renamed', client_unconfirmed: true });
  await expect(page.getByText(/action could not be confirmed/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Revoke worker', exact: true })).toBeDisabled();
  await page.unroute(`**/api/v1/admin/workers/${fixture.workers.busy_id}`);
  await page.getByRole('button', { name: 'Refresh workers' }).click();
  await expect(page.getByRole('heading', { name: 'Committed before response loss', exact: true })).toBeVisible();
  const actual = await control('/api/v1/admin/workers', { key: session.session_token });
  expect(actual.data.workers.find(worker => worker.id === fixture.workers.busy_id).current_job.job_id).toBe(fixture.workers.busy_job_id);
  await screenshot(page, 'error', 1440);
  passed('portal.worker_ordering_and_uncertainty', { obsolete_response_discarded: true, committed_response_loss_reconciled: true, automatic_mutation_retry: false });
  await context.close();
}

function verifyOwner(identity) {
  const actual = JSON.parse(execFileSync('docker', ['inspect', identity], { encoding: 'utf8' }))[0];
  expect(actual.Config.Labels['io.aaa-muse.test-owner']).toBe(fixture.owner);
}

async function outageAndDenial() {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage(); const session = await login(page);
  verifyOwner(fixture.database); execFileSync('docker', ['stop', '--time', '1', fixture.database], { stdio: 'pipe' });
  try {
    const backend = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/workers' && response.status() === 503);
    const stale = report(page, 'service_unavailable'); await page.getByRole('button', { name: 'Refresh workers' }).click();
    const response = await backend; await stale;
    await expect(page.getByText('Could not refresh workers. Check the connection and retry.')).toBeVisible();
    receipt.diagnostics.push({ request_id: response.headers()['x-request-id'], event: 'worker.operation_failed' });
  } finally { execFileSync('docker', ['start', fixture.database], { stdio: 'pipe' }); }
  const deadline = Date.now() + 30_000; let ready = false;
  while (Date.now() < deadline) { const result = await control('/readyz'); if (result.response.status === 200) { ready = true; break; } await pause(100); }
  expect(ready).toBe(true); await page.getByRole('button', { name: 'Refresh workers' }).click(); await expect(page.getByText('Stale snapshot · Refresh before changing worker access.')).not.toBeVisible();
  await action(page, '/api/v1/admin/enrollments', async () => { await page.getByLabel('Enrollment format').selectOption('code'); await page.getByRole('button', { name: 'Generate enrollment code' }).click(); }, 201).then(value => remember(value.data.enrollment_code));
  expect((await control('/api/v1/portal/logout', { key: session.session_token, method: 'POST' })).response.status).toBe(204);
  const denied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/workers' && response.status() === 401);
  await page.getByRole('button', { name: 'Refresh workers' }).click(); const rejected = await denied;
  receipt.diagnostics.push({ request_id: rejected.headers()['x-request-id'], event: 'portal.auth_failed' });
  await expect(page.getByText('Your session ended. Sign in again.')).toBeVisible();
  expect(await page.locator('[data-sensitive]').count()).toBe(0); await privateStorage(page, context);
  passed('portal.worker_outage_recovery_and_denial', { real_postgres_outage: true, invalid_session_clears_enrollment: true }); await context.close();
}

async function expiryAndLateLogout() {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage(); await page.clock.install(); await login(page);
  await page.getByLabel('Enrollment format').selectOption('code');
  const issued = await action(page, '/api/v1/admin/enrollments', () => page.getByRole('button', { name: 'Generate enrollment code' }).click(), 201); remember(issued.data.enrollment_code);
  await page.clock.fastForward(900_001); await expect(page.getByText(/Enrollment expired/)).toBeVisible();
  expect(await page.locator('[data-sensitive]').count()).toBe(0); expect(await page.getByRole('button', { name: 'Copy enrollment code' }).count()).toBe(0);
  passed('portal.worker_browser_enrollment_expiry', { browser_clock_controlled: true, server_expiry_tested_separately: true }); await context.close();
  const second = await browser.newContext({ serviceWorkers: 'block' }); const delayed = await second.newPage(); await login(delayed);
  let release, seen, done; const gate = new Promise(resolve => { release = resolve; }); const observed = new Promise(resolve => { seen = resolve; }); const finished = new Promise(resolve => { done = resolve; });
  await delayed.route('**/api/v1/admin/workers', async route => { const response = await route.fetch(); seen(); await gate; try { await route.fulfill({ response }); } catch (error) { if (!route.request().failure()) throw error; } finally { done(); } });
  await delayed.getByRole('button', { name: 'Refresh workers' }).click(); await observed; await delayed.getByRole('button', { name: 'Sign out' }).click(); release(); await finished;
  await expect(delayed.getByRole('heading', { name: 'Service access' })).toBeVisible(); expect(await delayed.getByRole('region', { name: 'Registered workers' }).count()).toBe(0);
  passed('portal.worker_late_response_after_logout'); await second.close();
  const third = await browser.newContext({ serviceWorkers: 'block' }); const timed = await third.newPage(); await timed.clock.install(); await login(timed);
  let unblock, reached; const blocked = new Promise(resolve => { unblock = resolve; }); const requested = new Promise(resolve => { reached = resolve; });
  await timed.route('**/api/v1/admin/workers', async route => { const response = await route.fetch(); reached(); await blocked; try { await route.fulfill({ response }); } catch (error) { if (!route.request().failure()) throw error; } });
  const deadlineReport = report(timed, 'request_timeout'); await timed.getByRole('button', { name: 'Refresh workers' }).click(); await requested;
  await timed.clock.fastForward(10_001); await deadlineReport; await expect(timed.getByText('Could not refresh workers. Check the connection and retry.')).toBeVisible();
  unblock(); await third.close(); passed('portal.worker_request_deadline', { deadline_ms: 10000 });
}

try {
  browser = await chromium.launch({ headless: true, args: [`--unsafely-treat-insecure-origin-as-secure=${fixture.origin}`] });
  if (fixture.phase === 'empty') await emptyViews();
  else { await viewports(); await orderingAndUncertainty(); await expiryAndLateLogout(); await outageAndDenial(); }
  receipt.outcome = 'passed';
  console.log(JSON.stringify({ case: 'portal.workers_browser_conformance', outcome: 'passed', cases: receipt.cases.length, screenshots: receipt.screenshots.length }));
} catch (error) {
  let detail = String(error?.stack || error).replace(/muse_(?:portal|worker|enroll)_[A-Za-z0-9_-]{43}/g, '[REDACTED]');
  for (const value of [fixture.password, ...secrets]) detail = detail.split(value).join('[REDACTED]');
  writeFileSync(join(fixture.directory, `worker-browser-failure-${fixture.phase}.txt`), detail, { mode: 0o600 });
  console.error('Worker browser conformance failed; inspect private worker-browser evidence.'); process.exitCode = 1;
} finally { save(`worker-browser-receipt-${fixture.phase}.json`, receipt); if (browser) await browser.close(); }
