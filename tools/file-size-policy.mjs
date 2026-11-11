import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logEvent } from '../.github/scripts/ci-log.mjs';
import { inspectSource } from './source-inventory.mjs';

const lockfiles = new Set(['package-lock.json', '.github/scripts/package-lock.json', 'go.sum']);
const sourceFile = path => /\.(?:go|[cm]?[jt]sx?|py|sh|sql|html?|css|scss|ya?ml|json|toml)$/.test(path) || /(?:^|\/)(?:Makefile|Dockerfile)(?:\.[^/]*)?$/.test(path) || /\.Dockerfile$/.test(path);

export function countLines(bytes) {
  const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  if (text.includes('\0')) throw new Error('nul_in_maintained_source');
  return text ? text.split('\n').length - Number(text.endsWith('\n')) : 0;
}

export function checkFileSizes(paths, read, maximum = 1000) {
  const files = [], excluded_files = [], problems = [];
  for (const path of [...new Set(paths)].sort()) {
    if (lockfiles.has(path)) { excluded_files.push({ path, reason: 'dependency_lockfile' }); continue; }
    if (!sourceFile(path)) continue;
    try {
      const lines = countLines(read(path));
      files.push({ path, lines });
      if (lines > maximum) problems.push({ path, lines, maximum, cause: 'maintained_file_exceeds_limit' });
    } catch (error) { problems.push({ path, lines: null, maximum, cause: error.code ?? error.message }); }
  }
  return { files, excluded_files, problems };
}

export function main(root = process.cwd(), inspect = inspectSource, emit = logEvent) {
  try {
    const source = inspect(root);
    const result = checkFileSizes(source.paths, path => readFileSync(join(root, path)));
    for (const problem of result.problems) emit(null, 'error', 'ci.file_limit_rejected', { source: source.identity, ...problem });
    emit(null, 'info', 'ci.file_inventory', { source: source.identity, ...result, maximum: 1000, outcome: result.problems.length ? 'failed' : 'passed' });
    return result.problems.length ? 1 : 0;
  } catch (error) {
    emit(null, 'error', 'ci.file_limit_rejected', { path: null, lines: null, maximum: 1000, cause: error.code ?? error.message });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
