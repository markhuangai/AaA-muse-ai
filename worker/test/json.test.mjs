import test from 'node:test';
import assert from 'node:assert/strict';
import { parse, encode, object, text, integer, exact, identifier, decision, JsonNumber } from '../dist/json.js';
import { Failure, cause, requireValue } from '../dist/errors.js';
import { job, connection, version, correlation } from '../dist/protocol.js';
import { delivery, claimed, ID, JOB } from './helpers.mjs';

test('strict JSON preserves admitted number lexemes and rejects duplicate or malformed input', () => {
  const raw = '{"n":9007199254740993,"e":1e400,"a":[-0,1.2300],"s":"{\\\"x\\\":1}","object":{"a":1}}';
  assert.equal(encode(parse(raw)), raw);
  assert(parse('1') instanceof JsonNumber);
  for (const value of ['{"a":1,"\\u0061":2}', '{"a":{"b":1,"b":2}}', '[] []', '{', '{"x":"bad\n"}', '{"x":"\\x"}', 'undefined']) assert.throws(() => parse(value), Failure);
  for (const value of [null, [], 'x', 7, new JsonNumber('1'), undefined]) assert.throws(() => object(value));
  assert.equal(text('x'), 'x'); assert.throws(() => text(1));
  assert.equal(integer(parse('42')), 42); assert.equal(integer(4), 4);
  for (const value of [parse('9007199254740993'), parse('-1'), parse('1.1'), '3']) assert.throws(() => integer(value));
  assert.equal(identifier('abc-123_'), 'abc-123_'); assert.throws(() => identifier('../x'));
  exact({ a: 1 }, ['a']); assert.throws(() => exact({ a: 1, b: 2 }, ['a']));
  assert.equal(cause(null), 'operation_failed'); assert.equal(cause({ cause: { code: 'ECONNRESET' } }), 'ECONNRESET');
  assert.equal(cause(new Failure('specific')), 'specific'); assert.throws(() => requireValue(false, 'failed'));
});

test('decision validation runs real shape, names and identifier logic', () => {
  const tools = [{ name: 'read_file' }];
  assert.equal(decision('{"type":"final","text":""}', tools).text, '');
  assert.match(encode(decision('{"type":"tool_call","call_id":"c-1","name":"read_file","arguments":{"n":9007199254740993}}', tools)), /9007199254740993/);
  for (const d of [null, { type: 'final', text: 1 }, { type: 'final', text: 'x', role: 'assistant' }, { type: 'tool_result', call_id: 'x', name: 'read_file', arguments: {} }, { type: 'tool_call', call_id: 'bad id', name: 'read_file', arguments: {} }, { type: 'tool_call', call_id: 'x', name: 'bad name', arguments: {} }, { type: 'tool_call', call_id: 'x', name: 'read_file', arguments: [] }, { type: 'tool_call', call_id: 'x', name: 'unknown', arguments: {} }]) assert.throws(() => decision(JSON.stringify(d), tools));
  assert.throws(() => decision(' '.repeat(1024 * 1024 + 1), tools), /body_too_large/);
});

test('protocol rejects wrong ownership, broken receipts and unsafe generations', () => {
  const valid = claimed();
  assert.equal(job(valid, ID, JOB), valid);
  assert.equal(correlation(valid).job_id, JOB);
  assert.equal(job(delivery(), ID, JOB).state, 'queued');
  const delta = delivery(JOB, { context: { ...valid.context, kind: 'delta', base_receipt_id: 'base', base_sha256: '2'.repeat(64) } });
  assert.equal(job(delta, ID, JOB).context.kind, 'delta');
  for (const changes of [{ protocol_version: 2 }, { worker_id: 'foreign' }, { conversation_id: '' }, { state: 'invented' }, { deadline_at: 'bad' }, { generation: -1 }, { held: false }, { connection_generation: 0 }, { lease_id: '' }, { context: {} }, { context: { ...valid.context, canonical_sha256: '' } }, { context: { ...delta.context, base_sha256: '' } }]) assert.throws(() => job({ ...valid, ...changes }, ID, JOB));
  connection({ protocol_version: 1, connection_id: 'conn', connection_generation: 1 });
  assert.throws(() => connection({ protocol_version: 1, connection_id: 'conn', connection_generation: 0 })); assert.throws(() => version(2));
});
