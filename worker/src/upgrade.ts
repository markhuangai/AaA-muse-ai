import { isAbsolute } from 'node:path';
import { cause, Failure, requireValue } from './errors.js';
import { readObject, readOwnership, readSubscriber, watchdogSettings } from './health.js';
import { encode, identifier, integer, object, text, type ObjectValue } from './json.js';
import { Setup } from './setup.js';
import { checkLocalWork, oldOutage } from './upgrade-evidence.js';
import type { Transport } from './transport.js';
import type { LockOwner } from './state.js';

interface UpgradeIO {
  stage(root: string, entry: string): Promise<string>;
  stop(owner: LockOwner, stateDir: string, installation: ObjectValue): void;
}

const attemptEntry = 'upgrade.json';
type Mode = 'prepare' | 'apply' | 'cancel';

export class EnrolledUpgrade {
  constructor(readonly setup: Setup, readonly io: UpgradeIO, readonly sha: string) {}

  async run(mode: Mode): Promise<ObjectValue> {
    const { state, worker } = this.setup;
    return await state.withLock('upgrade', async () => {
      const installed = await readObject(state, 'installation.json');
      const config = await readObject(state, 'config.json');
      requireValue(installed && config && identifier(config.worker_id) === installed.worker_id &&
        config.origin === installed.origin && isAbsolute(text(installed.root)), 'upgrade_identity_mismatch');
      identifier(installed.setup_id);
      const transport = await worker.load();
      const status = await worker.identity(transport);
      const pin = object(status.worker_package);
      requireValue(pin.version === this.setup.version && pin.sha256 === this.sha, 'upgrade_package_pin_changed');
      const saved = await readObject(state, attemptEntry);
      if (saved) requireValue(saved.worker_id === installed.worker_id && saved.setup_id === installed.setup_id &&
        saved.sha256 === this.sha && saved.package_version === this.setup.version, 'upgrade_attempt_mismatch');
      if (mode === 'cancel') {
        if (saved) await this.release(transport, saved);
        await state.remove(attemptEntry);
        return { outcome: 'cancelled' };
      }
      if (mode === 'prepare') return await this.prepare(transport, installed, status, saved);
      requireValue(saved, 'upgrade_prepare_required');
      try {
        const generation = integer(saved.generation);
        await this.reservation(transport, saved, 'renew', generation);
        const before = await readSubscriber(state);
        const alreadyInstalled = installed.package_version === this.setup.version && before.owner_state === 'live';
        let setup = this.setup;
        let receipt = this.setup.registrationReceipt(text(installed.root), identifier(installed.worker_id));
        if (!alreadyInstalled) {
          await checkLocalWork(setup, transport);
          await oldOutage(setup, installed);
          let entry = saved.staged_entry;
          if (entry === undefined) {
            await setup.io.prepareDirectory(text(installed.root) + '/releases', 'install_directory');
            entry = await this.io.stage(text(installed.root), setup.io.entry);
            saved.staged_entry = entry;
            await state.write(attemptEntry, encode(saved));
          }
          await this.stopAndArchive(transport, saved, installed);
          setup = new Setup(worker, { ...setup.io, entry: text(entry) }, setup.version);
          receipt = await setup.install(text(installed.origin), '', text(installed.root), text(installed.setup_id), undefined, true);
        }
        const heartbeat = await this.waitForHeartbeat(integer(saved.previous_connection_generation));
        await this.release(transport, saved);
        await state.remove(attemptEntry);
        await setup.log('INFO', 'worker.upgrade_completed', { operation_id: saved.operation_id, ...heartbeat, outcome: 'heartbeat_confirmed' });
        return { ...receipt, ...heartbeat, outcome: 'upgraded', package_version: setup.version };
      } catch (error) {
        await this.release(transport, saved);
        await this.setup.log('ERROR', 'worker.upgrade_failed', { operation_id: saved.operation_id, cause: cause(error), outcome: 'restore_native_registrations' });
        throw error;
      }
    });
  }

