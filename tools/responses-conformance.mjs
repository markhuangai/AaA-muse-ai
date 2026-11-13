import OpenAI from 'openai';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { model } from './openai-conformance.mjs';

function require(value, code) { if (!value) throw Object.assign(new Error(code), { code }); }

export function validateResponse(value) {
  require(value?.object === 'response' && typeof value.id === 'string' && value.id.startsWith('resp_') && value.model === model && Number.isInteger(value.created_at), 'invalid_response_identity');
  require(value.status === 'completed' && value.error === null && value.incomplete_details === null && value.usage === null, 'invalid_response_outcome');
  require(Array.isArray(value.output) && value.output.length === 1, 'invalid_response_output');
  const item = value.output[0];
  require(typeof item.id === 'string' && item.id.length > 0 && item.status === 'completed', 'invalid_item_identity');
  if (item.type === 'message') require(item.role === 'assistant' && item.content?.length === 1 && item.content[0].type === 'output_text' && typeof item.content[0].text === 'string' && Array.isArray(item.content[0].annotations) && item.content[0].annotations.length === 0, 'invalid_response_message');
  else {
    require(item.type === 'function_call' && typeof item.call_id === 'string' && item.call_id && typeof item.name === 'string' && typeof item.arguments === 'string', 'invalid_response_function');
    let args; try { args = JSON.parse(item.arguments); } catch { require(false, 'invalid_response_arguments'); }
    require(args && typeof args === 'object' && !Array.isArray(args), 'invalid_response_arguments');
  }
  return value;
}

export class ResponseAccumulator {
  constructor() { this.sequence = 0; this.stage = 'created'; this.text = ''; this.arguments = ''; this.terminal = false; }

  add(event) {
    require(!this.terminal && event && event.sequence_number === this.sequence++, 'invalid_response_sequence');
    const type = event.type;
    if (this.stage === 'created' || this.stage === 'progress') {
      require(type === (this.stage === 'created' ? 'response.created' : 'response.in_progress'), 'invalid_response_lifecycle');
      const r = event.response;
      require(r?.object === 'response' && r.status === 'in_progress' && r.output?.length === 0 && typeof r.id === 'string' && r.id.startsWith('resp_') && r.model === model && Number.isInteger(r.created_at) && r.usage === null && r.error === null, 'invalid_response_progress');
      if (this.identity) require(isDeepStrictEqual(r, this.identity), 'changed_response_identity');
      this.identity = r; this.stage = this.stage === 'created' ? 'progress' : 'item'; return;
    }
    if (type === 'response.failed') {
      require(this.stage === 'item' && event.response?.id === this.identity.id && event.response.status === 'failed' && event.response.output?.length === 0 && typeof event.response.error?.code === 'string', 'invalid_response_failure');
      this.terminal = true; this.failure = event.response.error.code; return;
    }
    if (this.stage === 'item') {
      require(type === 'response.output_item.added' && event.output_index === 0 && event.item?.status === 'in_progress' && typeof event.item.id === 'string', 'invalid_item_start');
      this.item = structuredClone(event.item);
      if (this.item.type === 'message') { require(this.item.role === 'assistant' && this.item.content?.length === 0, 'invalid_message_start'); this.stage = 'part'; }
      else { require(this.item.type === 'function_call' && this.item.arguments === '' && this.item.call_id && this.item.name, 'invalid_function_start'); this.stage = 'arguments'; }
      return;
    }
    if (type === 'response.output_item.done') {
      require(this.stage === 'item_done' && event.output_index === 0 && isDeepStrictEqual(event.item, { ...this.item, status: 'completed' }), 'invalid_item_completion');
      this.item = event.item; this.stage = 'complete'; return;
    }
    if (this.stage === 'complete') {
      require(type === 'response.completed', 'missing_response_completion');
      const result = validateResponse(event.response);
      require(result.id === this.identity.id && result.created_at === this.identity.created_at && result.model === this.identity.model && isDeepStrictEqual(result.output, [this.item]) && result.instructions === this.identity.instructions && result.previous_response_id === this.identity.previous_response_id, 'changed_response_completion');
      this.value = result; this.terminal = true; return;
    }
    require(event.item_id === this.item.id && event.output_index === 0, 'changed_response_item');
    if (this.item.type === 'message') {
      require(event.content_index === 0, 'invalid_response_content_index');
      if (this.stage === 'part') {
        require(type === 'response.content_part.added' && isDeepStrictEqual(event.part, { type: 'output_text', text: '', annotations: [] }), 'invalid_content_start'); this.stage = 'text';
      } else if (this.stage === 'text' && type === 'response.output_text.delta') {
        require(typeof event.delta === 'string', 'invalid_text_delta'); this.text += event.delta;
      } else if (this.stage === 'text') {
        require(type === 'response.output_text.done' && event.text === this.text, 'invalid_text_completion'); this.stage = 'part_done';
      } else {
        require(this.stage === 'part_done' && type === 'response.content_part.done' && isDeepStrictEqual(event.part, { type: 'output_text', text: this.text, annotations: [] }), 'invalid_content_completion');
        this.item.content = [event.part]; this.stage = 'item_done';
      }
    } else if (this.stage === 'arguments' && type === 'response.function_call_arguments.delta') {
      require(typeof event.delta === 'string', 'invalid_argument_delta'); this.arguments += event.delta;
    } else {
      require(this.stage === 'arguments' && type === 'response.function_call_arguments.done' && event.arguments === this.arguments, 'invalid_argument_completion');
      this.item.arguments = this.arguments; this.stage = 'item_done';
    }
    require(this.text.length + this.arguments.length <= 2 * 1024 * 1024, 'response_output_too_large');
  }

