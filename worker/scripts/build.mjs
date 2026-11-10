import { execFileSync } from 'node:child_process';
import { writeFileSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const source_sha = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const source_dirty = !!execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const package_version = process.env.WORKER_RELEASE_VERSION || manifest.version;
assert(/^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(dev|rc)\.(0|[1-9][0-9]*))?$/.test(package_version), 'canonical package version required');
const path = new URL('../dist/cli.js', import.meta.url);
const compiled = readFileSync(path, 'utf8');
assert.equal((compiled.match(/export const VERSION = '[^']+';/g) || []).length, 1);
writeFileSync(path, compiled.replace(/export const VERSION = '[^']+';/, `export const VERSION = '${package_version}';`));
writeFileSync(new URL('../dist/build.json', import.meta.url), JSON.stringify({ source_sha, source_dirty, package_version }) + '\n');
