import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { Worker } from '../dist/worker.js';
import { State } from '../dist/state.js';
import { parse, encode, object } from '../dist/json.js';
import { fixture, enrolled, claimed, delivery, KEY, CODE, ID, JOB, CONN } from './helpers.mjs';

test('enrollment preserves identity, rejects origin changes, and never silently redeems uncertain authority', async t => {
  const f = await fixture(t);
  await assert.rejects(f.worker.load(), /worker_not_configured/);
  await f.worker.configure('https://broker.example.test');
  await assert.rejects(f.worker.load(), /worker_not_enrolled/);
  await assert.rejects(f.worker.enroll('invalid'), /invalid_enrollment_code/);
  await f.worker.enroll(CODE);
  assert.equal((await f.state.read('credential.key')).trim(), KEY);
  assert.equal((await f.worker.enroll(CODE)).identity_preserved, true);
  assert.equal(f.broker.calls.filter(c => c.path.endsWith('/enroll')).length, 1);
  await f.worker.configure('https://broker.example.test');
  await assert.rejects(f.worker.configure('https://different.example.test'), /enrolled_origin_immutable/);
  assert(!f.output.join('').includes(KEY)); assert(!f.output.join('').includes(CODE));
  f.broker.denied = true;
  await assert.rejects(f.worker.enroll(CODE), /worker_unauthorized/);
  assert.equal((await f.state.read('credential.key')).trim(), KEY);

  const lost = await fixture(t);
  await lost.worker.configure('https://broker.example.test');
  lost.broker.override = async call => { if (call.path.endsWith('/enroll')) throw Object.assign(new Error(KEY), { code: 'ECONNRESET' }); };
  await assert.rejects(lost.worker.enroll(CODE), /broker_unreachable/);
  await assert.rejects(lost.worker.enroll(CODE), /enrollment_uncertain/);
  assert.equal(lost.broker.calls.filter(c => c.path.endsWith('/enroll')).length, 1);
  const rejected = await fixture(t); await rejected.worker.configure('https://broker.example.test');
  rejected.broker.override = async call => call.path.endsWith('/enroll') ? new Response('{"error":"enrollment_expired"}', { status: 410 }) : undefined;
  await assert.rejects(rejected.worker.enroll(CODE), /broker_rejected/);
  assert.equal(object(parse(await rejected.state.read('enrollment.json'))).state, 'rejected');
  rejected.broker.override = undefined; await rejected.worker.enroll(CODE);
});

test('identity recovery and all-or-explicit-failure enrollment storage execute real persistence', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  await f.state.write('config.json', '{"protocol_version":1,"origin":"https://broker.example.test"}');
  await f.worker.load(); await f.worker.identity(transport);
  assert.equal(object(parse(await f.state.read('config.json'))).worker_id, ID);
  f.worker.config.worker_id = 'foreign'; await assert.rejects(f.worker.identity(transport), /worker_identity_mismatch/);
  const bad = await fixture(t); await bad.worker.configure('https://broker.example.test');
  const state = new State(bad.state.root, { ...fs, open: async (path, ...rest) => {
    if (path.includes('.credential.key.')) throw Object.assign(new Error(), { code: 'ENOSPC' });
    return await fs.open(path, ...rest);
  } }, bad.state.sys);
  const worker = new Worker(state, bad.logger, bad.net);
  await assert.rejects(worker.enroll(CODE)); assert.equal(await bad.state.read('credential.key'), undefined);
  await assert.rejects(bad.worker.enroll(CODE), /enrollment_uncertain/);
  assert.equal(bad.broker.calls.filter(c => c.path.endsWith('/enroll')).length, 1);
});

