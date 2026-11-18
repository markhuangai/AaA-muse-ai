import { download } from './release-io.mjs';
import { digest, hash, jsonBytes, need, repository, sameDigest, validateManifest } from './release-manifest.mjs';
import { isFinalVersion, releaseVersion } from './release-versions.mjs';

export function releaseAsset(release, name) {
  const matches = release.assets?.filter(asset => asset.name === name) ?? [];
  need(matches.length <= 1, 'product_release_ambiguous_assets', { destination: name });
  return matches[0];
}

export async function readReleaseAsset(release, name, fetcher) {
  const asset = releaseAsset(release, name);
  need(asset, 'product_release_asset_missing', { destination: name });
  const bytes = await download('https://github.com/' + repository + '/releases/download/' + release.tag_name + '/' + name,
    { fetcher, limit: 65536 });
  if (asset.digest) sameDigest('sha256:' + hash(bytes), asset.digest, name);
  return bytes;
}

export function completionMarker(manifest) {
  return '<!-- aaa-muse-product:verified:' + manifest.source_sha + ':' + manifest.version + ':' +
    manifest.image.split('@')[1] + ':' + manifest.worker.sha256 + ' -->';
}

export const hasCompletionMarker = release => (release.body ?? '').includes('<!-- aaa-muse-product:verified:');

export async function readProductRelease(release, fetcher) {
  const bytes = await readReleaseAsset(release, 'product-release.json', fetcher);
  const manifest = validateManifest(JSON.parse(bytes));
  const markers = (release.body ?? '').match(/<!-- aaa-muse-product:verified:[^>]* -->/g) ?? [];
  need(!release.draft && release.tag_name === 'v' + manifest.version && markers.length === 1 && markers[0] === completionMarker(manifest),
    'product_release_completion_conflict', { destination: release.tag_name, expected_digest: hash(bytes) });
  return { manifest, manifestSHA256: hash(bytes) };
}

export function promotionReceipt(manifest, manifestSHA256, qualificationSHA256) {
  return { schema_version: 1, source_sha: manifest.source_sha, version: manifest.version, manifest_sha256: manifestSHA256,
    qualification_sha256: qualificationSHA256, image: manifest.image, worker_sha256: manifest.worker.sha256,
    outcome: 'complete', live_qualification: 'pass', destinations: [manifest.version, 'latest', 'npm_latest', 'github_release'] };
}

export async function latestStableRelease(releases, fetcher) {
  const release = releases.filter(item => !item.draft && !item.prerelease && item.tag_name?.startsWith('v') &&
    isFinalVersion(item.tag_name.slice(1)) && releaseAsset(item, 'promotion.json'))
    .sort((a, b) => releaseVersion(b.tag_name.slice(1)).patch - releaseVersion(a.tag_name.slice(1)).patch)[0];
  if (!release) return null;
  const { manifest, manifestSHA256 } = await readProductRelease(release, fetcher);
  const bytes = await readReleaseAsset(release, 'promotion.json', fetcher);
  const prior = JSON.parse(bytes);
  need(manifest.publication_kind === 'candidate' && digest(prior.qualification_sha256) &&
    releaseAsset(release, 'qualification-' + prior.qualification_sha256 + '.json'), 'product_release_prior_promotion_invalid');
  sameDigest(hash(bytes), hash(jsonBytes(promotionReceipt(manifest, manifestSHA256, prior.qualification_sha256))), 'promotion.json');
  return { tag: release.tag_name, version: manifest.version, image: manifest.image, release_id: release.id };
}

export function nextPatch(prior) {
  const patch = prior ? releaseVersion(prior.version).patch + 1 : 0;
  need(Number.isSafeInteger(patch), 'product_release_version_overflow');
  return patch;
}
