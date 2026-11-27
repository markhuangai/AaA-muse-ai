import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { aggregatePortal, main } from './portal-ci.mjs';
import { inspectSource } from './source-inventory.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = { sha: 'a'.repeat(40), dirty: false, tree_sha256: 'b'.repeat(64) };
const widths = [1440, 768, 390];
const cases = {
  shell: [
    'runtime.identity', 'runtime.rootfs', 'portal.log_only_asset_diagnosis', 'portal.credential_and_configuration_boundaries',
    'portal.log_only_database_diagnosis', 'portal.process_local_sessions', 'portal.cookie_authority_shared_and_revocable',
    'portal.cookie_log_only_store_failure', 'portal.password_rotation_invalidates_browser_grants', 'portal.log_only_browser_diagnosis',
    'portal.log_only_auth_diagnosis', 'portal.capture_protection', 'portal.log_only_config_write_failure', 'portal.shared_client_keys',
    'portal.browser_viewport', 'portal.reload_and_new_tab_restore_session', 'portal.logout_invalidates_server_session_and_other_tabs',
    'portal.unconfirmed_logout_can_be_retried', 'portal.late_response_is_fenced_after_logout',
    'portal.remembered_session_survives_broker_restart', 'portal.chromium_profile_relaunch',
    'portal.browser_session_check_retries_real_sqlite_outage', 'portal.no_browser_logout_timer',
    'portal.browser_request_deadline', 'portal.browser_client_keys_and_origins', 'portal.http_setup_explanation',
  ],
  workers: [
    'runtime.identity', 'portal.workers_controlled_activity', 'portal.worker_server_expiry', 'portal.worker_role_and_shell_boundaries',
    'portal.worker_log_only_diagnosis', 'portal.worker_capture_protection', 'portal.worker_remote_task', 'portal.workers_empty',
    'portal.worker_drawer_dismissal', 'portal.workers_actions', 'portal.worker_offline_timer',
    'portal.worker_ordering_and_uncertainty', 'portal.revocation_response_loss_and_stale_poll',
    'portal.worker_revoked_from_another_browser_closes_both_dialogs', 'portal.worker_outage_recovery_and_denial',
    'portal.worker_browser_enrollment_expiry', 'portal.worker_late_response_after_logout', 'portal.worker_request_deadline',
  ],
  history: [
    'runtime.identity', 'portal.history_media_projections', 'portal.history_native_tool_linkage', 'portal.history_json_payload_fidelity',
    'portal.history_equal_timestamp_database_pages', 'portal.history_recorded_replacement_boundaries',
    'portal.history_cancellation_authority', 'portal.history_log_only_diagnosis', 'portal.history_browser_log_only_diagnosis',
    'portal.history_capture_protection', 'portal.history_empty', 'portal.history_media_job_progress',
    'portal.history_nul_native_and_legacy', 'portal.history_text_tools_instructions_and_cancellation',
    'portal.history_reassignment_and_interrupted_boundaries', 'portal.history_pagination_failure_recovery',
    'portal.history_pagination_and_concurrent_arrivals', 'portal.history_selection_cancellation_and_scroll_ordering',
    'portal.history_cancellation_completion_race_and_response_loss', 'portal.history_actual_timeline_render_failure',
    'portal.history_outage_malformed_timeout_stale_and_session_continuity', 'portal.history_invalid_session_and_late_logout',
  ],
};
const viewportCases = {
  shell: ['portal.browser_viewport'],
  workers: ['portal.worker_remote_task', 'portal.workers_empty', 'portal.worker_drawer_dismissal', 'portal.workers_actions',
    'portal.worker_offline_timer', 'portal.worker_ordering_and_uncertainty', 'portal.revocation_response_loss_and_stale_poll'],
  history: ['portal.history_empty', 'portal.history_nul_native_and_legacy', 'portal.history_text_tools_instructions_and_cancellation'],
};
const names = { shell: 'receipt.json', workers: 'workers-receipt.json', history: 'history-receipt.json' };
const suites = { shell: 'portal', workers: 'portal-workers', history: 'portal-history' };
const images = { shell: 'login-1440.png', workers: 'workers-empty-390.png', history: 'history-detail-768.png' };
const png = Buffer.from('89504e470d0a1a0a', 'hex');

