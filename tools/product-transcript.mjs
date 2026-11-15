import { need } from './qualification-evidence.mjs';

function message(role, text) {
  need(typeof role === 'string' && typeof text === 'string', 'invalid_product_message');
  return { type: 'message', role, ...(text ? { text } : {}) };
}

export function productDecision(protocol, value) {
  if (protocol === 'chat') {
    const assistant = value.choices[0].message, call = assistant.tool_calls?.[0];
    return call ? { type: 'tool_call', call_id: call.id, name: call.function.name, arguments: JSON.parse(call.function.arguments) } : { type: 'final', ...(assistant.content ? { text: assistant.content } : {}) };
  }
  const output = value.output[0];
  return output.type === 'function_call' ? { type: 'tool_call', call_id: output.call_id, name: output.name, arguments: JSON.parse(output.arguments) } : { type: 'final', ...(output.content[0].text ? { text: output.content[0].text } : {}) };
}

function projectedMessages(protocol, body) {
  if (protocol === 'chat') return body.messages.flatMap(item => {
    if (item.role === 'tool') return [{ type: 'tool_result', call_id: item.tool_call_id, ...(item.content ? { output: item.content } : {}) }];
    if (item.tool_calls?.length) return [productDecision('chat', { choices: [{ message: item }] })];
    return [message(item.role, item.content)];
  });
  const supplied = typeof body.input === 'string' ? [{ role: 'user', content: body.input }] : body.input;
  return supplied.map(item => item.type === 'function_call_output' ? { type: 'tool_result', call_id: item.call_id, ...(item.output ? { output: item.output } : {}) } : message(item.role, item.content));
}

export function productTools(protocol, body) {
  return (body.tools ?? []).map(tool => {
    const value = protocol === 'chat' ? tool.function : tool;
    need(tool.type === 'function' && value.name && value.parameters && typeof value.parameters === 'object', 'invalid_product_tool');
    return { name: value.name, ...(value.description ? { description: value.description } : {}), parameters: value.parameters };
  });
}

export function productTranscript(item) {
  const operations = new Map(), responses = new Map(), projected = [];
  for (const turn of item.turns) {
    const prior = operations.get(turn.operation_id);
    if (prior) { projected.push({ ...prior, replay: true }); continue; }
    const supplied = projectedMessages(item.protocol, turn.body);
    let canonical = supplied;
    if (item.protocol === 'responses' && turn.body.previous_response_id) {
      const base = responses.get(turn.body.previous_response_id);
      need(base, 'product_response_base_missing'); canonical = [...base, ...supplied];
    }
    const decision = productDecision(item.protocol, turn.value);
    const after = [...canonical, decision.type === 'final' ? message('assistant', decision.text ?? '') : decision];
    const messages = item.protocol === 'responses' && typeof turn.body.instructions === 'string' ? [message('system', turn.body.instructions), ...canonical] : canonical;
    const receipt = { messages, tools: productTools(item.protocol, turn.body), decision, canonical_after: after, replay: false, body: turn.body };
    operations.set(turn.operation_id, receipt); responses.set(turn.value.id, after); projected.push(receipt);
  }
  return projected;
}
