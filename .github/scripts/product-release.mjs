import { createHash } from 'node:crypto';
import { registryManifest, resolvePublication } from './image-policy.mjs';
import { ReleaseFailure } from './worker-release.mjs';
import { logEvent } from './ci-log.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const need = (condition, cause) => { if (!condition) throw new ReleaseFailure(cause); };

export async function finalizeProductRelease({ github, context, prepared, worker, image, token, fetcher = fetch }) {
  const { source_sha, version, tag } = prepared;
  need(prepared.paired && tag === 'v' + version && worker.source?.source_sha === source_sha && worker.source.source_dirty === false && worker.version === version && worker.source.package_version === version, 'product_release_worker_identity_mismatch');
  need(image.source_sha === source_sha && image.version === version && /^sha256:[a-f0-9]{64}$/.test(image.image_config_digest ?? '') && image.worker_sha256 === worker.sha256, 'product_release_image_identity_mismatch');
  need(await resolvePublication({ github, context }) === source_sha, 'product_release_source_changed');
  const release = (await github.rest.repos.getReleaseByTag({ ...context.repo, tag })).data;
  need(!release.draft && release.prerelease && release.body?.includes(`<!-- aaa-muse-worker:verified:${source_sha}:${worker.sha256} -->`), 'product_release_worker_unverified');
  const registry = await registryManifest({ token, image: 'markhuangai/aaa-muse-ai', tag: version, expectedConfig: image.image_config_digest, fetcher });
  const sourceTag = await registryManifest({ token, image: 'markhuangai/aaa-muse-ai', tag: 'sha-' + source_sha, expectedConfig: image.image_config_digest, fetcher });
  need(registry.exists && sourceTag.exists && registry.digest === sourceTag.digest, 'product_release_image_unverified');
  const receipt = { version, source_sha, image: 'ghcr.io/markhuangai/aaa-muse-ai@' + registry.digest, image_config_digest: image.image_config_digest, worker: { package: worker.package, version, sha256: worker.sha256, archive: `markhuangai-aaa-muse-worker-${version}.tgz` }, outcome: 'complete', live_qualification: 'not_established' };
  const content = Buffer.from(JSON.stringify(receipt, null, 2) + '\n');
  const matches = release.assets.filter(asset => asset.name === 'product-release.json');
  need(matches.length <= 1, 'product_release_ambiguous_receipts');
  if (!matches.length) await github.rest.repos.uploadReleaseAsset({ ...context.repo, release_id: release.id, name: 'product-release.json', data: content, headers: { 'content-type': 'application/json', 'content-length': content.length } });
  const response = await fetcher(`https://github.com/markhuangai/AaA-muse-ai/releases/download/${tag}/product-release.json`, { signal: AbortSignal.timeout(120000) });
  need(response.ok && Number(response.headers.get('content-length') ?? 0) <= 65536, 'product_release_receipt_download_failed');
  const reader = response.body?.getReader();
  need(reader, 'product_release_receipt_download_failed');
  const chunks = []; let count = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      count += value.byteLength; need(count <= 65536, 'product_release_receipt_too_large'); chunks.push(value);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
  need(hash(Buffer.concat(chunks)) === hash(content), 'product_release_receipt_conflict');
  need(await resolvePublication({ github, context }) === source_sha, 'product_release_source_changed');
  const marker = `<!-- aaa-muse-product:verified:${source_sha}:${version}:${registry.digest}:${worker.sha256} -->`;
  const existing = /<!-- aaa-muse-product:verified:[^>]* -->/.exec(release.body ?? '');
  need(!existing || existing[0] === marker, 'product_release_completion_conflict');
  if (!existing) await github.rest.repos.updateRelease({ ...context.repo, release_id: release.id, body: release.body + '\n\n' + marker + '\n\nPaired artifact publication verified. This does not qualify live Muse.' });
  logEvent(null, 'info', 'product.release.verified', receipt);
  return receipt;
}
