import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { logEvent } from '../.github/scripts/ci-log.mjs';
import { inspectSource } from './source-inventory.mjs';
import { aggregateCoverage, collectCoverage, hash, reportCoverage, reportName, rootDirectory } from './coverage-policy.mjs';

export function unitCommand(component, source, root) {
  if (component === 'service') return ['make', 'test-service-unit'];
  if (component === 'worker' || component === 'portal') return ['npm', 'run', 'test:unit', '--workspace', component];
  const directory = { 'ci-helpers': '.github/scripts', tools: 'tools', 'worker-scripts': 'worker/scripts' }[component];
  if (!directory) throw new Error('unknown_component');
  const tests = source.paths.filter(path => path.startsWith(directory + '/') && path.endsWith('.test.mjs'));
  if (!tests.length) throw new Error('missing_component_unit_tests');
  return [process.execPath, join(root, 'node_modules/c8/bin/c8.js'), '--all', '--include=' + directory + '/**/*.mjs', '--exclude=**/*.test.mjs', '--exclude=**/test/**', '--exclude=**/tests/**', '--reporter=json', '--reporter=text', '--temp-directory=.artifacts/unit-v8/' + component, '--reports-dir=.artifacts/unit/' + component, process.execPath, '--test', ...tests];
}

export function safeLog(raw, env = process.env) {
  let result = raw.replace(/muse_(?:worker|enroll)_[A-Za-z0-9_-]{43}/g, '[REDACTED]').replace(/(Bearer\s+)[^\s"']+/gi, '$1[REDACTED]');
  for (const [key, value] of Object.entries(env)) if (/TOKEN|PASSWORD|SECRET|AUTH|KEY/i.test(key) && value) result = result.split(value).join('[REDACTED]');
  return result;
}

export function runUnit(component, { root = rootDirectory, env = process.env, spawn = spawnSync, inspect = inspectSource, now = Date.now, output = text => process.stdout.write(text) } = {}) {
  const started = now();
  const source = inspect(root);
  const directory = join(root, '.artifacts/unit', component);
  if (!Object.hasOwn(source.components, component)) throw new Error('unknown_or_absent_component');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const execution = { command: [], tools: { node: process.version }, started_at: new Date(started).toISOString(), run_id: env.GITHUB_RUN_ID ?? 'local', run_attempt: env.GITHUB_RUN_ATTEMPT ?? '1', outcome: 'failed', log_complete: true };
  let log = '', receipt, problems = [];
  try {
    execution.command = unitCommand(component, source, root);
    const result = spawn(execution.command[0], execution.command.slice(1), { cwd: root, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024, timeout: 25 * 60 * 1000 });
    log = safeLog((result.stdout ?? '') + (result.stderr ?? ''), env);
    execution.exit_code = result.status;
    execution.signal = result.signal ?? null;
    execution.log_complete = !result.error;
    execution.tools.c8 = JSON.parse(readFileSync(join(root, 'node_modules/c8/package.json'), 'utf8')).version;
    if (component === 'service') execution.tools.go = readFileSync(join(directory, 'go-version.txt'), 'utf8').trim();
    if (result.error || result.status !== 0 || result.signal) throw new Error(result.error?.code ?? 'unit_command_failed');
    if (statSync(join(directory, reportName(component))).mtimeMs < started) throw new Error('unit_report_not_written_by_command');
    if (JSON.stringify(inspect(root).identity) !== JSON.stringify(source.identity)) throw new Error('source_changed_during_unit_run');
    execution.outcome = 'passed';
    ({ receipt, problems } = collectCoverage(component, { root, source, execution }));
  } catch (error) {
    execution.outcome = 'failed';
    execution.cause = error.code ?? error.message;
    problems = [{ component, suite: 'unit', source: source.identity, covered: null, total: null, missing_files: source.components[component], excluded_files: [], cause: error.code ?? error.message }];
    receipt = { component, suite: 'unit', source: source.identity, files: [], covered: 0, total: 0, outcome: 'failed', execution };
  }
  execution.finished_at = new Date(now()).toISOString();
  execution.duration_ms = now() - started;
  execution.log_sha256 = hash(log);
  if (problems.length) { execution.outcome = 'failed'; execution.cause ??= problems[0].cause; }
  writeFileSync(join(directory, 'test.log'), log, { mode: 0o600 });
  writeFileSync(join(directory, 'receipt.json'), JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600 });
  const published = join(root, '.artifacts/ci/unit', component);
  mkdirSync(published, { recursive: true, mode: 0o700 });
  for (const name of ['receipt.json', 'test.log', ...(receipt.report ? [receipt.report.file] : [])]) copyFileSync(join(directory, name), join(published, name));
  output(log);
  return reportCoverage({ receipt, problems });
}

export function main(args = process.argv.slice(2), options = {}) {
  const root = options.root ?? rootDirectory;
  try {
    if (args.length !== 1) throw new Error('expected_component_all_or_list');
    const source = (options.inspect ?? inspectSource)(root);
    if (args[0] === 'list') { console.log(JSON.stringify(Object.keys(source.components))); return 0; }
    if (args[0] !== 'all') return runUnit(args[0], options);
    for (const component of Object.keys(source.components)) if (runUnit(component, options)) return 1;
    return reportCoverage(aggregateCoverage({ root, source, env: options.env }));
  } catch (error) {
    logEvent(null, 'error', 'ci.coverage_rejected', { component: args[0] ?? null, suite: 'unit', cause: error.code ?? error.message, missing_files: [], excluded_files: [] });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
