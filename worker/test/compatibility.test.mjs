import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../dist/transport.js';
import { Worker } from '../dist/worker.js';
import { State } from '../dist/state.js';
import { execute } from '../dist/cli.js';
import { encode, parse } from '../dist/json.js';
import { fixture, enrolled, CODE, KEY, ID, JOB, CONN } from './helpers.mjs';
import * as fs from 'node:fs/promises';

test('product majors accept both minor-version orders and reject incompatible HTTP and SSE without retries', async t => {
  for (const [service, worker] of [['1.2.0', '1.0.0'], ['1.0.0', '1.9.0'], ['2.0.0', '2.4.1'], [null, '0.1.0-dev.0']]) {
    const f = await fixture(t); const calls = [];
    const net = { ...f.net, fetch: async (url, options) => {
      calls.push(options);
      const headers = service === null ? {} : { 'x-muse-service-version': service };
      if (url.endsWith('/events')) return new Response(': ready\n\n', { headers: { ...headers, 'content-type': 'text/event-stream' } });
      return new Response(JSON.stringify({ id: ID }), { headers });
    } };
    const transport = new Transport('https://broker.example.test', KEY, f.logger, f.state.sys, net, worker);
    assert.equal((await transport.request('/api/v1/worker/status')).data.id, ID);
    await assert.rejects(async () => { for await (const _ of transport.events(new AbortController().signal)) assert.fail('empty stream emitted a job'); }, /stream_interrupted/);
    assert(calls.every(call => call.headers['X-Muse-Worker-Version'] === worker));
  }
  for (const [service, worker] of [['2.0.0', '1.5.0'], ['1.0.0', '2.0.0'], [null, '1.0.0']]) {
    const f = await fixture(t); let calls = 0;
    const net = { ...f.net, fetch: async () => { calls++; return new Response(JSON.stringify({ id: ID }), { headers: service === null ? {} : { 'x-muse-service-version': service } }); } };
    const transport = new Transport('https://broker.example.test', KEY, f.logger, f.state.sys, net, worker);
    assert.equal((await transport.request('/api/v1/worker/status')).data.id, ID);
    for (const route of ['/api/v1/worker/enroll', '/api/v1/worker/jobs/new/claim']) await assert.rejects(transport.request(route, 'POST', '{}'), error => error.code === 'update_required' && !error.retryable && error.fields.automatic_update === false);
    await assert.rejects(async () => { for await (const _ of transport.events(new AbortController().signal)) {} }, /update_required/);
    assert.equal(calls, 4); assert.deepEqual(f.waits, []);
    assert.equal((await transport.request('/api/v1/worker/jobs/old/decisions', 'POST', '{}')).data.id, ID);
  }
});

test('future-major enrollment preflights a legacy server without consuming its code or creating identity', async t => {
  const f = await fixture(t); let enrollments = 0;
  const net = { ...f.net, fetch: async url => {
    if (url.endsWith('/enroll')) enrollments++;
    return new Response('{"error":"unauthorized"}', { status: 401 });
  } };
  const worker = new Worker(f.state, f.logger, net, '1.0.0');
  await worker.configure('https://broker.example.test');
  await assert.rejects(worker.enroll(CODE), /update_required/);
  assert.equal(enrollments, 0); assert.equal(await f.state.read('credential.key'), undefined); assert.equal(await f.state.read('enrollment.json'), undefined);
  const compatible = new Transport('https://broker.example.test', '', f.logger, f.state.sys, { ...net, fetch: async () => new Response('{"error":"unauthorized"}', { status: 401, headers: { 'x-muse-service-version': '1.2.0' } }) }, '1.0.0');
  await compatible.enrollmentCompatibility();
  const mismatched = new Worker(f.state, f.logger, { ...net, fetch: async url => {
    if (url.endsWith('/enroll')) enrollments++;
    return new Response('{"error":"unauthorized"}', { status: 401, headers: { 'x-muse-service-version': '2.1.0' } });
  } }, '1.0.0');
  await assert.rejects(mismatched.enroll(CODE), error => error.code === 'update_required' && error.fields.recommended_worker.version === '2.1.0' && error.fields.recommended_worker.release_url.endsWith('/v2.1.0'));
  assert.equal(enrollments, 0); assert.equal(await f.state.read('credential.key'), undefined); assert.equal(await f.state.read('enrollment.json'), undefined);
  const down = new Transport('https://broker.example.test', '', f.logger, f.state.sys, { ...net, fetch: async () => { throw Object.assign(new Error(), { code: 'CERT_EXPIRED' }); } }, '1.0.0');
  await assert.rejects(down.enrollmentCompatibility(), /broker_unreachable/);
});

