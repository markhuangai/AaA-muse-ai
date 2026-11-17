import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFixture } from './test/release-fixture.mjs';
import { publishRelease } from './worker-release.mjs';
import { publishCandidate } from './release-candidate.mjs';
import { promoteCandidate, verifyQualification } from './release-promote.mjs';
import { hash, jsonBytes } from './release-manifest.mjs';

const publish = f => publishCandidate({ ...f, publishWorker: options => publishRelease({ ...options, publishNpm: f.publishNpm }) });
export function qualification(f) {
  const receipt = { schema_version: 1, kind: 'final_candidate_qualification', manifest_sha256: hash(jsonBytes(f.manifest)),
    source_sha: f.source, tree_sha: f.tree, version: f.version, protocol_version: 1, image: f.manifest.image, image_config_digest: f.configDigest,
    worker_sha256: f.worker.sha256, installer_sha256: f.worker.installer_sha256, report_sha256: 'd'.repeat(64), run_id: 'controlled-test-only',
    finished_at: '2026-11-17T00:00:00Z', evidence_kind: 'live', verdict: 'pass', exports: [{ source: 'broker', sha256: 'f'.repeat(64) }] };
  const bytes = jsonBytes(receipt), digest = hash(bytes);
  return { receipt, qualificationBytes: bytes, qualificationSHA256: digest, manifestSHA256: receipt.manifest_sha256,
    confirmation: `promote ${f.version} ${receipt.manifest_sha256} ${digest}` };
}

test('candidate publication uses frozen final-version bytes, then retries without building or republishing', async t => {
  const f = await releaseFixture(t);
  const first = await publish(f);
  assert.equal(first.publication, 'complete'); assert.equal(first.version, '0.1.0');
  assert.equal(f.state.npm.version, '0.1.0'); assert.equal(f.state.tags.latest, undefined);
  assert(f.release.prerelease); assert.match(f.release.body, /aaa-muse-product:verified/);
  assert(f.state.images.has('candidate-0.1.0')); assert(!f.state.images.has('sha-' + f.source));
  assert(!f.state.commands.some(command => command.includes('build') || command.includes('pack')));
  const uploads = f.state.uploads, pushes = f.state.commands.filter(command => command.includes('push')).length;
  const second = await publish(f);
  assert.equal(second.manifest_sha256, first.manifest_sha256); assert.equal(f.state.uploads, uploads);
  assert.equal(f.state.commands.filter(command => command.includes('push')).length, pushes);
});

test('partial publication retains its destination ledger and resumes only the missing identical bytes', async t => {
  const f = await releaseFixture(t); f.state.failAsset = 'product-release.json';
  await assert.rejects(publish(f), error => {
    assert.equal(error.fields.operation, 'manifest_publication'); assert(error.fields.completed_destinations.includes('github_packages'));
    assert.equal(error.fields.destination, 'product-release.json'); assert.equal(error.fields.http_status, 503); return true;
  });
  assert(f.state.npm); assert(!f.release.body.includes('aaa-muse-product:verified'));
  const commands = f.state.commands.length; f.state.failAsset = null;
  assert.equal((await publish(f)).publication, 'complete');
  assert.equal(f.state.commands.length, commands);
});

test('candidate refusal preserves conflicting image destinations and altered frozen artifacts', async t => {
  const f = await releaseFixture(t);
  const other = jsonBytes({ config: { digest: 'sha256:' + hash('{}') } });
  f.state.images.set('candidate-0.1.0', other); f.state.configBytes = Buffer.from('{}');
  await assert.rejects(publish(f), /artifact_conflict/);
  assert.deepEqual(f.state.images.get('candidate-0.1.0'), other); assert.equal(f.state.npm, null);
  f.state.images.clear(); writeFileSync(join(f.directory, 'image.tar'), 'changed');
  await assert.rejects(publish(f), /artifact_conflict/); assert.equal(f.state.uploads, 0);
});

test('candidate reconciliation copies a verified existing manifest for a missing tag without pushing new bytes', async t => {
  const f = await releaseFixture(t); f.seed();
  f.state.images.delete(`sha-${f.source}-0.1.0`);
  const result = await publish(f); assert.equal(result.publication, 'complete');
  assert(f.state.commands.some(command => command.includes('imagetools')));
  assert(!f.state.commands.some(command => command.includes('push')));
});

