import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

test('real failing candidate path emits sufficient INFO/WARN/ERROR evidence without credentials', () => {
  const script = `
    import { releaseFixture } from './.github/scripts/test/release-fixture.mjs';
    import { publishCandidate } from './.github/scripts/release-candidate.mjs';
    import { publishRelease, reportReleaseFailure } from './.github/scripts/worker-release.mjs';
    const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
    f.state.failAsset = 'product-release.json';
    try {
      await publishCandidate({ ...f, publishWorker: options => publishRelease({ ...options, publishNpm: f.publishNpm }) });
      process.exitCode = 2;
    } catch (error) {
      reportReleaseFailure({ error: line => process.stderr.write(line + '\\n'), setFailed() {} }, error);
    } finally { for (const fn of cleanup) await fn(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const events = (child.stdout + child.stderr).trim().split('\n').filter(line => line.startsWith('{')).map(JSON.parse);
  const failed = events.find(event => event.level === 'ERROR' && event.event === 'worker.release.failed');
  assert.equal(failed.operation, 'manifest_publication'); assert.equal(failed.destination, 'product-release.json');
  assert.equal(failed.http_status, 503); assert.equal(failed.outcome, 'incomplete');
  assert(failed.completed_destinations.includes('github_packages')); assert(failed.completed_destinations.includes('candidate-1.0.0'));
  assert(!failed.missing_destinations.includes('candidate-1.0.0'));
  assert(!failed.missing_destinations.includes('sha-' + 'a'.repeat(40) + '-1.0.0'));
  assert(failed.completed_destinations.every(destination => !failed.missing_destinations.includes(destination)));
  assert.equal(failed.uncertain_destination, 'product-release.json');
  assert(!failed.missing_destinations.includes(failed.uncertain_destination));
  assert.equal(failed.operation_id, 'release-100-1'); assert.equal(failed.attempt, 1); assert(failed.duration_ms >= 0);
  assert(events.some(event => event.level === 'WARN' && event.event === 'product.release.reconciled'));
  assert(events.some(event => event.level === 'INFO' && event.event === 'product.release.source_verified'));
  assert(!(child.stdout + child.stderr).includes('secret-sentinel'));
  assert(!(child.stdout + child.stderr).includes('fixture-registry-bearer'));
  for (const event of events) console.log(JSON.stringify({ ...event, controlled_reproduction: true, qualifies_live_muse: false }));
});

test('source and reservation rejection logs identify the exact safe mismatch and blocked operation', () => {
  const script = `
    import { releaseFixture } from './.github/scripts/test/release-fixture.mjs';
    import { prepareStableRelease, candidateRecovery } from './.github/scripts/release-control.mjs';
    import { verifyPublished } from './.github/scripts/release-verify.mjs';
    import { reportReleaseFailure } from './.github/scripts/worker-release.mjs';
    import { hash, jsonBytes } from './.github/scripts/release-manifest.mjs';
    const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
    const core = { error: line => process.stderr.write(line + '\\n'), setFailed() {} };
    f.state.source = 'f'.repeat(40);
    try { await prepareStableRelease(f); } catch (error) { reportReleaseFailure(core, error); }
    f.state.refs.set('tags/v1.0.0', { object: { type: 'commit', sha: 'f'.repeat(40) } });
    try { await candidateRecovery(f); } catch (error) { reportReleaseFailure(core, error); }
    f.state.source = f.source; f.seed();
    f.state.refs.get('tags/v1.0.0').object.sha = 'f'.repeat(40);
    try { await verifyPublished({ ...f, tag: 'v1.0.0', sourceSHA: f.source, manifestSHA256: hash(jsonBytes(f.manifest)) }); } catch (error) { reportReleaseFailure(core, error); }
    f.state.refs.get('tags/v1.0.0').object.sha = f.source; f.state.tree = 'd'.repeat(40);
    try { await verifyPublished({ ...f, tag: 'v1.0.0', sourceSHA: f.source, manifestSHA256: hash(jsonBytes(f.manifest)) }); } catch (error) { reportReleaseFailure(core, error); }
    for (const fn of cleanup) await fn();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const events = child.stderr.trim().split('\n').map(JSON.parse);
  const source = events.find(event => event.cause === 'product_release_source_identity_mismatch');
  assert.equal(source.expected_source, 'a'.repeat(40)); assert.equal(source.observed_source, 'f'.repeat(40));
  assert.equal(source.operation_id, 'release-100-1'); assert.equal(source.destination, 'source_repository');
  for (const cause of ['product_release_version_reserved_for_other_source', 'product_release_tag_conflict', 'product_release_source_tree_conflict']) {
    const rejected = events.find(event => event.cause === cause); assert(rejected, cause);
    assert.equal(rejected.expected_source, 'a'.repeat(40)); assert(rejected.operation_id); assert(rejected.destination); assert.equal(rejected.version, '1.0.0');
    if (cause.endsWith('tree_conflict')) { assert.equal(rejected.expected_tree, 'e'.repeat(40)); assert.equal(rejected.observed_tree, 'd'.repeat(40)); }
    else assert.equal(rejected.observed_source, 'f'.repeat(40));
  }
  assert(!(child.stdout + child.stderr).includes('secret-sentinel'));
  assert(!(child.stdout + child.stderr).includes('fixture-registry-bearer'));
  for (const event of events) console.log(JSON.stringify({ ...event, controlled_reproduction: true, qualifies_live_muse: false }));
});

