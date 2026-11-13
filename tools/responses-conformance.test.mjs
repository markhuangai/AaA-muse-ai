import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ResponseAccumulator, readResponseSSE, runResponseConformance, responseCases, validateResponse } from './responses-conformance.mjs';

const execute = promisify(execFile);
const textItem = text => ({ type: 'message', id: 'msg_unit', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] });
const response = (item, body = {}) => ({ id: body.id ?? 'resp_unit', object: 'response', created_at: 100, model: 'muse-pool-text', status: 'completed', error: null, incomplete_details: null, usage: null, instructions: body.instructions ?? null, previous_response_id: body.previous_response_id ?? null, output: [item] });

function events(value) {
  const item = value.output[0], progress = { ...value, output: [], status: 'in_progress' };
  const added = { ...item, status: 'in_progress', ...(item.type === 'message' ? { content: [] } : { arguments: '' }) };
  const parts = [{ type: 'response.created', response: progress }, { type: 'response.in_progress', response: progress }, { type: 'response.output_item.added', output_index: 0, item: added }];
  const link = { item_id: item.id, output_index: 0, content_index: 0 };
  if (item.type === 'message') parts.push(
    { type: 'response.content_part.added', ...link, part: { type: 'output_text', text: '', annotations: [] } },
    { type: 'response.output_text.delta', ...link, delta: item.content[0].text },
    { type: 'response.output_text.done', ...link, text: item.content[0].text },
    { type: 'response.content_part.done', ...link, part: item.content[0] },
  );
  else parts.push({ type: 'response.function_call_arguments.delta', ...link, delta: item.arguments }, { type: 'response.function_call_arguments.done', ...link, arguments: item.arguments });
  parts.push({ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: value });
  return parts.map((part, sequence_number) => ({ ...part, sequence_number }));
}
const wire = values => values.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('');

async function server(t, change = () => {}) {
  const stored = new Map(); let identity = 0;
  const value = createServer(async (req, res) => {
    const pieces = []; for await (const part of req) pieces.push(part);
    const body = JSON.parse(Buffer.concat(pieces));
    res.setHeader('x-request-id', 'unit-request'); res.setHeader('content-type', 'application/json');
    if (body.model !== 'muse-pool-text' || Object.hasOwn(body, 'store')) { res.statusCode = body.model !== 'muse-pool-text' ? 404 : 400; res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'unsupported', param: body.model !== 'muse-pool-text' ? 'model' : 'store' } })); return; }
    const session = req.headers['x-muse-session-id'] ?? stored.get(body.previous_response_id)?.session;
    res.setHeader('x-muse-session-id', session);
    const last = typeof body.input === 'string' ? { content: body.input } : body.input.at(-1);
    let item;
    if (last.type === 'function_call_output') item = textItem(last.output);
    else {
      const content = typeof last.content === 'string' ? last.content : last.content[0].text;
      item = content.startsWith('aaa-chat:tool:') ? { type: 'function_call', id: 'fc_unit', call_id: 'call_unit', name: 'read_file', arguments: JSON.stringify({ path: content.slice('aaa-chat:tool:'.length) }), status: 'completed' } : textItem(content.slice('aaa-chat:text:'.length));
    }
    const key = JSON.stringify({ ...body, stream: false, session });
    let result = stored.get(key)?.result;
    if (!result) { result = response(item, { ...body, id: 'resp_unit_' + ++identity }); stored.set(key, { result, session }); stored.set(result.id, { result, session }); }
    change(result, body);
    if (!body.stream) res.end(JSON.stringify(result));
    else { res.setHeader('content-type', 'text/event-stream'); res.end(wire(events(result))); }
  });
  value.listen(0, '127.0.0.1'); await once(value, 'listening');
  t.after(async () => { value.closeAllConnections(); await new Promise(resolve => value.close(resolve)); });
  return `http://127.0.0.1:${value.address().port}/v1`;
}

test('Responses validator runs complete lifecycle and exact text/function semantics', async () => {
  for (const item of [textItem('exact\r\n😀'), { type: 'function_call', id: 'fc_unit', call_id: 'call', name: 'f', status: 'completed', arguments: '{"path":"x"}' }]) {
    const value = response(item), accumulator = new ResponseAccumulator();
    for (const event of events(value)) accumulator.add(event);
    assert.deepEqual(accumulator.result(), value);
    assert.deepEqual(await readResponseSSE(new Response(wire(events(value)), { headers: { 'content-type': 'text/event-stream' } })), value);
    assert.throws(() => accumulator.add({ sequence_number: 100 }));
  }
  assert.throws(() => new ResponseAccumulator().result(), /truncated_response_stream/);
});

