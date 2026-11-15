import { identifier, instant, same } from './qualification-evidence.mjs';
import { validateProductReport } from './product-report.mjs';
import { inspectCase } from './qualification-case.mjs';
export { inspectCase } from './qualification-case.mjs';

export const requiredCases = ['readiness', 'trial-1', 'trial-2', 'trial-3', 'full', 'delta', 'interleave-a', 'interleave-b', 'replay', 'refresh'];
const time = value => Date.parse(value);
const provenance = entry => entry && instant(entry.time) && typeof entry.observer === 'string' && entry.observer.length > 0 && typeof entry.source_ref === 'string' && entry.source_ref.length > 0;

function inspectReport(report, evidence = []) {
  const errors = [], missing = [];
  if (report?.schema_version !== 1 || !['live','synthetic'].includes(report?.evidence_kind) || !identifier(report?.run_id) || !identifier(report?.worker_id) || !Array.isArray(report?.cases) || !Array.isArray(report?.observations) || !Array.isArray(report?.exports)) return { valid:false, verdict:'inconclusive', observed_result:'inconclusive', errors:['invalid_report_structure'], missing:[], cases:[] };
  if (!instant(report.started_at) || !instant(report.finished_at) || !instant(report.setup_ended_at)) missing.push('run_and_setup_timing');
  if (!/^[a-f0-9]{40}$/.test(report.source?.service_sha ?? '') || !/^sha256:[a-f0-9]{64}$/.test(report.source?.image_digest ?? '') || !report.source?.worker_version || !/^[a-f0-9]{64}$/.test(report.source?.worker_sha256 ?? '')) missing.push('exact_source_identity');
  const bundled = report.status_receipt?.build?.worker_package;
  const pin = bundled ?? report.status_receipt?.configuration?.worker_package;
  const separateInstaller = bundled || report.source?.installer_version !== undefined;
  if (report.status_receipt?.ready !== true || report.status_receipt?.build?.dirty !== false || report.status_receipt?.build?.revision !== report.source?.service_sha || pin?.version !== (separateInstaller ? report.source?.installer_version : report.source?.worker_version) || pin?.sha256 !== (separateInstaller ? report.source?.installer_sha256 : report.source?.worker_sha256)) missing.push('authenticated_service_identity');
  if (report.settings?.idle_seconds !== 120 || report.settings?.turn_seconds !== 300) errors.push('qualification_limits_changed');
  const setup = report.observations.find(entry => entry.kind === 'setup_ended' && provenance(entry) && entry.time === report.setup_ended_at && entry.worker_id === report.worker_id && entry.consumer_count === 1 && entry.interval_seconds === 5 && identifier(entry.hook_id) && entry.state_mode === '0700' && entry.key_file_mode === '0600' && Array.isArray(entry.actual_permissions) && entry.actual_permissions.length);
  if (!setup) missing.push('observed_setup');
  if (separateInstaller && (setup?.worker_version !== report.source?.worker_version || setup?.worker_sha256 !== report.source?.worker_sha256 || !evidence.filter(ref => ref.source === 'worker' && !ref.error).flatMap(ref => ref.events ?? []).some(event => event.package_version === report.source?.worker_version))) missing.push('observed_installed_worker_identity');
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
  try { return report?.schema_version === 2 ? validateProductReport(report,evidence) : inspectReport(report,evidence); }
  catch { return {valid:false,verdict:'inconclusive',observed_result:'inconclusive',errors:['invalid_report_structure'],missing:[],cases:[]}; }
}
