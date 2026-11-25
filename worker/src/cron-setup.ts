import { isAbsolute, join } from 'node:path';
import { launcherScript, shellQuote as quote, type InstallationIO } from './install-io.js';
import { State } from './state.js';
import { Worker } from './worker.js';
import { encode, identifier, object, parse, text, type ObjectValue } from './json.js';
import { requireValue } from './errors.js';
import { archiveDigest } from './update-archive.js';

export { launcherScript } from './install-io.js';

export class CronSetup {
  constructor(readonly worker: Worker, readonly io: InstallationIO, readonly version: string) {}

  get state() { return this.worker.state; }

  async install(origin: string, input: string, root: string, setupID: string, digest?: string): Promise<ObjectValue> {
    requireValue(isAbsolute(root) && isAbsolute(this.io.node) && isAbsolute(this.io.entry), 'absolute_install_paths_required');
    identifier(setupID);
    requireValue(digest === undefined || archiveDigest.test(digest), "invalid_archive_digest");
    return this.state.withLock('setup', async () => {
      const prior = await this.worker.readRecord(this.state, 'installation.json');
      requireValue(!prior || (prior.setup_id === setupID && prior.root === root && prior.origin === origin && prior.package_version === this.version), 'fresh_worker_state_required');
      await this.io.prepareDirectory(root, 'install_directory');
      const bin = new State(join(root, 'bin'), this.state.io, this.state.sys);
      await this.io.prepareDirectory(bin.root, 'launcher_directory');
      const launcher = bin.path('aaa-muse-worker');
      await bin.write('aaa-muse-worker', launcherScript(this.io.node, this.io.entry, this.state.root), 0o700);
      await this.worker.configure(origin);
      const enrolled = await this.worker.enroll(input.split('\n', 1)[0].trim(), setupID);
      const workerID = identifier(enrolled.worker_id);
      requireValue(!prior || prior.worker_id === workerID, 'worker_identity_mismatch');
      const installation = { setup_id: setupID, worker_id: workerID, origin, package_version: this.version, root, launcher, command: quote(launcher), ...(digest ? { package_sha256: digest, node: this.io.node, entry: this.io.entry } : {}) };
      const skillRoot = join(this.io.home, 'workspace', 'skills');
      await this.io.prepareDirectory(skillRoot, 'skill_directory', workerID, true);
      const skillDir = new State(join(skillRoot, 'aaa-muse-worker-' + workerID), this.state.io, this.state.sys);
      await this.io.prepareDirectory(skillDir.root, 'skill_directory', workerID);
      const skill = (await this.io.asset('SKILL.md')).replaceAll('@LAUNCHER@', launcher).replaceAll('@STATE@', this.state.root).replaceAll('@WORKER@', workerID).replaceAll('@ORIGIN@', origin);
      await skillDir.write('SKILL.md', skill);
      await this.state.write('installation.json', encode(installation));
      await this.worker.logger.log('INFO', 'setup.native_install_prepared', { setup_id: setupID, worker_id: workerID, outcome: 'checker_readback_pending' });
      return { ...enrolled, ...installation, state_dir: this.state.root, skill_path: skillDir.path('SKILL.md'), inference_readiness: 'unverified', cron_registration: 'pending' };
    });
  }

