import { Worker } from './worker.js';
import { Failure, cause, requireValue } from './errors.js';
import { connection, correlation } from './protocol.js';
import { encode, identifier, integer, object, parse, text, type ObjectValue } from './json.js';
import type { Transport } from './transport.js';

export class Subscriber {
  active?: ObjectValue;
  lastEvent = '';
  constructor(readonly worker: Worker) {}
  async heartbeat(transport: Transport, challenge: ObjectValue): Promise<void> {
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
    await this.worker.state.write('connection.json', encode({ ...this.active, last_event_id: this.lastEvent, last_heartbeat_at: new Date(this.worker.state.sys.now()).toISOString(), status: result.data.connection_status }));
    if (acknowledged) {
      acknowledged.state = 'confirmed';
      await acks.write(`${text(acknowledged.job_id)}.json`, encode(acknowledged));
      const current = await this.worker.getJob(transport, text(acknowledged.job_id));
      await this.worker.publish(current, 'ack_confirmed', 'broker_confirmed_idle');
      await this.worker.logger.log('INFO', 'worker.idle_confirmed', { ...correlation(current), request_id: result.requestId });
    }
  }
  async run(signal: AbortSignal): Promise<void> {
    const { worker } = this;
    const transport = await worker.load();
    const release = await worker.state.lock('daemon', false);
    try {
      const status = await worker.identity(transport);
      await worker.reconcile(transport, status);
      let attempt = 0;
      await worker.logger.log('INFO', 'worker.started', { worker_id: worker.config.worker_id, endpoint: worker.config.origin, inference_readiness: 'unverified' });
      while (!signal.aborted) {
        this.active = undefined;
        try {
          for await (const event of transport.events(signal)) {
            this.lastEvent = event.id;
            if (event.type === 'connection.opened') {
              connection(event.data);
              requireValue(!this.active, 'duplicate_connection_opened');
              this.active = event.data;
              await worker.state.write('connection.json', encode({ ...event.data, last_event_id: event.id, status: 'connecting' }));
              await worker.logger.log('INFO', 'worker.connected', { worker_id: worker.config.worker_id, ...event.data });
            } else if (event.type === 'health.challenge') {
              await this.heartbeat(transport, event.data);
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
          await worker.logger.log('WARN', 'worker.stream_retrying', { worker_id: worker.config.worker_id, endpoint: worker.config.origin, ...this.active, cause: cause(error), ...error.fields, attempt, delay_ms: delay, last_event_id: this.lastEvent });
          await worker.state.write('connection.json', encode({ ...(this.active ?? {}), status: 'offline', last_event_id: this.lastEvent }));
          for (let elapsed = 0; elapsed < delay && !signal.aborted; elapsed += 100) await worker.state.sys.wait(Math.min(100, delay - elapsed));
        }
      }
      await worker.logger.log('INFO', 'worker.stopped', { worker_id: worker.config.worker_id, last_event_id: this.lastEvent });
    } finally { await release(); }
  }
}
