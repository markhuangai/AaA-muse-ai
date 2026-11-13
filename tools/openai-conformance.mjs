import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const model = 'muse-pool-text';
export const requiredCases = ['sdk.text.json', 'sdk.tools.json', 'sdk.text.sse', 'sdk.tools.sse', 'raw.text.json', 'raw.tools.json', 'raw.text.sse', 'raw.tools.sse', 'errors.explicit'];

function require(condition, code) {
  if (!condition) throw Object.assign(new Error(code), { code });
}

function callOf(message) {
  require(message.content === null && Array.isArray(message.tool_calls) && message.tool_calls.length === 1, 'invalid_tool_message');
  const call = message.tool_calls[0];
  require(typeof call.id === 'string' && call.id.length > 0 && call.type === 'function' && typeof call.function?.name === 'string' && typeof call.function.arguments === 'string', 'invalid_function_call');
  let args;
  try { args = JSON.parse(call.function.arguments); } catch { require(false, 'invalid_function_arguments'); }
  require(args && typeof args === 'object' && !Array.isArray(args), 'invalid_function_arguments');
  return { call, args };
}

export function validateCompletion(value) {
  require(value?.object === 'chat.completion' && typeof value.id === 'string' && value.id.startsWith('chatcmpl-') && Number.isInteger(value.created) && value.model === model, 'invalid_completion_identity');
  require(!Object.hasOwn(value, 'usage'), 'invented_usage');
  require(Array.isArray(value.choices) && value.choices.length === 1 && value.choices[0].index === 0, 'invalid_choices');
  const choice = value.choices[0];
  require(choice.message?.role === 'assistant', 'invalid_assistant_role');
  if (choice.finish_reason === 'tool_calls') callOf(choice.message);
  else require(choice.finish_reason === 'stop' && typeof choice.message.content === 'string' && !choice.message.tool_calls, 'invalid_final_answer');
  return value;
}

export class ChatAccumulator {
  constructor() { this.chunks = 0; this.content = ''; this.call = null; this.finished = false; }

  add(chunk) {
    require(!this.finished, 'chunk_after_finish');
    require(chunk?.object === 'chat.completion.chunk' && typeof chunk.id === 'string' && chunk.id.startsWith('chatcmpl-') && chunk.model === model && Number.isInteger(chunk.created), 'invalid_chunk_identity');
    require(!Object.hasOwn(chunk, 'usage'), 'invented_usage');
    require(Array.isArray(chunk.choices) && chunk.choices.length === 1 && chunk.choices[0].index === 0, 'invalid_choices');
    const { delta, finish_reason: finish } = chunk.choices[0];
    require(delta && typeof delta === 'object' && !Array.isArray(delta) && Object.keys(delta).every(key => ['role', 'content', 'tool_calls'].includes(key)), 'invalid_delta');
    if (this.chunks === 0) {
      require(delta.role === 'assistant' && !delta.tool_calls && (delta.content === undefined || delta.content === '') && finish === null, 'missing_initial_role');
      this.identity = { id: chunk.id, created: chunk.created, model: chunk.model };
    } else {
      require(chunk.id === this.identity.id && chunk.created === this.identity.created && !delta.role, 'changed_chunk_identity');
      if (delta.content !== undefined) {
        require(typeof delta.content === 'string' && !this.call, 'mixed_or_invalid_content');
        this.content += delta.content;
      }
      if (delta.tool_calls !== undefined) {
        require(!this.content && Array.isArray(delta.tool_calls) && delta.tool_calls.length === 1, 'parallel_or_mixed_tools');
        const part = delta.tool_calls[0];
        require(part.index === 0 && Object.keys(part).every(key => ['index', 'id', 'type', 'function'].includes(key)), 'invalid_tool_delta');
        this.call ??= { id: '', type: 'function', function: { name: '', arguments: '' } };
        if (part.id !== undefined) { require(typeof part.id === 'string' && !this.call.id, 'duplicate_tool_identity'); this.call.id = part.id; }
        if (part.type !== undefined) require(part.type === 'function', 'invalid_tool_type');
        if (part.function !== undefined) {
          require(part.function && Object.keys(part.function).every(key => ['name', 'arguments'].includes(key)), 'invalid_function_delta');
          if (part.function.name !== undefined) { require(typeof part.function.name === 'string' && !this.call.function.name, 'duplicate_function_name'); this.call.function.name = part.function.name; }
          if (part.function.arguments !== undefined) { require(typeof part.function.arguments === 'string', 'invalid_argument_delta'); this.call.function.arguments += part.function.arguments; }
        }
      }
      if (finish !== null) {
        require(Object.keys(delta).length === 0 && finish === (this.call ? 'tool_calls' : 'stop'), 'invalid_finish');
        this.finished = true;
      }
    }
    this.chunks++;
    require(this.content.length + (this.call?.function.arguments.length ?? 0) <= 2 * 1024 * 1024, 'output_too_large');
  }

