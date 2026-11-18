import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFixture } from '../.github/scripts/test/release-fixture.mjs';
import { main } from './verify-release.mjs';
import { hash, jsonBytes } from '../.github/scripts/release-manifest.mjs';

test('release verification chooses read-only published mode only with every pinned selector', async t => {
  const f = await releaseFixture(t); f.seed();
  const result = await main({ env: { RELEASE_TAG: f.prepared.tag, RELEASE_SOURCE_SHA: f.source, RELEASE_MANIFEST_SHA256: hash(jsonBytes(f.manifest)), GH_TOKEN: f.token },
    verify: options => import('../.github/scripts/release-verify.mjs').then(module => module.verifyPublished({ ...options, fetcher: f.fetcher })) });
  assert.equal(result.exit_code, 0); assert.equal(result.receipt.publication, 'complete'); assert.equal(f.state.commands.length, 0);
  assert.equal((await main({ env: { RELEASE_TAG: 'v0.1.0' } })).exit_code, 1);
});

test('controlled entry point checks real archive content, image metadata, source drift and scoped cleanup', async t => {
  const f = await releaseFixture(t, { version: '0.1.1' }), writes = new Map(), commands = [], source = { identity: { sha: f.source, tree_sha256: 'snapshot' } };
  const execute = (command, args, options) => {
    commands.push([command, ...args]);
    if (command === 'make' || command === process.execPath || (command === 'docker' && args[1] === 'rm')) return '';
    return f.execute(command, args, options);
  };
  const options = { env: {}, execute, inspect: () => source, mkdir() {}, write: (path, bytes) => writes.set(path, bytes),
    list: () => ['release-verify.test.mjs'], read: path => path === '.artifacts/worker-package/latest.json' ? jsonBytes({ ...f.worker, archive: f.directory + '/worker.tgz' }) : Buffer.from('unused') };
  options.read = path => path === '.artifacts/worker-package/latest.json' ? jsonBytes({ ...f.worker, archive: f.directory + '/worker.tgz' }) : f.archive;
  const result = await main(options);
  assert.equal(result.exit_code, 0); assert.equal(result.receipt.cleanup, 'passed');
  assert.equal(result.receipt.version, '0.1.1');
  assert.equal(JSON.parse(writes.get('.artifacts/ci/release/receipt.json')).worker_sha256, f.worker.sha256);
  assert(commands.some(command => command.includes('--no-prune')));
  let reads = 0;
  assert.equal((await main({ ...options, inspect: () => ++reads === 1 ? source : { identity: { ...source.identity, tree_sha256: 'changed' } } })).exit_code, 1);
  assert.equal((await main({ ...options, list: () => [] })).exit_code, 1);
  assert.equal((await main({ ...options, execute: () => { throw { status: 1 }; } })).exit_code, 1);
});
