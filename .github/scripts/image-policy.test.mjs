import assert from 'node:assert/strict';
import test from 'node:test';
import { imageConfigDigest, registryManifest, resolvePublication } from './image-policy.mjs';

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
  const state = { pulls: [], main: sha };
  const github = { rest: { repos: {
    getBranch: async () => ({ data: { commit: { sha: state.main } } }),
    listPullRequestsAssociatedWithCommit() {},
  }, actions: {
    getWorkflow: async () => ({ data: { id: 9, path: '.github/workflows/ci.yml' } }),
  } }, paginate: async () => state.pulls };
  const context = { repo: { owner: 'markhuangai', repo: 'AaA-muse-ai' }, eventName: 'workflow_run' };
  return { state, github, context };
}

test('publication requires trusted successful main CI, exact current source and a merged PR', async () => {
  const make = () => { const f = fixture();
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