test('matching npm bytes recover an absent candidate tag and preserve a conflicting distribution tag', async t => {
  const f = await releaseFixture(t); f.seed(); delete f.state.tags.candidate;
  await publish(f);
  assert.equal(f.state.tags.candidate, f.version);
  assert.deepEqual(f.state.commands.filter(command => command[0] === 'npm').map(command => command.slice(1, 4)), [['dist-tag', 'add', '@markhuangai/aaa-muse-worker@0.1.0']]);
  assert(!f.state.commands.some(command => command.includes('publish')));
  f.state.tags.candidate = '0.2.0'; const before = f.state.commands.length;
  await assert.rejects(publish(f), /distribution_conflict/);
  assert.equal(f.state.tags.candidate, '0.2.0'); assert.equal(f.state.commands.length, before);
});

test('stable promotion requires explicit pinned qualification, preserves candidate bytes and has no build/publish path', async t => {
  const f = await releaseFixture(t); f.seed(); const q = qualification(f);
  const before = new Map(f.state.assets);
  const result = await promoteCandidate({ ...f, ...q });
  assert.equal(result.outcome, 'complete'); assert.equal(result.live_qualification, 'pass');
  assert.equal(f.state.tags.latest, '0.1.0'); assert(!f.release.prerelease);
  assert(f.state.images.has('0.1.0')); assert(f.state.images.has('latest'));
  for (const [name, bytes] of before) assert.deepEqual(f.state.assets.get(name), bytes);
  assert(!f.state.commands.some(command => command.includes('build') || command.includes('pack') || command.includes('publish') || command.includes('push')));
  const count = f.state.commands.length;
  await promoteCandidate({ ...f, ...q });
  assert.equal(f.state.commands.length, count + 1);
});

test('promotion gates reject missing, inconclusive, synthetic and mismatched receipts before distribution changes', async t => {
  const f = await releaseFixture(t); f.seed();
  for (const change of [q => { q.receipt.evidence_kind = 'synthetic'; }, q => { q.receipt.verdict = 'inconclusive'; },
    q => { q.receipt.manifest_sha256 = 'f'.repeat(64); }, q => { q.receipt.source_sha = 'f'.repeat(40); },
    q => { q.receipt.worker_sha256 = 'f'.repeat(64); }, q => { q.receipt.exports = []; }, q => { q.receipt.finished_at = ''; }]) {
    const q = qualification(f); change(q);
    assert.throws(() => verifyQualification(q.receipt, f.manifest, q.manifestSHA256));
  }
  const q = qualification(f);
  await assert.rejects(promoteCandidate({ ...f, ...q, confirmation: '' }), /confirmation_required/);
  await assert.rejects(promoteCandidate({ ...f, ...q, qualificationBytes: Buffer.from('wrong') }), /artifact_conflict/);
  const bad = qualification(f); bad.receipt.verdict = 'inconclusive'; bad.qualificationBytes = jsonBytes(bad.receipt); bad.qualificationSHA256 = hash(bad.qualificationBytes);
  bad.confirmation = `promote ${f.version} ${bad.manifestSHA256} ${bad.qualificationSHA256}`;
  await assert.rejects(promoteCandidate({ ...f, ...bad }), /receipt_rejected/);
  assert.equal(f.state.commands.length, 0); assert(f.release.prerelease);
});

test('promotion stops on distribution conflicts, retains partial progress, and reports causal evidence', async t => {
  const f = await releaseFixture(t); f.seed(); const q = qualification(f);
  f.state.tags.latest = '0.2.0'; await assert.rejects(promoteCandidate({ ...f, ...q }), /distribution_conflict/); delete f.state.tags.latest;
  f.release.immutable = true; await assert.rejects(promoteCandidate({ ...f, ...q }), /release_unavailable/); f.release.immutable = false;
  const execute = f.execute;
  f.execute = (command, args, options) => { if (command === 'npm') throw { status: 503, message: 'secret-sentinel' }; return execute(command, args, options); };
  await assert.rejects(promoteCandidate({ ...f, ...q }), error => {
    assert(error.fields.completed_destinations.includes('latest')); assert.equal(error.fields.operation, 'npm_distribution_promotion');
    assert.equal(error.fields.uncertain_destination, 'npm_latest'); assert(!error.message.includes('secret-sentinel')); return true;
  });
  assert(f.release.prerelease); f.execute = execute;
  assert.equal((await promoteCandidate({ ...f, ...q })).outcome, 'complete');
});
