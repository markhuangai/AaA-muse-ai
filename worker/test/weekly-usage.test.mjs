import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { parseWeeklyUsage, readWeeklyUsage, weeklyUsageHeaders } from '../dist/weekly-usage.js';

test('only the explicit account-wide weekly line determines usage', () => {
  const free = 'The user does not have a subscription.\r\nUsage: 33% of free weekly limit.\r\nWeekly limit resets Nov 29 at 7:49 AM EST';
  assert.deepEqual(parseWeeklyUsage(free), { used_percent: 33, reset_label: 'Nov 29 at 7:49 AM EST' });
  assert.deepEqual(parseWeeklyUsage('Usage: 12.25% of weekly limit.\nAdditional tokens: 99% used (12M tokens left)'),
    { used_percent: 12.25 });
  assert.deepEqual(parseWeeklyUsage('Usage: 100.0% of free weekly limit.'), { used_percent: 100 });
  assert.deepEqual(parseWeeklyUsage('Usage: 0% of weekly limit.\nWeekly limit resets private provider output'),
    { used_percent: 0 });
  assert.deepEqual(parseWeeklyUsage('Usage: 99.9999% of weekly limit.'), { used_percent: 99.9999 });
  for (const input of ['Usage: 33% of this chat context window.', 'Additional tokens: 99% used',
    'Usage: 100.0000000000001% of weekly limit.', 'Usage: -1% of weekly limit.',
    'Usage: 1% of free weekly limit.\nUsage: 9% of free weekly limit.']) {
    assert.equal(parseWeeklyUsage(input), undefined);
  }
  const header = weeklyUsageHeaders({ used_percent: 33, observed_at: '2026-11-23T00:00:00Z' })['X-Muse-Worker-Weekly-Usage'];
  assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url')), { used_percent: 33, observed_at: '2026-11-23T00:00:00Z' });
  assert.deepEqual(weeklyUsageHeaders(), {});
});

test('fixed status subprocess enforces time and output bounds and reports only safe causes', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'muse-weekly-usage-'));
  const command = join(dir, 'subscription-status');
  const prior = process.env.PATH;
  process.env.PATH = dir;
  t.after(async () => {
    if (prior === undefined) delete process.env.PATH;
    else process.env.PATH = prior;
    await rm(dir, { recursive: true, force: true });
  });
  const script = async (content, mode = 0o700) => {
    await writeFile(command, '#!/bin/sh\n' + content);
    await chmod(command, mode);
  };
  assert.deepEqual(await readWeeklyUsage(), { reason: 'subscription_status_missing' });
  await script('test "$#" = 1 && test "$1" = status && echo "Usage: 33% of free weekly limit."');
  assert.deepEqual(await readWeeklyUsage(), { reading: { used_percent: 33 } });
  await script('echo "provider-private" >&2; exit 2');
  assert.deepEqual(await readWeeklyUsage(), { reason: 'subscription_status_failed' });
  await script('echo "Usage unavailable"');
  assert.deepEqual(await readWeeklyUsage(), { reason: 'unrecognized_weekly_usage' });
  await script('echo "Usage: 0% of free weekly limit."', 0o600);
  assert.deepEqual(await readWeeklyUsage(), { reason: 'subscription_status_denied' });
  await script('/usr/bin/head -c 9000 /dev/zero');
  assert.deepEqual(await readWeeklyUsage(), { reason: 'subscription_status_output_limit' });
  await script("trap '' TERM; exec /bin/sleep 20");
  const started = Date.now();
  assert.deepEqual(await readWeeklyUsage(), { reason: 'subscription_status_timeout' });
  assert.ok(Date.now() - started < 5000);
});
