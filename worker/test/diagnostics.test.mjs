import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { State } from '../dist/state.js';
import { Capture, Logger, Redactor } from '../dist/diagnostics.js';
import { parse, encode } from '../dist/json.js';
import { Subscriber } from '../dist/subscriber.js';
import { fixture, enrolled, until, ID, CONN, KEY, CODE } from './helpers.mjs';

function pausedExport(f) {
  let entered, unblock, paused = false;
  const started = new Promise(resolve => { entered = resolve; });
  const released = new Promise(resolve => { unblock = resolve; });
  const io = { ...fs, async open(path, ...args) {
    if (!paused && String(path).split('/').at(-1).startsWith('capture-')) {
      paused = true; entered(); await released;
    }
    return await fs.open(path, ...args);
  } };
  const state = new State(f.logger.capture.state.root, io, f.state.sys);
  return { capture: new Capture(state, f.logger.capture.maxBytes, f.logger.capture.retentionMs), started, unblock };
}

test('redaction merges overlapping original spans and protects object keys without losing number text', () => {
  const r = new Redactor(); r.add('abcdef'); r.add('defghi'); r.add(''); r.add('abcdef');
  assert.equal(r.text('before abcdefghi after'), 'before [REDACTED] after');
  const nested = 'muse_worker_' + 'x'.repeat(10) + 'muse_worker_' + 'y'.repeat(43);
  assert.equal(r.text('start ' + nested + ' end'), 'start [REDACTED] end');
  const value = parse('{"n":9007199254740993,"password":"hidden","list":["' + KEY + '",null],"' + KEY + '":"retained","[REDACTED]":"ordinary","api_key":"hide"}');
  const raw = encode(r.value(value));
  assert(raw.includes('9007199254740993')); assert(!raw.includes(KEY)); assert(!raw.includes('hidden')); assert(raw.includes('retained')); assert(raw.includes('[REDACTED]#2'));
  assert.equal(encode(r.value({ token: 'ordinary schema', n: 1 }, '', false)), '{"token":"ordinary schema","n":1}');
});

test('actual INFO logger retains complete protected DEBUG captures and reconstructs chunked payloads', async t => {
  const f = await fixture(t);
  const payload = 'complete-λ-'.repeat(9000);
  await f.logger.log('DEBUG', 'worker.context', { operation_id: 'experiment', request_id: 'request', payload, key: KEY, arguments: parse('{"n":9007199254740993}') });
  assert.equal(f.output.length, 0);
  await f.logger.log('INFO', 'worker.completed', { operation_id: 'experiment', status: 'ok', credential: CODE });
  assert.equal(f.output.length, 1); assert(!f.output.join('').includes(CODE));
  const raw = await f.logger.capture.export({ operation_id: 'experiment' }, false);
  for (const line of raw.trimEnd().split('\n').slice(1)) assert(Buffer.byteLength(line) + 1 <= 6144);
  const decoded = (await f.logger.capture.export({ operation_id: 'experiment' }, true)).trimEnd().split('\n').map(line => parse(line));
  assert.equal(decoded[0].complete, true); assert.equal(decoded[1].payload, payload); assert.match(encode(decoded[1].arguments), /9007199254740993/);
  assert.equal(decoded[1].key, '[REDACTED]');
  const filtered = (await f.logger.capture.export({ request_id: 'request' }, true)).trimEnd().split('\n'); assert.equal(filtered.length, 2);
  assert.equal(JSON.parse((await f.logger.capture.export({ request_id: 'missing' }, false)).split('\n')[0]).complete, false);
  await assert.rejects(f.logger.capture.export({ since: 'bad' }, false), /invalid_time_filter/);
  await assert.rejects(f.logger.capture.export({ since: '2030-01-01T00:00:00Z', until: '2020-01-01T00:00:00Z' }, false), /invalid_time_interval/);
  const past = JSON.parse((await f.logger.capture.export({ since: '2000-01-01T00:00:00Z', until: '2100-01-01T00:00:00Z' }, false)).split('\n')[0]);
  assert.equal(past.complete, false); assert.equal(past.omissions.length, 2);
  const file = (await f.logger.capture.state.list()).find(n => n.startsWith('capture-'));
  await f.logger.capture.state.write(file, '{"type":"broken"}\n');
  assert(JSON.parse((await f.logger.capture.export({}, false)).split('\n')[0]).omissions.some(s => s.startsWith('incomplete_capture:')));
});

