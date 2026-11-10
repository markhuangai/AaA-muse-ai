import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolvePublication } from './image-policy.mjs';
import { logEvent } from './ci-log.mjs';

const prefix = 'refs/tags/worker-v';
const rc = /^0\.1\.0-rc\.(0|[1-9][0-9]*)$/;
const sha = /^[a-f0-9]{40}$/;
const hash = value => createHash('sha256').update(value).digest('hex');

export class ReleaseFailure extends Error {
  constructor(code, fields = {}) { super(code); this.fields = fields; }
}
function requireThat(ok, code, fields) { if (!ok) throw new ReleaseFailure(code, fields); }

export function shippedInput(path) {
  return /^worker\/(src\/|setup\/)/.test(path) || ['worker/package.json', 'worker/tsconfig.json', 'worker/LICENSE', 'worker/README.md', 'worker/scripts/build.mjs', 'worker/scripts/package.mjs', 'package.json', 'package-lock.json', '.nvmrc'].includes(path);
}

export function chooseVersion(refs, source) {
  let next = 0;
  const existing = [];
  for (const ref of refs) {
    const version = ref.ref.slice(prefix.length);
    if (!ref.ref.startsWith(prefix) || !rc.test(version)) continue;
    requireThat(ref.object.type === 'commit' && sha.test(ref.object.sha), 'worker_release_invalid_tag');
    const number = Number(version.slice('0.1.0-rc.'.length));
    requireThat(Number.isSafeInteger(number) && number < Number.MAX_SAFE_INTEGER, 'worker_release_version_overflow');
    next = Math.max(next, number + 1);
    if (ref.object.sha === source) existing.push(version);
  }
  requireThat(existing.length <= 1, 'worker_release_ambiguous_source_tags');
  return existing[0] ?? `0.1.0-rc.${next}`;
}

function completedRelease(release, refs) {
  const version = release.tag_name?.replace(/^worker-v/, '');
  if (release.draft || !release.prerelease || !rc.test(version ?? '')) return false;
  const marker = /<!-- aaa-muse-worker:verified:([a-f0-9]{40}):([a-f0-9]{64}) -->/.exec(release.body ?? '');
  return !!marker && refs.some(ref => ref.ref === prefix + version && ref.object.type === 'commit' && ref.object.sha === marker[1]) &&
    ['markhuangai-aaa-muse-worker-' + version + '.tgz', 'SHA256SUMS', 'worker-release.json'].every(name => release.assets?.filter(asset => asset.name === name).length === 1);
}

