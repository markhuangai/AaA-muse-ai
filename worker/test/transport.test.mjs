import test from 'node:test';
import assert from 'node:assert/strict';
import { Transport, origin, network } from '../dist/transport.js';
import { encode } from '../dist/json.js';
import { fixture, KEY } from './helpers.mjs';

test('origin rejects credential-bearing and non-origin URLs', () => {
  assert.equal(origin('https://example.com:443/'), 'https://example.com');
  for (const input of ['bad', 'http://example.com', 'https://u:p@example.com', 'https://example.com/path', 'https://example.com?x=1', 'https://example.com/#x']) assert.throws(() => origin(input), /https_origin_required/);
  assert.equal(typeof network.fetch, 'function');
});

test('HTTP retries preserve exact bodies, classify causal errors, and keep credentials out of evidence', async t => {
  const f = await fixture(t);
  const calls = [];
  const transport = new Transport('https://example.test', KEY, f.logger, f.state.sys, { ...f.net, fetch: async (url, options) => {
    calls.push({ url, options });
    if (calls.length < 3) return new Response('{"error":"unavailable"}', { status: 503, headers: { 'x-request-id': 'failure-' + calls.length } });
    return new Response('{"n":9007199254740993}', { status: 200, headers: { 'x-request-id': 'success' } });
  } });
  const body = '{"n":9007199254740993}';
  const result = await transport.request('/api/v1/worker/heartbeat', 'POST', body);
  assert.match(encode(result.data), /9007199254740993/); assert.equal(result.requestId, 'success');
  assert.equal(new Set(calls.map(c => c.options.body)).size, 1); assert.deepEqual(f.waits, [1000, 2000]);
  assert(calls.every(c => c.options.redirect === 'manual' && c.options.headers.Authorization === 'Bearer ' + KEY));
  assert(!f.output.join('').includes(KEY));
  await assert.rejects(transport.request('/foreign'), /invalid_worker_route/);
  await assert.rejects(transport.request('/api/v1/worker/heartbeat', 'POST', 'x'.repeat(1024 * 1024 + 1)), /body_too_large/);
  for (const [response, expected] of [[new Response(null, { status: 302 }), 'redirect_forbidden'], [new Response('{"error":"unauthorized"}', { status: 401 }), 'worker_unauthorized'], [new Response('[]'), 'object_required'], [new Response('broken'), 'invalid_json']]) {
    const client = new Transport('https://example.test', KEY, f.logger, f.state.sys, { ...f.net, fetch: async () => response });
    await assert.rejects(client.request('/api/v1/worker/status'), new RegExp(expected));
  }
  const failed = new Transport('https://example.test', KEY, f.logger, f.state.sys, { ...f.net, fetch: async () => { throw Object.assign(new Error(KEY), { cause: { code: 'ECONNRESET' } }); } });
  await assert.rejects(failed.request('/api/v1/worker/status'), /broker_unreachable/);
  const tls = new Transport('https://example.test', KEY, f.logger, f.state.sys, { ...f.net, fetch: async () => { throw Object.assign(new Error(KEY), { cause: { code: 'CERT_HAS_EXPIRED' } }); } });
  await assert.rejects(tls.request('/api/v1/worker/status'), error => !error.retryable);
  assert.equal(await transport.body(new Response()), '');
  await assert.rejects(transport.body(new Response('x'.repeat(20)), 10), /response_too_large/);
});

function stream(chunks, contentType = 'text/event-stream') {
  return new Response(new ReadableStream({ start(controller) { for (const chunk of chunks) controller.enqueue(typeof chunk === 'string' ? Buffer.from(chunk) : chunk); controller.close(); } }), { headers: { 'content-type': contentType } });
}
test('SSE parses fragmented UTF-8, multiline data, CRLF, comments and coalesced frames', async t => {
  const f = await fixture(t);
  const frame = ': comment\r\nid: first\r\nevent: connection.opened\r\ndata: {"protocol_version":1,\r\ndata: "text":"λ"}\r\n\r\n';
  const bytes = Buffer.from(frame);
  const many = Array.from({ length: 50 }, (_, i) => 'id: event-' + i + '\nevent: job.available\ndata: ' + JSON.stringify({ text: 'x'.repeat(2000) }) + '\n\n').join('');
  const client = new Transport('https://example.test', KEY, f.logger, f.state.sys, { ...f.net, fetch: async () => stream([...bytes].map(b => Buffer.from([b])).concat(Buffer.from(many))) });
  const controller = new AbortController();
  const events = [];
  for await (const event of client.events(controller.signal)) { events.push(event); if (events.length === 51) controller.abort(); }
  assert.equal(events[0].data.text, 'λ'); assert.equal(events.length, 51);
});

test('SSE rejects bad protocol, bounded frames, TLS failures and incomplete streams', async t => {
  const f = await fixture(t);
  const cases = [
    [() => new Response(null, { status: 302 }), 'redirect_forbidden'],
    [() => new Response(null, { status: 401 }), 'worker_unauthorized'],
    [() => new Response(null, { status: 409 }), 'stream_rejected'],
    [() => stream([], 'text/plain'), 'invalid_stream_response'],
    [() => stream(['id: x\nevent: unknown\ndata: {}\n\n']), 'unsupported_stream_event'],
    [() => stream(['id: x\nevent: health.challenge\ndata: nope\n\n']), 'invalid_json'],
    [() => stream(['x'.repeat(65_537)]), 'sse_frame_too_large'],
    [() => stream(['id: x\nevent: health.challenge\ndata: {']), 'stream_interrupted'],
    [() => stream([Buffer.from([255])]), 'invalid_utf8'],
    [() => { throw Object.assign(new Error(), { code: 'CERT_HAS_EXPIRED' }); }, 'stream_interrupted'],
  ];
  for (const [response, expected] of cases) {
    const client = new Transport('https://example.test', KEY, f.logger, f.state.sys, { ...f.net, fetch: async () => response() });
    await assert.rejects(async () => { for await (const _ of client.events(new AbortController().signal)) {} }, new RegExp(expected));
  }
  const stopped = new AbortController(); stopped.abort();
  const client = new Transport('https://example.test', KEY, f.logger, f.state.sys, { ...f.net, fetch: async () => { throw new Error(); } });
  for await (const _ of client.events(stopped.signal)) assert.fail('aborted stream emitted an event');
});
