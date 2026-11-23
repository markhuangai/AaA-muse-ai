import { join } from 'node:path';
import { Failure, cause, requireValue } from './errors.js';
import type { InstallationIO } from './install-io.js';
import { encode, identifier, integer, object, text, type ObjectValue, type Value } from './json.js';
import { State } from './state.js';
import { launcherScript } from './cron-setup.js';
import { archiveDigest, supportsSource, updateArchiveIO, updateContract, updateTarget, verifyInstallEntry, type UpdateArchiveIO } from './update-archive.js';
import { origin, type Transport } from './transport.js';
import type { Worker } from './worker.js';

const journalFile = 'cron-update.json';
const installationFile = 'installation.json';
const launcherFile = 'aaa-muse-worker';

function knownFailure(error: unknown) {
  const code = error instanceof Failure ? error.code : 'staging_failed';
  return ['archive_unavailable', 'download_failed', 'archive_digest_mismatch', 'archive_invalid', 'staging_failed', 'candidate_incompatible'].includes(code)
    ? code : 'staging_failed';
}

function correction(reason: string) {
  switch (reason) {
    case 'archive_unavailable':
    case 'download_failed':
      return 'Check the pinned public archive over HTTPS and wait for the next scheduled retry.';
    case 'archive_digest_mismatch':
    case 'archive_invalid':
    case 'candidate_incompatible':
      return 'Compare the deployed image pin against the verified release archive before installing.';
    case 'target_changed':
      return 'Bring the running brokers to the intended paired release and allow the next idle check.';
    default:
      return 'Check the private installation directory, permissions and available disk space.';
  }
}

function headers(digest: string): Record<string, string> {
  return { 'X-Muse-Worker-Updater': updateContract, 'X-Muse-Worker-SHA256': digest };
}

export class CronUpdate {
  constructor(readonly worker: Worker, readonly io: InstallationIO, readonly archive: UpdateArchiveIO = updateArchiveIO(io)) {}
  get state() { return this.worker.state; }

  private async read(file: string) { return this.worker.readRecord(this.state, file); }
  private async save(attempt: ObjectValue) { await this.state.write(journalFile, encode(attempt)); }

  private bin(installation: ObjectValue): State {
    const bin = new State(join(text(installation.root), 'bin'), this.state.io, this.state.sys);
    requireValue(installation.launcher === bin.path(launcherFile), 'update_launcher_changed');
    return bin;
  }

  async contactHeaders(): Promise<Record<string, string>> {
    const installation = await this.read(installationFile);
    if (!installation?.package_sha256) return {};
    const digest = text(installation.package_sha256);
    requireValue(archiveDigest.test(digest) && installation.package_version === this.worker.productVersion &&
      installation.entry === this.io.entry && installation.node === this.io.node, 'update_running_version_unverified');
    const bin = this.bin(installation);
    requireValue(await bin.read(launcherFile, 0o700) === launcherScript(this.io.node, this.io.entry, this.state.root), 'update_launcher_changed');
    return headers(digest);
  }

  private async idle() {
    requireValue(!(await this.read('cron-claim.json')) && !(await this.read('cron-tick.json'))?.pending, 'update_worker_has_pending_work');
  }

  private async newAttempt(installation: ObjectValue, id: string, target: ObjectValue): Promise<ObjectValue> {
    await this.idle();
    const launcher = await this.bin(installation).read(launcherFile, 0o700);
    requireValue(launcher, 'update_launcher_missing');
    const previous = text(installation.package_version);
    requireValue(supportsSource(target, previous), 'candidate_incompatible');
    return { id, target, stage: 'starting', from: previous, previous_launcher: launcher, started_at_ms: this.state.sys.now() };
  }

