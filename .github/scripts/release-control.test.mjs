import test from 'node:test';
import assert from 'node:assert/strict';
import { releaseFixture } from './test/release-fixture.mjs';
import { resolveStableSource, candidateRecovery, bundleName } from './release-control.mjs';

test('only an administrator dispatch from trusted main can select the checked issue 19 merge', async t => {
  const f = await releaseFixture(t);
  const run = () => resolveStableSource({ ...f, sourceSHA: f.source, phase: 'candidate', version: f.version });
  const result = await run(); assert.equal(result.tree_sha, f.tree); assert.equal(result.pr, 49); assert.equal(result.tag, 'v0.1.0');
  for (const [object, key, value, cause] of [[f.context, 'eventName', 'pull_request', 'untrusted'], [f.context, 'ref', 'refs/heads/other', 'untrusted'],
    [f.state, 'permission', 'write', 'administrator'], [f.state, 'source', 'f'.repeat(40), 'source_identity'],
    [f.state, 'sourceOnMain', false, 'not_on_main'], [f.state, 'merged', false, 'delivery_merge'],
    [f.state, 'files', [], 'issue_19_delivery'], [f.state, 'mainSuccess', false, 'main_checks']]) {
    const prior = object[key]; object[key] = value; await assert.rejects(run(), new RegExp(cause)); object[key] = prior;
  }
  const paginate = f.github.paginate;
  f.github.paginate = async (route, options) => options.run_id ? [] : paginate(route, options);
  await assert.rejects(run(), /jobs_incomplete/);
  f.github.paginate = async (route, options) => options.run_id ? [{ name: 'other', conclusion: 'success' }] : paginate(route, options);
  await assert.rejects(run(), /verifier_missing/);
});

test('candidate recovery selects original trusted bytes and never rebuilds a reserved version without them', async t => {
  const f = await releaseFixture(t);
  assert.equal(await candidateRecovery(f), null);
  f.state.runs = [{ id: 70 }];
  f.state.artifacts = [{ id: 1, name: bundleName(f.prepared), run_id: 70, expired: true }];
  await assert.rejects(candidateRecovery(f), /original_bundle_unavailable/);
  assert.equal(f.state.refs.size, 0);
  f.state.artifacts = [];
  f.state.historyJobs.set(70, [{ name: 'build', steps: [{ name: 'Freeze original image and worker bytes before any publication', conclusion: 'success' }] }]);
  await assert.rejects(candidateRecovery(f), error => error.fields.artifact_record_missing === true && error.fields.original_run_id === 70);
  assert.equal(f.state.refs.size, 0); f.state.historyJobs.clear();
  f.state.runs = []; f.state.artifacts = [];
  f.state.refs.set('tags/v0.1.0', { object: { type: 'commit', sha: f.source } });
  await assert.rejects(candidateRecovery(f), /original_bundle_unavailable/);
  f.state.runs = [{ id: 70 }, { id: 80 }];
  f.state.artifacts = [{ id: 1, name: bundleName(f.prepared), run_id: 70, expired: false }];
  f.state.originalRuns.set(70, { workflow_id: 7, event: 'workflow_dispatch', head_branch: 'main', repository: { full_name: 'markhuangai/AaA-muse-ai' },
    head_repository: { full_name: 'markhuangai/AaA-muse-ai' }, actor: { login: 'Z-M-Huang' } });
  assert.deepEqual(await candidateRecovery(f), { run_id: 70, artifact_id: 1 });
  assert.equal((await candidateRecovery({ ...f, resumeRunID: '70' })).run_id, 70);
  f.state.artifacts[0].expired = true; await assert.rejects(candidateRecovery({ ...f, resumeRunID: '70' }), /unavailable/);
  f.state.artifacts[0].expired = false;
  f.state.originalRuns.get(70).actor.login = 'another'; await assert.rejects(candidateRecovery({ ...f, resumeRunID: '70' }), /untrusted/);
  await assert.rejects(candidateRecovery({ ...f, resumeRunID: '100' }), /must_use_original_bundle/);
  f.state.runs = []; f.state.artifacts = [];
  await assert.rejects(candidateRecovery({ ...f, resumeRunID: '100' }), /run_invalid/);
  f.state.refs.get('tags/v0.1.0').object.sha = 'f'.repeat(40); await assert.rejects(candidateRecovery(f), /reserved_for_other/);
  f.github.rest.git.getRef = async () => { throw { status: 403 }; }; await assert.rejects(candidateRecovery(f), error => error.fields.http_status === 403);
});
