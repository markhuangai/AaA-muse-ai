import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { ReleaseFailure } from './worker-release.mjs';

export const repository = 'markhuangai/AaA-muse-ai';
export const imageName = 'ghcr.io/markhuangai/aaa-muse-ai';
export const packageName = '@markhuangai/aaa-muse-worker';
export const sha = value => /^[a-f0-9]{40}$/.test(value ?? '');
export const digest = value => /^[a-f0-9]{64}$/.test(value ?? '');
export const imageDigest = value => /^sha256:[a-f0-9]{64}$/.test(value ?? '');
export const hash = value => createHash('sha256').update(value).digest('hex');
export const jsonBytes = value => Buffer.from(JSON.stringify(value, null, 2) + '\n');
export const need = (ok, cause, fields = {}) => { if (!ok) throw new ReleaseFailure(cause, fields); };
export const archiveName = version => `markhuangai-aaa-muse-worker-${version}.tgz`;
export const imageTags = manifest => manifest.publication_kind === 'candidate'
  ? [`candidate-${manifest.version}`, `sha-${manifest.source_sha}-${manifest.version}`]
  : [manifest.version, `sha-${manifest.source_sha}`];

export function inspectWorker(archive, { read = readFileSync, execute = execFileSync } = {}) {
  return inspectWorkerBytes(read(archive), { execute });
}

export function inspectWorkerBytes(bytes, { execute = execFileSync } = {}) {
  const extract = path => execute('tar', ['-xOzf', '-', path], { input: bytes, maxBuffer: 64 * 1024 * 1024, stdio: ['pipe', 'pipe', 'pipe'] });
  const metadata = JSON.parse(extract('package/package.json'));
  const build = JSON.parse(extract('package/dist/build.json'));
  need(metadata.name === packageName && metadata.version === build.package_version && sha(build.source_sha), 'product_release_archive_identity_mismatch');
  return { package: metadata.name, version: metadata.version, sha256: hash(bytes), source: build,
    installer_sha256: hash(extract('package/setup/install.sh')) };
}

export function makeManifest({ source_sha, tree_sha, version, image_digest, image_config_digest, worker, publication_kind = 'rc' }) {
  const manifest = { schema_version: 2, version, source_sha, tree_sha, protocol_version: 1, publication_kind,
    image: imageName + '@' + image_digest, image_config_digest,
    worker: { package: packageName, version, sha256: worker.sha256, archive: archiveName(version) },
    installer: { path: 'package/setup/install.sh', sha256: worker.installer_sha256 },
    outcome: 'complete', live_qualification: 'not_established' };
  need(worker.source?.source_sha === source_sha && worker.source.source_dirty === false && worker.source.package_version === version && worker.version === version,
    'product_release_worker_identity_mismatch');
  return validateManifest(manifest);
}

export function validateManifest(value, { historical = false } = {}) {
  need(value && sha(value.source_sha) && imageDigest(value.image_config_digest) &&
    value.image?.startsWith(imageName + '@') && imageDigest(value.image.slice(imageName.length + 1)) &&
    value.worker?.package === packageName && value.worker.version === value.version && digest(value.worker.sha256) &&
    value.worker.archive === archiveName(value.version) && value.outcome === 'complete' && value.live_qualification === 'not_established', 'product_release_manifest_invalid');
  if (value.schema_version === undefined && historical) return { ...value, missing_identity_fields: ['tree_sha', 'protocol_version', 'installer.sha256'] };
  need(value.schema_version === 2 && sha(value.tree_sha) && value.protocol_version === 1 &&
    ['rc', 'candidate'].includes(value.publication_kind) && value.installer?.path === 'package/setup/install.sh' && digest(value.installer.sha256) &&
    (value.publication_kind === 'candidate' ? value.version === '0.1.0' : /^0\.1\.0-rc\.(0|[1-9][0-9]*)$/.test(value.version)), 'product_release_manifest_identity_incomplete');
  return value;
}

export function sameDigest(observed, expected, destination) {
  need(observed === expected, 'product_release_artifact_conflict', { destination, expected_digest: expected, observed_digest: observed });
}