export async function prepareRelease({ github, context }) {
  let operation = 'source_verification';
  try {
  const source_sha = await resolvePublication({ github, context });
  operation = 'version_tag_listing';
  const refs = await github.paginate(github.rest.git.listMatchingRefs, { ...context.repo, ref: 'tags/worker-v0.1.0-rc.', per_page: 100 });
  operation = 'completed_release_listing';
  const releases = await github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });
  const completed = releases.filter(release => completedRelease(release, refs)).sort((a, b) => Number(b.tag_name.split('.').at(-1)) - Number(a.tag_name.split('.').at(-1)));
  const current = refs.some(ref => ref.object.sha === source_sha);
  let relevant = true;
  if (completed.length && !current) {
    const prior = refs.find(ref => ref.ref === 'refs/tags/' + completed[0].tag_name).object.sha;
    operation = 'shipped_input_comparison';
    const comparison = (await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${prior}...${source_sha}`, per_page: 100 })).data;
    requireThat(comparison.merge_base_commit.sha === prior && Array.isArray(comparison.files) && comparison.files.length < 300,
      'worker_release_comparison_incomplete');
    relevant = comparison.files.some(file => shippedInput(file.filename) || (file.previous_filename && shippedInput(file.previous_filename)));
  }
  operation = 'version_selection';
  const version = chooseVersion(refs, source_sha);
  const result = { source_sha, version, tag: 'worker-v' + version, should_publish: relevant || current };
  logEvent(null, 'info', 'worker.release.prepared', result);
  return result;
  } catch (error) {
    throw new ReleaseFailure(error instanceof ReleaseFailure || /^publication_[a-z_]+$/.test(error.message ?? '') ? error.message : 'required_api_operation_failed', {
      operation, destination: 'release_plan', source_sha: context.payload?.workflow_run?.head_sha ?? 'unavailable', version: 'unavailable', expected_digest: 'unavailable', observed_digest: 'unavailable', completed_destinations: [],
      ...(error instanceof ReleaseFailure ? error.fields : {}), http_status: Number.isInteger(error.status) ? error.status : null, request_id: error.response?.headers?.['x-github-request-id'] ?? null,
    });
  }
}

async function bytes(fetcher, url, token) {
  const response = await fetcher(url, { headers: token ? { Authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(120000) });
  requireThat(response.ok, 'worker_release_download_failed', { http_status: response.status, operation: token ? 'registry_download' : 'public_download' });
  const length = Number(response.headers.get('content-length'));
  requireThat(!length || length <= 64 * 1024 * 1024, 'worker_release_download_too_large');
  const parts = [];
  let size = 0;
  for await (const part of response.body) {
    size += part.length;
    requireThat(size <= 64 * 1024 * 1024, 'worker_release_download_too_large');
    parts.push(part);
  }
  return Buffer.concat(parts);
}

async function registryVersion(fetcher, token, version) {
  const response = await fetcher('https://npm.pkg.github.com/@markhuangai%2faaa-muse-worker', { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120000) });
  if (response.status === 404) return null;
  requireThat(response.ok, 'worker_release_registry_metadata_failed', { http_status: response.status });
  const metadata = await response.json();
  return metadata.versions?.[version] ?? null;
}

function matchingBytes(actual, expected, destination) {
  const observed = hash(actual);
  requireThat(observed === expected, 'worker_release_artifact_conflict', { destination, expected_digest: expected, observed_digest: observed });
}

export async function publishRelease({ github, context, prepared, receipt, archive, token, fetcher = fetch, publishNpm = path => {
  try { execFileSync('npm', ['publish', path, '--ignore-scripts', '--registry', 'https://npm.pkg.github.com', '--tag', 'rc', '--json', '--silent'], { env: { ...process.env, NODE_AUTH_TOKEN: token }, stdio: 'pipe', maxBuffer: 6144 }); }
  catch (error) {
    let npmCode = 'unavailable';
    try { const value = JSON.parse(String(error.stdout)); if (/^E[A-Z0-9_]+$/.test(value.error?.code ?? '')) npmCode = value.error.code; } catch { /* Raw registry error bodies are excluded by the repository CI exposure policy. */ }
    throw new ReleaseFailure('worker_release_npm_publish_failed', { process_status: error.status ?? null, process_code: typeof error.code === 'string' ? error.code : null, npm_code: npmCode, raw_output_omitted: true, omission_reason: 'authentication_material_protection' });
  }
} }) {
  const { source_sha, version, tag } = prepared;
  let operation = 'package_validation', destination = 'local_archive', expectedDigest = receipt.sha256 ?? 'unavailable', observedDigest = 'unavailable';
  const completed = [];
  const at = (nextOperation, nextDestination, expected = receipt.sha256) => { operation = nextOperation; destination = nextDestination; expectedDigest = expected; observedDigest = 'unavailable'; };
  const evidence = () => ({ source_sha, version, tag, operation, destination, expected_digest: expectedDigest, observed_digest: observedDigest, completed_destinations: [...completed] });
  try {
  requireThat(prepared.should_publish && rc.test(version) && tag === 'worker-v' + version && sha.test(source_sha), 'worker_release_invalid_preparation');
  requireThat(receipt.source?.source_sha === source_sha && receipt.source.source_dirty === false && receipt.source.package_version === version && receipt.version === version && receipt.package === '@markhuangai/aaa-muse-worker', 'worker_release_package_identity_mismatch');
  matchingBytes(archive, receipt.sha256, 'local_archive');
  observedDigest = hash(archive);
  at('source_verification', 'source_repository');
  requireThat(await resolvePublication({ github, context }) === source_sha, 'worker_release_source_changed');
  let ref;
  at('tag_lookup', 'git_tag');
  try { ref = (await github.rest.git.getRef({ ...context.repo, ref: 'tags/' + tag })).data; }
  catch (error) { if (error.status !== 404) throw error; }
  if (ref) requireThat(ref.object.type === 'commit' && ref.object.sha === source_sha, 'worker_release_tag_conflict', { expected_source: source_sha, observed_source: ref.object.sha });
  else {
    at('tag_creation', 'git_tag');
    await github.rest.git.createRef({ ...context.repo, ref: 'refs/tags/' + tag, sha: source_sha });
    at('tag_confirmation', 'git_tag');
    ref = (await github.rest.git.getRef({ ...context.repo, ref: 'tags/' + tag })).data;
    requireThat(ref.object.type === 'commit' && ref.object.sha === source_sha, 'worker_release_tag_conflict', { expected_source: source_sha, observed_source: ref.object.sha });
  }
  completed.push('git_tag');
  logEvent(null, 'info', 'worker.release.tag_verified', { ...evidence(), outcome: 'verified' });
  at('registry_metadata', 'github_packages');
  let metadata = await registryVersion(fetcher, token, version);
  if (!metadata) {
    at('npm_publish', 'github_packages');
    logEvent(null, 'info', 'worker.release.registry_started', { source_sha, version, archive_sha256: receipt.sha256 });
    await publishNpm(receipt.archive);
    at('registry_metadata_confirmation', 'github_packages');
    metadata = await registryVersion(fetcher, token, version);
  }
  requireThat(metadata?.name === receipt.package && metadata.version === version, 'worker_release_registry_identity_mismatch');
  const tarball = new URL(metadata.dist?.tarball ?? '');
  requireThat(tarball.protocol === 'https:' && tarball.hostname === 'npm.pkg.github.com' && !tarball.username && !tarball.password, 'worker_release_registry_url_unsafe');
  at('registry_download_verification', 'github_packages');
  const registryBytes = await bytes(fetcher, tarball.href, token);
  observedDigest = hash(registryBytes);
  matchingBytes(registryBytes, receipt.sha256, 'github_packages');
  completed.push('github_packages');
  logEvent(null, 'info', 'worker.release.destination_verified', { ...evidence(), outcome: 'verified' });
  let release;
  at('release_lookup', 'github_release');
  try { release = (await github.rest.repos.getReleaseByTag({ ...context.repo, tag })).data; }
  catch (error) { if (error.status !== 404) throw error; }
  if (!release) {
    at('release_creation', 'github_release');
    release = (await github.rest.repos.createRelease({ ...context.repo, tag_name: tag, target_commitish: source_sha, name: tag, prerelease: true, draft: false, make_latest: 'false', body: 'Worker installation candidate. Muse inference and refresh recovery remain unverified; require issue #7 live qualification.' })).data;
  }
  requireThat(!release.draft && release.prerelease && release.tag_name === tag, 'worker_release_destination_conflict');
  const name = 'markhuangai-aaa-muse-worker-' + version + '.tgz';
  const manifest = Buffer.from(JSON.stringify({ package: receipt.package, version, source_sha, archive: name, sha256: receipt.sha256 }, null, 2) + '\n');
  const files = new Map([[name, archive], ['SHA256SUMS', Buffer.from(`${receipt.sha256}  ${name}\n`)], ['worker-release.json', manifest]]);
  for (const [assetName, content] of files) {
    const existing = release.assets.filter(asset => asset.name === assetName);
    requireThat(existing.length <= 1, 'worker_release_ambiguous_assets');
    if (!existing.length) {
      at('asset_upload', 'public_release/' + assetName, hash(content));
      await github.rest.repos.uploadReleaseAsset({ ...context.repo, release_id: release.id, name: assetName, data: content, headers: { 'content-type': 'application/octet-stream', 'content-length': content.length } });
    }
    const publicURL = `https://github.com/markhuangai/AaA-muse-ai/releases/download/${tag}/${assetName}`;
    at('public_download_verification', 'public_release/' + assetName, hash(content));
    const publicBytes = await bytes(fetcher, publicURL);
    observedDigest = hash(publicBytes);
    matchingBytes(publicBytes, hash(content), 'public_release/' + assetName);
    completed.push('public_release/' + assetName);
    logEvent(null, 'info', 'worker.release.destination_verified', { ...evidence(), outcome: 'verified' });
  }
  at('source_reverification', 'source_repository');
  requireThat(await resolvePublication({ github, context }) === source_sha, 'worker_release_source_changed');
  const marker = `<!-- aaa-muse-worker:verified:${source_sha}:${receipt.sha256} -->`;
  const existingMarker = /<!-- aaa-muse-worker:verified:[^>]* -->/.exec(release.body ?? '');
  requireThat(!existingMarker || existingMarker[0] === marker, 'worker_release_receipt_conflict');
  if (!existingMarker) {
    at('completion_marker_publication', 'release_receipt');
    await github.rest.repos.updateRelease({ ...context.repo, release_id: release.id, body: (release.body ?? '') + '\n\n' + marker });
  }
  logEvent(null, 'info', 'worker.release.verified', { source_sha, version, archive_sha256: receipt.sha256, registry: receipt.package, public_url: `https://github.com/markhuangai/AaA-muse-ai/releases/download/${tag}/${name}`, destinations: ['github_packages', 'public_release'], outcome: 'complete' });
  } catch (error) {
    const safeCause = error instanceof ReleaseFailure ? error.message : /^publication_[a-z_]+$/.test(error.message ?? '') ? error.message : error.status === 403 ? 'permission_or_rate_limit' : 'required_api_operation_failed';
    throw new ReleaseFailure(safeCause, { ...evidence(), ...(error instanceof ReleaseFailure ? error.fields : {}), http_status: Number.isInteger(error.status) ? error.status : error.fields?.http_status ?? null, request_id: error.response?.headers?.['x-github-request-id'] ?? null });
  }
}

export function reportReleaseFailure(core, error, fields = {}) {
  logEvent(core, 'error', 'worker.release.failed', { ...fields, ...(error instanceof ReleaseFailure ? error.fields : {}), cause: error instanceof ReleaseFailure ? error.message : 'required_api_operation_failed', http_status: Number.isInteger(error.status) ? error.status : error.fields?.http_status ?? null, request_id: error.response?.headers?.['x-github-request-id'] ?? error.fields?.request_id ?? null, outcome: 'incomplete' });
  core.setFailed('Worker publication failed; inspect worker.release.failed evidence. Existing artifacts were preserved.');
}