  result() { require(this.terminal, 'truncated_response_stream'); require(!this.failure, 'response_failed'); return this.value; }
}

export async function readResponseSSE(response) {
  require(response.ok && response.headers.get('content-type')?.split(';')[0] === 'text/event-stream' && response.body, 'invalid_responses_sse');
  const accumulator = new ResponseAccumulator(), decoder = new TextDecoder('utf-8', { fatal: true });
  let pending = '', bytes = 0;
  const frame = raw => {
    const lines = raw.split('\n').filter(line => line && !line.startsWith(':'));
    if (!lines.length) return;
    const types = lines.filter(line => line.startsWith('event:')).map(line => line.slice(6).trim());
    const text = lines.filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /, '')).join('\n');
    require(types.length === 1 && text && text !== '[DONE]', 'invalid_responses_sse_frame');
    const event = JSON.parse(text); require(event.type === types[0], 'response_event_type_mismatch'); accumulator.add(event);
  };
  for await (const chunk of response.body) {
    bytes += chunk.byteLength; require(bytes <= 8 * 1024 * 1024, 'response_stream_too_large');
    pending = (pending + decoder.decode(chunk, { stream: true })).replaceAll('\r\n', '\n');
    let end; while ((end = pending.indexOf('\n\n')) >= 0) { frame(pending.slice(0, end)); pending = pending.slice(end + 2); }
  }
  pending += decoder.decode(); require(!pending.trim(), 'truncated_response_frame'); return accumulator.result();
}

export const responseCases = ['sdk.text.json', 'sdk.text.sse', 'raw.text.json', 'raw.text.sse', ...['sdk', 'raw'].flatMap(mode => ['json', 'sse'].flatMap(format => ['replay', 'chain'].map(style => `${mode}.tools.${format}.${style}`))), 'errors.explicit'];

