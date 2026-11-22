import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { releaseFixture } from './test/release-fixture.mjs';
import { prepareRelease, publishRelease } from './worker-release.mjs';
import { publishCandidate } from './release-candidate.mjs';
import { promoteStable } from './release-promote.mjs';
import { hash, jsonBytes } from './release-manifest.mjs';
import { bundleName, prepareStableRelease } from './release-control.mjs';
import { latestStableRelease, readProductRelease } from './release-history.mjs';
import { candidateNpmTag } from './release-versions.mjs';
import { verifyPublished } from './release-verify.mjs';

const publish = f => publishCandidate({ ...f, publishWorker: options => publishRelease({ ...options, publishNpm: f.publishNpm }) });
const promote = (f, options) => promoteStable({ ...f, ...options });

test('major-zero frozen recovery verifies original identity without rebuilding or promoting', async t => {
  const f = await releaseFixture(t, { version: '0.1.0', rcVersion: '0.1.0-rc.13' });
  const active = f.addRC('1.0.0-rc.0', { rcSource: 'b'.repeat(40) });
  const next = await prepareStableRelease({ ...f, prereleaseTag: active.release.tag_name, version: '1.0.0' });
  assert.equal(next.source_sha, active.source);
  assert.equal(next.resume_run_id, null);
  await assert.rejects(prepareStableRelease(f), /original_bundle_unavailable/);
  f.state.runs = [{ id: 72 }];
  const artifact = { id: 54, name: bundleName(f.prepared), run_id: 72, expired: true };
  f.state.artifacts = [artifact];
  const original = { workflow_id: 7, event: 'workflow_dispatch', head_branch: 'main',
    repository: { full_name: 'markhuangai/AaA-muse-ai' }, head_repository: { full_name: 'markhuangai/AaA-muse-ai' } };
  f.state.originalRuns.set(72, original);
  await assert.rejects(prepareStableRelease(f), /original_bundle_unavailable/);
  artifact.expired = false; original.head_branch = 'other';
  await assert.rejects(prepareStableRelease(f), /resume_run_untrusted/);
  original.head_branch = 'main';
  const prepared = await prepareStableRelease(f);
  assert.equal(prepared.recovery_only, true);
  assert.equal(prepared.resume_run_id, 72);
  assert.equal(prepared.resume_artifact_id, 54);
  await assert.rejects(publish({ ...f, prepared: { ...prepared, resume_artifact_id: 55 } }), /original_bundle_unavailable/);
  writeFileSync(join(f.directory, 'bundle.json'), jsonBytes({ ...f.bundle, source_rc: { ...f.bundle.source_rc, manifest_sha256: 'f'.repeat(64) } }));
  await assert.rejects(publish({ ...f, prepared }), /bundle_identity_mismatch/);
  assert.equal(f.state.commands.length, 0);
  assert.equal(f.state.uploads, 0);
  writeFileSync(join(f.directory, 'bundle.json'), jsonBytes(f.bundle));
  const receipt = await publish({ ...f, prepared });
  assert.equal(receipt.publication, 'complete');
  assert.equal(f.state.tags[candidateNpmTag(f.version)], f.version);
  assert.equal(f.state.tags.candidate, undefined);
  assert.equal(f.state.tags.latest, undefined);
  assert(!f.state.images.has(f.version) && !f.state.images.has('latest'));
  assert(!f.state.commands.some(command => command[0] === 'docker' &&
    (command[1] === 'build' || command[1] === 'buildx' && command[2] === 'build')));
  await assert.rejects(promote(f, { prepared, manifestSHA256: receipt.manifest_sha256 }), /historical_candidate_only/);
  assert.equal((await prepareStableRelease(f)).candidate_ready, true);
  assert(!f.state.assets.has('promotion-intent.json'));
});

