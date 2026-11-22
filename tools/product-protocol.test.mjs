import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { cycle, cycleIDs, finalText, retryOutput, ProductProtocol } from './product-protocol.mjs';
import { productServer } from './test/product-server.mjs';
import { exportFixture } from './qualification-fixtures.mjs';
import { decodeExport, openEvidence } from './qualification-evidence.mjs';
import { Capture } from '../worker/dist/diagnostics.js';

const make = (protocol = 'chat', stream = false) => cycle({ id: 'case-a', slot: 'a', protocol, stream, session: 'session-a', fixture: { owner: 'client_driver', path: 'client-only.txt', contents: 'private-random\r\n😀\n' } });
const keys = { a: 'Bearer client-a', b: 'Bearer client-b' };

test('shared product driver runs all eight actual HTTP/SSE tool cycles, exact retries and owned followups', async t => {
  const h = await productServer(t); let reads = 0, saves = 0;
  const driver = new ProductProtocol({ origin: h.origin, keys, readFixture: async () => { reads++; return 'private-random\r\n😀\n'; }, save: async () => { saves++; } });
  for (const id of cycleIDs) {
    const [slot, protocol, format] = id.split('.'), item = make(protocol, format === 'sse'); item.id = id; item.slot = slot; item.session_id = 'session-' + id.replaceAll('.', '-');
    await driver.start(item); await driver.finish(item); await driver.followup(item, 'after-final-' + id);
    const receipt = await driver.correlate(item, h.management);
    assert.equal(receipt.operation_ids.length, 3); assert.equal(receipt.worker_ids[0], 'worker-' + slot); assert.equal(receipt.client_tool_executions, 1);
    assert.equal(item.turns.length, 4); assert.equal(item.turns[1].value.id, item.turns[2].value.id);
    if (protocol === 'chat') {
      const raw = item.turns[item.stream ? 2 : 1].value, parsed = item.turns[item.stream ? 1 : 2].value;
      assert.equal(raw.choices[0].logprobs, null); assert.equal(parsed.choices[0].logprobs, undefined);
      assert.deepEqual(retryOutput(protocol, raw), retryOutput(protocol, parsed));
      const changed = structuredClone(raw); changed.choices[0].message.refusal = 'unsupported refusal';
      assert.notDeepEqual(retryOutput(protocol, changed), retryOutput(protocol, parsed));
    }
    assert.equal(finalText(protocol, item.turns.at(-1).value), 'after-final-' + id);
    if (protocol === 'responses') assert.equal((await driver.rejectOtherClient(item)).status, 404);
    await assert.rejects(driver.finish(item), /product_tool_already_executed_or_uncertain/);
    await assert.rejects(driver.start(item), /product_cycle_already_started/);
    await assert.rejects(driver.followup(item, 'duplicate'), /product_followup_conflict/);
  }
  assert.equal(reads, 8); assert.ok(saves > 40);
  assert.ok(h.requests.filter(value => value.body.previous_response_id).every(value => !value.headers['x-muse-session-id']));
});

test('product driver rejects changed fixtures, wrong tools, malformed arguments, missing correlation and expiry', async t => {
  for (const [change, expected] of [
    [(value, _body, response) => response.setHeader('x-muse-session-id', 'foreign'), 'product_correlation_missing'],
    [(value) => { value.choices[0].message.tool_calls[0].function.arguments = 'invalid'; }, 'invalid_function_arguments'],
    [(value) => { value.choices[0].message.tool_calls[0].function.name = 'shell'; }, 'product_unpermitted_tool'],
    [(_value, _body, response) => { response.statusCode = 426; }, 'product_http_426'],
  ]) {
    const h = await productServer(t, change), driver = new ProductProtocol({ origin: h.origin, keys });
    await assert.rejects(driver.start(make()), new RegExp(expected));
  }
  const h = await productServer(t), item = make();
  const driver = new ProductProtocol({ origin: h.origin, keys, readFixture: async () => 'changed' });
  await driver.start(item); await assert.rejects(driver.finish(item), /product_fixture_changed/); assert.equal(item.client_tool_executions, 0);
  let clock = 0;
  const late = new ProductProtocol({ origin: h.origin, keys, now: () => { clock += 300001; return clock; } });
  await assert.rejects(late.start(make()), /product_turn_deadline/);
  assert.throws(() => cycle({ ...make(), id: 'bad id' }), /invalid_product_cycle/);
  assert.throws(() => cycle({ id: 'id', slot: 'a', protocol: 'chat', stream: false, session: 'session', fixture: {} }), /client_fixture_required/);
});

