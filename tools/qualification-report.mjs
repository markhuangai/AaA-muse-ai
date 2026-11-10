import { identifier, instant, same } from './qualification-evidence.mjs';

export const requiredCases = ['readiness', 'trial-1', 'trial-2', 'trial-3', 'full', 'delta', 'interleave-a', 'interleave-b', 'replay', 'refresh'];
const time = value => Date.parse(value);
const provenance = entry => entry && instant(entry.time) && typeof entry.observer === 'string' && entry.observer.length > 0 && typeof entry.source_ref === 'string' && entry.source_ref.length > 0;
const overlap = (entry, start, end) => time(entry.time) >= time(start) && time(entry.time) <= time(end);
const linked = (event, item) => event.worker_id === item.worker_id && event.conversation_id === item.conversation_id && event.operation_id === item.experiment_id;

function inspectCase(item, report, evidence) {
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
    if (!native.some(entry => entry.job_id === turn.job_id && typeof entry.account_memory_observation === 'string' && entry.account_memory_observation.length && same(entry.effective_instructions, initialMessages.filter(message => ['system','developer'].includes(message.role))))) { if (!negative) miss('native_model_turn'); }
    if (context?.kind === 'full' && (context.base_prefix !== 0 || context.base_receipt_id || context.history_count !== context.messages?.length)) fail('full_context_contract');
    if (!['full','delta'].includes(context?.kind)) fail('unsupported_context_kind');
    if (context?.kind === 'delta') {
      const base = turns.find(previous => previous.job_id === context.base_receipt_id);
      if (!base || context.base_prefix !== base.context?.history_count || context.base_sha256 !== base.context?.canonical_sha256 || context.history_count !== context.base_prefix + context.messages?.length) fail('delta_base_contract');
      if (new Set(native.map(entry => entry.native_conversation_id)).size !== 1) miss('delta_native_base');
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

function inspectReport(report, evidence = []) {
  const errors = [], missing = [];
  if (report?.schema_version !== 1 || !['live','synthetic'].includes(report?.evidence_kind) || !identifier(report?.run_id) || !identifier(report?.worker_id) || !Array.isArray(report?.cases) || !Array.isArray(report?.observations) || !Array.isArray(report?.exports)) return { valid:false, verdict:'inconclusive', observed_result:'inconclusive', errors:['invalid_report_structure'], missing:[], cases:[] };
  if (!instant(report.started_at) || !instant(report.finished_at) || !instant(report.setup_ended_at)) missing.push('run_and_setup_timing');
  if (!/^[a-f0-9]{40}$/.test(report.source?.service_sha ?? '') || !/^sha256:[a-f0-9]{64}$/.test(report.source?.image_digest ?? '') || !report.source?.worker_version || !/^[a-f0-9]{64}$/.test(report.source?.worker_sha256 ?? '')) missing.push('exact_source_identity');
  if (report.status_receipt?.ready !== true || report.status_receipt?.build?.dirty !== false || report.status_receipt?.build?.revision !== report.source?.service_sha || report.status_receipt?.configuration?.worker_package?.version !== report.source?.worker_version || report.status_receipt?.configuration?.worker_package?.sha256 !== report.source?.worker_sha256) missing.push('authenticated_service_identity');
  if (report.settings?.idle_seconds !== 120 || report.settings?.turn_seconds !== 300) errors.push('qualification_limits_changed');
  const setup = report.observations.find(entry => entry.kind === 'setup_ended' && provenance(entry) && entry.time === report.setup_ended_at && entry.worker_id === report.worker_id && entry.consumer_count === 1 && entry.interval_seconds === 5 && identifier(entry.hook_id) && entry.state_mode === '0700' && entry.key_file_mode === '0600' && Array.isArray(entry.actual_permissions) && entry.actual_permissions.length);
  if (!setup) missing.push('observed_setup');
  for (const failure of report.evidence_import_failures ?? []) missing.push(`evidence_import_failed:${failure.source}:${failure.case_id}:${failure.cause}`);
  const prerequisitesComplete = missing.length === 0;
  if (report.observations.some(entry => !provenance(entry))) errors.push('invalid_observation_provenance');
  const ids = report.cases.map(item => item.id);
  if (new Set(ids).size !== ids.length || ids.some(id => !identifier(id))) errors.push('duplicate_or_invalid_case_id');
  if (report.cases.some(item => ![...requiredCases,'readiness-repeat'].includes(item.id) || item.kind !== (item.id.startsWith('readiness') ? 'readiness' : item.id === 'replay' ? 'replay' : 'tool'))) errors.push('incorrect_case_type');
  const readiness = report.cases.find(item => item.id === 'readiness'), repeat = report.cases.find(item => item.id === 'readiness-repeat');
  if (repeat && (!readiness || repeat.challenge === readiness.challenge || repeat.experiment_id === readiness.experiment_id || repeat.conversation_id === readiness.conversation_id || time(repeat.started_at) < time(readiness.finished_at))) errors.push('readiness_reproduction_not_independent');
  for (const id of requiredCases) if (!ids.includes(id)) missing.push(`required_case:${id}`);
  if (report.context_strategy?.baseline !== 'full' || !['accepted_candidate','rejected_candidate','inconclusive'].includes(report.context_strategy?.delta)) missing.push('context_strategy_decision');
  const results = report.cases.map(item => inspectCase(item, report, evidence));
  const fixtures = report.cases.filter(item => item.fixture).map(item => item.fixture);
  if (new Set(fixtures.map(item => item.contents)).size !== fixtures.length || new Set(fixtures.map(item => item.path)).size !== fixtures.length) errors.push('fixture_reuse');
  const calls = report.cases.flatMap(item => item.observed?.messages?.slice(item.request?.messages?.length ?? 0).filter(message => message.type === 'tool_call').map(message => `${item.conversation_id}:${message.call_id}`) ?? []);
  if (new Set(calls).size !== calls.length) errors.push('duplicate_call_id');
  const a = report.cases.find(item => item.id === 'interleave-a'), b = report.cases.find(item => item.id === 'interleave-b');
  if (a && b && (a.conversation_id === b.conversation_id || !(time(a.turns?.[0]?.finished_at) <= time(b.started_at) && time(b.turns?.[0]?.finished_at) <= time(a.turns?.[1]?.started_at) && time(a.finished_at) <= time(b.turns?.[1]?.started_at)))) errors.push('sessions_not_interleaved');
  const refresh = report.observations.filter(entry => provenance(entry));
  const approval = refresh.find(entry => entry.kind === 'refresh_approval' && entry.owner === true && entry.scope && entry.destructive === false);
  const performed = refresh.find(entry => entry.kind === 'refresh_performed' && entry.scope === approval?.scope && time(entry.time) > time(approval?.time));
  const recovered = refresh.find(entry => entry.kind === 'refresh_reconnected' && time(entry.time) > time(performed?.time) && entry.worker_id === report.worker_id && entry.hook_id === setup?.hook_id && entry.consumer_count === 1 && entry.state_mode === '0700' && entry.key_file_mode === '0600' && entry.reinstalled === false && entry.reenrolled === false && entry.manual_message === false);
  const refreshCase = report.cases.find(item => item.id === 'refresh');
  if (!approval || !performed || !recovered || !refreshCase || time(refreshCase.started_at) < time(recovered.time)) missing.push('supported_refresh_reconnection');
  const recoveryEvents = evidence.filter(ref => ref.source === 'worker' && !ref.error).flatMap(ref => ref.events ?? []);
  if (!recoveryEvents.some(event => event.msg === 'setup.subscriber_started' && event.worker_id === report.worker_id && time(event.time) > time(performed?.time) && time(event.time) <= time(recovered?.time))) missing.push('scheduled_subscriber_recovery');
  const delta = results.find(item => item.id === 'delta');
  if (delta?.failed.length && report.context_strategy?.delta !== 'rejected_candidate') errors.push('failed_delta_not_rejected');
  if (delta && !delta.failed.length && !delta.missing.length && report.context_strategy?.delta !== 'accepted_candidate') errors.push('successful_delta_not_recorded');
  const requiredResults = results.filter(item => item.id !== 'delta');
  const allMissing = [...missing,...results.flatMap(item => item.missing)];
  // A conclusive failure needs two complete observations of the same failed boundary.
  const failures = new Map();
  for (const item of requiredResults.filter(item => !item.missing.length)) for (const reason of item.failed.map(value => value.slice(value.indexOf(':')+1))) failures.set(reason,(failures.get(reason) ?? 0)+1);
  const reproducible = [...failures.values()].some(count => count >= 2);
  const observed = !errors.length && prerequisitesComplete && reproducible ? 'fail' : !errors.length && !allMissing.length && requiredResults.every(item => !item.failed.length) ? 'pass' : 'inconclusive';
  const verdict = report.evidence_kind === 'live' ? observed : 'inconclusive';
  if (report.verdict !== verdict) errors.push('claimed_verdict_not_supported');
  return {valid:errors.length === 0,verdict,observed_result:observed,errors,missing:[...new Set(allMissing)],cases:results};
}

export function validateReport(report, evidence = []) {
  try { return inspectReport(report,evidence); }
  catch { return {valid:false,verdict:'inconclusive',observed_result:'inconclusive',errors:['invalid_report_structure'],missing:[],cases:[]}; }
}
