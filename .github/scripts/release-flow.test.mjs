import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFixture } from './test/release-fixture.mjs';
import { prepareRelease, publishRelease } from './worker-release.mjs';
import { publishCandidate } from './release-candidate.mjs';
import { promoteCandidate, verifyQualification } from './release-promote.mjs';
import { hash, jsonBytes } from './release-manifest.mjs';
import { prepareCandidate } from './release-control.mjs';
import { candidateNpmTag } from './release-versions.mjs';
import { verifyPublished } from './release-verify.mjs';

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
  const rcImage = f.state.images.get('sha-' + f.source);
  const first = await publish(f);
  assert.equal(first.publication, 'complete'); assert.equal(first.version, '0.1.0');
  assert.equal(f.state.npm.version, '0.1.0'); assert.equal(f.state.tags.latest, undefined);
  assert.equal(f.state.tags[candidateNpmTag(f.version)], f.version);
  assert(f.release.prerelease); assert.match(f.release.body, /aaa-muse-product:verified/);
  assert(f.state.images.has('candidate-0.1.0'));
  assert.deepEqual(f.state.images.get('sha-' + f.source), rcImage);
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
  assert.deepEqual(f.state.commands.slice(commands).map(args => args.slice(0, 5)),
    [['npm', 'dist-tag', 'add', '@markhuangai/aaa-muse-worker@0.1.0', 'candidate']]);
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

test('a version-specific npm candidate tag conflict blocks package publication', async t => {
  const f = await releaseFixture(t);
  const tag = candidateNpmTag(f.version);
  f.state.tags[tag] = '0.1.1';
  await assert.rejects(publish(f), error => error.message === 'product_release_candidate_distribution_conflict' &&
    error.fields.destination === tag && error.fields.observed_version === '0.1.1');
  assert.equal(f.state.npm, null);
  assert(!f.state.refs.has('tags/' + f.prepared.tag));
  assert.equal(f.state.tags[tag], '0.1.1');
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
  assert.equal(f.state.commands.length, count);
});

test('a newer complete RC blocks a fresh promotion before any stable write', async t => {
  const f = await releaseFixture(t); f.seed();
  const q = qualification(f);
  f.addRC('0.1.0-rc.14', { rcSource: 'b'.repeat(40) });
  await assert.rejects(promoteCandidate({ ...f, ...q }), error => {
    assert.equal(error.message, 'product_release_stale_rc');
    assert.equal(error.fields.expected_rc, 'v0.1.0-rc.13');
    assert.equal(error.fields.observed_rc, 'v0.1.0-rc.14');
    return true;
  });
  assert.equal(f.state.uploads, 0);
  assert.deepEqual(f.state.commands, []);
  assert(f.release.prerelease);
});

test('two successive candidates advance the verified aliases and keep the old exact release verifiable', async t => {
  const first = await releaseFixture(t, { version: '0.1.1' });
  await publish(first);
  const firstQualification = qualification(first);
  await promoteCandidate({ ...first, ...firstQualification });

  const source = 'b'.repeat(40);
  first.state.main = source;
  const repo = { full_name: 'markhuangai/AaA-muse-ai' };
  const context = { ...first.context, eventName: 'workflow_run', payload: { workflow_run: {
    id: 4, workflow_id: 7, event: 'push', conclusion: 'success', head_branch: 'main', head_sha: source, repository: repo, head_repository: repo,
  } } };
  const next = await prepareRelease({ ...first, context, paired: true });
  assert.equal(next.version, '0.1.2-rc.0');
  first.state.refs.set('tags/' + next.tag, { object: { type: 'commit', sha: source } });
  assert.equal((await prepareRelease({ ...first, context, paired: true })).version, next.version);
  const second = await releaseFixture(t, { version: '0.1.2', rcVersion: next.version, source, previous: first });
  assert.equal((await prepareCandidate(second)).version, second.version);
  await publish(second);
  assert.equal(second.state.tags.candidate, '0.1.2');
  assert.equal(second.state.tags.latest, '0.1.1');
  const startingCommands = second.state.commands.length;
  await promoteCandidate({ ...second, ...qualification(second) });
  assert.equal(second.state.tags.latest, '0.1.2');
  assert.equal(second.state.githubLatest, second.release.id);
  assert.deepEqual(second.state.images.get('latest'), second.state.images.get(second.imageDigest));
  assert.deepEqual(second.state.images.get('0.1.1'), first.state.images.get(first.imageDigest));
  assert(!second.state.commands.slice(startingCommands).some(command => command.includes('build') ||
    command.includes('pack') || command.includes('publish') || command.includes('push')));

  const commands = second.state.commands.length;
  const before = second.state.uploads;
  const historical = await verifyPublished({ ...second, tag: first.prepared.tag, sourceSHA: first.source, manifestSHA256: firstQualification.manifestSHA256 });
  assert.equal(historical.receipt.version, '0.1.1');
  await promoteCandidate({ ...second, ...firstQualification, version: first.version });
  assert.equal(second.state.commands.length, commands);
  assert.equal(second.state.uploads, before);
  assert.equal(second.state.tags.latest, '0.1.2');
  assert(second.state.requests.filter(request => request.url.startsWith('https://github.com/')).every(request => !request.authenticated));
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
  assert(f.release.prerelease);
  assert(f.state.assets.has('promotion-intent.json'));
  assert(!f.state.assets.has('promotion.json'));
  f.addRC('0.1.0-rc.14', { rcSource: 'b'.repeat(40) });
  const newer = await releaseFixture(t, { version: '0.1.1', rcVersion: '0.1.0-rc.14', source: 'b'.repeat(40), previous: f });
  newer.seed();
  await assert.rejects(promoteCandidate({ ...newer, ...qualification(newer) }), /other_promotion_incomplete/);
  f.execute = execute;
  assert.equal((await promoteCandidate({ ...f, ...q })).outcome, 'complete');
});

test('a saved intent without an actual stable write does not permit stale promotion', async t => {
  const f = await releaseFixture(t); f.seed();
  const q = qualification(f);
  const execute = f.execute;
  f.execute = (command, args, options) => {
    if (command === 'docker' && args[0] === 'buildx') throw { status: 1 };
    return execute(command, args, options);
  };
  await assert.rejects(promoteCandidate({ ...f, ...q }), /required_operation_failed/);
  assert(f.state.assets.has('promotion-intent.json'));
  assert(!f.state.images.has(f.version));
  f.addRC('0.1.0-rc.14', { rcSource: 'b'.repeat(40) });
  f.execute = execute;
  const before = { commands: f.state.commands.length, uploads: f.state.uploads };
  await assert.rejects(promoteCandidate({ ...f, ...q }), /stale_rc/);
  assert.equal(f.state.commands.length, before.commands);
  assert.equal(f.state.uploads, before.uploads);
  assert(f.release.prerelease);
});
