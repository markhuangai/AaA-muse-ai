import { isAbsolute, join } from 'node:path';
import { launcherScript, shellQuote } from './install-io.js';
import type { InstallationIO } from './install-io.js';
import { requireValue } from './errors.js';
import { encode, identifier, object, parse, text, type ObjectValue } from './json.js';
import { State } from './state.js';
import { archiveDigest } from './update-archive.js';
import type { Worker } from './worker.js';

export const hookInstallation = 'hook-installation.json';
const expectedFile = 'hook-expected.json';
const intentFile = 'hook-registration-intent.json';
export const pollSeconds = 15;
export const hookTimeoutSeconds = 120;
export const watchdogEvery = '1h';

function matches(expected: ObjectValue, observed: ObjectValue): boolean {
  return Object.entries(expected).every(([key, value]) => encode(value) === encode(observed[key]));
}

export class HookSetup {
  constructor(readonly worker: Worker, readonly io: InstallationIO) {}

  get state() { return this.worker.state; }

  async install(origin: string, code: string, root: string, setupID: string, digest: string): Promise<ObjectValue> {
    requireValue(isAbsolute(root) && isAbsolute(this.io.node) && isAbsolute(this.io.entry), 'absolute_install_paths_required');
    identifier(setupID);
    requireValue(archiveDigest.test(digest), 'invalid_archive_digest');
    return this.state.withLock('setup', async () => {
      const prior = await this.worker.readRecord(this.state, 'installation.json');
      const version = this.worker.productVersion;
      requireValue(!prior || (prior.setup_id === setupID && prior.root === root && prior.origin === origin &&
        prior.package_version === version && prior.package_sha256 === digest), 'fresh_worker_state_required');
      await this.io.prepareDirectory(root, 'install_directory');
      const bin = new State(join(root, 'bin'), this.state.io, this.state.sys);
      await this.io.prepareDirectory(bin.root, 'launcher_directory');
      const launcher = bin.path('aaa-muse-worker');
      const node = prior ? text(prior.node) : this.io.node;
      const entry = prior ? text(prior.entry) : this.io.entry;
      await bin.write('aaa-muse-worker', launcherScript(node, entry, this.state.root), 0o700);
      await this.worker.configure(origin);
      const enrolled = await this.worker.enroll(code.split('\n', 1)[0].trim(), setupID, digest);
      const workerID = text(enrolled.worker_id);
      requireValue(/^[a-f0-9]{32}$/.test(workerID) && (!prior || prior.worker_id === workerID), 'worker_identity_mismatch');
      const name = 'aaa-muse-worker-' + workerID;
      const hookRoot = join(this.io.home, 'hooks', 'scripts');
      const skillRoot = join(this.io.home, 'workspace', 'skills');
      await this.io.prepareDirectory(hookRoot, 'hook_directory', workerID, true);
      await this.io.prepareDirectory(skillRoot, 'skill_directory', workerID, true);
      const hook = new State(join(hookRoot, name), this.state.io, this.state.sys);
      const skill = new State(join(skillRoot, name), this.state.io, this.state.sys);
      await this.io.prepareDirectory(hook.root, 'hook_directory', workerID);
      await this.io.prepareDirectory(skill.root, 'skill_directory', workerID);
      const detector = (await this.io.asset('hook.sh')).replaceAll('@LAUNCHER@', shellQuote(launcher));
      await hook.write('detector.sh', detector, 0o700);
      await skill.write('SKILL.md', (await this.io.asset('SKILL.md'))
        .replaceAll('@LAUNCHER@', launcher).replaceAll('@STATE@', this.state.root).replaceAll('@WORKER@', workerID).replaceAll('@ORIGIN@', origin));
      const installation = { setup_id: setupID, worker_id: workerID, origin, root, launcher, node, entry, detector: hook.path('detector.sh'),
        package_version: version, package_sha256: digest, installed_at: prior?.installed_at ?? new Date(this.state.sys.now()).toISOString() };
      await this.state.write('installation.json', encode(installation));
      await this.worker.logger.log('INFO', 'setup.hook_install_prepared', { ...installation, outcome: 'registration_readback_pending' });
      return { ...enrolled, ...installation, state_dir: this.state.root, skill_path: skill.path('SKILL.md'),
        registration: 'pending', inference_readiness: 'unverified' };
    });
  }

