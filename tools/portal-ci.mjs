import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, parse, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { logEvent } from '../.github/scripts/ci-log.mjs';
import { inspectSource } from './source-inventory.mjs';

const widths = [1440, 768, 390];
const shards = {
  shell: {
    suite: 'portal', receipt: 'receipt.json',
    screenshots: /^(login(?:-dark)?|settings(?:-dark)?|error|client-keys)-(1440|768|390)\.png$/,
    cases: [
      'runtime.identity', 'runtime.rootfs', 'portal.log_only_asset_diagnosis', 'portal.credential_and_configuration_boundaries',
      'portal.log_only_database_diagnosis', 'portal.process_local_sessions', 'portal.cookie_authority_shared_and_revocable',
      'portal.cookie_log_only_store_failure', 'portal.password_rotation_invalidates_browser_grants', 'portal.log_only_browser_diagnosis',
      'portal.log_only_auth_diagnosis', 'portal.capture_protection', 'portal.log_only_config_write_failure', 'portal.shared_client_keys',
      'portal.browser_viewport', 'portal.reload_and_new_tab_restore_session', 'portal.logout_invalidates_server_session_and_other_tabs',
      'portal.unconfirmed_logout_can_be_retried', 'portal.late_response_is_fenced_after_logout',
      'portal.remembered_session_survives_broker_restart', 'portal.chromium_profile_relaunch',
      'portal.browser_session_check_retries_real_sqlite_outage', 'portal.no_browser_logout_timer',
      'portal.browser_request_deadline', 'portal.browser_client_keys_and_origins', 'portal.http_setup_explanation',
    ],
    viewportCases: ['portal.browser_viewport'],
  },
  workers: {
    suite: 'portal-workers', receipt: 'workers-receipt.json',
    screenshots: /^workers-(empty|list|detail(?:-dark)?|revoke|error|remote)-(1440|768|390)\.png$/,
    cases: [
      'runtime.identity', 'portal.workers_controlled_activity', 'portal.worker_server_expiry', 'portal.worker_role_and_shell_boundaries',
      'portal.worker_log_only_diagnosis', 'portal.worker_capture_protection', 'portal.worker_remote_task', 'portal.workers_empty',
      'portal.worker_drawer_dismissal', 'portal.workers_actions', 'portal.worker_offline_timer',
      'portal.worker_ordering_and_uncertainty', 'portal.revocation_response_loss_and_stale_poll',
      'portal.worker_revoked_from_another_browser_closes_both_dialogs', 'portal.worker_outage_recovery_and_denial',
      'portal.worker_browser_enrollment_expiry', 'portal.worker_late_response_after_logout', 'portal.worker_request_deadline',
    ],
    viewportCases: [
      'portal.worker_remote_task', 'portal.workers_empty', 'portal.worker_drawer_dismissal', 'portal.workers_actions',
      'portal.worker_offline_timer', 'portal.worker_ordering_and_uncertainty', 'portal.revocation_response_loss_and_stale_poll',
    ],
  },
  history: {
    suite: 'portal-history', receipt: 'history-receipt.json',
    screenshots: /^history-(empty|list|detail|cancel|error)-(1440|768|390)\.png$/,
    cases: [
      'runtime.identity', 'portal.history_media_projections', 'portal.history_native_tool_linkage', 'portal.history_json_payload_fidelity',
      'portal.history_equal_timestamp_database_pages', 'portal.history_recorded_replacement_boundaries',
      'portal.history_cancellation_authority', 'portal.history_log_only_diagnosis', 'portal.history_browser_log_only_diagnosis',
      'portal.history_capture_protection', 'portal.history_empty', 'portal.history_media_job_progress',
      'portal.history_nul_native_and_legacy', 'portal.history_text_tools_instructions_and_cancellation',
      'portal.history_reassignment_and_interrupted_boundaries', 'portal.history_pagination_failure_recovery',
      'portal.history_pagination_and_concurrent_arrivals', 'portal.history_selection_cancellation_and_scroll_ordering',
      'portal.history_cancellation_completion_race_and_response_loss', 'portal.history_actual_timeline_render_failure',
      'portal.history_outage_malformed_timeout_stale_and_session_continuity', 'portal.history_invalid_session_and_late_logout',
    ],
    viewportCases: ['portal.history_empty', 'portal.history_nul_native_and_legacy', 'portal.history_text_tools_instructions_and_cancellation'],
  },
};

