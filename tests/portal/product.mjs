import { chromium, expect } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { browserTransport } from './browser-transport.mjs';
import { checkBrowserSession } from './session.mjs';

const fixture = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--fixture') + 1], 'utf8'));
const password = fixture.password ?? readFileSync(fixture.password_file, 'utf8').replace(/\n$/, '');
const transport = fixture.phase === 'setup' ? { origin: fixture.origin, args: [] } : browserTransport(fixture.origin);
const receipt = { outcome: 'failed', phase: fixture.phase, source_sha: fixture.source_sha, cases: [], prompts: [], secrets: [] };
const save = () => writeFileSync(join(fixture.directory, `product-browser-${fixture.phase}-receipt.json`), JSON.stringify(receipt), { mode: 0o600 });
const passed = (id, fields = {}) => receipt.cases.push({ id, outcome: 'passed', ...fields });
let browser;

async function action(page, path, click, status = 200) {
  const pending = page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() !== 'GET');
  await click();
  const response = await pending;
  expect(response.status()).toBe(status);
  return { data: await response.json(), response, request_id: response.headers()['x-request-id'] };
}

try {
  browser = await chromium.launch({ headless: true, args: transport.args });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', ignoreHTTPSErrors: fixture.phase === 'setup' });
  const page = await context.newPage();
  await page.goto(transport.origin + '/workers');
  await page.getByLabel('Portal password').fill(password);
  const login = await action(page, '/api/v1/portal/login', () => page.getByRole('button', { name: 'Sign in', exact: true }).click());
  receipt.secrets.push((await checkBrowserSession(page, login.response)).value); save();
  await expect(page.getByRole('heading', { name: 'Workers', exact: true })).toBeVisible();
  passed('portal.login', { request_id: login.request_id });
  if (fixture.phase === 'setup') {
    for (const slot of ['a', 'b']) {
      const prompt = await action(page, '/api/v1/admin/setup-prompts', () => page.getByRole('button', { name: 'Generate setup prompt' }).click(), 201);
      expect(prompt.data.setup_prompt).toContain(`origin='${fixture.origin}'`);
      expect(await page.getByLabel('Complete setup prompt').inputValue()).toBe(prompt.data.setup_prompt);
      expect(prompt.data.worker_package).toEqual(fixture.installer);
      receipt.prompts.push({ slot, ...prompt.data });
      receipt.secrets.push(prompt.data.setup_prompt.match(/muse_enroll_[A-Za-z0-9_-]{43}/)[0]); save();
      passed('portal.enrollment.' + slot, { request_id: prompt.request_id, enrollment_id: prompt.data.enrollment_id });
    }
  } else {
    for (const worker of fixture.workers) {
      const row = page.locator('tbody tr').filter({ hasText: worker.worker_id });
      await row.getByRole('button').click();
      if (fixture.phase === 'revoke') {
        await page.getByRole('button', { name: 'Revoke worker', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Revoke this worker?' });
        await expect(dialog).toContainText(worker.worker_id);
        const result = await action(page, `/api/v1/admin/workers/${worker.worker_id}/revoke`, () => dialog.getByRole('button', { name: 'Confirm revocation' }).click());
        expect(result.data.id).toBe(worker.worker_id); expect(!!result.data.revoked_at).toBe(true);
        await expect(row).toHaveCount(0);
        await expect(page.locator('.worker-drawer')).not.toBeVisible();
        passed('portal.revoke.' + worker.slot, { request_id: result.request_id, worker_id: worker.worker_id });
      } else {
        const name = `Qualification ${worker.slot} 名称`;
        await page.getByLabel('Display name', { exact: true }).fill(name);
        const result = await action(page, `/api/v1/admin/workers/${worker.worker_id}`, () => page.getByRole('button', { name: 'Save name', exact: true }).click());
        expect(result.data.id).toBe(worker.worker_id); expect(result.data.name).toBe(name);
        await expect(page.getByRole('heading', { name, exact: true })).toBeVisible();
        passed('portal.rename.' + worker.slot, { request_id: result.request_id, worker_id: worker.worker_id, name });
      }
      if (fixture.phase !== 'revoke') await page.getByRole('button', { name: 'Close worker settings', exact: true }).click();
    }
    if (fixture.phase === 'inspect') {
      await page.getByRole('link', { name: 'Requests', exact: true }).click();
      for (const id of fixture.request_ids) {
        const back = page.getByRole('button', { name: 'All requests', exact: true });
        if (await back.count()) await back.click();
        await page.getByLabel('Exact request ID').fill(id);
        const pending = page.waitForResponse(response => new URL(response.url()).pathname === '/api/v1/admin/requests/' + id);
        await page.getByRole('button', { name: 'Open request', exact: true }).click();
        expect((await pending).status()).toBe(200);
        await expect(page.getByRole('region', { name: 'Request detail' })).toContainText(id);
        await expect(page.getByRole('heading', { name: 'Conversation timeline', exact: true })).toBeVisible();
      }
      passed('portal.history', { request_ids: fixture.request_ids });
    }
  }
  const storage = await page.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]);
  expect(storage).toEqual([[], []]); expect((await context.cookies()).length).toBe(1); expect(await page.evaluate(() => document.cookie)).toBe('');
  receipt.outcome = 'passed'; save();
} catch (error) {
  receipt.cause = 'product_browser_failed'; save();
  let detail = String(error.stack ?? error);
  for (const secret of [password, ...receipt.secrets]) if (secret) detail = detail.split(secret).join('[REDACTED]');
  writeFileSync(join(fixture.directory, `product-browser-${fixture.phase}-failure.txt`), detail, { mode: 0o600 });
  process.exitCode = 1;
} finally { await browser?.close(); }