export async function runResponseConformance({ baseURL, key, fixturePath, read = readFile, fetchImpl = fetch, prefix = randomUUID(), emit = () => {} }) {
  const origin = new URL(baseURL);
  require(['http:', 'https:'].includes(origin.protocol) && !origin.username && !origin.password && !origin.search && !origin.hash && origin.pathname.replace(/\/$/, '') === '/v1' && key && fixturePath, 'invalid_runner_configuration');
  const fixture = resolve(fixturePath), client = new OpenAI({ baseURL, apiKey: key, maxRetries: 0, timeout: 330000 });
  const tools = [{ type: 'function', name: 'read_file', description: 'Read the exact permitted client fixture.', parameters: { type: 'object', properties: { path: { type: 'string', const: fixture } }, required: ['path'], additionalProperties: false }, strict: false }];
  const receipts = [], record = (name, fields = {}) => { const value = { case: name, outcome: 'passed', ...fields }; receipts.push(value); emit(value); };
  const call = async (mode, stream, input, session, fields = {}) => {
    const body = { model, input, stream, parallel_tool_calls: false, ...fields };
    let response, value;
    const headers = session ? { 'X-Muse-Session-Id': session } : {};
    if (mode === 'sdk') {
      const result = await client.responses.create(body, { headers }).withResponse(); response = result.response;
      if (stream) { const accumulator = new ResponseAccumulator(); for await (const event of result.data) accumulator.add(event); value = accumulator.result(); }
      else value = validateResponse(result.data);
    } else {
      response = await fetchImpl(baseURL.replace(/\/$/, '') + '/responses', { method: 'POST', headers: { ...headers, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(330000) });
      require(response.ok, 'unexpected_responses_error'); value = stream ? await readResponseSSE(response) : validateResponse(await response.json());
    }
    require(response.headers.get('x-request-id') && response.headers.get('x-muse-session-id') && (!session || response.headers.get('x-muse-session-id') === session), 'missing_response_correlation');
    return { value, session: response.headers.get('x-muse-session-id'), requestID: response.headers.get('x-request-id') };
  };
  for (const mode of ['sdk', 'raw']) for (const stream of [false, true]) {
    const format = stream ? 'sse' : 'json', label = mode + '-' + format, marker = 'exact-' + prefix + '-' + label;
    const text = await call(mode, stream, 'aaa-chat:text:' + marker, prefix + '-text-' + label, { instructions: 'Return the exact marker.' });
    require(text.value.output[0].content[0].text === marker && text.value.instructions === 'Return the exact marker.', 'wrong_response_text'); record(mode + '.text.' + format, { request_id: text.requestID });
    for (const style of ['replay', 'chain']) {
      const session = prefix + '-' + label + '-' + style;
      const input = [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'aaa-chat:tool:' + fixture }] }];
      const first = await call(mode, stream, input, session, { tools, instructions: 'The client executes read_file; return its exact result.' });
      const item = first.value.output[0], args = JSON.parse(item.arguments);
      require(item.type === 'function_call' && item.name === 'read_file' && args.path === fixture && Object.keys(args).length === 1, 'unpermitted_response_tool');
      const output = await read(fixture, 'utf8'), result = { type: 'function_call_output', call_id: item.call_id, output };
      const next = style === 'replay' ? [...input, item, result] : [result];
      const fields = style === 'chain' ? { tools, previous_response_id: first.value.id } : { tools };
      const final = await call(mode, stream, next, style === 'chain' ? undefined : session, fields);
      require(final.session === session && final.value.output[0].content[0].text === output && final.value.instructions === null, 'wrong_response_tool_result');
      const replay = await call(mode, !stream, next, style === 'chain' ? undefined : session, fields);
      require(isDeepStrictEqual(replay.value.output, final.value.output) && replay.value.id === final.value.id, 'response_retry_regenerated');
      record(`${mode}.tools.${format}.${style}`, { request_id: final.requestID, call_id: item.call_id, client_tool_executions: 1, exact_retry: true });
    }
  }
  const rejections = [];
  for (const [body, status, param] of [[{ model: 'unknown', input: 'x' }, 404, 'model'], [{ model, input: 'x', store: false }, 400, 'store']]) {
    const response = await fetchImpl(baseURL.replace(/\/$/, '') + '/responses', { method: 'POST', headers: { Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(15000) });
    const error = (await response.json()).error; require(response.status === status && error?.type === 'invalid_request_error' && error.param === param && typeof error.code === 'string' && response.headers.get('x-request-id'), 'invalid_response_error');
    rejections.push({ request_id: response.headers.get('x-request-id'), code: error.code, parameter: param, status });
  }
  record('errors.explicit', { rejections }); require(responseCases.every(name => receipts.filter(r => r.case === name && r.outcome === 'passed').length === 1), 'missing_response_case');
  const sdk = JSON.parse(await readFile(new URL('../node_modules/openai/package.json', import.meta.url), 'utf8')).version; require(sdk === '7.53.0', 'wrong_sdk_version');
  return { suite: 'openai-responses', sdk_version: sdk, qualifies_live_muse: false, receipts };
}
