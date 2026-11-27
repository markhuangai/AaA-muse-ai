import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { main } from './image-receipt.mjs';
import { fixture } from './test/helpers.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const sha = 'a'.repeat(40);
const imageID = 'sha256:' + 'b'.repeat(64);
const labels = { 'org.opencontainers.image.revision': sha, 'org.opencontainers.image.version': '1.0.0-dev.0', 'io.aaa-muse.source-dirty': 'false' };

function setup(t) {
  const files = fixture(t);
  const archive = join(files.root, '.artifacts/worker-package/pack/worker.tgz');
  files.write('.artifacts/worker-package/pack/worker.tgz', 'worker bytes');
  const worker = { outcome: 'passed', version: '1.0.0-dev.0', archive, sha256: hash('worker bytes'),
    source: { source_sha: sha, source_dirty: false, package_version: '1.0.0-dev.0' } };
  const writeWorker = value => files.write('.artifacts/worker-package/latest.json', JSON.stringify(value));
  writeWorker(worker);
  files.write('worker/dist/diagnostics.js', 'diagnostics bytes');
  files.write('worker/dist/state.js', 'state bytes');
  const docker = join(files.root, 'docker-shim');
  const inspection = join(files.root, 'inspection.json');
  writeFileSync(docker, '#!/bin/sh\ncat ' + JSON.stringify(inspection) + '\n');
  chmodSync(docker, 0o755);
  const writeImage = (id = imageID, imageLabels = labels) => writeFileSync(inspection, JSON.stringify([{ Id: id, Config: { Labels: imageLabels } }]));
  writeImage();
  const args = mode => [mode, '--docker', docker, '--image', 'service:test', '--source-sha', sha, '--source-dirty', 'false', '--product-version', '1.0.0-dev.0'];
  const run = mode => {
    const lines = [], original = console.log;
    console.log = line => lines.push(line);
    try {
      const status = main(args(mode), { root: files.root, inspect: files.inspect });
      assert.equal(lines.length, 1);
      return { status, event: JSON.parse(lines[0].replace(/^::error::/, '')) };
    } finally { console.log = original; }
  };
  const ready = () => { for (const mode of ['capture', 'prepare', 'write']) assert.equal(run(mode).status, 0); };
  return { ...files, archive, worker, writeWorker, writeImage, inspection, args, run, ready };
}

function rejected(result, cause) {
  assert.equal(result.status, 1);
  assert.equal(result.event.event, 'ci.image_receipt_rejected');
  assert.equal(result.event.cause, cause);
  assert.equal(result.event.remediation, 'make image');
}

test('image reuse binds actual archive, image labels and exact decoder bytes', t => {
  const f = setup(t);
  f.ready();
  const receipt = JSON.parse(f.read('.artifacts/service-image/latest.json'));
  assert.equal(receipt.image_id, imageID);
  assert.equal(receipt.worker_sha256, hash('worker bytes'));
  assert.deepEqual(receipt.decoder_sha256, { 'worker/dist/diagnostics.js': hash('diagnostics bytes'), 'worker/dist/state.js': hash('state bytes') });
  assert.equal(f.run('verify').event.event, 'ci.image_receipt_verified');
  f.write('worker/dist/diagnostics.js', 'modified decoder');
  const changed = f.run('verify');
  rejected(changed, 'worker_decoder_digest_mismatch');
  assert.equal(changed.event.expected_decoder_sha256['worker/dist/diagnostics.js'], hash('diagnostics bytes'));
  assert.equal(changed.event.observed_decoder_sha256['worker/dist/diagnostics.js'], hash('modified decoder'));
  f.write('worker/dist/diagnostics.js', 'diagnostics bytes');
  rmSync(join(f.root, 'worker/dist/state.js'));
  const missing = f.run('verify');
  rejected(missing, 'worker_decoders_unavailable');
  assert.deepEqual(missing.event.missing_dist_files, ['worker/dist/state.js']);
});

