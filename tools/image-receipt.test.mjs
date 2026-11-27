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
  files.write('worker/dist/errors.js', 'errors bytes');
  files.write('worker/dist/json.js', 'json bytes');
  files.write('.artifacts/worker-package/pack/unpacked/package/setup/install.sh', 'installer bytes');
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
  assert.deepEqual(receipt.decoder_sha256, { 'worker/dist/diagnostics.js': hash('diagnostics bytes'), 'worker/dist/state.js': hash('state bytes'),
    'worker/dist/errors.js': hash('errors bytes'), 'worker/dist/json.js': hash('json bytes') });
  assert.equal(receipt.installer_sha256, hash('installer bytes'));
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

test('image reuse rejects changed and missing transitive imports and unpacked installer', t => {
  const f = setup(t);
  f.ready();
  for (const name of ['errors', 'json']) {
    const path = `worker/dist/${name}.js`;
    f.write(path, 'changed bytes');
    const changed = f.run('verify');
    rejected(changed, 'worker_decoder_digest_mismatch');
    assert.equal(changed.event.expected_decoder_sha256[path], hash(`${name} bytes`));
    assert.equal(changed.event.observed_decoder_sha256[path], hash('changed bytes'));
    rmSync(join(f.root, path));
    const missing = f.run('verify');
    rejected(missing, 'worker_decoders_unavailable');
    assert.deepEqual(missing.event.missing_dist_files, [path]);
    f.write(path, `${name} bytes`);
  }
  const installer = '.artifacts/worker-package/pack/unpacked/package/setup/install.sh';
  f.write(installer, 'changed installer');
  const changed = f.run('verify');
  rejected(changed, 'worker_installer_digest_mismatch');
  assert.equal(changed.event.expected_installer_sha256, hash('installer bytes'));
  assert.equal(changed.event.observed_installer_sha256, hash('changed installer'));
  rmSync(join(f.root, installer));
  rejected(f.run('verify'), 'worker_installer_unavailable');
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

test('prebuilt verification rejects source drift and missing diagnostics module', t => {
  const f = setup(t);
  f.ready();
  const original = f.read('tools/example.mjs');
  f.write('tools/example.mjs', 'export const value = 2;\n');
  const drift = f.run('verify');
  rejected(drift, 'source_drift');
  assert.notEqual(drift.event.expected_source.tree_sha256, drift.event.observed_source.tree_sha256);
  f.write('tools/example.mjs', original);
  rmSync(join(f.root, 'worker/dist/diagnostics.js'));
  const missing = f.run('verify');
  rejected(missing, 'worker_decoders_unavailable');
  assert.deepEqual(missing.event.missing_dist_files, ['worker/dist/diagnostics.js']);
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
  assert.equal(mismatch.event.expected_image_id, imageID);
  assert.equal(mismatch.event.observed_labels['org.opencontainers.image.version'], 'sha256:' + hash('2.0.0'));
  assert.deepEqual(mismatch.event.label_mismatches, ['org.opencontainers.image.version']);
  const canary = 'muse_worker_' + 'z'.repeat(43);
  f.writeImage(imageID, { ...labels, 'org.opencontainers.image.version': canary });
  const unsafe = f.run('verify');
  rejected(unsafe, 'image_labels_mismatch');
  assert.equal(unsafe.event.observed_labels['org.opencontainers.image.version'], 'invalid');
  assert.equal(JSON.stringify(unsafe.event).includes(canary), false);
  const missingLabels = { ...labels };
  delete missingLabels['org.opencontainers.image.version'];
  f.writeImage(imageID, missingLabels);
  const missing = f.run('verify');
  rejected(missing, 'image_labels_mismatch');
  assert.equal(missing.event.observed_labels['org.opencontainers.image.version'], 'missing');
  writeFileSync(f.inspection, 'not JSON');
  const unavailable = f.run('verify');
  rejected(unavailable, 'image_inspection_failed');
  assert.equal(unavailable.event.expected_image_id, imageID);
  assert.equal(unavailable.event.observed_image_id, null);
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

test('format-valid token labels and known credentials never enter image events', t => {
  const f = setup(t);
  f.ready();
  const previous = process.env.NODE_AUTH_TOKEN;
  try {
    const canary = 'd'.repeat(40);
    process.env.NODE_AUTH_TOKEN = canary;
    f.writeImage(imageID, { ...labels, 'org.opencontainers.image.revision': canary });
    const mismatch = f.run('verify');
    rejected(mismatch, 'image_labels_mismatch');
    assert.deepEqual(mismatch.event.label_mismatches, ['org.opencontainers.image.revision']);
    assert.equal(mismatch.event.observed_labels['org.opencontainers.image.revision'], 'sha256:' + hash(canary));
    assert.equal(JSON.stringify(mismatch.event).includes(canary), false);
    process.env.NODE_AUTH_TOKEN = sha;
    f.writeImage();
    const matched = f.run('verify');
    assert.equal(matched.status, 0);
    assert.equal(JSON.stringify(matched.event).includes(sha), false);
  } finally {
    if (previous === undefined) delete process.env.NODE_AUTH_TOKEN;
    else process.env.NODE_AUTH_TOKEN = previous;
  }
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