test('major-one workers retain HTTP retries and retryable streams through headerless proxy outages', async t => {
  for (const status of [429, 502, 503, 504]) {
    const f = await fixture(t); let calls = 0;
    const net = { ...f.net, fetch: async (_url, options) => {
      assert.equal(options.headers['X-Muse-Worker-Version'], '1.2.0');
      return ++calls < 3 ? new Response('<html>temporary proxy outage</html>', { status }) :
        new Response(JSON.stringify({ id: ID }), { headers: { 'x-muse-service-version': '1.5.0' } });
    } };
    const transport = new Transport('https://broker.example.test', KEY, f.logger, f.state.sys, net, '1.2.0');
    assert.equal((await transport.request('/api/v1/worker/status')).data.id, ID);
    assert.equal(calls, 3); assert.deepEqual(f.waits, [1000, 2000]);
  }
  for (const status of [409, 429, 502, 503, 504]) {
    const f = await fixture(t);
    const transport = new Transport('https://broker.example.test', KEY, f.logger, f.state.sys,
      { ...f.net, fetch: async () => new Response('<html>temporary proxy outage</html>', { status }) }, '1.2.0');
    await assert.rejects(async () => { for await (const _ of transport.events(new AbortController().signal)) {} },
      error => error.code === 'stream_rejected' && error.retryable && error.fields.http_status === status);
  }
});

test('transient status codes cannot hide declared version mismatches or explicit update requirements', async t => {
  for (const [headers, body, streamStatus, version, expected] of [
    [{ 'x-muse-service-version': '2.0.0' }, {}, 503, '1.2.0', 'update_required'],
    [{}, { error: 'update_required', worker_package: { version: '2.0.0' } }, 426, '0.1.0-dev.0', 'update_required'],
    [{ 'x-muse-service-version': 'invalid' }, {}, 503, '1.2.0', 'invalid_service_version'],
  ]) {
    const f = await fixture(t); let calls = 0;
    const transport = new Transport('https://broker.example.test', KEY, f.logger, f.state.sys, { ...f.net, fetch: async url => {
      calls++; return new Response(JSON.stringify(body), { status: url.endsWith('/events') ? streamStatus : 503, headers });
    } }, version);
    await assert.rejects(transport.request('/api/v1/worker/jobs/new/claim', 'POST', '{}'), error => error.code === expected && !error.retryable);
    await assert.rejects(async () => { for await (const _ of transport.events(new AbortController().signal)) {} }, error => error.code === expected && !error.retryable);
    assert.equal(calls, 2); assert.deepEqual(f.waits, []);
  }
});

