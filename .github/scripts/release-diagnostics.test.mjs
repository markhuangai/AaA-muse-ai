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
  assert(failed.completed_destinations.includes('github_packages')); assert(failed.completed_destinations.includes('candidate-0.1.0'));
  assert(!failed.missing_destinations.includes('candidate-0.1.0'));
  assert(!failed.missing_destinations.includes('sha-' + 'a'.repeat(40) + '-0.1.0'));
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

test('source and qualification rejection logs identify the exact safe mismatch and blocked operation', () => {
  const script = `
    import { releaseFixture } from './.github/scripts/test/release-fixture.mjs';
    import { resolveStableSource, candidateRecovery } from './.github/scripts/release-control.mjs';
    import { verifyPublished } from './.github/scripts/release-verify.mjs';
    import { verifyQualification } from './.github/scripts/release-promote.mjs';
    import { reportReleaseFailure } from './.github/scripts/worker-release.mjs';
    import { hash, jsonBytes } from './.github/scripts/release-manifest.mjs';
    const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) });
    const core = { error: line => process.stderr.write(line + '\\n'), setFailed() {} };
    f.state.source = 'f'.repeat(40);
    try { await resolveStableSource({ ...f, sourceSHA: f.source, phase: 'candidate', version: f.version }); } catch (error) { reportReleaseFailure(core, error); }
    const receipt = { schema_version: 1, kind: 'final_candidate_qualification', manifest_sha256: hash(jsonBytes(f.manifest)), evidence_kind: 'synthetic', verdict: 'inconclusive' };
    try { verifyQualification(receipt, f.manifest, receipt.manifest_sha256); } catch (error) { reportReleaseFailure(core, error); }
    f.state.refs.set('tags/v0.1.0', { object: { type: 'commit', sha: 'f'.repeat(40) } });
    try { await candidateRecovery(f); } catch (error) { reportReleaseFailure(core, error); }
    f.state.source = f.source; f.seed();
    f.state.refs.get('tags/v0.1.0').object.sha = 'f'.repeat(40);
    try { await verifyPublished({ ...f, tag: 'v0.1.0', sourceSHA: f.source, manifestSHA256: hash(jsonBytes(f.manifest)) }); } catch (error) { reportReleaseFailure(core, error); }
    f.state.refs.get('tags/v0.1.0').object.sha = f.source; f.state.tree = 'd'.repeat(40);
    try { await verifyPublished({ ...f, tag: 'v0.1.0', sourceSHA: f.source, manifestSHA256: hash(jsonBytes(f.manifest)) }); } catch (error) { reportReleaseFailure(core, error); }
    Object.assign(receipt, { evidence_kind: 'live', verdict: 'pass', report_sha256: 'd'.repeat(64), run_id: 'fixture', finished_at: '2026-11-17T00:00:00Z',
      exports: [{ source: 'broker', sha256: 'c'.repeat(64) }], source_sha: f.source, tree_sha: f.tree, version: f.version,
      protocol_version: 1, image: f.manifest.image, image_config_digest: f.configDigest, worker_sha256: 'f'.repeat(64), installer_sha256: f.worker.installer_sha256 });
    try { verifyQualification(receipt, f.manifest, receipt.manifest_sha256); } catch (error) { reportReleaseFailure(core, error); }
    for (const fn of cleanup) await fn();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const events = child.stderr.trim().split('\n').map(JSON.parse);
  const source = events.find(event => event.cause === 'product_release_source_identity_mismatch');
  assert.equal(source.expected_source, 'a'.repeat(40)); assert.equal(source.observed_source, 'f'.repeat(40));
  assert.equal(source.operation_id, 'release-100-1'); assert.equal(source.destination, 'source_repository');
  const qualification = events.find(event => event.cause === 'product_release_qualification_receipt_rejected');
  assert.equal(qualification.evidence_kind, 'synthetic'); assert(qualification.rejected_requirements.includes('passing_verdict_required'));
  assert.equal(qualification.version, '0.1.0'); assert.equal(qualification.source_sha, 'a'.repeat(40));
  assert.equal(qualification.outcome, 'incomplete');
  assert.equal(qualification.promotion_outcome, 'blocked');
  const mismatch = events.find(event => event.cause === 'product_release_qualification_identity_mismatch');
  assert.equal(mismatch.expected_worker_digest.length, 64); assert.equal(mismatch.observed_worker_digest, 'f'.repeat(64));
  assert.equal(mismatch.promotion_outcome, 'blocked');
  for (const cause of ['product_release_version_reserved_for_other_source', 'product_release_tag_conflict', 'product_release_source_tree_conflict']) {
    const rejected = events.find(event => event.cause === cause); assert(rejected, cause);
    assert.equal(rejected.expected_source, 'a'.repeat(40)); assert(rejected.operation_id); assert(rejected.destination); assert.equal(rejected.version, '0.1.0');
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
    import { promoteCandidate } from './.github/scripts/release-promote.mjs';
    import { reportReleaseFailure } from './.github/scripts/worker-release.mjs';
    import { hash, jsonBytes } from './.github/scripts/release-manifest.mjs';
    import { execFileSync } from 'node:child_process';
    const cleanup = [], f = await releaseFixture({ after: fn => cleanup.push(fn) }); f.seed();
    const receipt = { schema_version: 1, kind: 'final_candidate_qualification', manifest_sha256: hash(jsonBytes(f.manifest)), evidence_kind: 'live', verdict: 'pass',
      report_sha256: 'd'.repeat(64), run_id: 'fixture', finished_at: '2026-11-17T00:00:00Z', exports: [{ source: 'broker', sha256: 'c'.repeat(64) }],
      source_sha: f.source, tree_sha: f.tree, version: f.version, protocol_version: 1, image: f.manifest.image, image_config_digest: f.configDigest,
      worker_sha256: f.worker.sha256, installer_sha256: f.worker.installer_sha256 };
    const qualificationBytes = jsonBytes(receipt), qualificationSHA256 = hash(qualificationBytes);
    try {
      await promoteCandidate({ ...f, qualificationBytes, qualificationSHA256, manifestSHA256: receipt.manifest_sha256,
        confirmation: 'promote 0.1.0 ' + receipt.manifest_sha256 + ' ' + qualificationSHA256,
        execute: (command, args, options) => command === 'npm' ? execFileSync(process.execPath, ['-e', 'process.exit(1)'], { stdio: 'pipe' }) : f.execute(command, args, options) });
      process.exitCode = 2;
    } catch (error) { reportReleaseFailure({ error: line => process.stderr.write(line + '\\n'), setFailed() {} }, error); }
    finally { for (const fn of cleanup) await fn(); }
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const events = child.stderr.trim().split('\n').map(JSON.parse);
  const failed = events.find(event => event.level === 'ERROR');
  assert.equal(failed.process_status, 1); assert.equal(failed.http_status, null); assert.equal(failed.uncertain_destination, 'npm_latest');
  assert(failed.completed_destinations.includes('0.1.0')); assert(failed.completed_destinations.includes('latest'));
  assert(failed.missing_destinations.includes('github_release')); assert(failed.missing_destinations.includes('promotion.json'));
  assert(!failed.missing_destinations.includes('npm_latest'));
  assert(failed.completed_destinations.every(destination => !failed.missing_destinations.includes(destination)));
  assert(!(child.stdout + child.stderr).includes('secret-sentinel'));
  assert(!(child.stdout + child.stderr).includes('fixture-registry-bearer'));
  for (const event of events) console.log(JSON.stringify({ ...event, controlled_reproduction: true, qualifies_live_muse: false }));
});