test('claims and decisions retain identity and exact large-number payloads across lost responses and restart', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  await f.worker.claim(transport, JOB, { connection_id: CONN, connection_generation: 1 });
  const cue = object(parse(await f.state.read('pending.json')));
  assert.equal(cue.jobs[0].conversation_id, f.broker.jobs.get(JOB).conversation_id);
  assert(!encode(cue).includes('lease_id')); assert(!encode(cue).includes('client-only request')); assert(!encode(cue).includes(KEY));
  const shown = await f.worker.show(JOB); assert.equal(shown.context.messages[0].text, 'client-only request');
  f.broker.lost = 1;
  const input = '{"type":"tool_call","call_id":"call-1","name":"read_file","arguments":{"n":9007199254740993}}';
  const first = await f.worker.submit(JOB, input);
  assert.equal(first.experiment.state, 'waiting_for_tool');
  const posts = f.broker.calls.filter(c => c.path.endsWith('/decisions'));
  assert.equal(posts.length, 2); assert.equal(posts[0].options.body, posts[1].options.body); assert(posts[0].options.body.includes('9007199254740993'));
  const restarted = new Worker(f.state, f.logger, f.net);
  const repeated = await restarted.submit(JOB, input);
  assert.equal(repeated.submission_id, first.submission_id);
  await assert.rejects(restarted.submit(JOB, '{"type":"final","text":"different"}'), /pending_submission_conflict/);
  const journals = await f.state.child('journals');
  const journal = object(parse(await journals.read('operation-' + first.submission_id + '.json')));
  assert.equal(journal.state, 'accepted'); assert(journal.body.includes('9007199254740993'));
  const after = object(parse(await f.state.read('pending.json'))); assert.equal(after.jobs.length, 0);
  const events = await f.logger.capture.export({ operation_id: f.broker.jobs.get(JOB).experiment_id }, true);
  assert(events.includes('worker.http_retrying')); assert(events.includes('worker.operation_accepted')); assert(!events.includes(KEY));
});

test('rejected decisions can be corrected; invalid, foreign and stale results cannot become fresh authority', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  await f.worker.claim(transport, JOB, { connection_id: CONN, connection_generation: 1 });
  await assert.rejects(f.worker.submit(JOB, '{"type":"final","text":"x","extra":true}'), /unsupported_or_missing_fields/);
  await assert.rejects(f.worker.submit(JOB, '{"type":"tool_call","call_id":"x","name":"unknown","arguments":{}}'), /unknown_tool/);
  await assert.rejects(f.worker.submit(JOB, '{"type":"final","text":'), /invalid_json/);
  await assert.rejects(f.worker.submit(JOB, '{"type":"final","text":"' + KEY + '","unexpected":true}'), /unsupported_or_missing_fields/);
  const rejectedEvents = (await f.logger.capture.export({ operation_id: f.broker.jobs.get(JOB).experiment_id }, true)).trimEnd().split('\n').map(JSON.parse);
  assert(rejectedEvents.some(e => e.msg === 'worker.decision_input' && e.input_complete && e.input.name === 'unknown'));
  assert(rejectedEvents.some(e => e.msg === 'worker.decision_input' && e.input_complete && e.input.text === '[REDACTED]' && e.input.unexpected));
  assert(rejectedEvents.some(e => e.msg === 'worker.decision_input' && e.input_complete === false && e.input_omitted && e.omitted_input_bytes > 0 && e.validation_cause === 'invalid_json'));
  f.broker.decisionError = 'invalid_tool_arguments';
  await assert.rejects(f.worker.submit(JOB, '{"type":"final","text":"first"}'), /broker_rejected/);
  const journals = await f.state.child('journals');
  const before = object(parse(await journals.read('decision-' + JOB + '.json'))).submission_id;
  f.broker.decisionError = undefined;
  const accepted = await f.worker.submit(JOB, '{"type":"final","text":"corrected"}');
  assert.notEqual(accepted.submission_id, before); assert(await journals.read('operation-' + before + '.json'));
  const saved = await f.worker.getJob(transport, JOB); saved.worker_id = 'foreign';
  f.broker.jobs.set(JOB, saved); await assert.rejects(f.worker.show(JOB), /job_owner_mismatch/);
  f.broker.jobs.set(JOB, delivery());
  const fresh = new Worker(f.state, f.logger, f.net); await fresh.load();
  await assert.rejects(fresh.claim(transport, JOB, { connection_id: CONN, connection_generation: 2 }), /recovered_claim_not_current/).catch(error => { throw error; });
});