class PortalError extends Error {
  constructor(cause, fields = {}) {
    super(cause);
    this.fields = fields;
  }
}

const reject = (cause, fields) => { throw new PortalError(cause, fields); };
const requireThat = (condition, cause, fields) => { if (!condition) reject(cause, fields); };
const safeAttempt = value => typeof value === 'string' && Number.isSafeInteger(Number(value)) && Number(value) > 0 && String(Number(value)) === value ? Number(value) : null;
const safeSource = value => value && typeof value === 'object' && !Array.isArray(value) &&
  typeof value.sha === 'string' && value.sha.length === 40 && /^[a-f0-9]{40}$/.test(value.sha) && typeof value.dirty === 'boolean' &&
  typeof value.tree_sha256 === 'string' && value.tree_sha256.length === 64 && /^[a-f0-9]{64}$/.test(value.tree_sha256)
  ? { sha: value.sha, dirty: value.dirty, tree_sha256: value.tree_sha256 } : null;
const safeResult = value => ['success', 'failure', 'cancelled', 'skipped'].includes(value) ? value : value == null ? null : '[REDACTED]';
const allowedScreenshot = (spec, name) => spec.screenshots.exec(name)?.[0] === name;

function redact(value, env) {
  const secrets = Object.entries(env).filter(([name, secret]) => /TOKEN|PASSWORD|SECRET|AUTH|KEY/i.test(name) && typeof secret === 'string' && secret).map(([, secret]) => secret);
  const scrub = item => {
    if (typeof item === 'string') {
      let result = item.replace(/muse_(?:worker|enroll|portal|download)_[A-Za-z0-9_-]{43}/g, '[REDACTED]');
      for (const secret of secrets) result = result.split(secret).join('[REDACTED]');
      return result;
    }
    if (Array.isArray(item)) return item.map(scrub);
    if (item && typeof item === 'object') return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, scrub(entry)]));
    return item;
  };
  return scrub(value);
}

function contextFor(source, env) {
  const expected = safeSource(source);
  const attempt = safeAttempt(env.GITHUB_RUN_ATTEMPT ?? '1');
  const runID = env.GITHUB_RUN_ID ?? 'local';
  const context = {
    shard: null, expected_source: expected, observed_source: null,
    run_id: typeof runID === 'string' && /^(?:local|[1-9][0-9]{0,19})$/.exec(runID)?.[0] === runID ? runID : null,
    expected_attempt_bound: attempt, observed_attempt: null,
    portal_cases_result: safeResult(env.PORTAL_CASES_RESULT), unsafe_path: null,
  };
  requireThat(expected && isDeepStrictEqual(expected, source), 'invalid_source_identity', context);
  requireThat(!Object.hasOwn(env, 'SOURCE_SHA') || env.SOURCE_SHA === source.sha, 'source_mismatch', context);
  requireThat(context.run_id && attempt, 'invalid_run_identity', context);
  return context;
}

function directoryPath(path, allowMissing = false) {
  const absolute = resolve(path), root = parse(absolute).root;
  let current = root;
  for (const part of absolute.slice(root.length).split(sep).filter(Boolean)) {
    current = join(current, part);
    let entry;
    try { entry = lstatSync(current); }
    catch (error) { if (allowMissing && error.code === 'ENOENT') return; throw error; }
    requireThat(entry.isDirectory() && !entry.isSymbolicLink(), 'unsafe_path', { unsafe_path: '[REDACTED]' });
  }
}

function regularFile(path) {
  const entry = lstatSync(path);
  requireThat(entry.isFile() && !entry.isSymbolicLink(), 'unsafe_path', { unsafe_path: '[REDACTED]' });
  const file = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    requireThat(fstatSync(file).isFile(), 'unsafe_path', { unsafe_path: '[REDACTED]' });
    return readFileSync(file);
  } finally { closeSync(file); }
}

