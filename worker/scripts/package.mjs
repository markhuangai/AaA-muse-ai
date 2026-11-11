import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workerDirectory = fileURLToPath(new URL('../', import.meta.url));

export function packageWorker(args = process.argv.slice(2), { directory = workerDirectory, execute = execFileSync } = {}) {
  const root = resolve(directory, '..');
  const artifacts = join(root, '.artifacts', 'worker-package');
  mkdirSync(artifacts, { recursive: true, mode: 0o700 });
  if (args[0] === '--verify-receipt') {
    const receipt = JSON.parse(readFileSync(resolve(root, args[1]), 'utf8'));
    assert.equal(createHash('sha256').update(readFileSync(receipt.archive)).digest('hex'), receipt.sha256);
    verifyArchive(receipt.archive, receipt.version, receipt.source.source_sha, receipt.owned_directory, { execute, directory });
    return { event: 'worker.package_runtime_verified', archive_sha256: receipt.sha256, version: receipt.version, source_sha: receipt.source.source_sha, runtime: process.version };
  }
  const owned = mkdtempSync(join(artifacts, 'pack-'));
  const staging = join(owned, 'staging');
  mkdirSync(staging, { mode: 0o700 });
  for (const name of ['dist', 'setup', 'LICENSE', 'README.md']) cpSync(join(directory, name), join(staging, name), { recursive: true });
  const metadata = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
  const source = JSON.parse(readFileSync(join(directory, 'dist/build.json'), 'utf8'));
  metadata.version = source.package_version;
  writeFileSync(join(staging, 'package.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
  const result = JSON.parse(execute('npm', ['pack', staging, '--ignore-scripts', '--json', '--pack-destination', owned], { cwd: directory, encoding: 'utf8' }))[0];
  assert.equal(result.name, metadata.name);
  assert.equal(result.version, metadata.version);
  assert.deepEqual(Object.keys(metadata.dependencies ?? {}), []);
  for (const file of result.files) assert(/^(dist\/|setup\/|package.json$|LICENSE$|README.md$)/.test(file.path), `unexpected package path: ${file.path}`);
  assert(result.files.some(file => file.path === 'dist/main.js'));
  assert(result.files.some(file => file.path === 'dist/build.json'));
  for (const path of ['setup/install.sh', 'setup/hook.sh', 'setup/SKILL.md']) assert(result.files.some(file => file.path === path));
  const archive = join(owned, result.filename);
  verifyArchive(archive, metadata.version, source.source_sha, owned, { execute, directory });
  const receipt = { outcome: 'passed', package: metadata.name, version: metadata.version, archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), source, runtime: process.version, files: result.files.map(file => file.path), owned_directory: owned };
  writeFileSync(join(owned, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  writeFileSync(join(artifacts, 'latest.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  return receipt;
}

export function verifyArchive(archive, version, sha, owned, { execute = execFileSync, directory = workerDirectory, runtime = process.env.WORKER_RUNTIME_NODE || process.execPath } = {}) {
  const unpacked = join(owned, 'unpacked');
  mkdirSync(unpacked, { mode: 0o700, recursive: true });
  execute('tar', ['-xzf', archive, '-C', unpacked]);
  const binary = join(unpacked, 'package', 'dist', 'main.js');
  const state = mkdtempSync(join(owned, 'state-'));
  assert.match(execute(runtime, [binary, '--help'], { encoding: 'utf8' }), /decision-submit/);
  assert.equal(execute(runtime, [binary, '--version'], { encoding: 'utf8' }).trim(), version);
  const configured = execute(runtime, [binary, 'configure', '--state-dir', state, '--origin', 'https://worker-package.example.test'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  assert.equal(JSON.parse(configured).configured, true);
  const source = JSON.parse(readFileSync(join(unpacked, 'package', 'dist', 'build.json'), 'utf8'));
  assert.equal(source.source_sha, sha);
  assert.equal(source.package_version, version);
  assert.equal(sha, execute('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { cwd: directory, encoding: 'utf8' }).trim());
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(packageWorker()));
