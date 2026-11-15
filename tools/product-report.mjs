import { hash, identifier, instant, same } from './qualification-evidence.mjs';
import { cycleIDs, finalText, retryOutput } from './product-protocol.mjs';
import { validateCompletion } from './openai-conformance.mjs';
import { validateResponse } from './responses-conformance.mjs';
import { productTranscript } from './product-transcript.mjs';
import { brokerBoundary, recoveryBoundary } from './product-recovery.mjs';
import { inspectCase } from './qualification-case.mjs';

export const flowCases = ['portal.login', 'portal.enrollment.a', 'portal.enrollment.b', 'readiness.a', 'readiness.b', 'idle.a', 'idle.b', ...cycleIDs,
  'sessions.interleaved', 'sessions.affinity', 'sessions.isolation', 'boundary.cross-client', 'boundary.cross-worker',
  'portal.rename.a', 'portal.rename.b', 'portal.history', 'recovery.broker-tool-wait', 'recovery.worker', 'recovery.hook',
  'recovery.replacement-full-history', 'recovery.stale-result', 'recovery.tool-dedup', 'diagnostics.log-only', 'portal.revoke.a', 'portal.revoke.b'];
export const boundaryCases = ['failure.partial-output', 'failure.unresolved-tool'];
export const liveCases = [...flowCases, ...boundaryCases, 'recovery.refresh'];
export const caseEvents = {
  'portal.login': ['portal.session_created'], 'portal.enrollment.a': ['setup.prompt_created'], 'portal.enrollment.b': ['setup.prompt_created'],
  'portal.rename.a': ['worker.renamed'], 'portal.rename.b': ['worker.renamed'], 'portal.history': ['history.query_completed'],
  'portal.revoke.a': ['worker.revoked'], 'portal.revoke.b': ['worker.revoked'], 'boundary.cross-client': ['responses.reference_rejected'],
  'boundary.cross-worker': ['lease.rejected'], 'recovery.stale-result': ['lease.fenced'],
  'recovery.replacement-full-history': ['dispatch.reassigned'], 'recovery.broker-tool-wait': ['recovery.restored'],
  'failure.partial-output': ['request.output_interrupted', 'responses.stream_terminated', 'chat.stream_terminated'],
  'failure.unresolved-tool': ['recovery.uncertain'], 'diagnostics.log-only': ['lease.fenced', 'lease.rejected'],
};
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const provenance = value => instant(value?.time) && typeof value.observer === 'string' && value.observer && typeof value.source_ref === 'string' && value.source_ref;
const eventsOf = (evidence, source) => [...new Map(evidence.filter(ref => ref.source === source && !ref.error).flatMap(ref => ref.events ?? []).map(event => [hash(JSON.stringify(event)), event])).values()];

