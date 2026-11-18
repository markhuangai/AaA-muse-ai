import { execFileSync } from 'node:child_process';
import { verifyPublished } from './release-verify.mjs';
import { latestCompleteRC, listReleases, requireCurrentRC, verifyMainSource, verifyReleaseDispatch } from './release-control.mjs';
import { latestStableRelease, promotionReceipt, readProductRelease, readReleaseAsset, releaseAsset } from './release-history.mjs';
import { isFinalVersion, releaseVersion } from './release-versions.mjs';
import { registryImage, npmVersion, ensureAsset } from './release-io.mjs';
import { hash, jsonBytes, imageName, need, sameDigest, digest, sha, imageDigest, ReleaseFailure } from './release-manifest.mjs';
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

export async function promoteRelease({ qualificationAssetID, ...options }) {
  const { github, context, version, manifestSHA256, qualificationSHA256, fetcher = fetch } = options;
  const started = Date.now();
  const assetID = /^[1-9][0-9]{0,19}$/.test(qualificationAssetID ?? '') ? qualificationAssetID : 'invalid';
  let operation = 'qualification_asset_lookup', qualificationBytes, asset;
  try {
    await verifyReleaseDispatch({ github, context });
    need(isFinalVersion(version), 'product_release_promotion_version_required');
    const release = (await github.rest.repos.getReleaseByTag({ ...context.repo, tag: 'v' + version })).data;
    const matches = release.assets.filter(item => String(item.id) === assetID);
    if (matches.length === 1) asset = matches[0];
    need(asset && asset.size <= 65536 && /^[A-Za-z0-9_.-]+\.json$/.test(asset.name), 'product_release_qualification_asset_required');
    operation = 'qualification_asset_download';
    qualificationBytes = await readReleaseAsset(release, asset.name, fetcher);
  } catch (error) {
    const publishedDigest = asset?.digest?.replace(/^sha256:/, '');
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_qualification_asset_lookup_failed', {
      operation_id: 'release-' + context.runId + '-' + (context.runAttempt ?? 1), run_id: context.runId, attempt: context.runAttempt ?? 1,
      operation, destination: 'qualification_receipt', version: isFinalVersion(version) ? version : 'invalid',
      manifest_sha256: digest(manifestSHA256) ? manifestSHA256 : 'invalid',
      expected_asset_id: assetID, observed_asset_id: asset ? String(asset.id) : 'missing',
      expected_digest: digest(qualificationSHA256) ? qualificationSHA256 : 'invalid',
      observed_digest: digest(error.fields?.observed_digest) ? error.fields.observed_digest : digest(publishedDigest) ? publishedDigest : 'unavailable',
      completed_destinations: [], missing_destinations: ['qualification_receipt'], duration_ms: Date.now() - started,
      http_status: Number.isInteger(error.status) ? error.status : error.fields?.http_status ?? null,
      request_id: error.response?.headers?.['x-github-request-id'] ?? null,
      outcome: 'blocked', raw_output_omitted: true, omission_reason: 'credential_protection' });
  }
  return promoteCandidate({ ...options, qualificationBytes });
}

