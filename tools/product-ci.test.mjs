import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { boundaryCases } from './product-report.mjs';
import { collectShards, main, nativeFlowCases, validateNativeReport, validateShards } from './product-ci.mjs';
import { hash } from './qualification-evidence.mjs';
import { exportFixture } from './qualification-fixtures.mjs';
import { productFixture } from './test/product-fixture.mjs';

const source = { sha: 'a'.repeat(40), dirty: false, tree_sha256: 'b'.repeat(64) };
const expected = { source, runID: '123', attempt: '1' };
function receipts() {
  return ['flow', 'boundaries'].map(shard => ({ schema_version: 1, suite: 'product-e2e', shard, source, run_id: '123', run_attempt: '1', outcome: 'passed', evidence_kind: 'synthetic', qualifies_live_muse: false, duration_ms: 1000, capture_complete: true,
    cases: (shard === 'flow' ? nativeFlowCases : boundaryCases).map(id => ({ id, outcome: 'passed' })), image_digest: 'sha256:' + 'c'.repeat(64), installer_sha256: 'd'.repeat(64), report_sha256: 'e'.repeat(64), exports: [{}, {}, {}], cleanup: { failures: [] },
    worker_version: '1.0.0-rc.7', worker_sha256: 'f'.repeat(64), images: ['sha256:' + 'c'.repeat(64), 'sha256:' + 'c'.repeat(64)] }));
}

function nativeReport() {
  const { report, broker, workers } = productFixture(false, ['restart', 'worker-probe']);
  Object.assign(report, { schema_version: 1, suite: 'native-pull-product', qualifies_live_muse: false,
    cleanup: { failures: [] }, model_cleanup_failures: [] });
  report.source.working_source = source;
  report.cases.find(item => item.id === 'recovery.hook').id = 'recovery.native-checker';
  const crossing = report.cases.find(item => item.id === 'boundary.cross-worker');
  crossing.job_id = 'foreign-job';
  broker.find(event => event.msg === 'lease.rejected' && event.request_id === crossing.request_id).job_id = crossing.job_id;
  for (const worker of report.workers) {
    worker.checker_job_id = 'checker-' + worker.slot;
    workers.push({ time: report.started_at, level: 'INFO', msg: 'setup.hook_registration_verified', worker_id: worker.worker_id, hook: { id: worker.checker_job_id } });
  }
  const seen = new Set();
  for (const cycle of report.cycles) {
    for (const turn of cycle.turns) {
      const job = turn.job_id;
      Object.assign(turn, { claim_id: 'claim-' + job, launch_id: 'launch-' + job, native_job_id: 'once-' + job });
      if (seen.has(job)) continue;
      seen.add(job);
      const claim = Object.fromEntries(['job_id', 'worker_id', 'operation_id', 'claim_id', 'launch_id', 'native_job_id', 'generation'].map(key => [key, turn[key]]));
      const start = { ...claim, time: turn.started_at, level: 'INFO', request_id: 'start-' + job, pull_run_id: 'pull-' + job, wake_invocation_id: 'wake-' + job };
      const settle = { ...claim, time: turn.finished_at, level: 'INFO', request_id: 'settle-' + job, native_run_id: 'event-hook-wake-' + job };
      workers.push({ ...start, msg: 'hook.work_started' }, { ...start, level: 'DEBUG', msg: 'worker.http_exchange', route: `/api/v1/worker/hook/jobs/${job}/start`,
        http_status: 200, output: { context: broker.find(event => event.msg === 'inference.context' && event.job_id === job).context } },
      { ...settle, msg: 'cron.work_settled', settling_checker_run_id: 'observer-' + job, receipt_state: 'accepted' });
      broker.push({ ...start, msg: 'job.work_started' }, { ...settle, msg: 'job.work_settled' });
    }
  }
  function archives() {
    const captures = new Map();
    report.exports = [['broker', undefined, broker], ...report.workers.map(worker =>
      ['worker', worker.worker_id, workers.filter(event => event.worker_id === worker.worker_id)])].map(([kind, worker, events]) => {
      const file = `${worker ?? kind}.ndjson`, raw = exportFixture(events);
      captures.set(file, raw);
      return { file, source: kind, worker_id: worker, sha256: hash(raw) };
    });
    return name => captures.get(name);
  }
  return { report, broker, workers, archives };
}