function fixture(t, identity = source) {
  const home = mkdtempSync(join(tmpdir(), 'portal-ci-test-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  const directory = join(home, 'downloads');
  const env = { SOURCE_SHA: identity.sha, GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '1', PORTAL_CASES_RESULT: 'success' };
  const path = (shard, attempt = 1) => join(directory, `portal-shard-${identity.sha}-${shard}-${attempt}`);
  const receipt = (shard, attempt = 1) => ({
    suite: suites[shard], outcome: 'passed', source_sha: identity.sha, source_dirty: String(identity.dirty),
    working_source: structuredClone(identity), run_id: env.GITHUB_RUN_ID, run_attempt: String(attempt),
    cases: cases[shard].flatMap(name => viewportCases[shard].includes(name)
      ? widths.map(width => ({ case: name, outcome: 'passed', width })) : [{ case: name, outcome: 'passed' }]),
    cleanup: { owner: 'fixture', removed: {}, failures: [] }, ...(shard === 'history' ? { peer_cleanup_failures: [] } : {}),
  });
  const writeReceipt = (shard, value, attempt = 1) => writeFileSync(join(path(shard, attempt), names[shard]), JSON.stringify(value));
  const writeShard = (shard, attempt = 1, value = receipt(shard, attempt)) => {
    mkdirSync(join(path(shard, attempt), 'screens'), { recursive: true });
    writeReceipt(shard, value, attempt);
    writeFileSync(join(path(shard, attempt), 'screens', images[shard]), png);
    return value;
  };
  let sequence = 0;
  const run = (options = {}) => {
    const destination = options.destination ?? join(home, `merged-${++sequence}`);
    const result = aggregatePortal({ directory, destination, source: identity, env, ...options });
    return { ...result, destination };
  };
  for (const shard of Object.keys(cases)) writeShard(shard);
  return { home, directory, env, identity, path, receipt, writeReceipt, writeShard, run };
}

function rejected(result, cause, shard) {
  assert(result.problems.some(problem => problem.cause === cause && (shard === undefined || problem.shard === shard)), JSON.stringify(result.problems));
  assert.equal(existsSync(result.destination), false);
}

test('stages only the three source-bound receipts and allowlisted screenshot bytes', t => {
  const f = fixture(t), result = f.run();
  assert.deepEqual(result.problems, []);
  assert.deepEqual(result.attempts, { shell: 1, workers: 1, history: 1 });
  assert.deepEqual(readdirSync(result.destination).sort(), ['history-receipt.json', 'receipt.json', 'screens', 'workers-receipt.json']);
  assert.deepEqual(readdirSync(join(result.destination, 'screens')).sort(), Object.values(images).sort());
  for (const shard of Object.keys(cases)) {
    assert.deepEqual(readFileSync(join(result.destination, names[shard])), readFileSync(join(f.path(shard), names[shard])));
    assert.deepEqual(readFileSync(join(result.destination, 'screens', images[shard])), png);
  }
});

test('accepts an exactly matching dirty working-source identity', t => {
  const identity = { ...source, dirty: true }, f = fixture(t, identity);
  assert.deepEqual(f.run().problems, []);
  const receipt = f.receipt('shell'); receipt.source_dirty = 'false'; f.writeReceipt('shell', receipt);
  rejected(f.run(), 'source_mismatch', 'shell');
});

test('selects the newest per-shard attempt without falling back to an older pass', t => {
  const f = fixture(t);
  f.env.GITHUB_RUN_ATTEMPT = '2';
  const old = f.receipt('shell'); old.outcome = 'failed'; f.writeReceipt('shell', old);
  f.writeShard('shell', 2); f.writeShard('workers', 2);
  const mixed = f.run();
  assert.deepEqual(mixed.problems, []);
  assert.deepEqual(mixed.attempts, { shell: 2, workers: 2, history: 1 });
  assert.equal(JSON.parse(readFileSync(join(mixed.destination, 'receipt.json'))).run_attempt, '2');
  const failed = f.receipt('workers', 2); failed.outcome = 'failed'; f.writeReceipt('workers', failed, 2);
  rejected(f.run(), 'shard_failed', 'workers');
});

test('rejects unsafe files even in an older, superseded artifact', t => {
  const f = fixture(t);
  f.env.GITHUB_RUN_ATTEMPT = '2'; f.writeShard('shell', 2);
  const oldScreenshot = join(f.path('shell'), 'screens', images.shell);
  rmSync(oldScreenshot); symlinkSync(join(f.path('shell', 2), 'screens', images.shell), oldScreenshot);
  rejected(f.run(), 'unsafe_path', 'shell');
  rmSync(oldScreenshot); writeFileSync(oldScreenshot, png);
  writeFileSync(join(f.path('shell'), 'unexpected.log'), 'private');
  rejected(f.run(), 'unexpected_file', 'shell');
});

test('rejects missing downloads, absent shards, malformed artifact names and out-of-bound attempts', t => {
  const f = fixture(t);
  rejected(f.run({ directory: join(f.home, 'missing') }), 'missing_shard');
  rmSync(f.path('history'), { recursive: true });
  rejected(f.run(), 'missing_shard', 'history');
  f.writeShard('history');
  for (const suffix of ['0', '01', '1\n', '2', '9007199254740992', 'not-an-attempt']) {
    const bad = f.path('shell', suffix);
    renameSync(f.path('shell'), bad);
    rejected(f.run(), 'invalid_shard_attempt', 'shell');
    renameSync(bad, f.path('shell'));
  }
  mkdirSync(join(f.directory, 'portal-shard-unexpected-secret'));
  rejected(f.run(), 'unexpected_artifact');
});

test('rejects source, suite, outcome, run and attempt mismatches independently', t => {
  const f = fixture(t);
  const changes = [
    [value => { value.suite = 'portal'; }, 'shard_failed'],
    [value => { value.outcome = 'failed'; }, 'shard_failed'],
    [value => { value.working_source.sha = 'c'.repeat(40); }, 'source_mismatch'],
    [value => { value.working_source.dirty = true; }, 'source_mismatch'],
    [value => { value.working_source.tree_sha256 = 'c'.repeat(64); }, 'source_mismatch'],
    [value => { value.working_source.extra = true; }, 'source_mismatch'],
    [value => { value.source_sha = 'c'.repeat(40); }, 'source_mismatch'],
    [value => { value.source_dirty = 'true'; }, 'source_mismatch'],
    [value => { value.run_id = '54321'; }, 'run_identity_mismatch'],
    [value => { value.run_attempt = '2'; }, 'run_identity_mismatch'],
    [value => { value.run_attempt = '01'; }, 'run_identity_mismatch'],
    [value => { value.run_attempt = 1; }, 'run_identity_mismatch'],
  ];
  for (const [change, cause] of changes) {
    const receipt = f.receipt('workers'); change(receipt); f.writeReceipt('workers', receipt);
    rejected(f.run(), cause, 'workers');
  }
  writeFileSync(join(f.path('workers'), names.workers), '{');
  rejected(f.run(), 'invalid_receipt', 'workers');
  writeFileSync(join(f.path('workers'), names.workers), 'null');
  rejected(f.run(), 'shard_failed', 'workers');
});

test('rejects every failed or malformed case, including unrequired extra cases', t => {
  const f = fixture(t);
  for (const item of [null, [], {}, { case: 'extra', outcome: 'failed' }, { case: 'extra' }, { case: '', outcome: 'passed' }]) {
    const receipt = f.receipt('history'); receipt.cases.push(item); f.writeReceipt('history', receipt);
    rejected(f.run(), 'case_failed', 'history');
  }
  for (const value of [null, [], {}]) {
    const receipt = f.receipt('history'); receipt.cases = value; f.writeReceipt('history', receipt);
    rejected(f.run(), 'case_failed', 'history');
  }
  const receipt = f.receipt('history'); receipt.cases.push({ case: 'additional.passing.case', outcome: 'passed' });
  f.writeReceipt('history', receipt);
  assert.deepEqual(f.run().problems, []);
});

test('requires every documented case and each recorded viewport in each shard', t => {
  const f = fixture(t);
  for (const shard of Object.keys(cases)) {
    for (const name of cases[shard]) {
      const receipt = f.receipt(shard); receipt.cases = receipt.cases.filter(item => item.case !== name); f.writeReceipt(shard, receipt);
      rejected(f.run(), 'required_case_missing', shard);
    }
    for (const name of viewportCases[shard]) {
      const receipt = f.receipt(shard); receipt.cases = receipt.cases.filter(item => item.case !== name || item.width !== 768); f.writeReceipt(shard, receipt);
      rejected(f.run(), 'required_viewport_missing', shard);
    }
    f.writeReceipt(shard, f.receipt(shard));
  }
});

test('requires clean resource and history peer cleanup, including optional peer evidence', t => {
  const f = fixture(t);
  for (const shard of Object.keys(cases)) {
    for (const failures of [undefined, null, {}, ['leftover']]) {
      const receipt = f.receipt(shard); receipt.cleanup.failures = failures; f.writeReceipt(shard, receipt);
      rejected(f.run(), 'cleanup_failed', shard);
    }
    f.writeReceipt(shard, f.receipt(shard));
  }
  for (const failures of [undefined, null, {}, ['peer']]) {
    const receipt = f.receipt('history'); receipt.peer_cleanup_failures = failures; f.writeReceipt('history', receipt);
    rejected(f.run(), 'peer_cleanup_failed', 'history');
  }
  f.writeReceipt('history', f.receipt('history'));
  const worker = f.receipt('workers'); worker.peer_cleanup_failures = ['peer']; f.writeReceipt('workers', worker);
  rejected(f.run(), 'peer_cleanup_failed', 'workers');
});

test('rejects missing, empty, unexpected and wrong-shard screenshots', t => {
  const f = fixture(t), screenshots = join(f.path('shell'), 'screens'), image = join(screenshots, images.shell);
  rmSync(image);
  rejected(f.run(), 'missing_screenshots', 'shell');
  writeFileSync(image, '');
  rejected(f.run(), 'empty_screenshot', 'shell');
  writeFileSync(image, png);
  const unexpected = join(screenshots, images.workers); writeFileSync(unexpected, png);
  rejected(f.run(), 'unexpected_file', 'shell');
  rmSync(unexpected);
  const newline = join(screenshots, images.shell + '\n'); writeFileSync(newline, png);
  rejected(f.run(), 'unexpected_file', 'shell');
  rmSync(newline); rmSync(screenshots, { recursive: true });
  rejected(f.run(), 'missing_screenshots', 'shell');
  mkdirSync(screenshots); mkdirSync(image);
  rejected(f.run(), 'unsafe_path', 'shell');
});

test('accepts every screenshot name allowed by the three harnesses', t => {
  const f = fixture(t);
  const variants = {
    shell: ['login', 'login-dark', 'settings', 'settings-dark', 'error', 'client-keys'],
    workers: ['workers-empty', 'workers-list', 'workers-detail', 'workers-detail-dark', 'workers-revoke', 'workers-error', 'workers-remote'],
    history: ['history-empty', 'history-list', 'history-detail', 'history-cancel', 'history-error'],
  };
  for (const [shard, prefixes] of Object.entries(variants)) {
    for (const prefix of prefixes) for (const width of widths) writeFileSync(join(f.path(shard), 'screens', `${prefix}-${width}.png`), png);
  }
  const result = f.run();
  assert.deepEqual(result.problems, []);
  assert.equal(readdirSync(join(result.destination, 'screens')).length, 54);
});

test('rejects missing receipts, extra artifact contents, symlinks and non-directory artifacts', t => {
  const f = fixture(t), receipt = join(f.path('workers'), names.workers), image = join(f.path('workers'), 'screens', images.workers);
  rmSync(receipt);
  rejected(f.run(), 'missing_receipt', 'workers');
  symlinkSync(join(f.path('shell'), names.shell), receipt);
  rejected(f.run(), 'unsafe_path', 'workers');
  rmSync(receipt); f.writeReceipt('workers', f.receipt('workers'));
  rmSync(image); symlinkSync(join(f.path('shell'), 'screens', images.shell), image);
  rejected(f.run(), 'unsafe_path', 'workers');
  rmSync(image); writeFileSync(image, png);
  writeFileSync(join(f.path('workers'), 'private.log'), 'secret');
  rejected(f.run(), 'unexpected_file', 'workers');
  rmSync(join(f.path('workers'), 'private.log'));
  rmSync(join(f.path('workers'), 'screens'), { recursive: true });
  symlinkSync(join(f.path('shell'), 'screens'), join(f.path('workers'), 'screens'));
  rejected(f.run(), 'unsafe_path', 'workers');
  rmSync(f.path('history'), { recursive: true });
  symlinkSync(f.path('shell'), f.path('history'));
  rejected(f.run(), 'unsafe_path');
  rmSync(f.path('history')); writeFileSync(f.path('history'), 'not a directory');
  rejected(f.run(), 'unsafe_path');
});

test('never stages failed job results, overlapping paths, dirty destinations or symlinked paths', t => {
  const f = fixture(t);
  f.env.PORTAL_CASES_RESULT = 'failure';
  rejected(f.run(), 'portal_cases_not_successful');
  rmSync(f.path('history'), { recursive: true });
  const multiple = f.run();
  rejected(multiple, 'portal_cases_not_successful');
  assert(multiple.problems.some(item => item.cause === 'missing_shard' && item.shard === 'history'));
  f.writeShard('history'); f.env.PORTAL_CASES_RESULT = 'success';
  const nested = f.run({ destination: join(f.directory, 'output') });
  assert(nested.problems.some(item => item.cause === 'overlapping_paths'));
  assert.equal(existsSync(nested.destination), false);
  const parent = f.run({ destination: f.home });
  assert(parent.problems.some(item => item.cause === 'overlapping_paths'));
  const occupied = join(f.home, 'occupied'); mkdirSync(occupied); writeFileSync(join(occupied, 'keep'), 'untouched');
  const existing = f.run({ destination: occupied });
  assert(existing.problems.some(item => item.cause === 'destination_not_empty'));
  assert.equal(readFileSync(join(occupied, 'keep'), 'utf8'), 'untouched');
  const link = join(f.home, 'link'); symlinkSync(occupied, link);
  const unsafe = f.run({ destination: join(link, 'output') });
  assert(unsafe.problems.some(item => item.cause === 'unsafe_path'));
  const downloadLink = join(f.home, 'download-link'); symlinkSync(f.directory, downloadLink);
  rejected(f.run({ directory: downloadLink }), 'unsafe_path');
  const invalid = f.run({ destination: join(f.home, 'x'.repeat(300)) });
  assert(invalid.problems.some(item => item.cause === 'filesystem_error'));
  const empty = join(f.home, 'empty'); mkdirSync(empty);
  assert.deepEqual(f.run({ destination: empty }).problems, []);
});

test('rejects invalid source or run settings and emits bounded structured diagnostics', t => {
  const f = fixture(t), events = [];
  const logger = (core, level, event, fields) => events.push({ level, event, ...fields });
  const invoke = (options = {}) => main([f.directory, join(f.home, 'output')], { source: () => f.identity, env: f.env, logger, ...options });
  f.env.PORTAL_CASES_RESULT = 'failure';
  assert.equal(invoke(), 1);
  assert.deepEqual(events.shift(), {
    level: 'error', event: 'ci.portal_rejected', cause: 'portal_cases_not_successful', shard: null,
    expected_source: source, observed_source: null, run_id: '12345', expected_attempt_bound: 1,
    observed_attempt: null, portal_cases_result: 'failure', unsafe_path: null,
  });
  f.env.PORTAL_CASES_RESULT = 'private-job-result';
  assert.equal(invoke(), 1); assert.equal(events.shift().portal_cases_result, '[REDACTED]');
  f.env.PORTAL_CASES_RESULT = 'success';
  f.env.SOURCE_SHA = 'c'.repeat(40); assert.equal(invoke(), 1); assert.equal(events.shift().cause, 'source_mismatch');
  f.env.SOURCE_SHA = source.sha;
  for (const attempt of ['0', '01', '1\n', '-1', '9007199254740992', 'secret-attempt']) {
    f.env.GITHUB_RUN_ATTEMPT = attempt; assert.equal(invoke(), 1); assert.equal(events.shift().cause, 'invalid_run_identity');
  }
  f.env.GITHUB_RUN_ATTEMPT = '1'; f.env.GITHUB_RUN_ID = 'secret-run-id';
  assert.equal(invoke(), 1); const invalid = events.shift(); assert.equal(invalid.cause, 'invalid_run_identity'); assert.equal(invalid.run_id, null);
  f.env.GITHUB_RUN_ID = '12345\n'; assert.equal(invoke(), 1); assert.equal(events.shift().cause, 'invalid_run_identity');
  f.env.GITHUB_RUN_ID = '12345';
  assert.equal(invoke({ source: () => ({ ...source, dirty: 'false' }) }), 1); assert.equal(events.shift().cause, 'invalid_source_identity');
  assert.equal(invoke({ source: () => ({ ...source, sha: source.sha + '\n' }) }), 1); assert.equal(events.shift().cause, 'invalid_source_identity');
  assert.equal(invoke({ source: () => { throw new Error('secret-source-error'); } }), 1); assert.equal(events.shift().cause, 'filesystem_error');
  assert.equal(main([], { logger, env: f.env }), 1); assert.equal(events.shift().cause, 'expected_input_and_output');
  assert.equal(invoke(), 0); assert.equal(events.shift().event, 'ci.portal_verified');
});

test('redacts secret-shaped observed source fields from structured diagnostics', t => {
  const f = fixture(t), events = [], secret = 'd'.repeat(40);
  f.env.SERVICE_TOKEN = secret;
  const receipt = f.receipt('history'); receipt.working_source.sha = secret; f.writeReceipt('history', receipt);
  const logger = (core, level, event, fields) => events.push({ level, event, ...fields });
  assert.equal(main([f.directory, join(f.home, 'output')], { source: () => f.identity, env: f.env, logger }), 1);
  assert.equal(events[0].cause, 'source_mismatch');
  assert.equal(events[0].observed_source.sha, '[REDACTED]');
  assert(!JSON.stringify(events).includes(secret));
});

test('real CLI emits redacted JSON and stages mixed artifacts using the actual source inventory', t => {
  const identity = inspectSource().identity, f = fixture(t, identity), destination = join(f.home, 'cli-output');
  const env = { ...process.env, ...f.env, TEST_PASSWORD: 'private-canary-value' };
  const command = [join(root, 'tools/portal-ci.mjs'), f.directory, destination];
  const successful = spawnSync(process.execPath, command, { cwd: root, env, encoding: 'utf8' });
  assert.equal(successful.status, 0, successful.stderr);
  const passed = JSON.parse(successful.stdout.trim());
  assert.equal(passed.level, 'INFO'); assert.equal(passed.event, 'ci.portal_verified');
  const secret = join(f.path('history'), 'screens', 'private-canary-value.png');
  writeFileSync(secret, png);
  const failed = spawnSync(process.execPath, [command[0], f.directory, join(f.home, 'cli-failed')], { cwd: root, env, encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert(!`${failed.stdout}${failed.stderr}`.includes('private-canary-value'));
  const diagnosis = JSON.parse(failed.stdout.trim().replace(/^::error::/, ''));
  assert.equal(diagnosis.event, 'ci.portal_rejected'); assert.equal(diagnosis.cause, 'unexpected_file');
  assert.equal(diagnosis.shard, 'history'); assert.equal(diagnosis.unsafe_path, '[REDACTED]');
});

test('imports and reports a missing shard without worker build or installed dependencies', t => {
  const f = fixture(t), isolated = join(f.home, 'isolated');
  for (const name of ['tools/portal-ci.mjs', 'tools/source-inventory.mjs', '.github/scripts/ci-log.mjs']) {
    mkdirSync(dirname(join(isolated, name)), { recursive: true });
    copyFileSync(join(root, name), join(isolated, name));
  }
  const script = `import { main } from './tools/portal-ci.mjs'; process.exitCode = main(['missing', 'out'], { source: () => (${JSON.stringify(source)}), env: ${JSON.stringify(f.env)} });`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: isolated, encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const diagnosis = JSON.parse(result.stdout.trim().replace(/^::error::/, ''));
  assert.equal(diagnosis.event, 'ci.portal_rejected'); assert.equal(diagnosis.cause, 'missing_shard');
  assert.equal(existsSync(join(isolated, 'worker')), false);
  assert.equal(existsSync(join(isolated, 'node_modules')), false);
});
