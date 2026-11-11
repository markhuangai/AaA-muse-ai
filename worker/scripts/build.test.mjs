import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { stampBuild } from './build.mjs';
import { checkWorkerCoverage } from './coverage.mjs';
import { rootDirectory } from '../../tools/coverage-policy.mjs';
import { fixture, istanbul } from '../../tools/test/helpers.mjs';

test('build stamping uses canonical package versions, source identity and exactly one compiled version', t => {
  const f = fixture(t);
  f.write('worker/package.json', '{"version":"0.1.0-dev.0"}');
  const reset = () => f.write('worker/dist/cli.js', "export const VERSION = 'old';\n");
  const execute = (_file, args) => args.includes('status') ? ' M source.ts\n' : 'a'.repeat(40) + '\n';
  const options = { directory: join(f.root, 'worker'), execute, env: {} };
  reset();
  const build = stampBuild(options);
  assert.deepEqual(build, { source_sha: 'a'.repeat(40), source_dirty: true, package_version: '0.1.0-dev.0' });
  assert(f.read('worker/dist/cli.js').includes("VERSION = '0.1.0-dev.0'"));
  assert.deepEqual(JSON.parse(f.read('worker/dist/build.json')), build);
  for (const version of ['0.1.0-rc.0', '1.2.3']) { reset(); assert.equal(stampBuild({ ...options, env: { WORKER_RELEASE_VERSION: version } }).package_version, version); }
  for (const version of ['01.2.3', '0.1.0-rc.01', '0.1.0-beta.0', 'arbitrary']) { reset(); assert.throws(() => stampBuild({ ...options, env: { WORKER_RELEASE_VERSION: version } }), /canonical package version/); }
  for (const contents of ['', "export const VERSION = 'one';\nexport const VERSION = 'two';\n"]) { f.write('worker/dist/cli.js', contents); assert.throws(() => stampBuild(options)); }
  const actual = spawnSync(process.execPath, [join(rootDirectory, 'worker/scripts/build.mjs')], { cwd: rootDirectory, encoding: 'utf8' });
  assert.equal(actual.status, 0, actual.stderr);
});

test('worker coverage entry uses the shared actual raw-count policy and rejects an omitted module', t => {
  const f = fixture(t, ['worker/src/main.ts']);
  f.write('.artifacts/unit/worker/coverage-final.json', JSON.stringify(istanbul(f.root, 'worker/src/main.ts')));
  assert.equal(checkWorkerCoverage(f.root, { source: f.inspect() }), 0);
  f.write('.artifacts/unit/worker/coverage-final.json', '{}');
  assert.equal(checkWorkerCoverage(f.root, { source: f.inspect() }), 1);
});