test('native product validation rejects uncoupled claim, context, observation and terminal evidence', () => {
  const fixture = nativeReport();
  assert.doesNotThrow(() => validateNativeReport(fixture.report, fixture.archives(), source));
  for (const mutate of [
    ({ report }) => { report.qualifies_live_muse = true; },
    ({ report }) => { report.status_receipt.build.revision = 'other'; },
    ({ report }) => { report.workers[0].checker_job_id = 'other'; },
    ({ report }) => { report.cycles.pop(); report.cycles = report.cycles.filter(cycle => cycle.id !== 'restart'); },
    ({ report }) => { report.cycles[0].turns[0].claim_id = 'foreign-claim'; },
    ({ workers }) => { workers.find(event => event.msg === 'worker.http_exchange').output = { context: {} }; },
    ({ workers }) => { workers.find(event => event.msg === 'cron.work_settled').settling_checker_run_id = workers.find(event => event.msg === 'hook.work_started').wake_invocation_id; },
    ({ broker }) => { broker.find(event => event.msg === 'job.work_settled').request_id = 'other-settlement'; },
    ({ broker }) => { broker.find(event => event.msg === 'lease.fenced').job_id = 'other-job'; },
  ]) {
    const changed = nativeReport(); mutate(changed);
    assert.throws(() => validateNativeReport(changed.report, changed.archives(), source), /native_e2e_/);
  }
  const read = fixture.archives();
  assert.throws(() => validateNativeReport(fixture.report, file => read(file) + '\n', source), /native_e2e_capture_digest/);
});

test('product aggregate requires complete case/source/run/artifact/budget evidence from both shards', () => {
  const result = validateShards(receipts(), expected);
  assert.equal(result.outcome, 'passed'); assert.equal(result.qualifies_live_muse, false);
  for (const change of [
    rows => rows.pop(), rows => rows.push(rows[0]), rows => { rows[0].outcome = 'failed'; }, rows => { rows[0].evidence_kind = 'live'; },
    rows => { rows[0].source = {}; }, rows => { rows[0].run_attempt = '2'; }, rows => { rows[0].duration_ms = 1500001; }, rows => { rows[0].capture_complete = false; },
    rows => { rows[0].cases.pop(); }, rows => { rows[0].cleanup.failures.push('leftover'); }, rows => { rows[0].image_digest = 'latest'; },
    rows => { rows[1].worker_sha256 = '0'.repeat(64); }, rows => { rows[1].images = []; }, rows => { rows[0].cases.push(rows[0].cases[0]); },
  ]) { const rows = receipts(); change(rows); assert.throws(() => validateShards(rows, expected)); }
});

test('aggregate discovers real shard files and returns explicit failure diagnostics', t => {
  const root = mkdtempSync(join(tmpdir(), 'aaa-product-ci-')); t.after(() => rmSync(root, { recursive: true }));
  const rows = receipts(); mkdirSync(join(root, 'flow'));
  writeFileSync(join(root, 'flow', 'flow.json'), JSON.stringify(rows[0])); writeFileSync(join(root, 'boundaries.json'), JSON.stringify(rows[1])); writeFileSync(join(root, 'ignored.json'), '{}');
  assert.equal(collectShards(root).length, 2);
  const lines = [], options = { source: () => source, env: { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }, output: line => lines.push(JSON.parse(line)) };
  assert.equal(main([root], options), 0); assert.equal(lines.at(-1).msg, 'e2e.completed');
  assert.equal(main([], options), 1); assert.equal(lines.at(-1).cause, 'e2e_receipt_directory_required');
  assert.equal(main([root], { ...options, collect: () => { throw new Error('unsafe /path/error'); } }), 1);
  assert.equal(lines.at(-1).cause, 'e2e_receipt_read_failed');
  assert.equal(main([root], { ...options, env: {}, collect: () => rows }), 1);
});
