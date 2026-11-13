import assert from 'node:assert/strict';
import { readFileSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { aggregateCoverage, rootDirectory } from './coverage-policy.mjs';
import { main, runUnit, safeLog, unitCommand } from './unit-runner.mjs';
import { fixture, istanbul } from './test/helpers.mjs';

test('unit commands preserve component boundaries and require real helper tests', t => {
  const f = fixture(t);
  assert.deepEqual(unitCommand('service', f.inspect(), f.root), ['make', 'test-service-unit']);
  for (const name of ['worker', 'portal']) assert.deepEqual(unitCommand(name, f.inspect(), f.root), ['npm', 'run', 'test:unit', '--workspace', name]);
  const command = unitCommand('tools', f.inspect(), f.root);
  assert(command.includes('--all')); assert(command.includes('--include=tools/**/*.mjs')); assert(command.includes('tools/example.test.mjs'));
  assert.throws(() => unitCommand('ci-helpers', f.inspect(), f.root), /missing_component_unit_tests/);
  assert.throws(() => unitCommand('unknown', f.inspect(), f.root), /unknown_component/);
  assert(safeLog('Bearer abc ' + 'muse_worker_' + 'a'.repeat(43) + ' secret-value', { API_SECRET: 'secret-value', EMPTY_KEY: '' }).includes('[REDACTED]'));
  assert(!safeLog('Bearer abc secret-value', { API_SECRET: 'secret-value' }).includes('secret-value'));
  const browserSession = 'muse_portal_' + 'b'.repeat(43);
  assert.equal(safeLog(JSON.stringify({ session_token: browserSession }), {}), '{"session_token":"[REDACTED]"}');
});

test('runner executes real coverage rules, binds actual evidence and publishes only safe allowlisted files', t => {
  const f = fixture(t), output = [];
  let called = false;
  const spawn = (command, args, options) => {
    called = true;
    assert.equal(command, process.execPath); assert(args.includes('--test')); assert.equal(options.cwd, f.root);
    f.write('.artifacts/unit/tools/coverage-final.json', JSON.stringify(istanbul(f.root, 'tools/example.mjs')));
    return { status: 0, stdout: 'passed secret-value\n', stderr: 'Bearer hidden\n' };
  };
  const options = { root: f.root, inspect: f.inspect, spawn, env: { UNIT_SECRET: 'secret-value' }, output: value => output.push(value), now: () => 1 };
  assert.equal(runUnit('tools', options), 0); assert(called);
  const receipt = JSON.parse(f.read('.artifacts/unit/tools/receipt.json'));
  assert.equal(receipt.covered, 10); assert.equal(receipt.total, 10);
  assert.equal(receipt.execution.outcome, 'passed'); assert.equal(receipt.execution.log_complete, true);
  assert(!output.join('').includes('secret-value')); assert(!output.join('').includes('hidden'));
  assert.equal(f.read('.artifacts/ci/unit/tools/receipt.json'), f.read('.artifacts/unit/tools/receipt.json'));
  assert.deepEqual(aggregateCoverage({ root: f.root, source: f.inspect(), env: {} }).problems, []);
  assert.equal(main(['all'], options), 0);
});

test('failed commands, truncated logs, stale reports and source mutation cannot produce a passing shard', t => {
  for (const failure of ['exit', 'truncated', 'signal', 'stale', 'changed', 'missing-report', 'coverage']) {
    const f = fixture(t);
    const source = f.inspect();
    let scans = 0;
    const options = { root: f.root, env: {}, output() {}, now: () => 2000, inspect: () => ++scans > 1 && failure === 'changed' ? { ...source, identity: { ...source.identity, dirty: true } } : source, spawn: () => {
      if (failure !== 'missing-report') {
        f.write('.artifacts/unit/tools/coverage-final.json', JSON.stringify(istanbul(f.root, 'tools/example.mjs', failure === 'coverage' ? [1, 0] : undefined)));
        if (failure === 'stale') utimesSync(join(f.root, '.artifacts/unit/tools/coverage-final.json'), 0, 0);
      }
      return { status: failure === 'exit' ? 1 : 0, signal: failure === 'signal' ? 'SIGTERM' : null, ...(failure === 'truncated' ? { error: { code: 'ENOBUFS' } } : {}) };
    } };
    assert.equal(runUnit('tools', options), 1, failure);
    const receipt = JSON.parse(f.read('.artifacts/unit/tools/receipt.json'));
    assert.equal(receipt.execution.outcome, 'failed'); assert.equal(receipt.outcome, 'failed');
    if (failure === 'truncated') assert.equal(receipt.execution.log_complete, false);
  }
});

test('service receipts retain the effective Go version and missing commands fail explicitly', t => {
  const f = fixture(t, ['cmd/main.go']);
  f.write('go.mod', 'module example.test/project\n');
  const options = { root: f.root, env: {}, inspect: f.inspect, output() {}, now: () => 1, spawn: () => {
    f.write('.artifacts/unit/service/service.cover', 'mode: atomic\nexample.test/project/cmd/main.go:1.1,2.1 10 1\n');
    f.write('.artifacts/unit/service/go-version.txt', 'go version go1.27.3 linux/amd64\n');
    return { status: 0, stdout: 'real unit runner fixture\n' };
  } };
  assert.equal(runUnit('service', options), 0);
  assert.equal(JSON.parse(f.read('.artifacts/unit/service/receipt.json')).execution.tools.go, 'go version go1.27.3 linux/amd64');
  assert.throws(() => runUnit('portal', options), /unknown_or_absent_component/);
  assert.equal(main([], options), 1);
  assert.equal(main(['unknown'], options), 1);
  const cli = spawnSync(process.execPath, [join(rootDirectory, 'tools/unit-runner.mjs'), 'list'], { cwd: rootDirectory, encoding: 'utf8' });
  assert.equal(cli.status, 0); assert(JSON.parse(cli.stdout).includes('worker-scripts'));
  assert(readFileSync(join(f.root, '.artifacts/unit/service/test.log'), 'utf8').includes('unit runner fixture'));
});
