import { isAbsolute, join } from 'node:path';
import { launcherScript, shellQuote, writeManagedAssets } from './install-io.js';
import type { InstallationIO } from './install-io.js';
import { digest } from './diagnostics.js';
import { requireValue } from './errors.js';
import { encode, identifier, object, parse, text, type ObjectValue } from './json.js';
import { State } from './state.js';
import { archiveDigest } from './update-archive.js';
import type { Worker } from './worker.js';

export const hookInstallation = 'hook-installation.json';
export const hookPromptVersion = 'managed-hook-prompt-v2';
const upgradeExpected = 'hook-upgrade-expected.json';
export const agentTasksHeader = 'X-Muse-Worker-Agent-Tasks';
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
      const identity = { setup_id: setupID, worker_id: workerID, origin, root, launcher, node, entry };
      const assets = await writeManagedAssets(this.io, this.state, identity);
      const installation = { ...identity, ...assets, package_version: version, package_sha256: digest,
        installed_at: prior?.installed_at ?? new Date(this.state.sys.now()).toISOString() };
      await this.state.write('installation.json', encode(installation));
      await this.worker.logger.log('INFO', 'setup.hook_install_prepared', { ...installation, outcome: 'registration_readback_pending' });
      return { ...enrolled, ...installation, state_dir: this.state.root,
        registration: 'pending', inference_readiness: 'unverified' };
    });
  }

  private definition(installation: ObjectValue, goalID: string, previous?: ObjectValue): ObjectValue {
    const command = shellQuote(text(installation.launcher));
    const workerID = identifier(installation.worker_id);
    const hook = { id: 'aaa-muse-worker-' + workerID, script_path: installation.detector, enabled: true,
      poll_interval_secs: pollSeconds, script_timeout_secs: hookTimeoutSeconds, prompt: hookPrompt(command) };
    const watchdog = previous ? object(previous.watchdog) : {
      goal_id: identifier(goalID), name: 'aaa-muse-worker-watchdog-' + workerID, every: watchdogEvery, kind: 'agent', enabled: true,
      prompt: [
        `Call ${command} watchdog-check exactly once. Stay silent when notify is false. When notify is true send one short message to the owning chat summarizing the reported incidents or recovery.`,
        'For a missing or stale hook ask the owner to inspect its status in the main Muse chat and re-enable or repair the exact hook. For an uncertain claim preserve the hold and inspect diagnostics. Include no credentials, file paths or job contents.',
      ].join(' '),
    };
    return { goal_id: goalID, hook, watchdog };
  }

  async describe(goalID: string): Promise<ObjectValue> {
    return this.state.withLock('hook-setup', async () => {
      const installation = await this.worker.readRecord(this.state, 'installation.json');
      requireValue(installation, 'worker_setup_required');
      const definition = this.definition(installation, goalID);
      const saved = await this.worker.readRecord(this.state, expectedFile);
      requireValue(!saved || encode(saved) === encode(definition), 'hook_definition_changed');
      if (!saved) await this.state.write(expectedFile, encode(definition));
      return definition;
    });
  }

  async describeUpgrade(workerID: string, goalID: string): Promise<ObjectValue> {
    return this.state.withLock('hook-setup', async () => {
      const installation = await this.worker.readRecord(this.state, 'installation.json');
      const registration = await this.worker.readRecord(this.state, hookInstallation);
      requireValue(installation && installation.worker_id === workerID && registration?.worker_id === workerID &&
        registration.hook_id === 'aaa-muse-worker-' + workerID, 'worker_identity_mismatch');
      const previous = await this.worker.readRecord(this.state, expectedFile);
      requireValue(!previous || previous.goal_id === goalID, 'hook_goal_mismatch');
      const definition = this.definition(installation, goalID, previous);
      const saved = await this.worker.readRecord(this.state, upgradeExpected);
      requireValue(!saved || encode(saved) === encode(definition), 'hook_definition_changed');
      if (!saved) await this.state.write(upgradeExpected, encode(definition));
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
      const pending = await this.worker.readRecord(this.state, upgradeExpected);
      const expected = pending ?? await this.worker.readRecord(this.state, expectedFile);
      requireValue(installation && expected && observed.dry_run === 'silent' && observed.complete === true &&
        observed.goal_id === expected.goal_id && Array.isArray(observed.hooks) && observed.hooks.length === 1 &&
        Array.isArray(observed.watchdogs) && observed.watchdogs.length === 1, 'hook_readback_unverified');
      const hook = object(observed.hooks[0]), watchdog = object(observed.watchdogs[0]);
      requireValue(matches(object(expected.hook), hook) && matches(object(expected.watchdog), watchdog), 'hook_readback_mismatch',
        { expected, observed: { hook, watchdog } });
      const id = identifier(watchdog.native_job_id);
      const prior = await this.worker.readRecord(this.state, hookInstallation);
      requireValue(!prior || prior.watchdog_job_id === id, 'watchdog_identity_changed');
      requireValue(!prior || prior.hook_id === hook.id && prior.worker_id === installation.worker_id, 'worker_identity_mismatch');
      const prompt = hookPrompt(shellQuote(text(installation.launcher)));
      const versionVerified = hook.prompt === prompt;
      requireValue(!pending || versionVerified, 'hook_readback_mismatch');
      const now = new Date(this.state.sys.now()).toISOString();
      if (pending) await this.state.write(expectedFile, encode(expected));
      await this.state.write(hookInstallation, encode({ hook_id: hook.id, worker_id: installation.worker_id, watchdog_job_id: id,
        confirmed_at: prior?.confirmed_at ?? now, ...(versionVerified ? {
          hook_prompt_version: hookPromptVersion, hook_prompt_sha256: digest(prompt),
          prompt_confirmed_at: prior?.hook_prompt_sha256 === digest(prompt) ? prior.prompt_confirmed_at : now,
        } : {}) }));
      if (pending) await this.state.remove(upgradeExpected);
      await this.worker.logger.log('INFO', 'setup.hook_registration_verified', { worker_id: installation.worker_id, hook, watchdog, dry_run: 'silent' });
      return { outcome: 'registered', hook_id: hook.id, watchdog_job_id: id, worker_id: installation.worker_id };
    });
  }
}

