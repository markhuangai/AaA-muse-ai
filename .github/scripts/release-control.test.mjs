import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFixture } from './test/release-fixture.mjs';
import { prepareStableRelease, candidateRecovery, bundleName, candidateBuildName } from './release-control.mjs';
import { chooseVersion } from './worker-release.mjs';
import { nextRCBase } from './release-history.mjs';
import { isNextStable, isRCTag, releaseVersion } from './release-versions.mjs';

test('only a trusted main administrator can prepare the latest verified merge', async t => {
  const f = await releaseFixture(t);
  const run = () => prepareStableRelease(f);
  const result = await run();
  assert.equal(result.tree_sha, f.tree);
  assert.equal(result.source_sha, f.source);
  assert.deepEqual(result.source_rc, f.prepared.source_rc);
  assert.equal(result.tag, 'v1.0.0');
  for (const [object, key, value, cause] of [[f.context, 'eventName', 'pull_request', 'untrusted'], [f.context, 'ref', 'refs/heads/other', 'untrusted'],
    [f.state, 'permission', 'write', 'administrator'], [f.state, 'source', 'f'.repeat(40), 'source_identity'],
    [f.state, 'sourceOnMain', false, 'not_on_main'], [f.state, 'merged', false, 'merged_source'],
    [f.state, 'mainSuccess', false, 'main_checks']]) {
    const prior = object[key]; object[key] = value; await assert.rejects(run(), new RegExp(cause)); object[key] = prior;
  }
  const paginate = f.github.paginate;
  f.github.paginate = async (route, options) => options.run_id ? [] : paginate(route, options);
  await assert.rejects(run(), /jobs_incomplete/);
  f.github.paginate = async (route, options) => options.run_id ? [{ name: 'other', conclusion: 'success' }] : paginate(route, options);
  await assert.rejects(run(), /verifier_missing/);
});

test('RC allocation moves to the new series without losing reservations for an earlier source', () => {
  const previous = 'a'.repeat(40);
  const current = 'b'.repeat(40);
  const refs = ['0.1.0-rc.13', '1.0.0-rc.0'].map((version, i) => ({
    ref: 'refs/tags/v' + version, object: { type: 'commit', sha: i === 0 ? previous : current },
  }));
  const series = nextRCBase({ version: '0.3.2' });
  assert.equal(series, '1.0.0');
  assert.equal(chooseVersion([], current, true, nextRCBase(null)), '1.0.0-rc.0');
  assert.equal(chooseVersion(refs.slice(0, 1), current, true, series), '1.0.0-rc.0');
  assert.equal(chooseVersion(refs, previous, true, series), '0.1.0-rc.13');
  assert.equal(chooseVersion(refs, 'c'.repeat(40), true, series), '1.0.0-rc.1');
  assert.equal(chooseVersion(refs, 'c'.repeat(40), true, nextRCBase({ version: '1.0.0' })), '1.0.1-rc.0');
});

test('stable target accepts one patch, minor or major step and validates canonical versions', () => {
  assert.deepEqual(releaseVersion('1.2.3-rc.4'), { major: 1, minor: 2, patch: 3, rc: 4 });
  for (const version of ['0.1.0', '0.1.1', '0.2.0', '1.0.0']) assert(isNextStable(version));
  for (const version of ['1.2.4', '1.3.0', '2.0.0']) assert(isNextStable(version, '1.2.3'));
  for (const version of ['1.2.3', '1.2.5', '1.3.1', '2.1.0', '3.0.0', '0.9.9']) assert(!isNextStable(version, '1.2.3'));
  for (const version of [null, '1.00.0', '1.0.0-rc.01', '1.0.9007199254740992', 'v1.0.0', '1.0.0+meta', '1.0.0\n']) {
    assert.equal(releaseVersion(version), null);
  }
  assert(isRCTag('v1.0.1-rc.0'));
  assert(!isRCTag('v1.0.1'));
});

test('two inputs stay pinned and an incomplete newer RC does not replace the requested complete RC', async t => {
  const f = await releaseFixture(t);
  f.addRC('1.0.0-rc.14', { rcSource: 'b'.repeat(40), complete: false });
  const prepared = await prepareStableRelease(f);
  assert.equal(prepared.version, '1.0.0');
  assert.deepEqual(prepared.source_rc, f.prepared.source_rc);
  assert.equal(prepared.source_sha, f.source);
  assert.equal(prepared.resume_run_id, null);
  assert.equal(prepared.candidate_ready, false);
  await assert.rejects(prepareStableRelease({ ...f, version: '0.1.0' }), /source_target_major_mismatch/);
  await assert.rejects(prepareStableRelease({ ...f, version: '1.0.1' }), /version_step_invalid/);
  await assert.rejects(prepareStableRelease({ ...f, prereleaseTag: 'main' }), /dispatch_inputs_invalid/);

  const rc = f.addRC('1.0.0-rc.15', { rcSource: 'c'.repeat(40) });
  await assert.rejects(prepareStableRelease(f), error => error.fields.expected_rc === f.prereleaseTag &&
    error.fields.observed_rc === rc.release.tag_name);
  const request = { ...f, prereleaseTag: rc.release.tag_name };
  assert.equal((await prepareStableRelease(request)).source_sha, rc.source);
  rc.release.body = '<!-- aaa-muse-product:verified:conflict -->';
  await assert.rejects(prepareStableRelease(request), /completion_conflict/);
  assert.deepEqual(f.state.commands, []);
  assert.equal(f.state.uploads, 0);
});