test('update-required RPC and stream errors retain metadata and CLI logs without installing or changing identity', async t => {
  const f = await fixture(t); await f.worker.configure('https://broker.example.test'); await f.worker.enroll(CODE);
  const pending = encode({ protocol_version: 1, worker_id: ID, jobs: [] });
  await f.state.write('pending.json', pending);
  const key = await f.state.read('credential.key'); const config = await f.state.read('config.json');
  const body = { id: ID, worker_package: { version: '2.0.0', sha256: 'a'.repeat(64) } };
  const net = { ...f.net, fetch: async url => new Response(JSON.stringify(url.endsWith('/events') ? { ...body, error: 'update_required' } : body), { status: url.endsWith('/events') ? 426 : 200, headers: { 'x-muse-service-version': '2.0.0', 'x-request-id': 'update-check' } }) };
  const transport = new Transport('https://broker.example.test', KEY, f.logger, f.state.sys, net);
  await assert.rejects(transport.request('/api/v1/worker/jobs/new/claim', 'POST', '{}'), error => error.fields.recommended_worker.version === '2.0.0');
  await assert.rejects(async () => { for await (const _ of transport.events(new AbortController().signal)) {} }, /update_required/);
  const stdout = [];
  assert.equal(await execute(['run', '--state-dir', f.state.root], { files: fs, system: f.state.sys, network: net, env: {}, home: () => f.state.root, nodeVersion: process.version, input: async () => CODE, stdout: line => stdout.push(line), stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit', source_dirty: true }) }), 1);
  const event = f.output.map(JSON.parse).find(e => e.msg === 'worker.update_required');
  assert.equal(event.automatic_update, false); assert.equal(event.service_version, '2.0.0'); assert.equal(event.recommended_worker.version, '2.0.0');
  assert.equal(await f.state.read('credential.key'), key); assert.equal(await f.state.read('config.json'), config); assert.equal(await f.state.read('pending.json'), pending);
  assert(!stdout.join('').includes(KEY));
  const malformed = new Transport('https://broker.example.test', KEY, f.logger, f.state.sys, { ...net, fetch: async () => new Response('{}', { headers: { 'x-muse-service-version': 'invalid' } }) });
  await assert.rejects(malformed.request('/api/v1/worker/status'), /invalid_service_version/);
});

test('decision-submit reconciles accepted and uncertain receipts across service major changes through the CLI', async t => {
  for (const acknowledgement of ['accepted', 'uncertain']) {
    const f = await fixture(t), transport = await enrolled(f);
    await f.worker.claim(transport, JOB, { connection_id: CONN, connection_generation: 1 });
    const input = '{"type":"final","text":"accepted once"}';
    if (acknowledgement === 'accepted') await f.worker.submit(JOB, input);
    else {
      let fail = false;
      const state = new State(f.state.root, { ...fs, open: async (path, ...args) => {
        if (fail && path.includes('/journals/.operation-')) { fail = false; throw Object.assign(new Error('ack persistence fault'), { code: 'ENOSPC' }); }
        return fs.open(path, ...args);
      } }, f.state.sys);
      f.broker.override = call => { if (call.path.endsWith('/decisions')) fail = true; };
      await assert.rejects(new Worker(state, f.logger, f.net).submit(JOB, input));
      f.broker.override = undefined;
    }
    const journals = await f.state.child('journals'), pointer = parse(await journals.read('decision-' + JOB + '.json'));
    const name = 'operation-' + pointer.submission_id + '.json', saved = parse(await journals.read(name));
    assert.equal(saved.state, acknowledgement);
    const key = await f.state.read('credential.key'), config = await f.state.read('config.json'), names = (await journals.list()).sort();
    const fetch = f.net.fetch;
    f.net.fetch = async (...args) => { const response = await fetch(...args); response.headers.set('x-muse-service-version', '1.0.0'); return response; };
    const before = f.broker.calls.length, stdout = [];
    assert.equal(await execute(['decision-submit', '--job-id', JOB, '--input', '-', '--state-dir', f.state.root], { files: fs, system: f.state.sys, network: f.net, env: {}, home: () => f.state.root, nodeVersion: process.version, input: async () => input, stdout: line => stdout.push(line), stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit', source_dirty: true }) }), 0);
    const replay = f.broker.calls.slice(before).filter(call => call.path.endsWith('/decisions'));
    assert.equal(replay.length, 1); assert.equal(replay[0].options.body, saved.body); assert.equal(replay[0].input.submission_id, pointer.submission_id);
    assert.equal(parse(stdout.join('')).submission_id, pointer.submission_id);
    assert.equal(parse(await journals.read(name)).state, 'accepted'); assert.deepEqual((await journals.list()).sort(), names);
    assert.equal(await f.state.read('credential.key'), key); assert.equal(await f.state.read('config.json'), config);
    assert(!f.broker.calls.slice(before).some(call => call.path.endsWith('/enroll') || call.path.endsWith('/claim') || call.input?.idle_ack));
    assert.equal(await f.state.read('run-stop.json'), undefined);
  }
});
