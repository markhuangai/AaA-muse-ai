import { cycle, cycleIDs, instructions } from '../product-protocol.mjs';
import { flowCases, liveCases, caseEvents } from '../product-report.mjs';
import { completeFixture, exportFixture } from '../qualification-fixtures.mjs';
import { hash } from '../qualification-evidence.mjs';

export const stamp = seconds => new Date(Date.UTC(2026, 10, 14) + seconds * 1000).toISOString();
export function chatValue(id, output, tool = false) {
  return { id: 'chatcmpl-' + id, created: 123, model: 'muse-pool-text', object: 'chat.completion', choices: [{ index: 0, logprobs: null, finish_reason: tool ? 'tool_calls' : 'stop', message: {
    role: 'assistant', refusal: null, content: tool ? null : output, ...(tool ? { tool_calls: [{ id: 'call-' + id, type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: output }) } }] } : {}),
  } }] };
}
export function responseValue(id, output, tool = false, fields = {}) {
  return { id: 'resp_' + id, object: 'response', model: 'muse-pool-text', created_at: 123, status: 'completed', error: null, incomplete_details: null, usage: null,
    instructions: null, previous_response_id: null, output: [tool ? { id: 'fc-' + id, type: 'function_call', status: 'completed', name: 'read_file', arguments: JSON.stringify({ path: output }), call_id: 'call-' + id } : {
      id: 'msg-' + id, type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: output, annotations: [] }],
    }], ...fields };
}