export async function promoteCandidate({ github, context, version, manifestSHA256, qualificationBytes, qualificationSHA256, confirmation,
  token, fetcher = fetch, execute = execFileSync }) {
  const started = Date.now(), completed = [];
  const missing = [version, 'latest', 'npm_latest', 'github_release', 'qualification_receipt', 'promotion-intent.json', 'promotion.json'];
  const complete = value => { if (!completed.includes(value)) completed.push(value); const index = missing.indexOf(value); if (index >= 0) missing.splice(index, 1); };
  let failureChannel = 'http', mutationAttempted = false, manifest;
  let operation = 'human_gate', destination = 'qualification';
  const fields = () => ({ operation_id: 'release-' + context.runId + '-' + (context.runAttempt ?? 1), run_id: context.runId, attempt: context.runAttempt ?? 1,
    source_sha: manifest?.source_sha ?? 'unavailable', version: isFinalVersion(version) ? version : 'invalid', source_rc: manifest?.source_rc,
    manifest_sha256: digest(manifestSHA256) ? manifestSHA256 : 'invalid', qualification_sha256: digest(qualificationSHA256) ? qualificationSHA256 : 'invalid',
    operation, destination, completed_destinations: completed, missing_destinations: missing, duration_ms: Date.now() - started });
  const image = reference => registryImage(reference, { fetcher, token, actor: context.actor });
  const npmLatest = async () => (await npmVersion(version, { fetcher, token })).tags.latest ?? null;
  const getRelease = async () => (await github.rest.repos.getReleaseByTag({ ...context.repo, tag: 'v' + version })).data;
  const latestGitHub = async () => {
    try { return (await github.rest.repos.getLatestRelease(context.repo)).data; }
    catch (error) { if (error.status !== 404) throw error; return null; }
  };
  function writeAsset(release, name, bytes) {
    mutationAttempted = true;
    return ensureAsset({ github, context, release, name, bytes, fetcher });
  }
  try {
    need(isFinalVersion(version) && digest(manifestSHA256) && digest(qualificationSHA256) &&
      confirmation === 'promote ' + version + ' ' + manifestSHA256 + ' ' + qualificationSHA256, 'product_release_explicit_promotion_confirmation_required');
    sameDigest(hash(qualificationBytes), qualificationSHA256, 'qualification_receipt');
    await verifyReleaseDispatch({ github, context });
    const release = await getRelease();
    const publication = await readProductRelease(release, fetcher);
    manifest = publication.manifest;
    need(manifest.publication_kind === 'candidate' && manifest.source_rc, 'product_release_final_candidate_required');
    sameDigest(publication.manifestSHA256, manifestSHA256, 'product-release.json');
    await verifyPublished({ tag: release.tag_name, sourceSHA: manifest.source_sha, manifestSHA256, token, fetcher });
    await verifyMainSource({ github, context, manifest });
    operation = 'qualification_verification'; destination = 'qualification_receipt';
    verifyQualification(JSON.parse(qualificationBytes), manifest, manifestSHA256);

    operation = 'stable_destination_reconciliation'; destination = version;
    const candidateDigest = manifest.image.split('@')[1];
    const existing = await image(version);
    const receipt = promotionReceipt(manifest, manifestSHA256, qualificationSHA256);
    const qualificationName = 'qualification-' + qualificationSHA256 + '.json';
    if (releaseAsset(release, 'promotion.json')) {
      need(!release.prerelease && existing.exists, 'product_release_stable_release_missing');
      sameDigest(existing.digest, candidateDigest, version);
      sameDigest(hash(await readReleaseAsset(release, qualificationName, fetcher)), qualificationSHA256, qualificationName);
      sameDigest(hash(await readReleaseAsset(release, 'promotion.json', fetcher)), hash(jsonBytes(receipt)), 'promotion.json');
      logEvent(null, 'info', 'product.release.promotion_verified', { ...fields(), ...receipt, missing_destinations: [], completed_destinations: receipt.destinations });
      return receipt;
    }
    need(!release.immutable && release.tag_name === 'v' + version, 'product_release_promotion_release_unavailable');
    const releases = await listReleases({ github, context });
    const prior = await latestStableRelease(releases, fetcher);
    need(!prior || releaseVersion(prior.version).patch < releaseVersion(version).patch, 'product_release_stable_version_not_newer',
      { expected_version_above: prior?.version, observed_version: version });
    for (const other of releases) {
      const otherVersion = other.tag_name?.slice(1);
      if (other.id === release.id || other.draft || !other.tag_name?.startsWith('v') || !isFinalVersion(otherVersion) ||
        releaseAsset(other, 'promotion.json') || !releaseAsset(other, 'promotion-intent.json')) continue;
      need(!(await image(otherVersion)).exists, 'product_release_other_promotion_incomplete',
        { destination: otherVersion, expected_version: version, observed_version: otherVersion });
    }

    const intent = { schema_version: 1, version, source_sha: manifest.source_sha, source_rc: manifest.source_rc,
      manifest_sha256: manifestSHA256, qualification_sha256: qualificationSHA256, image: manifest.image, previous_stable: prior };
    const intentBytes = jsonBytes(intent);
    const intentName = 'promotion-intent.json';
    const priorIntent = releaseAsset(release, intentName);
    if (priorIntent) sameDigest(hash(await readReleaseAsset(release, intentName, fetcher)), hash(intentBytes), intentName);
    if (existing.exists) {
      sameDigest(existing.digest, candidateDigest, version);
      need(priorIntent, 'product_release_stable_write_without_intent');
      complete(version);
    }

    const priorDigest = prior?.image.split('@')[1] ?? null;
    async function checkImageLatest() {
      const observed = (await image('latest')).digest ?? null;
      need(observed === priorDigest || observed === candidateDigest, 'product_release_latest_distribution_conflict',
        { expected_digest: priorDigest, observed_digest: observed });
      return observed;
    }
    async function checkNpmLatest() {
      const observed = await npmLatest();
      need(observed === (prior?.version ?? null) || observed === version, 'product_release_latest_distribution_conflict',
        { expected_version: prior?.version ?? null, observed_version: isFinalVersion(observed) ? observed : observed === null ? null : 'unknown' });
      return observed;
    }
    async function checkGitHubLatest() {
      const observed = await latestGitHub();
      need((observed?.id ?? null) === (prior?.release_id ?? null) || observed?.id === release.id,
        'product_release_latest_distribution_conflict', { expected_version: prior?.version ?? null,
          observed_version: isFinalVersion(observed?.tag_name?.slice(1)) ? observed.tag_name.slice(1) : 'unknown' });
      return observed;
    }
    destination = 'latest'; await checkImageLatest();
    destination = 'npm_latest'; await checkNpmLatest();
    destination = 'github_release'; await checkGitHubLatest();
    if (!existing.exists) {
      operation = 'latest_rc_reverification'; destination = 'source_rc';
      requireCurrentRC(manifest, await latestCompleteRC({ github, context, releases: await listReleases({ github, context }), prior, token, fetcher }));
    } else {
      logEvent(null, 'warn', 'product.release.promotion_resuming', { ...fields(), observed_digest: existing.digest, outcome: 'incomplete' });
    }
    operation = 'promotion_intent_publication'; destination = intentName;
    await writeAsset(release, intentName, intentBytes); complete(intentName); mutationAttempted = false;
    operation = 'qualification_receipt_publication'; destination = 'qualification_receipt';
    await writeAsset(await getRelease(), qualificationName, qualificationBytes); complete(destination); mutationAttempted = false;

    operation = 'stable_image_promotion'; destination = 'registry_login'; failureChannel = 'process';
    execute('docker', ['login', 'ghcr.io', '--username', context.actor, '--password-stdin'], { input: token, stdio: ['pipe', 'ignore', 'pipe'] });
    failureChannel = 'http';
    for (const tag of [version, 'latest']) {
      destination = tag;
      const observed = tag === 'latest' ? await checkImageLatest() : (await image(tag)).digest;
      if (tag === version && observed !== undefined) sameDigest(observed, candidateDigest, tag);
      if (observed !== candidateDigest) {
        failureChannel = 'process'; mutationAttempted = true;
        execute('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', imageName + ':' + tag, manifest.image], { stdio: ['ignore', 'ignore', 'pipe'] });
        failureChannel = 'http';
      }
      sameDigest((await image(tag)).digest, candidateDigest, tag); complete(tag); mutationAttempted = false;
    }

    destination = 'npm_latest'; operation = 'npm_distribution_promotion';
    if (await checkNpmLatest() !== version) {
      failureChannel = 'process'; mutationAttempted = true;
      execute('npm', ['dist-tag', 'add', manifest.worker.package + '@' + version, 'latest', '--registry', 'https://npm.pkg.github.com'],
        { env: { ...process.env, NODE_AUTH_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] });
      failureChannel = 'http';
    }
    need(await npmLatest() === version, 'product_release_latest_distribution_missing');
    complete(destination); mutationAttempted = false;
    destination = 'github_release'; operation = 'release_distribution_promotion';
    const latest = await checkGitHubLatest();
    if (latest?.id !== release.id || latest.prerelease) {
      mutationAttempted = true;
      await github.rest.repos.updateRelease({ ...context.repo, release_id: release.id, prerelease: false, make_latest: 'true' });
    }
    const published = await getRelease();
    need(!published.prerelease && !published.draft && (await latestGitHub())?.id === published.id, 'product_release_stable_release_missing');
    complete(destination); mutationAttempted = false;

    operation = 'final_stable_verification';
    await verifyPublished({ tag: published.tag_name, sourceSHA: manifest.source_sha, manifestSHA256, token, fetcher });
    sameDigest((await image(version)).digest, candidateDigest, version);
    sameDigest((await image('latest')).digest, candidateDigest, 'latest');
    need(await npmLatest() === version, 'product_release_latest_distribution_missing');
    need((await latestGitHub())?.id === release.id, 'product_release_stable_release_missing');
    destination = 'promotion.json'; operation = 'promotion_receipt_publication';
    await writeAsset(published, destination, jsonBytes(receipt)); complete(destination); mutationAttempted = false;
    logEvent(null, 'info', 'product.release.promoted', { ...fields(), ...receipt });
    return receipt;
  } catch (error) {
    const failedOperation = error.fields?.operation ?? operation;
    const failedDestination = error.fields?.destination ?? destination;
    const uncertain = mutationAttempted && !completed.includes(destination) ? destination : null;
    const index = missing.indexOf(uncertain); if (index >= 0) missing.splice(index, 1);
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_required_operation_failed', {
      ...(error instanceof ReleaseFailure ? error.fields : {}), ...fields(),
      operation: failedOperation, destination: failedDestination,
      parent_operation: failedOperation === operation ? undefined : operation,
      http_status: failureChannel === 'http' ? error.status ?? error.fields?.http_status ?? null : null,
      process_status: failureChannel === 'process' && Number.isInteger(error.status) ? error.status : null,
      process_signal: failureChannel === 'process' ? error.signal ?? null : null,
      uncertain_destination: uncertain, raw_output_omitted: true, omission_reason: 'credential_protection', outcome: operation === 'human_gate' || operation === 'latest_rc_reverification' ? 'blocked' : 'incomplete' });
  }
}
