import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fixture, ID, KEY } from './helpers.mjs';
import { CronUpdate } from '../dist/cron-update.js';
import { launcherScript } from '../dist/cron-setup.js';
import { Failure } from '../dist/errors.js';
import { State } from '../dist/state.js';
import { Worker } from '../dist/worker.js';
import { supportsSource, updateContract, updateTarget, preflightLegacyUpdate, verifyCandidate, verifyInstallEntry } from '../dist/update-archive.js';

const from = '1.0.1-rc.1', to = '1.0.1', firstSHA = 'a'.repeat(64), nextSHA = 'b'.repeat(64);
const origin = 'https://worker.example.test';
const target = {
  name: '@markhuangai/aaa-muse-worker', version: to, contract: updateContract,
  sha256: nextSHA, source_sha: '9'.repeat(40), from_majors: '',
  url: 'https://github.com/markhuangai/AaA-muse-ai/releases/download/v1.0.1/markhuangai-aaa-muse-worker-1.0.1.tgz',
};

async function setup(t, { legacy = false, stage, override } = {}) {
  const f = await fixture(t);
  const bin = await f.state.child('bin');
  const before = join(f.state.root, 'releases/bundle.one/package/dist/main.js');
  const after = join(f.state.root, 'releases/update.two/package/dist/main.js');
  const original = launcherScript(process.execPath, before, f.state.root);
  await bin.write('aaa-muse-worker', original, 0o700);
  const install = { worker_id: ID, root: f.state.root, origin, package_version: from,
    launcher: bin.path('aaa-muse-worker'), command: 'launcher', ...(!legacy ? { package_sha256: firstSHA, node: process.execPath, entry: before } : {}) };
  await f.state.write('installation.json', JSON.stringify(install));
  await f.state.write('cron-installation.json', JSON.stringify({ checker_job_id: 'existing', command: 'launcher' }));
  await f.state.write('config.json', JSON.stringify({ protocol_version: 1, origin, worker_id: ID }));
  await f.state.write('credential.key', KEY);
  const actions = [];
  f.broker.override = async request => {
    if (request.path.endsWith('/status')) return Response.json({ id: ID, update_target: target });
    if (request.path.endsWith('/update')) {
      actions.push(request.input.action);
      const overridden = await override?.(request.input.action);
      return overridden ?? Response.json({ attempt: 1, retry_at: '2026-11-12T01:00:00Z' });
    }
  };
  const archive = { stage: stage ?? (async () => ({ entry: after, observed_digest: nextSHA, http_status: '200' })), verify: async () => {} };
  const updater = (version, entry) => new CronUpdate(new Worker(f.state, f.logger, f.net, version), {
    home: join(f.state.root, 'home'), node: process.execPath, entry,
    asset: name => fs.readFile(new URL('../setup/' + name, import.meta.url), 'utf8'),
    prepareDirectory: path => fs.mkdir(path, { recursive: true, mode: 0o700 }),
  }, archive);
  return { ...f, updater, actions, bin, before, after, original };
}

