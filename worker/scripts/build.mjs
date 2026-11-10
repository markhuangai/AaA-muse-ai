import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const source_sha = execFileSync('git', ['--no-optional-locks', 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const source_dirty = !!execFileSync('git', ['--no-optional-locks', 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' }).trim();
writeFileSync(new URL('../dist/build.json', import.meta.url), JSON.stringify({ source_sha, source_dirty }) + '\n');
