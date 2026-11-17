import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readFile, writeFile } from 'node:fs/promises';
import { privateRead, readExports } from './qualification-evidence.mjs';
import { validateReport } from './qualification-report.mjs';
import { hash, jsonBytes, need, validateManifest } from '../.github/scripts/release-manifest.mjs';
import { logEvent } from '../.github/scripts/ci-log.mjs';

export function qualificationReceipt(manifest, manifestBytes, report, evidence, reportBytes) {
  validateManifest(manifest);
  const fields = { source_sha: manifest.source_sha, tree_sha: manifest.tree_sha, version: manifest.version, manifest_sha256: hash(manifestBytes),
    evidence_kind: ['live', 'synthetic'].includes(report.evidence_kind) ? report.evidence_kind : 'missing_or_invalid', outcome: 'blocked' };
  const result = validateReport(report, evidence);
  need(report.schema_version === 2 && report.suite === 'release' && report.evidence_kind === 'live' &&
    result.valid && result.verdict === 'pass' && result.observed_result === 'pass' && !result.missing.length,
    'product_release_qualification_not_passed', { ...fields, verdict: result.verdict, rejected_requirements: ['complete_live_pass_required'], missing: result.missing, errors: result.errors });
  const source = report.source;
  need(source.service_sha === manifest.source_sha && source.service_version === manifest.version && source.worker_version === manifest.version &&
    source.image_digest === manifest.image.split('@')[1] && source.worker_sha256 === manifest.worker.sha256 && source.installer_sha256 === manifest.installer.sha256 &&
    report.workers.every(worker => worker.installed_version === manifest.version && worker.installed_sha256 === manifest.worker.sha256), 'product_release_qualification_identity_mismatch', {
      ...fields, expected_source: manifest.source_sha, observed_source: source.service_sha, expected_image: manifest.image, observed_image: source.image_digest,
      expected_worker_digest: manifest.worker.sha256, observed_worker_digest: source.worker_sha256, expected_installer_digest: manifest.installer.sha256,
      observed_installer_digest: source.installer_sha256, expected_version: manifest.version,
      observed_version: /^\d+\.\d+\.\d+(?:-(?:rc|dev)\.\d+)?$/.test(source.service_version ?? '') ? source.service_version : 'invalid_or_omitted',
      rejected_requirements: ['exact_final_candidate_identity'] });
  return { schema_version: 1, kind: 'final_candidate_qualification', manifest_sha256: hash(manifestBytes), source_sha: manifest.source_sha,
    tree_sha: manifest.tree_sha, version: manifest.version, protocol_version: manifest.protocol_version, image: manifest.image,
    image_config_digest: manifest.image_config_digest, worker_sha256: manifest.worker.sha256, installer_sha256: manifest.installer.sha256,
    report_sha256: hash(reportBytes), run_id: report.run_id, finished_at: report.finished_at, evidence_kind: 'live', verdict: 'pass',
    exports: report.exports.map(ref => ({ source: ref.source, sha256: ref.sha256 })) };
}

export async function createQualification({ manifestPath, reportPath, outputPath }, { read = privateRead, readManifest = path => readFile(path), write = writeFile } = {}) {
  const manifestBytes = await readManifest(manifestPath), manifest = JSON.parse(manifestBytes);
  const reportBytes = await read(resolve(reportPath)), report = JSON.parse(reportBytes);
  const evidence = await readExports(report, file => read(join(dirname(resolve(reportPath)), file)));
  const receipt = qualificationReceipt(manifest, manifestBytes, report, evidence, reportBytes);
  await write(outputPath, jsonBytes(receipt), { mode: 0o600, flag: 'wx' });
  logEvent(null, 'info', 'product.release.qualification_verified', { manifest_sha256: receipt.manifest_sha256, report_sha256: receipt.report_sha256,
    source_sha: receipt.source_sha, version: receipt.version, receipt_sha256: hash(jsonBytes(receipt)), verdict: receipt.verdict });
  return receipt;
}

export async function main(args = process.argv.slice(2)) {
  try {
    need(args.length === 3, 'product_release_qualification_usage');
    await createQualification({ manifestPath: args[0], reportPath: args[1], outputPath: args[2] }); return 0;
  } catch (error) {
    logEvent(null, 'error', 'product.release.qualification_rejected', { cause: error.fields ? error.message : 'qualification_read_or_write_failed',
      ...error.fields, outcome: 'blocked' }); return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main();
