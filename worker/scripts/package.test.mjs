import assert from 'node:assert/strict';
import { join, relative } from 'node:path';
import test from 'node:test';
import { packageWorker, verifyArchive } from './package.mjs';
import { fixture } from '../../tools/test/helpers.mjs';

function packaging(t, change = {}) {
  const f = fixture(t);
  const source = { source_sha: 'a'.repeat(40), source_dirty: false, package_version: '0.1.0-dev.0' };
  const metadata = { name: '@markhuangai/aaa-muse-worker', version: '0.1.0-dev.0', ...change.metadata };
  for (const [path, raw] of Object.entries({ 'worker/package.json': JSON.stringify(metadata), 'worker/dist/build.json': JSON.stringify(source), 'worker/dist/main.js': 'compiled-worker', 'worker/setup/install.sh': 'installer', 'worker/setup/hook.sh': 'hook', 'worker/setup/SKILL.md': 'skill', 'worker/LICENSE': 'Apache-2.0', 'worker/README.md': 'worker' })) f.write(path, raw);
  const calls = [];
  const execute = (command, args) => {
    calls.push({ command, args });
    if (command === 'npm') {
      const owned = args[args.indexOf('--pack-destination') + 1];
      f.write(relative(f.root, join(owned, 'worker.tgz')), 'archive-bytes');
      return JSON.stringify([{ name: metadata.name, version: source.package_version, filename: 'worker.tgz', files: ['dist/main.js', 'dist/build.json', 'setup/install.sh', 'setup/hook.sh', 'setup/SKILL.md', 'LICENSE', 'README.md', 'package.json'].map(path => ({ path })), ...change.result }]);
    }
    if (command === 'tar') {
      const unpacked = args[args.indexOf('-C') + 1];
      f.write(relative(f.root, join(unpacked, 'package/dist/build.json')), JSON.stringify({ ...source, ...change.source }));
      return '';
    }
    if (command === 'git') return (change.gitSHA ?? source.source_sha) + '\n';
    if (args.includes('--help')) return change.help ?? 'decision-submit';
    if (args.includes('--version')) return change.version ?? source.package_version;
    return JSON.stringify({ configured: change.configured ?? true });
  };
  return { ...f, source, calls, options: { directory: join(f.root, 'worker'), execute } };
}

test('packaging validates metadata, archive inputs, provenance and the same archive runtime receipt', t => {
  const f = packaging(t);
  const receipt = packageWorker([], f.options);
  assert.equal(receipt.outcome, 'passed'); assert.equal(receipt.version, f.source.package_version);
  assert.equal(receipt.sha256.length, 64); assert.equal(receipt.source.source_sha, f.source.source_sha);
  const published = JSON.parse(f.read('.artifacts/worker-package/latest.json'));
  assert.deepEqual(published, receipt);
  assert(f.calls.find(call => call.command === 'npm').args.includes('--ignore-scripts'));
  const verified = packageWorker(['--verify-receipt', '.artifacts/worker-package/latest.json'], f.options);
  assert.equal(verified.archive_sha256, receipt.sha256);
  assert.equal(verified.event, 'worker.package_runtime_verified');
  f.write(relative(f.root, receipt.archive), 'changed bytes');
  assert.throws(() => packageWorker(['--verify-receipt', '.artifacts/worker-package/latest.json'], f.options));
});

test('packaging rejects malformed package, required files, runtime behavior and source proof', t => {
  for (const change of [
    { result: { name: 'wrong-package' } }, { result: { version: '1.2.3' } },
    { metadata: { dependencies: { unexpected: '1' } } },
    { result: { files: [{ path: 'outside.js' }] } },
    { result: { files: [] } }, { result: { files: [{ path: 'dist/main.js' }] } },
    { result: { files: [{ path: 'dist/main.js' }, { path: 'dist/build.json' }] } },
    { help: 'missing commands' }, { version: 'wrong' }, { configured: false },
    { source: { source_sha: 'b'.repeat(40) } }, { source: { package_version: 'wrong' } }, { gitSHA: 'b'.repeat(40) },
  ]) {
    const f = packaging(t, change);
    assert.throws(() => packageWorker([], f.options), JSON.stringify(change));
  }
});

test('archive verification accepts an explicitly selected Node runtime without publication', t => {
  const f = packaging(t), receipt = packageWorker([], f.options);
  verifyArchive(receipt.archive, receipt.version, receipt.source.source_sha, receipt.owned_directory, { ...f.options, runtime: '/fixture/node' });
  assert(f.calls.some(call => call.command === '/fixture/node'));
  assert(!f.calls.some(call => call.args.includes('publish')));
});