test('retention and capture failures provide honest omissions and stop required work', async t => {
  const f = await fixture(t, { maxBytes: 6144, retentionMs: 100 });
  await f.logger.log('INFO', 'old', { operation_id: 'old' }); f.advance(200);
  await f.logger.log('INFO', 'new', { payload: 'x'.repeat(12_000) });
  const metadata = JSON.parse((await f.logger.capture.export({}, false)).split('\n')[0]);
  assert.equal(metadata.complete, false); assert(metadata.pruned_through);
  const broken = new State(f.logger.capture.state.root, { ...fs, open: async () => { throw Object.assign(new Error(KEY), { code: 'ENOSPC' }); } }, f.state.sys);
  const logger = new Logger(f.state, new Capture(broken), line => f.output.push(line));
  await assert.rejects(logger.log('INFO', 'required_operation'), /diagnostics_unavailable/);
  const error = JSON.parse(f.output.at(-1)); assert.equal(error.msg, 'worker.capture_failed'); assert.equal(error.stopped_operation, 'required_operation'); assert(!f.output.join('').includes(KEY));
});

test('large diagnostic captures hash the payload once and reconstruct every bounded chunk', async t => {
  const f = await fixture(t);
  const payload = 'large-λ-'.repeat(400_000);
  const createHash = crypto.createHash;
  let hashes = 0;
  try {
    crypto.createHash = (...args) => { hashes++; return createHash(...args); };
    syncBuiltinESMExports();
    await f.logger.log('DEBUG', 'worker.large_exchange', { operation_id: 'large', payload, credential: KEY });
  } finally { crypto.createHash = createHash; syncBuiltinESMExports(); }
  assert.equal(hashes, 1);
  assert.equal(f.output.length, 0);
  const raw = await f.logger.capture.export({ operation_id: 'large' }, false);
  assert(raw.trimEnd().split('\n').length > 1000);
  for (const line of raw.trimEnd().split('\n').slice(1)) assert(Buffer.byteLength(line) + 1 <= 6144);
  const events = (await f.logger.capture.export({ operation_id: 'large' }, true)).trimEnd().split('\n').map(JSON.parse);
  assert.equal(events[0].complete, true); assert.equal(events[1].payload, payload); assert.equal(events[1].credential, '[REDACTED]');
});

test('a paused export cannot stop a real background subscriber or include its later captures', async t => {
  const f = await fixture(t); await enrolled(f); f.broker.jobs.clear();
  const pause = pausedExport(f), exported = pause.capture.export({}, true);
  await pause.started;
  const stop = new AbortController(), connection = { protocol_version: 1, connection_id: CONN, connection_generation: 1 };
  f.broker.override = call => {
    if (call.path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(`id: opened\nevent: connection.opened\ndata: ${encode(connection)}\n\nid: health\nevent: health.challenge\ndata: ${encode({ ...connection, challenge_id: 'export-health' })}\n\n`));
    } }), { headers: { 'content-type': 'text/event-stream' } });
    if (call.path.endsWith('/heartbeat')) stop.abort();
  };
  const initialWaits = f.waits.length;
  let settled = false, failure;
  const running = new Subscriber(f.worker).run(stop.signal, true).catch(error => { failure = error; }).finally(() => { settled = true; });
  try {
    await until(() => settled || f.waits.length > initialWaits);
    if (!settled) f.advance(11_000);
    await running;
    assert.equal(failure, undefined, 'export lock contention made required logging terminal');
    assert.equal(await f.state.read('run-stop.json'), undefined);
    assert.equal((await f.state.read('credential.key')).trim(), KEY);
    assert.equal(parse(await f.state.read('connection.json')).status, 'online');
    assert(f.broker.calls.some(call => call.path.endsWith('/heartbeat')));
    assert(!f.output.some(line => JSON.parse(line).msg === 'worker.capture_failed'));
  } finally { pause.unblock(); stop.abort(); await running; }
  const snapshot = (await exported).trimEnd().split('\n').map(JSON.parse);
  assert.equal(snapshot[0].complete, true);
  assert(!snapshot.slice(1).some(event => event.msg === 'worker.supervision_started' || event.msg === 'worker.connected'));
  assert.equal(ID, f.worker.config.worker_id);
});

