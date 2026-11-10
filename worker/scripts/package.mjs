import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, cpSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = resolve('..');
const artifacts = join(root, '.artifacts', 'worker-package');
mkdirSync(artifacts, { recursive: true, mode: 0o700 });
if (process.argv[2] === '--verify-receipt') {
  const receipt = JSON.parse(readFileSync(resolve(root, process.argv[3]), 'utf8'));
  assert.equal(createHash('sha256').update(readFileSync(receipt.archive)).digest('hex'), receipt.sha256);
  verify(receipt.archive, receipt.version, receipt.source.source_sha, receipt.owned_directory);
  console.log(JSON.stringify({ event: 'worker.package_runtime_verified', archive_sha256: receipt.sha256, version: receipt.version, source_sha: receipt.source.source_sha, runtime: process.version }));
  process.exit(0);
}
const owned = mkdtempSync(join(artifacts, 'pack-'));
const staging = join(owned, 'staging');
mkdirSync(staging, { mode: 0o700 });
for (const name of ['dist', 'setup', 'LICENSE', 'README.md']) cpSync(name, join(staging, name), { recursive: true });
const metadata = JSON.parse(readFileSync('package.json', 'utf8'));
const source = JSON.parse(readFileSync('dist/build.json', 'utf8'));
metadata.version = source.package_version;
writeFileSync(join(staging, 'package.json'), JSON.stringify(metadata, null, 2) + '\n', { mode: 0o600 });
const result = JSON.parse(execFileSync('npm', ['pack', staging, '--ignore-scripts', '--json', '--pack-destination', owned], { encoding: 'utf8' }))[0];
assert.equal(result.name, metadata.name);
assert.equal(result.version, metadata.version);
assert.deepEqual(Object.keys(metadata.dependencies ?? {}), []);
for (const file of result.files) assert(/^(dist\/|setup\/|package.json$|LICENSE$|README.md$)/.test(file.path), `unexpected package path: ${file.path}`);
assert(result.files.some(file => file.path === 'dist/main.js'));
assert(result.files.some(file => file.path === 'dist/build.json'));
for (const path of ['setup/install.sh', 'setup/hook.sh', 'setup/SKILL.md']) assert(result.files.some(file => file.path === path));
const archive = join(owned, result.filename);
verify(archive, metadata.version, source.source_sha, owned);
const receipt = { outcome: 'passed', package: metadata.name, version: metadata.version, archive, sha256: createHash('sha256').update(readFileSync(archive)).digest('hex'), source, runtime: process.version, files: result.files.map(file => file.path), owned_directory: owned };
writeFileSync(join(owned, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
writeFileSync(join(artifacts, 'latest.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify(receipt));

function verify(archive, version, sha, owned) {
const unpacked = join(owned, 'unpacked');
mkdirSync(unpacked, { mode: 0o700, recursive: true });
execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
const binary = join(unpacked, 'package', 'dist', 'main.js');
const runtime = process.env.WORKER_RUNTIME_NODE || process.execPath;
const state = mkdtempSync(join(owned, 'state-'));
assert.match(execFileSync(runtime, [binary, '--help'], { encoding: 'utf8' }), /decision-submit/);
assert.equal(execFileSync(runtime, [binary, '--version'], { encoding: 'utf8' }).trim(), version);
const configured = execFileSync(runtime, [binary, 'configure', '--state-dir', state, '--origin', 'https://worker-package.example.test'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
assert.equal(JSON.parse(configured).configured, true);
const source = JSON.parse(readFileSync(join(unpacked, 'package', 'dist', 'build.json'), 'utf8'));
assert.equal(source.source_sha, sha);
assert.equal(source.package_version, version);
assert.equal(sha, execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
}