test('declared update target and candidate metadata restrict the version, provenance and installed path', async t => {
  const f = await setup(t);
  assert.equal(updateTarget(target), target);
  assert.equal(supportsSource(target, from), true);
  assert.equal(supportsSource(target, to), false);
  assert.equal(supportsSource(target, '1.1.0'), false);
  assert.equal(supportsSource(target, '2.0.0'), false);
  assert.equal(supportsSource({ ...target, from_majors: '2' }, '2.0.0'), false);
  assert.equal(supportsSource(target, '0.9.0'), false);
  assert.equal(supportsSource({ ...target, version: '1.0.1-rc.1' }, to), false);
  assert.equal(supportsSource({ ...target, version: '1.0.1-rc.10' }, '1.0.1-rc.2'), true);
  assert.equal(supportsSource({ ...target, version: '1.0.1-rc.2' }, '1.0.1-rc.10'), false);
  assert.equal(supportsSource({ ...target, version: '1.0.1-rc.0' }, '1.0.1-dev.10'), true);
  assert.equal(supportsSource({ ...target, version: '2.0.0' }, to), false);
  assert.throws(() => updateTarget({ ...target, version: '2.0.0', url: target.url.replaceAll('1.0.1', '2.0.0') }), /candidate_incompatible/);
  assert.throws(() => updateTarget({ ...target, url: 'https://elsewhere.invalid/worker.tgz' }), /candidate_incompatible/);
  assert.throws(() => verifyInstallEntry(f.state.root, '/outside/main.js'), /update_entry_outside_installation/);
  verifyInstallEntry(f.state.root, f.after);
  const root = join(f.state.root, 'releases/update.two/package');
  await fs.mkdir(join(root, 'dist'), { recursive: true });
  const assets = join(root, 'setup');
  await fs.mkdir(assets);
  await Promise.all(['hook.sh', 'SKILL.md'].map(name => fs.copyFile(new URL('../setup/' + name, import.meta.url), join(assets, name))));
  await fs.writeFile(f.after, "process.stdout.write('1.0.1\\n')");
  await fs.writeFile(join(root, 'dist/build.json'), JSON.stringify({ package_version: to, source_sha: target.source_sha }));
  await fs.writeFile(join(root, 'package.json'), JSON.stringify({ name: target.name, version: to, aaa_muse_update: { contract: target.contract, from_majors: '' } }));
  await verifyCandidate({ node: process.execPath }, f.after, target);
  await fs.appendFile(join(assets, 'hook.sh'), 'if invalid then\n');
  await assert.rejects(() => verifyCandidate({ node: process.execPath }, f.after, target), /candidate_incompatible/);
  await fs.copyFile(new URL('../setup/hook.sh', import.meta.url), join(assets, 'hook.sh'));
  const next = f.updater(to, f.after);
  await f.state.write('cron-update.json', JSON.stringify({ stage: 'downloading', target }));
  await assert.rejects(preflightLegacyUpdate(next.io, f.state, to, 'foreign-hook'), /worker_identity_mismatch/);
  await preflightLegacyUpdate(next.io, f.state, to, 'aaa-muse-worker-' + ID);
  await fs.appendFile(join(assets, 'hook.sh'), 'if invalid then\n');
  await assert.rejects(preflightLegacyUpdate(next.io, f.state, to, 'aaa-muse-worker-' + ID), /candidate_incompatible/);
  assert.equal(await f.bin.read('aaa-muse-worker', 0o700), f.original);
  await assert.rejects(() => verifyCandidate({ node: process.execPath }, f.after, { ...target, source_sha: '1'.repeat(40) }), /candidate_incompatible/);
});

test('a journal and the actual launcher reconcile a switched package after a lost report', async t => {
  let lost = false;
  const f = await setup(t, { override: action => {
    if (action === 'applied' && !lost) { lost = true; throw new Error('lost connection'); }
  } });
  const prior = f.updater(from, f.before);
  const transport = await prior.worker.load();
  assert.equal((await prior.contactHeaders())['X-Muse-Worker-SHA256'], firstSHA);
  const input = { id: 'update-one', target };
  const result = await f.state.withLock('cron', () => prior.offer(input, transport, 'pull-request'));
  assert.equal(result.outcome, 'update_awaiting_confirmation');
  assert.notEqual(await f.bin.read('aaa-muse-worker', 0o700), f.original);
  const current = f.updater(to, f.after);
  await assert.rejects(() => f.state.withLock('cron', () => current.recover()), /broker_unreachable/);
  assert(await f.state.read('cron-update.json'));
  assert.equal(await f.state.withLock('cron', () => current.recover()), undefined);
  assert.equal(await f.state.read('cron-update.json'), undefined);
  assert.equal((await current.contactHeaders())['X-Muse-Worker-SHA256'], nextSHA);
  assert.deepEqual(f.actions, ['begin', 'activate', 'applied', 'applied']);
  const installation = JSON.parse(await f.state.read('installation.json'));
  assert(installation.skill_path.endsWith('/SKILL.md'));
  const details = await Promise.all([fs.readFile(installation.skill_path, 'utf8'), fs.stat(installation.detector), fs.stat(installation.skill_path)]);
  assert(details[0].includes('Background tasks'));
  assert.equal(details[1].mode & 0o777, 0o700);
  assert.equal(details[2].mode & 0o777, 0o600);
});

test('failed checksum keeps the previous launcher and records evidence for the watchdog', async t => {
  const f = await setup(t, { stage: async () => { throw new Failure('archive_digest_mismatch', { observed_digest: 'x' }); } });
  const previous = f.updater(from, f.before);
  const transport = await previous.worker.load();
  await f.state.write('cron-tick.json', JSON.stringify({ pending: {} }));
  await assert.rejects(() => previous.offer({ id: 'attempt', target }, transport, 'req'), /update_worker_has_pending_work/);
  await f.state.remove('cron-tick.json');
  const rejected = await previous.offer({ id: 'attempt', target }, transport, 'req');
  assert.equal(rejected.cause, 'archive_digest_mismatch');
  assert.equal(await f.bin.read('aaa-muse-worker', 0o700), f.original);
  assert.deepEqual(f.actions, ['begin', 'failed']);
  assert(f.output.some(message => message.includes('worker.update_verification_failed') && message.includes('archive_digest_mismatch')));

  assert.equal(JSON.parse(await f.state.read('hook-update-health.json')).cause, 'archive_digest_mismatch');
});