function checkLayout(root, shard) {
  const spec = shards[shard];
  for (const name of readdirSync(root)) {
    requireThat(name === spec.receipt || name === 'screens', 'unexpected_file', { shard, unsafe_path: '[REDACTED]' });
    const path = join(root, name);
    if (name === 'screens') {
      directoryPath(path);
      for (const screenshot of readdirSync(path)) {
        requireThat(allowedScreenshot(spec, screenshot), 'unexpected_file', { shard, unsafe_path: '[REDACTED]' });
        const entry = lstatSync(join(path, screenshot));
        requireThat(entry.isFile() && !entry.isSymbolicLink(), 'unsafe_path', { shard, unsafe_path: '[REDACTED]' });
      }
    } else {
      const entry = lstatSync(path);
      requireThat(entry.isFile() && !entry.isSymbolicLink(), 'unsafe_path', { shard, unsafe_path: '[REDACTED]' });
    }
  }
}

function selectShards(directory, source, bound) {
  const selected = {};
  for (const name of readdirSync(directory)) {
    const shard = Object.keys(shards).find(key => name.startsWith(`portal-shard-${source.sha}-${key}-`));
    requireThat(shard, 'unexpected_artifact', { unsafe_path: '[REDACTED]' });
    const attempt = safeAttempt(name.slice(`portal-shard-${source.sha}-${shard}-`.length));
    requireThat(attempt && attempt <= bound, 'invalid_shard_attempt', { shard, observed_attempt: attempt });
    const path = join(directory, name);
    try { directoryPath(path); checkLayout(path, shard); }
    catch (error) {
      if (error instanceof PortalError) error.fields = { shard, observed_attempt: attempt, ...error.fields };
      throw error;
    }
    if (!selected[shard] || attempt > selected[shard].attempt) selected[shard] = { name, attempt };
  }
  return selected;
}

function validateReceipt(receipt, shard, source, runID, attempt) {
  const spec = shards[shard], fields = { shard, observed_source: safeSource(receipt?.working_source), observed_attempt: safeAttempt(receipt?.run_attempt) };
  requireThat(receipt && typeof receipt === 'object' && !Array.isArray(receipt) && receipt.suite === spec.suite && receipt.outcome === 'passed', 'shard_failed', fields);
  requireThat(isDeepStrictEqual(receipt.working_source, source) && receipt.source_sha === source.sha && receipt.source_dirty === String(source.dirty), 'source_mismatch', fields);
  requireThat(receipt.run_id === runID && safeAttempt(receipt.run_attempt) === attempt, 'run_identity_mismatch', fields);
  requireThat(Array.isArray(receipt.cleanup?.failures) && receipt.cleanup.failures.length === 0, 'cleanup_failed', fields);
  if (shard === 'history' || Object.hasOwn(receipt, 'peer_cleanup_failures')) {
    requireThat(Array.isArray(receipt.peer_cleanup_failures) && receipt.peer_cleanup_failures.length === 0, 'peer_cleanup_failed', fields);
  }
  requireThat(Array.isArray(receipt.cases) && receipt.cases.length > 0 && receipt.cases.every(item =>
    item && typeof item === 'object' && !Array.isArray(item) && typeof item.case === 'string' && item.case.trim() && item.outcome === 'passed'), 'case_failed', fields);
  requireThat(spec.cases.every(name => receipt.cases.some(item => item.case === name)), 'required_case_missing', fields);
  requireThat(spec.viewportCases.every(name => widths.every(width => receipt.cases.some(item => item.case === name && item.width === width))), 'required_viewport_missing', fields);
}

