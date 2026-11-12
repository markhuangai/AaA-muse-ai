import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { ChatAccumulator, assertCases, model, readSSE, requiredCases, runConformance, validateCompletion } from './openai-conformance.mjs';

const execute = promisify(execFile);
const final = content => ({ id: 'chatcmpl-test', created: 100, model, object: 'chat.completion', choices: [{ index: 0, finish_reason: 'stop', message: { role: 'assistant', content, refusal: null } }] });
const tool = args => ({ ...final(null), choices: [{ index: 0, finish_reason: 'tool_calls', message: { role: 'assistant', content: null, tool_calls: [{ id: 'call-a', type: 'function', function: { name: 'read_file', arguments: args } }] } }] });
const chunk = (delta, finish_reason = null) => ({ id: 'chatcmpl-test', created: 100, model, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] });
const frame = value => 'data: ' + (typeof value === 'string' ? value : JSON.stringify(value)) + '\n\n';
const textFrames = text => [chunk({ role: 'assistant' }), chunk({ content: text }), chunk({}, 'stop')];

async function server(t, handler) {
  const value = createServer(handler);
  value.listen(0, '127.0.0.1');
  await once(value, 'listening');
  t.after(async () => { value.closeAllConnections(); await new Promise(resolve => value.close(resolve)); });
  return `http://127.0.0.1:${value.address().port}/v1`;
}

async function fixture(t) {
  const parent = resolve('.artifacts/unit');
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(parent, 'openai-test-'));
  t.after(() => rm(root, { recursive: true }));
  const path = join(root, 'client-only.txt');
  await writeFile(path, 'fixture\r\nexact 😀\n', { mode: 0o600 });
  return { root, path };
}

async function protocolServer(t, change = () => {}) {
  return server(t, async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('X-Request-Id', 'request-a');
    res.setHeader('X-Muse-Session-Id', req.headers['x-muse-session-id'] ?? 'generated');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model', created: 0, owned_by: 'aaa-muse-ai' }] })); return; }
    const pieces = []; for await (const part of req) pieces.push(part);
    const body = JSON.parse(Buffer.concat(pieces));
    if (body.model !== model || Object.hasOwn(body, 'temperature')) {
      res.statusCode = body.model !== model ? 404 : 400;
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'unsupported', message: 'unsupported', param: body.model !== model ? 'model' : 'temperature' } })); return;
    }
    const last = body.messages.at(-1);
    let result;
    if (last.role === 'tool') result = final(last.content);
    else if (last.content.startsWith('aaa-chat:text:')) result = final(last.content.slice('aaa-chat:text:'.length));
    else result = tool(JSON.stringify({ path: body.tools[0].function.parameters.properties.path.const }));
    change(result, body, res);
    if (!body.stream) res.end(JSON.stringify(result));
    else {
      res.setHeader('Content-Type', 'text/event-stream');
      const choice = result.choices[0], message = choice.message;
      const delta = choice.finish_reason === 'tool_calls' ? { tool_calls: [{ ...message.tool_calls[0], index: 0 }] } : { content: message.content };
      res.end([chunk({ role: 'assistant' }), chunk(delta), chunk({}, choice.finish_reason)].map(frame).join('') + frame('[DONE]'));
    }
  });
}

test('SDK and raw HTTP run every real client protocol case and local file effect', async t => {
  const { path, root } = await fixture(t);
  const baseURL = await protocolServer(t);
  const result = await runConformance({ baseURL, key: 'unit-client-key', fixturePath: path });
  assert.equal(result.sdk_version, '7.53.0');
  assert.equal(result.qualifies_live_muse, false);
  assert.equal(result.receipts.length, requiredCases.length);
  assert.equal(result.receipts.filter(r => r.client_tool_executions === 1).length, 4);
  assertCases(result.receipts);
  const receipt = join(root, 'receipt.json');
  const invoked = await execute(process.execPath, ['tools/openai-conformance.mjs', '--base-url', baseURL, '--fixture', path, '--receipt', receipt], { env: { ...process.env, MUSE_CHAT_CLIENT_KEY: 'unit-client-key' }, timeout: 20000 });
  assert.equal(invoked.stdout.trim().split('\n').length, requiredCases.length);
  assert.equal((await stat(receipt)).mode & 0o777, 0o600);
  assert.equal(JSON.parse(await readFile(receipt, 'utf8')).sdk_version, '7.53.0');
});

test('raw SSE handles real fragmented HTTP, CRLF and exact UTF-8 without invented progress', async t => {
  const stream = textFrames('a\r\n😀');
  const base = await server(t, (_req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    const bytes = Buffer.from(': keepalive\r\n\r\n' + stream.map(frame).join('').replaceAll('\n\n', '\r\n\r\n') + frame('[DONE]'));
    for (const byte of bytes) res.write(Buffer.from([byte]));
    res.end();
  });
  const value = await readSSE(await fetch(base));
  assert.equal(value.choices[0].message.content, 'a\r\n😀');
});

