import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishRelease, ReleaseFailure } from './worker-release.mjs';
import { latestCompleteRC, listReleases, releaseOperation, requireCurrentRC, verifyReleaseDispatch } from './release-control.mjs';
import { completionMarker, hasCompletionMarker, latestStableRelease, readProductRelease } from './release-history.mjs';
import { candidateNpmTag, compareVersions, isFinalVersion } from './release-versions.mjs';
import { preparedImageTag, verifyBundle } from './release-bundle.mjs';
import { imageConfigDigest } from './image-policy.mjs';
import { registryImage, ensureAsset, npmVersion } from './release-io.mjs';
import { imageName, imageTags, makeManifest, jsonBytes, hash, need, sameDigest } from './release-manifest.mjs';
import { verifyPublished, verifyImageConfig } from './release-verify.mjs';
import { logEvent } from './ci-log.mjs';

export async function publishCandidate({ github, context, prepared, directory, token, fetcher = fetch,
  execute = execFileSync, read = readFileSync, bundleCheck = verifyBundle, publishWorker = publishRelease }) {
  const started = Date.now(), completed = [], missing = ['github_packages', 'public_worker', 'product-release.json', 'completion_marker', 'npm_candidate'];
  let failureChannel = 'http';
  const runProcess = (...args) => { failureChannel = 'process'; const result = execute(...args); failureChannel = 'http'; return result; };
  const complete = value => { if (!completed.includes(value)) completed.push(value); const index = missing.indexOf(value); if (index >= 0) missing.splice(index, 1); };
  let operation = 'frozen_bundle_verification', destination = 'bundle';
  const fields = () => ({ ...releaseOperation(context),
    source_sha: prepared.source_sha, tree_sha: prepared.tree_sha, version: prepared.version, source_rc: prepared.source_rc,
    operation, destination, completed_destinations: [...completed], missing_destinations: [...missing], duration_ms: Date.now() - started });
  const verifySource = async () => {
    const { object } = (await github.rest.git.getRef({ ...context.repo, ref: 'tags/' + prepared.source_rc.tag })).data;
    need(object.type === 'commit' && object.sha === prepared.source_sha, 'product_release_source_changed',
      { expected_source: prepared.source_sha, observed_source: object.sha });
    return prepared.source_sha;
  };
  const npmOptions = { fetcher, token };
  const imageOptions = { ...npmOptions, actor: context.actor };
  try {
    await verifyReleaseDispatch({ github, context });
    const bundle = bundleCheck(directory, prepared, { read, execute });
    const packageVersion = bundle.worker.package + '@' + prepared.version;
    const scopedTag = candidateNpmTag(prepared.version);
    const tagNpm = tag => runProcess('npm', ['dist-tag', 'add', packageVersion, tag, '--registry', 'https://npm.pkg.github.com'],
      { env: { ...process.env, NODE_AUTH_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] });
    const releases = await listReleases({ github, context });
    const prior = await latestStableRelease(releases, fetcher);
    requireCurrentRC(prepared, await latestCompleteRC({ github, context, releases, prior, fetcher, token }));
    const tags = imageTags({ ...prepared, publication_kind: 'candidate' });
    missing.push(...tags);
    operation = 'destination_reconciliation';
    let imageDigest;
    destination = prepared.version;
    const stableImage = await registryImage(destination, imageOptions);
    need(!stableImage.exists, 'product_release_version_destination_conflict', { observed_digest: stableImage.digest });
    for (const tag of tags) {
      destination = tag;
      const existing = await registryImage(tag, imageOptions);
      if (!existing.exists) continue;
      sameDigest(existing.config_digest, bundle.image_config_digest, tag + '/config');
      verifyImageConfig(existing.config, prepared);
      if (imageDigest) sameDigest(existing.digest, imageDigest, tag);
      imageDigest = existing.digest; complete(tag);
    }
    logEvent(null, missing.length ? 'warn' : 'info', 'product.release.reconciled', { ...fields(), outcome: 'incomplete' });
    operation = 'candidate_distribution_preflight'; destination = 'npm_candidate';
    const { tags: existingNpmTags } = await npmVersion(prepared.version, npmOptions);
    await verifyCandidateAlias(releases, prepared.version, existingNpmTags.candidate, fetcher);
    destination = scopedTag;
    verifyScopedNpmTag(existingNpmTags[scopedTag], prepared.version);
    if (!imageDigest) {
      operation = 'frozen_image_restore'; destination = 'image.tar';
      runProcess('docker', ['load', '-i', join(directory, 'image.tar')], { stdio: ['ignore', 'ignore', 'pipe'] });
      const [restored] = JSON.parse(runProcess('docker', ['image', 'inspect', preparedImageTag], { stdio: ['ignore', 'pipe', 'pipe'] }));
      sameDigest(imageConfigDigest(restored), bundle.image_config_digest, 'restored_image_config');
      verifyImageConfig({ config: restored.Config }, prepared);
    }
    operation = 'worker_publication'; destination = 'github_packages_and_release';
    const workerReceipt = { ...bundle.worker, archive: join(directory, 'worker.tgz') };
    await publishWorker({ github, context, prepared, receipt: workerReceipt, archive: read(workerReceipt.archive), token, fetcher, verifySource });
    complete('github_packages'); complete('public_worker');
    operation = 'candidate_distribution_reconciliation'; destination = scopedTag;
    const scoped = (await npmVersion(prepared.version, npmOptions)).tags[scopedTag];
    verifyScopedNpmTag(scoped, prepared.version);
    if (scoped === undefined) tagNpm(scopedTag);
    need((await npmVersion(prepared.version, npmOptions)).tags[scopedTag] === prepared.version, 'product_release_candidate_distribution_missing');
    const missingImages = tags.filter(tag => missing.includes(tag));
    if (missingImages.length) {
      operation = 'image_registry_login'; destination = 'registry_login';
      runProcess('docker', ['login', 'ghcr.io', '--username', context.actor, '--password-stdin'], { input: token, stdio: ['pipe', 'ignore', 'pipe'] });
      for (const tag of missingImages) {
        operation = 'image_publication';
        destination = tag; await verifySource();
        const raced = await registryImage(tag, imageOptions);
        if (raced.exists) {
          sameDigest(raced.config_digest, bundle.image_config_digest, tag + '/config');
          if (imageDigest) sameDigest(raced.digest, imageDigest, tag);
        } else if (imageDigest) {
          runProcess('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', `${imageName}:${tag}`, `${imageName}@${imageDigest}`], { stdio: ['ignore', 'ignore', 'pipe'] });
        } else {
          operation = 'image_tagging';
          runProcess('docker', ['tag', preparedImageTag, `${imageName}:${tag}`], { stdio: ['ignore', 'ignore', 'pipe'] });
          operation = 'image_publication';
          runProcess('docker', ['push', `${imageName}:${tag}`], { stdio: ['ignore', 'ignore', 'pipe'] });
        }
        const published = await registryImage(tag, imageOptions);
        need(published.exists, 'product_release_image_destination_missing');
        sameDigest(published.config_digest, bundle.image_config_digest, tag + '/config');
        if (imageDigest) sameDigest(published.digest, imageDigest, tag);
        imageDigest = published.digest; complete(tag);
      }
    }
    const manifest = makeManifest({ ...prepared, image_digest: imageDigest, image_config_digest: bundle.image_config_digest, worker: bundle.worker, publication_kind: 'candidate' });
    destination = 'product-release.json'; operation = 'manifest_publication';
    const release = (await github.rest.repos.getReleaseByTag({ ...context.repo, tag: prepared.tag })).data;
    const content = jsonBytes(manifest);
    await ensureAsset({ github, context, release, name: destination, bytes: content, fetcher });
    complete('product-release.json');
    operation = 'final_verification';
    const verified = await verifyPublished({ tag: prepared.tag, sourceSHA: prepared.source_sha, manifestSHA256: hash(content), token, fetcher });
    await verifySource();
    destination = 'completion_marker'; operation = 'completion_marker_publication';
    const marker = completionMarker(manifest);
    const markers = (release.body ?? '').match(/<!-- aaa-muse-product:verified:[^>]* -->/g) ?? [];
    need(!markers.length || (markers.length === 1 && markers[0] === marker), 'product_release_completion_conflict');
    if (!markers.length) await github.rest.repos.updateRelease({ ...context.repo, release_id: release.id, body: (release.body ?? '') + '\n\n' + marker + '\n\nCandidate publication complete; live qualification is not established.' });
    complete('completion_marker');
    operation = 'candidate_alias_publication'; destination = 'npm_candidate';
    const old = (await npmVersion(prepared.version, npmOptions)).tags.candidate;
    const desired = await verifyCandidateAlias(await listReleases({ github, context }), prepared.version, old, fetcher);
    if (old !== desired) tagNpm('candidate');
    need((await npmVersion(prepared.version, npmOptions)).tags.candidate === desired, 'product_release_candidate_distribution_missing');
    complete('npm_candidate');
    logEvent(null, 'info', 'product.release.candidate_completed', { ...fields(), ...verified.receipt, outcome: 'complete' });
    return verified.receipt;
  } catch (error) {
    for (const child of error.fields?.completed_destinations ?? []) complete(child);
    const workerAssets = ['markhuangai-aaa-muse-worker-' + prepared.version + '.tgz', 'SHA256SUMS', 'worker-release.json'];
    if (workerAssets.every(name => completed.includes('public_release/' + name))) complete('public_worker');
    destination = error.fields?.destination ?? destination;
    const localImageOperations = ['frozen_image_restore', 'image_registry_login', 'image_tagging'];
    const uncertain = !localImageOperations.includes(operation) && Number.isInteger(error.status ?? error.fields?.http_status) &&
      !completed.includes(destination) ? destination : null;
    const index = missing.indexOf(uncertain); if (index >= 0) missing.splice(index, 1);
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_required_operation_failed', {
      ...(error instanceof ReleaseFailure ? error.fields : {}), ...fields(), child_operation: error.fields?.operation ?? null,
      http_status: failureChannel === 'http' ? error.status ?? error.fields?.http_status ?? null : null,
      process_status: failureChannel === 'process' ? error.status ?? null : error.fields?.process_status ?? null,
      uncertain_destination: uncertain, raw_output_omitted: true, omission_reason: 'credential_protection' });
  }
}

function verifyScopedNpmTag(observed, version) {
  need(observed === undefined || observed === version, 'product_release_candidate_distribution_conflict',
    { expected_version: version, observed_version: isFinalVersion(observed) ? observed : 'unknown' });
}

async function verifyCandidateAlias(releases, version, current, fetcher) {
  if (current === undefined || current === version) return version;
  const previous = isFinalVersion(current) &&
    releases.find(release => !release.draft && release.tag_name === 'v' + current && hasCompletionMarker(release));
  const fields = { expected_version: version, observed_version: isFinalVersion(current) ? current : 'unknown' };
  need(previous, 'product_release_candidate_distribution_conflict', fields);
  const { manifest } = await readProductRelease(previous, fetcher);
  need(manifest.publication_kind === 'candidate', 'product_release_candidate_distribution_conflict', fields);
  return compareVersions(current, version) < 0 ? version : current;
}
