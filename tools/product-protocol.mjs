import { model, readSSE, validateCompletion } from './openai-conformance.mjs';
import { readResponseSSE, validateResponse } from './responses-conformance.mjs';
import { decodeExport, identifier, need, same } from './qualification-evidence.mjs';

export const cycleIDs = ['a', 'b'].flatMap(slot => ['chat', 'responses'].flatMap(protocol => ['json', 'sse'].map(format => `${slot}.${protocol}.${format}`)));
export const instructions = 'The client owns the file and executes read_file. For aaa-product:tool:, propose exactly that client tool using the path after the prefix. Do not read a file on your VM. After the matching client result, return that result exactly, including newlines. For aaa-product:echo:, return exactly the text after that prefix.';

export function cycle({ id, slot, protocol, stream, fixture, session }) {
  need(typeof id === 'string' && /^[A-Za-z0-9_.-]{1,100}$/.test(id) && ['a', 'b'].includes(slot) && ['chat', 'responses'].includes(protocol) && typeof stream === 'boolean' && identifier(session), 'invalid_product_cycle');
  need(fixture?.owner === 'client_driver' && typeof fixture.path === 'string' && fixture.path && typeof fixture.contents === 'string' && fixture.contents, 'client_fixture_required');
  const parameters = { type: 'object', properties: { path: { type: 'string', enum: [fixture.path] } }, required: ['path'], additionalProperties: false };
  const fn = { name: 'read_file', description: 'Read the one permitted client-only fixture.', parameters };
  const user = { role: 'user', content: 'aaa-product:tool:' + fixture.path };
  const tools = protocol === 'chat' ? [{ type: 'function', function: fn }] : [{ type: 'function', ...fn }];
  const body = protocol === 'chat' ? { model, messages: [{ role: 'system', content: instructions }, user], tools, stream } : { model, instructions, input: [user], tools, stream };
  return { id, slot, protocol, stream, session_id: session, fixture, initial_body: body, turns: [], client_tool_executions: 0 };
}

