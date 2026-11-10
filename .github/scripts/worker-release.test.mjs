import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chooseVersion, shippedInput, prepareRelease, publishRelease, reportReleaseFailure, ReleaseFailure } from './worker-release.mjs';

const source = 'a'.repeat(40), prior = 'b'.repeat(40);
const digest = value => createHash('sha256').update(value).digest('hex');
const tag = (n, sha = source) => ({ ref: `refs/tags/worker-v0.1.0-rc.${n}`, object: { type: 'commit', sha } });
function fixture() {
  const state = { refs: [], releases: [], files: [], archive: Buffer.from('real production digest input'), registry: null, published: 0, uploads: 0, main: source, public: new Map(), requests: [] };
  const repo = { full_name: 'markhuangai/AaA-muse-ai' };
  const routes = { refs() {}, releases() {}, pulls() {} };
  const github = { rest: { actions: { getWorkflow: async () => ({ data: { id: 7, path: '.github/workflows/ci.yml' } }) }, git: {
    listMatchingRefs: routes.refs,
    getRef: async ({ ref }) => { const value = state.refs.find(x => x.ref === 'refs/' + ref); if (!value) throw { status: 404 }; return { data: value }; },
    createRef: async ({ ref, sha }) => { state.refs.push({ ref, object: { type: 'commit', sha } }); },
  }, repos: {
    listReleases: routes.releases, listPullRequestsAssociatedWithCommit: routes.pulls,
    getBranch: async () => ({ data: { commit: { sha: state.main } } }),
    compareCommitsWithBasehead: async () => ({ data: { merge_base_commit: { sha: prior }, files: state.files } }),
    getReleaseByTag: async ({ tag }) => { const value = state.releases.find(x => x.tag_name === tag); if (!value) throw { status: 404 }; return { data: value }; },
    createRelease: async value => { const release = { ...value, id: 1, assets: [] }; state.releases.push(release); return { data: release }; },
    uploadReleaseAsset: async ({ name, data }) => { state.uploads++; state.public.set(name, data); state.releases[0].assets.push({ name }); },
    updateRelease: async ({ body }) => { state.releases[0].body = body; },
  } }, paginate: async route => route === routes.refs ? state.refs : route === routes.releases ? state.releases : [{ merged_at: '2026-11-10', merge_commit_sha: source, base: { ref: 'main', repo } }] };
  const context = { eventName: 'workflow_run', repo: { owner: 'markhuangai', repo: 'AaA-muse-ai' }, payload: { workflow_run: { id: 3, workflow_id: 7, event: 'push', conclusion: 'success', head_branch: 'main', head_sha: source, repository: repo, head_repository: repo } } };
  const receipt = { archive: '/fixture/archive.tgz', version: '0.1.0-rc.0', package: '@markhuangai/aaa-muse-worker', source: { source_sha: source, source_dirty: false, package_version: '0.1.0-rc.0' }, sha256: digest(state.archive) };
  const fetcher = async (url, options) => {
    state.requests.push({ url, options });
    if (url.endsWith('%2faaa-muse-worker')) return new Response(state.registry ? JSON.stringify({ versions: { '0.1.0-rc.0': state.registry } }) : '{}', { status: state.registry ? 200 : 404 });
    if (url.startsWith('https://npm.pkg.github.com/')) return new Response(state.registryBytes ?? state.archive);
    const content = state.public.get(url.split('/').at(-1));
    return new Response(content ?? '', { status: content ? 200 : 404 });
  };
  const publishNpm = async () => { state.published++; state.registry = { name: receipt.package, version: receipt.version, dist: { tarball: 'https://npm.pkg.github.com/archive.tgz' } }; };
  return { state, github, context, receipt, fetcher, publishNpm };
}

test('worker prerelease allocation is monotonic, source-bound, and limited to shipped inputs', () => {
  assert.equal(chooseVersion([], source), '0.1.0-rc.0');
  assert.equal(chooseVersion([tag(4, prior)], source), '0.1.0-rc.5');
  assert.equal(chooseVersion([tag(4)], source), '0.1.0-rc.4');
  assert.throws(() => chooseVersion([tag(1), tag(2)], source), /ambiguous/);
  assert.throws(() => chooseVersion([{ ...tag(1), object: { type: 'tag', sha: source } }], source), /invalid_tag/);
  assert.throws(() => chooseVersion([tag('9007199254740991')], source), /overflow/);
  for (const name of ['worker/src/setup.ts', 'worker/setup/install.sh', 'worker/package.json', 'worker/scripts/build.mjs', 'package-lock.json']) assert(shippedInput(name));
  for (const name of ['worker/test/setup.test.mjs', 'README.md', '.github/workflows/ci.yml', 'internal/service/setup.go']) assert(!shippedInput(name));
});

test('release classification compares shipped inputs since the last completed immutable release', async () => {
  const f = fixture(); assert.equal((await prepareRelease(f)).version, '0.1.0-rc.0');
  f.state.refs.push(tag(0, prior));
  f.state.releases.push({ tag_name: 'worker-v0.1.0-rc.0', prerelease: true, draft: false, body: `<!-- aaa-muse-worker:verified:${prior}:${'c'.repeat(64)} -->`, assets: ['markhuangai-aaa-muse-worker-0.1.0-rc.0.tgz', 'SHA256SUMS', 'worker-release.json'].map(name => ({ name })) });
  f.state.files = [{ filename: 'README.md' }]; assert.equal((await prepareRelease(f)).should_publish, false);
  f.state.files = [{ filename: 'worker/src/setup.ts' }]; assert.equal((await prepareRelease(f)).should_publish, true);
  f.state.files = [{ filename: 'other', previous_filename: 'worker/setup/old.sh' }]; assert.equal((await prepareRelease(f)).should_publish, true);
  f.state.files = Array.from({ length: 300 }, () => ({ filename: 'README.md' }));
  await assert.rejects(prepareRelease(f), /comparison_incomplete/);
  f.state.main = prior; await assert.rejects(prepareRelease(f), /main_head_changed/);
});

