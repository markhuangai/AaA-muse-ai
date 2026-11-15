import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { inspectSource } from './source-inventory.mjs';
import { boundaryCases, flowCases } from './product-report.mjs';
import { need, same } from './qualification-evidence.mjs';

export function validateShards(receipts, { source, runID, attempt }) {
  need(receipts.length === 2 && ['flow', 'boundaries'].every(shard => receipts.filter(item => item.shard === shard).length === 1), 'missing_or_duplicate_e2e_shard');
  for (const receipt of receipts) {
    need(receipt.schema_version === 1 && receipt.suite === 'product-e2e' && receipt.outcome === 'passed' && receipt.evidence_kind === 'synthetic' && receipt.qualifies_live_muse === false, 'e2e_shard_failed_or_mislabeled');
    need(same(receipt.source, source) && receipt.run_id === runID && receipt.run_attempt === attempt, 'e2e_shard_source_or_run_mismatch');
    need(Number.isInteger(receipt.duration_ms) && receipt.duration_ms > 0 && receipt.duration_ms <= 1500000 && receipt.capture_complete === true, 'e2e_shard_evidence_or_budget_incomplete');
    const required = receipt.shard === 'flow' ? flowCases : boundaryCases;
    need(Array.isArray(receipt.cases) && required.every(id => receipt.cases.filter(item => item.id === id && item.outcome === 'passed').length === 1), 'e2e_required_case_missing');
    if (receipt.shard === 'flow') need(/^sha256:[a-f0-9]{64}$/.test(receipt.image_digest ?? '') && /^[a-f0-9]{64}$/.test(receipt.installer_sha256 ?? '') && /^[a-f0-9]{64}$/.test(receipt.report_sha256 ?? '') && receipt.exports?.length >= 3 && receipt.cleanup?.failures?.length === 0, 'e2e_flow_identity_or_cleanup_incomplete');
    else need(receipt.images?.length === 2 && receipt.images.every(value => /^sha256:[a-f0-9]{64}$/.test(value)), 'e2e_boundary_image_identity_missing');
  }
  need(receipts[0].worker_version && receipts[0].worker_version === receipts[1].worker_version && /^[a-f0-9]{64}$/.test(receipts[0].worker_sha256 ?? '') && receipts[0].worker_sha256 === receipts[1].worker_sha256, 'e2e_paired_worker_mismatch');
  return { outcome: 'passed', evidence_kind: 'synthetic', qualifies_live_muse: false, source, shards: receipts.map(item => item.shard), cases: [...flowCases, ...boundaryCases] };
}

export function collectShards(directory, read = readFileSync, list = readdirSync, stat = statSync) {
  return list(directory).flatMap(name => {
    const path = join(directory, name);
    return stat(path).isDirectory() ? collectShards(path, read, list, stat) : /^(flow|boundaries)\.json$/.test(name) ? [JSON.parse(read(path, 'utf8'))] : [];
  });
}

export function main(args = process.argv.slice(2), { source = () => inspectSource().identity, env = process.env, collect = collectShards, output = line => process.stdout.write(line + '\n') } = {}) {
  try {
    need(args.length === 1, 'e2e_receipt_directory_required');
    const result = validateShards(collect(args[0]), { source: source(), runID: env.GITHUB_RUN_ID ?? 'local', attempt: env.GITHUB_RUN_ATTEMPT ?? '1' });
    output(JSON.stringify({ level: 'INFO', msg: 'e2e.completed', ...result })); return 0;
  } catch (error) {
    output(JSON.stringify({ level: 'ERROR', msg: 'e2e.evidence_incomplete', cause: /^[a-z0-9_]+$/.test(error.message) ? error.message : 'e2e_receipt_read_failed' })); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main();
