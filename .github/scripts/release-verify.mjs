import { download, npmVersion, npmArchive, registryImage } from './release-io.mjs';
import { repository, imageName, hash, need, sha, digest, jsonBytes, validateManifest, inspectWorkerBytes, sameDigest, imageTags } from './release-manifest.mjs';
import { logEvent } from './ci-log.mjs';
import { ReleaseFailure } from './worker-release.mjs';
import { candidateNpmTag, isReleaseVersion } from './release-versions.mjs';

export async function verifyPublished({ tag, sourceSHA, manifestSHA256, token, fetcher = fetch, historical = false, inspect = inspectWorkerBytes, emit = logEvent }) {
  const started = Date.now();
  let operation = 'verification_selectors', destination = 'product-release.json', observedSource = 'unavailable';
  try {
  const version = tag?.startsWith('v') ? tag.slice(1) : null;
  need(isReleaseVersion(version) && sha(sourceSHA) && digest(manifestSHA256), 'product_release_verification_selectors_required');
  const base = `https://github.com/${repository}/releases/download/${tag}/`;
  const bytes = await download(base + 'product-release.json', { fetcher, limit: 65536 });
  sameDigest(hash(bytes), manifestSHA256, 'product-release.json');
  const manifest = validateManifest(JSON.parse(bytes), { historical });
  observedSource = manifest.source_sha;
  need(manifest.source_sha === sourceSHA && 'v' + manifest.version === tag, 'product_release_requested_identity_mismatch', {
    expected_source: sourceSHA, observed_source: manifest.source_sha, observed_version: manifest.version });
  const api = path => download(`https://api.github.com/repos/${repository}/${path}`, { fetcher, token, limit: 1024 * 1024 }).then(JSON.parse);
  operation = 'published_tag_verification'; destination = 'git_tag/' + tag;
  const ref = await api('git/ref/tags/' + tag);
  need(ref.object?.type === 'commit' && ref.object.sha === sourceSHA, 'product_release_tag_conflict', {
    expected_source: sourceSHA, observed_source: sha(ref.object?.sha) ? ref.object.sha : 'unavailable' });
  operation = 'published_tree_verification'; destination = 'source_repository';
  const commit = await api('commits/' + sourceSHA);
  need(commit.sha === sourceSHA && sha(commit.commit?.tree?.sha) && (!manifest.tree_sha || commit.commit.tree.sha === manifest.tree_sha), 'product_release_source_tree_conflict', {
    expected_source: sourceSHA, observed_source: sha(commit.sha) ? commit.sha : 'unavailable', expected_tree: manifest.tree_sha ?? 'unavailable',
    observed_tree: sha(commit.commit?.tree?.sha) ? commit.commit.tree.sha : 'unavailable' });
  operation = 'published_destination_verification'; destination = 'public_worker';
  const workerBytes = await download(base + manifest.worker.archive, { fetcher });
  sameDigest(hash(workerBytes), manifest.worker.sha256, 'public_worker');
  const worker = inspect(workerBytes);
  need(worker.version === manifest.version && worker.source.source_sha === sourceSHA && worker.source.source_dirty === false, 'product_release_embedded_worker_mismatch');
  if (manifest.installer) sameDigest(worker.installer_sha256, manifest.installer.sha256, 'installer');
  const workerManifest = { package: manifest.worker.package, version: manifest.version, source_sha: sourceSHA, archive: manifest.worker.archive, sha256: manifest.worker.sha256 };
  sameDigest(hash(await download(base + 'worker-release.json', { fetcher, limit: 65536 })), hash(jsonBytes(workerManifest)), 'worker-release.json');
  sameDigest(hash(await download(base + 'SHA256SUMS', { fetcher, limit: 65536 })), hash(Buffer.from(`${manifest.worker.sha256}  ${manifest.worker.archive}\n`)), 'SHA256SUMS');
  destination = 'github_packages';
  const registry = await npmVersion(manifest.version, { fetcher, token });
  need(registry.metadata?.version === manifest.version, 'product_release_npm_destination_missing');
  sameDigest(hash(await npmArchive(registry.metadata, { fetcher, token })), manifest.worker.sha256, 'github_packages');
  const tags = imageTags(manifest);
  if (manifest.source_rc) need(registry.tags[candidateNpmTag(manifest.version)] === manifest.version, 'product_release_candidate_distribution_missing');
  for (const tag of [manifest.image.slice(imageName.length + 1), ...tags]) {
    destination = tag;
    const image = await registryImage(tag, { fetcher, token });
    need(image.exists, 'product_release_image_destination_missing', { destination: tag });
    sameDigest(image.digest, manifest.image.slice(imageName.length + 1), tag);
    sameDigest(image.config_digest, manifest.image_config_digest, tag + '/config');
    verifyImageConfig(image.config, manifest);
  }
  const result = { source_sha: sourceSHA, tree_sha: commit.commit.tree.sha, version: manifest.version, manifest_sha256: manifestSHA256, source_rc: manifest.source_rc,
    image: manifest.image, image_config_digest: manifest.image_config_digest, worker_sha256: manifest.worker.sha256,
    installer_sha256: worker.installer_sha256, publication: 'complete', live_qualification: 'not_established',
    missing_identity_fields: manifest.missing_identity_fields ?? [], destinations: ['git_tag', 'github_packages', 'public_release', ...tags] };
  emit(null, 'info', 'product.release.verified', result);
  return { manifest, receipt: result };
  } catch (error) {
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_verification_dependency_failed', {
      operation_id: `verify-release-${process.pid}`, run_id: process.env.GITHUB_RUN_ID ?? 'local', attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1',
      operation, destination, source_sha: sha(sourceSHA) ? sourceSHA : 'invalid', version: tag?.startsWith('v') && isReleaseVersion(tag.slice(1)) ? tag.slice(1) : 'invalid',
      expected_source: sha(sourceSHA) ? sourceSHA : 'invalid', observed_source: observedSource,
      expected_digest: digest(manifestSHA256) ? manifestSHA256 : 'unavailable', observed_digest: 'unavailable',
      duration_ms: Date.now() - started, ...(error instanceof ReleaseFailure ? error.fields : {}),
      http_status: Number.isInteger(error.status) ? error.status : error.fields?.http_status ?? null,
      raw_output_omitted: true, omission_reason: 'credential_protection' });
  }
}

export function verifyImageConfig(config, manifest) {
  const labels = config?.config?.Labels;
  need(labels?.['org.opencontainers.image.revision'] === manifest.source_sha && labels?.['org.opencontainers.image.version'] === manifest.version &&
    labels?.['io.aaa-muse.source-dirty'] === 'false' && config.config.User === '10001:10001' &&
    Object.keys(config.config.ExposedPorts ?? {}).join() === '8080/tcp', 'product_release_embedded_image_mismatch');
}