function inspectCycle(item, report, broker, workers) {
  const issues = [], miss = code => issues.push(`${item.id}:${code}`);
  const worker = report.workers.find(value => value.slot === item.slot);
  if (!worker || !identifier(item.session_id) || item.fixture?.owner !== 'client_driver' || !item.fixture.contents || !item.fixture.path || !instant(item.fixture.created_at)) miss('client_fixture_or_identity');
  if (!instant(item.started_at) || !instant(item.finished_at) || item.client_tool_executions !== 1 || !identifier(item.call_id) || item.outcome !== 'passed' || item.turns?.length < 3) miss('incomplete_cycle');
  const turns = item.turns ?? [], [first, final, replay] = turns;
  let transcript = [];
  try { transcript = productTranscript(item); } catch { miss('unprojectable_client_transcript'); }
  for (const [index, turn] of turns.entries()) {
    if (!identifier(turn.request_id) || !identifier(turn.operation_id) || !identifier(turn.job_id) || turn.session_id !== item.session_id || !identifier(turn.conversation_id) || !instant(turn.started_at) || !instant(turn.finished_at) || Date.parse(turn.finished_at) - Date.parse(turn.started_at) >= 300000) miss('turn_identity_or_deadline');
    const accepted = broker.filter(event => event.msg === 'decision.accepted' && event.operation_id === turn.operation_id && event.job_id === turn.job_id);
    const context = broker.find(event => event.msg === 'inference.context' && event.operation_id === turn.operation_id && event.job_id === turn.job_id);
    if (accepted.length !== 1 || context?.context?.kind !== 'full' || context.worker_id !== turn.worker_id || (item.id !== 'replacement' && turn.worker_id !== worker?.worker_id)) miss('accepted_full_context');
    const expected = transcript[index], delivered = context?.context;
    if (!expected || !same(delivered?.messages, expected.messages) || !same(delivered?.tools, expected.tools) || delivered.receipt_id !== turn.job_id || delivered.base_prefix !== 0 || delivered.history_count !== expected.messages.length || !/^[a-f0-9]{64}$/.test(delivered.canonical_sha256 ?? '')) miss('authenticated_client_history_and_tools');
    const decision = broker.find(event => event.msg === 'inference.decision' && event.operation_id === turn.operation_id && event.job_id === turn.job_id);
    const appended = expected?.decision.type === 'final' ? { type: 'message', role: 'assistant', ...(expected.decision.text ? { text: expected.decision.text } : {}) } : expected?.decision;
    if (!expected || !same(decision?.decision, expected.decision) || !same(decision?.tools, expected.tools) || !same(decision?.canonical_messages, [...expected.messages, appended]) || accepted[0]?.decision_type !== expected.decision.type || (accepted[0]?.call_id ?? '') !== (expected.decision.call_id ?? '')) miss('authenticated_accepted_decision');
    const boundary = broker.find(event => event.msg === item.protocol + '.input' && event.request_id === turn.request_id);
    const encoded = broker.find(event => event.msg === item.protocol + '.accepted_decision' && event.request_id === turn.request_id);
    const admission = broker.find(event => event.msg === item.protocol + '.request_admitted' && event.request_id === turn.request_id);
    if (!boundary || !same(boundary.input, turn.body) || !expected || !same(encoded?.decision, expected.decision) || admission?.operation_id !== turn.operation_id || admission?.session_id !== item.session_id || admission?.conversation_id !== turn.conversation_id) miss('authenticated_protocol_boundary');
    if (!workers.some(event => event.msg === 'worker.context' && event.worker_id === turn.worker_id && event.job_id === turn.job_id && same(event.context, context?.context))) miss('authenticated_worker_context');
    if (report.evidence_kind === 'live') {
      const observedCaseID = index < (item.measured_from_turn ?? 0) ? item.replay_source_case_id : item.id;
      const observation = report.observations.find(entry => entry.kind === 'model_turn' && entry.case_id === observedCaseID && entry.worker_id === turn.worker_id && entry.job_id === turn.job_id && provenance(entry) && identifier(entry.native_conversation_id) && typeof entry.account_memory_observation === 'string' && entry.account_memory_observation && Array.isArray(entry.effective_instructions));
      if (!observation || !same(observation.effective_instructions, expected?.messages.filter(message => ['system', 'developer'].includes(message.role)))) miss('native_model_turn');
      if (!workers.some(event => event.msg === 'setup.wake_emitted' && event.worker_id === turn.worker_id && event.jobs?.some(job => job.job_id === turn.job_id))) miss('native_hook_wake');
    }
  }
  try {
    const validate = item.protocol === 'chat' ? validateCompletion : validateResponse;
    for (const turn of turns) validate(turn.value);
    const proposed = item.protocol === 'chat' ? first.value.choices[0].message.tool_calls[0] : first.value.output[0];
    const fn = item.protocol === 'chat' ? proposed.function : proposed;
    if (fn.name !== 'read_file' || !same(JSON.parse(fn.arguments), { path: item.fixture.path }) || (proposed.call_id ?? proposed.id) !== item.call_id) miss('client_tool_linkage');
    if (finalText(item.protocol, final.value) !== item.fixture.contents || replay.value.id !== final.value.id || !same(retryOutput(item.protocol, replay.value), retryOutput(item.protocol, final.value)) || replay.operation_id !== final.operation_id || first.operation_id === final.operation_id) miss('exact_result_and_dedup');
    const result = item.protocol === 'chat' ? item.result_body.messages.at(-1) : item.result_body.input[0];
    if ((result.call_id ?? result.tool_call_id) !== item.call_id || (result.output ?? result.content) !== item.fixture.contents || JSON.stringify(item.initial_body).includes(item.fixture.contents)) miss('client_result_provenance');
  } catch { miss('protocol_receipts'); }
  if (new Set(turns.map(turn => turn.conversation_id)).size !== 1) miss('conversation_changed');
  const measured = turns.slice(item.measured_from_turn ?? 0);
  const starts = [Date.parse(item.started_at), ...measured.map(turn => Date.parse(turn.started_at))].filter(Number.isFinite);
  const ends = [Date.parse(item.finished_at), ...measured.map(turn => Date.parse(turn.finished_at))].filter(Number.isFinite);
  if (starts.length && ends.length && report.observations.some(entry => entry.kind === 'intervention' && Date.parse(entry.time) >= Math.min(...starts) && Date.parse(entry.time) <= Math.max(...ends))) miss('intervened');
  return [...new Set(issues)];
}