  async adopt(expectedOrigin: string, workerID: string, digest: string, root: string): Promise<ObjectValue> {
    return await this.state.withLock('cron', async () => {
      await this.idle();
      const installation = await this.read(installationFile);
      const checker = await this.read('cron-installation.json');
      requireValue(installation && checker && checker.command === installation.command && installation.root === root &&
        installation.worker_id === workerID && installation.origin === origin(expectedOrigin), 'update_adoption_identity_mismatch');
      const transport = await this.worker.load();
      const status = await this.worker.identity(transport);
      const target = updateTarget(status.update_target);
      requireValue(status.id === workerID && !status.current_claim && target.sha256 === digest &&
        target.version === this.worker.productVersion, 'update_adoption_pin_changed');
      verifyInstallEntry(root, this.io.entry);
      await this.archive.verify(this.io.entry, target);
      const prior = await this.read(journalFile);
      if (prior) {
        requireValue(prior.worker_id === workerID && encode(prior.target) === encode(target), 'update_adoption_conflict');
        return await this.advance(prior, installation, transport);
      }
      if (installation.package_sha256 === digest) return { outcome: 'update_managed', worker_id: workerID };
      requireValue(!installation.package_sha256, 'update_adoption_conflict');
      const attempt = await this.newAttempt(installation, this.state.sys.uuid(), target);
      Object.assign(attempt, { worker_id: workerID, entry: this.io.entry, node: this.io.node, observed_digest: digest });
      await this.save(attempt);
      return await this.advance(attempt, installation, transport);
    });
  }

  async offer(value: Value | undefined, transport: Transport, requestID: string): Promise<ObjectValue> {
    const offer = object(value);
    const target = updateTarget(offer.target);
    const installation = await this.read(installationFile);
    requireValue(installation && installation.package_version === this.worker.productVersion &&
      installation.package_version !== target.version && installation.package_sha256, 'update_offer_mismatch');
    requireValue(!(await this.read(journalFile)), 'update_attempt_pending');
    await this.contactHeaders();
    const attempt = await this.newAttempt(installation, identifier(offer.id), target);
    Object.assign(attempt, { offer_request_id: requestID, node: this.io.node });
    await this.save(attempt);
    return await this.advance(attempt, installation, transport);
  }

  async recover(): Promise<ObjectValue | undefined> {
    const attempt = await this.read(journalFile);
    if (!attempt) return;
    const installation = await this.read(installationFile);
    requireValue(installation, 'worker_setup_required');
    await this.idle();
    const result = await this.advance(attempt, installation, await this.worker.load());
    if (result.outcome !== 'update_confirming') return result;
  }

