import { identifier, instant, same } from './qualification-evidence.mjs';

const time = value => Date.parse(value);
const provenance = entry => entry && instant(entry.time) && typeof entry.observer === 'string' && entry.observer.length > 0 && typeof entry.source_ref === 'string' && entry.source_ref.length > 0;
const overlap = (entry, start, end) => time(entry.time) >= time(start) && time(entry.time) <= time(end);
const linked = (event, item) => event.worker_id === item.worker_id && event.conversation_id === item.conversation_id && event.operation_id === item.experiment_id;

export function inspectCase(item, report, evidence) {
  const missing = [], failed = [];
  const observations = report.observations ?? [];
  const miss = reason => missing.push(`${item.id}:${reason}`);
  const fail = reason => failed.push(`${item.id}:${reason}`);
  if (!instant(item.started_at) || !instant(item.finished_at)) miss('case_timing');
  if (item.worker_id !== report.worker_id || !identifier(item.experiment_id) || !identifier(item.conversation_id)) miss('case_identity');
  if (!Array.isArray(item.turns) || !item.turns.length || item.turns.some(turn => !identifier(turn.job_id) || !instant(turn.started_at) || !instant(turn.finished_at))) miss('turn_receipts');
  const quiet = observations.find(entry => entry.kind === 'quiet_window' && entry.case_id === item.id && provenance(entry) && instant(entry.started_at) && entry.ended_at === item.started_at && time(entry.ended_at) - time(entry.started_at) >= 120000 && entry.exclusive === true);
  if (!quiet) miss('observed_quiet_window');
  const start = quiet?.started_at ?? item.started_at;
  if (observations.some(entry => entry.kind === 'intervention' && overlap(entry, start, item.finished_at))) miss('intervened');
  const broker = evidence.filter(ref => ref.source === 'broker' && ref.case_id === item.id);
  const worker = evidence.filter(ref => ref.source === 'worker' && [item.id, 'all'].includes(ref.case_id));
  if (!broker.length || !worker.length || [...broker, ...worker].some(ref => ref.error)) miss('complete_broker_worker_exports');
  const b = broker.flatMap(ref => ref.events ?? []).filter(event => linked(event, item));
  const w = worker.flatMap(ref => ref.events ?? []);
  const contexts = b.filter(event => event.msg === 'inference.context');
  if (!b.some(event => event.msg === 'inference.exchange' && event.operation === 'read' && same(event.output, item.observed))) miss('authenticated_final_history');
  const turns = item.turns ?? [];
  const initialMessages = item.request?.messages ?? [];
  if (turns[0]?.context?.kind !== 'full' || !same(turns[0]?.context?.messages,initialMessages)) fail('initial_full_delivery');
  const native = observations.filter(entry => entry.kind === 'model_turn' && entry.case_id === item.id && provenance(entry) && identifier(entry.native_conversation_id));
  const nativeMatches = (entry,turn) => entry.job_id === turn.job_id && typeof entry.account_memory_observation === 'string' && entry.account_memory_observation.length && same(entry.effective_instructions, initialMessages.filter(message => ['system','developer'].includes(message.role)));
  for (const turn of turns) {
    if (time(turn.finished_at) - time(turn.started_at) >= 300000 || time(turn.finished_at) < time(turn.started_at)) fail('turn_deadline');
    const context = contexts.find(event => event.job_id === turn.job_id)?.context;
    if (!context || !same(context, turn.context)) miss('exact_context_receipt');
    if (!identifier(context?.receipt_id) || context.receipt_id !== turn.job_id || !/^[a-f0-9]{64}$/.test(context.canonical_sha256 ?? '') || !same(context.tools, item.request?.tools)) miss('context_identity_and_tools');
    const emission = w.find(event => event.msg === 'setup.wake_emitted' && event.jobs?.some(job => job.job_id === turn.job_id && job.conversation_id === item.conversation_id));
    const noModel = observations.find(entry => entry.kind === 'no_model_turn' && entry.case_id === item.id && entry.job_id === turn.job_id && provenance(entry) && entry.started_at === turn.started_at && entry.ended_at === turn.finished_at && entry.last_boundary === item.last_boundary);
    const negative = ['cancelled','interrupted'].includes(item.observed?.state) && noModel;
    if (noModel && item.observed?.state === 'completed') fail('contradictory_native_observation');
    if (!emission && !negative) miss('wake_emitted');
    if (!w.some(event => event.msg === 'worker.context' && event.job_id === turn.job_id && event.worker_id === item.worker_id && same(event.context, turn.context)) && !negative) miss('authenticated_model_context_read');
    if (!native.some(entry => nativeMatches(entry,turn)) && !negative) miss('native_model_turn');
    if (context?.kind === 'full' && (context.base_prefix !== 0 || context.base_receipt_id || context.history_count !== context.messages?.length)) fail('full_context_contract');
    if (!['full','delta'].includes(context?.kind)) fail('unsupported_context_kind');
    if (context?.kind === 'delta') {
      const base = turns.find(previous => previous.job_id === context.base_receipt_id);
      if (!base || context.base_prefix !== base.context?.history_count || context.base_sha256 !== base.context?.canonical_sha256 || context.history_count !== context.base_prefix + context.messages?.length) fail('delta_base_contract');
      if (!turns.every(previous => native.some(entry => nativeMatches(entry,previous)))) miss('delta_native_base');
      else if (new Set(native.filter(entry => turns.some(previous => nativeMatches(entry,previous))).map(entry => entry.native_conversation_id)).size !== 1) fail('delta_native_base');
    }
  }
  if (!item.initial || !item.observed || !same(item.initial.messages, item.request?.messages)) miss('canonical_input');
  const observed = item.observed;
  if (observed && !same(observed.messages?.slice(0, initialMessages.length), initialMessages)) fail('lost_or_duplicated_input');
  if (item.kind === 'readiness') {
    if (typeof item.challenge !== 'string' || !item.challenge.length || initialMessages.at(-1)?.text !== item.challenge || observed?.state !== 'completed' || observed.final_text !== item.challenge || turns.length !== 1) fail('readiness_answer');
  } else if (item.kind === 'replay') {
    const original = report.cases.find(previous => previous.id === 'full');
    const boundary = observations.find(entry => entry.kind === 'fresh_conversation' && provenance(entry) && instant(original?.finished_at) && time(entry.time) > time(original.finished_at) && time(entry.time) < time(item.started_at));
    const oldNative = observations.filter(entry => entry.kind === 'model_turn' && entry.case_id === 'full').map(entry => entry.native_conversation_id);
    if (!boundary || !native.length || native.some(entry => entry.native_conversation_id !== boundary.native_conversation_id || oldNative.includes(entry.native_conversation_id))) miss('fresh_native_conversation');
    if (!original || !same(initialMessages.slice(0, -1), original.observed?.messages) || !same(item.request?.tools,original.request?.tools) || !same(turns[0]?.context?.tools,original.request?.tools)) fail('canonical_replay');
    if (!same(item.expected,original?.expected) || !same(parseFinal(observed?.final_text), original?.expected) || observed?.state !== 'completed' || turns.length !== 1) fail('replay_answer');
  } else {
    const fixture = item.fixture;
    const appended = observed?.messages?.slice(initialMessages.length) ?? [];
    const [call, result, answer] = appended;
    if (call?.type === 'tool_call' && call.name === 'read_file' && same(call.arguments,{path:item.fixture?.path}) && !item.tool_result_request && item.observed?.state !== 'completed') miss('client_result_not_supplied');
    if (!fixture || fixture.owner !== 'client_driver' || !identifier(fixture.id) || typeof fixture.contents !== 'string' || !fixture.contents.length || time(fixture.created_at) < time(report.setup_ended_at)) miss('fresh_client_fixture');
    if (appended.length !== 3 || call?.type !== 'tool_call' || call.name !== 'read_file' || !identifier(call.call_id) || !same(call.arguments, { path: fixture?.path }) || result?.type !== 'tool_result' || result.call_id !== call.call_id || result.output !== fixture?.contents || answer?.role !== 'assistant' || answer.text !== observed?.final_text) fail('tool_linkage');
    if (!identifier(item.tool_result_request?.submission_id) || !same(item.tool_result_request, { protocol_version: 1, submission_id: item.tool_result_request?.submission_id, call_id: call?.call_id, output: fixture?.contents, ...(item.id === 'delta' ? {context_probe:{kind:'delta',base_receipt_id:turns[0]?.job_id}} : {}) })) fail('client_result_receipt');
    if (!item.session_marker || !initialMessages.some(message => message.role === 'system' && message.text?.includes(item.session_marker)) || !same(item.expected,{session:item.session_marker,value:fixture?.contents})) fail('expected_fixture_binding');
    if (!same(parseFinal(observed?.final_text), item.expected) || observed?.state !== 'completed' || turns.length !== 2) fail('final_exact_result');
    if (turns[1]?.context?.kind !== (item.id === 'delta' ? 'delta' : 'full')) fail('context_strategy');
    if (!same(turns[1]?.context?.messages, item.id === 'delta' ? [call,result] : [...initialMessages,call,result])) fail('exact_delivery');
  }
  if (observed?.state === 'completed') {
    for (const turn of turns) if (!b.some(event => event.msg === 'decision.accepted' && event.job_id === turn.job_id)) miss('accepted_decision');
  }
  return { id:item.id, missing:[...new Set(missing)], failed:[...new Set(failed)], last_boundary:item.last_boundary ?? 'not_observed' };
}

function parseFinal(value) { try { return JSON.parse(value); } catch { return undefined; } }
