import assert from 'node:assert/strict';
import test from 'node:test';
import { fenceCandidate, imageConfigDigest, registryManifest, resolveCandidate, resolvePublication } from './image-policy.mjs';

const sha = 'a'.repeat(40), tree = 'b'.repeat(40), digest = `sha256:${'c'.repeat(64)}`;
const repo = { id: 1, full_name: 'markhuangai/AaA-muse-ai' };
const pull = () => ({ number: 2, state: 'open', draft: false, head: { sha, repo }, base: { ref: 'main', repo } });

test('image config identity supports classic and descriptor-based Docker stores without conflating manifest digests', () => {
  assert.equal(imageConfigDigest({ Id: digest }), digest);
  assert.equal(imageConfigDigest({ Id: `sha256:${'d'.repeat(64)}`, Descriptor: { annotations: { 'config.digest': digest } } }), digest);
  assert.throws(() => imageConfigDigest({ Id: digest, Descriptor: {} }), /unavailable/);
  assert.throws(() => imageConfigDigest({ Id: 'invalid' }), /unavailable/);
});
function fixture() {
  const state = { permission: 'admin', ancestor: true, pulls: [pull()], current: pull(), main: sha };
  const github = { rest: { repos: {
    getCollaboratorPermissionLevel: async () => ({ data: { permission: state.permission } }),
    get: async () => ({ data: { ...repo, default_branch: 'main' } }),
    getCommit: async () => ({ data: { sha, commit: { tree: { sha: tree } } } }),
    compareCommitsWithBasehead: async () => ({ data: { merge_base_commit: { sha: state.ancestor ? sha : tree } } }),
    getBranch: async () => ({ data: { commit: { sha: state.main } } }),
    listPullRequestsAssociatedWithCommit() {},
  }, pulls: { list() {}, get: async () => ({ data: state.current }) }, actions: {
    getWorkflow: async () => ({ data: { id: 9, path: '.github/workflows/ci.yml' } }),
  } }, paginate: async () => state.pulls };
  const context = { repo: { owner: 'markhuangai', repo: 'AaA-muse-ai' }, actor: 'Z-M-Huang', eventName: 'workflow_dispatch', ref: 'refs/heads/main' };
  return { state, github, context };
}

test('candidate verifies actor, exact source/tree, main ancestry or current same-repository PR', async () => {
  const f = fixture();
  assert.deepEqual(await resolveCandidate({ ...f, sourceSHA: sha }), { source_sha: sha, tree_sha: tree, pr: null, actor: 'Z-M-Huang' });
  f.state.ancestor = false;
  assert.equal((await resolveCandidate({ ...f, sourceSHA: sha })).pr, 2);
  await fenceCandidate({ ...f, sourceSHA: sha, pr: 2 });
  f.state.current.head.sha = tree;
  await assert.rejects(fenceCandidate({ ...f, sourceSHA: sha, pr: 2 }), /head_changed/);
  await assert.rejects(fenceCandidate({ ...f, sourceSHA: sha, pr: null }), /ancestry_changed/);
});

test('candidate rejects untrusted events, invalid SHA, insufficient permission and ambiguous PRs', async () => {
  for (const mutate of [f => { f.context.ref = 'refs/heads/feature'; }, f => { f.context.eventName = 'push'; },
    f => { f.context.repo.owner = 'foreign'; }, f => { f.state.permission = 'read'; },
    f => { f.state.ancestor = false; f.state.pulls = []; }, f => { f.state.ancestor = false; f.state.pulls = [pull(), pull()]; },
    f => { f.state.ancestor = false; f.state.pulls[0].head.repo = { id: 2 }; },
    f => { f.state.ancestor = false; f.state.pulls[0].draft = true; }]) {
    const f = fixture(); mutate(f); await assert.rejects(resolveCandidate({ ...f, sourceSHA: sha }));
  }
  await assert.rejects(resolveCandidate({ ...fixture(), sourceSHA: 'main' }));
  const f = fixture(); f.github.rest.repos.getCommit = async () => ({ data: { sha: tree } });
  await assert.rejects(resolveCandidate({ ...f, sourceSHA: sha }), /identity_mismatch/);
});

test('publication requires trusted successful main CI, exact current source and a merged PR', async () => {
  const make = () => { const f = fixture(); f.context.eventName = 'workflow_run';
    f.context.payload = { workflow_run: { id: 10, workflow_id: 9, event: 'push', conclusion: 'success', head_branch: 'main', head_sha: sha, repository: repo, head_repository: repo } };
    f.state.pulls = [{ ...pull(), merged_at: '2026-11-08T00:00:00Z', merge_commit_sha: sha }]; return f; };
  assert.equal(await resolvePublication(make()), sha);
  for (const mutate of [f => { f.context.payload.workflow_run.conclusion = 'failure'; },
    f => { f.context.payload.workflow_run.event = 'pull_request'; }, f => { f.context.payload.workflow_run.workflow_id = 8; },
    f => { f.state.main = tree; }, f => { f.state.pulls = []; }, f => { f.context.payload.workflow_run.head_repository = { full_name: 'fork/repo' }; }]) {
    const f = make(); mutate(f); await assert.rejects(resolvePublication(f));
  }
});

test('immutable manifest handling distinguishes absence, matching bytes, conflicts and ambiguous failures', async () => {
  const response = (status, body, imageDigest = digest) => ({ status, ok: status >= 200 && status < 300, json: async () => body, headers: { get: () => imageDigest } });
  const run = async (manifest, auth = response(200, { token: 'ephemeral-fixture-token' })) => {
    let count = 0;
    return registryManifest({ token: 'fixture-only', image: 'markhuangai/aaa-muse-ai', tag: `sha-${sha}`, expectedConfig: digest,
      fetcher: async () => ++count === 1 ? auth : manifest });
  };
  assert.deepEqual(await run(response(404, {})), { exists: false });
  assert.deepEqual(await run(response(200, { config: { digest } })), { exists: true, digest });
  await assert.rejects(run(response(200, { config: { digest: 'different' } })), /conflict/);
  await assert.rejects(run(response(200, { config: { digest } }, 'invalid')), /conflict/);
  await assert.rejects(run(response(403, {})), /http_403/);
  await assert.rejects(run(response(500, {})), /http_500/);
  await assert.rejects(run(response(404, {}), response(401, {})), /auth_failed_http_401/);
  await assert.rejects(run(response(404, {}), response(200, {})), /token_missing/);
});
