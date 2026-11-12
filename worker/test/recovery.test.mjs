import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { execute } from '../dist/cli.js';
import { Subscriber } from '../dist/subscriber.js';
import { Worker } from '../dist/worker.js';
import { State } from '../dist/state.js';
import { encode, parse } from '../dist/json.js';
import { fixture, enrolled, claimed, ID, JOB, CONN, KEY } from './helpers.mjs';

const opened = { protocol_version: 1, connection_id: CONN, connection_generation: 1 };
function stream() {
  const frames = [['connection.opened', opened], ['health.challenge', { ...opened, challenge_id: 'recovery-health' }]];
  return new Response(new ReadableStream({ start(c) { c.enqueue(Buffer.from(frames.map(([type, data], i) => `id: recovery-${i}\nevent: ${type}\ndata: ${encode(data)}\n\n`).join(''))); } }), { headers: { 'content-type': 'text/event-stream' } });
}
const unavailable = () => new Response('{"error":"controlled_outage"}', { status: 503, headers: { 'x-request-id': 'outage-request' } });
function adapters(f) {
  return { files: f.state.io, system: f.state.sys, network: f.net, env: {}, home: () => f.state.root, nodeVersion: process.version, input: async () => '', stdout() {}, stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit', source_dirty: true }) };
}
async function events(f) {
  const raw = await f.logger.capture.export({}, true);
  const values = raw.trimEnd().split('\n').map(JSON.parse);
  assert.equal(values.shift().complete, true);
  assert(!raw.includes(KEY));
  assert(!f.output.some(line => JSON.parse(line).level === 'DEBUG'));
  return values;
}

test('background startup retries exhausted authentication and reconciliation outages without a terminal marker', async t => {
  for (const phase of ['authentication', 'reconciliation']) {
    const f = await fixture(t); await enrolled(f);
    if (phase === 'reconciliation') f.broker.jobs.set(JOB, claimed());
    let failed = 0;
    const stop = new AbortController();
    f.broker.override = call => {
      if ((phase === 'authentication' ? call.path.endsWith('/status') : call.path.endsWith('/' + JOB)) && failed++ < 3) return unavailable();
      if (call.path.endsWith('/events')) return stream();
      if (call.path.endsWith('/heartbeat')) stop.abort();
    };
    await new Subscriber(f.worker).run(stop.signal, true);
    assert.equal(await f.state.read('run-stop.json'), undefined);
    await assert.rejects(fs.lstat(f.state.path('daemon.lock')), { code: 'ENOENT' });
    assert.equal((await f.state.read('credential.key')).trim(), KEY);
    assert.equal(parse(await f.state.read('connection.json')).status, 'online');
    const log = await events(f);
    assert(log.some(e => e.msg === 'worker.stream_retrying' && e.phase === phase && e.attempt === 1 && e.delay_ms === 1000 && e.request_id === 'outage-request' && e.duration_ms >= 0));
    assert(log.some(e => e.msg === 'worker.supervision_started' && e.outcome === 'exclusive_owner' && e.pid));
    assert(log.some(e => e.msg === 'worker.recovery_reconciled'));
    assert(!f.broker.calls.some(c => c.path.endsWith('/decisions') || c.input?.idle_ack));
  }
});

test('cancellation during startup backoff stops cleanly and leaves no terminal marker', async t => {
  const f = await fixture(t); await enrolled(f);
  const stop = new AbortController();
  f.broker.override = call => call.path.endsWith('/status') ? unavailable() : undefined;
  const wait = f.state.sys.wait;
  f.state.sys.wait = async ms => { if (ms === 100) stop.abort(); await wait(ms); };
  await new Subscriber(f.worker).run(stop.signal, true);
  assert.equal(await f.state.read('run-stop.json'), undefined);
  assert(!f.broker.calls.some(c => c.path.endsWith('/events')));
  assert((await events(f)).some(e => e.msg === 'worker.stopped'));
});

test('a rejected duplicate background command cannot create or overwrite the owner stop, launch, or lock', async t => {
  for (const prior of [undefined, encode({ cause: 'retained_terminal_failure', requires_operator_action: true })]) {
    const f = await fixture(t); await enrolled(f);
    const release = await f.state.lock('daemon', false);
    try {
      if (prior) await f.state.write('run-stop.json', prior);
      await f.state.write('launch.json', encode({ pid: f.state.sys.pid, worker_id: ID }));
      const launch = await f.state.read('launch.json');
      const owner = await (new State(f.state.path('daemon.lock'), fs, f.state.sys)).read('owner.json');
      assert.equal(await execute(['run', '--background', '--state-dir', f.state.root], adapters(f)), 1);
      assert.equal(await f.state.read('run-stop.json'), prior);
      assert.equal(await f.state.read('launch.json'), launch);
      assert.equal(await (new State(f.state.path('daemon.lock'), fs, f.state.sys)).read('owner.json'), owner);
      assert(!f.broker.calls.some(c => c.path.endsWith('/events')));
    } finally { await release(); }
  }
});

test('only an owning background process records terminal failures and existing stops remain unchanged', async t => {
  for (const failure of ['revocation', 'tls', 'local_json']) {
    const f = await fixture(t); await enrolled(f);
    if (failure === 'revocation') f.broker.denied = true;
    if (failure === 'tls') f.net.fetch = async () => { throw Object.assign(new Error('private error'), { code: 'CERT_HAS_EXPIRED' }); };
    if (failure === 'local_json') await f.state.write('config.json', '{"origin":');
    const io = adapters(f);
    assert.equal(await execute(['run', '--background', '--state-dir', f.state.root], io), 1);
    const marker = await f.state.read('run-stop.json');
    assert.equal(parse(marker).requires_operator_action, true);
    assert.equal(parse(marker).pid.raw, String(f.state.sys.pid));
    const calls = f.broker.calls.length;
    assert.equal(await execute(['run', '--background', '--state-dir', f.state.root], io), 1);
    assert.equal(await f.state.read('run-stop.json'), marker);
    assert.equal(f.broker.calls.length, calls);
    const log = await events(f);
    assert(!log.some(e => e.msg === 'worker.stream_retrying'));
    if (failure === 'local_json') assert(log.some(e => e.msg === 'worker.local_state_invalid' && e.entry === 'config.json' && e.input_omitted && e.omitted_input_bytes > 0));
  }
});

test('reconnect reconciles a broker-accepted decision whose local acknowledgement write failed without submitting again', async t => {
  const f = await fixture(t); const transport = await enrolled(f);
  await f.worker.claim(transport, JOB, opened);
  let fail = false;
  const state = new State(f.state.root, { ...fs, open: async (path, ...args) => {
    if (fail && path.includes('/journals/.operation-')) { fail = false; throw Object.assign(new Error('ack persistence fault'), { code: 'ENOSPC' }); }
    return fs.open(path, ...args);
  } }, f.state.sys);
  f.broker.override = call => { if (call.path.endsWith('/decisions')) fail = true; };
  await assert.rejects(new Worker(state, f.logger, f.net).submit(JOB, '{"type":"final","text":"accepted once"}'));
  const journals = await f.state.child('journals');
  const pointer = parse(await journals.read('decision-' + JOB + '.json'));
  const before = await journals.read('operation-' + pointer.submission_id + '.json');
  assert.equal(parse(before).state, 'uncertain');
  const stop = new AbortController(); let streams = 0;
  f.broker.override = call => {
    if (call.path.endsWith('/events')) return ++streams === 1 ? unavailable() : stream();
    if (call.path.endsWith('/heartbeat')) stop.abort();
  };
  await new Subscriber(f.worker).run(stop.signal);
  assert.equal(streams, 2);
  assert.equal(parse(await f.state.read('pending.json')).jobs.length, 0);
  assert.equal(await journals.read('operation-' + pointer.submission_id + '.json'), before);
  assert.equal(f.broker.calls.filter(c => c.path.endsWith('/decisions')).length, 1);
  const log = await events(f);
  assert(log.some(e => e.msg === 'worker.recovery_reconciled' && e.local_state === 'uncertain' && e.broker_state === 'accepted' && e.submission_id === pointer.submission_id && e.disposition === 'broker_accepted' && !e.automatic_submission));
  assert(log.filter(e => e.msg === 'worker.recovery_reconciled').length >= 2);
  assert(log.some(e => e.msg === 'worker.recovery_detail' && e.saved_operations.some(op => op.kind === 'decision' && op.body.decision.text === 'accepted once')));
});

test('invalid journal ownership and missing operations fail explicitly without changing local evidence', async t => {
  for (const defect of ['owner', 'missing']) {
    const f = await fixture(t); const transport = await enrolled(f);
    await f.worker.claim(transport, JOB, opened);
    const journals = await f.state.child('journals');
    const pointer = parse(await journals.read('claim-' + JOB + '.json'));
    const name = 'operation-' + pointer.submission_id + '.json';
    const op = parse(await journals.read(name));
    if (defect === 'missing') await journals.remove(name);
    else await journals.write(name, encode({ ...op, worker_id: 'foreign' }));
    const before = await journals.read(name);
    await assert.rejects(f.worker.reconcile(transport, await f.worker.identity(transport)), /invalid_local_state/);
    assert.equal(await journals.read(name), before);
    const log = await events(f);
    assert(log.some(e => e.msg === 'worker.local_state_invalid' && e.level === 'ERROR' && e.entry.endsWith(name)));
    assert.equal(f.broker.calls.filter(c => c.path.endsWith('/claim')).length, 1);
    assert(!f.broker.calls.some(c => c.path.endsWith('/decisions')));
  }
});

test('terminal-marker storage failure remains visible and releases daemon ownership', async t => {
  const f = await fixture(t); await enrolled(f); f.broker.denied = true;
  const io = adapters(f);
  io.files = { ...fs, open: async (path, ...args) => {
    if (path.includes('/.run-stop.json.')) throw Object.assign(new Error('marker full'), { code: 'ENOSPC' });
    return fs.open(path, ...args);
  } };
  assert.equal(await execute(['run', '--background', '--state-dir', f.state.root], io), 1);
  assert(f.output.map(JSON.parse).some(e => e.msg === 'setup.recovery_marker_failed' && e.cause === 'ENOSPC'));
  const release = await f.state.lock('daemon', false); await release();
});