test('oversized complete decisions leave no journal and allow a shorter correction', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  await f.worker.claim(transport, JOB, { connection_id: CONN, connection_generation: 1 });
  const journals = await f.state.child('journals');
  const before = await journals.list();
  const limit = 1024 * 1024;
  const overhead = Buffer.byteLength(encode({ type: 'final', text: '' }));
  const input = encode({ type: 'final', text: 'x'.repeat(limit - overhead - 4) });
  assert.equal(Buffer.byteLength(input), 1_048_572);
  await assert.rejects(f.worker.submit(JOB, input), error => {
    assert.equal(error.code, 'body_too_large');
    assert.equal(error.fields.max_bytes, limit);
    assert(error.fields.observed_bytes > limit);
    return true;
  });
  assert.deepEqual(await journals.list(), before);
  assert.equal(f.broker.calls.filter(c => c.path.endsWith('/decisions')).length, 0);
  assert.equal(f.broker.jobs.get(JOB).state, 'claimed');
  const result = await f.worker.submit(JOB, '{"type":"final","text":"corrected"}');
  assert.equal(result.experiment.state, 'completed');
  assert.equal(f.broker.calls.filter(c => c.path.endsWith('/decisions')).length, 1);
  const events = (await f.logger.capture.export({ operation_id: f.broker.jobs.get(JOB).experiment_id }, true)).trimEnd().split('\n').map(JSON.parse);
  assert.equal(events[0].complete, true);
  assert(events.some(e => e.msg === 'worker.decision_rejected' && e.cause === 'body_too_large' && e.observed_bytes > e.max_bytes));
  assert(events.some(e => e.msg === 'worker.operation_accepted' && e.submission_id === result.submission_id));
});

test('explicit idle acknowledgement is bound to stopped assignment and stays queued until broker confirmation', async t => {
  const f = await fixture(t); await enrolled(f);
  f.broker.jobs.set(JOB, claimed());
  await assert.rejects(f.worker.ack(JOB), /idle_ack_requires_stopped_assignment/);
  f.broker.jobs.get(JOB).state = 'cancelled';
  assert.equal((await f.worker.ack(JOB)).acknowledgement, 'queued');
  assert.equal((await f.worker.ack(JOB)).acknowledgement, 'queued');
  assert.equal(f.broker.jobs.get(JOB).held, true);
  f.broker.jobs.get(JOB).generation = 2; await assert.rejects(f.worker.ack(JOB), /idle_ack_assignment_changed/);
  f.broker.jobs.get(JOB).generation = 1; f.broker.jobs.get(JOB).held = false;
  assert.equal((await f.worker.ack(JOB)).acknowledgement, 'confirmed');
});

test('pending cues retain unconfirmed, differently fenced and active work', async t => {
  const f = await fixture(t); await enrolled(f);
  const acks = await f.state.child('acks');
  const exact = { job_id: JOB, generation: 1, lease_id: 'f'.repeat(32), state: 'confirmed' };
  for (const ack of [undefined, { ...exact, state: 'queued' }, { ...exact, job_id: ID }, { ...exact, generation: 2 }, { ...exact, lease_id: 'a'.repeat(32) }]) {
    if (ack) await acks.write(JOB + '.json', encode(ack));
    for (const state of ['cancelled', 'interrupted', 'claimed']) {
      await f.worker.publish(claimed({ state }), state, 'needs_explicit_ack');
      const cues = parse(await f.state.read('pending.json')).jobs;
      assert.equal(cues.length, 1); assert.equal(cues[0].state, state === 'claimed' ? 'pending' : state); assert.equal(cues[0].needs_attention, true);
    }
  }
  await acks.write(JOB + '.json', encode(exact));
  await f.worker.publish(claimed({ generation: 2, lease_id: 'a'.repeat(32) }), 'claimed', 'different_assignment');
  const active = parse(await f.state.read('pending.json')).jobs;
  assert.equal(active.length, 1); assert.equal(active[0].state, 'pending');
  assert.equal(parse(await acks.read(JOB + '.json')).state, 'confirmed');
  assert(!f.broker.calls.some(call => call.input?.idle_ack || call.path.endsWith('/decisions')));
});

