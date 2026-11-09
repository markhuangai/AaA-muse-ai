import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { State } from '../dist/state.js';
import { Capture, Logger, Redactor } from '../dist/diagnostics.js';
import { parse, encode } from '../dist/json.js';
import { fixture, KEY, CODE } from './helpers.mjs';

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
