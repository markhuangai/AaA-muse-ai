import { chromium, expect } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { inspectTaste } from './taste.mjs';
import { browserSessionHeaders, checkBrowserSession } from './session.mjs';

const fixture = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--fixture') + 1], 'utf8'));
const origin = fixture.browser_origin;
const secrets = [];
const receipt = { source_sha: fixture.source_sha, outcome: 'failed', cases: [], diagnostics: [], screenshots: [], design: [] };
const save = (name, value) => writeFileSync(join(fixture.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const passed = (name, details = {}) => receipt.cases.push({ case: name, outcome: 'passed', ...details });
const remember = secret => { secrets.push(secret); save(`worker-browser-secrets-${fixture.phase}.json`, secrets); };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser;

async function control(path, { method = 'GET', key, body, cookie } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (cookie) Object.assign(headers, browserSessionHeaders(cookie, fixture.origin));
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(fixture.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const data = response.status === 204 ? null : await response.json();
  return { response, data };
}

async function login(page) {
  await page.goto(`${origin}/workers`);
  await page.getByLabel('Portal password').fill(fixture.password);
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/login' && response.status() === 200);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const session = await checkBrowserSession(page, await pending); remember(session.value);
  await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Refresh workers', exact: true })).toBeEnabled();
  return session;
}

async function privateStorage(page, context, cookieCount = 1) {
  const actual = await page.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage),
    databases: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
    caches: typeof caches === 'undefined' ? [] : await caches.keys(), workers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0 }));
  expect(actual).toEqual({ local: [], session: [], databases: 0, caches: [], workers: 0 });
  expect((await context.cookies()).length).toBe(cookieCount);
  expect(await page.evaluate(() => document.cookie)).toBe('');
}

async function screenshot(page, kind, width) {
  expect(await page.locator('[data-sensitive]').count()).toBe(0);
  const text = await page.locator('body').innerText();
  expect([fixture.password, ...secrets].some(secret => text.includes(secret))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const name = `workers-${kind}-${width}.png`;
  const modal = await page.locator('dialog:modal').count();
  await page.screenshot({ path: join(fixture.directory, name), fullPage: modal === 0, animations: 'disabled' });
  receipt.design.push(await inspectTaste(page, fixture.directory, name.replace('.png', '')));
  receipt.screenshots.push(name);
}

async function openWorker(page, id) {
  await page.locator('tbody tr').filter({ hasText: id }).getByRole('button').click();
  await expect(page.getByRole('region', { name: 'Worker detail' })).toBeVisible();
  const drawer = page.locator('.worker-drawer');
  await expect(drawer.getByRole('heading', { level: 2 })).toBeFocused();
  expect(new URL(page.url()).pathname).toBe('/workers');
  expect(await page.locator('tbody tr').filter({ hasText: id }).count()).toBe(1);
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
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: 'block' }); const page = await context.newPage();
    await login(page); await expect(page.getByText(/No workers have access/)).toBeVisible();
    await screenshot(page, 'empty', width); await privateStorage(page, context);
    passed('portal.workers_empty', { width }); await context.close();
  }
}

async function verifyDrawerDismissal(page, opener, width, scroll) {
  const drawer = page.locator('.worker-drawer');
  const name = drawer.getByLabel('Display name', { exact: true });
  const close = drawer.getByRole('button', { name: 'Close', exact: true });
  await expect(drawer.locator('.data-panel').first().getByRole('heading')).toHaveText('Registration and access');
  await expect(name).toBeInViewport();
  await expect(drawer.getByRole('button', { name: 'Save name', exact: true })).toBeInViewport();
  await expect.poll(() => drawer.evaluate(element => Math.abs(new DOMMatrix(getComputedStyle(element).transform).m41))).toBeLessThan(1);
  const drawerBox = await drawer.boundingBox();
  expect(drawerBox.x).toBeGreaterThanOrEqual(44);
  if (width === 390) expect(drawerBox.x + drawerBox.width).toBeCloseTo(width, 0);
  const rowBox = await opener.boundingBox();
  const x = rowBox.x + 3;
  const y = rowBox.y + rowBox.height / 2;
  expect(x).toBeLessThan(drawerBox.x);

  await page.mouse.click(drawerBox.x + 6, y);
  await page.mouse.move(drawerBox.x + 6, y);
  await page.mouse.down();
  await page.mouse.move(x, y);
  await page.mouse.up();
  await expect(drawer).toBeVisible();
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(drawerBox.x + 6, y);
  await page.mouse.up();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Revoke worker', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Revoke this worker?' });
  await expect(confirm).toBeVisible();
  await page.mouse.click(x, y);
  await expect(confirm).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(confirm).not.toBeVisible();
  await expect(drawer).toBeVisible();
  await opener.evaluate(element => element.addEventListener('click', () => { element.dataset.backgroundClicked = 'yes'; }, { once: true }));
  if (width === 390) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await expect(drawer).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(await opener.getAttribute('data-background-clicked')).toBeNull();
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  const id = await opener.locator('..').locator('.worker-id').textContent();
  await openWorker(page, id);
  await close.click();
  await expect(drawer).not.toBeVisible();
  await expect(opener).toBeFocused();
  expect(await page.evaluate(() => scrollY)).toBe(scroll);
  passed('portal.worker_drawer_dismissal', { width, rename_in_viewport: true, close: true, backdrop: true, drag_ignored: true,
    nested_confirmation: true, focus_restored: true, scroll_preserved: true, touch: width === 390 });
}

