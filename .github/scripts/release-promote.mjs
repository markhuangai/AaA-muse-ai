import { execFileSync } from 'node:child_process';
import { verifyPublished } from './release-verify.mjs';
import { resolveStableSource } from './release-control.mjs';
import { registryImage, npmVersion, ensureAsset } from './release-io.mjs';
import { hash, jsonBytes, imageName, need, sameDigest, digest, sha, imageDigest } from './release-manifest.mjs';
import { ReleaseFailure } from './worker-release.mjs';
import { logEvent } from './ci-log.mjs';

export function verifyQualification(receipt, manifest, manifestSHA256) {
  const fields = { source_sha: manifest.source_sha, version: manifest.version, manifest_sha256: manifestSHA256,
    evidence_kind: ['live', 'synthetic'].includes(receipt?.evidence_kind) ? receipt.evidence_kind : 'missing_or_invalid',
    observed_verdict: ['pass', 'fail', 'inconclusive'].includes(receipt?.verdict) ? receipt.verdict : 'missing_or_invalid',
    operation: 'qualification_verification', destination: 'qualification_receipt', promotion_outcome: 'blocked', outcome: 'blocked' };
  need(receipt?.schema_version === 1 && receipt.kind === 'final_candidate_qualification' && receipt.manifest_sha256 === manifestSHA256 &&
    receipt.evidence_kind === 'live' && receipt.verdict === 'pass' && digest(receipt.report_sha256) &&
    typeof receipt.run_id === 'string' && receipt.run_id && Number.isFinite(Date.parse(receipt.finished_at)) &&
    Array.isArray(receipt.exports) && receipt.exports.length > 0 && receipt.exports.every(ref => ['broker', 'worker'].includes(ref.source) && digest(ref.sha256)),
    'product_release_qualification_receipt_rejected', { ...fields, rejected_requirements: [
      ...(receipt?.evidence_kind !== 'live' ? ['live_evidence_required'] : []), ...(receipt?.verdict !== 'pass' ? ['passing_verdict_required'] : []),
      ...(!receipt?.exports?.length ? ['complete_export_references_required'] : []), 'valid_pinned_qualification_schema_required'] });
  for (const field of ['source_sha', 'tree_sha', 'version', 'protocol_version', 'image', 'image_config_digest']) {
    const value = receipt[field];
    const safe = field === 'protocol_version' ? Number.isSafeInteger(value) : field.endsWith('_sha') ? sha(value) :
      field === 'image_config_digest' ? imageDigest(value) : field === 'image' ? typeof value === 'string' && value.startsWith(imageName + '@') && imageDigest(value.split('@')[1]) :
        /^\d+\.\d+\.\d+(?:-(?:rc|dev)\.\d+)?$/.test(value ?? '');
    need(receipt[field] === manifest[field], 'product_release_qualification_identity_mismatch', { ...fields, identity_field: field,
      expected_identity: manifest[field], observed_identity: safe ? value : 'invalid_or_omitted',
      rejected_requirements: ['exact_candidate_' + field] });
  }
  need(receipt.worker_sha256 === manifest.worker.sha256 && receipt.installer_sha256 === manifest.installer.sha256, 'product_release_qualification_identity_mismatch', {
    ...fields, expected_worker_digest: manifest.worker.sha256, observed_worker_digest: digest(receipt.worker_sha256) ? receipt.worker_sha256 : 'invalid',
    expected_installer_digest: manifest.installer.sha256, observed_installer_digest: digest(receipt.installer_sha256) ? receipt.installer_sha256 : 'invalid',
    rejected_requirements: ['exact_candidate_worker_and_installer'] });
}