test('malformed, incomplete and wrong-result streams fail through raw HTTP', async t => {
  const valid = textFrames('ok');
  const variants = [
    valid.map(frame).join(''),
    frame('[DONE]'),
    frame(valid[0]) + frame('[DONE]'),
    valid.map(frame).join('') + frame('[DONE]') + frame('[DONE]'),
    valid.map(frame).join('') + 'data: [DONE]',
    'data: {broken}\n\n',
    'event: unexpected\n\n',
    frame(chunk({ content: 'no role' })),
    frame(valid[0]) + frame({ ...valid[1], id: 'chatcmpl-other' }),
    frame(valid[0]) + frame(chunk({ content: 7 })),
    frame(valid[0]) + frame(chunk({ refusal: 'no' })),
    frame(valid[0]) + frame(chunk({ content: 'text' }, 'stop')),
    frame(valid[0]) + frame(chunk({}, 'length')),
    frame(valid[0]) + frame(chunk({ tool_calls: [] })),
    frame(valid[0]) + frame(chunk({ tool_calls: [{ index: 1 }] })),
  ];
  const base = await server(t, (req, res) => { res.setHeader('Content-Type', 'text/event-stream'); res.end(variants[Number(req.url.split('/').at(-1))]); });
  for (let i = 0; i < variants.length; i++) await assert.rejects(readSSE(await fetch(base + '/' + i)));
  await assert.rejects(readSSE(new Response('', { status: 400 })));
  await assert.rejects(readSSE(new Response('', { headers: { 'Content-Type': 'text/plain' } })));
});

test('stream accumulator preserves fragmented function arguments and enforces its state machine', () => {
  const a = new ChatAccumulator();
  a.add(chunk({ role: 'assistant', content: '' }));
  a.add(chunk({ tool_calls: [{ index: 0, id: 'call-a', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] }));
  a.add(chunk({ tool_calls: [{ index: 0, function: { arguments: '"x"}' } }] }));
  a.add(chunk({}, 'tool_calls'));
  assert.equal(a.result().choices[0].message.tool_calls[0].function.arguments, '{"path":"x"}');
  assert.throws(() => a.add(chunk({})), /chunk_after_finish/);
  for (const part of [
    { index: 0, id: 1 }, { index: 0, type: 'custom' }, { index: 0, function: { extra: true } },
    { index: 0, function: { name: 7 } }, { index: 0, function: { arguments: 7 } }, { index: 0, extra: true },
  ]) {
    const b = new ChatAccumulator(); b.add(chunk({ role: 'assistant' }));
    assert.throws(() => b.add(chunk({ tool_calls: [part] })));
  }
  for (const second of [{ content: 'text' }, { tool_calls: [{ index: 0, id: 'again' }] }, { tool_calls: [{ index: 0, function: { name: 'again' } }] }]) {
    const b = new ChatAccumulator(); b.add(chunk({ role: 'assistant' }));
    b.add(chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'f', arguments: '{}' } }] }));
    assert.throws(() => b.add(chunk(second)));
  }
  const b = new ChatAccumulator(); b.add(chunk({ role: 'assistant' })); b.add(chunk({ content: 'x' }));
  assert.throws(() => b.add(chunk({ tool_calls: [{ index: 0 }] })));
  assert.throws(() => new ChatAccumulator().result(), /missing_finish/);
});

test('completion assertions reject malformed envelopes, choices, calls and unknown usage', () => {
  const variants = [null, {}, { ...final('x'), usage: {} }, { ...final('x'), choices: [] }, { ...final('x'), choices: [{ index: 1 }] },
    { ...final('x'), choices: [{ index: 0, message: { role: 'user' } }] }, tool('bad JSON'), tool('null'), tool('[]')];
  for (const value of variants) assert.throws(() => validateCompletion(value));
  const bad = tool('{}'); bad.choices[0].message.tool_calls[0].type = 'custom'; assert.throws(() => validateCompletion(bad));
  const missing = tool('{}'); missing.choices[0].message.tool_calls = []; assert.throws(() => validateCompletion(missing));
  assert.throws(() => assertCases([]), /missing_or_duplicate_required_case/);
});

test('runner reports wrong backend results and refuses unpermitted client tool effects', async t => {
  const { path } = await fixture(t);
  const wrong = await protocolServer(t, (value, body) => { if (!body.tools.length) value.choices[0].message.content = 'wrong'; });
  await assert.rejects(runConformance({ baseURL: wrong, key: 'unit-key', fixturePath: path }), /wrong_text_result/);
  const unpermitted = await protocolServer(t, value => { if (value.choices[0].finish_reason === 'tool_calls') value.choices[0].message.tool_calls[0].function.name = 'run_shell'; });
  await assert.rejects(runConformance({ baseURL: unpermitted, key: 'unit-key', fixturePath: path }), /unpermitted_client_tool/);
  for (const baseURL of ['file:///v1', 'https://user:password@example.test/v1', 'https://example.test/wrong', 'https://example.test/v1?key=secret']) await assert.rejects(runConformance({ baseURL, key: 'unit-key', fixturePath: path }), /invalid_runner_configuration/);
  try { await execute(process.execPath, ['tools/openai-conformance.mjs'], { env: { ...process.env, MUSE_CHAT_CLIENT_KEY: 'must-not-log' } }); assert.fail('CLI accepted missing cases'); }
  catch (error) { assert.equal(error.code, 1); assert.match(error.stderr, /runner_arguments_required/); assert.ok(!error.stderr.includes('must-not-log')); }
});