export class ProductProtocol {
  constructor({ origin, keys, fetcher = fetch, now = Date.now, readFixture, save = async () => {} }) {
    this.origin = origin; this.keys = keys; this.fetcher = fetcher; this.now = now; this.readFixture = readFixture; this.save = save;
  }
  stamp() { return new Date(this.now()).toISOString(); }
  async call(item, body, session = item.session_id) {
    const started = this.stamp();
    const response = await this.fetcher(this.origin + '/v1/' + (item.protocol === 'chat' ? 'chat/completions' : 'responses'), {
      method: 'POST', headers: { Authorization: this.keys[item.slot], 'Content-Type': 'application/json', ...(session ? { 'X-Muse-Session-Id': session } : {}) },
      body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(330000),
    });
    need(response.ok, `product_http_${response.status}`);
    const value = item.protocol === 'chat' ? (body.stream ? await readSSE(response) : validateCompletion(await response.json())) : (body.stream ? await readResponseSSE(response) : validateResponse(await response.json()));
    const actualSession = response.headers.get('x-muse-session-id'), request = response.headers.get('x-request-id');
    need(actualSession === item.session_id && identifier(request), 'product_correlation_missing');
    const turn = { started_at: started, finished_at: this.stamp(), request_id: request, session_id: actualSession, body, value };
    need(Date.parse(turn.finished_at) - Date.parse(started) < 300000, 'product_turn_deadline');
    item.turns.push(turn); await this.save(item);
    return turn;
  }
  async start(item) {
    need(item.turns.length === 0, 'product_cycle_already_started');
    item.started_at = this.stamp(); await this.save(item);
    const first = await this.call(item, item.initial_body);
    const proposed = item.protocol === 'chat' ? first.value.choices[0].message.tool_calls?.[0] : first.value.output[0];
    const name = item.protocol === 'chat' ? proposed?.function?.name : proposed?.name;
    const raw = item.protocol === 'chat' ? proposed?.function?.arguments : proposed?.arguments;
    const args = JSON.parse(raw);
    const callID = item.protocol === 'chat' ? proposed.id : proposed.call_id;
    need(name === 'read_file' && identifier(callID) && same(args, { path: item.fixture.path }), 'product_unpermitted_tool');
    item.call_id = callID; item.last_boundary = 'waiting_for_client_tool'; await this.save(item);
    return item;
  }
  async finish(item) {
    need(item.turns.length === 1 && identifier(item.call_id) && item.client_tool_executions === 0 && !item.result_body, 'product_tool_already_executed_or_uncertain');
    const contents = await this.readFixture(item.fixture.path);
    need(contents === item.fixture.contents, 'product_fixture_changed');
    const first = item.turns[0].value;
    item.client_tool_executions = 1;
    item.result_body = item.protocol === 'chat' ? { ...item.initial_body, messages: [...item.initial_body.messages, first.choices[0].message, { role: 'tool', tool_call_id: item.call_id, content: contents }] } : {
      model, instructions, input: [{ type: 'function_call_output', call_id: item.call_id, output: contents }], previous_response_id: first.id, tools: item.initial_body.tools, stream: item.stream,
    };
    await this.save(item);
    const final = await this.call(item, item.result_body, item.protocol === 'responses' ? null : item.session_id);
    const text = finalText(item.protocol, final.value);
    need(text === contents, 'product_wrong_tool_result');
    const replay = await this.call(item, { ...item.result_body, stream: !item.stream }, item.protocol === 'responses' ? null : item.session_id);
    need(replay.value.id === final.value.id && same(retryOutput(item.protocol, replay.value), retryOutput(item.protocol, final.value)), 'product_retry_regenerated');
    item.last_boundary = 'completed'; item.finished_at = this.stamp(); item.outcome = 'passed'; await this.save(item);
    return item;
  }
  async followup(item, marker) {
    need(item.outcome === 'passed' && !item.followup, 'product_followup_conflict');
    const previous = item.turns.at(-1), final = previous.value;
    const body = item.protocol === 'chat' ? { ...item.initial_body, messages: [...previous.body.messages, final.choices[0].message, { role: 'user', content: 'aaa-product:echo:' + marker }] } : {
      model, instructions, input: 'aaa-product:echo:' + marker, previous_response_id: final.id, stream: item.stream,
    };
    item.followup = { body, marker }; item.outcome = 'incomplete'; await this.save(item);
    const turn = await this.call(item, body, item.protocol === 'responses' ? null : item.session_id);
    need(finalText(item.protocol, turn.value) === marker, 'product_wrong_followup');
    item.followup.value = turn.value; item.finished_at = turn.finished_at; item.outcome = 'passed'; await this.save(item);
    return turn;
  }
  async rejectOtherClient(item) {
    const other = item.slot === 'a' ? 'b' : 'a';
    const response = await this.fetcher(this.origin + '/v1/responses', { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Authorization: this.keys[other], 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: 'aaa-product:echo:cross-owner-must-not-run', previous_response_id: item.turns[1].value.id }),
    });
    const value = await response.json();
    need(response.status === 404 && value.error?.type === 'invalid_request_error' && identifier(response.headers.get('x-request-id')), 'product_cross_client_admitted');
    return { request_id: response.headers.get('x-request-id'), status: response.status, error: value.error, owner_slot: item.slot, rejected_slot: other };
  }
  async correlate(item, management) {
    const operations = [], workers = [], conversations = [], contexts = [];
    for (const turn of item.turns) {
      const created = item.protocol === 'chat' ? turn.value.created : turn.value.created_at;
      need(Number.isSafeInteger(created) && created >= 0 && Number.isFinite(new Date(created * 1000).getTime()), 'product_creation_time_invalid');
      const query = new URLSearchParams({ request_id: turn.request_id, since: new Date(created * 1000).toISOString() });
      const events = decodeExport(await management('/api/v1/admin/diagnostics/export?' + query)).events;
      const admitted = events.find(event => ['chat.request_admitted', 'responses.request_admitted'].includes(event.msg));
      need(identifier(admitted?.operation_id), 'product_request_operation_missing');
      const detail = await management('/api/v1/admin/requests/' + admitted.operation_id), execution = detail.execution;
      need(identifier(execution?.worker_id) && identifier(execution.current_job_id), 'product_assignment_missing');
      const assignment = detail.assignment;
      need(identifier(assignment?.connection_id) && assignment.connection_generation > 0 && assignment.generation > 0, 'product_assignment_missing');
      Object.assign(turn, { operation_id: admitted.operation_id, worker_id: execution.worker_id, job_id: execution.current_job_id, conversation_id: detail.request.conversation_id,
        connection_id: assignment.connection_id, connection_generation: assignment.connection_generation, generation: assignment.generation });
      operations.push(turn.operation_id); workers.push(turn.worker_id); conversations.push(turn.conversation_id); contexts.push(detail.delivery);
    }
    need(conversations.length && new Set(conversations).size === 1, 'product_session_identity_changed');
    await this.save(item);
    return { id: item.id, outcome: 'passed', operation_ids: [...new Set(operations)], worker_ids: [...new Set(workers)], conversation_id: conversations[0], request_ids: item.turns.map(turn => turn.request_id),
      session_id: item.session_id, client_tool_executions: item.client_tool_executions, call_id: item.call_id, contexts };
  }
}

export function finalText(protocol, value) {
  return protocol === 'chat' ? value.choices[0].message.content : value.output[0].content?.[0]?.text;
}

export function retryOutput(protocol, value) {
  return protocol === 'responses' ? value.output : value.choices.map(choice => ({ ...choice, logprobs: choice.logprobs ?? null,
    message: { ...choice.message, refusal: choice.message.refusal ?? null } }));
}
