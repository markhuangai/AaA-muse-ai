import test from 'node:test';
import assert from 'node:assert/strict';
import { Subscriber } from '../dist/subscriber.js';
import { Worker } from '../dist/worker.js';
import { encode, parse, integer } from '../dist/json.js';
import { fixture, enrolled, until, ID, JOB, CONN, KEY, claimed } from './helpers.mjs';

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

test('an exhausted HTML heartbeat outage reconnects and restores authenticated health', async t => {
  const f = await fixture(t); await enrolled(f);
  const stop = new AbortController(); let streams = 0, heartbeats = 0;
  f.broker.override = async call => {
    if (call.path.endsWith('/events')) {
      streams++;
      const connection = { ...opened, connection_id: CONN.slice(0, -1) + streams, connection_generation: streams };
      const frames = [['connection.opened', connection], ['health.challenge', { ...connection, challenge_id: 'health-' + streams }]].map(([type, data], i) => `id: ${streams}-${i}\nevent: ${type}\ndata: ${encode(data)}\n\n`).join('');
      return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(frames)); } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (call.path.endsWith('/heartbeat')) {
      if (++heartbeats <= 3) return new Response('<html>Unavailable ' + KEY + '</html>', { status: 503 });
      stop.abort();
    }
  };
  await new Subscriber(f.worker).run(stop.signal);
  assert.equal(streams, 2); assert.equal(heartbeats, 4);
  const calls = f.broker.calls.filter(c => c.path.endsWith('/heartbeat'));
  assert.equal(new Set(calls.slice(0, 3).map(c => c.options.body)).size, 1);
  assert.equal(integer(calls[3].input.connection_generation), 2);
  const saved = parse(await f.state.read('connection.json'));
  assert.equal(saved.status, 'online'); assert.equal(integer(saved.connection_generation), 2);
  const warnings = f.output.map(JSON.parse).filter(e => e.msg === 'worker.stream_retrying');
  assert.equal(warnings.length, 1); assert.equal(warnings[0].http_status, 503);
  assert.equal(warnings[0].response_validation_cause, 'invalid_json');
  const exported = await f.logger.capture.export({}, true);
  assert.equal(JSON.parse(exported.split('\n')[0]).complete, true);
  assert(!exported.includes(KEY)); assert(!f.output.join('').includes(KEY));
  assert(!f.broker.calls.some(c => c.path.endsWith('/decisions')));
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

test('expired heartbeat connections reopen SSE and confirm queued idle only on a fresh accepted challenge', async t => {
  for (const reason of ['stale_connection', 'unknown_or_expired_challenge']) {
    const f = await fixture(t); await enrolled(f);
    f.broker.jobs.set(JOB, claimed({ state: 'interrupted' }));
    await f.worker.ack(JOB);
    const acks = await f.state.child('acks');
    const queued = await acks.read(JOB + '.json');
    const stop = new AbortController(); let streams = 0, heartbeats = 0;
    f.broker.override = async call => {
      if (call.path.endsWith('/events')) {
        if (++streams === 2) {
          assert.equal(await acks.read(JOB + '.json'), queued);
          assert.equal(f.broker.jobs.get(JOB).held, true);
        }
        const c = { ...opened, connection_id: CONN.slice(0, -1) + streams, connection_generation: streams };
        const frames = [['connection.opened', c], ['health.challenge', { ...c, challenge_id: 'fresh-' + streams }]].map(([type, data], i) => `id: ${streams}-${i}\nevent: ${type}\ndata: ${encode(data)}\n\n`).join('');
        return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(frames)); } }), { headers: { 'content-type': 'text/event-stream' } });
      }
      if (call.path.endsWith('/heartbeat')) {
        assert.equal(call.input.idle_ack.job_id, JOB);
        assert.equal(integer(call.input.idle_ack.generation), 1);
        assert.equal(call.input.idle_ack.lease_id, 'f'.repeat(32));
        if (++heartbeats === 1) return new Response(encode({ error: reason }), { status: 409, headers: { 'x-request-id': 'expired-heartbeat' } });
        stop.abort();
      }
    };
    await new Subscriber(f.worker).run(stop.signal);
    assert.equal(streams, 2); assert.equal(heartbeats, 2);
    const calls = f.broker.calls.filter(c => c.path.endsWith('/heartbeat'));
    assert.equal(integer(calls[0].input.connection_generation), 1);
    assert.equal(integer(calls[1].input.connection_generation), 2);
    assert.notEqual(calls[0].input.challenge_id, calls[1].input.challenge_id);
    assert.equal(parse(await acks.read(JOB + '.json')).state, 'confirmed');
    assert.equal(f.broker.jobs.get(JOB).held, false);
    assert.equal(parse(await f.state.read('pending.json')).jobs.length, 0);
    const warnings = f.output.map(JSON.parse).filter(e => e.msg === 'worker.stream_retrying');
    assert.equal(warnings.length, 1); assert.equal(warnings[0].reason, reason);
    assert.equal(warnings[0].request_id, 'expired-heartbeat'); assert.equal(warnings[0].delay_ms, 1000);
    const exported = await f.logger.capture.export({}, true);
    assert.equal(JSON.parse(exported.split('\n')[0]).complete, true);
    assert(!exported.includes(KEY)); assert(!f.output.join('').includes(KEY));
    assert(!f.broker.calls.some(c => c.path.endsWith('/decisions')));
  }
});

