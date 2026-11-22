import test from 'node:test';
import assert from 'node:assert/strict';
import { finalizeProductRelease } from './product-release.mjs';
import { chooseVersion, prepareRelease } from './worker-release.mjs';

function fixture() {
  const source = 'a'.repeat(40), digest = 'b'.repeat(64), imageConfig = 'sha256:' + 'c'.repeat(64), imageDigest = 'sha256:' + 'd'.repeat(64);
  const repository = { full_name: 'markhuangai/AaA-muse-ai' };
  const state = { main: source, assets: new Map(), uploads: 0, updates: 0, registry: true, configs: imageConfig, digest: imageDigest, response: null, body: `<!-- aaa-muse-worker:verified:${source}:${digest} -->` };
  const refsRoute = () => {}, releasesRoute = () => {}, pullsRoute = () => {};
  const github = { rest: {
    actions: { getWorkflow: async () => ({ data: { id: 7, path: '.github/workflows/ci.yml' } }) },
    git: { listMatchingRefs: refsRoute },
    repos: {
      getBranch: async () => ({ data: { commit: { sha: state.main } } }), listPullRequestsAssociatedWithCommit: pullsRoute, listReleases: releasesRoute,
      getReleaseByTag: async () => ({ data: { id: 1, draft: false, prerelease: true, tag_name: 'v1.0.0-rc.7', body: state.body, assets: [...state.assets.keys()].map(name => ({ name })) } }),
      uploadReleaseAsset: async ({ name, data }) => { state.uploads++; state.assets.set(name, data); },
      updateRelease: async ({ body }) => { state.updates++; state.body = body; },
    },
  }, paginate: async route => route === refsRoute ? [{ ref: 'refs/tags/v1.0.0-rc.6', object: { type: 'commit', sha: 'e'.repeat(40) } }] : route === releasesRoute ? [] : [{ merged_at: '2026-11-14', merge_commit_sha: source, base: { ref: 'main', repo: repository } }] };
  const context = { eventName: 'workflow_run', repo: { owner: 'markhuangai', repo: 'AaA-muse-ai' }, payload: { workflow_run: { id: 3, workflow_id: 7, event: 'push', conclusion: 'success', head_branch: 'main', head_sha: source, repository, head_repository: repository } } };
  const prepared = { source_sha: source, version: '1.0.0-rc.7', tag: 'v1.0.0-rc.7', paired: true };
  const worker = { source: { source_sha: source, source_dirty: false, package_version: prepared.version }, version: prepared.version, sha256: digest, installer_sha256: 'f'.repeat(64), package: '@markhuangai/aaa-muse-worker' };
  const image = { source_sha: source, tree_sha: 'e'.repeat(40), version: prepared.version, image_config_digest: imageConfig, worker_sha256: digest };
  const fetcher = async (url, options) => {
    if (url.startsWith('https://ghcr.io/token')) return Response.json({ token: 'registry-fixture' });
    if (url.startsWith('https://ghcr.io/v2/')) return state.registry ? Response.json({ config: { digest: state.configs } }, { headers: { 'docker-content-digest': state.digest } }) : new Response(null, { status: 404 });
    assert.equal(options.headers?.Authorization, undefined);
    return state.response ? state.response() : new Response(state.assets.get('product-release.json'));
  };
  return { state, github, context, prepared, worker, image, fetcher, token: 'private-fixture-token' };
}

test('paired selection includes service-only changes and reserves one shared version across retries', async () => {
  const f = fixture(); const prepared = await prepareRelease({ ...f, paired: true });
  assert.equal(prepared.should_publish, true); assert.equal(prepared.version, '1.0.0-rc.7'); assert.equal(prepared.tag, 'v1.0.0-rc.7');
  const ref = { ref: 'refs/tags/v1.0.0-rc.7', object: { type: 'commit', sha: f.prepared.source_sha } };
  assert.equal(chooseVersion([ref], f.prepared.source_sha, true, '1.0.0'), '1.0.0-rc.7');
  assert.equal(chooseVersion([ref], 'e'.repeat(40), true, '1.0.0'), '1.0.0-rc.8');
  assert.throws(() => chooseVersion([ref, { ...ref, ref: 'refs/tags/v1.0.0-rc.8' }], f.prepared.source_sha, true, '1.0.0'), /ambiguous/);
});

test('paired completion verifies registry identities and anonymous receipt bytes, then publishes once', async () => {
  const f = fixture(); const receipt = await finalizeProductRelease(f);
  assert.equal(receipt.version, f.worker.version); assert.equal(receipt.worker.sha256, f.worker.sha256);
  assert.equal(receipt.image, 'ghcr.io/markhuangai/aaa-muse-ai@' + f.state.digest);
  assert.equal(f.state.uploads, 1); assert.equal(f.state.updates, 1); assert.match(f.state.body, /aaa-muse-product:verified/);
  await finalizeProductRelease(f); assert.equal(f.state.uploads, 1); assert.equal(f.state.updates, 1);
});

test('incomplete or conflicting pairs never get a completion marker or overwrite immutable bytes', async () => {
  for (const change of [f => { f.worker.version = '0.1.0-rc.6'; }, f => { f.image.version = '0.1.0-rc.6'; }, f => { f.image.worker_sha256 = 'e'.repeat(64); },
    f => { f.state.main = 'e'.repeat(40); }, f => { f.state.body = ''; }, f => { f.state.registry = false; }, f => { f.state.configs = 'sha256:' + 'f'.repeat(64); },
    f => { f.state.assets.set('product-release.json', Buffer.from('conflicting immutable receipt')); },
    f => { f.state.body += '\n<!-- aaa-muse-product:verified:conflict -->'; },
    f => { f.state.response = () => new Response(null, { status: 503 }); },
    f => { f.state.response = () => new Response(null); },
    f => { f.state.response = () => new Response('x'.repeat(65537)); },
    f => { f.state.response = () => new Response('x', { headers: { 'content-length': '65537' } }); },
  ]) {
    const f = fixture(); change(f); await assert.rejects(finalizeProductRelease(f));
    assert.equal(f.state.updates, 0); assert(!f.state.body.includes('Paired artifact publication verified'));
  }
});
