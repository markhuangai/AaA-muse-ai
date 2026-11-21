import { drainMedia } from './media.js';
import { Worker } from './worker.js';
import { Failure, cause, requireValue } from './errors.js';
import { connection, correlation } from './protocol.js';
import { encode, identifier, integer, object, parse, text, type ObjectValue } from './json.js';
import type { Transport } from './transport.js';

export class Subscriber {
  active?: ObjectValue;
  lastEvent = '';
  private supervision?: ObjectValue;
  private lastAcknowledged?: ObjectValue;
  private mediaUpload?: Promise<void>;
  private mediaFailure?: unknown;
  constructor(readonly worker: Worker) {}
  async heartbeat(transport: Transport, challenge: ObjectValue): Promise<ObjectValue> {
    connection(challenge);
    identifier(challenge.challenge_id);
    requireValue(this.active && challenge.connection_id === this.active.connection_id && integer(challenge.connection_generation) === integer(this.active.connection_generation), 'health_connection_mismatch');
    const input: ObjectValue = { protocol_version: 1, connection_id: challenge.connection_id, connection_generation: challenge.connection_generation, challenge_id: challenge.challenge_id };
    const acks = await this.worker.state.child('acks');
    let acknowledged: ObjectValue | undefined;
    for (const name of (await acks.list()).filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n))) {
      const ack = object(parse((await acks.read(name))!));
      if (ack.state !== 'queued') continue;
      const current = await this.worker.getJob(transport, text(ack.job_id));
      requireValue(integer(current.generation) === integer(ack.generation) && current.lease_id === ack.lease_id && ['cancelled', 'interrupted'].includes(text(current.state)), 'idle_ack_assignment_changed');
      if (current.held !== true) {
        ack.state = 'confirmed'; await acks.write(name, encode(ack));
        await this.worker.publish(current, 'ack_confirmed', 'broker_already_released_hold');
        continue;
      }
      requireValue(!acknowledged, 'multiple_idle_acknowledgements');
      input.idle_ack = { job_id: ack.job_id, generation: ack.generation, lease_id: ack.lease_id };
      acknowledged = ack;
    }
    let result;
    try {
      result = await transport.request('/api/v1/worker/heartbeat', 'POST', encode(input), { worker_id: this.worker.config.worker_id, operation_id: this.active!.connection_id, connection_id: this.active!.connection_id, connection_generation: this.active!.connection_generation });
    } catch (error) {
      if (error instanceof Failure && error.code === 'broker_rejected' && error.fields.http_status === 409 &&
          (error.fields.reason === 'stale_connection' || error.fields.reason === 'unknown_or_expired_challenge')) error.retryable = true;
      throw error;
    }
    const at = new Date(this.worker.state.sys.now()).toISOString();
    this.lastAcknowledged = { at, connection_id: challenge.connection_id, connection_generation: challenge.connection_generation, request_id: result.requestId };
    await this.saveConnection(text(result.data.connection_status), { last_heartbeat_at: at });
    if (acknowledged) {
      acknowledged.state = 'confirmed';
      await acks.write(`${text(acknowledged.job_id)}.json`, encode(acknowledged));
      const current = await this.worker.getJob(transport, text(acknowledged.job_id));
      await this.worker.publish(current, 'ack_confirmed', 'broker_confirmed_idle');
      await this.worker.logger.log('INFO', 'worker.idle_confirmed', { ...correlation(current), request_id: result.requestId });
    }
    return this.lastAcknowledged;
  }
  private async saveConnection(status: string, fields: ObjectValue = {}): Promise<void> {
    await this.worker.state.write('connection.json', encode({ ...this.active, ...this.supervision, status,
      last_event_id: this.lastEvent, last_acknowledged: this.lastAcknowledged, ...fields }));
  }
  async run(signal: AbortSignal, background = false): Promise<void> {
    const { worker } = this;
    const release = await worker.state.lock('daemon', false);
    try {
      if (background) requireValue(!(await worker.state.read('run-stop.json')), 'subscriber_terminal_stop');
      const owner = await worker.state.lockOwner('daemon');
      requireValue(owner?.pid === worker.state.sys.pid, 'lock_owner_ambiguous', { lock: 'daemon' });
      this.supervision = { subscriber_pid: owner.pid, subscriber_owner: owner.owner, subscriber_started_at: worker.state.sys.now() };
      this.lastAcknowledged = undefined;
      const transport = await worker.load();
      let attempt = 0;
      let previousHeartbeat: ObjectValue | undefined;
      await worker.logger.log('INFO', 'worker.supervision_started', { worker_id: worker.config.worker_id, pid: worker.state.sys.pid, lock: 'daemon', outcome: 'exclusive_owner', background });
      await worker.logger.log('INFO', 'worker.started', { worker_id: worker.config.worker_id, endpoint: worker.config.origin, inference_readiness: 'unverified' });
      while (!signal.aborted) {
        this.active = undefined;
        let phase = 'authentication';
        const started = worker.state.sys.now();
        try {
          const status = await worker.identity(transport);
          phase = 'reconciliation';
          await worker.reconcile(transport, status);
          if (signal.aborted) break;
          phase = 'subscription';
          const installed = await worker.state.read('installation.json');
          const report = installed ? object(parse(installed)).model_report : undefined;
          for await (const event of transport.events(signal, report)) {
            this.lastEvent = event.id;
            if (event.type === 'connection.opened') {
              connection(event.data);
              requireValue(!this.active, 'duplicate_connection_opened');
              this.active = event.data;
              await this.saveConnection('connecting');
              await worker.logger.log('INFO', 'worker.connected', { worker_id: worker.config.worker_id, ...event.data });
            } else if (event.type === 'health.challenge') {
              previousHeartbeat = await this.heartbeat(transport, event.data);
              if (this.mediaFailure) throw this.mediaFailure;
              this.mediaUpload ??= drainMedia(worker, transport).catch(error => { this.mediaFailure = error; }).finally(() => { this.mediaUpload = undefined; });
              if (attempt > 0) await worker.logger.log('INFO', 'worker.stream_recovered', { worker_id: worker.config.worker_id,
                ...previousHeartbeat, retries: attempt, outcome: 'heartbeat_confirmed' });
              attempt = 0;
            } else if (event.type === 'job.available') {
              requireValue(this.active && event.data.worker_id === worker.config.worker_id, 'job_owner_mismatch');
              try { await worker.claim(transport, text(event.data.job_id), this.active); }
              catch (error) {
                if (!(error instanceof Failure && error.code === 'broker_rejected' && !error.retryable)) throw error;
                await worker.logger.log('WARN', 'worker.claim_rejected', { job_id: event.data.job_id, worker_id: worker.config.worker_id, ...error.fields });
              }
            } else {
              requireValue(this.active, 'connection_not_open');
              const current = await worker.getJob(transport, text(event.data.job_id));
              requireValue(integer(current.generation) === integer(event.data.generation), 'cancellation_generation_mismatch');
              await worker.publish(current, text(current.state), 'awaiting_explicit_idle_acknowledgement');
            }
          }
        } catch (error) {
          if (signal.aborted) break;
          if (!(error instanceof Failure && error.retryable)) throw error;
          const delay = Math.min(30_000, 1000 * 2 ** Math.min(attempt++, 5));
          await worker.logger.log('WARN', 'worker.stream_retrying', { worker_id: worker.config.worker_id, endpoint: worker.config.origin, ...this.active,
            previous_connection_id: previousHeartbeat?.connection_id, previous_connection_generation: previousHeartbeat?.connection_generation,
            cause: cause(error), ...error.fields, phase, attempt, delay_ms: delay, duration_ms: worker.state.sys.now() - started, last_event_id: this.lastEvent });
          await this.saveConnection('offline');
          for (let elapsed = 0; elapsed < delay && !signal.aborted; elapsed += 100) await worker.state.sys.wait(Math.min(100, delay - elapsed));
        }
      }
      await worker.logger.log('INFO', 'worker.stopped', { worker_id: worker.config.worker_id, last_event_id: this.lastEvent });
    } catch (error) {
      if (background) {
        try {
          if (!(await worker.state.read('run-stop.json'))) await worker.state.write('run-stop.json', encode({ cause: cause(error), pid: worker.state.sys.pid, stopped_at: worker.state.sys.now(), requires_operator_action: true }));
        } catch (markerError) {
          worker.logger.stderr(encode({ level: 'ERROR', msg: 'setup.recovery_marker_failed', cause: cause(markerError), pid: worker.state.sys.pid }) + '\n');
        }
      }
      throw error;
    } finally { await this.mediaUpload;
      await release(); }
  }
}
