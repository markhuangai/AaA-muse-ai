import test from 'node:test';
import assert from 'node:assert/strict';
import { loadReleaseAccess, runProductBrowser, ReleaseCollector } from './product-collector.mjs';
import { releaseHarness } from './test/release-harness.mjs';
import { liveCases } from './product-report.mjs';
import { Redactor } from '../worker/dist/diagnostics.js';
import { stamp } from './test/product-fixture.mjs';
import { decodeExport, privateRead } from './qualification-evidence.mjs';
import { exportFixture } from './qualification-fixtures.mjs';

test('private access accepts paths, separates credential roles, and never adds a worker key', async () => {
  const value = { schema_version: 1, workers: [{ slot: 'a', account_ref: 'account-a' }, { slot: 'b', account_ref: 'account-b' }], clients: { a: { header_file: '/private/a' }, b: { header_file: '/private/b' } }, portal_password_file: '/private/password' };
  const files = new Map([['/private/access', JSON.stringify(value)], ['/private/a', 'Authorization: Bearer client-a\n'], ['/private/b', 'Authorization: Bearer client-b'], ['/private/password', 'private-password\n']]);
  const redactor = new Redactor(), read = async path => { if (!files.has(path)) throw new Error('private_file_unsafe'); return files.get(path); };
  const access = await loadReleaseAccess('/private/access', redactor, read);
  assert.equal(access.keys.a, 'Bearer client-a'); assert.ok(!JSON.stringify(access).includes('private-password'));
  assert.ok(!redactor.text('client-a client-b private-password').includes('private-password'));
  files.set('/private/b', files.get('/private/a')); await assert.rejects(loadReleaseAccess('/private/access', redactor, read), /distinct_client_keys_required/);
  files.set('/private/b', 'malformed'); await assert.rejects(loadReleaseAccess('/private/access', redactor, read), /invalid_client_header_file/);
  files.set('/private/b', 'Authorization: Bearer client-b'); files.set('/private/password', 'client-a'); await assert.rejects(loadReleaseAccess('/private/access', redactor, read), /distinct_portal_password_required/);
  value.workers[1].account_ref = 'account-a'; files.set('/private/access', JSON.stringify(value)); await assert.rejects(loadReleaseAccess('/private/access', redactor, read), /isolated_account_references_required/);
  value.workers.pop(); files.set('/private/access', JSON.stringify(value)); await assert.rejects(loadReleaseAccess('/private/access', redactor, read), /two_release_workers_required/);
});

test('release initialization requires the verified paired image and retains interventions across restarts', async t => {
  const h = await releaseHarness(t); await h.collector.initialize();
  assert.equal(h.collector.report.schema_version, 2); assert.equal(h.collector.worker('a').installed_version, h.status.build.version);
  const entry = { kind: 'intervention', time: stamp(1), observer: 'owner', source_ref: 'manual-message' };
  h.collector.report.observations.push(entry); await h.collector.save(); await h.collector.initialize();
  assert.ok(h.collector.report.observations.some(value => value.source_ref === entry.source_ref));
  const old = h.collector.report.workers[0].installed_version; h.collector.report.workers[0].installed_version = '0.0.1'; await h.collector.save();
  await assert.rejects(h.collector.initialize(), /release_worker_identity_conflict/); h.collector.report.workers[0].installed_version = old; await h.collector.save();
  h.collector.report.source.service_sha = 'c'.repeat(40); await h.collector.save(); await assert.rejects(h.collector.initialize(), /release_run_identity_conflict/);
  h.status.build.dirty = true; await assert.rejects(h.collector.initialize(), /verified_paired_service_required/); h.status.build.dirty = false;
  h.entries.find(entry => entry.kind === 'artifact_identity').installer_sha256 = ''; await h.write(); await assert.rejects(h.collector.initialize(), /verified_image_and_installer_required/);
  assert.throws(() => h.collector.worker('missing'), /worker_setup_required/);
  assert.throws(() => new ReleaseCollector({ ...h.evidence, origin: 'https://broker.test', header: 'Authorization: Bearer management-private', access: { ...h.access, keys: { ...h.access.keys, a: 'Bearer management-private' } } }), /distinct_management_key_required/);
});