function hookPrompt(command: string): string {
  return [
    'A broker claim woke you. Use the launch_id in the wake payload and the actual event-hook:<invocation-id> of this run. Stop if you cannot identify your own run.',
    `When the payload kind is background_task, run ${command} hook-task-start --launch-id <launch_id> --run-id <your-run-id>. Work only after it authorizes the returned prompt. Use the Muse tools available in this run within their granted permissions. Hook or cron changes, chat.send and permission approvals require the main chat. Finish all activity before calling ${command} hook-task-finish --task-id <task_id> --input - with one JSON object containing result_text and an optional summary. On a clean failure or refusal, call ${command} hook-task-abort --launch-id <launch_id> --run-id <your-run-id> --reason execution_failed or execution_refused, with an optional --summary. End after delivery or a saved abort.`,
    `For an inference or media claim, call ${command} hook-start --launch-id <launch_id> --run-id <your-run-id>. Stop if start is refused or uncertain. Use only the returned brief. For text or tools call ${command} decision-submit --job-id <job_id> --input - with one strict JSON decision. The calling client executes its tools. For media, write to the private destination and run ${command} media-finish --job-id <job_id> when the file is complete.`,
    `Keep inference and media work in the foreground. For a finite media producer, use cron-producer-intent on the same launcher and start it only through the returned producer_command. After clean failure or refusal with no active producers, call ${command} hook-abort --launch-id <launch_id> --run-id <your-run-id> --reason execution_failed or execution_refused. End immediately after accepted delivery or abort. Return a short safe outcome.`,
  ].join(' ');
}

export async function hookTaskCapability(worker: Worker): Promise<Record<string, string>> {
  const registration = await worker.readRecord(worker.state, hookInstallation);
  if (registration?.hook_prompt_version !== hookPromptVersion || !registration.prompt_confirmed_at) return {};
  const installation = await worker.readRecord(worker.state, 'installation.json');
  if (!installation || registration.worker_id !== installation.worker_id ||
    registration.hook_id !== 'aaa-muse-worker-' + installation.worker_id ||
    registration.hook_prompt_sha256 !== digest(hookPrompt(shellQuote(text(installation.launcher))))) return {};
  return { [agentTasksHeader]: '1' };
}
