import { join, isAbsolute } from 'node:path';
import { State } from './state.js';
import { Worker } from './worker.js';
import { Failure, cause, requireValue } from './errors.js';
import { encode, parse, object, text, integer, identifier, type ObjectValue, type Value } from './json.js';
import { maxModelReportBytes } from './protocol.js';
import type { SetupIO } from './setup-os.js';
import { beginHookPoll, finishHookPoll, installedPaths, readActionable, readObject, readOwnership, watchdogSettings } from './health.js';
import { captureBootstrap } from './install-io.js';

const quote = (value: string): string => "'" + value.replaceAll("'", "'\"'\"'") + "'";

export class Setup {
  constructor(readonly worker: Worker, readonly io: SetupIO, readonly version: string) {}
  get state(): State { return this.worker.state; }
  registrationReceipt(root: string, workerID: string): ObjectValue {
    const paths = installedPaths(root, this.io.home, workerID);
    return { hook_path: join(paths.hookDirectory, 'detector.sh'), skill_path: join(paths.skillDirectory, 'SKILL.md'), launcher: paths.launcher,
      state_dir: this.state.root, requested_interval_seconds: 5, watchdog: {
        id: 'aaa-muse-worker-watchdog', interval_seconds: watchdogSettings.schedule_seconds, timeout_seconds: watchdogSettings.timeout_seconds,
        command: quote(paths.launcher) + ' watchdog-check --state-dir ' + quote(this.state.root), registration: 'unverified',
      } };
  }
  async log(level: 'INFO' | 'WARN' | 'ERROR' | 'DEBUG', event: string, fields: ObjectValue = {}): Promise<void> {
    const saved = await this.state.read('installation.json');
    const installation = saved ? object(parse(saved)) : {};
    await this.worker.logger.log(level, event, { setup_id: installation.setup_id, operation_id: installation.setup_id, worker_id: this.worker.config.worker_id ?? installation.worker_id, package_version: this.version, ...fields });
  }
  async owner(): Promise<number | undefined> {
    const owner = await this.state.lockOwner('daemon');
    if (!owner) return undefined;
    const alive = this.state.sys.alive(owner.pid);
    requireValue(alive !== undefined, 'lock_owner_ambiguous', { pid: owner.pid });
    return alive ? owner.pid : undefined;
  }
  async ensureRunning(watchdogAttempt?: number): Promise<void> {
    await this.state.withLock('launch', async () => {
      try {
        const installed = await readObject(this.state, 'installation.json');
        requireValue(installed, 'worker_setup_required');
        const { status, owner: _owner, ...ownership } = await readOwnership(this.state);
        requireValue(status !== 'ambiguous', ownership.lock_pid_alive === null ? 'lock_owner_ambiguous' : 'subscriber_owner_ambiguous', ownership);
        if (status === 'live') return;
        const stopped = await readObject(this.state, 'run-stop.json');
        requireValue(!stopped, 'subscriber_terminal_stop', { terminal_outcome: stopped ?? null });
        const transport = await this.worker.load();
        const identity = await this.worker.identity(transport);
        requireValue(identity.id === installed.worker_id, 'worker_identity_mismatch');
        const startedAt = this.state.sys.now();
        const pid = await this.io.launch(this.state, text(installed.node), text(installed.entry));
        await this.state.write('launch.json', encode({ pid, started_at: startedAt, package_version: installed.package_version }));
        const deadline = this.state.sys.now() + 5000;
        for (;;) {
          try { if (await this.owner() === pid) break; }
          catch (error) {
            if (!(error instanceof Failure && error.code === 'lock_owner_ambiguous' && this.state.sys.alive(pid) === true && this.state.sys.now() < deadline)) throw error;
            await this.log('DEBUG', 'setup.owner_pending', { pid, cause: 'new_child_publishing_lock', attempt: watchdogAttempt ?? 1 });
          }
          const exited = this.state.sys.alive(pid) === false;
          if (exited || this.state.sys.now() >= deadline) throw new Failure('subscriber_start_not_observed', { pid, exited });
          await this.state.sys.wait(20);
        }
        await this.log('INFO', 'setup.subscriber_started', { pid, attempt: watchdogAttempt ?? 1, outcome: 'process_lock_observed', inference_readiness: 'unverified' });
      } catch (error) {
        if (watchdogAttempt !== undefined) throw error;
        await this.log('ERROR', 'setup.recovery_blocked', { cause: cause(error), ...(error instanceof Failure ? error.fields as ObjectValue : {}), outcome: 'stopped', attempt: 1 });
        throw new Failure(cause(error), { ...(error instanceof Failure ? error.fields : {}), diagnostic_recorded: true }, error instanceof Failure && error.retryable);
      }
    });
  }
  private async probe(state: State, capability: string, asset?: string, mode: 0o600 | 0o700 = 0o600): Promise<void> {
    try {
      if (asset) {
        try { await state.check(state.path(asset), false, mode); }
        catch (error) { if (cause(error) !== 'ENOENT') throw error; }
      }
      const name = '.preflight-' + state.sys.uuid();
      await state.write(name, 'setup\n');
      await state.remove(name);
    } catch (error) {
      throw new Failure('state_unsafe', { ...(error instanceof Failure ? error.fields : {}), capability,
        expected_state: 'private_atomic_write', observed_state: 'refused', cause: cause(error) });
    }
  }
  private async prepareAssets(root: string, id: string) {
    const paths = installedPaths(root, this.io.home, id);
    const hooks = new State(paths.hookDirectory, this.state.io, this.state.sys);
    const skill = new State(paths.skillDirectory, this.state.io, this.state.sys);
    await this.io.prepareDirectory(hooks.root, 'hook_directory', id);
    await this.probe(hooks, 'hook_directory', 'detector.sh', 0o700);
    await this.io.prepareDirectory(skill.root, 'skill_directory', id);
    await this.probe(skill, 'skill_directory', 'SKILL.md');
    return { hooks, skill };
  }
  private async modelReport(raw: string, setupID: string, workerID: string): Promise<ObjectValue | undefined> {
    if (!raw) return undefined;
    try {
      requireValue(Buffer.byteLength(raw) <= maxModelReportBytes, 'model_report_too_large');
      const report = object(parse(raw));
      requireValue(Object.keys(report).every(key => key === 'model_name' || key === 'context_window_tokens'), 'unsupported_model_report_fields');
      const result: ObjectValue = {};
      if (report.model_name !== undefined) {
        const name = text(report.model_name);
        requireValue(name.trim() && Buffer.byteLength(name) <= 128 && !/\p{Cc}/u.test(name), 'invalid_model_name');
        requireValue(this.worker.logger.redactor.text(name) === name, 'model_name_contains_credential');
        result.model_name = name;
      }
      if (report.context_window_tokens !== undefined) {
        const window = integer(report.context_window_tokens);
        requireValue(window > 0, 'invalid_context_window');
        result.context_window_tokens = window;
      }
      if (Object.keys(result).length === 0) return undefined;
      result.reported_at = new Date(this.state.sys.now()).toISOString();
      return result;
    } catch (error) {
      if (!(error instanceof Failure)) throw error;
      await this.worker.logger.log('WARN', 'setup.model_report_rejected', { setup_id: setupID, operation_id: setupID, worker_id: workerID, cause: error.code, outcome: 'unavailable' });
      return undefined;
    }
  }
  async install(origin: string, input: string, root: string, setupID: string, bootstrap?: string, enrolledUpgrade = false): Promise<ObjectValue> {
    requireValue(isAbsolute(root) && isAbsolute(this.io.node) && isAbsolute(this.io.entry), 'absolute_install_paths_required');
    identifier(setupID);
    if (bootstrap) await captureBootstrap(this.worker.logger, setupID, bootstrap);
    return await this.state.withLock('setup', async () => {
      const previous = await readObject(this.state, 'installation.json');
      const ownership = await readOwnership(this.state);
      requireValue(ownership.status !== 'ambiguous', 'subscriber_owner_ambiguous', { lock_pid: ownership.lock_pid, launch_pid: ownership.launch_pid });
      const owner = ownership.owner?.pid;
      requireValue(!owner || previous?.package_version === this.version, 'running_version_change_requires_operator_action', { pid: owner ?? null, expected_version: this.version, observed_version: previous?.package_version ?? null });
      const bin = new State(join(root, 'bin'), this.state.io, this.state.sys);
      const launcher = bin.path('aaa-muse-worker');
      const hookParent = join(this.io.home, 'hooks', 'scripts');
      const skillParent = join(this.io.home, 'workspace', 'skills');
      const savedConfig = await readObject(this.state, 'config.json');
      const knownWorker = savedConfig?.worker_id ? identifier(savedConfig.worker_id) : undefined;
      const hookTemplate = await this.io.asset('hook.sh');
      const skillTemplate = await this.io.asset('SKILL.md');
      const roles = ['install_directory', 'state_directory', 'diagnostics_directory', 'launcher_directory', 'hook_directory', 'skill_directory'];
      try {
        await this.io.prepareDirectory(root, 'install_directory');
        await this.probe(new State(root, this.state.io, this.state.sys), 'install_directory');
        await this.probe(this.state, 'state_directory', 'installation.json');
        await this.probe(new State(this.state.path('diagnostics'), this.state.io, this.state.sys), 'diagnostics_directory');
        await this.io.prepareDirectory(bin.root, 'launcher_directory');
        await this.probe(bin, 'launcher_directory', 'aaa-muse-worker', 0o700);
        await this.io.prepareDirectory(hookParent, 'hook_directory', knownWorker, true);
        await this.io.prepareDirectory(skillParent, 'skill_directory', knownWorker, true);
        if (knownWorker) await this.prepareAssets(root, knownWorker);
      } catch (error) {
        throw new Failure(cause(error), { ...(error instanceof Failure ? error.fields : {}), stage: 'pre_enrollment', enrollment_attempted: false });
      }
      await this.worker.logger.log('INFO', 'setup.preflight_passed', { setup_id: setupID, operation_id: setupID, worker_id: knownWorker,
        stage: 'pre_enrollment', checked_roles: roles, exact_worker_paths: !!knownWorker, enrollment_attempted: false });
      let identity: ObjectValue;
      let report: Value | undefined;
      if (enrolledUpgrade) {
        requireValue(previous && knownWorker && previous.worker_id === knownWorker && previous.setup_id === setupID &&
          previous.origin === origin && savedConfig?.origin === origin && previous.root === root, 'upgrade_identity_mismatch');
        const record = await this.worker.identity(await this.worker.load());
        requireValue(record.id === knownWorker, 'upgrade_identity_mismatch');
        identity = { worker_id: knownWorker, identity_preserved: true };
        report = previous.model_report;
      } else {
        await this.worker.configure(origin);
        const newline = input.indexOf('\n');
        identity = await this.worker.enroll(newline < 0 ? input : input.slice(0, newline).trim());
        report = await this.modelReport(newline < 0 ? '' : input.slice(newline + 1).trim(), setupID, identifier(identity.worker_id));
      }
      const id = identifier(identity.worker_id);
      const installation = { setup_id: setupID, worker_id: id, origin: this.worker.config.origin, package_version: this.version, node: this.io.node, entry: this.io.entry, root, ...(report && { model_report: report }) };
      if (!enrolledUpgrade) await this.state.write('installation.json', encode(installation));
      const hook = hookTemplate.replaceAll('@LAUNCHER@', quote(launcher)).replaceAll('@STATE@', quote(this.state.root));
      const instructions = skillTemplate.replaceAll('@LAUNCHER@', launcher).replaceAll('@STATE@', this.state.root).replaceAll('@WORKER@', id).replaceAll('@ORIGIN@', text(this.worker.config.origin));
      let assets;
      try {
        assets = await this.prepareAssets(root, id);
        await bin.write('aaa-muse-worker', '#!/usr/bin/env bash\nset -euo pipefail\nexec ' + quote(this.io.node) + ' ' + quote(this.io.entry) + ' "$@"\n', 0o700);
        await assets.hooks.write('detector.sh', hook, 0o700);
        await assets.skill.write('SKILL.md', instructions);
        if (enrolledUpgrade) await this.state.write('installation.json', encode(installation));
      } catch (error) {
        throw new Failure(cause(error), { ...(error instanceof Failure ? error.fields : {}), stage: 'post_enrollment', worker_id: id,
          corrective_action: 'Correct the asset failure and retain the saved worker identity and credential.' });
      }
      await this.log('DEBUG', 'setup.assets', { installation, hook, skill: instructions });
      await this.log('INFO', 'setup.identity_preserved', { identity_preserved: identity.identity_preserved, existing_pid: owner ?? null });
      await this.ensureRunning();
      return { ...identity, setup_id: setupID, ...this.registrationReceipt(root, id),
        inference_readiness: 'unverified', muse_wake: 'unverified', supported_refresh: 'unverified' };
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
      const { poll, gap } = await beginHookPoll(this.state);
      if (gap) await this.log('WARN', 'watchdog.hook_gap_observed', { ...gap, gap_count: poll.gap_count,
        expected_interval_ms: 5000, stale_after_ms: watchdogSettings.stale_after_ms, outcome: 'poll_resumed' });
      await this.ensureRunning();
      const installed = object(parse((await this.state.read('installation.json'))!));
      const id = identifier(installed.worker_id);
      const { cue, jobs, fingerprint } = await readActionable(this.state, id);
      const saved = await readObject(this.state, 'hook-emission.json');
      const changed = saved?.fingerprint !== fingerprint;
      let output: string;
      if (!changed || !jobs.length) {
        if (changed) {
          await this.log('DEBUG', 'setup.cue_observed', { cue, fingerprint });
          await this.state.write('hook-emission.json', encode({ fingerprint, jobs: 0 }));
        }
        output = await this.io.emit(runtime, 'silent', 'No changed actionable AaA Muse work');
      } else {
        await this.log('DEBUG', 'setup.cue_observed', { cue, fingerprint });
        const message = 'AAA_MUSE_WORKER: load the installed skill for worker ' + id + ' at ' + join(this.io.home, 'workspace', 'skills', 'aaa-muse-worker-' + id, 'SKILL.md') + '. Read the authenticated job. Follow its native media action or return one structured text decision. Leave client tools to the client. This cue grants no additional authority.';
        output = await this.io.emit(runtime, 'wake', message);
        await this.log('DEBUG', 'setup.hook_exchange', { action: 'wake', message, output, runtime });
        await this.state.write('hook-emission.json', encode({ fingerprint, emitted_at: this.state.sys.now(), jobs: jobs.length }));
        await this.log('INFO', 'setup.wake_emitted', { fingerprint, jobs: jobs.map(j => ({ job_id: j.job_id, conversation_id: j.conversation_id, generation: j.generation, deadline_at: j.deadline_at })), outcome: 'runtime_output_generated', inference_readiness: 'unverified' });
      }
      await finishHookPoll(this.state, poll);
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