  result() {
    require(this.finished, 'missing_finish');
    const message = { role: 'assistant', content: this.call ? null : this.content, ...(this.call ? { tool_calls: [this.call] } : {}) };
    return validateCompletion({ ...this.identity, object: 'chat.completion', choices: [{ index: 0, message, finish_reason: this.call ? 'tool_calls' : 'stop' }] });
  }
}

export async function readSSE(response) {
  require(response.ok && response.headers.get('content-type')?.split(';')[0] === 'text/event-stream' && response.body, 'invalid_sse_response');
  const accumulator = new ChatAccumulator();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', done = false, bytes = 0;
  const frame = raw => {
    const lines = raw.split('\n').filter(line => line && !line.startsWith(':'));
    if (!lines.length) return;
    require(!done, 'frame_after_done');
    const data = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    require(data.length > 0, 'missing_sse_data');
    if (data === '[DONE]') { require(accumulator.finished, 'done_before_finish'); done = true; }
    else accumulator.add(JSON.parse(data));
  };
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    require(bytes <= 4 * 1024 * 1024, 'stream_too_large');
    pending = (pending + decoder.decode(chunk, { stream: true })).replaceAll('\r\n', '\n');
    let end;
    while ((end = pending.indexOf('\n\n')) >= 0) { frame(pending.slice(0, end)); pending = pending.slice(end + 2); }
  }
  pending += decoder.decode();
  require(!pending.trim() && done, 'truncated_sse');
  return accumulator.result();
}

export function assertCases(receipts) {
  require(requiredCases.every(name => receipts.filter(receipt => receipt.case === name && receipt.outcome === 'passed').length === 1), 'missing_or_duplicate_required_case');
}

