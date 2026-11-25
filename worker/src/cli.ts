import * as fs from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { State, system, type Files, type System } from './state.js';
import { Capture, Logger } from './diagnostics.js';
import { Worker } from './worker.js';
import { Failure, cause, requireValue } from './errors.js';
import { encode, object, parse, identifier, type ObjectValue } from './json.js';
import { presenceTimeoutMs, type Network } from './transport.js';
import { captureBootstrap, installationIO, type InstallationIO } from './install-io.js';
import { Cron } from './cron.js';
import { CronUpdate } from './cron-update.js';
import { HookRunner, type EmitHook } from './hook.js';
import { HookSetup, hookTimeoutSeconds, pollSeconds, watchdogEvery } from './hook-setup.js';
import { HookWatchdog } from './hook-watchdog.js';
import { preflightLegacyUpdate } from './update-archive.js';

import { VERSION } from './version.js';
export { VERSION } from './version.js';
const help = 'aaa-muse-worker setup --origin HTTPS_ORIGIN --code-stdin --install-dir ABSOLUTE_PATH --setup-id ID --archive-digest SHA256 | hook-describe --goal-id ID | hook-upgrade-describe --worker-id ID --goal-id ID | hook-authorize-registration --input FILE|- | hook-confirm --input FILE|- | hook-check | hook-start --launch-id ID --run-id ID | hook-abort --launch-id ID --run-id ID --reason REASON | hook-task-start --launch-id ID --run-id ID | hook-task-finish --task-id ID --input FILE|- | hook-task-abort --launch-id ID --run-id ID --reason REASON [--summary TEXT] | watchdog-check | cron-producer-intent --launch-id ID | status | doctor | media-finish --job-id ID | decision-submit --job-id ID --input FILE|- | diagnostics-export [--operation-id ID] [--request-id ID] [--since RFC3339] [--until RFC3339] [--decode]\nCommon: --state-dir ABSOLUTE_PATH, --help, --version\n';
export interface Adapters {
  files: Files;
  system: System;
  network?: Network;
  setup?: InstallationIO;
  emitHook?: EmitHook;
  env: Record<string, string | undefined>;
  home(): string;
  nodeVersion: string;
  parentPid?: number;
  legacyUpdateState?(): Promise<string | undefined>;
  input(file: string): Promise<string>;
  stdout(line: string): void;
  stderr(line: string): void;
  signal: AbortSignal;
  metadata(): Promise<ObjectValue>;
}
export function argumentsFor(args: string[]): { command: string; flags: Record<string, string | boolean> } {
  const command = args[0] ?? '--help';
  const flags: Record<string, string | boolean> = Object.create(null);
  const allowed: Record<string, string[]> = {
    configure: ['origin'], enroll: ['code-stdin', 'archive-digest'], status: [], doctor: [], 'media-finish': ['job-id'],
    setup: ['origin', 'code-stdin', 'install-dir', 'setup-id', 'bootstrap', 'archive-digest'],
    'decision-submit': ['job-id', 'input'], 'diagnostics-export': ['operation-id', 'request-id', 'since', 'until', 'decode'],
    'hook-describe': ['goal-id'], 'hook-authorize-registration': ['input'], 'hook-confirm': ['input'], 'hook-check': [],
    'hook-upgrade-describe': ['worker-id', 'goal-id'],
    'hook-task-start': ['launch-id', 'run-id'], 'hook-task-finish': ['task-id', 'input'],
    'hook-task-abort': ['launch-id', 'run-id', 'reason', 'summary'],
    'hook-start': ['launch-id', 'run-id'], 'hook-abort': ['launch-id', 'run-id', 'reason'], 'watchdog-check': [],
    'cron-producer-intent': ['launch-id'],
    'cron-producer-bind': ['launch-id', 'producer-id'],
  };
  requireValue(Object.hasOwn(allowed, command) || ['--help', '--version'].includes(command), 'unknown_command');
  for (let i = 1; i < args.length; i++) {
    requireValue(args[i].startsWith('--'), 'unsupported_argument');
    const key = args[i].slice(2);
    requireValue(['state-dir', 'help', 'version', ...(allowed[command] ?? [])].includes(key) && !Object.hasOwn(flags, key), 'unsupported_or_duplicate_option');
    if (['help', 'version', 'code-stdin', 'decode'].includes(key)) flags[key] = true;
    else { requireValue(args[i + 1] !== undefined && !args[i + 1].startsWith('--'), 'option_value_required'); flags[key] = args[++i]; }
  }
  return { command, flags };
}

