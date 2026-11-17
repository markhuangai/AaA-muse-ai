import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { publishRelease, ReleaseFailure } from './worker-release.mjs';
import { resolveStableSource } from './release-control.mjs';
import { verifyBundle } from './release-bundle.mjs';
import { registryImage, ensureAsset, npmVersion } from './release-io.mjs';
import { imageName, imageTags, makeManifest, jsonBytes, hash, need, sameDigest } from './release-manifest.mjs';
import { verifyPublished, verifyImageConfig } from './release-verify.mjs';
import { logEvent } from './ci-log.mjs';

export async function publishCandidate({ github, context, prepared, directory, token, fetcher = fetch,
  execute = execFileSync, read = readFileSync, bundleCheck = verifyBundle, publishWorker = publishRelease }) {
  const started = Date.now(), completed = [], missing = ['github_packages', 'public_worker', 'product-release.json', 'completion_marker'];
  let failureChannel = 'http';
  const runProcess = (...args) => { failureChannel = 'process'; const result = execute(...args); failureChannel = 'http'; return result; };
  const complete = value => { if (!completed.includes(value)) completed.push(value); const index = missing.indexOf(value); if (index >= 0) missing.splice(index, 1); };
  let operation = 'frozen_bundle_verification', destination = 'bundle';
  const fields = () => ({ operation_id: `release-${context.runId}-${context.runAttempt ?? 1}`, run_id: context.runId,
    attempt: context.runAttempt ?? 1, source_sha: prepared.source_sha, tree_sha: prepared.tree_sha, version: prepared.version,
    operation, destination, completed_destinations: [...completed], missing_destinations: [...missing], duration_ms: Date.now() - started });
  const verifySource = async () => (await resolveStableSource({ github, context, sourceSHA: prepared.source_sha, phase: 'candidate', version: prepared.version })).source_sha;
  try {
    const bundle = bundleCheck(directory, prepared, { read, execute });
    await verifySource();
    const tags = imageTags({ ...prepared, publication_kind: 'candidate' });
    missing.push(...tags);
    operation = 'destination_reconciliation';
    let imageDigest;
    for (const tag of tags) {
      destination = tag;
      const existing = await registryImage(tag, { fetcher, token });
      if (!existing.exists) continue;
      sameDigest(existing.config_digest, bundle.image_config_digest, tag + '/config');
      verifyImageConfig(existing.config, prepared);
      if (imageDigest) sameDigest(existing.digest, imageDigest, tag);
      imageDigest = existing.digest; complete(tag);
    }
    logEvent(null, missing.length ? 'warn' : 'info', 'product.release.reconciled', { ...fields(), outcome: 'incomplete' });
    operation = 'worker_publication'; destination = 'github_packages_and_release';
    const workerReceipt = { ...bundle.worker, archive: join(directory, 'worker.tgz') };
    await publishWorker({ github, context, prepared, receipt: workerReceipt, archive: read(workerReceipt.archive), token, fetcher, verifySource });
    let registry = await npmVersion(prepared.version, { fetcher, token });
    if (!registry.tags.candidate) {
      operation = 'candidate_distribution_reconciliation'; destination = 'npm_candidate';
      runProcess('npm', ['dist-tag', 'add', `${bundle.worker.package}@${prepared.version}`, 'candidate', '--registry', 'https://npm.pkg.github.com'],
        { env: { ...process.env, NODE_AUTH_TOKEN: token }, stdio: ['ignore', 'ignore', 'pipe'] });
      registry = await npmVersion(prepared.version, { fetcher, token });
    }
    need(registry.tags.candidate === prepared.version, 'product_release_candidate_distribution_conflict');
    complete('github_packages'); complete('public_worker');
    operation = 'image_publication';
    const missingImages = tags.filter(tag => missing.includes(tag));
    if (missingImages.length) {
      runProcess('docker', ['load', '-i', join(directory, 'image.tar')], { stdio: ['ignore', 'ignore', 'pipe'] });
      runProcess('docker', ['login', 'ghcr.io', '--username', context.actor, '--password-stdin'], { input: token, stdio: ['pipe', 'ignore', 'pipe'] });
      for (const tag of missingImages) {
        destination = tag; await verifySource();
        const raced = await registryImage(tag, { fetcher, token });
        if (raced.exists) {
          sameDigest(raced.config_digest, bundle.image_config_digest, tag + '/config');
          if (imageDigest) sameDigest(raced.digest, imageDigest, tag);
        } else if (imageDigest) {
          runProcess('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', `${imageName}:${tag}`, `${imageName}@${imageDigest}`], { stdio: ['ignore', 'ignore', 'pipe'] });
        } else {
          runProcess('docker', ['tag', bundle.image_config_digest, `${imageName}:${tag}`]);
          runProcess('docker', ['push', `${imageName}:${tag}`], { stdio: ['ignore', 'ignore', 'pipe'] });
        }
        const published = await registryImage(tag, { fetcher, token });
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
    const marker = `<!-- aaa-muse-product:verified:${prepared.source_sha}:${prepared.version}:${imageDigest}:${bundle.worker.sha256} -->`;
    const prior = /<!-- aaa-muse-product:verified:[^>]* -->/.exec(release.body ?? '');
    need(!prior || prior[0] === marker, 'product_release_completion_conflict');
    if (!prior) await github.rest.repos.updateRelease({ ...context.repo, release_id: release.id, body: release.body + '\n\n' + marker + '\n\nCandidate publication complete; live qualification is not established.' });
    complete('completion_marker');
    logEvent(null, 'info', 'product.release.candidate_completed', { ...fields(), ...verified.receipt, outcome: 'complete' });
    return verified.receipt;
  } catch (error) {
    for (const child of error.fields?.completed_destinations ?? []) complete(child);
    const workerAssets = ['markhuangai-aaa-muse-worker-' + prepared.version + '.tgz', 'SHA256SUMS', 'worker-release.json'];
    if (workerAssets.every(name => completed.includes('public_release/' + name))) complete('public_worker');
    destination = error.fields?.destination ?? destination;
    const uncertain = Number.isInteger(error.status ?? error.fields?.http_status) && !completed.includes(destination) ? destination : null;
    const index = missing.indexOf(uncertain); if (index >= 0) missing.splice(index, 1);
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_required_operation_failed', {
      ...(error instanceof ReleaseFailure ? error.fields : {}), ...fields(), child_operation: error.fields?.operation ?? null,
      http_status: failureChannel === 'http' ? error.status ?? error.fields?.http_status ?? null : null,
      process_status: failureChannel === 'process' ? error.status ?? null : error.fields?.process_status ?? null,
      uncertain_destination: uncertain, raw_output_omitted: true, omission_reason: 'credential_protection' });
  }
}