  private async advance(attempt: ObjectValue, installation: ObjectValue, transport: Transport): Promise<ObjectValue> {
    const target = updateTarget(attempt.target);
    const id = identifier(attempt.id);
    const adopted = typeof attempt.worker_id === 'string';
    const bin = this.bin(installation);
    const details = { operation_id: id, from_version: attempt.from, target_version: target.version, source_sha: target.source_sha,
      expected_digest: target.sha256, offer_request_id: attempt.offer_request_id, worker_id: installation.worker_id };
    const previousDigest = adopted ? text(target.sha256) : text(installation.package_sha256);
    const report = (action: string, digest: string, reason?: string) => transport.request('/api/v1/worker/update', 'POST', encode({
      id, action, target, reason, ...(action === 'adopt' ? { worker_id: attempt.worker_id, previous_version: attempt.from } : {}),
    }), details, 1, 5_000, headers(digest));

    const actual = await bin.read(launcherFile, 0o700);
    const staged = typeof attempt.entry === 'string' && typeof attempt.node === 'string' ?
      launcherScript(attempt.node, attempt.entry, this.state.root) : undefined;
    if (staged && actual === staged) {
      if (this.io.entry !== attempt.entry) return { outcome: 'update_awaiting_confirmation', ...details };
      verifyInstallEntry(text(installation.root), text(attempt.entry));
      requireValue(this.worker.productVersion === target.version && this.io.node === attempt.node &&
        attempt.observed_digest === target.sha256, 'update_running_version_unverified');
      await this.state.write(installationFile, encode({ ...installation, package_version: target.version, package_sha256: target.sha256, entry: attempt.entry, node: attempt.node }));
      await report('applied', text(target.sha256));
      await this.worker.logger.log('INFO', 'worker.update_applied', { ...details, observed_digest: attempt.observed_digest, duration_ms: this.state.sys.now() - integer(attempt.started_at_ms) });
      await this.state.remove(journalFile);
      return { outcome: 'update_confirming', ...details };
    }
    requireValue(actual === attempt.previous_launcher, 'update_launcher_uncertain', details);
    if (!adopted) await this.contactHeaders();

    if (attempt.stage === 'starting') {
      try {
        const receipt = await report(adopted ? 'adopt' : 'begin', previousDigest);
        attempt.attempt = receipt.data.attempt;
      } catch (error) {
        if (error instanceof Failure && error.fields.http_status === 409) await this.state.remove(journalFile);
        throw error;
      }
      attempt.stage = 'downloading';
      await this.save(attempt);
      await this.worker.logger.log('INFO', 'worker.update_started', { ...details, attempt: attempt.attempt, url: target.url });
    }
    const fail = async (reason: string, error?: unknown) => {
      attempt.stage = 'failed';
      attempt.reason = reason;
      await this.save(attempt);
      await this.worker.logger.log(reason === 'target_changed' ? 'WARN' : 'ERROR', 'worker.update_verification_failed', {
        ...details, attempt: attempt.attempt, stage: attempt.entry ? 'activation' : 'download_and_verification', reason, corrective_action: correction(reason), duration_ms: this.state.sys.now() - integer(attempt.started_at_ms),
        ...(error instanceof Failure ? error.fields : error ? { cause: cause(error) } : {}),
      });
    };
    if (attempt.stage === 'downloading' && !attempt.entry) {
      try {
        const candidate = await this.archive.stage(text(installation.root), target);
        Object.assign(attempt, candidate);
        await this.save(attempt);
        await this.worker.logger.log('DEBUG', 'worker.update_archive_verified', { ...details, ...candidate });
      } catch (error) {
        await fail(knownFailure(error), error);
      }
    }
    if (attempt.stage !== 'failed') {
      try {
        await report('activate', previousDigest);
      } catch (error) {
        if (!(error instanceof Failure && ['update_target_changed', 'mixed_broker_releases', 'release_digest_conflict'].includes(String(error.fields.reason)))) throw error;
        await fail('target_changed', error);
      }
    }
    if (attempt.stage !== 'failed') {
      const entry = text(attempt.entry);
      verifyInstallEntry(text(installation.root), entry);
      try {
        await bin.write(launcherFile, launcherScript(text(attempt.node), entry, this.state.root), 0o700);
        await this.worker.logger.log('INFO', 'worker.update_activated', { ...details, attempt: attempt.attempt, observed_digest: attempt.observed_digest,
          duration_ms: this.state.sys.now() - integer(attempt.started_at_ms) });
        return { outcome: 'update_awaiting_confirmation', ...details };
      } catch (error) {
        const observed = await bin.read(launcherFile, 0o700);
        if (observed !== attempt.previous_launcher) throw error;
        await fail('activation_failed', error);
      }
    }
    requireValue(await bin.read(launcherFile, 0o700) === attempt.previous_launcher, 'update_launcher_uncertain', details);
    const response = await report('failed', previousDigest, text(attempt.reason));
    await this.worker.logger.log('WARN', 'worker.update_fallback', { ...details, attempt: attempt.attempt, cause: attempt.reason, stage: 'fallback', observed_digest: previousDigest,
      corrective_action: correction(text(attempt.reason)), retry_at: response.data.retry_at });
    await this.state.remove(journalFile);
    return { outcome: 'update_failed', ...details, cause: attempt.reason };
  }
}
