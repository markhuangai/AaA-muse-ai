import { createServer } from 'node:http';
import { once } from 'node:events';
import { chatValue, responseValue } from './product-fixture.mjs';
import { exportFixture } from '../qualification-fixtures.mjs';

export function wire(protocol, value) {
  if (protocol === 'chat') {
    const choice = value.choices[0], tool = choice.message.tool_calls?.[0];
    return [{ role: 'assistant' }, tool ? { tool_calls: [{ ...tool, index: 0 }] } : { content: choice.message.content }, {}].map((delta, index) => 'data: ' + JSON.stringify({
      id: value.id, created: value.created, model: value.model, object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason: index === 2 ? choice.finish_reason : null }],
    }) + '\n\n').join('') + 'data: [DONE]\n\n';
  }
  const item = value.output[0], progress = { ...value, status: 'in_progress', output: [] }, tool = item.type === 'function_call';
  const link = { item_id: item.id, output_index: 0, content_index: 0 };
  const events = [{ type: 'response.created', response: progress }, { type: 'response.in_progress', response: progress }, { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', ...(tool ? { arguments: '' } : { content: [] }) } }];
  if (tool) events.push({ type: 'response.function_call_arguments.delta', ...link, delta: item.arguments }, { type: 'response.function_call_arguments.done', ...link, arguments: item.arguments });
  else events.push({ type: 'response.content_part.added', ...link, part: { type: 'output_text', text: '', annotations: [] } }, { type: 'response.output_text.delta', ...link, delta: item.content[0].text },
    { type: 'response.output_text.done', ...link, text: item.content[0].text }, { type: 'response.content_part.done', ...link, part: item.content[0] });
  events.push({ type: 'response.output_item.done', output_index: 0, item }, { type: 'response.completed', response: value });
  return events.map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join('');
}

export async function productServer(t, change = () => {}) {
  const saved = new Map(), requests = [], details = new Map(); let sequence = 0;
  const server = createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks));
    const requestID = 'request-' + ++sequence;
    requests.push({ path: req.url, body, headers: req.headers, request_id: requestID });
    res.setHeader('Content-Type', 'application/json'); res.setHeader('X-Request-Id', requestID);
    const previous = saved.get(body.previous_response_id);
    if (previous && previous.key !== req.headers.authorization) { res.statusCode = 404; res.end(JSON.stringify({ error: { type: 'invalid_request_error', code: 'history_owner_denied' } })); return; }
    const session = req.headers['x-muse-session-id'] ?? previous?.session;
    res.setHeader('X-Muse-Session-Id', session ?? 'generated-session');
    const protocol = req.url.endsWith('/responses') ? 'responses' : 'chat';
    const last = protocol === 'chat' ? body.messages.at(-1) : typeof body.input === 'string' ? { content: body.input } : body.input.at(-1);
    const text = last.content ?? '', tool = typeof text === 'string' && text.startsWith('aaa-product:tool:');
    const output = tool ? text.slice('aaa-product:tool:'.length) : last.type === 'function_call_output' ? last.output : last.role === 'tool' ? last.content : text.slice('aaa-product:echo:'.length);
    const fingerprint = JSON.stringify({ ...body, stream: false, session });
    let value = saved.get(fingerprint)?.value;
    if (!value) {
      value = (protocol === 'chat' ? chatValue : responseValue)('op-' + sequence, output, tool, { instructions: body.instructions ?? null, previous_response_id: body.previous_response_id ?? null });
      const record = { value, session, key: req.headers.authorization };
      saved.set(fingerprint, record); saved.set(value.id, record);
    }
    const operation = value.id.replace(/^(resp_|chatcmpl-)/, '');
    details.set(requestID, { operation, session, worker: req.headers.authorization === 'Bearer client-a' ? 'worker-a' : 'worker-b' });
    change(value, body, res);
    if (body.stream) { res.setHeader('Content-Type', 'text/event-stream'); res.end(wire(protocol, value)); }
    else res.end(JSON.stringify(value));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const management = async path => {
    if (path.includes('/diagnostics/export')) {
      const id = new URL('http://test' + path).searchParams.get('request_id'), detail = details.get(id);
      return exportFixture([{ time: new Date().toISOString(), level: 'INFO', msg: requests.find(request => request.request_id === id).path.endsWith('/responses') ? 'responses.request_admitted' : 'chat.request_admitted', operation_id: detail.operation }]);
    }
    const operation = path.split('/').at(-1), detail = [...details.values()].find(value => value.operation === operation);
    return { execution: { worker_id: detail.worker, current_job_id: 'job-' + operation }, assignment: { connection_id: 'connection-' + detail.worker, connection_generation: 2, generation: 1 }, request: { conversation_id: 'conversation-' + detail.session }, delivery: { kind: 'full', messages: [] } };
  };
  return { origin: 'http://127.0.0.1:' + server.address().port, requests, management };
}
