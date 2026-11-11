import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { logEvent } from '../.github/scripts/ci-log.mjs';
import { inspectSource } from './source-inventory.mjs';

export const rootDirectory = fileURLToPath(new URL('../', import.meta.url));
export const reportName = component => component === 'service' ? 'service.cover' : 'coverage-final.json';
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const requireThat = (value, cause) => { if (!value) throw new Error(cause); };
const count = value => Number.isSafeInteger(value) && value >= 0;

export function istanbulFiles(report, root) {
  requireThat(report && typeof report === 'object' && !Array.isArray(report), 'invalid_istanbul_report');
  const files = [];
  for (const [key, entry] of Object.entries(report)) {
    requireThat(entry && typeof entry.path === 'string' && entry.s && entry.statementMap, 'invalid_istanbul_entry');
    const path = relative(root, resolve(root, entry.path));
    requireThat(!path.startsWith('../') && !files.some(file => file.path === path) && resolve(root, key) === resolve(root, entry.path), 'invalid_or_duplicate_module');
    const statements = Object.keys(entry.statementMap).sort();
    requireThat(JSON.stringify(statements) === JSON.stringify(Object.keys(entry.s).sort()) && Object.values(entry.s).every(count), 'invalid_statement_counts');
    files.push({ path, covered: Object.values(entry.s).filter(hits => hits > 0).length, total: statements.length });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

export function goFiles(raw, module) {
  const lines = raw.trimEnd().split('\n');
  requireThat(lines.shift() === 'mode: atomic', 'invalid_go_unit_profile');
  const blocks = new Map();
  for (const line of lines) {
    const match = /^(.*):(\d+\.\d+,\d+\.\d+) (\d+) (\d+)$/.exec(line);
    requireThat(match && match[1].startsWith(module + '/'), 'invalid_go_coverage_block');
    const path = match[1].slice(module.length + 1), statements = Number(match[3]), hits = Number(match[4]);
    requireThat(count(statements) && count(hits) && !path.startsWith('../') && !path.includes('/../'), 'invalid_go_statement_counts');
    const key = path + ':' + match[2], prior = blocks.get(key);
    requireThat(!prior || prior.total === statements, 'inconsistent_go_coverage_block');
    blocks.set(key, { path, total: statements, covered: hits > 0 || prior?.covered > 0 ? statements : 0 });
  }
  const files = new Map();
  for (const block of blocks.values()) {
    const file = files.get(block.path) ?? { path: block.path, covered: 0, total: 0 };
    file.total += block.total; file.covered += block.covered; files.set(file.path, file);
  }
  return [...files.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function coverageProblems(receipt, component, expected, identity) {
  const fields = { component, suite: receipt?.suite ?? null, source: receipt?.source ?? null, expected_source: identity, covered: receipt?.covered ?? null, total: receipt?.total ?? null, execution: receipt?.execution ?? null, missing_files: [], excluded_files: [] };
  const reject = cause => [{ ...fields, cause }];
  if (!expected?.length) return reject('missing_component_sources');
  if (!receipt || receipt.component !== component || receipt.suite !== 'unit' || receipt.outcome !== 'passed') { fields.missing_files = expected; return reject('missing_or_failed_unit_receipt'); }
  if (JSON.stringify(receipt.source) !== JSON.stringify(identity)) return reject('stale_source_identity');
  if (!Array.isArray(receipt.files) || receipt.files.some(file => !file || typeof file.path !== 'string' || !count(file.covered) || !count(file.total) || file.covered > file.total)) return reject('invalid_file_counts');
  const paths = receipt.files.map(file => file.path);
  fields.missing_files = expected.filter(path => !paths.includes(path));
  fields.excluded_files = paths.filter(path => !expected.includes(path));
  if (new Set(paths).size !== paths.length || fields.missing_files.length || fields.excluded_files.length) return reject('incomplete_source_inventory');
  const covered = receipt.files.reduce((sum, file) => sum + file.covered, 0), total = receipt.files.reduce((sum, file) => sum + file.total, 0);
  if (!count(covered) || !count(total) || receipt.covered !== covered || receipt.total !== total) return reject('inconsistent_raw_counts');
  if (!total || BigInt(covered) * 100n <= BigInt(total) * 90n) return reject('unit_statements_not_strictly_above_90');
  return [];
}

export function collectCoverage(component, { root = rootDirectory, source = inspectSource(root), execution = null, read = readFileSync } = {}) {
  requireThat(Object.hasOwn(source.components, component), 'unknown_or_absent_component');
  const raw = read(join(root, '.artifacts/unit', component, reportName(component)), 'utf8');
  const module = component === 'service' ? /^module (\S+)$/m.exec(read(join(root, 'go.mod'), 'utf8'))?.[1] : null;
  requireThat(component !== 'service' || module, 'missing_go_module');
  const files = component === 'service' ? goFiles(raw, module) : istanbulFiles(JSON.parse(raw), root);
  const receipt = { component, suite: 'unit', source: source.identity, files, covered: files.reduce((sum, file) => sum + file.covered, 0), total: files.reduce((sum, file) => sum + file.total, 0), report: { file: reportName(component), sha256: hash(raw) }, execution, outcome: 'passed' };
  const problems = coverageProblems(receipt, component, source.components[component], source.identity);
  if (problems.length) receipt.outcome = 'failed';
  return { receipt, problems };
}

export function selectShard(component, sha, names, attempt) {
  const prefix = `unit-${sha}-${component}-`;
  const matches = names.filter(name => name.startsWith(prefix)).map(name => ({ name, attempt: Number(name.slice(prefix.length)) }));
  requireThat(matches.length && matches.every(item => Number.isSafeInteger(item.attempt) && item.attempt >= 1 && item.attempt <= attempt), 'missing_or_invalid_shard_attempt');
  const latest = Math.max(...matches.map(item => item.attempt));
  const selected = matches.filter(item => item.attempt === latest);
  requireThat(selected.length === 1, 'ambiguous_latest_shard');
  return selected[0];
}

export function aggregateCoverage({ root = rootDirectory, directory = join(root, '.artifacts/unit'), source = inspectSource(root), env = process.env, read = readFileSync, artifactNames = null } = {}) {
  const problems = [], receipts = [];
  for (const [setting, job] of [['STANDARDS_RESULT', 'standards'], ['UNIT_RESULT', 'unit']]) if (Object.hasOwn(env, setting) && env[setting] !== 'success') problems.push({ component: 'aggregate', suite: 'unit', source: source.identity, job, observed_result: env[setting], cause: 'required_job_not_successful' });
  for (const [component, files] of Object.entries(source.components)) {
    let receipt;
    try {
      const selected = artifactNames ? selectShard(component, source.identity.sha, artifactNames, Number(env.GITHUB_RUN_ATTEMPT ?? '1')) : null;
      const shard = selected ? join(directory, selected.name, component) : join(directory, component);
      receipt = JSON.parse(read(join(shard, 'receipt.json'), 'utf8'));
      const validation = coverageProblems(receipt, component, files, source.identity);
      problems.push(...validation);
      if (validation.length) continue;
      const execution = receipt.execution;
      requireThat(execution?.outcome === 'passed' && execution.log_complete === true && execution.command?.length && execution.tools?.node && count(execution.duration_ms) && Number.isFinite(Date.parse(execution.started_at)) && Number.isFinite(Date.parse(execution.finished_at)), 'missing_execution_evidence');
      const attempt = Number(execution.run_attempt), current = Number(env.GITHUB_RUN_ATTEMPT ?? '1');
      requireThat(execution.run_id === (env.GITHUB_RUN_ID ?? 'local') && Number.isSafeInteger(attempt) && attempt >= 1 && attempt <= current && (!selected || attempt === selected.attempt), 'stale_run_identity');
      const report = read(join(shard, reportName(component)), 'utf8');
      const log = read(join(shard, 'test.log'), 'utf8');
      requireThat(receipt.report?.file === reportName(component) && hash(report) === receipt.report.sha256 && hash(log) === execution.log_sha256, 'missing_or_changed_report_or_log');
      const module = component === 'service' ? /^module (\S+)$/m.exec(read(join(root, 'go.mod'), 'utf8'))?.[1] : null;
      const observed = component === 'service' ? goFiles(report, module) : istanbulFiles(JSON.parse(report), root);
      requireThat(JSON.stringify(observed) === JSON.stringify(receipt.files), 'raw_report_counts_differ');
      receipts.push(receipt);
    } catch (error) {
      problems.push({ component, suite: receipt?.suite ?? 'unit', source: receipt?.source ?? null, expected_source: source.identity, covered: receipt?.covered ?? null, total: receipt?.total ?? null, missing_files: files, excluded_files: [], cause: error.code === 'ENOENT' ? 'missing_shard_report_or_log' : error.message });
    }
  }
  return { receipts, problems };
}

export function reportCoverage({ receipt, problems }, output = logEvent) {
  for (const problem of problems) output(null, 'error', 'ci.coverage_rejected', problem);
  if (receipt) output(null, problems.length ? 'error' : 'info', 'ci.unit_coverage', receipt);
  return problems.length ? 1 : 0;
}

export function main(args = process.argv.slice(2), root = rootDirectory, options = {}) {
  try {
    if (args.length === 2 && args[0] === 'collect') {
      const result = collectCoverage(args[1], { root, ...options });
      const directory = join(root, '.artifacts/unit', args[1]);
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, 'receipt.json'), JSON.stringify(result.receipt, null, 2) + '\n', { mode: 0o600 });
      return reportCoverage(result);
    }
    requireThat((args.length === 1 || args.length === 2) && args[0] === 'aggregate', 'expected_collect_component_or_aggregate');
    const directory = args[1] ? resolve(root, args[1]) : join(root, '.artifacts/unit');
    let artifactNames = null;
    if (args[1]) {
      try { artifactNames = readdirSync(directory); }
      catch (error) { if (error.code !== 'ENOENT') throw error; artifactNames = []; }
    }
    const { receipts, problems } = aggregateCoverage({ root, directory, ...options, ...(args[1] ? { artifactNames } : {}) });
    for (const receipt of receipts) reportCoverage({ receipt, problems: [] });
    return reportCoverage({ problems });
  } catch (error) {
    return reportCoverage({ problems: [{ component: args[1] ?? 'aggregate', suite: 'unit', cause: error.code ?? error.message, missing_files: [], excluded_files: [] }] });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
