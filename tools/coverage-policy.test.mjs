import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { aggregateCoverage, collectCoverage, coverageProblems, goFiles, hash, istanbulFiles, main, reportCoverage, selectShard } from './coverage-policy.mjs';
import { fixture, istanbul, receiptFor } from './test/helpers.mjs';

test('strict raw statement comparison rejects exactly 90 without rounding', () => {
  const identity = { sha: 'a'.repeat(40) }, path = 'tools/a.mjs';
  const receipt = (covered, total) => ({ component: 'tools', suite: 'unit', source: identity, outcome: 'passed', covered, total, files: [{ path, covered, total }] });
  for (const [covered, total, accepted] of [[90, 100, false], [91, 100, true], [9000001, 10000000, true], [0, 0, false], [Number.MAX_SAFE_INTEGER - 1, Number.MAX_SAFE_INTEGER, true]]) {
    assert.equal(coverageProblems(receipt(covered, total), 'tools', [path], identity).length === 0, accepted);
  }
  const valid = receipt(10, 10);
  for (const [changed, cause] of [
    [null, 'missing_or_failed_unit_receipt'],
    [{ ...valid, suite: 'integration' }, 'missing_or_failed_unit_receipt'],
    [{ ...valid, outcome: 'cancelled' }, 'missing_or_failed_unit_receipt'],
    [{ ...valid, source: { sha: 'b'.repeat(40) } }, 'stale_source_identity'],
    [{ ...valid, covered: 9 }, 'inconsistent_raw_counts'],
    [{ ...valid, files: [{ path, covered: -1, total: 10 }] }, 'invalid_file_counts'],
    [{ ...valid, files: [{ path, covered: 11, total: 10 }] }, 'invalid_file_counts'],
    [{ ...valid, files: [{ path, covered: 1.5, total: 10 }] }, 'invalid_file_counts'],
    [{ ...valid, files: null }, 'invalid_file_counts'],
    [{ ...valid, files: [null] }, 'invalid_file_counts'],
    [{ ...valid, files: [{ path: 7, covered: 10, total: 10 }] }, 'invalid_file_counts'],
    [{ ...valid, files: [...valid.files, ...valid.files] }, 'incomplete_source_inventory'],
  ]) assert.equal(coverageProblems(changed, 'tools', [path], identity)[0].cause, cause);
  assert.equal(coverageProblems(valid, 'tools', [], identity)[0].cause, 'missing_component_sources');
  const omitted = coverageProblems(valid, 'tools', [path, 'tools/missing.mjs'], identity)[0];
  assert.deepEqual(omitted.missing_files, ['tools/missing.mjs']);
  const unexpected = coverageProblems(valid, 'tools', ['tools/other.mjs'], identity)[0];
  assert.deepEqual(unexpected.excluded_files, [path]);
});

test('Istanbul parser verifies actual statement maps, module ownership and hit counts', () => {
  const root = '/unit', report = istanbul(root, 'tools/a.mjs', [1, 0, 2]);
  assert.deepEqual(istanbulFiles(report, root), [{ path: 'tools/a.mjs', covered: 2, total: 3 }]);
  for (const raw of [null, [], { bad: {} }]) assert.throws(() => istanbulFiles(raw, root), /invalid_istanbul/);
  for (const change of [entry => { entry.s['0'] = -1; }, entry => { delete entry.s['0']; }, entry => { entry.path = '/outside/a.mjs'; }]) {
    const value = structuredClone(report); change(Object.values(value)[0]);
    assert.throws(() => istanbulFiles(value, root), /invalid/);
  }
  const duplicate = { ...report, '/unit/tools/../tools/a.mjs': Object.values(report)[0] };
  assert.throws(() => istanbulFiles(duplicate, root), /duplicate/);
  assert.throws(() => istanbulFiles(istanbul('/outside', 'a.mjs'), root), /invalid/);
});

