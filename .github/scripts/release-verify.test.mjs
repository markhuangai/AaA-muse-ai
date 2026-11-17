import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFixture } from './test/release-fixture.mjs';
import { hash, jsonBytes, validateManifest, inspectWorker, makeManifest } from './release-manifest.mjs';
import { download, npmArchive, npmVersion, registryImage, ensureAsset } from './release-io.mjs';
import { verifyPublished, verifyImageConfig } from './release-verify.mjs';
import { freezeBundle, verifyBundle } from './release-bundle.mjs';

test('published verification reads real tar bytes and every destination; public downloads carry no authority', async t => {
  const f = await releaseFixture(t); f.seed();
  const result = await verifyPublished({ ...f, tag: f.prepared.tag, sourceSHA: f.source, manifestSHA256: hash(jsonBytes(f.manifest)) });
  assert.equal(result.receipt.publication, 'complete'); assert.equal(result.receipt.live_qualification, 'not_established');
  assert.equal(result.receipt.installer_sha256, f.worker.installer_sha256);
  assert.deepEqual(result.receipt.missing_identity_fields, []);
  assert(f.state.requests.filter(r => new URL(r.url).hostname === 'github.com').every(r => !r.authenticated));
  assert(f.state.requests.some(r => new URL(r.url).hostname === 'npm.pkg.github.com' && r.authenticated));
});

test('historical receipts remain readable and explicitly fail exact final-candidate requirements', async t => {
  const f = await releaseFixture(t);
  const legacy = structuredClone(f.manifest); delete legacy.schema_version; delete legacy.tree_sha; delete legacy.protocol_version; delete legacy.installer;
  assert.equal(validateManifest(legacy, { historical: true }).missing_identity_fields.length, 3);
  assert.throws(() => validateManifest(legacy), /identity_incomplete/);
  assert.throws(() => validateManifest(null), /manifest_invalid/);
  for (const change of [m => { m.worker.sha256 = 'x'; }, m => { m.worker.archive = 'other.tgz'; }, m => { m.image = 'foreign'; },
    m => { m.protocol_version = 2; }, m => { m.installer.sha256 = 'x'; }, m => { m.version = '1.0.0'; }]) {
    const m = structuredClone(f.manifest); change(m); assert.throws(() => validateManifest(m));
  }
  assert.throws(() => makeManifest({ ...f.manifest, image_digest: f.imageDigest, worker: { ...f.worker, source: { ...f.worker.source, source_dirty: true } } }), /worker_identity/);
});

test('identity, destination, and anonymous content failures cannot produce successful verification', async t => {
  const f = await releaseFixture(t); f.seed();
  const run = options => verifyPublished({ ...f, tag: f.prepared.tag, sourceSHA: f.source, manifestSHA256: hash(jsonBytes(f.manifest)), ...options });
  await assert.rejects(run({ tag: '' }), /selectors/);
  await assert.rejects(run({ manifestSHA256: '0'.repeat(64) }), /artifact_conflict/);
  f.state.tree = 'f'.repeat(40); await assert.rejects(run(), /source_tree/); f.state.tree = f.tree;
  f.state.refs.get('tags/' + f.prepared.tag).object.sha = 'f'.repeat(40); await assert.rejects(run(), /tag_conflict/);
  f.state.refs.get('tags/' + f.prepared.tag).object.sha = f.source;
  const saved = f.state.assets.get(f.manifest.worker.archive);
  f.state.assets.delete(f.manifest.worker.archive); await assert.rejects(run(), /download_failed/); f.state.assets.set(f.manifest.worker.archive, saved);
  f.state.npmBytes = Buffer.from('other archive'); await assert.rejects(run(), /artifact_conflict/); delete f.state.npmBytes;
  delete f.state.tags.candidate; await assert.rejects(run(), /distribution_missing/); f.state.tags.candidate = f.version;
  f.state.images.delete('candidate-' + f.version); await assert.rejects(run(), /destination_missing/);
  assert.throws(() => verifyImageConfig({}, f.manifest), /embedded_image/);
  await assert.rejects(run({ sourceSHA: 'f'.repeat(40) }), /requested_identity/);
});