  async describe(goalID: string): Promise<ObjectValue> {
    return this.state.withLock('hook-setup', async () => {
      const installation = await this.worker.readRecord(this.state, 'installation.json');
      requireValue(installation, 'worker_setup_required');
      const command = shellQuote(text(installation.launcher));
      const workerID = identifier(installation.worker_id);
      const hook = { id: 'aaa-muse-worker-' + workerID, script_path: installation.detector, enabled: true,
        poll_interval_secs: pollSeconds, script_timeout_secs: hookTimeoutSeconds, prompt: [
          `A broker claim woke you. Take launch_id from the wake payload and the actual event-hook:<invocation-id> from your own run context. Call ${command} hook-start --launch-id <launch_id> --run-id <your-run-id>. If you cannot identify your own run or start is refused or uncertain, stop without processing the claim.`,
          `Use only the returned brief. For text or tools run ${command} decision-submit --job-id <job_id> --input - with one strict JSON decision. Only the calling client executes client tools. For media use the private destination and run ${command} media-finish --job-id <job_id> once the file is complete.`,
          `Keep work in the foreground. For a finite detached producer use cron-producer-intent on the same launcher and start it only through the returned producer_command. After a clean failure or refusal with no active producers, call ${command} hook-abort --launch-id <launch_id> --run-id <your-run-id> --reason execution_failed or execution_refused. End immediately after accepted delivery or abort. Return only a short safe outcome.`,
        ].join(' ') };
      const watchdog = { goal_id: identifier(goalID), name: 'aaa-muse-worker-watchdog-' + workerID,
        every: watchdogEvery, kind: 'agent', enabled: true, prompt: [
          `Call ${command} watchdog-check exactly once. Stay silent when notify is false. When notify is true send one short message to the owning chat summarizing the reported incidents or recovery.`,
          'For a missing or stale hook ask the owner to inspect its status in the main Muse chat and re-enable or repair the exact hook. For an uncertain claim preserve the hold and inspect diagnostics. Include no credentials, file paths or job contents.',
        ].join(' ') };
      const definition = { goal_id: goalID, hook, watchdog };
      const saved = await this.worker.readRecord(this.state, expectedFile);
      requireValue(!saved || encode(saved) === encode(definition), 'hook_definition_changed');
      if (!saved) await this.state.write(expectedFile, encode(definition));
      return definition;
    });
  }

  async authorizeRegistration(input: string): Promise<ObjectValue> {
    const listing = object(parse(input));
    return this.state.withLock('hook-setup', async () => {
      const expected = await this.worker.readRecord(this.state, expectedFile);
      requireValue(expected && listing.goal_id === expected.goal_id && listing.complete === true &&
        (listing.target === 'hook' || listing.target === 'watchdog') &&
        Array.isArray(listing.hooks) && Array.isArray(listing.watchdogs), 'hook_listing_unverified');
      const prior = await this.worker.readRecord(this.state, intentFile);
      const registered = await this.worker.readRecord(this.state, hookInstallation);
      const hook = object(expected.hook), watchdog = object(expected.watchdog);
      requireValue(listing.hooks.length <= 1 && listing.watchdogs.length <= 1, 'hook_registration_conflict');
      const observedHook = listing.hooks.length ? object(listing.hooks[0]) : undefined;
      const observedWatchdog = listing.watchdogs.length ? object(listing.watchdogs[0]) : undefined;
      requireValue(!observedHook || (typeof observedHook.enabled === 'boolean' && matches({ ...hook, enabled: observedHook.enabled }, observedHook)),
        'hook_definition_mismatch', { expected: hook, observed: observedHook });
      requireValue(!observedWatchdog || matches(watchdog, observedWatchdog), 'watchdog_definition_mismatch',
        { expected: watchdog, observed: observedWatchdog });
      const watchdogID = observedWatchdog ? identifier(observedWatchdog.native_job_id) : undefined;
      requireValue(!registered || (observedHook && observedWatchdog && registered.watchdog_job_id === watchdogID),
        'registered_hook_readback_missing');
      requireValue(observedHook || !prior?.hook, 'hook_registration_uncertain');
      requireValue(observedWatchdog || !prior?.watchdog, 'watchdog_registration_uncertain');
      const addHook = listing.target === 'hook' && !observedHook;
      const addWatchdog = listing.target === 'watchdog' && !observedWatchdog;
      if (addHook || addWatchdog) await this.state.write(intentFile, encode({ ...prior, [text(listing.target)]: true }));
      const actions = { add_hook: addHook, enable_hook: listing.target === 'hook' && observedHook?.enabled !== true,
        add_watchdog: addWatchdog, ...(watchdogID ? { watchdog_job_id: watchdogID } : {}) };
      await this.worker.logger.log('INFO', 'setup.hook_registration_intent', { ...actions, hook_id: hook.id, goal_id: expected.goal_id });
      return { outcome: 'registration_authorized', hook, watchdog, ...actions };
    });
  }

  async confirm(input: string): Promise<ObjectValue> {
    const observed = object(parse(input));
    return this.state.withLock('hook-setup', async () => {
      const installation = await this.worker.readRecord(this.state, 'installation.json');
      const expected = await this.worker.readRecord(this.state, expectedFile);
      requireValue(installation && expected && observed.dry_run === 'silent' && observed.complete === true &&
        observed.goal_id === expected.goal_id && Array.isArray(observed.hooks) && observed.hooks.length === 1 &&
        Array.isArray(observed.watchdogs) && observed.watchdogs.length === 1, 'hook_readback_unverified');
      const hook = object(observed.hooks[0]), watchdog = object(observed.watchdogs[0]);
      requireValue(matches(object(expected.hook), hook) && matches(object(expected.watchdog), watchdog), 'hook_readback_mismatch',
        { expected, observed: { hook, watchdog } });
      const id = identifier(watchdog.native_job_id);
      const prior = await this.worker.readRecord(this.state, hookInstallation);
      requireValue(!prior || prior.watchdog_job_id === id, 'watchdog_identity_changed');
      await this.state.write(hookInstallation, encode({ hook_id: hook.id, worker_id: installation.worker_id, watchdog_job_id: id,
        confirmed_at: prior?.confirmed_at ?? new Date(this.state.sys.now()).toISOString() }));
      await this.worker.logger.log('INFO', 'setup.hook_registration_verified', { worker_id: installation.worker_id, hook, watchdog, dry_run: 'silent' });
      return { outcome: 'registered', hook_id: hook.id, watchdog_job_id: id, worker_id: installation.worker_id };
    });
  }
}