test('Go parser merges duplicated package blocks without inflating raw statements', () => {
  const profile = 'mode: atomic\nexample.test/project/a.go:1.1,2.1 2 0\nexample.test/project/a.go:1.1,2.1 2 1\nexample.test/project/a.go:3.1,4.1 3 0\nexample.test/project/b.go:1.1,2.1 1 2\n';
  assert.deepEqual(goFiles(profile, 'example.test/project'), [{ path: 'a.go', covered: 2, total: 5 }, { path: 'b.go', covered: 1, total: 1 }]);
  for (const raw of ['mode: count\n', 'mode: atomic\ninvalid', 'mode: atomic\nforeign/a.go:1.1,2.1 1 1', 'mode: atomic\nexample.test/project/../a.go:1.1,2.1 1 1', profile + 'example.test/project/a.go:1.1,2.1 3 1\n', 'mode: atomic\nexample.test/project/a.go:1.1,2.1 9007199254740992 1']) assert.throws(() => goFiles(raw, 'example.test/project'), /invalid|inconsistent/);
});

test('collection and aggregation require complete raw unit evidence for the current source and run', t => {
  const f = fixture(t);
  const receipt = receiptFor(f);
  const options = { root: f.root, source: f.inspect(), env: {} };
  assert.deepEqual(aggregateCoverage(options).problems, []);
  assert.equal(aggregateCoverage(options).receipts[0].covered, 10);
  assert.equal(aggregateCoverage({ ...options, env: { UNIT_RESULT: 'cancelled' } }).problems[0].cause, 'required_job_not_successful');
  assert.throws(() => collectCoverage('portal', options), /unknown_or_absent_component/);
  for (const [change, cause] of [
    [value => { value.execution = null; }, 'missing_execution_evidence'],
    [value => { value.execution.log_complete = false; }, 'missing_execution_evidence'],
    [value => { value.execution.run_id = 'other'; }, 'stale_run_identity'],
    [value => { value.execution.run_attempt = '2'; }, 'stale_run_identity'],
    [value => { value.report.sha256 = 'x'; }, 'missing_or_changed_report_or_log'],
    [value => { value.execution.log_sha256 = 'x'; }, 'missing_or_changed_report_or_log'],
    [value => { value.source.sha = 'b'.repeat(40); }, 'stale_source_identity'],
  ]) {
    const value = structuredClone(receipt); change(value);
    f.write('.artifacts/unit/tools/receipt.json', JSON.stringify(value));
    assert.equal(aggregateCoverage(options).problems[0].cause, cause);
  }
  f.write('.artifacts/unit/tools/receipt.json', JSON.stringify(receipt));
  f.write('.artifacts/unit/tools/test.log', 'truncated');
  assert.equal(aggregateCoverage(options).problems[0].cause, 'missing_or_changed_report_or_log');
});

test('missing shards, invalid reports and forged summary counts cannot pass aggregation', t => {
  const f = fixture(t, ['tools/a.mjs', '.github/scripts/a.mjs']);
  const receipt = receiptFor(f);
  const options = { root: f.root, source: f.inspect(), env: {} };
  assert.equal(aggregateCoverage(options).problems[0].component, 'ci-helpers');
  assert.equal(aggregateCoverage(options).problems[0].cause, 'missing_shard_report_or_log');
  receiptFor(f, 'ci-helpers');
  const changed = JSON.stringify(istanbul(f.root, 'tools/a.mjs', [1, 0]));
  f.write('.artifacts/unit/tools/coverage-final.json', changed);
  receipt.report.sha256 = hash(changed);
  f.write('.artifacts/unit/tools/receipt.json', JSON.stringify(receipt));
  assert.equal(aggregateCoverage(options).problems[0].cause, 'raw_report_counts_differ');
  f.write('.artifacts/unit/tools/receipt.json', 'not-json');
  assert(aggregateCoverage(options).problems.some(problem => problem.component === 'tools'));
});

