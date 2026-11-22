import { createServer } from 'node:http';
import { once } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { archiveName, hash, jsonBytes, packageName, repository, imageName, inspectWorker, makeManifest, imageTags } from '../release-manifest.mjs';
import { completionMarker } from '../release-history.mjs';
import { candidateNpmTag } from '../release-versions.mjs';

function pair(directory, source, tree, version, kind, source_rc) {
  mkdirSync(join(directory, 'package/dist'), { recursive: true });
  mkdirSync(join(directory, 'package/setup'));
  writeFileSync(join(directory, 'package/package.json'), jsonBytes({ name: packageName, version }));
  writeFileSync(join(directory, 'package/dist/build.json'), jsonBytes({ source_sha: source, source_dirty: false, package_version: version }));
  writeFileSync(join(directory, 'package/setup/install.sh'), '#!/bin/sh\nprintf "controlled installer"\n');
  execFileSync('tar', ['-czf', join(directory, 'worker.tgz'), '-C', directory, 'package']);
  const archive = readFileSync(join(directory, 'worker.tgz')), worker = inspectWorker(join(directory, 'worker.tgz'));
  const config = { config: { User: '10001:10001', ExposedPorts: { '8080/tcp': {} }, Labels: {
    'org.opencontainers.image.revision': source, 'org.opencontainers.image.version': version, 'io.aaa-muse.source-dirty': 'false' } } };
  const configBytes = jsonBytes(config), configDigest = 'sha256:' + hash(configBytes);
  const imageBytes = jsonBytes({ schemaVersion: 2, config: { digest: configDigest }, layers: [] }), imageDigest = 'sha256:' + hash(imageBytes);
  const manifest = makeManifest({ source_sha: source, tree_sha: tree, version, image_digest: imageDigest,
    image_config_digest: configDigest, worker, publication_kind: kind, source_rc });
  const npm = { name: packageName, version, dist: { tarball: 'https://npm.pkg.github.com/' + archiveName(version) } };
  return { source, tree, version, archive, worker, config, configBytes, configDigest, imageBytes, imageDigest, manifest, npm };
}

function populate(record) {
  const { manifest, release, assets, archive } = record;
  const worker = { ...manifest.worker, source_sha: manifest.source_sha };
  for (const [name, bytes] of [['product-release.json', jsonBytes(manifest)], [manifest.worker.archive, archive],
    ['worker-release.json', jsonBytes({ package: worker.package, version: worker.version, source_sha: worker.source_sha, archive: worker.archive, sha256: worker.sha256 })],
    ['SHA256SUMS', Buffer.from(worker.sha256 + '  ' + worker.archive + '\n')]]) {
    assets.set(name, bytes);
    release.assets.push({ id: assets.size, name, size: bytes.length, digest: 'sha256:' + hash(bytes) });
  }
  release.body = completionMarker(manifest);
}

