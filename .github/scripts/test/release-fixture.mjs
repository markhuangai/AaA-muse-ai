import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, jsonBytes, packageName, repository, imageName, inspectWorker, makeManifest } from '../release-manifest.mjs';

export async function releaseFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'aaa-release-test-'));
  const source = 'a'.repeat(40), tree = 'e'.repeat(40), version = '0.1.0';
  mkdirSync(join(directory, 'package/dist'), { recursive: true }); mkdirSync(join(directory, 'package/setup'));
  writeFileSync(join(directory, 'package/package.json'), jsonBytes({ name: packageName, version }));
  writeFileSync(join(directory, 'package/dist/build.json'), jsonBytes({ source_sha: source, source_dirty: false, package_version: version }));
  writeFileSync(join(directory, 'package/setup/install.sh'), '#!/bin/sh\nprintf "controlled installer"\n');
  execFileSync('tar', ['-czf', join(directory, 'worker.tgz'), '-C', directory, 'package']);
  const archive = readFileSync(join(directory, 'worker.tgz')), worker = inspectWorker(join(directory, 'worker.tgz'));
  const config = { config: { User: '10001:10001', ExposedPorts: { '8080/tcp': {} }, Labels: {
    'org.opencontainers.image.revision': source, 'org.opencontainers.image.version': version, 'io.aaa-muse.source-dirty': 'false' } } };
  const configBytes = jsonBytes(config), configDigest = 'sha256:' + hash(configBytes);
  const imageBytes = jsonBytes({ schemaVersion: 2, config: { digest: configDigest }, layers: [] }), imageDigest = 'sha256:' + hash(imageBytes);
  const manifest = makeManifest({ source_sha: source, tree_sha: tree, version, image_digest: imageDigest, image_config_digest: configDigest, worker, publication_kind: 'candidate' });
  const bundle = { schema_version: 1, source_sha: source, tree_sha: tree, version, image_config_digest: configDigest, worker,
    image_archive_sha256: hash(Buffer.from('controlled image save')) };
  writeFileSync(join(directory, 'image.tar'), 'controlled image save'); writeFileSync(join(directory, 'bundle.json'), jsonBytes(bundle));
  const state = { refs: new Map(), assets: new Map(), images: new Map(), npm: null, tags: {}, requests: [], commands: [], uploads: 0,
    phase: 'candidate', permission: 'admin', merged: true, files: [{ filename: '.github/workflows/release.yml', status: 'added' }], tree, source,
    sourceOnMain: true, mainSuccess: true, failAsset: null, corrupt: null, extraRun: null, artifacts: [], runs: [], originalRuns: new Map(), historyJobs: new Map(), imageBytes, configBytes };
  const context = { repo: { owner: 'markhuangai', repo: 'AaA-muse-ai' }, ref: 'refs/heads/main', eventName: 'workflow_dispatch', actor: 'Z-M-Huang', runId: 100, runAttempt: 1 };
  const prepared = { source_sha: source, tree_sha: tree, version, tag: 'v' + version, candidate: true, paired: true, should_publish: true };
  const route = { pulls() {}, files() {}, jobs() {}, artifacts() {} };
  const release = { id: 1, tag_name: prepared.tag, prerelease: true, draft: false, immutable: false, body: '', assets: [] };
  const github = { rest: {
    repos: {
      getCollaboratorPermissionLevel: async () => ({ data: { permission: state.permission } }),
      getCommit: async () => ({ data: { sha: state.source, commit: { tree: { sha: state.tree } } } }),
      compareCommitsWithBasehead: async () => ({ data: { merge_base_commit: { sha: state.sourceOnMain ? source : 'f'.repeat(40) } } }),
      listPullRequestsAssociatedWithCommit: route.pulls,
      getReleaseByTag: async () => { if (!state.release) throw { status: 404 }; return { data: structuredClone(release) }; },
      createRelease: async value => { Object.assign(release, value); state.release = true; return { data: structuredClone(release) }; },
      uploadReleaseAsset: async ({ name, data }) => {
        if (state.failAsset === name) throw { status: 503, message: 'secret-sentinel' };
        state.uploads++; state.assets.set(name, Buffer.from(data)); release.assets.push({ id: state.uploads, name, size: data.length });
      },
      updateRelease: async value => { Object.assign(release, value); return { data: structuredClone(release) }; },
    },
    pulls: { listFiles: route.files },
    actions: {
      getWorkflow: async () => ({ data: { id: 7 } }),
      listWorkflowRuns: async ({ workflow_id }) => ({ data: { workflow_runs: typeof workflow_id === 'number' ? state.runs : [{ id: 1, head_sha: source, head_branch: 'main', status: 'completed', conclusion: state.mainSuccess ? 'success' : 'failure' }] } }),
      listJobsForWorkflowRun: route.jobs, listWorkflowRunArtifacts: route.artifacts,
      getWorkflowRun: async ({ run_id }) => ({ data: state.originalRuns.get(run_id) }),
    },
    git: {
      getRef: async ({ ref }) => { if (!state.refs.has(ref)) throw { status: 404 }; return { data: state.refs.get(ref) }; },
      createRef: async ({ ref, sha }) => { state.refs.set(ref.replace('refs/', ''), { object: { type: 'commit', sha } }); },
    },
  }, paginate: async (method, options) => {
    if (method === github.rest.actions.listWorkflowRuns) return state.runs;
    if (method === route.pulls) return state.merged ? [{ merged_at: '2026-11-17', merge_commit_sha: source, number: 49,
      base: { ref: 'main', repo: { full_name: repository } }, head: { repo: { full_name: repository } }, user: { login: 'Z-M-Huang' } }] : [];
    if (method === route.files) return state.files;
    if (method === route.jobs) return options.filter === 'all' ? state.historyJobs.get(options.run_id) ?? [] : [{ name: 'Release / verify', conclusion: state.mainSuccess ? 'success' : 'failure' }];
    if (method === route.artifacts) return state.artifacts.filter(artifact => !artifact.run_id || artifact.run_id === options.run_id);
    throw new Error('unexpected fixture API');
  } };
  const server = createServer((request, response) => {
    const target = new URL(request.headers['x-upstream-url']);
    state.requests.push({ url: target.href, authenticated: !!request.headers.authorization });
    const send = (bytes, status = 200, headers = {}) => { response.writeHead(status, headers); response.end(bytes); };
    if (state.corrupt === target.href) return send('corrupted');
    if (target.hostname === 'api.github.com') {
      if (target.pathname.includes('/git/ref/')) return send(jsonBytes(state.refs.get('tags/' + prepared.tag) ?? {}));
      return send(jsonBytes({ sha: state.source, commit: { tree: { sha: state.tree } } }));
    }
    if (target.hostname === 'npm.pkg.github.com') {
      if (target.pathname.endsWith('aaa-muse-worker')) return state.npm ? send(jsonBytes({ versions: { [version]: state.npm }, 'dist-tags': state.tags })) : send('', 404);
      return send(state.npmBytes ?? archive);
    }
    if (target.hostname === 'ghcr.io') {
      if (target.pathname === '/token') return send(jsonBytes({ token: 'fixture-registry-bearer' }));
      if (target.pathname.includes('/blobs/')) return send(state.configBytes);
      const value = state.images.get(target.pathname.split('/manifests/')[1]);
      return value ? send(value, 200, { 'docker-content-digest': 'sha256:' + hash(value) }) : send('', 404);
    }
    const content = state.assets.get(target.pathname.split('/').at(-1));
    return content ? send(content) : send('', 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true }); });
  const fetcher = async (url, options = {}) => {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/`, { ...options, headers: { ...options.headers, 'x-upstream-url': url } });
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  };
  const npmMetadata = () => ({ name: packageName, version, dist: { tarball: 'https://npm.pkg.github.com/archive.tgz' } });
  const execute = (command, args, options = {}) => {
    if (command === 'tar') return execFileSync(command, args, options);
    state.commands.push([command, ...args]);
    if (command === 'npm' && args[0] === 'dist-tag') { state.tags[args[3]] = version; return ''; }
    if (command === 'docker' && args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Id: configDigest, Config: config.config }]);
    if (command === 'docker' && args[0] === 'save') { writeFileSync(args.at(-1), 'controlled image save'); return ''; }
    if (command === 'docker' && args[0] === 'push') {
      state.images.set(args[1].slice(imageName.length + 1), imageBytes); state.images.set(imageDigest, imageBytes); return '';
    }
    if (command === 'docker' && args[0] === 'buildx') { state.images.set(args[args.indexOf('--tag') + 1].slice(imageName.length + 1), imageBytes); return ''; }
    return '';
  };
  const publishNpm = async () => { state.npm = npmMetadata(); state.tags.candidate = version; };
  const seed = () => {
    state.release = true; state.refs.set('tags/' + prepared.tag, { object: { type: 'commit', sha: source } });
    state.npm = npmMetadata(); state.tags.candidate = version;
    for (const tag of ['candidate-' + version, `sha-${source}-${version}`, imageDigest]) state.images.set(tag, imageBytes);
    for (const [name, bytes] of [['product-release.json', jsonBytes(manifest)], [manifest.worker.archive, archive],
      ['worker-release.json', jsonBytes({ package: packageName, version, source_sha: source, archive: manifest.worker.archive, sha256: worker.sha256 })],
      ['SHA256SUMS', Buffer.from(`${worker.sha256}  ${manifest.worker.archive}\n`)]]) {
      state.assets.set(name, bytes); release.assets.push({ id: state.assets.size, name, size: bytes.length });
    }
  };
  return { directory, source, tree, version, archive, worker, manifest, bundle, configDigest, imageDigest, state, context, prepared, github, release, fetcher, execute, publishNpm, seed, token: 'secret-sentinel' };
}