test('an export reports a frozen capture removed by concurrent retention', async t => {
  const f = await fixture(t, { maxBytes: 6144 });
  await f.logger.log('INFO', 'existing');
  const name = (await f.logger.capture.state.list()).find(name => name.startsWith('capture-'));
  const pause = pausedExport(f), exported = pause.capture.export({}, false);
  await pause.started;
  const writing = f.logger.log('DEBUG', 'larger', { payload: 'x'.repeat(12_000) });
  let timer;
  try {
    const completed = await Promise.race([writing.then(() => true), new Promise(resolve => { timer = setTimeout(() => resolve(false), 2000); })]);
    assert.equal(completed, true, 'retention waited for an export read');
  } finally { clearTimeout(timer); pause.unblock(); await writing; }
  const snapshot = (await exported).trimEnd().split('\n').map(JSON.parse);
  assert.equal(snapshot[0].complete, false);
  assert.equal(snapshot[0].captures, 0);
  assert.deepEqual(snapshot[0].omissions, ['capture_removed_during_export:' + name]);
});

test('capacity pruning cannot exhaust a concurrent subscriber logging deadline through repeated watermark syncs', async t => {
  const f = await fixture(t); await enrolled(f); f.broker.jobs.clear();
  for (let i = 0; i < 24; i++) {
    await f.logger.log('DEBUG', 'retained', { payload: 'old-'.repeat(100) }); f.advance(1);
  }
  let entered, release;
  const started = new Promise(resolve => { entered = resolve; }), gate = new Promise(resolve => { release = resolve; });
  let first = true;
  const io = { ...fs, async open(path, ...args) {
    const handle = await fs.open(path, ...args);
    if (!String(path).split('/').at(-1).startsWith('.retention.json.')) return handle;
    const sync = handle.sync.bind(handle);
    handle.sync = async () => {
      if (first) { first = false; entered(); await gate; }
      f.advance(2000); await new Promise(resolve => setTimeout(resolve, 5)); await sync();
    };
    return handle;
  } };
  f.logger.capture = new Capture(new State(f.logger.capture.state.root, io, f.state.sys), 16 * 1024);
  const writing = f.logger.log('DEBUG', 'capacity-burst', { payload: 'x'.repeat(6000) });
  await started;
  const stop = new AbortController(), connection = { protocol_version: 1, connection_id: CONN, connection_generation: 1 };
  f.broker.override = call => {
    if (call.path.endsWith('/events')) return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(Buffer.from(`id: opened\nevent: connection.opened\ndata: ${encode(connection)}\n\nid: health\nevent: health.challenge\ndata: ${encode({ ...connection, challenge_id: 'prune-health' })}\n\n`));
    } }), { headers: { 'content-type': 'text/event-stream' } });
    if (call.path.endsWith('/heartbeat')) stop.abort();
  };
  const waits = f.waits.length; let settled = false, failure;
  const running = new Subscriber(f.worker).run(stop.signal, true).catch(error => { failure = error; }).finally(() => { settled = true; });
  try {
    await until(() => settled || f.waits.length > waits); release();
    await writing; await running;
    assert.equal(failure, undefined, 'capacity pruning made required subscriber logging terminal');
    assert.equal(await f.state.read('run-stop.json'), undefined);
    assert.equal((await f.state.read('credential.key')).trim(), KEY);
    assert(f.broker.calls.some(call => call.path.endsWith('/heartbeat')));
    assert(!f.output.some(line => JSON.parse(line).msg === 'worker.capture_failed'));
    const metadata = JSON.parse((await f.logger.capture.export({}, false)).split('\n')[0]);
    assert.equal(metadata.complete, false); assert(metadata.pruned_through);
  } finally { release(); stop.abort(); await writing; await running; }
});

