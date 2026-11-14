import { browserTransport } from './browser-transport.mjs';
import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { inspectTaste } from './taste.mjs';

const fixture = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--fixture') + 1], 'utf8'));
const transport = browserTransport(fixture.origin);
const receipt = { source_sha: fixture.source_sha, outcome: 'failed', cases: [], diagnostics: [], screenshots: [], design: [] };
const secrets = [];
const save = (name, value) => writeFileSync(join(fixture.directory, name), JSON.stringify(value, null, 2), { mode: 0o600 });
const passed = (name, fields = {}) => receipt.cases.push({ case: name, outcome: 'passed', ...fields });
const remember = value => { secrets.push(value); save(`history-browser-secrets-${fixture.phase}.json`, secrets); };
const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
let browser;

async function control(path, { key, method = 'GET', body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(fixture.origin + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(10_000) });
  const value = response.status === 204 ? null : await response.json();
  return { response, value };
}
async function login(page) {
  await page.goto(transport.origin + '/requests');
  await page.getByLabel('Portal password').fill(fixture.password);
  const sessionResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/portal/login' && response.status() === 200);
  const listResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/requests' && response.status() === 200);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const session = await (await sessionResponse).json(); remember(session.session_token);
  await listResponse;
  await expect(page.getByRole('heading', { name: 'Requests', exact: true })).toBeVisible();
  return session;
}
async function privateStorage(page, context) {
  const state = await page.evaluate(async () => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage), databases: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).length : 0,
    caches: typeof caches === 'undefined' ? [] : await caches.keys(), workers: 'serviceWorker' in navigator ? (await navigator.serviceWorker.getRegistrations()).length : 0 }));
  expect(state).toEqual({ local: [], session: [], databases: 0, caches: [], workers: 0 }); expect(await context.cookies()).toEqual([]);
}
async function screenshot(page, kind, width) {
  const text = await page.locator('body').innerText(); expect([fixture.password, ...secrets].some(value => text.includes(value))).toBe(false);
  expect(await page.locator('[data-sensitive]').count()).toBe(0); expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
  const name = `history-${kind}-${width}.png`; await page.screenshot({ path: join(fixture.directory, name), fullPage: true });
  receipt.design.push(await inspectTaste(page, fixture.directory, name.replace('.png', ''))); receipt.screenshots.push(name);
}
async function open(page, id) {
  const back = page.getByRole('button', { name: 'All requests', exact: true });
  if (await back.count()) await back.click();
  await page.getByLabel('Exact request ID').fill(id);
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/v1/admin/requests/' + id);
  const timeline = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/timeline') && value.status() === 200);
  await page.getByRole('button', { name: 'Open request', exact: true }).click();
  const actual = await response; expect(actual.status()).toBe(200);
  await expect(page.getByRole('region', { name: 'Request detail' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Request detail', exact: true })).toBeFocused();
  await expect(page.getByRole('heading', { name: 'Conversation timeline' })).toBeVisible();
  await timeline;
  await expect(page.getByRole('region', { name: 'Conversation timeline' })).toHaveAttribute('aria-busy', 'false');
  return actual;
}
function waitReport(page, event, cause, kind) {
  return page.waitForResponse(response => {
    if (new URL(response.url()).pathname !== '/api/v1/portal/events' || response.status() !== 204) return false;
    const value = response.request().postDataJSON(); return value.event === event && value.cause === cause && (!kind || value.query_kind === kind);
  }).then(response => {
    const data = response.request().postDataJSON(); expect(data.build).toBe(fixture.source_sha); expect([fixture.password, ...secrets].some(secret => JSON.stringify(data).includes(secret))).toBe(false);
    receipt.diagnostics.push({ operation_id: data.operation_id, event, cause }); return data;
  });
}
async function nextTimeline(page) {
  const response = page.waitForResponse(value => new URL(value.url()).pathname.endsWith('/timeline') && value.status() === 200);
  await page.getByRole('button', { name: 'Next timeline page', exact: true }).click(); await response;
  await expect(page.getByRole('region', { name: 'Conversation timeline' })).toHaveAttribute('aria-busy', 'false');
}
async function timelineText(page) {
  let value = '';
  for (let pages = 0; pages < 20; pages++) {
    const region = page.getByRole('region', { name: 'Conversation timeline' });
    value += await region.innerText();
    if (!await page.getByRole('button', { name: 'Next timeline page', exact: true }).isEnabled()) return value;
    await nextTimeline(page);
  }
  throw new Error('controlled timeline exceeded the expected bounded page count');
}
async function cancellation(page, id) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === `/api/v1/admin/experiments/${id}/cancel`);
  await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click();
  const response = await pending; receipt.diagnostics.push({ request_id: response.headers()['x-request-id'] }); return response;
}
function verifyOwner(identity) {
  const inspected = JSON.parse(execFileSync('docker', ['inspect', identity], { encoding: 'utf8' }))[0];
  expect(inspected.Config.Labels['io.aaa-muse.test-owner']).toBe(fixture.owner);
}
function concurrentLegacy() {
  verifyOwner(fixture.database);
  const id = randomBytes(16).toString('hex'), conversation = randomBytes(16).toString('hex'), time = new Date().toISOString();
  const data = { id, conversation_id: conversation, worker_id: fixture.fixtures.native.worker_id, state: 'completed', created_at: time, deadline_at: time, current_job_id: '', messages: [], tools: [], final_text: 'Concurrent legacy arrival', remote_outcome: 'decision_observed' };
  const sql = `INSERT INTO aaa_experiments(id,worker_id,state,deadline_at,data) VALUES ('${id}','${data.worker_id}','completed','${time}','${JSON.stringify(data)}');`;
  execFileSync('docker', ['exec', '-i', fixture.database, 'psql', '-X', '-v', 'ON_ERROR_STOP=1', '-U', 'postgres', '-d', 'aaa_muse'], { input: sql, stdio: ['pipe', 'pipe', 'pipe'] });
  return id;
}

async function emptyViews() {
  for (const width of [1440, 768, 390]) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: 'block' }); const page = await context.newPage();
    await login(page); await expect(page.getByText(/No recorded requests match/)).toBeVisible(); await screenshot(page, 'empty', width); await privateStorage(page, context);
    passed('portal.history_empty', { width }); await context.close();
  }
}
async function viewports() {
  const data = fixture.fixtures;
  for (const [index, width] of [1440, 768, 390].entries()) {
    const context = await browser.newContext({ viewport: { width, height: width === 390 ? 844 : 900 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] }); const page = await context.newPage();
    const origins = new Set(); page.on('request', request => origins.add(new URL(request.url()).origin));
    await login(page); await expect(page.locator('tbody tr')).toHaveCount(50); await screenshot(page, 'list', width);
    await open(page, data.native.first.id);
    const recorded = page.getByRole('region', { name: 'Request detail' });
    await expect(recorded.locator('pre').filter({ hasText: '9007199254740993' }).first()).toBeVisible();
    expect(await recorded.innerText()).toContain('Exact request text');
    await expect(page.getByRole('region', { name: 'Recorded outcome', exact: true }).getByText('Current name: Renamed archive agent', { exact: true })).toBeVisible();
    expect(await page.evaluate(() => window.__unsafe === undefined && document.querySelector('.request-detail img') === null)).toBe(true);
    await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeDisabled();
    await page.getByRole('button', { name: 'Copy request ID', exact: true }).click(); expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(data.native.first.id);
    await screenshot(page, 'detail', width);
    const timeline = await timelineText(page); expect(timeline).toContain(data.native.call_id); expect(timeline).toContain('Client-only exact result'); expect(timeline).toContain('Selected request');
    await open(page, data.native.continued.id); await expect(page.getByRole('region', { name: 'Request detail' })).toContainText('Client-only exact result');
    await open(page, data.native.response_request_id); await expect(page.getByText('Instructions only for this Responses request', { exact: false, selector: 'pre' }).first()).toBeVisible();
    await open(page, data.legacy); await expect(page.getByText(/Legacy request ·/)).toBeVisible(); await expect(page.getByText(/Native session identity/)).toBeVisible();
    await expect(page.locator('pre').filter({ hasText: '1e200000' })).toHaveCount(1);
    for (const id of [data.nul.native, data.nul.legacy]) {
      const response = await open(page, id); const value = await response.json();
      const snapshot = await page.getByRole('region', { name: 'Request detail' }).innerText();
      expect(snapshot).toContain('nul-history-value\\u0000'); expect(snapshot).toContain('literal\\\\u0000');
      expect(value.kind === 'native' ? value.request.input.messages[0].text : value.history[0].text).toContain('nul-history-value\u0000');
      const retained = await timelineText(page); expect(retained).toContain('nul-history-value\\u0000'); expect(retained).toContain(data.nul.call_id);
    }
    passed('portal.history_nul_native_and_legacy', { width, escaped_nul_preserved: true, literal_escape_distinct: true, timeline_readable: true });
    const queued = data.cancellation.queued[index]; await open(page, queued.id); await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Cancel request', exact: true }).click(); const dialog = page.getByRole('dialog'); await expect(dialog.getByRole('button', { name: 'Keep request' })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
    await page.getByRole('button', { name: 'Cancel request', exact: true }).click(); await screenshot(page, 'cancel', width);
    const cancelled = await cancellation(page, queued.id); expect(cancelled.status()).toBe(200); expect((await cancelled.json()).state).toBe('cancelled');
    await expect(page.getByText(/Server recorded cancelled/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeDisabled();
    expect([...origins]).toEqual([new URL(transport.origin).origin]); await privateStorage(page, context);
    passed('portal.history_text_tools_instructions_and_cancellation', { width, text_safe: true, immutable_worker_identity: true, current_name_labeled: true, request_scoped_instructions: true, clipboard: true, keyboard_confirmation: true }); await context.close();
  }
}
async function boundaries() {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage(); await login(page);
  await open(page, fixture.fixtures.boundaries.safe); const moved = await timelineText(page); expect(moved).toContain('dispatch.reassigned'); expect(moved).toContain('offline_before_claim_and_context'); expect(moved).toContain('prior_job_id'); expect(moved).toContain('Current name: Previous worker renamed now'); expect(moved).toContain('Current name: Replacement worker renamed now'); expect(moved).toContain('Full-history replacement');
  await open(page, fixture.fixtures.boundaries.context); await expect(page.getByText(/Context exposure or claimed inference/)).toBeVisible();
  await open(page, fixture.fixtures.boundaries.claimed); await expect(page.getByText('Retained; remote execution may continue', { exact: true })).toBeVisible();
  await open(page, fixture.fixtures.boundaries['tool-wait']); const tools = await timelineText(page); expect(tools).toContain('retained-boundary-call'); expect(tools).toContain('Accepted client result'); expect(tools).not.toContain('dispatch.reassigned');
  passed('portal.history_reassignment_and_interrupted_boundaries', { full_history: true, job_generations_preserved: true, accepted_call_ids_preserved: true, uncertainty_explicit: true }); await context.close();
}
async function pagingAndOrdering() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' }); const page = await context.newPage(); await page.clock.install(); await login(page);
  let release, reached; const gate = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { reached = resolve; }); let delayed = false;
  await page.route('**/api/v1/admin/requests?*', async route => { const response = await transport.fetch(route); if (!delayed) { delayed = true; reached(); await gate; } await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await seen;
  await page.getByLabel('Conversation ID').fill('no-such-conversation'); await page.getByRole('button', { name: 'Apply filter', exact: true }).click(); await expect(page.getByText(/No recorded requests match/)).toBeVisible();
  const discarded = waitReport(page, 'portal.history_load_failed', 'obsolete_response', 'requests'); release(); await discarded;
  await expect(page.getByText(/No recorded requests match/)).toBeVisible(); await page.unrouteAll({ behavior: 'wait' });
  await page.getByLabel('Conversation ID').fill(''); await page.getByRole('button', { name: 'Apply filter', exact: true }).click(); await expect(page.locator('tbody tr')).toHaveCount(50);
  const first = await page.locator('tbody .request-link').allTextContents();
  const failPage = async pattern => {
    await page.route(pattern, async route => { if (new URL(route.request().url()).searchParams.has('cursor')) { await transport.fetch(route); await route.abort('failed'); } else await route.continue(); });
  };
  await failPage('**/api/v1/admin/requests?*');
  const failedPage = waitReport(page, 'portal.history_load_failed', 'request_failed', 'requests');
  await page.getByRole('button', { name: 'Next requests page', exact: true }).click(); await failedPage;
  expect(await page.locator('tbody .request-link').allTextContents()).toEqual(first);
  await expect(page.getByLabel('Requests pagination')).toContainText('page 1');
  await expect(page.getByRole('button', { name: 'Previous requests page', exact: true })).toBeDisabled();
  await page.unrouteAll({ behavior: 'wait' });
  const next = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/requests' && new URL(response.url()).searchParams.has('cursor'));
  await page.getByRole('button', { name: 'Next requests page', exact: true }).click(); await next; await expect(page.getByText(/Older request page/)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Recorded requests' })).toHaveAttribute('aria-busy', 'false');
  const older = await page.locator('tbody .request-link').allTextContents(); expect(older.every(id => !first.includes(id))).toBe(true);
  await expect(page.getByLabel('Requests pagination')).toContainText('page 2');
  await page.getByRole('button', { name: 'Previous requests page', exact: true }).click(); await expect(page.getByLabel('Requests pagination')).toContainText('page 1');
  expect(await page.locator('tbody .request-link').allTextContents()).toEqual(first);
  await page.getByRole('button', { name: 'Next requests page', exact: true }).click(); await expect(page.getByText(/Older request page/)).toBeVisible();
  const concurrent = concurrentLegacy(); await page.clock.fastForward(30_001); expect(await page.locator('tbody .request-link').allTextContents()).toEqual(older);
  await page.getByRole('button', { name: 'First requests page', exact: true }).click(); await expect(page.locator('tbody .request-link').first()).toHaveText(concurrent);
  await open(page, fixture.fixtures.native.first.id);
  const timeline = page.getByRole('region', { name: 'Conversation timeline' }), events = await timeline.locator('.timeline-events').innerText();
  await failPage('**/api/v1/admin/conversations/*/timeline?*');
  const failedEvents = waitReport(page, 'portal.history_load_failed', 'request_failed', 'timeline');
  await page.getByRole('button', { name: 'Next timeline page', exact: true }).click(); await failedEvents;
  expect(await timeline.locator('.timeline-events').innerText()).toBe(events); await expect(page.getByLabel('Timeline pagination')).toContainText('page 1');
  await expect(page.getByRole('button', { name: 'Previous timeline page', exact: true })).toBeDisabled(); await page.unrouteAll({ behavior: 'wait' });
  await nextTimeline(page); await expect(page.getByLabel('Timeline pagination')).toContainText('page 2');
  await page.getByRole('button', { name: 'Previous timeline page', exact: true }).click(); await expect(page.getByLabel('Timeline pagination')).toContainText('page 1');
  expect(await timeline.locator('.timeline-events').innerText()).toBe(events);
  passed('portal.history_pagination_failure_recovery', { requests: true, timeline: true, retained_cursor_matches_records: true });
  passed('portal.history_pagination_and_concurrent_arrivals', { page_limit: 50, duplicate_ids: false, older_page_preserved: true, obsolete_response_discarded: true }); await context.close();
}
async function selectionAndCancellationOrdering() {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' }); const page = await context.newPage(); await login(page);
  const first = fixture.fixtures.native.first.id, second = fixture.fixtures.native.continued.id;
  await open(page, first);
  let release, reached; const gate = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { reached = resolve; });
  await page.route(`**/api/v1/admin/requests/${first}`, async route => { const response = await transport.fetch(route); reached(); await gate; await route.fulfill({ response }); });
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await seen;
  await open(page, second); const obsolete = waitReport(page, 'portal.history_load_failed', 'obsolete_response', 'request'); release(); await obsolete;
  await expect(page.getByRole('button', { name: 'Copy request ID', exact: true }).locator('..')).toContainText(second);
  await page.unrouteAll({ behavior: 'wait' });
  const target = fixture.fixtures.cancellation.queued[5].id; await open(page, target);
  let finish, started; const paused = new Promise(resolve => { finish = resolve; }), fetched = new Promise(resolve => { started = resolve; }); let old = true;
  await page.route(`**/api/v1/admin/requests/${target}`, async route => { const response = await transport.fetch(route); if (old) { old = false; started(); await paused; } await route.fulfill({ response }); });
  await page.evaluate(() => scrollTo(0, 180));
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await fetched;
  await page.getByRole('button', { name: 'Cancel request', exact: true }).click(); await cancellation(page, target);
  await expect(page.getByText(/Server recorded cancelled/)).toBeVisible(); const discarded = waitReport(page, 'portal.history_load_failed', 'obsolete_response', 'request'); finish(); await discarded;
  await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeDisabled();
  await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  // Clicking an off-screen control can scroll; refresh itself must preserve the resulting position.
  const afterClick = await page.evaluate(() => scrollY); await page.waitForLoadState('networkidle'); expect(await page.evaluate(() => scrollY)).toBe(afterClick);
  passed('portal.history_selection_cancellation_and_scroll_ordering', { obsolete_selection_discarded: true, pre_cancel_read_fenced: true, scroll_preserved: true }); await context.close();
}
async function cancellationOutcomes() {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage(); await login(page);
  const race = fixture.fixtures.cancellation.race, authority = fixture.fixtures.cancellation.race_control; remember(authority.credential);
  await open(page, race.id);
  await page.route(`**/api/v1/admin/experiments/${race.id}/cancel`, async route => {
    const claimed = await control(`/api/v1/worker/jobs/${authority.job_id}/claim`, { key: authority.credential, method: 'POST', body: { protocol_version: 1, submission_id: 'browser-race-claim', connection_id: authority.connection_id, connection_generation: authority.connection_generation } }); expect(claimed.response.status).toBe(200);
    const job = claimed.value;
    const decided = await control(`/api/v1/worker/jobs/${job.id}/decisions`, { key: authority.credential, method: 'POST', body: { protocol_version: 1, submission_id: 'browser-race-decision', connection_id: authority.connection_id, connection_generation: authority.connection_generation, generation: job.generation, lease_id: job.lease_id, conversation_id: job.conversation_id, context_receipt_id: job.context.receipt_id, decision: { type: 'final', text: 'Completion won the cancellation race' } } }); expect(decided.response.status).toBe(200);
    await route.continue();
  });
  await page.getByRole('button', { name: 'Cancel request', exact: true }).click(); expect((await cancellation(page, race.id)).status()).toBe(409);
  await expect(page.getByText(/server rejected cancellation/)).toBeVisible(); await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await expect(page.getByText('Completion won the cancellation race', { selector: 'pre', exact: false }).first()).toBeVisible();
  const lost = fixture.fixtures.cancellation.queued[3]; await open(page, lost.id); let committedID = '', attempts = 0;
  await page.route(`**/api/v1/admin/experiments/${lost.id}/cancel`, async route => { attempts++; const response = await transport.fetch(route); committedID = response.headers()['x-request-id']; await route.abort('failed'); });
  const uncertain = waitReport(page, 'portal.cancel_result', 'request_failed', 'cancel');
  await page.getByRole('button', { name: 'Cancel request', exact: true }).click(); await page.getByRole('button', { name: 'Confirm cancellation', exact: true }).click(); const report = await uncertain;
  receipt.diagnostics.at(-1).committed_request_id = committedID;
  await expect(page.getByText(/Cancellation could not be confirmed/)).toBeVisible(); await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeDisabled(); expect(attempts).toBe(1);
  await page.unrouteAll({ behavior: 'wait' }); await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await expect(page.getByText(/Current server state: cancelled/)).toBeVisible();
  expect(report.request_record_id).toBe(lost.id); await screenshot(page, 'error', 1440);
  await open(page, fixture.fixtures.cancellation.held.id); await page.getByRole('button', { name: 'Cancel request', exact: true }).click(); const held = await cancellation(page, fixture.fixtures.cancellation.held.id); expect(held.status()).toBe(200); expect((await held.json()).remote_outcome).toBe('unknown'); await expect(page.getByText('Retained; remote execution may continue', { exact: true })).toBeVisible();
  passed('portal.history_cancellation_completion_race_and_response_loss', { actual_completion_race: true, committed_response_loss_reconciled: true, mutation_attempts: attempts, held_uncertainty_preserved: true }); await context.close();
}
async function actualRenderFailure() {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage(); await login(page);
  const id = fixture.fixtures.native.first.id; await open(page, id); let sourceID = '';
  await page.route('**/api/v1/admin/conversations/*/timeline?*', async route => {
    const response = await transport.fetch(route); sourceID = response.headers()['x-request-id']; const value = await response.json();
    value.items[0].details = { render_fixture: 'timeline-browser-fault' }; await route.fulfill({ response, json: value });
  });
  await page.evaluate(() => {
    const original = JSON.stringify;
    JSON.stringify = function(value, ...args) { if (value && value.render_fixture === 'timeline-browser-fault') throw new Error('Controlled history serializer failure'); return original.call(JSON, value, ...args); };
  });
  const render = waitReport(page, 'portal.render_failed', 'render_exception', 'timeline'); await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); const report = await render;
  expect(report.request_id).toBe(sourceID); await expect(page.getByRole('alert')).toContainText('This history view could not be rendered');
  expect(report.request_id).not.toBe(await page.getByRole('region', { name: 'Request detail' }).locator('.history-correlation').first().innerText());
  passed('portal.history_actual_timeline_render_failure', { source_http_request_id: sourceID, component: 'timeline', actual_render_boundary: true }); await context.close();
}
async function failuresAndExpiry() {
  const context = await browser.newContext({ serviceWorkers: 'block' }); const page = await context.newPage(); await page.clock.install(); const session = await login(page);
  const target = fixture.fixtures.cancellation.queued[4]; await open(page, target.id);
  verifyOwner(fixture.database); execFileSync('docker', ['stop', '--time', '1', fixture.database], { stdio: 'pipe' });
  try {
    const failed = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/requests/' + target.id && response.status() === 503);
    const reported = waitReport(page, 'portal.history_load_failed', 'service_unavailable', 'request');
    await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); const response = await failed; await reported; receipt.diagnostics.push({ request_id: response.headers()['x-request-id'] });
    await expect(page.getByText(/Could not load request history/).first()).toBeVisible(); await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeDisabled();
  } finally { execFileSync('docker', ['start', fixture.database], { stdio: 'pipe' }); }
  const until = Date.now() + 30_000; let ready = false;
  while (Date.now() < until) { if ((await control('/readyz')).response.status === 200) { ready = true; break; } await pause(100); }
  expect(ready).toBe(true); await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeEnabled();
  await page.route(`**/api/v1/admin/requests/${target.id}`, async route => { const response = await transport.fetch(route); await route.fulfill({ response, json: { kind: 'native', request: {} } }); });
  const malformed = waitReport(page, 'portal.history_load_failed', 'invalid_response', 'request'); await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await malformed; await expect(page.getByText(/history response was invalid/)).toBeVisible(); await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeEnabled();
  let release, reached; const gate = new Promise(resolve => { release = resolve; }), seen = new Promise(resolve => { reached = resolve; });
  await page.route(`**/api/v1/admin/requests/${target.id}`, async route => { const response = await transport.fetch(route); reached(); await gate; try { await route.fulfill({ response }); } catch (error) { if (!route.request().failure()) throw error; } });
  const timeout = waitReport(page, 'portal.history_load_failed', 'request_timeout', 'request'); await page.getByRole('button', { name: 'Refresh history', exact: true }).click(); await seen; await page.clock.fastForward(10_001); await timeout; release(); await page.unrouteAll({ behavior: 'wait' });
  await page.getByRole('button', { name: 'Refresh history', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeEnabled(); await page.waitForLoadState('networkidle');
  await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
  const stale = waitReport(page, 'portal.history_load_failed', 'stale_data', 'request'); await page.clock.fastForward(60_001); await stale; await expect(page.getByRole('button', { name: 'Cancel request', exact: true })).toBeDisabled();
  await page.clock.fastForward(1_800_001); await expect(page.getByText('Your session ended. Sign in again.')).toBeVisible(); expect(await page.getByRole('region', { name: 'Request detail' }).count()).toBe(0); await privateStorage(page, context);
  const actual = await control('/api/v1/portal/logout', { key: session.session_token, method: 'POST' }); expect(actual.response.status).toBe(204);
  passed('portal.history_outage_malformed_timeout_stale_and_browser_expiry', { actual_postgres_outage: true, browser_clock_is_not_server_expiry: true, render_source_correlated: true }); await context.close();
  const deniedContext = await browser.newContext({ serviceWorkers: 'block' }); const deniedPage = await deniedContext.newPage(); const deniedSession = await login(deniedPage);
  expect((await control('/api/v1/portal/logout', { key: deniedSession.session_token, method: 'POST' })).response.status).toBe(204);
  const denied = deniedPage.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/requests' && response.status() === 401); await deniedPage.getByRole('button', { name: 'Refresh history', exact: true }).click(); const deniedResponse = await denied; receipt.diagnostics.push({ request_id: deniedResponse.headers()['x-request-id'] });
  await expect(deniedPage.getByText('Your session ended. Sign in again.')).toBeVisible(); await deniedContext.close();
  const lateContext = await browser.newContext({ serviceWorkers: 'block' }); const late = await lateContext.newPage(); await login(late);
  let finish, seenLate; const pending = new Promise(resolve => { finish = resolve; }), observed = new Promise(resolve => { seenLate = resolve; });
  await late.route('**/api/v1/admin/requests?*', async route => { const response = await transport.fetch(route); seenLate(); await pending; try { await route.fulfill({ response }); } catch (error) { if (!route.request().failure()) throw error; } });
  await late.getByRole('button', { name: 'Refresh history', exact: true }).click(); await observed; const abandoned = waitReport(late, 'portal.history_load_failed', 'obsolete_response', 'requests'); await late.getByRole('button', { name: 'Sign out', exact: true }).click(); await abandoned; finish(); await expect(late.getByRole('heading', { name: 'Service access' })).toBeVisible(); expect(await late.getByRole('region', { name: 'Recorded requests' }).count()).toBe(0); await privateStorage(late, lateContext);
  passed('portal.history_invalid_session_and_late_logout', { server_authority_denied: true, late_response_cannot_restore_content: true }); await lateContext.close();
}

try {
  browser = await chromium.launch({ headless: true, args: transport.args });
  if (fixture.phase === 'empty') await emptyViews();
  else { await viewports(); await boundaries(); await pagingAndOrdering(); await selectionAndCancellationOrdering(); await cancellationOutcomes(); await actualRenderFailure(); await failuresAndExpiry(); }
  receipt.outcome = 'passed';
} finally {
  if (browser) await browser.close(); save(`history-browser-receipt-${fixture.phase}.json`, receipt);
}