  private async prepare(transport: Transport, installed: ObjectValue, status: ObjectValue, previous?: ObjectValue): Promise<ObjectValue> {
    const { state } = this.setup;
    const local = await readSubscriber(state);
    if (installed.package_version === this.setup.version && local.connection_status === 'online' && status.connection_status === 'online') {
      if (previous) {
        await this.release(transport, previous);
        await state.remove(attemptEntry);
      }
      return { ...this.setup.registrationReceipt(text(installed.root), identifier(installed.worker_id)),
        outcome: 'already_current', package_version: this.setup.version, pid: local.pid, connection_generation: local.connection_generation };
    }
    const ownership = await readOwnership(state);
    const live = ownership.status === 'live' && status.connection_status === 'online';
    const absent = ownership.status === 'absent' && status.connection_status === 'offline';
    requireValue(live || absent, 'upgrade_subscriber_ambiguous', { local_owner: ownership.status, connection_status: status.connection_status });
    requireValue(status.current_job === null && integer(status.waiting_for_client_tool) === 0 &&
      ['idle', 'unknown', 'upgrading'].includes(text(status.work_status)), 'upgrade_worker_busy');
    await checkLocalWork(this.setup, transport);
    await oldOutage(this.setup, installed);
    const stagedEntry = previous?.staged_entry;
    if (previous?.generation !== undefined) {
      try {
        const lease = await this.reservation(transport, previous, 'renew', integer(previous.generation));
        return { outcome: 'reserved', expires_at: lease.expires_at };
      } catch (error) {
        if (!(error instanceof Failure && error.fields.reason === 'upgrade_reservation_fenced')) throw error;
        previous = undefined;
      }
    }
    if (previous && status.work_status !== 'upgrading' && integer(status.upgrade_reservation_generation) !== integer(previous.base_generation)) {
      previous = undefined;
    }
    const saved: ObjectValue = previous ?? {
      operation_id: state.sys.uuid(), worker_id: installed.worker_id, setup_id: installed.setup_id,
      package_version: this.setup.version, sha256: this.sha, base_generation: integer(status.upgrade_reservation_generation),
      previous_connection_generation: local.connection_generation ?? 0, owner: ownership.owner ? { ...ownership.owner } : null,
      ...(stagedEntry !== undefined && { staged_entry: stagedEntry }),
    };
    await state.write(attemptEntry, encode(saved));
    const lease = await this.reservation(transport, saved, 'acquire', integer(saved.base_generation));
    saved.generation = lease.generation;
    await state.write(attemptEntry, encode(saved));
    return { outcome: 'reserved', expires_at: lease.expires_at };
  }

  private async reservation(transport: Transport, saved: ObjectValue, action: string, generation: number): Promise<ObjectValue> {
    const operation_id = identifier(saved.operation_id);
    const reply = await transport.request('/api/v1/worker/upgrade-reservation', 'POST', encode({ protocol_version: 1, action, operation_id, generation }), { operation_id });
    requireValue(reply.data.operation_id === operation_id && integer(reply.data.generation) === generation + (action === 'acquire' ? 1 : 0) &&
      (action === 'release' ? reply.data.expires_at === undefined : Number.isFinite(Date.parse(text(reply.data.expires_at)))), 'upgrade_reservation_invalid');
    await this.setup.log('INFO', 'worker.upgrade_reservation', { operation_id, request_id: reply.requestId, lease_generation: reply.data.generation,
      expires_at: reply.data.expires_at, outcome: action });
    return reply.data;
  }

  private async release(transport: Transport, saved: ObjectValue): Promise<void> {
    try {
      await this.reservation(transport, saved, 'release', saved.generation === undefined ? integer(saved.base_generation) + 1 : integer(saved.generation));
    } catch (error) {
      await this.setup.log('WARN', 'worker.upgrade_release_unconfirmed', { operation_id: saved.operation_id, cause: cause(error),
        ...(error instanceof Failure ? error.fields as ObjectValue : {}), outcome: 'fenced_or_expires' });
    }
  }

  private async stopAndArchive(transport: Transport, saved: ObjectValue, installed: ObjectValue): Promise<void> {
    const { state } = this.setup;
    await state.withLock('launch', async () => {
      const live = await readOwnership(state);
      requireValue(live.status !== 'ambiguous', 'upgrade_subscriber_ambiguous');
      const evidence = await oldOutage(this.setup, installed);
      await checkLocalWork(this.setup, transport);
      await this.reservation(transport, saved, 'renew', integer(saved.generation));
      if (live.owner) {
        const owner = (await readOwnership(state)).owner;
        const expected = object(saved.owner);
        requireValue(owner && owner.owner === live.owner.owner && owner.owner === expected.owner && owner.pid === integer(expected.pid), 'upgrade_subscriber_changed');
        this.io.stop(owner, state.root, installed);
        const deadline = state.sys.now() + 35_000;
        while (state.sys.alive(owner.pid) === true && state.sys.now() < deadline) await state.sys.wait(100);
        requireValue((await readOwnership(state)).status === 'absent', 'upgrade_subscriber_stop_unconfirmed', { pid: owner.pid });
      }
      if (evidence) {
        await state.withLock('daemon', async () => {
          await state.archive('run-stop.json', evidence.archive, evidence.raw);
        });
        await this.setup.log('INFO', 'worker.upgrade_stop_archived', { operation_id: saved.operation_id,
          request_id: evidence.requestID, route: '/api/v1/worker/status', http_status: 404, outcome: 'original_preserved' });
      }
    });
  }

  private async waitForHeartbeat(previous: number): Promise<ObjectValue> {
    const { state } = this.setup;
    const deadline = state.sys.now() + watchdogSettings.launch_observation_ms;
    do {
      const current = await readSubscriber(state);
      if (current.owner_state === 'live' && current.connection_status === 'online' && current.heartbeat_evidence === 'current' &&
        current.connection_generation !== null && current.connection_generation > previous) {
        return { pid: current.pid, connection_generation: current.connection_generation, connection_id: current.connection_id,
          request_id: current.heartbeat_request_id };
      }
      await state.sys.wait(100);
    } while (state.sys.now() < deadline);
    throw new Failure('upgrade_heartbeat_unconfirmed');
  }
}
