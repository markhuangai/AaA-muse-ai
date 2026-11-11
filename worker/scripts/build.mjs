import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export function stampBuild({ directory = fileURLToPath(new URL('../', import.meta.url)), execute = execFileSync, read = readFileSync, write = writeFileSync, env = process.env } = {}) {
  const git = args => execute('git', ['--no-optional-locks', ...args], { cwd: directory, encoding: 'utf8' }).trim();
  const source_sha = git(['rev-parse', 'HEAD']);
  const source_dirty = !!git(['status', '--porcelain', '--untracked-files=all']);
  const manifest = JSON.parse(read(join(directory, 'package.json'), 'utf8'));
  const package_version = env.WORKER_RELEASE_VERSION || manifest.version;
  assert(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(dev|rc)\.(0|[1-9][0-9]*))?$/.test(package_version), 'canonical package version required');
  const path = join(directory, 'dist/cli.js');
  const compiled = read(path, 'utf8');
  assert.equal((compiled.match(/export const VERSION = '[^']+';/g) || []).length, 1);
  write(path, compiled.replace(/export const VERSION = '[^']+';/, `export const VERSION = '${package_version}';`));
  const receipt = { source_sha, source_dirty, package_version };
  write(join(directory, 'dist/build.json'), JSON.stringify(receipt) + '\n');
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) stampBuild();
