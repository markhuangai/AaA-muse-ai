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
    for (const state of ['cancelled', 'interrupted']) {
      await f.worker.publish(claimed({ state }), state, 'needs_explicit_ack');
      const cues = parse(await f.state.read('pending.json')).jobs;
      assert.equal(cues.length, 1); assert.equal(cues[0].state, state); assert.equal(cues[0].needs_attention, true);
    }
  }
  await acks.write(JOB + '.json', encode(exact));
  await f.worker.publish(claimed(), 'claimed', 'active_work');
  const active = parse(await f.state.read('pending.json')).jobs;
  assert.equal(active.length, 1); assert.equal(active[0].state, 'pending');
  assert.equal(parse(await acks.read(JOB + '.json')).state, 'confirmed');
  assert(!f.broker.calls.some(call => call.input?.idle_ack || call.path.endsWith('/decisions')));
});