test('a persisted tool execution intent is never automatically re-executed after response loss', async t => {
  const h = await productServer(t), item = make(); let reads = 0;
  const driver = new ProductProtocol({ origin: h.origin, keys, readFixture: async () => { reads++; return item.fixture.contents; } });
  await driver.start(item);
  driver.fetcher = async () => { throw new Error('lost response'); };
  await assert.rejects(driver.finish(item), /lost response/);
  assert.equal(item.client_tool_executions, 1); assert.ok(item.result_body);
  await assert.rejects(driver.finish(item), /product_tool_already_executed_or_uncertain/); assert.equal(reads, 1);
});

test('production correlation requires captured admission, an assignment and one canonical conversation', async t => {
  const h = await productServer(t), item = make(), driver = new ProductProtocol({ origin: h.origin, keys, readFixture: async () => item.fixture.contents });
  await driver.start(item); await driver.finish(item);
  await assert.rejects(driver.correlate(item, async () => exportFixture([])), /product_request_operation_missing/);
  await assert.rejects(driver.correlate(item, async path => path.includes('export') ? h.management(path) : {}), /product_assignment_missing/);
  let count = 0;
  await assert.rejects(driver.correlate(item, async path => {
    const value = await h.management(path);
    if (!path.includes('export')) value.request.conversation_id = 'different-' + ++count;
    return value;
  }), /product_session_identity_changed/);
  const sameOwner = new ProductProtocol({ origin: h.origin, keys: { a: keys.a, b: keys.a } });
  const responseItem = make('responses'); await driver.start(responseItem); await driver.finish(responseItem);
  await assert.rejects(sameOwner.rejectOtherClient(responseItem), /product_cross_client_admitted/);
});

test('native correlation binds every client turn to a claim, one-shot job and valid start time', async t => {
  const h = await productServer(t), item = make();
  const driver = new ProductProtocol({ origin: h.origin, keys, readFixture: async () => item.fixture.contents });
  await driver.start(item); await driver.finish(item);
  const management = (overrides = {}) => async path => {
    const value = await h.management(path);
    if (!path.includes('/diagnostics/export')) Object.assign(value.assignment, {
      lease_id: 'claim-' + value.execution.current_job_id, launch_id: 'launch-' + value.execution.current_job_id,
      native_job_id: 'native-' + value.execution.current_job_id, started_at: item.turns[0].started_at, ...overrides,
    });
    return value;
  };
  assert.equal((await driver.correlate(item, management())).outcome, 'passed');
  for (const turn of item.turns) {
    assert.equal(turn.claim_id, 'claim-' + turn.job_id);
    assert.equal(turn.launch_id, 'launch-' + turn.job_id);
    assert.equal(turn.native_job_id, 'native-' + turn.job_id);
  }
  for (const invalid of [{ lease_id: undefined }, { native_job_id: 'unsafe id' }, { started_at: null }]) {
    await assert.rejects(driver.correlate(item, management(invalid)), /product_assignment_missing/);
  }
});

test('correlation survives unrelated pruned history but rejects missing current evidence and invalid service times', async t => {
  for (const protocol of ['chat', 'responses']) {
    const h = await productServer(t), item = make(protocol);
    const driver = new ProductProtocol({ origin: h.origin, keys, readFixture: async () => item.fixture.contents });
    await driver.start(item); await driver.finish(item);
    const directory = await fs.mkdtemp(join(tmpdir(), 'aaa-product-retention-'));
    t.after(() => fs.rm(directory, { recursive: true }));
    let clock = 120000;
    const evidence = await openEvidence(join(directory, 'evidence'), { now: () => clock, stderr: () => {} });
    const capture = new Capture(evidence.capture.state, 1024 * 1024, 1000);
    await capture.write({ time: new Date(clock).toISOString(), level: 'INFO', msg: 'old.history' });
    clock = 123000;
    for (const turn of item.turns) {
      const [admitted] = decodeExport(await h.management('/api/v1/admin/diagnostics/export?request_id=' + turn.request_id)).events;
      await capture.write({ ...admitted, time: new Date(clock).toISOString(), request_id: turn.request_id });
    }
    const unbounded = await capture.export({ request_id: item.turns[0].request_id }, false);
    assert.throws(() => decodeExport(unbounded), /capture_incomplete/);
    const management = path => path.includes('/diagnostics/export') ? capture.export(Object.fromEntries(new URL('http://test' + path).searchParams), false) : h.management(path);
    const requests = h.requests.length;
    const receipt = await driver.correlate(item, management);
    assert.equal(receipt.operation_ids.length, 2);
    assert.equal(h.requests.length, requests);
    assert.equal(item.client_tool_executions, 1);
    const field = protocol === 'chat' ? 'created' : 'created_at';
    for (const value of [undefined, -1, 1.5, Infinity, Number.MAX_SAFE_INTEGER]) {
      item.turns[0].value[field] = value;
      await assert.rejects(driver.correlate(item, async () => { assert.fail('invalid service time must fail before export'); }), /product_creation_time_invalid/);
    }
    item.turns[0].value[field] = 123;
    clock += 2000;
    await assert.rejects(driver.correlate(item, management), /capture_incomplete/);
  }
});