  private checker(goalID: string, installation: ObjectValue): ObjectValue {
    const command = text(installation.command);
    const name = 'aaa-muse-worker-check-' + identifier(installation.worker_id);
    const prompt = [
      `Use native tools to identify this exact recurring job, its current individual run ID and nominal UTC scheduled time. If you cannot verify these, report recovery_pending and stop. Invoke ${command} cron-check --input - exactly once, passing JSON checker_job_id, checker_run_id and scheduled_at from this actual occurrence. Do not leave the work in this checker.`,
      `For outcome prepare, determine the earliest supported absolute UTC due_at strictly inside the claim deadline and pass it with claim_id and launch_id to ${command} cron-prepare --input -. Only the register outcome authorizes a single goal-owned native runonce agent registration using the returned exact work definition. Use the reference as its unique name if needed. Do not repeat a possibly delivered registration.`,
      `After attempting registration, or whenever the helper returns a non-null lookup, look up the exact work definition and execution through native tooling and call ${command} cron-observe --input - with claim_id, launch_id, checker_job_id and checker_run_id from this actual checker occurrence, observation time as observed_at, and the matching definitions as matches. Search active and finished one-shots for the exact goal, reference and action; a name alone, missing listing, or old run does not prove delivery, non-delivery, or termination.`,
      'Each match contains goal_id, reference, due_at, kind, prompt, native_job_id and status (queued, running, completed, failed, cancelled, or unobservable). Report running or a terminal execution only with an execution object containing native_job_id, native_run_id and status from the actual native run record. Use the parent job ID from the run record or the exact job ID that scoped the native run-history query, not a job ID inferred from the definition name, checker occurrence or prompt. If the run cannot be linked to this one-shot by native tooling, report unobservable. Only if native cancellation explicitly proves that execution never started, include execution_never_started: true without an execution record.',
      'Only if the native registration operation explicitly reports that it did not create the exact job, include registration_rejection with the exact definition, outcome: not_created, and its native_operation_id. A timeout, inaccessible status or missing match is not such proof. Report ambiguity without changing schedules. Return only the short outcome and identifiers; omit the prompt, request data, file paths and credentials. No other work is authorized in this checker.',
    ].join(' ');
    return { goal_id: identifier(goalID), name, every: '1m', enabled: true, kind: 'agent', prompt };
  }

  async describe(goalID: string): Promise<ObjectValue> {
    return this.state.withLock('cron-setup', async () => {
      const installation = await this.worker.readRecord(this.state, 'installation.json');
      requireValue(installation, 'worker_setup_required');
      const definition = this.checker(goalID, installation);
      const saved = await this.worker.readRecord(this.state, 'cron-expected.json');
      requireValue(!saved || encode(saved) === encode(definition), 'checker_definition_changed');
      if (!saved) await this.state.write('cron-expected.json', encode(definition));
      return definition;
    });
  }

  async authorizeRegistration(input: string): Promise<ObjectValue> {
    const listing = object(parse(input));
    return this.state.withLock('cron-setup', async () => {
      const expected = await this.worker.readRecord(this.state, 'cron-expected.json');
      requireValue(expected && listing.goal_id === expected.goal_id && listing.complete === true && Array.isArray(listing.matches) && listing.matches.length === 0, 'checker_absence_unverified');
      const prior = await this.worker.readRecord(this.state, 'cron-registration-intent.json');
      requireValue(!prior && !(await this.worker.readRecord(this.state, 'cron-installation.json')), 'checker_registration_uncertain');
      await this.state.write('cron-registration-intent.json', encode({ goal_id: expected.goal_id, name: expected.name, created_at: new Date(this.state.sys.now()).toISOString() }));
      await this.worker.logger.log('INFO', 'setup.native_registration_intent', { goal_id: expected.goal_id, name: expected.name });
      return { outcome: 'register', definition: expected };
    });
  }

  async confirm(input: string): Promise<ObjectValue> {
    const observed = object(parse(input));
    return this.state.withLock('cron-setup', async () => {
      const installation = await this.worker.readRecord(this.state, 'installation.json');
      const expected = await this.worker.readRecord(this.state, 'cron-expected.json');
      requireValue(installation && expected && Array.isArray(observed.matches) && observed.matches.length === 1, 'checker_match_unverified');
      const actual = object(observed.matches[0]);
      requireValue(Object.keys(expected).every(key => expected[key] === actual[key]), 'checker_definition_mismatch');
      const checker = identifier(actual.native_job_id);
      const prior = await this.worker.readRecord(this.state, 'cron-installation.json');
      requireValue(!prior || prior.checker_job_id === checker, 'checker_identity_changed');
      await this.state.write('cron-installation.json', encode({ ...expected, checker_job_id: checker, command: installation.command }));
      await this.worker.logger.log('INFO', 'setup.native_checker_verified', { setup_id: installation.setup_id, worker_id: installation.worker_id, checker_job_id: checker, goal_id: expected.goal_id, every: '1m' });
      return { outcome: 'registered', checker_job_id: checker, worker_id: installation.worker_id };
    });
  }
}
