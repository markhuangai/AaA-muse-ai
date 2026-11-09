import test from 'node:test';
import assert from 'node:assert/strict';
import { Subscriber } from '../dist/subscriber.js';
import { encode, parse } from '../dist/json.js';
import { fixture, enrolled, until, ID, JOB, CONN, claimed } from './helpers.mjs';

const opened = { protocol_version: 1, connection_id: CONN, connection_generation: 1 };
const health = id => ({ ...opened, challenge_id: id });
test('subscriber leaves model work pending, rejects duplicate consumers, and requires explicit stopped-work acknowledgement', async t => {
  const f = await fixture(t); await enrolled(f);
  let push, close;
  const stop = new AbortController();
  f.broker.override = async call => {
    if (!call.path.endsWith('/events')) return;
    const body = new ReadableStream({ start(controller) {
      push = (type, data, id) => controller.enqueue(Buffer.from(`id: ${id}\nevent: ${type}\ndata: ${encode(data)}\n\n`));
      close = () => controller.close();
    } });
    return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
  };
  const run = new Subscriber(f.worker).run(stop.signal);
  await until(() => push);
  push('connection.opened', opened, 'connection'); push('health.challenge', health('challenge-1'), 'challenge-1');
  await until(async () => (await f.state.read('connection.json'))?.includes('last_heartbeat_at'));
  await assert.rejects(new Subscriber(f.worker).run(stop.signal), /subscriber_already_running/);
  push('job.available', { worker_id: ID, job_id: JOB }, JOB);
  await until(async () => (await f.state.read('pending.json'))?.includes('awaiting_muse_decision'));
  assert.equal(f.broker.calls.filter(c => c.path.endsWith('/decisions')).length, 0);
  f.broker.jobs.get(JOB).state = 'cancelled';
  push('job.cancelled', { job_id: JOB, generation: 1 }, 'cancelled');
  await until(async () => (await f.state.read('pending.json'))?.includes('awaiting_explicit_idle_acknowledgement'));
  push('health.challenge', health('challenge-2'), 'challenge-2');
  await until(() => f.broker.calls.some(c => c.input?.challenge_id === 'challenge-2'));
  assert.equal(f.broker.jobs.get(JOB).held, true);
  await f.worker.ack(JOB);
  push('health.challenge', health('challenge-3'), 'challenge-3');
  await until(() => f.broker.jobs.get(JOB).held === false);
  await until(async () => (await f.state.read('pending.json'))?.includes('"jobs":[]'));
  stop.abort(); close(); await run;
  const events = await f.logger.capture.export({}, true);
  assert(events.includes('worker.idle_confirmed')); assert(events.includes('worker.stopped'));
  assert.equal(parse(await f.state.read('connection.json')).status, 'online');
});

test('transient stream reconnects have bounded delays and keep the original credential', async t => {
  const f = await fixture(t); await enrolled(f);
  const stop = new AbortController(); let attempts = 0;
  f.broker.override = async call => {
    if (!call.path.endsWith('/events')) return;
    if (++attempts > 7) { stop.abort(); return new Response(null, { status: 503 }); }
    return new Response(null, { status: 503 });
  };
  await new Subscriber(f.worker).run(stop.signal);
  const warnings = f.output.map(JSON.parse).filter(e => e.msg === 'worker.stream_retrying');
  assert.deepEqual(warnings.map(e => e.delay_ms), [1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  assert.equal(parse(await f.state.read('connection.json')).status, 'offline');
});

test('health and cancellation validate assignment identity before acting', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  const subscriber = new Subscriber(f.worker);
  await assert.rejects(subscriber.heartbeat(transport, health('a')), /health_connection_mismatch/);
  subscriber.active = opened;
  await assert.rejects(subscriber.heartbeat(transport, { ...health('a'), connection_generation: 2 }), /health_connection_mismatch/);
  f.broker.jobs.set(JOB, claimed({ state: 'interrupted', held: false }));
  const acks = await f.state.child('acks');
  await acks.write(JOB + '.json', encode({ job_id: JOB, generation: 1, lease_id: 'f'.repeat(32), state: 'queued' }));
  await subscriber.heartbeat(transport, health('fresh'));
  assert.equal(parse(await acks.read(JOB + '.json')).state, 'confirmed');
  await acks.write(JOB + '.json', encode({ job_id: JOB, generation: 2, lease_id: 'f'.repeat(32), state: 'queued' }));
  await assert.rejects(subscriber.heartbeat(transport, health('next')), /idle_ack_assignment_changed/);
});

test('invalid UTF-8 is a terminal protocol failure and never reconnects', async t => {
  const f = await fixture(t); await enrolled(f);
  f.broker.override = async call => call.path.endsWith('/events') ? new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from([255])); c.close(); } }), { headers: { 'content-type': 'text/event-stream' } }) : undefined;
  await assert.rejects(new Subscriber(f.worker).run(new AbortController().signal), error => error.code === 'invalid_utf8' && !error.retryable);
  assert.equal(f.broker.calls.filter(c => c.path.endsWith('/events')).length, 1);
  assert(!f.output.map(JSON.parse).some(e => e.msg === 'worker.stream_retrying'));
});
