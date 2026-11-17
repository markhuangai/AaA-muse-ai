import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { productFixture } from './test/product-fixture.mjs';
import { exportFixture } from './qualification-fixtures.mjs';
import { qualificationReceipt, createQualification, main } from './release-qualification.mjs';
import { makeManifest, jsonBytes, hash } from '../.github/scripts/release-manifest.mjs';

function fixture() {
  const f = JSON.parse(JSON.stringify(productFixture(true)).replaceAll('0.1.0-rc.7', '0.1.0'));
  const source = f.report.source;
  const manifest = makeManifest({ source_sha: source.service_sha, tree_sha: 'e'.repeat(40), version: source.service_version,
    image_digest: source.image_digest, image_config_digest: 'sha256:' + 'f'.repeat(64), publication_kind: 'candidate',
    worker: { version: source.worker_version, sha256: source.worker_sha256, installer_sha256: source.installer_sha256,
      source: { source_sha: source.service_sha, source_dirty: false, package_version: source.worker_version } } });
  return { ...f, manifest, manifestBytes: jsonBytes(manifest) };
}

test('qualification receipts require the existing complete real-logic validator and exact installed candidate identities', () => {
  const f = fixture();
  const result = qualificationReceipt(f.manifest, f.manifestBytes, f.report, f.evidence, jsonBytes(f.report));
  assert.equal(result.verdict, 'pass'); assert.equal(result.manifest_sha256, hash(f.manifestBytes));
  assert.equal(result.worker_sha256, f.report.source.worker_sha256);
  assert(!JSON.stringify(result).includes('client_driver'));
  for (const change of [r => { r.evidence_kind = 'synthetic'; }, r => { r.cases.pop(); }, r => { r.exports.push({ source: 'worker', file: 'missing' }); },
    r => { r.workers[0].installed_version = '0.1.0-rc.11'; }]) {
    const copy = structuredClone(f.report); change(copy);
    assert.throws(() => qualificationReceipt(f.manifest, f.manifestBytes, copy, f.evidence, jsonBytes(copy)), /qualification/);
  }
  const other = structuredClone(f.manifest); other.tree_sha = 'd'.repeat(40); other.installer.sha256 = 'e'.repeat(64);
  assert.throws(() => qualificationReceipt(other, jsonBytes(other), f.report, f.evidence, jsonBytes(f.report)), /identity_mismatch/);
});

test('adapter reopens protected reports and every export instead of trusting a declared verdict', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'aaa-release-qualification-'));
  t.after(() => rm(directory, { recursive: true }));
  const f = fixture(); f.report.exports = [];
  for (const [index, ref] of f.evidence.entries()) {
    const bytes = exportFixture(ref.events), file = `evidence-${index}.ndjson`;
    await writeFile(join(directory, file), bytes, { mode: 0o600 });
    f.report.exports.push({ source: ref.source, case_id: ref.case_id, file, sha256: hash(bytes) });
  }
  const reportPath = join(directory, 'report.json'), manifestPath = join(directory, 'manifest.json'), outputPath = join(directory, 'qualification.json');
  await writeFile(reportPath, jsonBytes(f.report), { mode: 0o600 }); await writeFile(manifestPath, f.manifestBytes);
  const result = await createQualification({ manifestPath, reportPath, outputPath });
  assert.equal(result.verdict, 'pass'); assert.equal(JSON.parse(await readFile(outputPath)).manifest_sha256, hash(f.manifestBytes));
  await assert.rejects(createQualification({ manifestPath, reportPath, outputPath }), { code: 'EEXIST' });
  await writeFile(join(directory, f.report.exports[0].file), 'changed');
  await assert.rejects(createQualification({ manifestPath, reportPath, outputPath: join(directory, 'bad.json') }), /not_passed/);
  assert.equal(await main([]), 1);
  assert.equal(await main([manifestPath, reportPath, join(directory, 'bad.json')]), 1);
});
