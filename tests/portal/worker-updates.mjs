import { chromium, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { checkBrowserSession } from './session.mjs';

const fixture = JSON.parse(readFileSync(process.argv[2], 'utf8'));
const browser = await chromium.launch();
try {
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  page.setDefaultTimeout(8_000);
  await page.goto(fixture.origin + '/workers');
  await page.getByLabel('Portal password').fill(fixture.password);
  const login = page.waitForResponse(response => response.url().endsWith('/api/v1/portal/login') && response.ok());
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await checkBrowserSession(page, await login);

  const verifyWidth = async (name, width) => {
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    expect((await page.locator('body').innerText()).includes(fixture.password)).toBe(false);
    await page.screenshot({ path: join(fixture.directory, name + '-' + width + '.png'), animations: 'disabled' });
  };
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const row = page.getByRole('row').filter({ hasText: fixture.worker });
    await expect(row.getByText(fixture.stage, { exact: true })).toBeVisible();
    await expect(page.getByRole('row').filter({ hasText: fixture.never }).getByText('Version Not reported')).toBeVisible();
    if (fixture.failure) await expect(row.getByText(fixture.failure, { exact: true })).toBeVisible();
    await row.getByRole('button').click();
    const drawer = page.getByRole('dialog');
    await expect(drawer.getByText(fixture.stage, { exact: true })).toBeVisible();
    await expect(drawer.getByRole('button', { name: 'Enable automatic updates' })).toHaveCount(0);
    await expect(drawer.locator('#worker-update-prompt')).toHaveCount(0);
    if (fixture.failure) await expect(drawer.getByText(fixture.failure, { exact: true })).toBeVisible();
    await verifyWidth(fixture.failure ? 'worker-update-failed' : 'worker-updating', width);
    await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  }

  if (!fixture.failure) for (const [index, entry] of fixture.interruptions.entries()) {
    await page.goto(fixture.origin + '/requests');
    await expect(page.getByRole('row').filter({ hasText: entry.task }).getByText(entry.reason)).toBeVisible();
    await page.getByLabel('Exact request ID').fill(entry.task);
    await page.getByRole('button', { name: 'Open request', exact: true }).click();
    for (const width of [1440, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.getByRole('region', { name: 'Request detail' }).getByText(entry.reason, { exact: true })).toBeVisible();
      await verifyWidth('interrupted-request-' + index, width);
    }
  }
} finally {
  await browser.close();
}