test('a requested version occupied in another destination is rejected before building', async t => {
  const f = await releaseFixture(t, { version: '1.0.0' });
  f.state.npm = { version: f.version };
  await assert.rejects(prepareStableRelease(f), error => error.fields.destination === 'github_packages');
  f.state.npm = null;
  f.state.images.set(f.version, f.state.imageBytes);
  await assert.rejects(prepareStableRelease(f), error => error.fields.destination === f.version);
  assert.equal(f.state.uploads, 0);
});

test('candidate recovery selects original trusted bytes and never rebuilds a reserved version without them', async t => {
  const f = await releaseFixture(t);
  assert.equal(await candidateRecovery(f), null);
  f.state.runs = [{ id: 70 }];
  f.state.artifacts = [{ id: 1, name: bundleName(f.prepared), run_id: 70, expired: true }];
  await assert.rejects(candidateRecovery(f), /original_bundle_unavailable/);
  assert(!f.state.refs.has('tags/' + f.prepared.tag));
  f.state.artifacts = [];
  const freeze = [{ name: 'Freeze original image and worker bytes before any publication', conclusion: 'success' }];
  f.state.historyJobs.set(70, [{ name: candidateBuildName({ ...f.prepared, version: '0.1.2' }), steps: freeze }]);
  assert.equal(await candidateRecovery(f), null);
  f.state.historyJobs.set(70, [{ name: candidateBuildName(f.prepared), steps: freeze }]);
  await assert.rejects(candidateRecovery(f), error => error.fields.artifact_record_missing === true && error.fields.original_run_id === 70);
  assert(!f.state.refs.has('tags/' + f.prepared.tag)); f.state.historyJobs.clear();
  f.state.runs = []; f.state.artifacts = [];
  f.state.refs.set('tags/' + f.prepared.tag, { object: { type: 'commit', sha: f.source } });
  await assert.rejects(candidateRecovery(f), /original_bundle_unavailable/);
  f.state.runs = [{ id: 70 }, { id: 80 }];
  f.state.artifacts = [{ id: 1, name: bundleName(f.prepared), run_id: 70, expired: false }];
  f.state.originalRuns.set(70, { workflow_id: 7, event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'markhuangai/AaA-muse-ai' },
    head_repository: { full_name: 'markhuangai/AaA-muse-ai' }, actor: { login: 'Z-M-Huang' } });
  assert.deepEqual(await candidateRecovery(f), { run_id: 70, artifact_id: 1 });
  assert.equal((await prepareStableRelease(f)).resume_run_id, 70);
  f.state.artifacts[0].expired = true; await assert.rejects(candidateRecovery(f), /unavailable/);
  f.state.artifacts[0].expired = false;
  f.state.originalRuns.get(70).head_branch = 'other'; await assert.rejects(candidateRecovery(f), /untrusted/);
  f.state.runs = [{ id: f.context.runId }]; f.state.artifacts[0].run_id = f.context.runId;
  await assert.rejects(candidateRecovery(f), /original_bundle_unavailable/);
  const previousAttempt = process.env.GITHUB_RUN_ATTEMPT;
  t.after(() => {
    if (previousAttempt === undefined) delete process.env.GITHUB_RUN_ATTEMPT;
    else process.env.GITHUB_RUN_ATTEMPT = previousAttempt;
  });
  process.env.GITHUB_RUN_ATTEMPT = '2';
  delete f.context.runAttempt;
  f.state.originalRuns.set(f.context.runId, { ...f.state.originalRuns.get(70), head_branch: 'main' });
  assert.equal((await candidateRecovery(f)).run_id, f.context.runId);
  f.state.refs.get('tags/' + f.prepared.tag).object.sha = 'f'.repeat(40); await assert.rejects(candidateRecovery(f), /reserved_for_other/);
  f.github.rest.git.getRef = async () => { throw { status: 403 }; }; await assert.rejects(candidateRecovery(f), error => error.fields.http_status === 403);
});