export async function promoteCandidate({ github, context, prepared, manifestSHA256, qualificationBytes, qualificationSHA256, confirmation,
  token, fetcher = fetch, execute = execFileSync }) {
  const completed = [], started = Date.now(), missing = [prepared.version, 'latest', 'npm_latest', 'github_release', 'qualification_receipt', 'promotion.json'];
  const complete = value => { if (!completed.includes(value)) completed.push(value); const index = missing.indexOf(value); if (index >= 0) missing.splice(index, 1); };
  let failureChannel = 'http', mutationAttempted = false;
  let operation = 'human_gate', destination = 'qualification';
  const fields = () => ({ operation_id: `release-${context.runId}-${context.runAttempt ?? 1}`, run_id: context.runId, attempt: context.runAttempt ?? 1,
    source_sha: prepared.source_sha, version: prepared.version, manifest_sha256: digest(manifestSHA256) ? manifestSHA256 : 'invalid', qualification_sha256: digest(qualificationSHA256) ? qualificationSHA256 : 'invalid',
    operation, destination, completed_destinations: [...completed], missing_destinations: [...missing], duration_ms: Date.now() - started });
  const fence = () => resolveStableSource({ github, context, sourceSHA: prepared.source_sha, version: prepared.version, phase: 'promote' });
  try {
    need(digest(manifestSHA256) && digest(qualificationSHA256) && confirmation === `promote ${prepared.version} ${manifestSHA256} ${qualificationSHA256}`, 'product_release_explicit_promotion_confirmation_required');
    sameDigest(hash(qualificationBytes), qualificationSHA256, 'qualification_receipt');
    await fence();
    const { manifest } = await verifyPublished({ tag: prepared.tag, sourceSHA: prepared.source_sha, manifestSHA256, token, fetcher });
    need(manifest.publication_kind === 'candidate', 'product_release_final_candidate_required');
    verifyQualification(JSON.parse(qualificationBytes), manifest, manifestSHA256);
    operation = 'stable_destination_reconciliation';
    const tags = [prepared.version, 'latest'];
    for (const tag of tags) {
      destination = tag;
      const existing = await registryImage(tag, { fetcher, token });
      if (existing.exists) { sameDigest(existing.digest, manifest.image.split('@')[1], tag); complete(tag); }
    }
    const npm = await npmVersion(prepared.version, { fetcher, token });
    need(!npm.tags.latest || npm.tags.latest === prepared.version, 'product_release_latest_distribution_conflict');
    if (npm.tags.latest === prepared.version) complete('npm_latest');
    const release = (await github.rest.repos.getReleaseByTag({ ...context.repo, tag: prepared.tag })).data;
    need(!release.draft && !release.immutable && release.tag_name === prepared.tag, 'product_release_promotion_release_unavailable');
    if (!release.prerelease) complete('github_release');
    destination = 'qualification_receipt'; operation = 'qualification_receipt_publication'; mutationAttempted = true;
    await ensureAsset({ github, context, release, name: `qualification-${qualificationSHA256}.json`, bytes: qualificationBytes, fetcher });
    complete('qualification_receipt'); mutationAttempted = false;
    operation = 'stable_image_promotion';
    destination = 'registry_login'; failureChannel = 'process';
    execute('docker', ['login', 'ghcr.io', '--username', context.actor, '--password-stdin'], { input: token, stdio: ['pipe', 'ignore', 'pipe'] });
    failureChannel = 'http';
    for (const tag of tags) {
      destination = tag; await fence();
      const existing = await registryImage(tag, { fetcher, token });
      if (!existing.exists) {
        failureChannel = 'process'; mutationAttempted = true;
        execute('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', `${imageName}:${tag}`, manifest.image], { stdio: ['ignore', 'ignore', 'pipe'] });
        failureChannel = 'http';
      }
      const result = await registryImage(tag, { fetcher, token });
      need(result.exists, 'product_release_stable_image_missing');
      sameDigest(result.digest, manifest.image.split('@')[1], tag); complete(tag); mutationAttempted = false;
    }
    destination = 'npm_latest'; operation = 'npm_distribution_promotion'; await fence();
    if (npm.tags.latest !== prepared.version) {
      failureChannel = 'process'; mutationAttempted = true;
      execute('npm', ['dist-tag', 'add', `${manifest.worker.package}@${prepared.version}`, 'latest', '--registry', 'https://npm.pkg.github.com'],
        { env: { ...process.env, NODE_AUTH_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] });
      failureChannel = 'http';
    }
    need((await npmVersion(prepared.version, { fetcher, token })).tags.latest === prepared.version, 'product_release_latest_distribution_missing');
    complete('npm_latest'); mutationAttempted = false; destination = 'github_release'; operation = 'release_distribution_promotion';
    await fence();
    if (release.prerelease) { mutationAttempted = true; await github.rest.repos.updateRelease({ ...context.repo, release_id: release.id, prerelease: false, make_latest: 'true' }); }
    const published = (await github.rest.repos.getReleaseByTag({ ...context.repo, tag: prepared.tag })).data;
    need(!published.prerelease && !published.draft, 'product_release_stable_release_missing'); complete('github_release'); mutationAttempted = false;
    await verifyPublished({ tag: prepared.tag, sourceSHA: prepared.source_sha, manifestSHA256, token, fetcher });
    await fence();
    const receipt = { schema_version: 1, source_sha: prepared.source_sha, version: prepared.version, manifest_sha256: manifestSHA256,
      qualification_sha256: qualificationSHA256, image: manifest.image, worker_sha256: manifest.worker.sha256,
      outcome: 'complete', live_qualification: 'pass', destinations: [prepared.version, 'latest', 'npm_latest', 'github_release'] };
    destination = 'promotion.json'; operation = 'promotion_receipt_publication'; mutationAttempted = true;
    await ensureAsset({ github, context, release: published, name: 'promotion.json', bytes: jsonBytes(receipt), fetcher });
    complete('promotion.json'); mutationAttempted = false;
    logEvent(null, 'info', 'product.release.promoted', { ...fields(), ...receipt });
    return receipt;
  } catch (error) {
    const uncertain = mutationAttempted && !completed.includes(destination) ? destination : null;
    const index = missing.indexOf(uncertain); if (index >= 0) missing.splice(index, 1);
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_required_operation_failed', {
      ...(error instanceof ReleaseFailure ? error.fields : {}), ...fields(),
      http_status: failureChannel === 'http' ? error.status ?? error.fields?.http_status ?? null : null,
      process_status: failureChannel === 'process' && Number.isInteger(error.status) ? error.status : null,
      process_signal: failureChannel === 'process' ? error.signal ?? null : null,
      uncertain_destination: uncertain, raw_output_omitted: true, omission_reason: 'credential_protection', outcome: operation === 'human_gate' ? 'blocked' : 'incomplete' });
  }
}
