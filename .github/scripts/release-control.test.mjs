import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFixture } from './test/release-fixture.mjs';
import { prepareCandidate, candidateRecovery, bundleName, candidateBuildName } from './release-control.mjs';
import { chooseVersion } from './worker-release.mjs';

test('only a trusted main administrator can prepare the latest verified merge', async t => {
  const f = await releaseFixture(t);
  const run = () => prepareCandidate(f);
  const result = await run();
  assert.equal(result.tree_sha, f.tree);
  assert.equal(result.source_sha, f.source);
  assert.deepEqual(result.source_rc, f.prepared.source_rc);
  assert.equal(result.tag, 'v0.1.0');
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
  const refs = ['0.1.0-rc.13', '0.1.2-rc.0'].map((version, i) => ({
    ref: 'refs/tags/v' + version, object: { type: 'commit', sha: i === 0 ? previous : current },
  }));
  assert.equal(chooseVersion([], current, true), '0.1.0-rc.0');
  assert.equal(chooseVersion(refs.slice(0, 1), current, true, 2), '0.1.2-rc.0');
  assert.equal(chooseVersion(refs, previous, true, 2), '0.1.0-rc.13');
  assert.equal(chooseVersion(refs, 'c'.repeat(40), true, 2), '0.1.2-rc.1');
});

test('candidate selection ignores incomplete newer RCs and allocates above reserved final versions', async t => {
  const f = await releaseFixture(t, { version: '0.1.1' });
  f.state.refs.set('tags/v0.1.0', { object: { type: 'commit', sha: 'b'.repeat(40) } });
  f.addRC('0.1.0-rc.14', { rcSource: 'b'.repeat(40), complete: false });
  const prepared = await prepareCandidate(f);
  assert.equal(prepared.version, '0.1.1');
  assert.deepEqual(prepared.source_rc, f.prepared.source_rc);
  assert.equal(prepared.source_sha, f.source);
  assert.equal(prepared.resume_run_id, null);

  const rc = f.addRC('0.1.0-rc.15', { rcSource: 'c'.repeat(40) });
  assert.equal((await prepareCandidate(f)).source_sha, rc.source);
  rc.release.body = '<!-- aaa-muse-product:verified:conflict -->';
  await assert.rejects(prepareCandidate(f), /completion_conflict/);
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
  f.state.refs.set('tags/v0.1.0', { object: { type: 'commit', sha: f.source } });
  await assert.rejects(candidateRecovery(f), /original_bundle_unavailable/);
  f.state.runs = [{ id: 70 }, { id: 80 }];
  f.state.artifacts = [{ id: 1, name: bundleName(f.prepared), run_id: 70, expired: false }];
  f.state.originalRuns.set(70, { workflow_id: 7, event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'markhuangai/AaA-muse-ai' },
    head_repository: { full_name: 'markhuangai/AaA-muse-ai' }, actor: { login: 'Z-M-Huang' } });
  assert.deepEqual(await candidateRecovery(f), { run_id: 70, artifact_id: 1 });
  assert.equal((await candidateRecovery({ ...f, resumeRunID: '70' })).run_id, 70);
  assert.equal((await prepareCandidate({ ...f, resumeRunID: '70' })).resume_run_id, 70);
  f.state.artifacts[0].expired = true; await assert.rejects(candidateRecovery({ ...f, resumeRunID: '70' }), /unavailable/);
  f.state.artifacts[0].expired = false;
  f.state.originalRuns.get(70).head_branch = 'other'; await assert.rejects(candidateRecovery({ ...f, resumeRunID: '70' }), /untrusted/);
  await assert.rejects(candidateRecovery({ ...f, resumeRunID: '100' }), /must_use_original_bundle/);
  f.state.runs = []; f.state.artifacts = [];
  await assert.rejects(candidateRecovery({ ...f, resumeRunID: '100' }), /run_invalid/);
  f.state.refs.get('tags/v0.1.0').object.sha = 'f'.repeat(40); await assert.rejects(candidateRecovery(f), /reserved_for_other/);
  f.github.rest.git.getRef = async () => { throw { status: 403 }; }; await assert.rejects(candidateRecovery(f), error => error.fields.http_status === 403);
});
