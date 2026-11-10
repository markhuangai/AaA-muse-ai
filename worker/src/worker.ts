import { State } from './state.js';
import { Logger } from './diagnostics.js';
import { Transport, origin, validateBody, type Network } from './transport.js';
import { cause, Failure, requireValue } from './errors.js';
import { decision, encode, identifier, integer, object, parse, text, type ObjectValue, type Value } from './json.js';
import { correlation, job, version } from './protocol.js';

export class Worker {
  config: ObjectValue = {};
  credential = '';
  constructor(readonly state: State, readonly logger: Logger, readonly net?: Network) {}
  async load(enrolled = true): Promise<Transport> {
    const raw = await this.state.read('config.json');
    requireValue(raw, 'worker_not_configured');
    this.config = object(parse(raw));
    version(this.config.protocol_version);
    const endpoint = origin(text(this.config.origin));
    this.credential = (await this.state.read('credential.key'))?.trim() ?? '';
    this.logger.redactor.add(this.credential);
    if (enrolled) requireValue(/^muse_worker_[A-Za-z0-9_-]{43}$/.test(this.credential), 'worker_not_enrolled');
    return new Transport(endpoint, this.credential, this.logger, this.state.sys, this.net);
  }
  async configure(endpoint: string): Promise<ObjectValue> {
    const normalized = origin(endpoint);
    return await this.state.withLock('config', async () => {
      const raw = await this.state.read('config.json');
      const saved = raw ? object(parse(raw)) : undefined;
      requireValue(!saved || saved.origin === normalized || !(await this.state.read('credential.key')), 'enrolled_origin_immutable');
      if (saved?.origin !== normalized) await this.state.write('config.json', encode({ protocol_version: 1, origin: normalized }));
      await this.logger.log('INFO', 'worker.configured', { endpoint: normalized, identity_preserved: !!saved?.worker_id });
      return { configured: true, origin: normalized };
    });
  }
  async identity(transport: Transport): Promise<ObjectValue> {
    const reply = await transport.request('/api/v1/worker/status');
    const id = identifier(reply.data.id);
    requireValue(!this.config.worker_id || this.config.worker_id === id, 'worker_identity_mismatch');
    if (!this.config.worker_id) {
      this.config.worker_id = id;
      await this.state.withLock('config', async () => { await this.state.write('config.json', encode(this.config)); });
    }
    return reply.data;
  }
  async enroll(code: string): Promise<ObjectValue> {
    this.logger.redactor.add(code);
    requireValue(/^muse_enroll_[A-Za-z0-9_-]{43}$/.test(code), 'invalid_enrollment_code');
    return await this.state.withLock('config', async () => {
      const transport = await this.load(false);
      if (this.credential) {
        const record = (await transport.request('/api/v1/worker/status')).data;
        const id = identifier(record.id);
        requireValue(!this.config.worker_id || this.config.worker_id === id, 'worker_identity_mismatch');
        this.config.worker_id = id;
        await this.state.write('config.json', encode(this.config));
        await this.logger.log('INFO', 'worker.identity_preserved', { worker_id: id });
        return { worker_id: id, identity_preserved: true };
      }
      const saved = await this.state.read('enrollment.json');
      requireValue(!saved || object(parse(saved)).state === 'rejected', 'enrollment_uncertain', { corrective_action: 'inspect management issuance records, revoke any orphaned identity, then use a separate clean state directory' });
      await this.state.write('enrollment.json', encode({ state: 'pending', started_at: new Date(this.state.sys.now()).toISOString() }));
      let response;
      try { response = await transport.request('/api/v1/worker/enroll', 'POST', encode({ enrollment_code: code }), {}, 1); }
      catch (error) {
        if (error instanceof Failure && error.code === 'broker_rejected' && !error.retryable) await this.state.write('enrollment.json', encode({ state: 'rejected', ...error.fields }));
        throw error;
      }
      const credential = text(response.data.credential);
      this.logger.redactor.add(credential);
      requireValue(/^muse_worker_[A-Za-z0-9_-]{43}$/.test(credential), 'invalid_enrollment_response');
      const id = identifier(object(response.data.worker).id);
      await this.state.write('credential.key', credential + '\n');
      this.config.worker_id = id;
      await this.state.write('config.json', encode(this.config));
      await this.state.write('enrollment.json', encode({ state: 'accepted', worker_id: id, request_id: response.requestId }));
      await this.logger.log('INFO', 'worker.enrolled', { worker_id: id, request_id: response.requestId });
      return { worker_id: id, identity_preserved: false };
    });
  }
  async getJob(transport: Transport, id: string): Promise<ObjectValue> {
    identifier(id);
    return job((await transport.request(`/api/v1/worker/jobs/${id}`, 'GET', undefined, { job_id: id, worker_id: text(this.config.worker_id) })).data, text(this.config.worker_id), id);
  }
  async publish(j: ObjectValue, phase: string, progress: string): Promise<void> {
    if (phase === 'claimed') phase = 'pending';
    await this.state.withLock('cues', async () => {
      if (phase === 'cancelled' || phase === 'interrupted') {
        const saved = await (await this.state.child('acks')).read(`${text(j.id)}.json`);
        const ack = saved ? object(parse(saved)) : undefined;
        if (ack?.state === 'confirmed' && ack.job_id === j.id && integer(ack.generation) === integer(j.generation) && ack.lease_id === j.lease_id) {
          phase = 'ack_confirmed'; progress = 'broker_already_confirmed_idle';
        }
      }
      const cues = await this.state.child('cues');
      const cue = { protocol_version: 1, ...correlation(j), state: phase, progress, updated_at: new Date(this.state.sys.now()).toISOString(), needs_attention: ['pending', 'cancelled', 'interrupted'].includes(phase) };
      await cues.write(`${text(j.id)}.json`, encode(cue));
      const values: ObjectValue[] = [];
      for (const name of (await cues.list()).filter(n => /^[A-Za-z0-9_-]+\.json$/.test(n)).sort()) {
        const value = object(parse((await cues.read(name))!));
        if (value.needs_attention === true) values.push(value);
      }
      await this.state.write('pending.json', encode({ protocol_version: 1, worker_id: this.config.worker_id, jobs: values, updated_at: cue.updated_at }));
    });
    await this.logger.log(phase === 'cancelled' || phase === 'interrupted' ? 'WARN' : 'INFO', 'worker.job_progress', { ...correlation(j), state: phase, progress, observed_state: j.state, observed_held: j.held, reason: j.reason ?? '', acknowledgement_required: phase !== 'ack_confirmed' && j.held === true && j.state !== 'claimed', elapsed_ms: j.claimed_at ? this.state.sys.now() - Date.parse(text(j.claimed_at)) : 0 });
  }
  async operation(kind: string, j: ObjectValue, build: (submission: string) => ObjectValue, decisionInput = ''): Promise<ObjectValue> {
    const journals = await this.state.child('journals');
    return await journals.withLock('journal', async () => {
      const pointer = `${kind}-${text(j.id)}.json`;
      const prior = await journals.read(pointer);
      if (prior) {
        const id = identifier(object(parse(prior)).submission_id);
        const saved = object(parse((await journals.read(`operation-${id}.json`))!));
        if (saved.state !== 'rejected') {
          requireValue(saved.decision_input === decisionInput, 'pending_submission_conflict', { submission_id: id, expected: 'identical_pending_decision' });
          return saved;
        }
      }
      const id = this.state.sys.uuid();
      const body = encode(build(id));
      validateBody(body);
      const value = { kind, submission_id: id, state: 'pending', body, decision_input: decisionInput, origin: this.config.origin, worker_id: this.config.worker_id, ...correlation(j), started_at: new Date(this.state.sys.now()).toISOString() };
      await journals.write(`operation-${id}.json`, encode(value));
      await journals.write(pointer, encode({ submission_id: id }));
      return value;
    });
  }
  async send(transport: Transport, j: ObjectValue, operation: ObjectValue): Promise<ObjectValue> {
    const journals = await this.state.child('journals');
    const id = identifier(operation.submission_id);
    requireValue(operation.origin === this.config.origin && operation.worker_id === this.config.worker_id && operation.job_id === j.id, 'journal_owner_mismatch');
    const route = `/api/v1/worker/jobs/${text(j.id)}/${operation.kind === 'claim' ? 'claim' : 'decisions'}`;
    await this.logger.log('INFO', 'worker.operation_started', { ...correlation(j), submission_id: id, operation: operation.kind, previous_outcome: operation.state });
    try {
      const reply = await transport.request(route, 'POST', text(operation.body), { ...correlation(j), submission_id: id });
      if (operation.kind === 'claim') job(reply.data, text(this.config.worker_id), text(j.id));
      else requireValue(reply.data.id === j.experiment_id && reply.data.conversation_id === j.conversation_id && reply.data.worker_id === j.worker_id && ['completed', 'waiting_for_tool'].includes(text(reply.data.state)), 'decision_response_mismatch');
      operation.state = 'accepted'; operation.result = reply.data; operation.request_id = reply.requestId;
      await journals.write(`operation-${id}.json`, encode(operation));
      await this.logger.log('INFO', 'worker.operation_accepted', { ...correlation(j), submission_id: id, request_id: reply.requestId, operation: operation.kind });
      return reply.data;
    } catch (error) {
      operation.state = error instanceof Failure && ['broker_rejected', 'worker_unauthorized'].includes(error.code) && !error.retryable ? 'rejected' : 'uncertain';
      operation.last_error = cause(error);
      await journals.write(`operation-${id}.json`, encode(operation));
      throw error;
    }
  }
  async claim(transport: Transport, id: string, connection: ObjectValue): Promise<void> {
    const current = await this.getJob(transport, id);
    const op = await this.operation('claim', current, submission => ({ protocol_version: 1, submission_id: submission, connection_id: connection.connection_id, connection_generation: connection.connection_generation }));
    await this.send(transport, current, op);
    const observed = await this.getJob(transport, id);
    requireValue(observed.state === 'claimed' && observed.held === true && observed.connection_id === connection.connection_id && integer(observed.connection_generation) === integer(connection.connection_generation), 'recovered_claim_not_current', { ...correlation(observed), observed_state: observed.state });
    await this.publish(observed, 'pending', 'awaiting_muse_decision');
  }
  async show(id: string): Promise<ObjectValue> {
    const transport = await this.load();
    await this.identity(transport);
    const current = await this.getJob(transport, id);
    await this.logger.log('DEBUG', 'worker.context', { ...correlation(current), context: current.context });
    await this.publish(current, text(current.state), 'context_shown');
    return { protocol_version: 1, ...correlation(current), state: current.state, context: current.context };
  }
  async submit(id: string, input: string): Promise<ObjectValue> {
    let current: ObjectValue | undefined;
    let operation: ObjectValue | undefined;
    try {
      const transport = await this.load();
      await this.identity(transport);
      current = await this.getJob(transport, id);
      try {
        validateBody(input);
        await this.logger.log('DEBUG', 'worker.decision_input', { ...correlation(current), input: parse(input), input_complete: true });
      } catch (error) {
        if (error instanceof Failure && error.code === 'diagnostics_unavailable') throw error;
        await this.logger.log('DEBUG', 'worker.decision_input', { ...correlation(current), input_complete: false, input_omitted: true, omitted_input_bytes: Buffer.byteLength(input), omission_reason: 'input_not_admitted_as_strict_json', validation_cause: cause(error), validation: error instanceof Failure ? error.fields : {}, expected: ['final_with_text', 'tool_call_with_call_id_name_object_arguments'] });
        throw error;
      }
      const d = decision(input, object(current.context).tools);
      const op = await this.operation('decision', current, submission => {
        requireValue(current!.state === 'claimed' && current!.held === true, 'assignment_not_active');
        return { protocol_version: 1, submission_id: submission, connection_id: current!.connection_id, connection_generation: current!.connection_generation, conversation_id: current!.conversation_id, generation: current!.generation, lease_id: current!.lease_id, context_receipt_id: object(current!.context).receipt_id, decision: d };
      }, encode(d));
      operation = op;
      const result = await this.send(transport, current, op);
      await this.publish(current, text(result.state), 'decision_accepted');
      return { accepted: true, submission_id: op.submission_id, experiment: result };
    } catch (error) {
      await this.logger.log('WARN', 'worker.decision_rejected', { ...(current ? correlation(current) : { job_id: id }), submission_id: operation?.submission_id, cause: cause(error), ...(error instanceof Failure ? error.fields : {}), input_bytes: Buffer.byteLength(input) });
      throw error;
    }
  }
  async ack(id: string): Promise<ObjectValue> {
    const transport = await this.load();
    await this.identity(transport);
    const current = await this.getJob(transport, id);
    requireValue(['cancelled', 'interrupted'].includes(text(current.state)), 'idle_ack_requires_stopped_assignment');
    const acks = await this.state.child('acks');
    await acks.withLock('ack', async () => {
      const prior = await acks.read(`${id}.json`);
      if (prior) {
        const saved = object(parse(prior));
        requireValue(integer(saved.generation) === integer(current.generation) && saved.lease_id === current.lease_id, 'idle_ack_assignment_changed');
      }
      await acks.write(`${id}.json`, encode({ job_id: id, generation: current.generation, lease_id: current.lease_id, state: current.held === true ? 'queued' : 'confirmed', ...correlation(current) }));
    });
    await this.publish(current, current.held === true ? 'ack_queued' : 'ack_confirmed', 'explicitly_reported_finished_or_stopped');
    await this.logger.log('INFO', 'worker.idle_ack_queued', { ...correlation(current), confirmed: current.held !== true });
    return { job_id: id, acknowledgement: current.held === true ? 'queued' : 'confirmed' };
  }
}
