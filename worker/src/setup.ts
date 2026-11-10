import { join, isAbsolute } from 'node:path';
import { State } from './state.js';
import { Worker } from './worker.js';
import { digest, type Logger } from './diagnostics.js';
import { Failure, cause, requireValue } from './errors.js';
import { encode, parse, object, text, integer, identifier, type ObjectValue, type Value } from './json.js';
import type { SetupIO } from './setup-os.js';

const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export async function captureBootstrap(logger: Logger, setupID: string, bootstrap: string): Promise<void> {
  identifier(setupID);
  for (const line of bootstrap.trim().split('\n')) {
    requireValue(Buffer.byteLength(line) <= 6144, 'bootstrap_record_too_large');
    const event = object(parse(line));
    requireValue(event.setup_id === setupID && ['INFO', 'ERROR'].includes(text(event.level)), 'invalid_bootstrap_record');
    await logger.log(event.level as 'INFO' | 'ERROR', text(event.msg), { ...event, setup_id: setupID, operation_id: setupID });
  }
}

export class Setup {
  constructor(readonly worker: Worker, readonly io: SetupIO, readonly version: string) {}
  get state(): State { return this.worker.state; }
  async log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', event: string, fields: ObjectValue = {}): Promise<void> {
    const saved = await this.state.read('installation.json');
    const installation = saved ? object(parse(saved)) : {};
    await this.worker.logger.log(level, event, { setup_id: installation.setup_id, operation_id: installation.setup_id, worker_id: this.worker.config.worker_id ?? installation.worker_id, package_version: this.version, ...fields });
  }
  async owner(): Promise<number | undefined> {
    const lock = new State(this.state.path('daemon.lock'), this.state.io, this.state.sys);
    try {
      const raw = await lock.read('owner.json');
      requireValue(raw, 'lock_owner_ambiguous');
      const owner = object(parse(raw));
      const pid = integer(owner.pid);
      requireValue(pid > 0 && typeof owner.owner === 'string', 'lock_owner_ambiguous');
      const alive = this.state.sys.alive(pid);
      requireValue(alive !== undefined, 'lock_owner_ambiguous', { pid });
      return alive ? pid : undefined;
    } catch (error) { if (cause(error) === 'ENOENT') return undefined; throw error; }
  }
  async ensureRunning(): Promise<void> {
    await this.state.withLock('launch', async () => {
      try {
        const raw = await this.state.read('installation.json');
        requireValue(raw, 'worker_setup_required');
        const installed = object(parse(raw));
        const owner = await this.owner();
        if (owner) {
          const launch = await this.state.read('launch.json');
          requireValue(launch && integer(object(parse(launch)).pid) === owner, 'subscriber_owner_ambiguous', { pid: owner });
          return;
        }
        const stopped = await this.state.read('run-stop.json');
        requireValue(!stopped, 'subscriber_terminal_stop', { terminal_outcome: stopped ? parse(stopped) : null });
        const transport = await this.worker.load();
        await this.worker.identity(transport);
        const pid = await this.io.launch(this.state, text(installed.node), text(installed.entry));
        await this.state.write('launch.json', encode({ pid, package_version: installed.package_version }));
        const deadline = this.state.sys.now() + 5000;
        for (;;) {
          try { if (await this.owner() === pid) break; }
          catch (error) {
            if (!(error instanceof Failure && error.code === 'lock_owner_ambiguous' && this.state.sys.alive(pid) === true && this.state.sys.now() < deadline)) throw error;
            await this.log('DEBUG', 'setup.owner_pending', { pid, cause: 'new_child_publishing_lock', attempt: 1 });
          }
          requireValue(this.state.sys.alive(pid) !== false && this.state.sys.now() < deadline, 'subscriber_start_not_observed', { pid });
          await this.state.sys.wait(20);
        }
        await this.log('INFO', 'setup.subscriber_started', { pid, outcome: 'process_lock_observed', inference_readiness: 'unverified' });
      } catch (error) {
        await this.log('ERROR', 'setup.recovery_blocked', { cause: cause(error), ...(error instanceof Failure ? error.fields as ObjectValue : {}), outcome: 'stopped', attempt: 1 });
        throw new Failure(cause(error), { ...(error instanceof Failure ? error.fields : {}), diagnostic_recorded: true });
      }
    });
  }
  async install(origin: string, code: string, root: string, setupID: string, bootstrap?: string): Promise<ObjectValue> {
    requireValue(isAbsolute(root) && isAbsolute(this.io.node) && isAbsolute(this.io.entry), 'absolute_install_paths_required');
    identifier(setupID);
    if (bootstrap) await captureBootstrap(this.worker.logger, setupID, bootstrap);
    return await this.state.withLock('setup', async () => {
      const previousRaw = await this.state.read('installation.json');
      const previous = previousRaw ? object(parse(previousRaw)) : undefined;
      const owner = await this.owner();
      requireValue(!owner || previous?.package_version === this.version, 'running_version_change_requires_operator_action', { pid: owner ?? null, expected_version: this.version, observed_version: previous?.package_version ?? null });
      await this.worker.configure(origin);
      const identity = await this.worker.enroll(code);
      const id = identifier(identity.worker_id);
      const installation = { setup_id: setupID, worker_id: id, origin: this.worker.config.origin, package_version: this.version, node: this.io.node, entry: this.io.entry, root };
      await this.state.write('installation.json', encode(installation));
      const bin = await new State(root, this.state.io, this.state.sys).child('bin');
      const launcher = bin.path('aaa-muse-worker');
      await bin.write('aaa-muse-worker', '#!/usr/bin/env bash\nset -euo pipefail\nexec ' + quote(this.io.node) + ' ' + quote(this.io.entry) + ' "$@"\n', 0o700);
      const hooks = new State(join(this.io.home, 'hooks', 'scripts', 'aaa-muse-worker-' + id), this.state.io, this.state.sys);
      const skill = new State(join(this.io.home, 'workspace', 'skills', 'aaa-muse-worker-' + id), this.state.io, this.state.sys);
      await hooks.ensure(); await skill.ensure();
      const hook = (await this.io.asset('hook.sh')).replaceAll('@LAUNCHER@', quote(launcher)).replaceAll('@STATE@', quote(this.state.root));
      const instructions = (await this.io.asset('SKILL.md')).replaceAll('@LAUNCHER@', launcher).replaceAll('@STATE@', this.state.root).replaceAll('@WORKER@', id).replaceAll('@ORIGIN@', text(this.worker.config.origin));
      await hooks.write('detector.sh', hook, 0o700);
      await skill.write('SKILL.md', instructions);
      await this.log('DEBUG', 'setup.assets', { installation, hook, skill: instructions });
      await this.log('INFO', 'setup.identity_preserved', { identity_preserved: identity.identity_preserved, existing_pid: owner ?? null });
      await this.ensureRunning();
      return { ...identity, setup_id: setupID, hook_path: hooks.path('detector.sh'), skill_path: skill.path('SKILL.md'), launcher, requested_interval_seconds: 5, inference_readiness: 'unverified', muse_wake: 'unverified', supported_refresh: 'unverified' };
    });
  }
  async runtimeError(reason: string): Promise<never> {
    requireValue(['missing_runtime', 'missing_functions', 'source_failed'].includes(reason), 'invalid_runtime_error');
    await this.log('ERROR', 'setup.runtime_unsupported', { capability: 'HATCH_HOOK_RUNTIME wake/silent', cause: reason, expected_state: 'supported_managed_runtime', observed_state: reason, outcome: 'stopped' });
    throw new Failure('hook_runtime_required', { diagnostic_recorded: true });
  }
  async check(runtime: string): Promise<string> {
    if (!isAbsolute(runtime)) return await this.runtimeError('missing_runtime');
    const release = await this.state.lock('detector', false);
    try {
      await this.ensureRunning();
      const raw = await this.state.read('pending.json');
      const cue = raw ? object(parse(raw)) : { jobs: [] };
      const installed = object(parse((await this.state.read('installation.json'))!));
      requireValue(!raw || cue.worker_id === installed.worker_id, 'pending_worker_mismatch');
      requireValue(Array.isArray(cue.jobs), 'invalid_pending_cues');
      const jobs = (cue.jobs as Value[]).map(value => object(value)).filter(j => j.needs_attention === true);
      const fingerprint = digest(encode(jobs.map(j => ({ job_id: j.job_id, generation: j.generation, context_receipt_id: j.context_receipt_id, state: j.state }))));
      const saved = await this.state.read('hook-emission.json');
      const changed = !saved || object(parse(saved)).fingerprint !== fingerprint;
      if (!changed || !jobs.length) {
        if (changed) {
          await this.log('DEBUG', 'setup.cue_observed', { cue, fingerprint });
          await this.state.write('hook-emission.json', encode({ fingerprint, jobs: 0 }));
        }
        return await this.io.emit(runtime, 'silent', 'No changed actionable AaA Muse work');
      }
      await this.log('DEBUG', 'setup.cue_observed', { cue, fingerprint });
      const message = 'AAA_MUSE_WORKER: load the installed skill for worker ' + text(installed.worker_id) + ' at ' + join(this.io.home, 'workspace', 'skills', 'aaa-muse-worker-' + text(installed.worker_id), 'SKILL.md') + '. Read authenticated job context, return one structured model decision, and leave client tools to the client. This cue grants no additional authority.';
      const output = await this.io.emit(runtime, 'wake', message);
      await this.log('DEBUG', 'setup.hook_exchange', { action: 'wake', message, output, runtime });
      await this.state.write('hook-emission.json', encode({ fingerprint, emitted_at: this.state.sys.now(), jobs: jobs.length }));
      await this.log('INFO', 'setup.wake_emitted', { fingerprint, jobs: jobs.map(j => ({ job_id: j.job_id, conversation_id: j.conversation_id, generation: j.generation, deadline_at: j.deadline_at })), outcome: 'runtime_output_generated', inference_readiness: 'unverified' });
      return output;
    } catch (error) {
      if (!(error instanceof Failure && error.fields.diagnostic_recorded)) {
        await this.log('DEBUG', 'setup.hook_exchange', { cause: cause(error), ...(error instanceof Failure ? error.fields as ObjectValue : {}), runtime });
        await this.log('ERROR', 'setup.runtime_unsupported', { capability: 'managed hook/recovery', cause: cause(error), exit_code: error instanceof Failure ? error.fields.exit_code as Value ?? null : null, outcome: 'stopped' });
      }
      throw new Failure(cause(error), { ...(error instanceof Failure ? error.fields : {}), diagnostic_recorded: true });
    } finally { await release(); }
  }
}