test('stopped claim recovery fences every receipt assignment mismatch', async t => {
  for (const mismatch of [{ generation: 2 }, { lease_id: 'a'.repeat(32) }, { connection_id: 'a'.repeat(32) }, { connection_generation: 2 }]) {
    const f = await fixture(t); const transport = await enrolled(f);
    f.broker.override = async call => {
      if (call.path.endsWith('/' + JOB) && f.broker.jobs.get(JOB).state === 'claimed') Object.assign(f.broker.jobs.get(JOB), { state: 'interrupted', ...mismatch });
    };
    await assert.rejects(f.worker.claim(transport, JOB, { connection_id: CONN, connection_generation: 1 }), /recovered_claim_not_current/);
    assert.equal(await f.state.read('pending.json'), undefined);
  }
});

test('near-limit HTML-escaped final receipts remain accepted and replayable without reducing request admission', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  await f.worker.claim(transport, JOB, { connection_id: CONN, connection_generation: 1 });
  const current = f.broker.jobs.get(JOB);
  const htmlJSON = value => JSON.stringify(value).replaceAll('<', '\\u003c');
  const messages = [...current.context.messages, { type: 'message', role: 'assistant', text: '' }];
  const overhead = Buffer.byteLength(htmlJSON({ messages, tools: current.context.tools }));
  const answer = '<'.repeat(Math.floor((1024 * 1024 - overhead) / 6));
  messages.at(-1).text = answer;
  const canonicalBytes = Buffer.byteLength(htmlJSON({ messages, tools: current.context.tools }));
  assert(canonicalBytes <= 1024 * 1024 && canonicalBytes > 1024 * 1024 - 6);
  let responseBytes = 0;
  f.broker.override = async call => {
    if (!call.path.endsWith('/decisions')) return;
    assert.equal(call.input.decision.text, answer);
    current.state = 'accepted'; current.held = false;
    const result = { id: current.experiment_id, worker_id: ID, conversation_id: current.conversation_id, state: 'completed', current_job_id: JOB, created_at: current.created_at, deadline_at: current.deadline_at, tools: current.context.tools, messages, final_text: answer, remote_outcome: 'decision_observed' };
    const raw = htmlJSON(result); responseBytes = Buffer.byteLength(raw);
    return new Response(raw, { headers: { 'x-request-id': 'near-context-limit' } });
  };
  const input = encode({ type: 'final', text: answer });
  const accepted = await f.worker.submit(JOB, input);
  assert(responseBytes > 2 * 1024 * 1024);
  assert.equal(accepted.experiment.final_text, answer);
  assert.equal(accepted.experiment.messages.at(-1).text, answer);
  const repeated = await new Worker(f.state, f.logger, f.net).submit(JOB, input);
  assert.equal(repeated.submission_id, accepted.submission_id);
  const journal = parse(await (await f.state.child('journals')).read('operation-' + accepted.submission_id + '.json'));
  assert.equal(journal.state, 'accepted'); assert.equal(journal.result.final_text, answer);
  assert.equal(parse(await f.state.read('pending.json')).jobs.length, 0);
  const events = (await f.logger.capture.export({ operation_id: current.experiment_id }, true)).trimEnd().split('\n').map(JSON.parse);
  assert.equal(events[0].complete, true);
  assert(events.some(e => e.msg === 'worker.http_exchange' && e.request_id === 'near-context-limit' && e.output.final_text === answer && e.input.decision.text === answer));
});

test('obsolete claim replacement requires a definitive stale rejection and still-queued work, and is bounded', async t => {
  for (const [reason, state, generation, limit, status] of [
    ['stale_connection', 'queued', 1, 1, 409],
    ['worker_busy', 'queued', 2, 1, 409],
    ['context_base_connection_changed', 'queued', 2, 1, 409],
    ['stale_connection', 'claimed', 2, 1, 409],
    ['stale_connection', 'queued', 2, 2, 409],
    ['stale_connection', 'queued', 2, 1, 400],
  ]) {
    const f = await fixture(t); const transport = await enrolled(f);
    await f.worker.operation('claim', delivery(), submission => ({ protocol_version: 1, submission_id: submission, connection_id: CONN, connection_generation: 1 }));
    if (state === 'claimed') f.broker.jobs.set(JOB, claimed());
    f.broker.override = async c => c.path.endsWith('/claim') ? new Response(encode({ error: reason }), { status }) : undefined;
    await assert.rejects(f.worker.claim(transport, JOB, { connection_id: CONN, connection_generation: generation }), error => error.code === 'broker_rejected' && error.fields.reason === reason);
    assert.equal(f.broker.calls.filter(c => c.path.endsWith('/claim')).length, limit);
    assert.equal(f.broker.jobs.get(JOB).state, state);
    assert(!f.broker.calls.some(c => c.path.endsWith('/decisions')));
  }
});