test('resume fills unknown installation metadata once and preserves established identity', async t => {
  const h = await releaseHarness(t);
  const index = h.entries.findIndex(entry => entry.kind === 'setup_ended' && entry.worker_id === 'worker-a');
  const [setup] = h.entries.splice(index, 1); await h.write(); await h.collector.initialize();
  assert.equal(h.collector.worker('a').installed_version, null);
  assert.equal(h.collector.worker('a').installed_sha256, null);
  h.entries.push({ ...setup, worker_sha256: undefined }); await h.write(); await h.collector.initialize();
  assert.equal(h.collector.worker('a').installed_version, setup.worker_version);
  assert.equal(h.collector.worker('a').installed_sha256, null);
  h.entries.at(-1).worker_sha256 = setup.worker_sha256; await h.write(); await h.collector.initialize();
  assert.equal(h.collector.worker('a').installed_sha256, setup.worker_sha256);
  const verified = { ...h.collector.worker('a') };
  for (const change of [{ worker_id: 'foreign' }, { account_ref: 'foreign' }, { installed_version: 'different' }, { installed_sha256: 'e'.repeat(64) }]) {
    h.collector.report.workers[0] = { ...verified, ...change }; await h.collector.save();
    await assert.rejects(h.collector.initialize(), /release_worker_identity_conflict/);
    h.collector.report.workers[0] = { ...verified }; await h.collector.save();
  }
  h.collector.report.workers[0] = { ...verified, worker_id: null, installed_version: null, installed_sha256: null }; await h.collector.save();
  h.access.workers[0].account_ref = 'foreign-owner';
  await assert.rejects(h.collector.initialize(), /release_worker_identity_conflict/);
});

test('release exports cover the entire run through contiguous bounded intervals', async t => {
  const h = await releaseHarness(t); await h.collector.initialize();
  const started = Date.parse(h.collector.report.started_at), snapshot = started + 601000;
  h.collector.now = () => snapshot;
  const events = [0, 300000, 600000, 601000].map((offset, index) => ({ time: new Date(started + offset).toISOString(), level: 'INFO', msg: 'boundary.observed', operation_id: 'operation-' + index }));
  const fetcher = h.collector.fetcher, intervals = [];
  h.collector.fetcher = async (url, options) => {
    const parsed = new URL(url);
    if (parsed.pathname !== '/api/v1/admin/diagnostics/export') return fetcher(url, options);
    const since = Date.parse(parsed.searchParams.get('since')), until = Date.parse(parsed.searchParams.get('until'));
    intervals.push([since, until]);
    return new Response(exportFixture(events.filter(event => Date.parse(event.time) >= since && Date.parse(event.time) <= until)));
  };
  await h.collector.finalize();
  assert.deepEqual(intervals, [[started, started + 300000], [started + 300000, started + 600000], [started + 600000, snapshot]]);
  const retained = [];
  for (const ref of h.collector.report.exports) retained.push(...decodeExport(await privateRead(h.collector.state.path(ref.file))).events);
  assert.deepEqual([...new Set(retained.map(event => event.operation_id))], events.map(event => event.operation_id));
  assert.deepEqual(h.collector.report.evidence_import_failures, []);
  h.collector.report.started_at = 'invalid';
  await h.collector.finalize();
  assert.ok(h.collector.report.evidence_import_failures.some(item => item.cause === 'invalid_run_timing'));
});

test('native approval executes the actual evidence verifier before granting routing authority', async t => {
  const h = await releaseHarness(t); await h.collector.initialize();
  await h.collector.native('a', 'baseline');
  assert.equal(h.collector.report.native_cases.length, 2);
  assert.ok(h.requests.some(request => request.body?.action === 'approve' && request.body.evidence_kind === 'live'));
  assert.ok(h.collector.report.cases.some(item => item.id === 'idle.a'));
  const bad = await releaseHarness(t); await bad.collector.initialize(); bad.badNative = true;
  await assert.rejects(bad.collector.native('b', 'baseline'), /independent_live_trial_evidence_required/);
  assert.ok(!bad.requests.some(request => request.body?.action === 'approve'));
  await assert.rejects(bad.collector.select('all'), /current_live_qualification_required/);
});

test('management exchanges retain the addressed worker and leave global requests unscoped', async t => {
  const h = await releaseHarness(t), exchanges = [], log = h.collector.log.bind(h.collector);
  h.collector.log = async (level, msg, fields) => { if (msg === 'qualification.http_exchange') exchanges.push(fields); return log(level, msg, fields); };
  await h.collector.api('/api/v1/admin/status');
  await h.collector.api('/api/v1/admin/workers/worker-b/qualifications', 'POST', {});
  assert.equal(exchanges[0].worker_id, undefined); assert.equal(exchanges[1].worker_id, 'worker-b');
});

test('release baseline links real client HTTP/SSE cycles, affinity, interleaving and role rejection', async t => {
  const h = await releaseHarness(t); await h.collector.initialize(); await h.collector.baseline();
  assert.equal(h.collector.report.cycles.length, 10);
  assert.ok(h.collector.report.cases.some(item => item.id === 'boundary.cross-client'));
  assert.ok(h.requests.every(request => request.path.startsWith('/api/v1/admin/')));
  const cases = h.collector.report.cases.length; await h.collector.baseline(); assert.equal(h.collector.report.cases.length, cases);
  await assert.rejects(h.collector.newCycle('a.chat.json', 'a'), /release_cycle_already_started/);
  await h.collector.browser('inspect'); assert.ok(h.collector.report.cases.some(item => item.id === 'portal.history'));
  const result = await h.collector.finalize(); assert.equal(result.verdict, 'inconclusive');
  assert.ok(h.logs.some(event => event.msg === 'e2e.evidence_incomplete')); assert.ok(h.logs.some(event => event.msg === 'e2e.completed'));
  assert.ok(!JSON.stringify(h.logs).includes('management-private'));
});