test('pruning failures preserve captures before watermark persistence and report conservative omissions after it', async t => {
  for (const stage of ['persist', 'remove']) {
    const f = await fixture(t);
    await f.logger.log('INFO', 'first'); f.advance(1); await f.logger.log('INFO', 'second'); f.advance(300);
    const state = f.logger.capture.state, before = await state.read('retention.json');
    const names = (await state.list()).filter(name => name.startsWith('capture-')).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
    const failure = () => Object.assign(new Error('injected filesystem failure'), { code: 'EIO' });
    const io = { ...fs,
      async rename(from, to) { if (stage === 'persist' && to === state.path('retention.json')) throw failure(); return fs.rename(from, to); },
      async unlink(path) { if (stage === 'remove' && path === state.path(names[1])) throw failure(); return fs.unlink(path); },
    };
    const capture = new Capture(new State(state.root, io, f.state.sys), undefined, 100);
    await assert.rejects(capture.prune(), { code: 'EIO' });
    if (stage === 'persist') {
      assert.equal(await state.read('retention.json'), before);
      for (const name of names) assert.notEqual(await state.read(name), undefined);
    } else {
      assert.equal(await state.read(names[0]), undefined); assert.notEqual(await state.read(names[1]), undefined);
      const retained = JSON.parse(await state.read('retention.json'));
      assert.equal(Date.parse(retained.pruned_through), Number(names[1].split('-')[1]));
      const metadata = JSON.parse((await new Capture(state, undefined, 100).export({}, false)).split('\n')[0]);
      assert.equal(metadata.complete, false); assert.equal(metadata.captures, 0);
      assert.deepEqual(metadata.omissions, ['expired_or_capacity_pruned_evidence']);
    }
  }
});

test('bounded export verifies chunks, redacts values and resumes a stable snapshot', async t => {
  const f = await fixture(t);
  const token = 'aaa_muse_ai_' + 'd'.repeat(64);
  const bearer = 'Bearer controlled-token-0123456789';
  const filter = { operation_id: 'controlled-bounded-export' };
  const dense = ('"\\').repeat(3500);
  for (const index of [1, 2, 3]) {
    await f.logger.capture.write({ time: new Date(f.state.sys.now()).toISOString(), level: 'DEBUG',
      msg: 'worker.fixture', operation_id: filter.operation_id, result: `${dense} ${token} ${bearer}`, index });
    f.advance(10);
  }
  const limit = 31_000;
  const first = await f.logger.capture.exportBounded(filter, true, limit, '', f.logger.redactor);
  assert(first.truncated && !first.complete && first.next_cursor && first.output.length > 0);
  assert(Buffer.byteLength(encode(first)) <= limit);
  assert(!encode(first).includes(token) && !encode(first).includes(bearer));
  const after = await f.logger.capture.exportBounded(filter, true, limit, first.next_cursor, f.logger.redactor);
  assert(after.captures > 0 && after.output[0] !== first.output[0]);
  await assert.rejects(f.logger.capture.exportBounded({ operation_id: 'other' }, true, limit, first.next_cursor, f.logger.redactor), /invalid_diagnostics_cursor/);
  await assert.rejects(f.logger.capture.exportBounded(filter, true, 1, '', f.logger.redactor), /diagnostics_limit_too_small/);

  const raw = await f.logger.capture.exportBounded(filter, false, 512 * 1024, '', f.logger.redactor);
  assert(raw.complete && !raw.truncated && raw.captures === 3);
  for (const entry of raw.output) {
    const chunks = entry.trimEnd().split('\n').map(JSON.parse);
    const payload = Buffer.concat(chunks.map(chunk => Buffer.from(chunk.data_base64, 'base64'))).toString();
    assert(!payload.includes(token) && !payload.includes(bearer) && payload.includes('[REDACTED]'));
    assert(entry.trimEnd().split('\n').every(line => Buffer.byteLength(line) + 1 <= 6144));
  }
});
