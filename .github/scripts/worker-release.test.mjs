import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseVersion, shippedInput, prepareRelease, publishRelease, reportReleaseFailure, ReleaseFailure, npmPublishMaxBuffer } from './worker-release.mjs';

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
    if (url.endsWith('%2faaa-muse-worker')) return new Response(state.registry ? JSON.stringify({ versions: { [receipt.version]: state.registry } }) : '{}', { status: state.registry ? 200 : 404 });
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
    assert.equal(f.state.uploads, 0); assert(!f.state.requests.some(r => new URL(r.url).hostname === 'foreign.test'));
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

test('default npm publication bounds real subprocess output and protects credentials', async t => {
  assert.equal(npmPublishMaxBuffer, 1024 * 1024);
  const directory = mkdtempSync(join(tmpdir(), 'worker-release-npm-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const shim = join(directory, 'npm');
  const script = join(directory, 'fake-npm.mjs');
  const report = join(directory, 'invocation.json');
  writeFileSync(shim, '#!/bin/sh\nexec "$FAKE_NPM_NODE" "$FAKE_NPM_SCRIPT" "$@"\n');
  chmodSync(shim, 0o755);
  writeFileSync(script, `
    import { writeFileSync } from 'node:fs';
    const token = process.env.NODE_AUTH_TOKEN;
    const mode = process.env.FAKE_NPM_MODE;
    const output = mode === 'success' ? JSON.stringify({ notice: 'x'.repeat(17 * 1024), token }) :
      mode === 'overflow' ? token + 'x'.repeat(2 * 1024 * 1024) :
      mode === 'malformed' ? '{"error":' + token :
      JSON.stringify({ error: { code: mode === 'conflict' ? 'EPUBLISHCONFLICT' : token, detail: token } });
    writeFileSync(process.env.FAKE_NPM_REPORT, JSON.stringify({ args: process.argv.slice(2),
      authenticated: token === process.env.FAKE_NPM_TOKEN, stdout_bytes: Buffer.byteLength(output) }));
    process.stderr.write(token);
    process.stdout.write(output);
    if (mode !== 'success' && mode !== 'overflow') process.exitCode = 1;
  `);
  const scenarios = [
    { name: 'large RC output', mode: 'success' },
    { name: 'large candidate output', mode: 'success', candidate: true },
    { name: 'publish conflict', mode: 'conflict', npmCode: 'EPUBLISHCONFLICT' },
    { name: 'malformed error', mode: 'malformed', npmCode: 'unavailable' },
    { name: 'output overflow', mode: 'overflow', npmCode: 'unavailable' },
    { name: 'credential-shaped error code', mode: 'secret-code', npmCode: 'unavailable' },
  ];
  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const f = fixture();
      const version = scenario.candidate ? '1.0.0' : '0.1.0-rc.0';
      const prepared = { source_sha: source, version, tag: scenario.candidate ? 'v1.0.0' : 'worker-v0.1.0-rc.0',
        should_publish: true, ...(scenario.candidate ? { paired: true, candidate: true } : {}) };
      f.receipt.version = f.receipt.source.package_version = version;
      const token = 'EFAKE_TEST_TOKEN_987654';
      let registryReads = 0;
      const fetcher = async (url, options) => {
        if (url.endsWith('%2faaa-muse-worker') && ++registryReads === 2) {
          f.state.registry = { name: f.receipt.package, version, dist: { tarball: 'https://npm.pkg.github.com/archive.tgz' } };
        }
        return f.fetcher(url, options);
      };
      const environment = { PATH: directory, FAKE_NPM_NODE: process.execPath, FAKE_NPM_SCRIPT: script,
        FAKE_NPM_REPORT: report, FAKE_NPM_TOKEN: token, FAKE_NPM_MODE: scenario.mode };
      const previous = Object.fromEntries(Object.keys(environment).map(key => [key, process.env[key]]));
      const originalLog = console.log;
      const logs = [], failures = [];
      let failure;
      try {
        Object.assign(process.env, environment);
        console.log = line => logs.push(String(line));
        const options = { ...f, prepared, archive: f.state.archive, token, fetcher, publishNpm: undefined };
        if (scenario.mode === 'success') {
          await publishRelease(options);
          assert.equal(f.state.uploads, 3);
        } else {
          await assert.rejects(publishRelease(options), error => { failure = error; return error instanceof ReleaseFailure; });
          reportReleaseFailure({ error: line => logs.push(line), setFailed: line => failures.push(line) }, failure, prepared);
        }
      } finally {
        console.log = originalLog;
        for (const [key, value] of Object.entries(previous)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
      }
      assert.equal([...logs, ...failures, failure?.stack ?? '', JSON.stringify(failure?.fields ?? {})].join('\n').includes(token), false,
        'npm credential appeared in diagnostics');
      const invocation = JSON.parse(readFileSync(report, 'utf8'));
      const expected = ['publish', f.receipt.archive, '--ignore-scripts', '--registry', 'https://npm.pkg.github.com',
        '--tag', scenario.candidate ? 'candidate-1.0.0' : 'rc', '--json', '--silent'];
      assert.equal(JSON.stringify(invocation.args).includes(token), false, 'npm credential appeared in arguments');
      assert.equal(JSON.stringify(invocation.args) === JSON.stringify(expected), true, 'npm publish arguments differ');
      assert.equal(invocation.authenticated, true);
      if (scenario.mode === 'success') assert(invocation.stdout_bytes > 16 * 1024);
      if (scenario.mode === 'overflow') assert(invocation.stdout_bytes > npmPublishMaxBuffer);
      const events = logs.map(line => JSON.parse(line));
      if (failure) {
        const failed = events.find(event => event.event === 'worker.release.failed');
        assert.equal(failed.level, 'ERROR');
        assert.equal(failed.cause, 'worker_release_npm_publish_failed');
        assert.equal(failed.operation, 'npm_publish');
        assert.equal(failed.destination, 'github_packages');
        assert.equal(failed.source_sha, source);
        assert.equal(failed.version, version);
        assert.equal(failed.tag, prepared.tag);
        assert.deepEqual(failed.completed_destinations, ['git_tag']);
        assert.equal(failed.npm_code, scenario.npmCode);
        assert.equal(failed.raw_output_omitted, true);
        assert.equal(failed.omission_reason, 'authentication_material_protection');
        if (scenario.mode === 'overflow') assert.equal(failed.process_code, 'ENOBUFS');
        else assert.equal(failed.process_status, 1);
        assert.equal(failures.length, 1);
      }
    });
  }
});