function inspectProductReport(report, evidence = []) {
  const errors = [], missing = [], failures = [];
  const invalid = code => errors.push(code), miss = code => missing.push(code);
  if (report?.schema_version !== 2 || report.suite !== 'release' || !['live', 'synthetic'].includes(report.evidence_kind) || !identifier(report.run_id) || !Array.isArray(report.cases) || !Array.isArray(report.cycles) || !Array.isArray(report.workers) || !Array.isArray(report.observations) || !Array.isArray(report.exports)) return { valid: false, verdict: 'inconclusive', observed_result: 'inconclusive', errors: ['invalid_product_report'], missing: [], cases: [] };
  const source = report.source ?? {}, build = report.status_receipt?.build;
  if (!/^[a-f0-9]{40}$/.test(source.service_sha ?? '') || !/^sha256:[a-f0-9]{64}$/.test(source.image_digest ?? '') || !digest(source.worker_sha256) || !digest(source.installer_sha256) || !source.service_version || source.service_version !== source.worker_version) miss('exact_paired_artifact_identity');
  if (!report.status_receipt?.ready || build?.revision !== source.service_sha || build?.version !== source.service_version || build?.worker_package?.version !== source.worker_version || build?.worker_package?.sha256 !== source.worker_sha256 || (report.evidence_kind === 'live' && build.dirty !== false)) miss('authenticated_paired_service');
  if (!instant(report.started_at) || !instant(report.finished_at) || Date.parse(report.finished_at) < Date.parse(report.started_at)) invalid('invalid_run_timing');
  if (report.workers.length !== 2 || ['a', 'b'].some(slot => report.workers.filter(worker => worker.slot === slot).length !== 1) || new Set(report.workers.map(worker => worker.worker_id)).size !== 2 || new Set(report.workers.map(worker => worker.account_ref)).size !== 2) miss('two_isolated_workers');
  for (const worker of report.workers) if (!identifier(worker.worker_id) || !worker.account_ref || !worker.installed_version || !digest(worker.installed_sha256)) miss(`installed_worker_identity:${worker.slot}`);
  const broker = eventsOf(evidence, 'broker'), workerEvents = eventsOf(evidence, 'worker');
  for (const ref of report.exports) if (!evidence.some(value => same(ref, Object.fromEntries(Object.entries(value).filter(([key]) => !['events', 'metadata', 'error'].includes(key)))))) miss(`unread_export:${ref.file}`);
  if (!evidence.some(ref => ref.source === 'broker' && !ref.error && ref.events?.length) || evidence.some(ref => ref.error || ref.metadata?.complete !== true || ref.metadata.omissions?.length)) miss('complete_broker_exports');
  for (const worker of report.workers) if (!evidence.some(ref => ref.source === 'worker' && !ref.error && ref.events?.some(event => event.worker_id === worker.worker_id && event.package_version === worker.installed_version))) miss(`complete_installed_worker_export:${worker.slot}`);
  const required = report.evidence_kind === 'live' ? liveCases : flowCases;
  const ids = report.cases.map(item => item.id);
  if (new Set(ids).size !== ids.length || ids.some(id => ![...liveCases, 'failure.claimed-inference'].includes(id))) invalid('duplicate_or_unknown_case');
  const results = [];
  for (const id of required) {
    const item = report.cases.find(value => value.id === id), gaps = [];
    if (!item) { miss(`required_case:${id}`); results.push({ id, outcome: 'missing' }); continue; }
    if (item.outcome !== 'passed') { failures.push(id); gaps.push(`${id}:${item.outcome ?? 'missing_outcome'}`); }
    const scoped = broker.filter(event => (!item.request_id || event.request_id === item.request_id) && (!item.operation_ids?.length || item.operation_ids.includes(event.operation_id)));
    if (caseEvents[id] && !scoped.some(event => caseEvents[id].includes(event.msg))) gaps.push(`${id}:causal_broker_evidence`);
    if (id.startsWith('readiness.') || id.startsWith('idle.')) {
      const worker = report.workers.find(value => value.slot === id.at(-1));
      const jobs = scoped.filter(event => event.msg === 'decision.accepted' && event.worker_id === worker?.worker_id).map(event => event.job_id);
      if (!jobs.length || !workerEvents.some(event => event.msg === 'setup.wake_emitted' && event.worker_id === worker?.worker_id && event.jobs?.some(job => jobs.includes(job.job_id)))) gaps.push(`${id}:independent_decision_and_wake`);
      if (report.evidence_kind === 'live' && !report.observations.some(entry => entry.kind === 'quiet_window' && [id, ...(item.native_case_ids ?? [])].includes(entry.case_id) && entry.exclusive === true && provenance(entry) && Date.parse(entry.ended_at) - Date.parse(entry.started_at) >= 120000)) gaps.push(`${id}:observed_idle_window`);
      if (report.evidence_kind === 'live') {
        const native = (item.native_case_ids ?? []).map(id => report.native_cases?.find(value => value.id === id));
        if (!native.length || native.some(value => !value) || (id.startsWith('readiness.') && (!native.some(value => value?.kind === 'readiness') || !native.some(value => value?.kind === 'tool')))) gaps.push(`${id}:native_trial_receipts`);
        for (const trial of native.filter(Boolean)) {
          const setup = report.observations.find(entry => entry.kind === 'setup_ended' && entry.worker_id === worker?.worker_id);
          const references = evidence.map(ref => ref.source === 'broker' && ref.case_id === 'all' ? { ...ref, case_id: trial.id } : ref);
          const result = inspectCase(trial, { ...report, worker_id: worker?.worker_id, setup_ended_at: setup?.time }, references);
          if (result.missing.length || result.failed.length) gaps.push(`${id}:authenticated_native_trial`);
        }
      }
    }
    if (['recovery.worker', 'recovery.hook', 'recovery.refresh'].includes(id)) {
      const recoveryID = id === 'recovery.hook' ? item.recovery_case_id : id;
      try { recoveryBoundary(report, recoveryID, workerEvents, { item }); }
      catch (error) { gaps.push(`${id}:${error.message}`); }
    }
    if (id === 'recovery.broker-tool-wait') {
      try { brokerBoundary(report, broker, item); }
      catch (error) { gaps.push(`${id}:${error.message}`); }
    }
    if (id === 'recovery.stale-result' && (!identifier(item.request_id) || !identifier(item.job_id) || !item.generation || !item.connection_generation || !identifier(item.worker_id) || !scoped.some(event => event.msg === 'lease.fenced' && event.operation === 'decision' && ['stale_assignment', 'stale_connection'].includes(event.reason) && event.job_id === item.job_id && event.worker_id === item.worker_id && event.evidence?.observed_generation === item.generation && event.evidence?.observed_connection_generation === item.connection_generation))) gaps.push(`${id}:correlated_stale_decision_fence`);
    if (id === 'recovery.tool-dedup' && (item.client_tool_executions !== 1 || !identifier(item.call_id))) gaps.push(`${id}:one_client_execution`);
    if (id === 'recovery.replacement-full-history' && (!item.full_history || !identifier(item.accepted_call_id) || item.worker_ids?.length !== 2)) gaps.push(`${id}:full_replay_and_accepted_call`);
    if (report.evidence_kind === 'live' && ['boundary.cross-worker', 'recovery.stale-result', 'recovery.worker', 'recovery.refresh', 'failure.partial-output', 'failure.unresolved-tool'].includes(id) && !report.observations.some(entry => entry.kind === 'product_case' && entry.case_id === id && provenance(entry) && entry.worker_ids?.every(worker => report.workers.some(value => value.worker_id === worker)) && entry.expected_boundary && entry.observed_boundary)) gaps.push(`${id}:native_action_observation`);
    missing.push(...gaps); results.push({ id, outcome: gaps.length ? 'incomplete' : item.outcome });
  }
  const cycleIds = report.cycles.map(item => item.id);
  if (new Set(cycleIds).size !== cycleIds.length) invalid('duplicate_cycle_identity');
  for (const id of cycleIDs) if (!cycleIds.includes(id)) miss(`required_cycle:${id}`);
  for (const item of report.cycles) missing.push(...inspectCycle(item, report, broker, workerEvents));
  for (const item of report.cycles) {
    if (item.id === 'replacement') {
      const original = report.cycles.find(value => value.id === item.replay_source_case_id);
      if (!original || item.measured_from_turn !== original.turns.length || !same(item.turns.slice(0, item.measured_from_turn), original.turns) || item.turns.length !== original.turns.length + 1 || item.turns.at(-1).worker_id === original.turns.at(-1).worker_id) miss('replacement_source_and_measured_turn');
    } else if (item.measured_from_turn) invalid('unsupported_measured_turn_offset');
  }
  const replacement = report.cycles.find(item => item.id === 'replacement');
  const replayCase = report.cases.find(item => item.id === 'recovery.replacement-full-history');
  if (!replacement || replayCase?.accepted_call_id !== replacement.call_id || !replayCase?.operation_ids?.includes(replacement.turns.at(-1)?.operation_id)) miss('authenticated_replacement_cycle');
  for (const id of cycleIDs) {
    const item = report.cycles.find(value => value.id === id);
    if (!item) continue;
    const [slot, protocol, format] = id.split('.');
    if (item.slot !== slot || item.protocol !== protocol || item.stream !== (format === 'sse')) invalid(`cycle_protocol_identity:${id}`);
    if (item.turns.length !== 4 || !item.followup?.marker || finalText(protocol, item.turns.at(-1)?.value) !== item.followup.marker) miss(`${id}:affinity_after_final_answer`);
  }
  const a = report.cycles.find(item => item.id === 'interleave-a'), b = report.cycles.find(item => item.id === 'interleave-b');
  if (!a || !b || a.session_id === b.session_id || a.turns[0]?.conversation_id === b.turns[0]?.conversation_id || a.turns[0]?.worker_id === b.turns[0]?.worker_id || Math.max(Date.parse(a.turns[0]?.finished_at), Date.parse(b.turns[0]?.finished_at)) > Math.min(Date.parse(a.turns[1]?.started_at), Date.parse(b.turns[1]?.started_at))) miss('concurrent_isolated_session_receipts');
  const fixtures = [...new Map(report.cycles.map(item => [item.session_id, item.fixture])).values()];
  if (new Set(fixtures.map(item => item?.contents)).size !== fixtures.length || new Set(fixtures.map(item => item?.path)).size !== fixtures.length) invalid('reused_client_fixture');
  if (report.observations.some(entry => !provenance(entry))) invalid('invalid_observation_provenance');
  if (report.evidence_kind === 'live') {
    for (const worker of report.workers) if (!report.observations.some(entry => entry.kind === 'setup_ended' && entry.worker_id === worker.worker_id && entry.account_ref === worker.account_ref && entry.worker_version === worker.installed_version && entry.worker_sha256 === worker.installed_sha256 && entry.consumer_count === 1 && entry.interval_seconds === 5 && entry.state_mode === '0700' && entry.key_file_mode === '0600' && entry.actual_permissions?.length && provenance(entry))) miss(`native_setup:${worker.slot}`);
    const approval = report.observations.find(entry => entry.kind === 'refresh_approval' && provenance(entry) && entry.owner === true && entry.destructive === false && entry.scope);
    const performed = report.observations.find(entry => entry.kind === 'refresh_performed' && provenance(entry) && entry.scope === approval?.scope && Date.parse(entry.time) > Date.parse(approval?.time));
    if (!performed) miss('owner_approved_supported_refresh');
  }
  for (const failure of report.evidence_import_failures ?? []) miss(`evidence_import_failed:${failure.source}:${failure.case_id}:${failure.cause}`);
  const observed = !errors.length && !missing.length && !failures.length && report.outcome === 'passed' ? 'pass' : failures.length ? 'fail' : 'inconclusive';
  const verdict = report.evidence_kind === 'live' ? observed : 'inconclusive';
  if (report.verdict !== verdict) invalid('claimed_verdict_not_supported');
  return { valid: errors.length === 0, verdict, observed_result: observed, errors, missing: [...new Set(missing)], cases: results };
}

export function validateProductReport(report, evidence = []) {
  try { return inspectProductReport(report, evidence); }
  catch { return { valid: false, verdict: 'inconclusive', observed_result: 'inconclusive', errors: ['invalid_product_report'], missing: [], cases: [] }; }
}