test('npm process failures after image promotion retain an accurate ledger and process exit evidence', () => {
  const script = `
    import { releaseFixture } from './.github/scripts/test/release-fixture.mjs';
    import { promoteStable } from './.github/scripts/release-promote.mjs';
    import { reportReleaseFailure } from './.github/scripts/worker-release.mjs';
    import { hash, jsonBytes } from './.github/scripts/release-manifest.mjs';
    import { execFileSync } from 'node:child_process';
    const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) }); f.seed();
    const options = { ...f, manifestSHA256: hash(jsonBytes(f.manifest)) };
    f.state.npmBytes = Buffer.from('mismatched archive');
    try {
      await promoteStable(options);
      process.exitCode = 2;
    } catch (error) { reportReleaseFailure({ error: line => process.stderr.write(line + '\\n'), setFailed() {} }, error); }
    delete f.state.npmBytes;
    try {
      await promoteStable({ ...options,
        execute: (command, args, options) => command === 'npm' ? execFileSync(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'pipe' }) : f.execute(command, args, options) });
      process.exitCode = 2;
    } catch (error) { reportReleaseFailure({ error: line => process.stderr.write(line + '\\n'), setFailed() {} }, error); }
    finally { for (const fn of cleanup) await fn(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const events = child.stderr.trim().split('\n').map(JSON.parse);
  const artifact = events.find(event => event.cause === 'product_release_artifact_conflict');
  assert.equal(artifact.level, 'ERROR');
  assert.equal(artifact.operation_id, 'release-100-1');
  assert.equal(artifact.operation, 'published_destination_verification');
  assert.equal(artifact.destination, 'github_packages');
  assert.equal(artifact.expected_digest.length, 64);
  assert.equal(artifact.observed_digest.length, 64);
  assert.notEqual(artifact.expected_digest, artifact.observed_digest);
  assert.deepEqual(artifact.completed_destinations, []);
  const failed = events.find(event => event.level === 'ERROR' && event.operation === 'npm_distribution_promotion');
  assert.equal(failed.process_status, 1); assert.equal(failed.http_status, null); assert.equal(failed.uncertain_destination, 'npm_latest');
  assert(failed.completed_destinations.includes('1.0.0')); assert(failed.completed_destinations.includes('latest'));
  assert(failed.missing_destinations.includes('github_release')); assert(failed.missing_destinations.includes('promotion.json'));
  assert(!failed.missing_destinations.includes('npm_latest'));
  assert(failed.completed_destinations.every(destination => !failed.missing_destinations.includes(destination)));
  assert(!(child.stdout + child.stderr).includes('secret-sentinel'));
  assert(!(child.stdout + child.stderr).includes('fixture-registry-bearer'));
  for (const event of events) console.log(JSON.stringify({ ...event, controlled_reproduction: true, qualifies_live_muse: false }));
});

test('stable dispatch failures identify the requested pair and the corrective action from logs', () => {
  const script = `
    import { releaseFixture } from './.github/scripts/test/release-fixture.mjs';
    import { prepareStableRelease } from './.github/scripts/release-control.mjs';
    import { reportReleaseFailure } from './.github/scripts/worker-release.mjs';
    const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) }, { version: '1.0.0' });
    const core = { error: line => process.stderr.write(line + '\\n'), setFailed() {} };
    const run = async options => {
      try { await prepareStableRelease(options); process.exitCode = 2; } catch (error) { reportReleaseFailure(core, error); }
    };
    await run({ ...f, version: f.token });
    await run({ ...f, version: '1.0.1' });
    const newer = f.addRC('1.0.0-rc.14', { rcSource: 'b'.repeat(40) });
    await run(f);
    f.state.images.set(f.version, f.state.imageBytes);
    await run({ ...f, prereleaseTag: newer.release.tag_name });
    f.state.images.delete(f.version);
    f.github.rest.repos.getCollaboratorPermissionLevel = async () => { throw { status: 503, message: f.token }; };
    await run(f);
    for (const fn of cleanup) await fn();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const events = child.stderr.trim().split('\n').map(JSON.parse);
  const [invalid, step, stale, occupied, unavailable] = events;
  assert.equal(invalid.cause, 'product_release_dispatch_inputs_invalid');
  assert.equal(invalid.version, 'invalid');
  assert.equal(step.cause, 'product_release_stable_version_step_invalid');
  assert.equal(step.active_series, '1.0.0');
  assert.equal(step.observed_version, '1.0.1');
  assert.equal(stale.cause, 'product_release_stale_rc');
  assert.equal(stale.operation, 'latest_rc_selection');
  assert.equal(stale.expected_rc, 'v1.0.0-rc.13');
  assert.equal(stale.observed_rc, 'v1.0.0-rc.14');
  assert.equal(stale.observed_digest.length, 64);
  assert.equal(stale.observed_source, 'b'.repeat(40));
  assert.equal(occupied.cause, 'product_release_version_destination_conflict');
  assert.equal(occupied.destination, '1.0.0');
  assert.match(occupied.observed_digest, /^sha256:[a-f0-9]{64}$/);
  assert.equal(unavailable.operation, 'dispatch_verification');
  assert.equal(unavailable.http_status, 503);
  for (const event of events) {
    assert.equal(event.level, 'ERROR');
    assert.equal(event.operation_id, 'release-100-1');
    assert.equal(event.run_id, 100);
    assert.equal(event.attempt, 1);
    assert.equal(event.outcome, 'blocked');
    assert.match(event.prerelease_tag, /^v1\.0\.0-rc\./);
    assert(event.duration_ms >= 0);
    assert.deepEqual(event.completed_destinations, []);
  }
  assert(!child.stderr.includes('secret-sentinel'));
  assert(!child.stderr.includes('fixture-registry-bearer'));
  for (const event of events) console.log(JSON.stringify({ ...event, controlled_reproduction: true, qualifies_live_muse: false }));
});
