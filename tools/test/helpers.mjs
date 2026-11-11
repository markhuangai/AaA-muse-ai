import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { collectCoverage, hash, rootDirectory } from '../coverage-policy.mjs';
import { inspectSource } from '../source-inventory.mjs';

export function fixture(t, paths = ['tools/example.mjs', 'tools/example.test.mjs']) {
  const parent = join(rootDirectory, '.artifacts/unit/policy-fixtures');
  mkdirSync(parent, { recursive: true, mode: 0o700 });
  const root = mkdtempSync(join(parent, 'unit-'));
  t.after(() => rmSync(root, { recursive: true }));
  const write = (path, value) => { mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 }); writeFileSync(join(root, path), value); };
  for (const path of paths) write(path, 'export const value = 1;\n');
  write('node_modules/c8/package.json', '{"version":"10.1.3"}');
  const execute = (_file, args) => args.includes('ls-files') ? paths.join('\0') + '\0' : args.includes('rev-parse') ? 'a'.repeat(40) + '\n' : '';
  const inspect = () => inspectSource(root, execute);
  return { root, paths, write, execute, inspect, read: path => readFileSync(join(root, path), 'utf8') };
}

export function istanbul(root, path, hits = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1]) {
  const absolute = join(root, path);
  return { [absolute]: { path: absolute, s: Object.fromEntries(hits.map((hit, i) => [String(i), hit])), statementMap: Object.fromEntries(hits.map((_hit, i) => [String(i), { start: { line: i + 1, column: 0 }, end: { line: i + 1, column: 1 } }])) } };
}

export function receiptFor(f, component = 'tools', changes = {}) {
  const paths = f.inspect().components[component];
  const report = Object.assign({}, ...paths.map(path => istanbul(f.root, path)));
  f.write(`.artifacts/unit/${component}/coverage-final.json`, JSON.stringify(report));
  const log = 'unit assertions passed\n';
  f.write(`.artifacts/unit/${component}/test.log`, log);
  const execution = { command: ['node', '--test'], tools: { node: process.version }, outcome: 'passed', log_complete: true, log_sha256: hash(log), run_id: 'local', run_attempt: '1', started_at: new Date(0).toISOString(), finished_at: new Date(1).toISOString(), duration_ms: 1 };
  const { receipt } = collectCoverage(component, { root: f.root, source: f.inspect(), execution });
  Object.assign(receipt, changes);
  f.write(`.artifacts/unit/${component}/receipt.json`, JSON.stringify(receipt));
  return receipt;
}
