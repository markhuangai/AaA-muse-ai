import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { imageConfigDigest } from './image-policy.mjs';
import { inspectWorker, need, hash, jsonBytes, sameDigest, sameRC, validRCIdentity } from './release-manifest.mjs';
import { verifyImageConfig } from './release-verify.mjs';

export function freezeBundle(directory, prepared, { receiptPath = '.artifacts/worker-package/latest.json', image = 'aaa-muse-stable:prepared',
  read = readFileSync, write = writeFileSync, copy = copyFileSync, mkdir = mkdirSync, execute = execFileSync } = {}) {
  mkdir(directory, { recursive: true, mode: 0o700 });
  need(validRCIdentity(prepared.source_rc), 'product_release_rc_identity_invalid');
  const receipt = JSON.parse(read(receiptPath));
  const worker = inspectWorker(receipt.archive, { read, execute });
  need(worker.source.source_sha === prepared.source_sha && worker.version === prepared.version && worker.source.source_dirty === false, 'product_release_bundle_worker_mismatch');
  sameDigest(worker.sha256, receipt.sha256, 'prepared_worker');
  const inspected = JSON.parse(execute('docker', ['image', 'inspect', image], { encoding: 'utf8' }))[0];
  verifyImageConfig({ config: inspected.Config }, prepared);
  const bundle = { schema_version: 1, source_sha: prepared.source_sha, tree_sha: prepared.tree_sha, version: prepared.version, source_rc: prepared.source_rc,
    image_config_digest: imageConfigDigest(inspected), worker };
  execute('docker', ['save', image, '-o', join(directory, 'image.tar')], { stdio: ['ignore', 'ignore', 'pipe'] });
  bundle.image_archive_sha256 = hash(read(join(directory, 'image.tar')));
  copy(receipt.archive, join(directory, 'worker.tgz'));
  write(join(directory, 'bundle.json'), jsonBytes(bundle), { mode: 0o600 });
  return bundle;
}

export function verifyBundle(directory, prepared, { read = readFileSync, execute = execFileSync } = {}) {
  const bundle = JSON.parse(read(join(directory, 'bundle.json')));
  need(bundle.schema_version === 1 && bundle.source_sha === prepared.source_sha && bundle.tree_sha === prepared.tree_sha &&
    bundle.version === prepared.version && sameRC(bundle.source_rc, prepared.source_rc),
    'product_release_bundle_identity_mismatch');
  sameDigest(hash(read(join(directory, 'image.tar'))), bundle.image_archive_sha256, 'frozen_image_archive');
  const worker = inspectWorker(join(directory, 'worker.tgz'), { read, execute });
  need(JSON.stringify(worker) === JSON.stringify(bundle.worker) && worker.source.source_dirty === false && worker.source.source_sha === prepared.source_sha && worker.version === prepared.version,
    'product_release_bundle_worker_mismatch');
  return bundle;
}