test('candidate publication uses frozen final-version bytes, then retries without building or republishing', async t => {
  const f = await releaseFixture(t);
  const rcImage = f.state.images.get('sha-' + f.source);
  const first = await publish(f);
  assert.equal(first.publication, 'complete'); assert.equal(first.version, '1.0.0');
  assert.equal(f.state.npm.version, '1.0.0'); assert.equal(f.state.tags.latest, undefined);
  assert.equal(f.state.tags[candidateNpmTag(f.version)], f.version);
  assert(f.release.prerelease); assert.match(f.release.body, /aaa-muse-product:verified/);
  assert(f.state.images.has('candidate-' + f.version));
  assert.deepEqual(f.state.images.get('sha-' + f.source), rcImage);
  assert(f.state.commands.some(([command, operation, source]) =>
    command === 'docker' && operation === 'tag' && source === 'aaa-muse-stable:prepared'));
  assert(!f.state.commands.some(command => command.includes('build') || command.includes('pack')));
  const uploads = f.state.uploads, pushes = f.state.commands.filter(command => command.includes('push')).length;
  const second = await publish(f);
  assert.equal(second.manifest_sha256, first.manifest_sha256); assert.equal(f.state.uploads, uploads);
  assert.equal(f.state.commands.filter(command => command.includes('push')).length, pushes);
});

test('a mismatched restored image blocks candidate writes', async t => {
  const f = await releaseFixture(t);
  const observed = 'sha256:' + 'f'.repeat(64);
  const execute = (command, args, options) => {
    const result = f.execute(command, args, options);
    if (command !== 'docker' || args[0] !== 'image' || args[1] !== 'inspect') return result;
    const [image] = JSON.parse(result);
    return JSON.stringify([{ ...image, Descriptor: { annotations: { 'config.digest': observed } } }]);
  };
  await assert.rejects(publish({ ...f, execute }), error => {
    assert.equal(error.message, 'product_release_artifact_conflict');
    assert.equal(error.fields.destination, 'restored_image_config');
    assert.equal(error.fields.expected_digest, f.configDigest);
    assert.equal(error.fields.observed_digest, observed);
    return true;
  });
  assert.equal(f.state.npm, null);
  assert.equal(f.state.uploads, 0);
  assert(!f.state.refs.has('tags/' + f.prepared.tag));
  assert(!f.state.images.has('candidate-' + f.version));
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
    [['npm', 'dist-tag', 'add', '@markhuangai/aaa-muse-worker@' + f.version, 'candidate']]);
});

test('a failed completion marker keeps the candidate alias usable for a newer stable dispatch', async t => {
  const earlier = await releaseFixture(t, { source: 'c'.repeat(40) });
  earlier.seed();
  await promote(earlier);
  const interrupted = await releaseFixture(t, { version: '1.0.1', rcVersion: '1.0.1-rc.0', previous: earlier });
  const updateRelease = interrupted.github.rest.repos.updateRelease;
  interrupted.github.rest.repos.updateRelease = async options => {
    if (options.body?.includes('<!-- aaa-muse-product:verified:')) throw { status: 503 };
    return updateRelease(options);
  };
  const original = await prepareStableRelease(interrupted);
  await assert.rejects(publish({ ...interrupted, prepared: original }), error =>
    error.fields.operation === 'completion_marker_publication' && error.fields.http_status === 503);
  assert.equal(interrupted.state.tags.candidate, earlier.version);
  assert.equal(interrupted.state.tags.latest, earlier.version);
  assert(!interrupted.release.body.includes('<!-- aaa-muse-product:verified:'));

  const source = 'b'.repeat(40), rcVersion = '1.0.1-rc.1';
  interrupted.addRC(rcVersion, { rcSource: source });
  await assert.rejects(prepareStableRelease(interrupted), /product_release_stale_rc/);
  const newer = await releaseFixture(t, { version: '1.1.0', rcVersion, source, previous: interrupted });
  const prepared = await prepareStableRelease(newer);
  const published = await publish({ ...newer, prepared });
  await promote(newer, { prepared, manifestSHA256: published.manifest_sha256 });
  assert.equal(newer.state.tags.candidate, newer.version);
  assert.equal(newer.state.tags.latest, newer.version);
});