test('source identity is captured before packaging and remains stable through image build', t => {
  const f = setup(t);
  assert.equal(f.run('capture').status, 0);
  f.write('tools/example.mjs', 'export const value = 2;\n');
  const changedBeforePackage = f.run('prepare');
  rejected(changedBeforePackage, 'source_drift');
  assert.notEqual(changedBeforePackage.event.expected_source.tree_sha256, changedBeforePackage.event.observed_source.tree_sha256);
  assert.equal(f.run('capture').status, 0);
  assert.equal(f.run('prepare').status, 0);
  f.write('tools/example.mjs', 'export const value = 3;\n');
  rejected(f.run('write'), 'source_drift');
  assert.throws(() => readFileSync(join(f.root, '.artifacts/service-image/latest.json')));
});

test('image ID, OCI labels, archive receipt and digest fail closed with structured evidence', t => {
  const f = setup(t);
  f.ready();
  f.writeImage('sha256:' + 'c'.repeat(64));
  const image = f.run('verify');
  rejected(image, 'image_id_mismatch');
  assert.equal(image.event.expected_image_id, imageID);
  assert.equal(image.event.observed_image_id, 'sha256:' + 'c'.repeat(64));
  f.writeImage(imageID, { ...labels, 'org.opencontainers.image.version': '2.0.0' });
  const mismatch = f.run('verify');
  rejected(mismatch, 'image_labels_mismatch');
  assert.equal(mismatch.event.observed_labels['org.opencontainers.image.version'], '2.0.0');
  const canary = 'muse_worker_' + 'z'.repeat(43);
  f.writeImage(imageID, { ...labels, 'org.opencontainers.image.version': canary });
  const unsafe = f.run('verify');
  rejected(unsafe, 'image_labels_mismatch');
  assert.equal(JSON.stringify(unsafe.event).includes(canary), false);
  f.writeImage();
  writeFileSync(f.archive, 'tampered bytes');
  const altered = f.run('verify');
  rejected(altered, 'worker_archive_digest_mismatch');
  assert.equal(altered.event.observed_worker_sha256, hash('tampered bytes'));
  rmSync(f.archive);
  rejected(f.run('verify'), 'worker_archive_unavailable');
  f.writeWorker({ ...f.worker, version: '2.0.0' });
  rejected(f.run('verify'), 'worker_receipt_identity_mismatch');
});

test('unavailable, malformed and mismatched evidence never certifies an image', t => {
  const f = setup(t);
  rejected(f.run('prepare'), 'source_capture_unavailable');
  assert.equal(f.run('capture').status, 0);
  f.writeWorker({ ...f.worker, sha256: 'bad' });
  rejected(f.run('prepare'), 'worker_receipt_invalid');
  f.writeWorker(f.worker);
  assert.equal(f.run('prepare').status, 0);
  writeFileSync(f.inspection, 'not JSON');
  rejected(f.run('write'), 'image_inspection_failed');
  f.writeImage('not-an-image-id');
  rejected(f.run('write'), 'image_id_invalid');
  f.writeImage();
  assert.equal(f.run('write').status, 0);
  const receipt = JSON.parse(f.read('.artifacts/service-image/latest.json'));
  f.write('.artifacts/service-image/latest.json', JSON.stringify({ ...receipt, worker_sha256: 'c'.repeat(64) }));
  rejected(f.run('verify'), 'worker_archive_binding_mismatch');
  f.write('.artifacts/service-image/latest.json', JSON.stringify({ ...receipt, labels: {} }));
  rejected(f.run('verify'), 'receipt_labels_mismatch');
  f.write('.artifacts/service-image/latest.json', '{');
  rejected(f.run('verify'), 'image_receipt_unavailable');
});

test('invalid arguments and source flags emit bounded safe errors', t => {
  const f = setup(t);
  const lines = [], original = console.log;
  console.log = line => lines.push(line);
  try {
    assert.equal(main(['invalid'], { root: f.root, inspect: f.inspect }), 1);
    const args = f.args('capture');
    args[args.indexOf('--source-dirty') + 1] = 'true';
    assert.equal(main(args, { root: f.root, inspect: f.inspect }), 1);
  } finally { console.log = original; }
  assert.deepEqual(lines.map(line => JSON.parse(line.replace(/^::error::/, '')).cause), ['invalid_operation', 'source_flags_mismatch']);
});