test('Responses consumer rejects malformed, reordered, truncated and inconsistent events', async () => {
  const value = response(textItem('exact'));
  const mutations = [
    list => list.reverse(), list => list.pop(), list => { list[2].output_index = 1; },
    list => { list[3].part.text = 'wrong'; }, list => { list[4].item_id = 'foreign'; }, list => { list[4].content_index = 1; },
    list => { list[4].delta = 4; }, list => { list[5].text = 'wrong'; }, list => { list[6].part.text = 'wrong'; },
    list => { list[7].item.status = 'in_progress'; }, list => { list[8].response.id = 'resp_foreign'; },
    list => { list[1].response.created_at = 200; }, list => { list[0].response.usage = {}; },
  ];
  for (const change of mutations) {
    const list = structuredClone(events(value)); change(list);
    await assert.rejects(readResponseSSE(new Response(wire(list), { headers: { 'content-type': 'text/event-stream' } })));
  }
  for (const raw of [wire(events(value)).slice(0, -2), wire(events(value)) + 'data: [DONE]\n\n', 'event: other\ndata: {}\n\n', 'data: {}\n\n']) await assert.rejects(readResponseSSE(new Response(raw, { headers: { 'content-type': 'text/event-stream' } })));
  await assert.rejects(readResponseSSE(new Response('', { status: 400 })));
  for (const invalid of [null, {}, { ...value, usage: {} }, { ...value, output: [] }, response({ ...textItem('x'), status: 'in_progress' }), response({ type: 'function_call', id: 'f', status: 'completed', call_id: 'c', name: 'f', arguments: 'null' }), response({ type: 'function_call', id: 'f', status: 'completed', call_id: 'c', name: 'f', arguments: 'invalid' })]) assert.throws(() => validateResponse(invalid));
  const failed = events(value).slice(0, 2); failed.push({ type: 'response.failed', sequence_number: 2, response: { ...value, output: [], status: 'failed', error: { code: 'worker_disconnected' } } });
  await assert.rejects(readResponseSSE(new Response(wire(failed), { headers: { 'content-type': 'text/event-stream' } })), /response_failed/);
});

test('Shared CLI and SDK/raw Responses runner execute permitted client file effects and replay', async t => {
  const parent = resolve('.artifacts/unit'); await mkdir(parent, { recursive: true }); const root = await mkdtemp(join(parent, 'responses-test-'));
  t.after(() => rm(root, { recursive: true }));
  const fixture = join(root, 'client-only.txt'); await writeFile(fixture, 'exact\r\n😀', { mode: 0o600 });
  const baseURL = await server(t);
  const proof = await runResponseConformance({ baseURL, key: 'unit-key', fixturePath: fixture });
  assert.equal(proof.receipts.length, responseCases.length); assert.equal(proof.receipts.filter(r => r.client_tool_executions === 1).length, 8);
  const receipt = join(root, 'receipt.json');
  await execute(process.execPath, ['tools/openai-conformance.mjs', '--protocol', 'responses', '--base-url', baseURL, '--fixture', fixture, '--receipt', receipt], { env: { ...process.env, MUSE_CHAT_CLIENT_KEY: 'unit-key' } });
  assert.equal(JSON.parse(await readFile(receipt, 'utf8')).suite, 'openai-responses');
  const wrong = await server(t, value => { if (value.output[0].type === 'message') value.output[0].content[0].text = 'wrong'; });
  await assert.rejects(runResponseConformance({ baseURL: wrong, key: 'unit-key', fixturePath: fixture }), /wrong_response_text/);
  const unsafe = await server(t, value => { if (value.output[0].type === 'function_call') value.output[0].name = 'run_shell'; });
  await assert.rejects(runResponseConformance({ baseURL: unsafe, key: 'unit-key', fixturePath: fixture }), /unpermitted_response_tool/);
  await assert.rejects(runResponseConformance({ baseURL: 'file:///v1', key: 'key', fixturePath: fixture }), /invalid_runner_configuration/);
});
