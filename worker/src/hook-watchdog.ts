import { iso, time } from './cron.js';
import { updateHealthFile } from './cron-update.js';
import { requireValue } from './errors.js';
import { hookInstallation } from './hook-setup.js';
import { bootIdentity, tickHealthFile } from './hook.js';
import { encode, integer, object, type ObjectValue } from './json.js';
import type { Worker } from './worker.js';

const staleMs = 300_000;
const noticeFile = 'watchdog-notice.json';

export class HookWatchdog {
  constructor(readonly worker: Worker, readonly boot = bootIdentity) {}

  private read(name: string) { return this.worker.readRecord(this.worker.state, name); }

  async check(): Promise<ObjectValue> {
    const state = this.worker.state;
    return state.withLock('watchdog', async () => {
      const registration = await this.read(hookInstallation);
      requireValue(registration, 'hook_registration_unverified');
      const now = state.sys.now();
      const observedBoot = await this.boot(state.sys.pid);
      const health = await this.read(tickHealthFile);
      const bootChanged = health !== undefined && health.boot_id !== observedBoot;
      const lastSuccess = health?.last_success_at ? time(health.last_success_at) : time(registration.confirmed_at);
      const incidents: ObjectValue[] = [];
      const keys: ObjectValue[] = [];
      if (now - lastSuccess > staleMs || (bootChanged && now - time(health?.last_tick_at) > staleMs)) {
        const kind = health ? 'hook_tick_stale' : 'hook_tick_missing';
        const corrective = 'Inspect the worker hook in the main Muse chat and confirm its next authenticated tick.';
        incidents.push({ kind, last_tick_at: health?.last_tick_at ?? null, last_outcome: health?.last_outcome ?? null,
          last_cause: health?.cause ?? null, observed_age_ms: now - lastSuccess, corrective_action: corrective });
        keys.push({ kind, boot: observedBoot });
      }
      const claim = await this.read('cron-claim.json');
      if (claim && now > time(claim.deadline_at) && object(claim.receipt ?? {}).accepted !== true && !claim.failure) {
        const kind = 'claim_deadline_exceeded';
        incidents.push({ kind, operation_id: claim.operation_id, job_id: claim.job_id, claim_id: claim.claim_id,
          generation: claim.generation, deadline_at: claim.deadline_at, wake_invocation_id: claim.wake_invocation_id,
          corrective_action: 'Keep the claim held and inspect the wake and delivery evidence on the matching release.' });
        keys.push({ kind, claim: claim.claim_id });
      }
      const journal = await this.read('cron-update.json');
      const failed = await this.read(updateHealthFile);
      if (journal?.stage === 'failed' || failed || (journal && now - integer(journal.started_at_ms) > staleMs)) {
        const kind = journal?.stage === 'failed' || failed ? 'update_failed' : 'update_stalled';
        const target = (journal ? object(journal.target).version : failed?.target_version) ?? null;
        const cause = journal?.reason ?? failed?.cause ?? 'no_update_progress';
        incidents.push({ kind, operation_id: journal?.id ?? failed?.operation_id ?? null, target_version: target, cause,
          stage: journal?.stage ?? 'fallback', retry_at: failed?.retry_at ?? null, started_at: journal ? iso(integer(journal.started_at_ms)) : null,
          corrective_action: 'Inspect the protected update exchange and the deployed release pin before taking action.' });
        keys.push({ kind, target, cause });
      }
      const previous = await this.read(noticeFile);
      const fingerprint = incidents.length ? encode(keys) : '';
      const notify = Boolean(fingerprint !== (previous?.fingerprint ?? '') && (fingerprint || previous?.fingerprint));
      const noticeID = notify ? state.sys.uuid() : previous?.notice_id ?? null;
      const outcome = incidents.length ? 'incident' : notify ? 'recovered' : 'healthy';
      const result = { notify, outcome, notice_id: noticeID, incidents, boot_changed: bootChanged, last_tick_at: health?.last_tick_at ?? null };
      const details = { ...result, hook_id: registration.hook_id, worker_id: registration.worker_id,
        expected_staleness_ms: staleMs, observed_boot_id: observedBoot, last_tick_boot_id: health?.boot_id,
        checked_at: iso(now), watchdog_job_id: registration.watchdog_job_id };
      if (notify) {
        await this.worker.logger.log(incidents.length ? 'WARN' : 'INFO', 'hook.watchdog_notice', details);
        await state.write(noticeFile, encode({ fingerprint, notice_id: noticeID }));
      } else await this.worker.logger.log('DEBUG', 'hook.watchdog_check', details);
      return result;
    });
  }
}