test('heartbeat authorization, protocol and idle-acknowledgement failures remain terminal', async t => {
  for (const [status, body, expected] of [
    [401, '{"error":"unauthorized"}', 'worker_unauthorized'],
    [200, 'not-json', 'invalid_json'],
    [409, '{"error":"idle_ack_mismatch"}', 'broker_rejected'],
    [409, '{"error":"challenge_reply_conflict"}', 'broker_rejected'],
    [400, '{"error":"unsupported_protocol_version"}', 'broker_rejected'],
  ]) {
    const f = await fixture(t); await enrolled(f);
    const frames = [['connection.opened', opened], ['health.challenge', health('terminal')]].map(([type, data], i) => `id: ${i}\nevent: ${type}\ndata: ${encode(data)}\n\n`).join('');
    f.broker.override = async call => {
      if (call.path.endsWith('/events')) return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(frames)); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (call.path.endsWith('/heartbeat')) return new Response(body, { status });
    };
    await assert.rejects(new Subscriber(f.worker).run(new AbortController().signal), e => e.code === expected && !e.retryable);
    assert.equal(f.broker.calls.filter(c => c.path.endsWith('/events')).length, 1);
    assert.equal(f.broker.calls.filter(c => c.path.endsWith('/heartbeat')).length, 1);
    assert(!f.output.map(JSON.parse).some(e => e.msg === 'worker.stream_retrying'));
  }
});

test('startup reconciliation preserves a held claimed cue through shutdown before subscription', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  await f.worker.claim(transport, JOB, opened);
  const before = parse(await f.state.read('pending.json')).jobs[0];
  const stop = new AbortController();
  f.broker.override = async call => { if (call.path.endsWith('/status')) stop.abort(); };
  await new Subscriber(new Worker(f.state, f.logger, f.net)).run(stop.signal);
  const after = parse(await f.state.read('pending.json')).jobs;
  assert.equal(after.length, 1); assert.equal(after[0].state, 'pending'); assert.equal(after[0].needs_attention, true);
  for (const key of ['job_id', 'worker_id', 'conversation_id', 'context_receipt_id', 'deadline_at']) assert.equal(after[0][key], before[key]);
  assert.equal(integer(after[0].generation), 1); assert.equal(after[0].progress, 'reconciled_existing_assignment');
  assert.equal(f.broker.jobs.get(JOB).state, 'claimed'); assert.equal(f.broker.jobs.get(JOB).held, true);
  assert.equal(f.broker.calls.filter(c => c.path.endsWith('/claim')).length, 1);
  assert(!f.broker.calls.some(c => c.path.endsWith('/events') || c.path.endsWith('/decisions')));
  assert.equal((await f.state.read('credential.key')).trim(), KEY);
  assert(!encode(after).includes('lease_id')); assert(!encode(after).includes('client-only request'));
  const events = (await f.logger.capture.export({}, true)).trimEnd().split('\n').map(JSON.parse);
  assert.equal(events[0].complete, true);
  assert(events.some(e => e.msg === 'worker.job_progress' && e.progress === 'reconciled_existing_assignment' && e.state === 'pending'));
});

