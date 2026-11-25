import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectSource } from './source-inventory.mjs';
import { boundaryCases, flowCases, inspectCycle } from './product-report.mjs';
import { cycleIDs } from './product-protocol.mjs';
import { decodeExport, hash, identifier, need, same } from './qualification-evidence.mjs';

export const nativeFlowCases = flowCases.map(id => id === 'recovery.hook' ? 'recovery.native-checker' : id);

function hasCases(cases, required) {
  return Array.isArray(cases) && required.every(id => cases.filter(item => item.id === id && item.outcome === 'passed').length === 1);
}

export function validateNativeReport(report, readCapture, source) {
  need(report.schema_version === 1 && report.suite === 'native-pull-product' && report.evidence_kind === 'synthetic' && report.outcome === 'passed' && report.qualifies_live_muse === false, 'native_e2e_report_invalid');
  need(hasCases(report.cases, nativeFlowCases) && report.cleanup?.failures?.length === 0 && report.model_cleanup_failures?.length === 0, 'native_e2e_case_or_cleanup_incomplete');
  const { build, ready } = report.status_receipt;
  const pin = report.source;
  need(ready && same(source, pin.working_source) && build.revision === source.sha && pin.service_sha === source.sha && build.version === pin.worker_version &&
    build.worker_package?.version === pin.worker_version && build.worker_package?.sha256 === pin.worker_sha256, 'native_e2e_artifact_identity');
  const workers = report.workers;
  need(workers.length === 2 && new Set(workers.map(worker => worker.worker_id)).size === 2 && ['a', 'b'].every(slot => workers.some(worker => worker.slot === slot)) &&
    workers.every(worker => worker.installed_version === pin.worker_version && worker.installed_sha256 === pin.worker_sha256 && identifier(worker.checker_job_id)), 'native_e2e_worker_identity');
  const captures = report.exports.map(ref => {
    need(ref.file && basename(ref.file) === ref.file, 'native_e2e_capture_path');
    const raw = readCapture(ref.file);
    need(hash(raw) === ref.sha256, 'native_e2e_capture_digest');
    return { ...ref, events: decodeExport(raw).events };
  });
  const broker = captures.filter(ref => ref.source === 'broker');
  const peers = captures.filter(ref => ref.source === 'worker');
  need(broker.length === 1 && peers.length === 2 && workers.every(worker => peers.some(ref => ref.worker_id === worker.worker_id &&
    ref.events.some(event => event.msg === 'setup.hook_registration_verified' && event.hook?.id === worker.checker_job_id))), 'native_e2e_capture_identity');
  const server = broker[0].events, local = peers.flatMap(ref => ref.events);
  const opened = report.cycles.map(cycle => cycle.id);
  need(new Set(opened).size === opened.length && [...cycleIDs, 'restart', 'replacement', 'worker-probe', 'interleave-a', 'interleave-b'].every(id => opened.includes(id)), 'native_e2e_cycles_incomplete');
  const matchStart = (event, turn, context) => {
    const sameClaim = value => value.worker_id === turn.worker_id && value.job_id === turn.job_id && value.operation_id === turn.operation_id &&
      value.claim_id === turn.claim_id && value.launch_id === turn.launch_id && value.native_job_id === turn.native_job_id && value.generation === turn.generation;
    if (event.msg !== 'hook.work_started' || ![turn.claim_id, turn.launch_id, turn.native_job_id, event.request_id].every(identifier) || !sameClaim(event)) return false;
    const settled = local.find(value => value.msg === 'cron.work_settled' && sameClaim(value) && value.receipt_state === 'accepted');
    return identifier(event.pull_run_id) && identifier(settled?.settling_checker_run_id) && settled.settling_checker_run_id !== event.wake_invocation_id &&
      identifier(event.wake_invocation_id) && settled.native_run_id === 'event-hook-' + event.wake_invocation_id &&
      identifier(settled.request_id) &&
      local.some(value => value.msg === 'worker.http_exchange' && value.request_id === event.request_id && sameClaim(value) &&
        value.route === `/api/v1/worker/hook/jobs/${turn.job_id}/start` && value.http_status === 200 && same(value.output?.context, context)) &&
      server.some(value => value.msg === 'job.work_started' && value.request_id === event.request_id && sameClaim(value)) &&
      server.some(value => value.msg === 'job.work_settled' && value.request_id === settled.request_id && sameClaim(value) && value.native_run_id === settled.native_run_id);
  };
  for (const cycle of report.cycles) need(!inspectCycle(cycle, report, server, local, matchStart).length, 'native_e2e_client_or_claim_trace_incomplete');
  const stale = report.cases.find(item => item.id === 'recovery.stale-result');
  const crossing = report.cases.find(item => item.id === 'boundary.cross-worker');
  need(server.some(event => event.msg === 'lease.fenced' && event.reason === 'stale_assignment' && event.request_id === stale.request_id && event.job_id === stale.job_id) &&
    server.some(event => event.msg === 'lease.rejected' && event.request_id === crossing.request_id && event.job_id === crossing.job_id), 'native_e2e_fence_evidence_missing');
}

