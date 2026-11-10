import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { State, system } from '../dist/state.js';
import { Logger, Capture } from '../dist/diagnostics.js';
import { Worker } from '../dist/worker.js';
import { encode, parse, object } from '../dist/json.js';

export const KEY = 'muse_worker_' + Buffer.alloc(32, 17).toString('base64url');
export const CODE = 'muse_enroll_' + Buffer.alloc(32, 29).toString('base64url');
export const ID = 'a'.repeat(32), JOB = 'b'.repeat(32), EXP = 'd'.repeat(32), CONV = 'e'.repeat(32), CONN = 'c'.repeat(32);
export function delivery(id = JOB, changes = {}) {
  return { protocol_version: 1, id, worker_id: ID, experiment_id: EXP, conversation_id: CONV, state: 'queued', created_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 300_000).toISOString(), claimed_at: null, lease_expires_at: null, generation: 0, lease_id: '', held: false, connection_id: '', connection_generation: 0, context: { receipt_id: id, kind: 'full', base_prefix: 0, history_count: 1, canonical_sha256: '1'.repeat(64), messages: [{ type: 'message', role: 'user', text: 'client-only request' }], tools: [{ name: 'read_file', parameters: { type: 'object' } }] }, ...changes };
}
export function claimed(changes = {}) { return delivery(JOB, { state: 'claimed', held: true, generation: 1, lease_id: 'f'.repeat(32), connection_id: CONN, connection_generation: 1, claimed_at: new Date().toISOString(), ...changes }); }
export class Broker {
  calls = [];
  jobs = new Map([[JOB, delivery()]]);
  replies = new Map();
  lost = 0;
  denied = false;
  decisionError = undefined;
  override;
  async fetch(url, options = {}) {
    const path = new URL(url).pathname;
    const input = options.body ? object(parse(options.body)) : undefined;
    const call = { path, options, input };
    this.calls.push(call);
    if (this.override) { const value = await this.override(call); if (value) return value; }
    const response = (value, status = 200) => new Response(encode(value), { status, headers: { 'content-type': 'application/json', 'x-request-id': 'unit-request-' + this.calls.length } });
    if (this.denied) return response({ error: 'unauthorized' }, 401);
    if (path.endsWith('/enroll')) return response({ worker: { id: ID }, credential: KEY }, 201);
    if (path.endsWith('/status')) {
      const held = [...this.jobs.values()].find(j => j.held);
      return response({ id: ID, name: 'Test', inference_readiness: 'unverified', connection_status: 'online', work_status: held ? 'busy' : 'idle', current_job: held ? { job_id: held.id, generation: held.generation, lease_id: held.lease_id } : null });
    }
    if (path.endsWith('/heartbeat')) {
      if (input.idle_ack) this.jobs.get(input.idle_ack.job_id).held = false;
      return response({ connection_status: 'online', work_status: 'idle' });
    }
    const id = path.split('/')[5];
    const current = this.jobs.get(id);
    if (!current) return response({ error: 'inference_not_found' }, 404);
    if (path.endsWith('/claim')) {
      if (this.replies.has(input.submission_id)) return response(this.replies.get(input.submission_id));
      Object.assign(current, { state: 'claimed', held: true, generation: 1, lease_id: 'f'.repeat(32), connection_id: input.connection_id, connection_generation: input.connection_generation, claimed_at: new Date().toISOString() });
      this.replies.set(input.submission_id, structuredCloneJson(current));
      return response(current);
    }
    if (path.endsWith('/decisions')) {
      if (this.decisionError) return response({ error: this.decisionError }, 400);
      if (this.replies.has(input.submission_id)) return response(this.replies.get(input.submission_id));
      current.held = false; current.state = 'accepted';
      const result = { id: current.experiment_id, worker_id: ID, conversation_id: current.conversation_id, state: input.decision.type === 'final' ? 'completed' : 'waiting_for_tool', messages: [input.decision] };
      this.replies.set(input.submission_id, result);
      if (this.lost-- > 0) throw Object.assign(new Error('secret must not reach logs ' + KEY), { code: 'ECONNRESET' });
      return response(result);
    }
    return response(current);
  }
}
function structuredCloneJson(value) { return object(parse(encode(value))); }
export async function fixture(t, { broker = new Broker(), maxBytes, retentionMs } = {}) {
  const parent = resolve('../.artifacts/unit/worker-fixtures');
  await fs.mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await fs.mkdtemp(join(parent, 'unit-'));
  const output = [];
  let offset = 0;
  const waits = [];
  const sys = { ...system, now: () => Date.now() + offset, wait: async ms => { waits.push(ms); await new Promise(done => setTimeout(done, Math.min(ms, 5))); } };
  const state = new State(root, fs, sys);
  await state.ensure();
  const logger = new Logger(state, new Capture(await state.child('diagnostics'), maxBytes, retentionMs), line => output.push(line), { package_version: '0.1.0-dev.0', node_version: process.version });
  logger.redactor.add(KEY); logger.redactor.add(CODE);
  const net = { fetch: broker.fetch.bind(broker), setTimer: setTimeout, clearTimer: clearTimeout };
  const worker = new Worker(state, logger, net);
  t.after(async () => { await fs.rm(root, { recursive: true }); });
  return { state, logger, worker, broker, net, output, waits, advance: ms => { offset += ms; } };
}
export async function enrolled(f) {
  await f.worker.configure('https://broker.example.test');
  await f.worker.enroll(CODE);
  return await f.worker.load();
}
export async function until(action, message = 'condition not observed') {
  for (let i = 0; i < 400; i++) { if (await action()) return; await new Promise(done => setTimeout(done, 5)); }
  throw new Error(message);
}