export async function execute(args: string[], io: Adapters): Promise<number> {
  let logger: Logger | undefined;
  let command = 'parse';
  let setupID: string | undefined;
  try {
    const parsed = argumentsFor(args);
    command = parsed.command;
    const flags = parsed.flags;
    setupID = typeof flags['setup-id'] === 'string' && /^[0-9a-f]{32}$/.test(flags['setup-id']) ? flags['setup-id'] : undefined;
    if (command === '--help' || flags.help) { io.stdout(help); return 0; }
    if (command === '--version' || flags.version) {
      // The published updater invokes the staged candidate with only --version.
      if (args.length === 1 && io.env.HATCH_HOOK_RUNTIME && io.env.HATCH_HOOK_ID) {
        const setup = io.setup ?? installationIO(io.home());
        const inherited = await io.legacyUpdateState?.();
        if (inherited) await preflightLegacyUpdate(setup, new State(inherited, io.files, io.system), VERSION, io.env.HATCH_HOOK_ID);
      }
      io.stdout(VERSION + '\n');
      return 0;
    }
    const match = /^v(\d+)\.(\d+)\./.exec(io.nodeVersion);
    requireValue(match && (Number(match[1]) > 22 || (Number(match[1]) === 22 && Number(match[2]) >= 12)), 'node_22_12_required');
    const xdg = io.env.XDG_STATE_HOME;
    requireValue(!xdg || isAbsolute(xdg), 'absolute_xdg_state_home_required');
    const path = flags['state-dir'] as string | undefined ?? join(xdg || join(io.home(), '.local', 'state'), 'aaa-muse-worker-hook-v1');
    const state = new State(path, io.files, io.system);
    await state.ensure();
    const metadata = await io.metadata();
    const logs = await state.child('diagnostics');
    logger = new Logger(state, new Capture(logs), io.stderr, { package_version: VERSION, node_version: io.nodeVersion, protocol_version: 1, command, command_id: io.system.uuid(), ...metadata, setup_id: flags['setup-id'] as string, operation_id: flags['setup-id'] as string, effective_settings: { request_timeout_ms: 10_000, request_attempts: 3, presence_timeout_ms: presenceTimeoutMs, presence_attempts: 1, capture_level: 'DEBUG', runtime_level: 'INFO', retention_days: 7, capture_max_bytes: 128 * 1024 * 1024, max_body_bytes: 1024 * 1024 } });
    if (command === 'setup' && typeof flags.bootstrap === 'string') {
      requireValue(typeof flags['setup-id'] === 'string', 'setup_id_required');
      await captureBootstrap(logger, flags['setup-id'], await io.input(flags.bootstrap));
    }
    const installedRaw = await state.read('installation.json');
    const installed = installedRaw ? object(parse(installedRaw)) : {};
    Object.assign(logger.base, { setup_id: flags['setup-id'] ?? installed.setup_id, operation_id: flags['setup-id'] ?? installed.setup_id, worker_id: installed.worker_id });
    const credential = await state.read('credential.key');
    if (credential) logger.redactor.add(credential.trim());
    const worker = new Worker(state, logger, io.network, VERSION, true);
    const setup = io.setup ?? installationIO(io.home());
    const updater = new CronUpdate(worker, setup);
    const cron = new Cron(worker, undefined, updater);
    const hook = new HookRunner(cron, updater, io.emitHook);
    const hookSetup = new HookSetup(worker, setup);
    const finiteCheck = command === 'hook-check' || command === 'watchdog-check';
    if (finiteCheck) Object.assign(logger.base, { hook_id: io.env.HATCH_HOOK_ID, hook_invocation_id: io.env.HATCH_HOOK_INVOCATION_ID,
      hook_poll_seconds: pollSeconds, hook_timeout_seconds: hookTimeoutSeconds, watchdog_every: watchdogEvery });
    if (!finiteCheck) await logger.log('INFO', 'worker.command_started');
    let result: ObjectValue;
    switch (command) {
      case 'setup': {
        requireValue(flags['code-stdin'] && typeof flags.origin === 'string' && typeof flags['install-dir'] === 'string' &&
          typeof flags['setup-id'] === 'string' && typeof flags['archive-digest'] === 'string', 'setup_options_required');
        result = await hookSetup.install(flags.origin, (await io.input('-')).trim(), flags['install-dir'], flags['setup-id'], flags['archive-digest']);
        break;
      }
      case 'hook-describe':
        result = await hookSetup.describe(identifier(flags['goal-id'] as string));
        break;
      case 'hook-upgrade-describe':
        result = await hookSetup.describeUpgrade(identifier(flags['worker-id'] as string), identifier(flags['goal-id'] as string));
        break;
      case 'hook-confirm':
      case 'hook-authorize-registration': {
        requireValue(typeof flags.input === 'string', 'hook_input_required');
        const raw = await io.input(flags.input);
        result = command === 'hook-confirm' ? await hookSetup.confirm(raw) : await hookSetup.authorizeRegistration(raw);
        break;
      }
      case 'hook-check':
        io.stdout(await hook.check(io.env));
        return 0;
      case 'hook-start':
        requireValue(typeof flags['run-id'] === 'string', 'hook_run_id_required');
        result = await hook.start(identifier(flags['launch-id'] as string), flags['run-id']);
        break;
      case 'hook-abort':
        requireValue(typeof flags['run-id'] === 'string' && typeof flags.reason === 'string', 'hook_abort_options_required');
        result = await hook.abort(identifier(flags['launch-id'] as string), flags['run-id'], flags.reason);
        break;
      case 'hook-task-start':
        requireValue(typeof flags['run-id'] === 'string', 'hook_run_id_required');
        result = await hook.tasks.start(identifier(flags['launch-id'] as string), flags['run-id']);
        break;
      case 'hook-task-finish':
        requireValue(typeof flags.input === 'string', 'task_result_input_required');
        result = await hook.tasks.finish(identifier(flags['task-id'] as string), await io.input(flags.input));
        break;
      case 'hook-task-abort':
        requireValue(typeof flags['run-id'] === 'string' && typeof flags.reason === 'string', 'hook_abort_options_required');
        result = await hook.tasks.abort(identifier(flags['launch-id'] as string), flags['run-id'], flags.reason, (flags.summary as string | undefined) ?? '');
        break;
      case 'watchdog-check':
        result = await new HookWatchdog(worker).check();
        break;
      case 'cron-producer-intent':
        result = await cron.producerIntent(identifier(flags['launch-id'] as string));
        break;
      case 'cron-producer-bind':
        result = await cron.producer(identifier(flags['launch-id'] as string), identifier(flags['producer-id'] as string), io.parentPid ?? 0, true);
        break;
      case 'configure':
        requireValue(typeof flags.origin === 'string', 'origin_required');
        result = await worker.configure(flags.origin);
        break;
      case 'enroll':
        requireValue(flags['code-stdin'], 'code_stdin_required');
        result = await worker.enroll((await io.input('-')).trim(), undefined, flags['archive-digest'] as string | undefined);
        break;
      case 'status':
      case 'doctor': {
        const transport = await worker.load();
        const record = await worker.identity(transport);
        result = { worker: record, pending_work: record.current_claim ?? null, inference_readiness: record.inference_readiness, ...(command === 'doctor' ? { state_permissions: 'verified', runtime: io.nodeVersion, transport: 'authenticated_https', muse_runtime: 'unverified', wake: 'unverified', recovery: 'unverified' } : {}) };
        break;
      }
      case 'media-finish':
        result = await cron.submit(identifier(flags['job-id'] as string));
        break;
      case 'decision-submit':
        requireValue(typeof flags['job-id'] === 'string' && typeof flags.input === 'string', 'decision_input_required');
        result = await cron.submit(identifier(flags['job-id']), await io.input(flags.input));
        break;
      default: {
        const filter: Record<string, string> = {};
        for (const key of ['operation-id', 'request-id', 'since', 'until']) if (flags[key]) filter[key.replace('-', '_')] = key.endsWith('-id') ? identifier(flags[key] as string) : flags[key] as string;
        io.stdout(await logger.capture.export(filter, flags.decode === true));
        await logger.log('INFO', 'worker.export_completed', { filter });
        return 0;
      }
    }
    await logger.log(finiteCheck ? 'DEBUG' : 'INFO', 'worker.command_completed', { outcome: 'success' });
    io.stdout(encode(logger.redactor.value(result, '', false)) + '\n');
    return 0;
  } catch (error) {
    const code = cause(error);
    const event = { stopped_operation: command, cause: code, ...(error instanceof Failure ? error.fields : {}) };
    if (logger && code !== 'diagnostics_unavailable' && !(error instanceof Failure && error.fields.diagnostic_recorded)) {
      const refusal = ['update_required', 'hook_broker_unavailable', 'hook_run_mismatch', 'work_already_started', 'hook_abort_uncertain', 'hook_abort_producer_active',
        'stale_hook_launch', 'broker_rejected'].includes(code);
      try { await logger.log(refusal ? 'WARN' : 'ERROR', code === 'update_required' ? 'worker.update_required' : code === 'state_unsafe' ? 'worker.state_unsafe' : 'worker.command_failed', event); }
      catch { return 1; }
    } else if (!logger) io.stderr(encode({ level: 'ERROR', msg: code === 'state_unsafe' ? 'worker.state_unsafe' : 'worker.command_failed',
      package_version: VERSION, setup_id: setupID, protected_capture_unavailable: true, ...event }) + '\n');
    return 1;
  }
}

