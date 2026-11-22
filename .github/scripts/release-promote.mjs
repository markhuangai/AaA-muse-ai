import { execFileSync } from 'node:child_process';
import { verifyPublished } from './release-verify.mjs';
import { historicalRC, latestCompleteRC, listReleases, releaseOperation, requireCurrentRC, requireCutoverMajor, requireStableTarget, verifyMainSource, verifyReleaseDispatch } from './release-control.mjs';
import { latestStableRelease, promotionReceipt, readProductRelease, readReleaseAsset, releaseAsset, verifyPromotionReceipt } from './release-history.mjs';
import { isFinalVersion } from './release-versions.mjs';
import { registryImage, npmVersion, ensureAsset } from './release-io.mjs';
import { hash, jsonBytes, imageName, need, sameDigest, digest, validRCIdentity, ReleaseFailure } from './release-manifest.mjs';
import { logEvent } from './ci-log.mjs';

export async function promoteStable({ github, context, prepared, manifestSHA256, token, fetcher = fetch, execute = execFileSync }) {
  const { version, source_rc } = prepared;
  const started = Date.now(), completed = [];
  const missing = [version, 'latest', 'npm_latest', 'github_release', 'promotion-intent.json', 'promotion.json'];
  const complete = value => { if (!completed.includes(value)) completed.push(value); const index = missing.indexOf(value); if (index >= 0) missing.splice(index, 1); };
  let failureChannel = 'http', mutationAttempted = false, manifest;
  let operation = 'dispatch_verification', destination = 'source_repository';
  const fields = () => ({ ...releaseOperation(context),
    source_sha: prepared.source_sha, tree_sha: prepared.tree_sha, version: isFinalVersion(version) ? version : 'invalid', source_rc,
    manifest_sha256: digest(manifestSHA256) ? manifestSHA256 : 'invalid', actor: context.actor,
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
    await verifyReleaseDispatch({ github, context });
    need(isFinalVersion(version) && digest(manifestSHA256) && validRCIdentity(source_rc), 'product_release_promotion_identity_required');
    operation = 'candidate_verification'; destination = 'product-release.json';
    const release = await getRelease();
    const publication = await readProductRelease(release, fetcher);
    manifest = publication.manifest;
    need(manifest.publication_kind === 'candidate' && manifest.source_rc && manifest.version === version, 'product_release_final_candidate_required');
    sameDigest(publication.manifestSHA256, manifestSHA256, 'product-release.json');
    requireCurrentRC(prepared, manifest);
    await verifyPublished({ tag: release.tag_name, sourceSHA: manifest.source_sha, manifestSHA256, token, fetcher });
    await verifyMainSource({ github, context, manifest });

    operation = 'stable_destination_reconciliation'; destination = version;
    const candidateDigest = manifest.image.split('@')[1];
    const existing = await image(version);
    const receipt = promotionReceipt(manifest, manifestSHA256);
    if (releaseAsset(release, 'promotion.json')) {
      need(!release.prerelease && existing.exists, 'product_release_stable_release_missing');
      sameDigest(existing.digest, candidateDigest, version);
      await verifyPromotionReceipt(release, manifest, manifestSHA256, fetcher);
      logEvent(null, 'info', 'product.release.promotion_verified', { ...fields(), ...receipt, missing_destinations: [], completed_destinations: receipt.destinations });
      return receipt;
    }
    need(!release.immutable && release.tag_name === 'v' + version, 'product_release_promotion_release_unavailable');
    const releases = await listReleases({ github, context });
    const prior = await latestStableRelease(releases, fetcher);
    if (!existing.exists || !releaseAsset(release, 'promotion-intent.json')) requireCutoverMajor(version, source_rc.tag);
    requireStableTarget(version, prior);
    for (const other of releases) {
      const otherVersion = other.tag_name?.slice(1);
      if (other.id === release.id || other.draft || !other.tag_name?.startsWith('v') || !isFinalVersion(otherVersion) ||
        releaseAsset(other, 'promotion.json') || !releaseAsset(other, 'promotion-intent.json')) continue;
      need(!(await image(otherVersion)).exists, 'product_release_other_promotion_incomplete',
        { destination: otherVersion, expected_version: version, observed_version: otherVersion });
    }

    const intent = { schema_version: 2, version, source_sha: manifest.source_sha, source_rc: manifest.source_rc,
      manifest_sha256: manifestSHA256, image: manifest.image, previous_stable: prior };
    const intentBytes = jsonBytes(intent);
    const intentName = 'promotion-intent.json';
    const priorIntent = releaseAsset(release, intentName);
    need(!historicalRC(source_rc.tag) || (priorIntent && existing.exists), 'product_release_historical_candidate_only');
    if (priorIntent) {
      const bytes = await readReleaseAsset(release, intentName, fetcher);
      const { schema_version, qualification_sha256 } = JSON.parse(bytes);
      const { source_sha, source_rc, manifest_sha256, image, previous_stable } = intent;
      const expected = schema_version === 1 && digest(qualification_sha256)
        ? jsonBytes({ schema_version: 1, version, source_sha, source_rc, manifest_sha256, qualification_sha256, image, previous_stable })
        : intentBytes;
      sameDigest(hash(bytes), hash(expected), intentName);
    }
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
    if (!priorIntent) await writeAsset(release, intentName, intentBytes);
    complete(intentName); mutationAttempted = false;

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
      uncertain_destination: uncertain, raw_output_omitted: true, omission_reason: 'credential_protection', outcome: !mutationAttempted && !completed.length ? 'blocked' : 'incomplete' });
  }
}