export async function releaseFixture(t, { source = 'a'.repeat(40), tree = 'e'.repeat(40), version = '1.0.0',
  rcVersion = '1.0.0-rc.13', previous } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'aaa-release-test-'));
  const state = { refs: new Map(previous?.state.refs), assets: new Map(), images: new Map(previous?.state.images),
    npm: null, tags: { ...previous?.state.tags }, requests: [], commands: [], uploads: 0, permission: 'admin',
    merged: true, tree, source, sourceOnMain: true, mainSuccess: true, failAsset: null, corrupt: null,
    artifacts: [], runs: [], originalRuns: new Map(), historyJobs: new Map(), otherPairs: new Map(previous?.state.otherPairs),
    githubLatest: previous?.state.githubLatest ?? null };
  if (previous) state.otherPairs.set(previous.prepared.tag, previous.record());

  const nextID = () => Math.max(0, ...Array.from(state.otherPairs.values(), item => item.release.id)) + 1;
  const releaseRecord = (id, tag) => ({ id, tag_name: tag, prerelease: true, draft: false, immutable: false, body: '', assets: [] });
  function registerImages(record) {
    for (const tag of [...imageTags(record.manifest), record.imageDigest]) state.images.set(tag, record.imageBytes);
  }
  function addRC(tagVersion, { rcSource = source, rcTree = tree, complete = true } = {}) {
    const tag = 'v' + tagVersion;
    const rc = { ...pair(join(directory, tag), rcSource, rcTree, tagVersion, 'rc'), release: releaseRecord(nextID() + 1, tag), assets: new Map() };
    if (complete) populate(rc);
    state.otherPairs.set(tag, rc);
    state.refs.set('tags/' + tag, { object: { type: 'commit', sha: rcSource } });
    registerImages(rc);
    return rc;
  }
  const rc = addRC(rcVersion);
  const source_rc = { tag: rc.release.tag_name, manifest_sha256: hash(rc.assets.get('product-release.json')) };
  const current = pair(directory, source, tree, version, 'candidate', source_rc);
  const { manifest, worker, archive, config, configBytes, configDigest, imageBytes, imageDigest } = current;
  Object.assign(state, { configBytes, imageBytes });
  const bundle = { schema_version: 1, source_sha: source, tree_sha: tree, version, source_rc, image_config_digest: configDigest,
    worker, image_archive_sha256: hash(Buffer.from('controlled image save')) };
  writeFileSync(join(directory, 'image.tar'), 'controlled image save');
  writeFileSync(join(directory, 'bundle.json'), jsonBytes(bundle));

  const context = { repo: { owner: 'markhuangai', repo: 'AaA-muse-ai' }, ref: 'refs/heads/main', eventName: 'workflow_dispatch', actor: 'Z-M-Huang', runId: 100, runAttempt: 1 };
  const prepared = { source_sha: source, tree_sha: tree, source_rc, version, tag: 'v' + version, candidate: true, paired: true, should_publish: true };
  const release = releaseRecord(nextID(), prepared.tag);
  const record = () => ({ ...current, release, assets: state.assets, npm: state.npm });
  const records = () => [...state.otherPairs.values(), ...(state.release ? [record()] : [])];
  const findCommit = sha => records().find(item => item.source === sha);
  const commit = sha => sha === source ? { sha: state.source, commit: { tree: { sha: state.tree } } }
    : { sha, commit: { tree: { sha: findCommit(sha)?.tree } } };
  const route = { pulls() {}, jobs() {}, artifacts() {}, releases() {}, refs() {} };
  const github = { rest: {
    repos: {
      getCollaboratorPermissionLevel: async () => ({ data: { permission: state.permission } }),
      getBranch: async () => ({ data: { commit: { sha: state.main ?? source } } }),
      getCommit: async ({ ref }) => ({ data: commit(ref) }),
      compareCommitsWithBasehead: async ({ basehead }) => ({ data: { merge_base_commit: { sha: state.sourceOnMain ? basehead.slice(0, 40) : 'f'.repeat(40) } } }),
      listPullRequestsAssociatedWithCommit: route.pulls,
      listReleases: route.releases,
      getReleaseByTag: async ({ tag }) => {
        const found = records().find(item => item.release.tag_name === tag);
        if (!found) throw { status: 404 };
        return { data: structuredClone(found.release) };
      },
      getLatestRelease: async () => {
        const found = records().find(item => item.release.id === state.githubLatest);
        if (!found) throw { status: 404 };
        return { data: structuredClone(found.release) };
      },
      createRelease: async value => { Object.assign(release, value); state.release = true; return { data: structuredClone(release) }; },
      uploadReleaseAsset: async ({ name, data }) => {
        if (state.failAsset === name) throw { status: 503, message: 'secret-sentinel' };
        state.uploads++;
        state.assets.set(name, Buffer.from(data));
        release.assets.push({ id: state.uploads, name, size: data.length });
      },
      updateRelease: async value => {
        Object.assign(release, value);
        if (value.make_latest === 'true') state.githubLatest = release.id;
        return { data: structuredClone(release) };
      },
    },
    actions: {
      getWorkflow: async ({ workflow_id }) => ({ data: { id: 7, path: '.github/workflows/' + workflow_id } }),
      listWorkflowRuns: async ({ workflow_id, head_sha }) => ({ data: { workflow_runs: typeof workflow_id === 'number' ? state.runs
        : [{ id: 1, head_sha, head_branch: 'main', status: 'completed', conclusion: state.mainSuccess ? 'success' : 'failure' }] } }),
      listJobsForWorkflowRun: route.jobs, listWorkflowRunArtifacts: route.artifacts,
      getWorkflowRun: async ({ run_id }) => ({ data: state.originalRuns.get(run_id) }),
    },
    git: {
      listMatchingRefs: route.refs,
      getRef: async ({ ref }) => { if (!state.refs.has(ref)) throw { status: 404 }; return { data: state.refs.get(ref) }; },
      createRef: async ({ ref, sha }) => { state.refs.set(ref.replace('refs/', ''), { object: { type: 'commit', sha } }); },
    },
  }, paginate: async (method, options) => {
    if (method === github.rest.actions.listWorkflowRuns) return state.runs;
    if (method === route.releases) return records().map(item => structuredClone(item.release));
    if (method === route.refs) return [...state.refs].map(([ref, value]) => ({ ref: 'refs/' + ref, ...value }));
    if (method === route.pulls) return state.merged ? [{ merged_at: '2026-11-17', merge_commit_sha: options.commit_sha, number: 52,
      base: { ref: 'main', repo: { full_name: repository } } }] : [];
    if (method === route.jobs) return options.filter === 'all' ? state.historyJobs.get(options.run_id) ?? []
      : [{ name: 'Release / verify', conclusion: state.mainSuccess ? 'success' : 'failure' }];
    if (method === route.artifacts) return state.artifacts.filter(artifact => !artifact.run_id || artifact.run_id === options.run_id);
    throw new Error('unexpected fixture API');
  } };

  const server = createServer((request, response) => {
    const target = new URL(request.headers['x-upstream-url']);
    state.requests.push({ url: target.href, authenticated: !!request.headers.authorization });
    const send = (bytes, status = 200, headers = {}) => { response.writeHead(status, headers); response.end(bytes); };
    const path = target.pathname.split('/');
    if (state.corrupt === target.href) return send('corrupted');
    if (target.hostname === 'api.github.com') {
      if (target.pathname.includes('/git/ref/')) return send(jsonBytes(state.refs.get('tags/' + path.at(-1)) ?? {}));
      return send(jsonBytes(commit(path.at(-1))));
    }
    if (target.hostname === 'npm.pkg.github.com') {
      if (target.pathname.endsWith('aaa-muse-worker')) {
        const packages = [...state.otherPairs.values(), record()];
        const versions = Object.fromEntries(packages.filter(item => item.npm).map(item => [item.version, item.npm]));
        return send(jsonBytes({ versions, 'dist-tags': state.tags }));
      }
      if (path.at(-1) === archiveName(version)) return send(state.npmBytes ?? archive);
      const found = records().find(item => archiveName(item.version) === path.at(-1));
      return found ? send(found.archive) : send('', 404);
    }
    if (target.hostname === 'ghcr.io') {
      if (target.pathname === '/token') return send(jsonBytes({ token: 'fixture-registry-bearer' }));
      if (target.pathname.includes('/blobs/')) {
        const other = [...state.otherPairs.values()].find(item => item.configDigest === path.at(-1));
        return send(other?.configBytes ?? state.configBytes);
      }
      const value = state.images.get(path.at(-1));
      return value ? send(value, 200, { 'docker-content-digest': 'sha256:' + hash(value) }) : send('', 404);
    }
    const entry = records().find(item => item.release.tag_name === path.at(-2));
    const content = entry?.assets.get(path.at(-1));
    return content ? send(content) : send('', 404);
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); rmSync(directory, { recursive: true }); });
  const fetcher = async (url, options = {}) => {
    const response = await fetch('http://127.0.0.1:' + server.address().port + '/', { ...options, headers: { ...options.headers, 'x-upstream-url': url } });
    return new Response(await response.arrayBuffer(), { status: response.status, headers: response.headers });
  };
  const execute = (command, args, options = {}) => {
    if (command === 'tar') return execFileSync(command, args, options);
    state.commands.push([command, ...args]);
    if (command === 'npm' && args[0] === 'dist-tag') { state.tags[args[3]] = args[2].split('@').at(-1); return ''; }
    if (command === 'docker' && args[0] === 'image' && args[1] === 'inspect') return JSON.stringify([{ Id: configDigest, Config: config.config }]);
    if (command === 'docker' && args[0] === 'save') { writeFileSync(args.at(-1), 'controlled image save'); return ''; }
    if (command === 'docker' && args[0] === 'push') {
      state.images.set(args[1].slice(imageName.length + 1), imageBytes); state.images.set(imageDigest, imageBytes); return '';
    }
    if (command === 'docker' && args[0] === 'buildx') {
      const sourceImage = state.images.get(args.at(-1).split('@').at(-1));
      if (!sourceImage) throw new Error('missing source manifest');
      state.images.set(args[args.indexOf('--tag') + 1].slice(imageName.length + 1), sourceImage);
    }
    return '';
  };
  const publishNpm = async () => { state.npm = current.npm; state.tags[candidateNpmTag(version)] = version; };
  const seed = () => {
    state.release = true;
    state.refs.set('tags/' + prepared.tag, { object: { type: 'commit', sha: source } });
    state.npm = current.npm;
    state.tags.candidate = version; state.tags[candidateNpmTag(version)] = version;
    registerImages(current);
    populate(record());
  };
  return { directory, source, tree, version, archive, worker, manifest, bundle, configDigest, imageDigest, state, context, prepared,
    prereleaseTag: source_rc.tag, manifestSHA256: hash(jsonBytes(manifest)), github, release, fetcher, execute,
    publishNpm, seed, addRC, record, token: 'secret-sentinel' };
}