test('accepted final and tool decisions cannot be revived by delayed claimed context', async t => {
  for (const input of ['{"type":"final","text":"done"}', '{"type":"tool_call","call_id":"call","name":"read_file","arguments":{"path":"client"}}']) {
    const f = await fixture(t); const transport = await enrolled(f);
    await f.worker.claim(transport, JOB, { connection_id: CONN, connection_generation: 1 });
    let release, captured, blocked = false;
    const ready = new Promise(done => { captured = done; }); const gate = new Promise(done => { release = done; });
    f.broker.override = async call => {
      if (!blocked && call.path.endsWith('/' + JOB)) {
        blocked = true; const raw = encode(f.broker.jobs.get(JOB)); captured(); await gate;
        return new Response(raw);
      }
    };
    const showing = f.worker.show(JOB); t.after(() => release()); await ready;
    const accepted = await f.worker.submit(JOB, input);
    assert.equal(parse(await f.state.read('pending.json')).jobs.length, 0);
    release(); await showing;
    assert.equal(parse(await f.state.read('pending.json')).jobs.length, 0);
    const cue = parse(await (await f.state.child('cues')).read(JOB + '.json'));
    assert.equal(cue.state, accepted.experiment.state); assert.equal(cue.needs_attention, false);
    const events = (await f.logger.capture.export({}, true)).trimEnd().split('\n').map(JSON.parse);
    assert.equal(events[0].complete, true);
    assert(events.some(e => e.msg === 'worker.job_progress' && e.progress === 'broker_already_accepted_decision' && e.state === accepted.experiment.state && e.observed_state === 'claimed' && e.observed_held && !e.acknowledgement_required));
    assert.equal(f.broker.calls.filter(c => c.path.endsWith('/decisions')).length, 1);
  }
});

test('cue suppression requires an accepted decision for the same owner and exact assignment', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  await f.worker.claim(transport, JOB, { connection_id: CONN, connection_generation: 1 });
  const old = await f.worker.getJob(transport, JOB);
  const accepted = await f.worker.submit(JOB, '{"type":"final","text":"done"}');
  const journals = await f.state.child('journals'); const name = 'operation-' + accepted.submission_id + '.json';
  const exact = parse(await journals.read(name));
  for (const mismatch of [{ state: 'pending' }, { state: 'uncertain' }, { state: 'rejected' }, { kind: 'claim' }, { origin: 'https://other.test' }, { worker_id: JOB }, { job_id: ID }, { generation: 2 }, { body: encode({ ...parse(exact.body), lease_id: 'a'.repeat(32) }) }]) {
    await journals.write(name, encode({ ...exact, ...mismatch }));
    await f.worker.publish(old, 'claimed', 'stale_snapshot');
    assert.equal(parse(await f.state.read('pending.json')).jobs.length, 1);
  }
  await journals.write(name, encode(exact));
  const other = '9'.repeat(32); f.broker.jobs.set(other, delivery(other));
  await f.worker.claim(transport, other, { connection_id: CONN, connection_generation: 1 });
  await f.worker.publish(old, 'claimed', 'stale_snapshot');
  const remaining = parse(await f.state.read('pending.json')).jobs;
  assert.equal(remaining.length, 1); assert.equal(remaining[0].job_id, other);
  await journals.write(name, encode({ ...exact, result: { state: 'claimed' } }));
  await assert.rejects(f.worker.publish(old, 'claimed', 'invalid_journal'), /invalid_decision_journal/);
});