function collectShard(directory, selected, shard, source, runID) {
  const spec = shards[shard], root = join(directory, selected.name), entries = readdirSync(root);
  requireThat(entries.every(name => name === spec.receipt || name === 'screens'), 'unexpected_file', { shard, unsafe_path: '[REDACTED]' });
  requireThat(entries.includes(spec.receipt), 'missing_receipt', { shard });
  requireThat(entries.includes('screens'), 'missing_screenshots', { shard });
  const raw = regularFile(join(root, spec.receipt));
  let receipt;
  try { receipt = JSON.parse(raw.toString('utf8')); }
  catch { reject('invalid_receipt', { shard }); }
  validateReceipt(receipt, shard, source, runID, selected.attempt);
  const screenDirectory = join(root, 'screens');
  directoryPath(screenDirectory);
  const names = readdirSync(screenDirectory);
  requireThat(names.length > 0, 'missing_screenshots', { shard });
  const files = [{ name: spec.receipt, contents: raw }];
  for (const name of names) {
    requireThat(allowedScreenshot(spec, name), 'unexpected_file', { shard, unsafe_path: '[REDACTED]' });
    const contents = regularFile(join(screenDirectory, name));
    requireThat(contents.length > 0, 'empty_screenshot', { shard });
    files.push({ name: join('screens', name), contents });
  }
  return files;
}

function overlaps(first, second) {
  const path = relative(first, second);
  return path === '' || (path !== '..' && !path.startsWith('..' + sep) && !parse(path).root);
}

function stageFiles(directory, destination, files) {
  const input = resolve(directory), output = resolve(destination);
  requireThat(!overlaps(input, output) && !overlaps(output, input), 'overlapping_paths', { unsafe_path: '[REDACTED]' });
  directoryPath(output, true);
  try { requireThat(readdirSync(output).length === 0, 'destination_not_empty', { unsafe_path: '[REDACTED]' }); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  mkdirSync(output, { recursive: true, mode: 0o700 });
  mkdirSync(join(output, 'screens'), { mode: 0o700 });
  for (const file of files) writeFileSync(join(output, file.name), file.contents, { flag: 'wx', mode: 0o600 });
}

function problem(error, context, fields = {}) {
  return { ...context, ...fields, ...(error instanceof PortalError ? error.fields : {}), cause: error instanceof PortalError ? error.message : 'filesystem_error' };
}

export function aggregatePortal({ directory, destination, source, env = process.env }) {
  const context = contextFor(source, env), problems = [], files = [], attempts = {};
  if (env.PORTAL_CASES_RESULT !== 'success') problems.push(problem(new PortalError('portal_cases_not_successful'), context));
  let selected;
  try {
    directoryPath(directory);
    selected = selectShards(directory, source, context.expected_attempt_bound);
  } catch (error) {
    problems.push(problem(error.code === 'ENOENT' ? new PortalError('missing_shard') : error, context));
    return { problems, attempts };
  }
  for (const shard of Object.keys(shards)) {
    if (!selected[shard]) {
      problems.push(problem(new PortalError('missing_shard'), context, { shard }));
      continue;
    }
    attempts[shard] = selected[shard].attempt;
    try { files.push(...collectShard(directory, selected[shard], shard, source, context.run_id)); }
    catch (error) { problems.push(problem(error, context, { shard, observed_attempt: selected[shard].attempt })); }
  }
  if (!problems.length) {
    try { stageFiles(directory, destination, files); }
    catch (error) { problems.push(problem(error, context)); }
  }
  return { problems, attempts, context };
}

export function main(args = process.argv.slice(2), { source = () => inspectSource().identity, env = process.env, logger = logEvent } = {}) {
  try {
    requireThat(args.length === 2, 'expected_input_and_output');
    const result = aggregatePortal({ directory: args[0], destination: args[1], source: source(), env });
    for (const entry of result.problems) logger(null, 'error', 'ci.portal_rejected', redact(entry, env));
    if (result.problems.length) return 1;
    logger(null, 'info', 'ci.portal_verified', redact({ ...result.context, attempts: result.attempts }, env));
    return 0;
  } catch (error) {
    logger(null, 'error', 'ci.portal_rejected', redact(problem(error, {
      shard: null, expected_source: null, observed_source: null, run_id: null, expected_attempt_bound: null,
      observed_attempt: null, portal_cases_result: safeResult(env.PORTAL_CASES_RESULT), unsafe_path: null,
    }), env));
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
