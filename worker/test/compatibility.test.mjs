import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport } from '../dist/transport.js';
import { Worker } from '../dist/worker.js';
import { execute } from '../dist/cli.js';
import { fixture, CODE, KEY, ID } from './helpers.mjs';
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
    await assert.rejects(transport.request('/api/v1/worker/status'), error => error.code === 'update_required' && !error.retryable && error.fields.automatic_update === false);
    await assert.rejects(async () => { for await (const _ of transport.events(new AbortController().signal)) {} }, /update_required/);
    assert.equal(calls, 2); assert.deepEqual(f.waits, []);
    // Reconciliation remains governed by the original receipt and ownership validation.
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

test('update-required RPC and stream errors retain metadata and CLI logs without installing or changing identity', async t => {
  const f = await fixture(t); await f.worker.configure('https://broker.example.test'); await f.worker.enroll(CODE);
  await f.state.write('pending.json', '{"preserved":true}');
  const key = await f.state.read('credential.key'); const config = await f.state.read('config.json');
  const body = { id: ID, worker_package: { version: '2.0.0', sha256: 'a'.repeat(64) } };
  const net = { ...f.net, fetch: async url => new Response(JSON.stringify(url.endsWith('/events') ? { ...body, error: 'update_required' } : body), { status: url.endsWith('/events') ? 426 : 200, headers: { 'x-muse-service-version': '2.0.0', 'x-request-id': 'update-check' } }) };
  const transport = new Transport('https://broker.example.test', KEY, f.logger, f.state.sys, net);
  await assert.rejects(transport.request('/api/v1/worker/status'), error => error.fields.recommended_worker.version === '2.0.0');
  await assert.rejects(async () => { for await (const _ of transport.events(new AbortController().signal)) {} }, /update_required/);
  const stdout = [];
  assert.equal(await execute(['status', '--state-dir', f.state.root], { files: fs, system: f.state.sys, network: net, env: {}, home: () => f.state.root, nodeVersion: process.version, input: async () => CODE, stdout: line => stdout.push(line), stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit', source_dirty: true }) }), 1);
  const event = f.output.map(JSON.parse).find(e => e.msg === 'worker.update_required');
  assert.equal(event.automatic_update, false); assert.equal(event.service_version, '2.0.0'); assert.equal(event.recommended_worker.version, '2.0.0');
  assert.equal(await f.state.read('credential.key'), key); assert.equal(await f.state.read('config.json'), config); assert.equal(await f.state.read('pending.json'), '{"preserved":true}');
  assert(!stdout.join('').includes(KEY));
  const malformed = new Transport('https://broker.example.test', KEY, f.logger, f.state.sys, { ...net, fetch: async () => new Response('{}', { headers: { 'x-muse-service-version': 'invalid' } }) });
  await assert.rejects(malformed.request('/api/v1/worker/status'), /invalid_service_version/);
});