test('broker checkpoint requires the owner action and preserves a pending tool across a new process', async t => {
  const h = await releaseHarness(t); await h.collector.initialize();
  let time = Date.now(); h.collector.now = () => ++time; h.collector.driver.now = h.collector.now;
  for (const slot of ['a', 'b']) await h.collector.native(slot, 'baseline');
  await h.collector.broker('broker-prepare');
  assert.equal(h.collector.report.cycles.at(-1).client_tool_executions, 0);
  await assert.rejects(h.collector.broker('broker-prepare'), /broker_checkpoint_already_created/);
  const observation = h.entries.find(entry => entry.case_id === 'recovery.broker-tool-wait');
  Object.assign(observation, { time: h.collector.stamp(), expected_boundary: 'waiting tool', observed_boundary: 'new service process', worker_ids: ['worker-a'], operation_ids: ['native-operation'] });
  h.collector.report.observations = h.entries;
  await assert.rejects(h.collector.broker('broker-resume'), /owner_broker_restart_not_observed/);
  h.instance = 'process-two'; await h.collector.broker('broker-resume');
  assert.equal(h.collector.report.checkpoints.broker.after_instance, 'process-two');
  assert.equal(h.collector.report.cycles.at(-1).client_tool_executions, 1);
  assert.ok(h.collector.report.cases.some(item => item.id === 'recovery.tool-dedup'));
  await assert.rejects(h.collector.broker('broker-resume'), /pending_broker_checkpoint_required/);
});

test('recovery probes require observed identity/scope and boundary imports retain missing evidence', async t => {
  const h = await releaseHarness(t); await h.collector.initialize();
  for (const entry of h.entries.filter(entry => entry.kind === 'product_case')) Object.assign(entry, { operation_ids: ['observed-operation'], capture_complete: true, receipt: {} });
  h.imports.set('/private/product-worker', h.fixture.files.get('worker-product.ndjson'));
  h.source.worker_exports.push({ case_id: 'all', path: '/private/product-worker' }); await h.write();
  h.collector.report.observations = h.entries;
  await h.collector.recovered('worker');
  h.connections.a = { connection_id: 'refresh-connection-worker-a', connection_generation: 3 };
  await h.collector.recovered('refresh'); await h.collector.boundaries(); await h.collector.boundaries();
  assert.ok(h.collector.report.cases.some(item => item.id === 'recovery.refresh'));
  h.collector.report.observations = []; assert.throws(() => h.collector.observation('missing'), /observed_product_case_required/);
  h.collector.report.observations = [{ kind: 'product_case', case_id: 'foreign', time: stamp(0), expected_boundary: 'one', observed_boundary: 'two', worker_ids: ['foreign'], operation_ids: ['operation'] }];
  assert.throws(() => h.collector.observation('foreign'), /observation_worker_mismatch/);
  h.source.worker_exports.push({ case_id: 'all', path: '/missing/export' }); await h.write();
  const result = await h.collector.finalize(); assert.ok(result.missing.some(reason => reason.includes('evidence_import_failed')));
});

test('staged collector catches adverse browser results, forbids early revocation and accounts for completion', async t => {
  const h = await releaseHarness(t); h.browserFailure = true;
  let result = await h.collector.collect('enroll'); assert.equal(result.verdict, 'inconclusive'); assert.ok(h.logs.some(event => event.msg === 'e2e.case_failed'));
  h.browserFailure = false; await h.collector.collect('enroll'); assert.ok(h.collector.report.cases.some(item => item.id === 'portal.enrollment.a'));
  await h.collector.collect('enroll'); await h.collector.collect('revoke');
  assert.ok(!h.collector.report.cases.some(item => item.id === 'portal.revoke.a'));
  for (const id of liveCases.filter(id => !id.startsWith('portal.revoke.'))) await h.collector.record(id);
  await h.collector.collect('revoke'); assert.ok(!h.collector.report.cases.some(item => item.id === 'portal.revoke.a'));
  await h.collector.collect('portal'); await h.collector.collect('finalize');
  await assert.rejects(h.collector.collect('all'), /invalid_release_stage/);
  result = await h.collector.finalize(); assert.equal(result.observed_result, 'inconclusive');
});

test('browser process boundary stores only protected paths and validates its receipt', async t => {
  const h = await releaseHarness(t), state = h.evidence.state;
  const result = await runProductBrowser({ state, phase: 'setup', fixture: { password_file: '/private/password' } }, async (_command, args) => {
    assert.ok(args.includes('--fixture')); await state.write('product-browser-setup-receipt.json', '{"outcome":"passed"}');
  });
  assert.equal(result.outcome, 'passed');
  await assert.rejects(runProductBrowser({ state, phase: 'setup', fixture: {} }, async () => { throw new Error('process failure'); }), /product_browser_failed/);
});
