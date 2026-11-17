import { imageName, packageName, need, hash, imageDigest, sameDigest } from './release-manifest.mjs';

export async function download(url, { fetcher = fetch, token, limit = 64 * 1024 * 1024 } = {}) {
  const response = await fetcher(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(120000) });
  need(response.ok, 'product_release_download_failed', { http_status: response.status, destination: new URL(url).hostname, authenticated: !!token });
  need(!response.url || new URL(response.url).protocol === 'https:', 'product_release_download_redirect_unsafe');
  need(Number(response.headers.get('content-length') ?? 0) <= limit && response.body, 'product_release_download_incomplete');
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; need(size <= limit, 'product_release_download_too_large'); parts.push(part); }
  return Buffer.concat(parts);
}

export async function npmVersion(version, { fetcher = fetch, token } = {}) {
  const response = await fetcher('https://npm.pkg.github.com/@markhuangai%2faaa-muse-worker', {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
  if (response.status === 404) return { metadata: null, tags: {} };
  need(response.ok, 'product_release_registry_metadata_failed', { http_status: response.status });
  const value = JSON.parse(await boundedBody(response, 1024 * 1024));
  return { metadata: value.versions?.[version] ?? null, tags: value['dist-tags'] ?? {} };
}

async function boundedBody(response, limit) {
  need(response.body, 'product_release_download_incomplete');
  const parts = []; let size = 0;
  for await (const part of response.body) { size += part.length; need(size <= limit, 'product_release_download_too_large'); parts.push(part); }
  return Buffer.concat(parts);
}

export async function npmArchive(metadata, options) {
  need(metadata?.name === packageName && typeof metadata.version === 'string', 'product_release_registry_identity_mismatch');
  const url = new URL(metadata.dist?.tarball ?? 'https://invalid.invalid');
  need(url.protocol === 'https:' && url.hostname === 'npm.pkg.github.com' && !url.username && !url.password, 'product_release_registry_url_unsafe');
  return download(url.href, options);
}

export async function registryImage(reference, { fetcher = fetch, token, actor = process.env.GITHUB_ACTOR, write = false } = {}) {
  const image = imageName.slice('ghcr.io/'.length);
  const auth = await fetcher(`https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:${write ? 'pull,push' : 'pull'}`, {
    headers: token ? { Authorization: `Basic ${Buffer.from(`${actor}:${token}`).toString('base64')}` } : {}, signal: AbortSignal.timeout(120000) });
  need(auth.ok, 'product_release_registry_auth_failed', { http_status: auth.status });
  const bearer = JSON.parse(await boundedBody(auth, 65536)).token;
  need(typeof bearer === 'string' && bearer, 'product_release_registry_token_missing');
  const headers = { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' };
  const url = `https://ghcr.io/v2/${image}/manifests/${reference}`;
  const response = await fetcher(url, { headers, signal: AbortSignal.timeout(120000) });
  if (response.status === 404) return { exists: false };
  need(response.ok, 'product_release_image_read_failed', { http_status: response.status });
  const bytes = await boundedBody(response, 1024 * 1024), manifest = JSON.parse(bytes);
  const digest = response.headers.get('docker-content-digest');
  sameDigest('sha256:' + hash(bytes), digest, 'image_manifest');
  need(imageDigest(manifest.config?.digest), 'product_release_image_config_missing');
  const configBytes = await download(`https://ghcr.io/v2/${image}/blobs/${manifest.config.digest}`, { fetcher, token: bearer, limit: 1024 * 1024 });
  sameDigest('sha256:' + hash(configBytes), manifest.config.digest, 'image_config');
  return { exists: true, digest, config_digest: manifest.config.digest, config: JSON.parse(configBytes) };
}

export async function ensureAsset({ github, context, release, name, bytes, fetcher = fetch }) {
  const assets = release.assets.filter(asset => asset.name === name);
  need(assets.length <= 1, 'product_release_ambiguous_assets', { destination: name });
  if (!assets.length) await github.rest.repos.uploadReleaseAsset({ ...context.repo, release_id: release.id, name, data: bytes,
    headers: { 'content-type': 'application/octet-stream', 'content-length': bytes.length } });
  const observed = await download(`https://github.com/${context.repo.owner}/${context.repo.repo}/releases/download/${release.tag_name}/${name}`, { fetcher, limit: Math.max(bytes.length, 65536) });
  sameDigest(hash(observed), hash(bytes), name);
}