test('candidate refusal preserves conflicting image destinations and altered frozen artifacts', async t => {
  const f = await releaseFixture(t);
  const other = jsonBytes({ config: { digest: 'sha256:' + hash('{}') } });
  f.state.images.set('candidate-' + f.version, other); f.state.configBytes = Buffer.from('{}');
  await assert.rejects(publish(f), /artifact_conflict/);
  assert.deepEqual(f.state.images.get('candidate-' + f.version), other); assert.equal(f.state.npm, null);
  f.state.images.delete('candidate-' + f.version); writeFileSync(join(f.directory, 'image.tar'), 'changed');
  await assert.rejects(publish(f), /artifact_conflict/); assert.equal(f.state.uploads, 0);
});

test('candidate reconciliation copies a verified existing manifest for a missing tag without pushing new bytes', async t => {
  const f = await releaseFixture(t); f.seed();
  f.state.images.delete(`sha-${f.source}-${f.version}`);
  const result = await publish(f); assert.equal(result.publication, 'complete');
  assert(f.state.commands.some(command => command.includes('imagetools')));
  assert(!f.state.commands.some(command => command.includes('push')));
});

test('matching npm bytes recover an absent candidate tag and preserve a conflicting distribution tag', async t => {
  const f = await releaseFixture(t); f.seed(); delete f.state.tags.candidate;
  await publish(f);
  assert.equal(f.state.tags.candidate, f.version);
  assert.deepEqual(f.state.commands.filter(command => command[0] === 'npm').map(command => command.slice(1, 4)), [['dist-tag', 'add', '@markhuangai/aaa-muse-worker@' + f.version]]);
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

test('stable publication verifies the pinned pair and records no implicit live pass', async t => {
  const f = await releaseFixture(t); f.seed();
  const before = new Map(f.state.assets);
  const result = await promote(f);
  assert.equal(result.outcome, 'complete'); assert.equal(result.live_qualification, 'not_established');
  assert.equal(result.schema_version, 2);
  assert.deepEqual(result.source_rc, f.prepared.source_rc);
  assert.deepEqual(JSON.parse(f.state.assets.get('promotion.json')), result);
  assert(!f.release.assets.some(asset => asset.name.startsWith('qualification-')));
  assert.equal(f.state.tags.latest, f.version); assert(!f.release.prerelease);
  assert(f.state.images.has(f.version)); assert(f.state.images.has('latest'));
  for (const [name, bytes] of before) assert.deepEqual(f.state.assets.get(name), bytes);
  assert(!f.state.commands.some(command => command.includes('build') || command.includes('pack') || command.includes('publish') || command.includes('push')));
  const count = f.state.commands.length;
  await promote(f);
  assert.equal(f.state.commands.length, count);
});

test('a newer complete RC blocks a fresh promotion before any stable write', async t => {
  const f = await releaseFixture(t); f.seed();
  f.addRC('1.0.0-rc.14', { rcSource: 'b'.repeat(40) });
  await assert.rejects(promote(f), error => {
    assert.equal(error.message, 'product_release_stale_rc');
    assert.equal(error.fields.expected_rc, 'v1.0.0-rc.13');
    assert.equal(error.fields.observed_rc, 'v1.0.0-rc.14');
    return true;
  });
  assert.equal(f.state.uploads, 0);
  assert.deepEqual(f.state.commands, []);
  assert(f.release.prerelease);
});

test('two successive candidates advance the verified aliases and keep the old exact release verifiable', async t => {
  const first = await releaseFixture(t, { version: '1.0.0', rcVersion: '1.0.0-rc.0' });
  await assert.rejects(prepareStableRelease({ ...first, version: '0.1.1' }), /source_target_major_mismatch/);
  await assert.rejects(prepareStableRelease({ ...first, prereleaseTag: 'v0.1.0-rc.15' }), /source_target_major_mismatch/);
  assert.equal(first.state.commands.length, 0);
  assert.equal(first.state.uploads, 0);
  const firstPrepared = await prepareStableRelease(first);
  assert.equal(firstPrepared.candidate_ready, false);
  const firstPublished = await publish({ ...first, prepared: firstPrepared });
  await promote(first, { prepared: firstPrepared, manifestSHA256: firstPublished.manifest_sha256 });

  const source = 'b'.repeat(40);
  first.state.main = source;
  const repo = { full_name: 'markhuangai/AaA-muse-ai' };
  const context = { ...first.context, eventName: 'workflow_run', payload: { workflow_run: {
    id: 4, workflow_id: 7, event: 'push', conclusion: 'success', head_branch: 'main', head_sha: source, repository: repo, head_repository: repo,
  } } };
  const next = await prepareRelease({ ...first, context, paired: true });
  assert.equal(next.version, '1.0.1-rc.0');
  first.state.refs.set('tags/' + next.tag, { object: { type: 'commit', sha: source } });
  assert.equal((await prepareRelease({ ...first, context, paired: true })).version, next.version);
  const second = await releaseFixture(t, { version: '1.0.1', rcVersion: next.version, source, previous: first });
  assert.equal((await prepareStableRelease(second)).version, second.version);
  await publish(second);
  assert.equal(second.state.tags.candidate, '1.0.1');
  assert.equal(second.state.tags.latest, '1.0.0');
  const startingCommands = second.state.commands.length;
  await promote(second);
  assert.equal(second.state.tags.latest, '1.0.1');
  assert.equal(second.state.githubLatest, second.release.id);
  assert.deepEqual(second.state.images.get('latest'), second.state.images.get(second.imageDigest));
  assert.deepEqual(second.state.images.get('1.0.0'), first.state.images.get(first.imageDigest));
  assert(!second.state.commands.slice(startingCommands).some(command => command.includes('build') ||
    command.includes('pack') || command.includes('publish') || command.includes('push')));

  const commands = second.state.commands.length;
  const before = second.state.uploads;
  const historical = await verifyPublished({ ...second, tag: first.prepared.tag, sourceSHA: first.source, manifestSHA256: firstPublished.manifest_sha256 });
  assert.equal(historical.receipt.version, '1.0.0');
  const request = { ...second, prereleaseTag: first.prereleaseTag, version: first.version };
  const historicalPrepared = await prepareStableRelease(request);
  assert.equal(historicalPrepared.candidate_ready, true);
  await promote(second, { prepared: historicalPrepared, manifestSHA256: historicalPrepared.manifest_sha256 });
  assert.equal(second.state.commands.length, commands);
  assert.equal(second.state.uploads, before);
  assert.equal(second.state.tags.latest, '1.0.1');
  assert(second.state.requests.filter(request => request.url.startsWith('https://github.com/')).every(request => !request.authenticated));
});

test('stable publication rejects mismatched lineage, manifest digest, and dispatch authority before writing', async t => {
  const f = await releaseFixture(t); f.seed();
  const prepared = await prepareStableRelease(f);
  assert.equal(prepared.candidate_ready, true);
  assert.equal(prepared.manifest_sha256, f.manifestSHA256);
  await assert.rejects(promote(f, { manifestSHA256: 'f'.repeat(64) }), /artifact_conflict/);
  await assert.rejects(promote(f, { prepared: { ...prepared, source_rc: { ...prepared.source_rc, manifest_sha256: 'f'.repeat(64) } } }), /stale_rc/);
  await assert.rejects(promote(f, { manifestSHA256: '' }), /identity_required/);
  f.state.permission = 'write';
  await assert.rejects(promote(f), /administrator_required/);
  assert.equal(f.state.commands.length, 0);
  assert.equal(f.state.uploads, 0);
  assert(f.release.prerelease);
});

test('historical qualification receipts verify without asserting a new live pass', async t => {
  const f = await releaseFixture(t); f.seed();
  const fresh = await promote(f);
  const qualification = jsonBytes({ evidence_kind: 'live', verdict: 'pass' });
  const qualificationSHA256 = hash(qualification);
  const { source_sha, version, manifest_sha256, image, worker_sha256, outcome, destinations } = fresh;
  const legacy = { schema_version: 1, source_sha, version, manifest_sha256, qualification_sha256: qualificationSHA256,
    image, worker_sha256, outcome, live_qualification: 'pass', destinations };
  const asset = 'qualification-' + qualificationSHA256 + '.json';
  await f.github.rest.repos.uploadReleaseAsset({ name: asset, data: qualification });
  f.state.assets.set('promotion.json', jsonBytes(legacy));
  assert.equal((await latestStableRelease([f.release], f.fetcher)).version, f.version);
  assert.equal((await promote(f)).live_qualification, 'not_established');
  assert.deepEqual(JSON.parse(f.state.assets.get('promotion.json')), legacy);
  f.state.assets.set(asset, Buffer.from('other bytes'));
  await assert.rejects(promote(f), /artifact_conflict/);
  assert.equal((await readProductRelease(f.release, f.fetcher)).manifest.version, f.version);
});

test('promotion stops on distribution conflicts, retains partial progress, and reports causal evidence', async t => {
  const f = await releaseFixture(t); f.seed();
  f.state.tags.latest = '0.2.0'; await assert.rejects(promote(f), /distribution_conflict/); delete f.state.tags.latest;
  f.release.immutable = true; await assert.rejects(promote(f), /release_unavailable/); f.release.immutable = false;
  const execute = f.execute;
  f.execute = (command, args, options) => { if (command === 'npm') throw { status: 503, message: 'secret-sentinel' }; return execute(command, args, options); };
  await assert.rejects(promote(f), error => {
    assert(error.fields.completed_destinations.includes('latest')); assert.equal(error.fields.operation, 'npm_distribution_promotion');
    assert.equal(error.fields.uncertain_destination, 'npm_latest'); assert(!error.message.includes('secret-sentinel')); return true;
  });
  assert(f.release.prerelease);
  assert(f.state.assets.has('promotion-intent.json'));
  assert(!f.state.assets.has('promotion.json'));
  f.addRC('1.0.0-rc.14', { rcSource: 'b'.repeat(40) });
  const newer = await releaseFixture(t, { version: '1.0.1', rcVersion: '1.0.0-rc.14', source: 'b'.repeat(40), previous: f });
  newer.seed();
  await assert.rejects(promote(newer), /stable_version_step_invalid/);
  f.execute = execute;
  const prepared = await prepareStableRelease(f);
  assert.equal(prepared.candidate_ready, true);
  const before = f.state.commands.length;
  assert.equal((await promote(f, { prepared, manifestSHA256: prepared.manifest_sha256 })).outcome, 'complete');
  assert(!f.state.commands.slice(before).some(command => command.includes('imagetools')));
  assert(!f.state.commands.slice(before).some(command => command.includes('publish')));
});

test('a saved intent without an actual stable write does not permit stale promotion', async t => {
  const f = await releaseFixture(t); f.seed();
  const execute = f.execute;
  f.execute = (command, args, options) => {
    if (command === 'docker' && args[0] === 'buildx') throw { status: 1 };
    return execute(command, args, options);
  };
  await assert.rejects(promote(f), /required_operation_failed/);
  assert(f.state.assets.has('promotion-intent.json'));
  assert(!f.state.images.has(f.version));
  f.addRC('1.0.0-rc.14', { rcSource: 'b'.repeat(40) });
  f.execute = execute;
  const before = { commands: f.state.commands.length, uploads: f.state.uploads };
  await assert.rejects(promote(f), /stale_rc/);
  assert.equal(f.state.commands.length, before.commands);
  assert.equal(f.state.uploads, before.uploads);
  assert(f.release.prerelease);
});