export function productFixture(live = false) {
  const report = { schema_version: 2, suite: 'release', evidence_kind: live ? 'live' : 'synthetic', run_id: 'product-fixture', started_at: stamp(0), finished_at: stamp(2000), outcome: 'passed', verdict: live ? 'pass' : 'inconclusive',
    source: { service_sha: 'a'.repeat(40), image_digest: 'sha256:' + 'b'.repeat(64), service_version: '0.1.0-rc.7', worker_version: '0.1.0-rc.7', worker_sha256: 'c'.repeat(64), installer_sha256: 'd'.repeat(64) },
    workers: ['a', 'b'].map(slot => ({ slot, worker_id: 'worker-' + slot, account_ref: 'account-' + slot, installed_version: '0.1.0-rc.7', installed_sha256: 'c'.repeat(64) })), cases: [], cycles: [], exports: [], observations: [],
    checkpoints: {} };
  report.status_receipt = { ready: true, build: { revision: report.source.service_sha, version: report.source.service_version, dirty: false, worker_package: { version: report.source.worker_version, sha256: report.source.worker_sha256 } } };
  const broker = [], workers = [];
  const observation = fields => ({ time: stamp(1000), observer: 'synthetic-native-observer', source_ref: 'synthetic-native-ref', ...fields });
  const addCase = (id, fields = {}) => report.cases.push({ id, outcome: 'passed', finished_at: stamp(900), ...fields });
  for (const [index, id] of [...cycleIDs, 'interleave-a', 'interleave-b', 'broker-wait'].entries()) {
    const slug = id.replaceAll('.', '-');
    const slot = id === 'broker-wait' ? 'a' : id.startsWith('interleave') ? id.at(-1) : id[0], protocol = id.includes('responses') || id === 'interleave-b' ? 'responses' : 'chat', stream = id.endsWith('sse');
    const item = cycle({ id, slot, protocol, stream, session: 'session-' + slug, fixture: { id: 'fixture-' + slug, path: 'client-' + id + '.txt', owner: 'client_driver', contents: 'random-' + id + '\r\nexact 😀\n', created_at: stamp(1) } });
    const make = protocol === 'chat' ? chatValue : responseValue;
    const first = make(slug + '-tool', item.fixture.path, true), final = make(slug + '-final', item.fixture.contents);
    item.call_id = 'call-' + slug + '-tool'; item.client_tool_executions = 1; item.started_at = stamp(200 + index * 10); item.finished_at = stamp(800 + index); item.outcome = 'passed';
    item.result_body = protocol === 'chat' ? { ...item.initial_body, messages: [...item.initial_body.messages, first.choices[0].message, { role: 'tool', tool_call_id: item.call_id, content: item.fixture.contents }] } : { model: 'muse-pool-text', instructions, input: [{ type: 'function_call_output', call_id: item.call_id, output: item.fixture.contents }], previous_response_id: first.id, stream, tools: item.initial_body.tools };
    const marker = 'affinity-' + id, later = make(slug + '-later', marker);
    const laterBody = protocol === 'chat' ? { ...item.initial_body, messages: [...item.result_body.messages, final.choices[0].message, { role: 'user', content: 'aaa-product:echo:' + marker }] } : { model: 'muse-pool-text', instructions, input: 'aaa-product:echo:' + marker, previous_response_id: final.id, stream };
    if (protocol === 'responses') { first.instructions = instructions; Object.assign(final, { instructions, previous_response_id: first.id }); Object.assign(later, { instructions, previous_response_id: final.id }); }
    item.followup = { body: laterBody, marker, value: later };
    const user = { type: 'message', role: 'user', text: 'aaa-product:tool:' + item.fixture.path };
    const call = { type: 'tool_call', call_id: item.call_id, name: 'read_file', arguments: { path: item.fixture.path } };
    const result = { type: 'tool_result', call_id: item.call_id, output: item.fixture.contents };
    const initial = [{ type: 'message', role: 'system', text: instructions }, user];
    const fn = protocol === 'chat' ? item.initial_body.tools[0].function : item.initial_body.tools[0];
    const definedTools = [{ name: fn.name, description: fn.description, parameters: fn.parameters }];
    item.turns = (id === 'broker-wait' ? [first, final, final] : [first, final, final, later]).map((value, turn) => {
      const operation = slug + '-' + (turn === 2 ? 1 : turn), job = 'job-' + operation;
      const receipt = { started_at: stamp(turn === 0 ? 300 + index : 500 + index * 5 + turn), finished_at: stamp(turn === 0 ? 301 + index : 501 + index * 5 + turn), session_id: item.session_id,
        value, body: turn === 0 ? item.initial_body : turn === 3 ? laterBody : { ...item.result_body, stream: turn === 2 ? !stream : stream }, request_id: 'request-' + slug + '-' + turn, operation_id: operation, job_id: job, worker_id: 'worker-' + slot, conversation_id: 'conversation-' + slug,
        connection_id: 'connection-worker-' + slot, connection_generation: 2, generation: 1 };
      const messages = turn === 0 ? initial : turn === 3 ? [...initial, call, result, { type: 'message', role: 'assistant', text: item.fixture.contents }, { type: 'message', role: 'user', text: 'aaa-product:echo:' + marker }] : [...initial, call, result];
      const tools = turn === 3 && protocol === 'responses' ? [] : definedTools;
      const decision = turn === 0 ? call : { type: 'final', text: turn === 3 ? marker : item.fixture.contents };
      if (turn !== 2) {
        const context = { kind: 'full', receipt_id: job, base_prefix: 0, history_count: messages.length, canonical_sha256: hash(JSON.stringify({ messages, tools })), messages, tools };
        const link = { operation_id: operation, job_id: job, worker_id: receipt.worker_id, conversation_id: receipt.conversation_id, connection_id: receipt.connection_id, connection_generation: receipt.connection_generation };
        broker.push({ ...link, time: receipt.finished_at, level: 'INFO', msg: 'decision.accepted', decision_type: decision.type, call_id: decision.call_id ?? '' });
        broker.push({ ...link, time: receipt.finished_at, level: 'DEBUG', msg: 'inference.decision', decision, tools, canonical_messages: [...messages, turn === 0 ? call : { type: 'message', role: 'assistant', text: decision.text }] });
        broker.push({ ...link, time: receipt.started_at, level: 'DEBUG', msg: 'inference.context', context });
        workers.push({ ...link, time: receipt.started_at, level: 'DEBUG', msg: 'worker.context', context, package_version: report.source.worker_version });
        workers.push({ time: receipt.started_at, level: 'INFO', msg: 'setup.wake_emitted', worker_id: receipt.worker_id, jobs: [{ job_id: job }] });
      }
      const boundary = { time: receipt.started_at, level: 'DEBUG', request_id: receipt.request_id, operation_id: operation, conversation_id: receipt.conversation_id, session_id: item.session_id };
      broker.push({ ...boundary, msg: protocol + '.input', input: receipt.body });
      broker.push({ ...boundary, msg: protocol + '.request_admitted', stream: receipt.body.stream });
      broker.push({ ...boundary, msg: protocol + '.accepted_decision', decision });
      report.observations.push(observation({ kind: 'model_turn', time: receipt.finished_at, case_id: id, worker_id: receipt.worker_id, job_id: job, native_conversation_id: 'native-' + slot, account_memory_observation: 'Synthetic fixture only.', effective_instructions: [initial[0]] }));
      return receipt;
    });
    report.cycles.push(item);
    if (cycleIDs.includes(id)) addCase(id, { operation_ids: item.turns.map(turn => turn.operation_id) });
  }
  const waiting = report.cycles.find(item => item.id === 'broker-wait'), [pending, continued] = waiting.turns;
  const beforeStatus = { ...report.status_receipt, instance_id: 'process-before' }, afterStatus = { ...report.status_receipt, instance_id: 'process-after' };
  report.checkpoints.broker = { cycle_id: waiting.id, pending_call_id: waiting.call_id, completed_request_id: continued.operation_id,
    prepared_at: stamp(400), resumed_at: stamp(480), before_instance: beforeStatus.instance_id, after_instance: afterStatus.instance_id, before_status: beforeStatus, after_status: afterStatus };
  for (const event of broker) event.instance_id = Date.parse(event.time) < Date.parse(stamp(450)) ? beforeStatus.instance_id : afterStatus.instance_id;
  for (const [time, status] of [[399, beforeStatus], [479, afterStatus]]) broker.push({ time: stamp(time), level: 'DEBUG', msg: 'request.exchange',
    route: '/api/v1/admin/status', role: 'management', status: 200, instance_id: status.instance_id, response: JSON.stringify(status) });
  broker.push({ time: stamp(451), level: 'INFO', msg: 'recovery.started', instance_id: afterStatus.instance_id },
    { time: stamp(452), level: 'INFO', msg: 'recovery.restored', instance_id: afterStatus.instance_id, operation_id: pending.operation_id, job_id: pending.job_id,
      conversation_id: pending.conversation_id, pending_call_id: waiting.call_id, pinned_worker_id: pending.worker_id });
  report.observations.push(observation({ kind: 'product_case', case_id: 'recovery.broker-tool-wait', time: stamp(450), worker_ids: [pending.worker_id], operation_ids: [pending.operation_id], expected_boundary: 'pending tool', observed_boundary: 'owner restarted service' }));
  addCase('recovery.broker-tool-wait', { operation_ids: [pending.operation_id, continued.operation_id], worker_ids: [pending.worker_id], session_id: waiting.session_id, conversation_id: pending.conversation_id, call_id: waiting.call_id });
  const original = report.cycles.find(item => item.id === 'a.responses.json'), replacement = structuredClone(original);
  Object.assign(replacement, { id: 'replacement', replay_source_case_id: original.id, measured_from_turn: original.turns.length, started_at: stamp(1000), finished_at: stamp(1002) });
  const body = { model: 'muse-pool-text', instructions, input: 'aaa-product:echo:replacement-final', previous_response_id: original.turns.at(-1).value.id, stream: false };
  const value = responseValue('replacement-final', 'replacement-final', false, { instructions, previous_response_id: body.previous_response_id });
  const turn = { started_at: stamp(1000), finished_at: stamp(1002), request_id: 'request-replacement', operation_id: 'operation-replacement', worker_id: 'worker-b', job_id: 'job-replacement',
    session_id: original.session_id, conversation_id: original.turns[0].conversation_id, connection_id: 'connection-worker-b', connection_generation: 2, generation: 1, body, value };
  replacement.turns.push(turn); replacement.followup = { body, value, marker: 'replacement-final' }; report.cycles.push(replacement);
  const priorContext = broker.find(event => event.msg === 'inference.decision' && event.job_id === original.turns.at(-1).job_id).canonical_messages;
  const messages = [...priorContext, { type: 'message', role: 'user', text: 'aaa-product:echo:replacement-final' }];
  const context = { kind: 'full', receipt_id: turn.job_id, base_prefix: 0, history_count: messages.length, canonical_sha256: hash(JSON.stringify({ messages, tools: [] })), messages, tools: [] };
  const link = { time: stamp(1001), level: 'DEBUG', request_id: turn.request_id, operation_id: turn.operation_id, worker_id: turn.worker_id, job_id: turn.job_id, conversation_id: turn.conversation_id, session_id: turn.session_id, connection_id: turn.connection_id, connection_generation: 2 };
  broker.push({ ...link, msg: 'inference.context', context }, { ...link, msg: 'decision.accepted', decision_type: 'final', call_id: '' },
    { ...link, msg: 'inference.decision', tools: [], decision: { type: 'final', text: 'replacement-final' }, canonical_messages: [...messages, { type: 'message', role: 'assistant', text: 'replacement-final' }] },
    { ...link, msg: 'responses.input', input: body }, { ...link, msg: 'responses.request_admitted' }, { ...link, msg: 'responses.accepted_decision', decision: { type: 'final', text: 'replacement-final' } });
  workers.push({ ...link, msg: 'worker.context', context }, { ...link, msg: 'setup.wake_emitted', jobs: [{ job_id: turn.job_id }] });
  report.observations.push(observation({ kind: 'model_turn', case_id: 'replacement', time: turn.finished_at, worker_id: turn.worker_id, job_id: turn.job_id, native_conversation_id: 'native-b', account_memory_observation: 'Synthetic replacement observation.', effective_instructions: [messages[0]] }));
  for (const id of live ? liveCases : flowCases) {
    if (report.cases.some(item => item.id === id)) continue;
    const slot = id.endsWith('.b') ? 'b' : 'a', operation = 'operation-' + id.replaceAll('.', '-');
    const fields = { operation_ids: [operation], worker_ids: ['worker-' + slot], request_id: 'request-' + id.replaceAll('.', '-') };
    if (id === 'recovery.tool-dedup') Object.assign(fields, { call_id: 'accepted-call', client_tool_executions: 1 });
    if (id === 'recovery.replacement-full-history') Object.assign(fields, { full_history: true, accepted_call_id: original.call_id, worker_ids: ['worker-a', 'worker-b'], operation_ids: [turn.operation_id] });
    if (id === 'recovery.stale-result') Object.assign(fields, { job_id: 'job-stale', worker_id: 'worker-a', generation: 1, connection_generation: 2 });
    if (id === 'recovery.hook') Object.assign(fields, { recovery_case_id: 'recovery.worker', operation_ids: ['operation-recovery-worker'] });
    for (const msg of caseEvents[id] ?? []) broker.push({ time: stamp(900), level: 'INFO', msg, operation_id: fields.operation_ids[0], request_id: fields.request_id, worker_id: 'worker-' + slot,
      ...(id === 'recovery.stale-result' ? { operation: 'decision', job_id: fields.job_id, reason: 'stale_assignment', evidence: { observed_generation: 1, observed_connection_generation: 2 } } : {}) });
    if (id.startsWith('readiness.') || id.startsWith('idle.')) {
      broker.push({ time: stamp(200), level: 'INFO', msg: 'decision.accepted', operation_id: operation, worker_id: 'worker-' + slot, job_id: 'job-' + id, request_id: fields.request_id });
      workers.push({ time: stamp(199), level: 'INFO', msg: 'setup.wake_emitted', worker_id: 'worker-' + slot, jobs: [{ job_id: 'job-' + id }] });
      report.observations.push(observation({ kind: 'quiet_window', case_id: id, started_at: stamp(10), ended_at: stamp(130), exclusive: true }));
    }
    report.observations.push(observation({ kind: 'product_case', case_id: id, worker_ids: fields.worker_ids, expected_boundary: 'synthetic expected', observed_boundary: 'synthetic observed' }));
    addCase(id, fields);
  }
  for (const worker of report.workers) {
    workers.push({ time: stamp(1), level: 'INFO', msg: 'setup.subscriber_started', worker_id: worker.worker_id, package_version: worker.installed_version });
    report.observations.push(observation({ kind: 'setup_ended', time: stamp(0), ...worker, setup_id: 'setup-' + worker.slot, hook_id: 'hook-' + worker.slot, hook_path: '/hooks/' + worker.slot,
      worker_version: worker.installed_version, worker_sha256: worker.installed_sha256, consumer_count: 1, interval_seconds: 5, state_mode: '0700', key_file_mode: '0600', actual_permissions: ['synthetic-shell'] }));
  }
  for (const [kind, action, generation, connection] of [['worker', 600, 2, 'connection-worker-a'], ['refresh', 700, 3, 'refresh-connection-worker-a']]) {
    const id = 'recovery.' + kind, actionObservation = report.observations.find(entry => entry.case_id === id && entry.kind === 'product_case');
    if (!actionObservation) continue;
    Object.assign(actionObservation, { action_at: stamp(action), hook_id: 'hook-a', hook_path: '/hooks/a', before_connection_id: generation === 2 ? 'old-worker-a' : 'connection-worker-a', before_connection_generation: generation - 1 });
    const link = { worker_id: 'worker-a', setup_id: 'setup-a', hook_id: 'hook-a', hook_path: '/hooks/a' };
    report.observations.push(observation({ ...link, kind: kind === 'refresh' ? 'refresh_reconnected' : 'worker_reconnected', time: stamp(action + 10), reinstalled: false, reenrolled: false, manual_message: false, consumer_count: 1, state_mode: '0700', key_file_mode: '0600', connection_id: connection, connection_generation: generation }));
    if (kind === 'refresh') {
      report.observations.push(observation({ ...link, kind: 'refresh_approval', time: stamp(action - 10), owner: true, destructive: false, scope: 'synthetic supported refresh' }));
      report.observations.push(observation({ ...link, kind: 'refresh_performed', time: stamp(action), scope: 'synthetic supported refresh' }));
    }
    workers.push({ ...link, time: stamp(action + 1), level: 'INFO', msg: 'setup.subscriber_started', pid: action });
    workers.push({ ...link, time: stamp(action + 2), level: 'INFO', msg: 'worker.supervision_started', pid: action, instance_id: 'supervisor-' + kind });
    workers.push({ ...link, time: stamp(action + 3), level: 'INFO', msg: 'worker.connected', instance_id: 'supervisor-' + kind, connection_id: connection, connection_generation: generation });
    workers.push({ ...link, time: stamp(action + 11), level: 'DEBUG', msg: 'worker.context', operation_id: 'operation-' + id.replaceAll('.', '-'), connection_id: connection, connection_generation: generation });
  }
  if (live) {
    report.native_cases = [];
    for (const slot of ['a', 'b']) {
      const originalNative = completeFixture(['readiness', 'trial-1']);
      const transform = value => {
        if (Array.isArray(value)) return value.map(transform);
        if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, transform(entry)]));
        if (typeof value !== 'string') return value;
        if (/^2026-01-01T/.test(value)) return new Date(Date.parse(value) + Date.parse(stamp(0)) - Date.UTC(2026, 0, 1)).toISOString();
        return value.replaceAll('worker-1', 'worker-' + slot).replaceAll('readiness-challenge-readiness', 'readiness-challenge-readiness-' + slot);
      };
      const native = transform(originalNative.report), references = transform(originalNative.evidence);
      for (const trial of native.cases) {
        const old = trial.id; trial.id = `baseline-${trial.kind === 'readiness' ? 'readiness' : 'tool'}-${slot}`;
        for (const entry of native.observations) if (entry.case_id === old) entry.case_id = trial.id;
        report.native_cases.push(trial);
      }
      const readiness = report.cases.find(item => item.id === 'readiness.' + slot), idle = report.cases.find(item => item.id === 'idle.' + slot);
      readiness.native_case_ids = native.cases.map(item => item.id); readiness.operation_ids = native.cases.map(item => item.experiment_id); delete readiness.request_id;
      idle.native_case_ids = [native.cases[0].id]; idle.operation_ids = [native.cases[0].experiment_id]; delete idle.request_id;
      report.observations.push(...native.observations.filter(entry => ['quiet_window', 'model_turn'].includes(entry.kind)));
      broker.push(...references.filter(ref => ref.source === 'broker').flatMap(ref => ref.events));
      workers.push(...references.filter(ref => ref.source === 'worker').flatMap(ref => ref.events));
    }
  }
  const evidence = [], files = new Map();
  for (const [source, events] of [['broker', broker], ['worker', workers]]) {
    const file = source + '-product.ndjson', raw = exportFixture(events), ref = { source, case_id: 'all', file, sha256: hash(raw) };
    report.exports.push(ref); files.set(file, raw); evidence.push({ ...ref, metadata: { complete: true, omissions: [] }, events });
  }
  return { report, evidence, files, broker, workers };
}