export async function main(args = process.argv.slice(2)): Promise<number> {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  try {
    return await execute(args, {
      files: fs, system, env: process.env, home: homedir, nodeVersion: process.version, parentPid: process.ppid, signal: controller.signal,
      async legacyUpdateState() {
        const args = (await fs.readFile(`/proc/${process.ppid}/cmdline`, 'utf8')).slice(0, -1).split('\0');
        if (args[2] === 'hook-check' && args.at(-2) === '--state-dir') return args.at(-1);
      },
      stdout: line => { process.stdout.write(line); }, stderr: line => { process.stderr.write(line); },
      async metadata() { return object(parse(await fs.readFile(fileURLToPath(new URL('./build.json', import.meta.url)), 'utf8'))); },
      async input(file) {
        if (file !== '-') {
          const handle = await fs.open(file, 'r');
          try { requireValue((await handle.stat()).size <= 1024 * 1024, 'body_too_large'); return new TextDecoder('utf8', { fatal: true }).decode(await handle.readFile()); }
          finally { await handle.close(); }
        }
        const chunks: Buffer[] = [];
        let length = 0;
        for await (const chunk of process.stdin) { length += chunk.length; requireValue(length <= 1024 * 1024, 'body_too_large'); chunks.push(chunk); }
        return new TextDecoder('utf8', { fatal: true }).decode(Buffer.concat(chunks));
      },
    });
  } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}