test('Go collection inventories every production file and requires atomic unit provenance', t => {
  const f = fixture(t, ['cmd/main.go']);
  f.write('go.mod', 'module example.test/project\n');
  f.write('.artifacts/unit/service/service.cover', 'mode: atomic\nexample.test/project/cmd/main.go:1.1,2.1 10 1\n');
  const result = collectCoverage('service', { root: f.root, source: f.inspect() });
  assert.equal(result.receipt.total, 10); assert.deepEqual(result.problems, []);
  f.write('.artifacts/unit/service/service.cover', 'mode: atomic\n');
  assert.equal(collectCoverage('service', { root: f.root, source: f.inspect() }).problems[0].cause, 'incomplete_source_inventory');
  f.write('go.mod', 'missing module declaration');
  assert.throws(() => collectCoverage('service', { root: f.root, source: f.inspect() }), /missing_go_module/);
});

test('artifact selection uses each latest attempt without reviving an older successful receipt', t => {
  const sha = 'a'.repeat(40), name = `unit-${sha}-tools-`;
  assert.deepEqual(selectShard('tools', sha, [name + '1', name + '2'], 2), { name: name + '2', attempt: 2 });
  for (const names of [[], [name + '0'], [name + '3'], [name + 'bad'], [name + '1', name + '1']]) assert.throws(() => selectShard('tools', sha, names, 2), /shard/);
  const f = fixture(t);
  const receipt = receiptFor(f);
  for (const attempt of [1, 2]) {
    for (const file of ['test.log', 'coverage-final.json']) f.write(`downloads/${name}${attempt}/tools/${file}`, f.read('.artifacts/unit/tools/' + file));
    const value = structuredClone(receipt); value.execution.run_attempt = String(attempt);
    if (attempt === 2) value.outcome = 'failed';
    f.write(`downloads/${name}${attempt}/tools/receipt.json`, JSON.stringify(value));
  }
  const options = { root: f.root, source: f.inspect(), directory: join(f.root, 'downloads'), artifactNames: [name + '1', name + '2'], env: { GITHUB_RUN_ATTEMPT: '2' } };
  assert.equal(aggregateCoverage(options).problems[0].cause, 'missing_or_failed_unit_receipt');
  assert.deepEqual(aggregateCoverage({ ...options, artifactNames: [name + '1'] }).problems, []);
});

test('CLI writes checked receipts and emits actionable ERROR evidence through the existing logger', t => {
  const f = fixture(t); receiptFor(f);
  const options = { source: f.inspect(), env: {} };
  assert.equal(main(['collect', 'tools'], f.root, options), 0);
  receiptFor(f);
  assert.equal(main(['aggregate'], f.root, options), 0);
  assert.equal(main(['collect', 'portal'], f.root, options), 1);
  assert.equal(main(['unknown'], f.root, options), 1);
  assert.equal(main(['aggregate', 'missing-directory'], f.root, options), 1);
  f.write('.artifacts/unit/tools/coverage-final.json', JSON.stringify(istanbul(f.root, 'tools/example.mjs', [1, 1, 1, 1, 1, 1, 1, 1, 1, 0])));
  const captured = [], previous = console.log;
  console.log = line => captured.push(line);
  try { assert.equal(main(['collect', 'tools'], f.root, options), 1); } finally { console.log = previous; }
  const rejected = captured.filter(line => line.startsWith('::error::')).map(line => JSON.parse(line.slice(9)));
  assert(rejected.some(event => event.level === 'ERROR' && event.event === 'ci.coverage_rejected' && event.component === 'tools' && event.suite === 'unit' && event.covered === 9 && event.total === 10 && event.source.sha && event.cause === 'unit_statements_not_strictly_above_90'));
  const emitted = [];
  assert.equal(reportCoverage({ receipt: { covered: 90, total: 100 }, problems: [{ component: 'tools', covered: 90, total: 100, suite: 'unit', cause: 'unit_statements_not_strictly_above_90' }] }, (_core, level, event, fields) => emitted.push({ level, event, ...fields })), 1);
  assert.equal(emitted[0].event, 'ci.coverage_rejected'); assert.equal(emitted[0].level, 'error'); assert.equal(emitted[0].covered, 90);
  assert.equal(JSON.parse(readFileSync(join(f.root, '.artifacts/unit/tools/receipt.json'), 'utf8')).suite, 'unit');
});