export function validateShards(receipts, { source, runID, attempt }) {
  need(receipts.length === 2 && ['flow', 'boundaries'].every(shard => receipts.filter(item => item.shard === shard).length === 1), 'missing_or_duplicate_e2e_shard');
  for (const receipt of receipts) {
    need(receipt.schema_version === 1 && receipt.suite === 'product-e2e' && receipt.outcome === 'passed' && receipt.evidence_kind === 'synthetic' && receipt.qualifies_live_muse === false, 'e2e_shard_failed_or_mislabeled');
    need(same(receipt.source, source) && receipt.run_id === runID && receipt.run_attempt === attempt, 'e2e_shard_source_or_run_mismatch');
    need(Number.isInteger(receipt.duration_ms) && receipt.duration_ms > 0 && receipt.duration_ms <= 1500000 && receipt.capture_complete === true, 'e2e_shard_evidence_or_budget_incomplete');
    const required = receipt.shard === 'flow' ? nativeFlowCases : boundaryCases;
    need(hasCases(receipt.cases, required), 'e2e_required_case_missing');
    if (receipt.shard === 'flow') need(/^sha256:[a-f0-9]{64}$/.test(receipt.image_digest ?? '') && /^[a-f0-9]{64}$/.test(receipt.installer_sha256 ?? '') && /^[a-f0-9]{64}$/.test(receipt.report_sha256 ?? '') && receipt.exports?.length >= 3 && receipt.cleanup?.failures?.length === 0, 'e2e_flow_identity_or_cleanup_incomplete');
    else need(receipt.images?.length === 2 && receipt.images.every(value => /^sha256:[a-f0-9]{64}$/.test(value)), 'e2e_boundary_image_identity_missing');
  }
  need(receipts[0].worker_version && receipts[0].worker_version === receipts[1].worker_version && /^[a-f0-9]{64}$/.test(receipts[0].worker_sha256 ?? '') && receipts[0].worker_sha256 === receipts[1].worker_sha256, 'e2e_paired_worker_mismatch');
  return { outcome: 'passed', evidence_kind: 'synthetic', qualifies_live_muse: false, source, shards: receipts.map(item => item.shard), cases: [...nativeFlowCases, ...boundaryCases] };
}

export function collectShards(directory, read = readFileSync, list = readdirSync, stat = statSync) {
  return list(directory).flatMap(name => {
    const path = join(directory, name);
    return stat(path).isDirectory() ? collectShards(path, read, list, stat) : /^(flow|boundaries)\.json$/.test(name) ? [JSON.parse(read(path, 'utf8'))] : [];
  });
}

export function main(args = process.argv.slice(2), { source = () => inspectSource().identity, env = process.env, collect = collectShards, output = line => process.stdout.write(line + '\n') } = {}) {
  try {
    if (args.length === 2 && args[0] === '--native-report') {
      const path = args[1];
      validateNativeReport(JSON.parse(readFileSync(path, 'utf8')), name => readFileSync(join(dirname(path), name), 'utf8'), source());
      return 0;
    }
    need(args.length === 1, 'e2e_receipt_directory_required');
    const result = validateShards(collect(args[0]), { source: source(), runID: env.GITHUB_RUN_ID ?? 'local', attempt: env.GITHUB_RUN_ATTEMPT ?? '1' });
    output(JSON.stringify({ level: 'INFO', msg: 'e2e.completed', ...result })); return 0;
  } catch (error) {
    output(JSON.stringify({ level: 'ERROR', msg: 'e2e.evidence_incomplete', cause: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'e2e_receipt_read_failed' })); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