test('downloads and registry readers enforce bounds, digest linkage, destination scope and explicit errors', async t => {
  const f = await releaseFixture(t); f.seed();
  const response = make => async () => make();
  await assert.rejects(download('https://example.test', { fetcher: response(() => new Response('x'.repeat(20))), limit: 10 }), /too_large/);
  await assert.rejects(download('https://example.test', { fetcher: response(() => new Response(null)) }), /incomplete/);
  await assert.rejects(download('https://example.test', { fetcher: response(() => new Response('x', { headers: { 'content-length': '99' } })), limit: 10 }), /incomplete/);
  const redirect = new Response('x'); Object.defineProperty(redirect, 'url', { value: 'http://unsafe.test' });
  await assert.rejects(download('https://example.test', { fetcher: async () => redirect }), /redirect_unsafe/);
  await assert.rejects(npmArchive({ name: f.worker.package, version: f.version, dist: { tarball: 'https://foreign.test/archive' } }, f), /url_unsafe/);
  await assert.rejects(npmArchive(null, f), /identity/);
  assert.equal((await npmVersion(f.version, { fetcher: response(() => new Response('', { status: 404 })) })).metadata, null);
  await assert.rejects(npmVersion(f.version, { fetcher: response(() => new Response('', { status: 403 })) }), /metadata_failed/);
  await assert.rejects(npmVersion(f.version, { fetcher: response(() => new Response('x'.repeat(1024 * 1024 + 1))) }), /too_large/);
  await assert.rejects(registryImage('candidate', { fetcher: response(() => new Response('', { status: 403 })) }), /auth_failed/);
  await assert.rejects(registryImage('candidate', { fetcher: response(() => Response.json({})) }), /token_missing/);
  let calls = 0;
  await assert.rejects(registryImage('candidate', { fetcher: async () => ++calls === 1 ? Response.json({ token: 'test' }) : new Response('', { status: 503 }) }), /image_read_failed/);
  calls = 0;
  await assert.rejects(registryImage('candidate', { fetcher: async () => ++calls === 1 ? Response.json({ token: 'test' }) : new Response('{}', { headers: { 'docker-content-digest': 'sha256:' + hash('{}') } }) }), /config_missing/);
  f.state.configBytes = Buffer.from('{}'); await assert.rejects(registryImage(f.imageDigest, f), /artifact_conflict/);
});

test('frozen bundles retain exact image, worker and installer bytes and reject altered recovery input', async t => {
  const f = await releaseFixture(t);
  assert.equal(verifyBundle(f.directory, f.prepared, f).worker.sha256, f.worker.sha256);
  const receipt = { ...f.worker, archive: join(f.directory, 'worker.tgz') };
  writeFileSync(join(f.directory, 'package-receipt.json'), jsonBytes(receipt));
  const frozen = freezeBundle(join(f.directory, 'frozen'), f.prepared, { execute: f.execute, receiptPath: join(f.directory, 'package-receipt.json') });
  assert.equal(frozen.worker.installer_sha256, f.worker.installer_sha256);
  assert.equal(hash(readFileSync(join(f.directory, 'frozen/worker.tgz'))), f.worker.sha256);
  assert.throws(() => verifyBundle(f.directory, { ...f.prepared, tree_sha: 'f'.repeat(40) }, f), /bundle_identity/);
  writeFileSync(join(f.directory, 'image.tar'), 'changed'); assert.throws(() => verifyBundle(f.directory, f.prepared, f), /artifact_conflict/);
  const changed = { ...f.prepared, version: '0.1.1' };
  assert.throws(() => freezeBundle(join(f.directory, 'bad'), changed, { execute: f.execute, receiptPath: join(f.directory, 'package-receipt.json') }), /worker_mismatch/);
  const legacy = inspectWorker(join(f.directory, 'worker.tgz')); assert.equal(legacy.source.source_dirty, false);
});

test('asset reconciliation preserves existing bytes and refuses duplicate or changed assets', async t => {
  const f = await releaseFixture(t); f.seed();
  const before = f.state.uploads;
  await ensureAsset({ ...f, name: 'new.json', bytes: Buffer.from('immutable') });
  assert.equal(f.state.uploads, before + 1);
  await ensureAsset({ ...f, name: 'new.json', bytes: Buffer.from('immutable') });
  assert.equal(f.state.uploads, before + 1);
  await assert.rejects(ensureAsset({ ...f, name: 'new.json', bytes: Buffer.from('different') }), /conflict/);
  f.release.assets.push({ name: 'new.json' });
  await assert.rejects(ensureAsset({ ...f, name: 'new.json', bytes: Buffer.from('immutable') }), /ambiguous/);
});