test('a buffered cancellation and later context read preserve confirmed idle after reconnect', async t => {
  for (const state of ['cancelled', 'interrupted']) {
    const f = await fixture(t); await enrolled(f);
    f.broker.jobs.set(JOB, claimed({ state }));
    await f.worker.ack(JOB);
    const acks = await f.state.child('acks');
    const c = { ...opened, connection_generation: 2 };
    const frames = [['connection.opened', c], ['health.challenge', { ...c, challenge_id: 'ack-first' }], ['job.cancelled', { job_id: JOB, generation: 1 }]].map(([type, data], i) => `id: buffered-${i}\nevent: ${type}\ndata: ${encode(data)}\n\n`).join('');
    const stop = new AbortController(); let confirmedReads = 0;
    f.broker.override = async call => {
      if (call.path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) { controller.enqueue(Buffer.from(frames)); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (call.path.endsWith('/' + JOB) && parse(await acks.read(JOB + '.json')).state === 'confirmed' && ++confirmedReads === 2) stop.abort();
    };
    await new Subscriber(f.worker).run(stop.signal);
    assert.equal(confirmedReads, 2); assert.equal(f.broker.jobs.get(JOB).held, false);
    assert.equal(parse(await acks.read(JOB + '.json')).state, 'confirmed');
    assert.equal(parse(await f.state.read('pending.json')).jobs.length, 0);
    await f.worker.show(JOB);
    assert.equal(parse(await f.state.read('pending.json')).jobs.length, 0);
    const cue = parse(await (await f.state.child('cues')).read(JOB + '.json'));
    assert.equal(cue.state, 'ack_confirmed'); assert.equal(cue.needs_attention, false);
    assert(!encode(cue).includes('lease_id')); assert(!encode(cue).includes(KEY));
    assert.equal(f.broker.calls.filter(call => call.input?.idle_ack).length, 1);
    assert(!f.broker.calls.some(call => call.path.endsWith('/decisions')));
  }
});

test('a context response captured before accepted idle cannot revive its confirmed assignment', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  f.broker.jobs.set(JOB, claimed({ state: 'interrupted' }));
  await f.worker.ack(JOB);
  let release, captured, blocked = false;
  const ready = new Promise(done => { captured = done; });
  const gate = new Promise(done => { release = done; });
  f.broker.override = async call => {
    if (!blocked && call.path.endsWith('/' + JOB)) {
      blocked = true;
      const raw = encode(f.broker.jobs.get(JOB));
      captured(); await gate;
      return new Response(raw);
    }
  };
  const showing = f.worker.show(JOB);
  t.after(() => release());
  await ready;
  const subscriber = new Subscriber(f.worker); subscriber.active = opened;
  await subscriber.heartbeat(transport, health('accepted-before-old-read'));
  assert.equal(parse(await f.state.read('pending.json')).jobs.length, 0);
  release(); await showing;
  assert.equal(parse(await f.state.read('pending.json')).jobs.length, 0);
  assert.equal(parse(await (await f.state.child('acks')).read(JOB + '.json')).state, 'confirmed');
  const events = (await f.logger.capture.export({}, true)).trimEnd().split('\n').map(JSON.parse);
  assert.equal(events[0].complete, true);
  assert(events.some(e => e.msg === 'worker.job_progress' && e.state === 'ack_confirmed' && e.progress === 'broker_already_confirmed_idle' && e.observed_state === 'interrupted' && e.observed_held === true && e.acknowledgement_required === false));
  assert(!f.output.some(line => JSON.parse(line).level === 'DEBUG'));
});

test('a rejected obsolete claim is replaced once on the healthy subscription without another job event', async t => {
  const f = await fixture(t); await enrolled(f);
  const stop = new AbortController(); let streams = 0, current;
  f.broker.override = async call => {
    if (call.path.endsWith('/events')) {
      current = { ...opened, connection_id: CONN.slice(0, -1) + ++streams, connection_generation: streams };
      const frames = [['connection.opened', current], ['health.challenge', { ...current, challenge_id: 'health-' + streams }], ['job.available', { worker_id: ID, job_id: JOB }]];
      if (streams === 2) frames.push(['health.challenge', { ...current, challenge_id: 'after-recovery' }]);
      return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(frames.map(([type, data], i) => `id: ${streams}-${i}\nevent: ${type}\ndata: ${encode(data)}\n\n`).join(''))); } }), { headers: { 'content-type': 'text/event-stream' } });
    }
    if (call.path.endsWith('/claim')) {
      if (streams === 1) return new Response('{"error":"unavailable"}', { status: 503 });
      if (call.input.connection_id !== current.connection_id) return new Response('{"error":"stale_connection"}', { status: 409, headers: { 'x-request-id': 'obsolete-claim' } });
    }
    if (call.input?.challenge_id === 'after-recovery') stop.abort();
  };
  await new Subscriber(f.worker).run(stop.signal);
  const claims = f.broker.calls.filter(c => c.path.endsWith('/claim'));
  assert.equal(streams, 2); assert.equal(claims.length, 5);
  assert.equal(new Set(claims.slice(0, 4).map(c => c.options.body)).size, 1);
  assert.notEqual(claims[4].input.submission_id, claims[0].input.submission_id);
  assert.equal(integer(claims[4].input.connection_generation), 2);
  const journals = await f.state.child('journals');
  assert.equal(parse(await journals.read('operation-' + claims[0].input.submission_id + '.json')).state, 'rejected');
  assert.equal(parse(await journals.read('operation-' + claims[4].input.submission_id + '.json')).state, 'accepted');
  assert.equal(f.broker.jobs.get(JOB).state, 'claimed'); assert.equal(f.broker.jobs.get(JOB).held, true);
  assert.equal(parse(await f.state.read('pending.json')).jobs.length, 1);
  assert(!f.broker.calls.some(c => c.path.endsWith('/decisions')));
  assert(f.output.map(JSON.parse).some(e => e.msg === 'worker.claim_retrying' && e.request_id === 'obsolete-claim' && e.previous_submission_id === claims[0].input.submission_id && e.submission_id === claims[4].input.submission_id && e.operation_attempt === 2));
});