async function viewports() {
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: width === 390 ? 844 : 900 }, hasTouch: width === 390,
      serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] }); const page = await context.newPage();
    const origins = new Set(); const telemetry = []; page.on('request', request => {
      origins.add(new URL(request.url()).origin);
      if (new URL(request.url()).pathname === '/api/v1/portal/events') telemetry.push(request.postData() || '');
    });
    const session = await login(page);
    const row = id => page.locator('tbody tr').filter({ hasText: id });
    await expect(row(fixture.workers.offline_id)).toContainText('Offline');
    await expect(row(fixture.workers.offline_id).locator('.offline-duration .num')).toHaveText(/^\d+h \d+m \d+s$/);
    if (width === 390) await expect(row(fixture.workers.offline_id).locator('.offline-label')).toBeVisible();
    expect(await page.evaluate(() => window.__unsafe === undefined && document.querySelector('tbody img') === null)).toBe(true);
    await expect(row(fixture.workers.transport_id)).toContainText('Online');
    await expect(page.getByRole('columnheader', { name: 'Qualification' })).toHaveCount(0);
    await expect(row(fixture.workers.busy_id)).toContainText('Busy');
    await expect(row(fixture.workers.waiting_id)).toContainText('1 client-tool waits');
    await expect(row(fixture.workers.reconnected_id)).toContainText('Idle');
    await screenshot(page, 'list', width);
    await page.evaluate(() => scrollTo(0, 100));
    await row(fixture.workers.transport_id).getByRole('button').scrollIntoViewIfNeeded();
    const listScroll = await page.evaluate(() => scrollY);
    expect(listScroll).toBeGreaterThan(0);
    await openWorker(page, fixture.workers.transport_id);
    await expect(page.getByRole('heading', { name: 'Reported by Muse during setup' })).toBeVisible();
    await expect(page.getByText('Controlled Muse', { exact: true })).toBeVisible();
    await expect(page.getByText('350,000 tokens', { exact: true })).toBeVisible();
    await expect(page.getByText('2026-11-18 00:00:00 UTC', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(row(fixture.workers.transport_id).getByRole('button')).toBeFocused();
    expect(await page.evaluate(() => scrollY)).toBe(listScroll);
    await openWorker(page, fixture.workers.transport_id);
    await verifyDrawerDismissal(page, row(fixture.workers.transport_id).getByRole('button'), width, listScroll);
    await openWorker(page, fixture.workers.busy_id);
    await expect(page.getByText(fixture.workers.busy_job_id, { exact: true })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Inference qualification' })).toHaveCount(0);
    await expect(page.getByText('Installed version', { exact: true }).locator('..')).toContainText('Not reported');
    await expect(page.getByText('Not independently observed', { exact: true })).toBeVisible();
    const acceptedName = `Research agent ${width} 名称`;
    await page.getByLabel('Display name', { exact: true }).fill(`  ${acceptedName}  `);
    const renamed = await action(page, `/api/v1/admin/workers/${fixture.workers.busy_id}`, () => page.getByRole('button', { name: 'Save name', exact: true }).click());
    expect(renamed.data.id).toBe(fixture.workers.busy_id); expect(renamed.data.name).toBe(acceptedName);
    expect(renamed.data.current_job.job_id).toBe(fixture.workers.busy_job_id);
    await expect(page.getByRole('heading', { name: acceptedName, exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save name' })).toBeFocused();
    await page.locator('.worker-drawer').getByRole('button', { name: 'Refresh workers' }).click();
    await expect(page.locator('.worker-drawer').getByRole('button', { name: 'Refresh workers' })).toBeEnabled();
    await expect(page.locator('.worker-drawer').getByRole('button', { name: 'Refresh workers' })).toBeFocused();
    await expect(page.getByRole('heading', { name: acceptedName, exact: true })).toBeVisible();
    await page.getByLabel('Display name', { exact: true }).fill('   ');
    const invalid = await action(page, `/api/v1/admin/workers/${fixture.workers.busy_id}`, () => page.getByRole('button', { name: 'Save name', exact: true }).click(), 400);
    await expect(page.getByText(/Name not accepted/)).toBeVisible(); await expect(page.getByText(invalid.response.headers()['x-request-id'], { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save name' })).toBeFocused();
    const drawer = page.locator('.worker-drawer');
    await expect(page.getByLabel('Display name', { exact: true })).toBeInViewport();
    await drawer.evaluate(element => { element.scrollTop = 0; });
    await screenshot(page, 'detail', width);
    await page.emulateMedia({ colorScheme: 'dark', reducedMotion: 'reduce' });
    expect(await drawer.evaluate(element => getComputedStyle(element).transitionDuration)).toBe('0s');
    await screenshot(page, 'detail-dark', width);
    await page.emulateMedia({ colorScheme: 'light', reducedMotion: 'no-preference' });
    await page.getByRole('button', { name: 'Close', exact: true }).click(); await expect(row(fixture.workers.busy_id)).toContainText(acceptedName);
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
    await expect(page.locator('.worker-drawer')).toBeVisible();
    expect((await control('/api/v1/worker/status', { key: enrolled.data.credential })).response.status).toBe(200);
    await page.getByRole('button', { name: 'Revoke worker', exact: true }).click(); await screenshot(page, 'revoke', width);
    const revoked = await action(page, `/api/v1/admin/workers/${enrolled.data.worker.id}/revoke`, () => dialog.getByRole('button', { name: 'Confirm revocation' }).click());
    expect(!!revoked.data.revoked_at).toBe(true); await expect(page.getByText(/server confirmed revocation/)).toBeVisible();
    await expect(page.locator('.worker-drawer')).not.toBeVisible();
    await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeFocused();
    await expect(row(enrolled.data.worker.id)).toHaveCount(0);
    expect((await control('/api/v1/worker/status', { key: enrolled.data.credential })).response.status).toBe(401);
    const retained = await control('/api/v1/admin/workers', { cookie: session });
    expect(retained.data.workers.some(worker => worker.id === enrolled.data.worker.id && worker.revoked_at)).toBe(true);
    expect(telemetry.every(value => !secrets.some(secret => value.includes(secret)))).toBe(true);
    expect([...origins]).toEqual([new URL(origin).origin]);
    passed('portal.workers_actions', { width, accepted_rename: true, identity_and_assignment_preserved: true, full_prompt: true, single_use: true, confirmed_revocation: true, keyboard: true, persistent_credentials: false });
    await context.close();
  }
}

async function offlineDuration() {
  const contexts = [];
  const views = [];
  try {
    for (const width of [1440, 768, 390]) {
      const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block', viewport: { width, height: 844 } });
      contexts.push(context);
      const page = await context.newPage();
      await page.clock.install({ time: new Date('2026-11-20T00:00:00Z') });
      await page.clock.pauseAt(new Date('2026-11-20T00:10:00Z'));
      let reads = 0;
      page.on('request', request => { if (new URL(request.url()).pathname === '/api/v1/admin/workers') reads++; });
      await login(page);
      const row = page.locator('tbody tr').filter({ hasText: fixture.workers.reconnect_id });
      const cell = row.locator('.offline-duration .num');
      await expect(cell).toHaveText(/^\d+h \d+m \d+s$/);
      const initial = await cell.textContent();
      const before = reads;
      await page.clock.runFor(2_100);
      await expect(cell).not.toHaveText(initial);
      expect(reads).toBe(before);
      views.push({ page, row, cell, width });
    }
    save('worker-browser-resume-subscriber', {});
    await expect.poll(() => existsSync(join(fixture.directory, 'worker-browser-subscriber-ready')), { timeout: 25_000 }).toBe(true);
    for (const { page, row, cell, width } of views) {
      await page.locator('.page-heading').getByRole('button', { name: 'Refresh workers', exact: true }).click();
      await expect(row.getByText('Online', { exact: true })).toBeVisible();
      await expect(cell).toHaveText('-');
      passed('portal.worker_offline_timer', { width, seconds_advance_locally: true, no_extra_requests: true, authenticated_reconnect: true });
    }
  } finally {
    await Promise.all(contexts.map(context => context.close()));
  }
}

async function orderingAndUncertainty(width) {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 900 }, serviceWorkers: 'block' }); const page = await context.newPage();
  const session = await login(page); await openWorker(page, fixture.workers.busy_id);
  let release, seen; const gate = new Promise(resolve => { release = resolve; }); const observed = new Promise(resolve => { seen = resolve; });
  await page.route('**/api/v1/admin/workers', async route => { const response = await route.fetch(); seen(); await gate; await route.fulfill({ response }); });
  await page.locator('.worker-drawer').getByRole('button', { name: 'Refresh workers' }).click(); await observed;
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
  await page.locator('.worker-drawer').getByRole('button', { name: 'Refresh workers' }).click();
  await expect(page.getByRole('heading', { name: 'Committed before response loss', exact: true })).toBeVisible();
  const actual = await control('/api/v1/admin/workers', { cookie: session });
  expect(actual.data.workers.find(worker => worker.id === fixture.workers.busy_id).current_job.job_id).toBe(fixture.workers.busy_job_id);
  if (width === 1440) await screenshot(page, 'error', width);
  passed('portal.worker_ordering_and_uncertainty', { width, obsolete_response_discarded: true, committed_response_loss_reconciled: true, automatic_mutation_retry: false });
  await page.getByRole('button', { name: 'Close', exact: true }).click();
  await page.getByLabel('Enrollment format').selectOption('code');
  const registration = await action(page, '/api/v1/admin/enrollments', () => page.getByRole('button', { name: 'Generate enrollment code' }).click(), 201);
  remember(registration.data.enrollment_code);
  const enrolled = await control('/api/v1/worker/enroll', { method: 'POST', body: { enrollment_code: registration.data.enrollment_code } });
  expect(enrolled.response.status).toBe(201);
  remember(enrolled.data.credential);
  const offline = enrolled.data.worker.id;
  await page.locator('.page-heading').getByRole('button', { name: 'Refresh workers', exact: true }).click();
  await openWorker(page, offline);
  const drawer = page.locator('.worker-drawer');
  let releaseOld, seeOld, heldRequestID;
  const held = new Promise(resolve => { releaseOld = resolve; });
  const hasOld = new Promise(resolve => { seeOld = resolve; });
  await page.route('**/api/v1/admin/workers', async route => {
    const response = await route.fetch();
    heldRequestID = response.headers()['x-request-id'];
    seeOld(); await held; await route.fulfill({ response });
  });
  await drawer.getByRole('button', { name: 'Refresh workers' }).click(); await hasOld;
  const revokePath = `/api/v1/admin/workers/${offline}/revoke`;
  await page.route('**' + revokePath, async route => {
    const committed = await route.fetch();
    expect(committed.status()).toBe(200);
    receipt.diagnostics.push({ request_id: committed.headers()['x-request-id'], event: 'worker.revoked', client_unconfirmed: true });
    await route.abort('failed');
  }, { times: 1 });
  await drawer.getByRole('button', { name: 'Revoke worker', exact: true }).click();
  const lost = report(page, 'request_failed');
  await page.getByRole('dialog', { name: 'Revoke this worker?' }).getByRole('button', { name: 'Confirm revocation' }).click();
  await lost;
  await expect(drawer.getByText(/action could not be confirmed/)).toBeVisible();
  await expect(drawer).toBeVisible();
  const discard = report(page, 'obsolete_response');
  releaseOld();
  expect((await discard).request_id).toBe(heldRequestID);
  await page.unroute('**/api/v1/admin/workers');
  await expect(drawer).toBeVisible();
  await drawer.getByRole('button', { name: 'Refresh workers' }).click();
  await expect(drawer).not.toBeVisible();
  await expect(page.locator('tbody tr').filter({ hasText: offline })).toHaveCount(0);
  await expect(page.getByText('The refreshed list shows that worker access is revoked.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeFocused();
  passed('portal.revocation_response_loss_and_stale_poll', { width, authoritative_refresh: true, prior_read_discarded: true });
  await context.close();
}

function verifyOwner(identity) {
  const actual = JSON.parse(execFileSync('docker', ['inspect', identity], { encoding: 'utf8' }))[0];
  expect(actual.Config.Labels['io.aaa-muse.test-owner']).toBe(fixture.owner);
}

async function independentRevocation() {
  const options = { ignoreHTTPSErrors: true, serviceWorkers: 'block' };
  const first = await browser.newContext(options), second = await browser.newContext(options);
  try {
    const primary = await first.newPage(), other = await second.newPage();
    await primary.clock.install();
    const primarySession = await login(primary);
    const otherSession = await login(other);
    expect(primarySession.value === otherSession.value).toBe(false);
    const id = fixture.workers.offline_id;
    for (const page of [primary, other]) {
      await openWorker(page, id);
      await page.getByRole('button', { name: 'Revoke worker', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Revoke this worker?' })).toBeVisible();
    }
    const revoke = await action(other, `/api/v1/admin/workers/${id}/revoke`, () => other.getByRole('button', { name: 'Confirm revocation' }).click());
    expect(Boolean(revoke.data.revoked_at)).toBe(true);
    await expect(primary.getByRole('dialog', { name: 'Revoke this worker?' })).toBeVisible();
    const refreshed = primary.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/workers' && response.status() === 200);
    await primary.clock.fastForward(30_001);
    await refreshed;
    await expect(primary.locator('dialog:modal')).toHaveCount(0);
    await expect(primary.locator('tbody tr').filter({ hasText: id })).toHaveCount(0);
    await expect(primary.getByRole('heading', { name: 'Workers', exact: true })).toBeFocused();
    passed('portal.worker_revoked_from_another_browser_closes_both_dialogs');
  } finally {
    await first.close();
    await second.close();
  }
}

function fixtureSQL(sql) {
  verifyOwner(fixture.database);
  execFileSync('docker', ['exec', '-i', '--user', '10001:10001', fixture.database, 'sqlite3', '-bail', '-batch', '-cmd', '.timeout 4000',
    '/var/lib/aaa-muse-ai/state/broker.sqlite3'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
}

async function outageAndDenial() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' }); const page = await context.newPage(); const session = await login(page);
  fixtureSQL('ALTER TABLE aaa_workers RENAME TO hidden_aaa_workers;');
  try {
    const backend = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/workers' && response.status() === 503);
    const stale = report(page, 'service_unavailable'); await page.getByRole('button', { name: 'Refresh workers' }).click();
    const response = await backend; await stale;
    await expect(page.getByText('Could not refresh workers. Check the connection and retry.')).toBeVisible();
    receipt.diagnostics.push({ request_id: response.headers()['x-request-id'], event: 'worker.operation_failed' });
  } finally { fixtureSQL('ALTER TABLE hidden_aaa_workers RENAME TO aaa_workers;'); }
  const deadline = Date.now() + 30_000; let ready = false;
  while (Date.now() < deadline) { const result = await control('/readyz'); if (result.response.status === 200) { ready = true; break; } await pause(100); }
  expect(ready).toBe(true); await page.getByRole('button', { name: 'Refresh workers' }).click(); await expect(page.getByText('Stale snapshot · Refresh before changing worker access.')).not.toBeVisible();
  await action(page, '/api/v1/admin/enrollments', async () => { await page.getByLabel('Enrollment format').selectOption('code'); await page.getByRole('button', { name: 'Generate enrollment code' }).click(); }, 201).then(value => remember(value.data.enrollment_code));
  expect((await control('/api/v1/portal/logout', { cookie: session, method: 'POST' })).response.status).toBe(204);
  const denied = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/workers' && response.status() === 401);
  await page.getByRole('button', { name: 'Refresh workers' }).click(); const rejected = await denied;
  await expect(page.getByText('Your session ended. Sign in again.')).toBeVisible();
  const request = rejected.headers()['x-request-id'];
  const operation = rejected.request().headers()['x-portal-operation-id'];
  await expect(page.getByText(request, { exact: true })).toBeVisible();
  await expect(page.getByText(operation, { exact: true })).toBeVisible();
  receipt.diagnostics.push({ request_id: request, operation_id: operation, event: 'portal.auth_failed' });
  expect(await page.locator('[data-sensitive]').count()).toBe(0); await privateStorage(page, context);
  passed('portal.worker_outage_recovery_and_denial', { real_sqlite_fault: true, invalid_session_clears_enrollment: true }); await context.close();
}

async function expiryAndLateLogout() {
  const context = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' }); const page = await context.newPage(); await page.clock.install(); await login(page);
  await page.getByLabel('Enrollment format').selectOption('code');
  const issued = await action(page, '/api/v1/admin/enrollments', () => page.getByRole('button', { name: 'Generate enrollment code' }).click(), 201); remember(issued.data.enrollment_code);
  await page.clock.fastForward(900_001); await expect(page.getByText(/Enrollment expired/)).toBeVisible();
  expect(await page.locator('[data-sensitive]').count()).toBe(0); expect(await page.getByRole('button', { name: 'Copy enrollment code' }).count()).toBe(0);
  passed('portal.worker_browser_enrollment_expiry', { browser_clock_controlled: true, server_expiry_tested_separately: true }); await context.close();
  const second = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' }); const delayed = await second.newPage(); await login(delayed);
  let release, seen, done; const gate = new Promise(resolve => { release = resolve; }); const observed = new Promise(resolve => { seen = resolve; }); const finished = new Promise(resolve => { done = resolve; });
  await delayed.route('**/api/v1/admin/workers', async route => { const response = await route.fetch(); seen(); await gate; try { await route.fulfill({ response }); } catch (error) { if (!route.request().failure()) throw error; } finally { done(); } });
  await delayed.getByRole('button', { name: 'Refresh workers' }).click(); await observed; await delayed.getByRole('button', { name: 'Sign out' }).click(); release(); await finished;
  await expect(delayed.getByRole('heading', { name: 'Service access' })).toBeVisible(); expect(await delayed.getByRole('region', { name: 'Registered workers' }).count()).toBe(0);
  passed('portal.worker_late_response_after_logout'); await second.close();
  const third = await browser.newContext({ ignoreHTTPSErrors: true, serviceWorkers: 'block' }); const timed = await third.newPage(); await timed.clock.install(); await login(timed);
  let unblock, reached; const blocked = new Promise(resolve => { unblock = resolve; }); const requested = new Promise(resolve => { reached = resolve; });
  await timed.route('**/api/v1/admin/workers', async route => { const response = await route.fetch(); reached(); await blocked; try { await route.fulfill({ response }); } catch (error) { if (!route.request().failure()) throw error; } });
  const deadlineReport = report(timed, 'request_timeout'); await timed.getByRole('button', { name: 'Refresh workers' }).click(); await requested;
  await timed.clock.fastForward(10_001); await deadlineReport; await expect(timed.getByText('Could not refresh workers. Check the connection and retry.')).toBeVisible();
  unblock(); await third.close(); passed('portal.worker_request_deadline', { deadline_ms: 10000 });
}

try {
  browser = await chromium.launch({ headless: true });
  if (fixture.phase === 'empty') await emptyViews();
  else {
    await offlineDuration();
    await viewports();
    for (const width of [1440, 768, 390]) await orderingAndUncertainty(width);
    await independentRevocation();
    await expiryAndLateLogout();
    await outageAndDenial();
  }
  receipt.outcome = 'passed';
  console.log(JSON.stringify({ case: 'portal.workers_browser_conformance', outcome: 'passed', cases: receipt.cases.length, screenshots: receipt.screenshots.length }));
} catch (error) {
  let detail = String(error?.stack || error).replace(/muse_(?:portal|worker|enroll)_[A-Za-z0-9_-]{43}/g, '[REDACTED]');
  for (const value of [fixture.password, ...secrets]) detail = detail.split(value).join('[REDACTED]');
  writeFileSync(join(fixture.directory, `worker-browser-failure-${fixture.phase}.txt`), detail, { mode: 0o600 });
  console.error('Worker browser conformance failed; inspect private worker-browser evidence.'); process.exitCode = 1;
} finally { save(`worker-browser-receipt-${fixture.phase}.json`, receipt); if (browser) await browser.close(); }