export async function runConformance({ baseURL, key, fixturePath, read = readFile, fetchImpl = fetch, prefix = randomUUID(), emit = () => {} }) {
  const origin = new URL(baseURL);
  require(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname.replace(/\/$/, '') === '/v1' && key && fixturePath, 'invalid_runner_configuration');
  const fixture = resolve(fixturePath);
  const client = new OpenAI({ baseURL, apiKey: key, maxRetries: 0, timeout: 330000 });
  const receipts = [];
  const record = (name, fields = {}) => { const receipt = { case: name, outcome: 'passed', ...fields }; receipts.push(receipt); emit(receipt); };
  const tools = [{ type: 'function', function: { name: 'read_file', description: 'Read the permitted client-only fixture.', parameters: { type: 'object', properties: { path: { type: 'string', const: fixture } }, required: ['path'], additionalProperties: false } } }];
  const call = async (mode, stream, messages, session, selectedTools = []) => {
    const body = { model, messages, tools: selectedTools, stream, n: 1, parallel_tool_calls: false };
    let value, response;
    if (mode === 'sdk') {
      const result = await client.chat.completions.create(body, { headers: { 'X-Muse-Session-Id': session } }).withResponse();
      response = result.response;
      if (stream) { const accumulator = new ChatAccumulator(); for await (const chunk of result.data) accumulator.add(chunk); value = accumulator.result(); }
      else value = validateCompletion(result.data);
    } else {
      response = await fetchImpl(baseURL.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', 'X-Muse-Session-Id': session }, body: JSON.stringify(body), signal: AbortSignal.timeout(330000) });
      require(response.ok, 'unexpected_chat_error');
      value = stream ? await readSSE(response) : validateCompletion(await response.json());
    }
    require(response.headers.get('x-muse-session-id') === session && response.headers.get('x-request-id'), 'missing_correlation_headers');
    return { value, requestID: response.headers.get('x-request-id') };
  };
  const models = await client.models.list();
  require(models.data.length === 1 && models.data[0].id === model, 'invalid_model_list');
  for (const mode of ['sdk', 'raw']) for (const stream of [false, true]) {
    const kind = stream ? 'sse' : 'json', label = mode + '-' + kind;
    const marker = 'exact-' + prefix + '-' + label;
    const instructions = { role: 'system', content: 'For this protocol test, return exactly the text after aaa-chat:text:. For aaa-chat:tool:, propose read_file for that exact client fixture, then return its exact tool result. The client executes the tool.' };
    const text = await call(mode, stream, [instructions, { role: 'user', content: 'aaa-chat:text:' + marker }], prefix + '-text-' + label);
    require(text.value.choices[0].message.content === marker, 'wrong_text_result');
    record(mode + '.text.' + kind, { request_id: text.requestID });
    const messages = [instructions, { role: 'user', content: 'aaa-chat:tool:' + fixture }];
    const session = prefix + '-tools-' + label;
    const first = await call(mode, stream, messages, session, tools);
    const { call: tool, args } = callOf(first.value.choices[0].message);
    require(tool.function.name === 'read_file' && args.path === fixture && Object.keys(args).length === 1, 'unpermitted_client_tool');
    const output = await read(fixture, 'utf8');
    messages.push(first.value.choices[0].message, { role: 'tool', tool_call_id: tool.id, content: output });
    const final = await call(mode, stream, messages, session, tools);
    require(final.value.choices[0].message.content === output, 'wrong_tool_result');
    record(mode + '.tools.' + kind, { request_id: final.requestID, call_id: tool.id, client_tool_executions: 1 });
  }
  for (const [body, status, param] of [[{ model: 'unknown', messages: [{ role: 'user', content: 'x' }] }, 404, 'model'], [{ model, messages: [{ role: 'user', content: 'x' }], temperature: 1 }, 400, 'temperature']]) {
    const response = await fetchImpl(baseURL.replace(/\/$/, '') + '/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const error = (await response.json()).error;
    require(response.status === status && typeof error?.code === 'string' && typeof error.message === 'string' && error.param === param && error.type === 'invalid_request_error', 'invalid_error_envelope');
  }
  record('errors.explicit');
  assertCases(receipts);
  const sdk = JSON.parse(await readFile(new URL('../node_modules/openai/package.json', import.meta.url), 'utf8')).version;
  require(sdk === '7.53.0', 'wrong_sdk_version');
  return { suite: 'openai-chat', sdk_version: sdk, qualifies_live_muse: false, receipts };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  try {
    const options = {};
    require(args.length === 6 || args.length === 8, 'runner_arguments_required');
    for (let i = 0; i < args.length; i += 2) { require(['--base-url', '--fixture', '--receipt', '--protocol'].includes(args[i]) && !options[args[i]] && args[i + 1], 'invalid_runner_arguments'); options[args[i]] = args[i + 1]; }
    require(['--base-url', '--fixture', '--receipt'].every(key => options[key]) && ['chat', 'responses'].includes(options['--protocol'] ?? 'chat'), 'invalid_runner_arguments');
    const run = options['--protocol'] === 'responses' ? (await import('./responses-conformance.mjs')).runResponseConformance : runConformance;
    const result = await run({ baseURL: options['--base-url'], key: env.MUSE_CHAT_CLIENT_KEY, fixturePath: options['--fixture'], emit: receipt => process.stdout.write(JSON.stringify(receipt) + '\n') });
    await writeFile(options['--receipt'], JSON.stringify(result, null, 2) + '\n', { mode: 0o600 });
    return 0;
  } catch (error) {
    process.stderr.write(JSON.stringify({ case: 'openai.conformance', outcome: 'failed', cause: error.code ?? 'conformance_failed' }) + '\n');
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main().then(code => { process.exitCode = code; });