test('publication verifies equal registry/public bytes, anonymous downloads, and idempotent retries', async () => {
  const f = fixture(); const prepared = await prepareRelease(f);
  await publishRelease({ ...f, prepared, archive: f.state.archive, token: 'fixture-token' });
  assert.equal(f.state.published, 1); assert.equal(f.state.uploads, 3);
  assert.equal(f.state.refs[0].object.sha, source);
  assert.equal(digest(f.state.public.get('markhuangai-aaa-muse-worker-0.1.0-rc.0.tgz')), f.receipt.sha256);
  assert.match(f.state.releases[0].body, /aaa-muse-worker:verified/);
  assert(f.state.requests.filter(r => r.url.startsWith('https://github.com/')).every(r => !r.options.headers.Authorization));
  await publishRelease({ ...f, prepared, archive: f.state.archive, token: 'fixture-token' });
  assert.equal(f.state.published, 1); assert.equal(f.state.uploads, 3);
  f.state.public.set('SHA256SUMS', Buffer.from('wrong bytes'));
  await assert.rejects(publishRelease({ ...f, prepared, archive: f.state.archive, token: 'fixture-token' }), /artifact_conflict/);
  assert.equal(f.state.uploads, 3);
});

test('publication rejects dirty source, conflicting tags, registry content, and foreign credential destinations', async () => {
  for (const change of [f => { f.receipt.source.source_dirty = true; }, f => { f.receipt.sha256 = '0'.repeat(64); },
    f => { f.state.refs.push(tag(0, prior)); }, f => { f.state.registry = { name: f.receipt.package, version: f.receipt.version, dist: { tarball: 'https://foreign.test/archive' } }; },
    f => { f.state.registry = { name: f.receipt.package, version: f.receipt.version, dist: { tarball: 'https://npm.pkg.github.com/archive' } }; f.state.registryBytes = Buffer.from('wrong'); }]) {
    const f = fixture(); const prepared = await prepareRelease(f); change(f);
    await assert.rejects(publishRelease({ ...f, prepared, archive: f.state.archive, token: 'fixture-token' }));
    assert.equal(f.state.uploads, 0); assert(!f.state.requests.some(r => r.url.startsWith('https://foreign.test')));
  }
  const f = fixture(); const prepared = await prepareRelease(f);
  await assert.rejects(publishRelease({ ...f, prepared, archive: f.state.archive, token: 'fixture-token', fetcher: async () => new Response('{}', { status: 403 }) }), /registry_metadata_failed/);
  const messages = []; const core = { error: value => messages.push(value), setFailed: value => messages.push(value) };
  reportReleaseFailure(core, new ReleaseFailure('worker_release_artifact_conflict', { expected_digest: 'a', observed_digest: 'b' }), prepared);
  reportReleaseFailure(core, { status: 403, response: { headers: { 'x-github-request-id': 'request-1' } }, message: 'credential-must-not-print' }, prepared);
  assert(messages.some(m => m.includes('request-1'))); assert(!messages.join('').includes('credential-must-not-print'));
});

test('partial publication diagnostics identify verified destinations and the exact failed operation', async () => {
  for (const [method, operation, destination] of [
    ['createRelease', 'release_creation', 'github_release'],
    ['uploadReleaseAsset', 'asset_upload', 'public_release/markhuangai-aaa-muse-worker-0.1.0-rc.0.tgz'],
    ['updateRelease', 'completion_marker_publication', 'release_receipt'],
  ]) {
    const f = fixture(); const prepared = await prepareRelease(f);
    f.github.rest.repos[method] = async () => { throw { status: 403, response: { headers: { 'x-github-request-id': 'failed-' + method } }, message: 'fixture-token' }; };
    let observed;
    await assert.rejects(publishRelease({ ...f, prepared, archive: f.state.archive, token: 'fixture-token' }), error => {
      observed = error;
      assert.equal(error.fields.operation, operation); assert.equal(error.fields.destination, destination);
      assert.equal(error.fields.source_sha, source); assert.equal(error.fields.version, f.receipt.version);
      assert(error.fields.completed_destinations.includes('github_packages'));
      assert.equal(error.fields.expected_digest, f.receipt.sha256);
      assert.equal(error.fields.observed_digest, 'unavailable');
      if (method === 'updateRelease') assert.equal(error.fields.completed_destinations.filter(d => d.startsWith('public_release/')).length, 3);
      return true;
    });
    const messages = [];
    reportReleaseFailure({ error: value => messages.push(JSON.parse(value)), setFailed() {} }, observed, prepared);
    assert.equal(messages[0].request_id, 'failed-' + method); assert.equal(messages[0].http_status, 403);
    assert.equal(messages[0].outcome, 'incomplete'); assert(!JSON.stringify(messages).includes('fixture-token'));
  }
});
