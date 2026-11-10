import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { Setup } from '../dist/setup.js';
import { State } from '../dist/state.js';
import { setupIO } from '../dist/setup-os.js';
import { execute, VERSION } from '../dist/cli.js';
import { encode } from '../dist/json.js';
import { fixture, CODE, KEY, ID, JOB, claimed } from './helpers.mjs';

const SETUP = '8'.repeat(32);
async function setupFixture(t) {
  const f = await fixture(t);
  const emitted = [];
  let launches = 0;
  const io = { ...setupIO(f.state.root), async launch(state) {
    launches++;
    const lock = await state.child('daemon.lock');
    await lock.write('owner.json', encode({ pid: state.sys.pid, owner: 'unit-owned' }));
    return state.sys.pid;
  }, async emit(runtime, action, message) { emitted.push({ runtime, action, message }); return JSON.stringify({ action, message }) + '\n'; } };
  const setup = new Setup(f.worker, io, VERSION);
  const install = () => setup.install('https://broker.example.test', CODE, join(f.state.root, 'installed'), SETUP,
    encode({ level: 'INFO', msg: 'setup.archive_verified', setup_id: SETUP, execution_started: false }));
  const stop = async () => { const lock = await f.state.child('daemon.lock'); await lock.remove('owner.json'); await f.state.io.rmdir(lock.root); };
  return { ...f, setup, io, install, emitted, stop, launches: () => launches };
}

test('setup preserves identity, protects executable assets, and owns one subscriber across repeats', async t => {
  const f = await setupFixture(t);
  const first = await f.install();
  const key = await f.state.read('credential.key');
  assert.equal(first.worker_id, ID); assert.equal(first.inference_readiness, 'unverified');
  for (const path of [first.hook_path, first.launcher]) assert.equal((await fs.stat(path)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(first.skill_path)).mode & 0o777, 0o600);
  assert(!(await fs.readFile(first.skill_path, 'utf8')).includes(KEY));
  assert.match(await fs.readFile(first.hook_path, 'utf8'), /HATCH_HOOK_DRY_RUN/);
  assert.match(await fs.readFile(first.skill_path, 'utf8'), /calling client's machine/);
  const second = await f.install();
  assert.equal(second.identity_preserved, true); assert.equal(await f.state.read('credential.key'), key); assert.equal(f.launches(), 1);
  await assert.rejects(new Setup(f.worker, f.io, '0.1.0-rc.99').install('https://broker.example.test', CODE, join(f.state.root, 'installed'), SETUP), /running_version_change_requires_operator_action/);
  await f.stop(); await f.setup.ensureRunning(); assert.equal(f.launches(), 2);
  await f.stop(); f.broker.denied = true;
  await assert.rejects(f.setup.ensureRunning(), /unauthorized/); assert.equal(f.launches(), 2);
  assert.equal(await f.state.read('credential.key'), key);
  assert(f.output.some(line => line.includes('setup.recovery_blocked')));
  assert(!f.output.join('').includes(KEY));
});

test('detector emits only changed cues and retries a failed emission without consuming it', async t => {
  const f = await setupFixture(t); await f.install();
  assert.equal(JSON.parse(await f.setup.check('/runtime')).action, 'silent');
  const cue = { worker_id: ID, jobs: [{ job_id: JOB, conversation_id: 'e'.repeat(32), generation: 1, state: 'pending', progress: 'claimed', needs_attention: true, deadline_at: '2030-01-01T00:00:00Z' }] };
  await f.state.write('pending.json', encode(cue));
  const original = f.io.emit;
  f.io.emit = async () => { throw Object.assign(new Error('failure must not consume cue'), { code: 'EIO' }); };
  await assert.rejects(f.setup.check('/runtime'), /EIO/);
  f.io.emit = original;
  assert.equal(JSON.parse(await f.setup.check('/runtime')).action, 'wake');
  assert.equal(JSON.parse(await f.setup.check('/runtime')).action, 'silent');
  cue.jobs[0].state = 'cancelled'; await f.state.write('pending.json', encode(cue));
  assert.equal(JSON.parse(await f.setup.check('/runtime')).action, 'wake');
  cue.jobs = []; await f.state.write('pending.json', encode(cue));
  assert.equal(JSON.parse(await f.setup.check('/runtime')).action, 'silent');
  const exported = (await f.logger.capture.export({}, true)).trim().split('\n').map(JSON.parse);
  assert(exported[0].complete); assert(exported.some(e => e.msg === 'setup.cue_observed' && e.level === 'DEBUG' && e.cue.jobs[0]?.job_id === JOB));
  assert.equal(exported.filter(e => e.msg === 'setup.wake_emitted').length, 2);
  assert(exported.some(e => e.msg === 'setup.runtime_unsupported' && e.cause === 'EIO'));
  assert(!f.output.join('').includes('"level":"DEBUG"'));
  await assert.rejects(f.setup.check('relative'), /hook_runtime_required/);
  await f.state.write('pending.json', encode({ worker_id: 'foreign', jobs: [] }));
  await assert.rejects(f.setup.check('/runtime'), /pending_worker_mismatch/);
  await f.state.write('pending.json', encode({ worker_id: ID, jobs: null }));
  await assert.rejects(f.setup.check('/runtime'), /invalid_pending_cues/);
});

test('recovery refuses ambiguous locks, terminal outcomes, unsafe state and unobserved launches', async t => {
  const f = await setupFixture(t);
  await assert.rejects(f.setup.ensureRunning(), /worker_setup_required/);
  await f.install();
  const lock = await f.state.child('daemon.lock');
  await lock.remove('owner.json');
  await assert.rejects(f.setup.owner(), /lock_owner_ambiguous/);
  await lock.write('owner.json', encode({ pid: 0, owner: 'bad' }));
  await assert.rejects(f.setup.owner(), /lock_owner_ambiguous/);
  await lock.write('owner.json', encode({ pid: f.state.sys.pid, owner: 'valid' }));
  const alive = f.state.sys.alive; f.state.sys.alive = () => undefined;
  await assert.rejects(f.setup.ensureRunning(), /lock_owner_ambiguous/);
  f.state.sys.alive = alive;
  await f.state.write('launch.json', encode({ pid: 1 }));
  await assert.rejects(f.setup.ensureRunning(), /subscriber_owner_ambiguous/);
  await f.stop();
  await f.state.write('run-stop.json', encode({ cause: 'unauthorized' }));
  await assert.rejects(f.setup.ensureRunning(), /subscriber_terminal_stop/);
  await f.state.remove('run-stop.json');
  f.io.launch = async () => { throw Object.assign(new Error('adapter failure'), { code: 'EIO' }); };
  await assert.rejects(f.setup.ensureRunning(), /EIO/);
  f.io.launch = async () => 2147483646;
  await assert.rejects(f.setup.ensureRunning(), /subscriber_start_not_observed/);
  const dead = await f.state.child('daemon.lock'); await dead.write('owner.json', encode({ pid: 2147483646, owner: 'dead' }));
  assert.equal(await f.setup.owner(), undefined);
  await assert.rejects(f.setup.install('https://broker.example.test', CODE, 'relative', SETUP), /absolute_install_paths_required/);
  await fs.chmod(f.state.path('installation.json'), 0o644);
  await assert.rejects(f.setup.ensureRunning(), /state_unsafe/);
});

test('setup CLI shares actual setup state and background failures retain a terminal marker', async t => {
  const f = await setupFixture(t); const output = [];
  const io = { files: fs, system: f.state.sys, setup: f.io, network: f.net, env: { HATCH_HOOK_RUNTIME: '/runtime' }, home: () => f.state.root, nodeVersion: process.version,
    input: async name => name === '-' ? CODE : encode({ level: 'INFO', msg: 'setup.archive_verified', setup_id: SETUP }), stdout: line => output.push(line), stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit' }) };
  const call = (...args) => execute([args[0], '--state-dir', f.state.root, ...args.slice(1)], io);
  assert.equal(await call('setup'), 1);
  assert.equal(await call('setup', '--origin', 'https://broker.example.test', '--code-stdin', '--install-dir', join(f.state.root, 'installed'), '--setup-id', SETUP, '--bootstrap', '/receipt'), 0);
  assert.equal(await call('hook-check'), 0); assert.equal(JSON.parse(output.at(-1)).action, 'silent');
  assert.equal(await call('hook-check', '--runtime-error', 'missing_functions'), 1);
  await assert.rejects(f.setup.runtimeError('invalid'), /invalid_runtime_error/);
  await f.stop(); f.broker.denied = true;
  assert.equal(await call('run', '--background'), 1);
  assert.equal(JSON.parse(await f.state.read('run-stop.json')).requires_operator_action, true);
  assert.equal(await call('hook-check'), 1);
});

test('bootstrap imports remain bounded and exact to their setup operation', async t => {
  const f = await setupFixture(t);
  for (const bootstrap of [encode({ level: 'INFO', msg: 'event', setup_id: 'foreign' }), 'x'.repeat(6145)]) {
    await assert.rejects(f.setup.install('https://broker.example.test', CODE, join(f.state.root, 'installed'), SETUP, bootstrap), /invalid_bootstrap_record|bootstrap_record_too_large/);
  }
  await f.install();
  const script = new State(join(f.state.root, 'installed', 'bin'), fs, f.state.sys);
  assert.match(await script.read('aaa-muse-worker', 0o700), /exec/);
  await assert.rejects(script.read('aaa-muse-worker'), /state_unsafe/);
});

test('job-show and startup reconciliation preserve delivered assignment deduplication', async t => {
  const f = await setupFixture(t); await f.install();
  const job = claimed(); f.broker.jobs.set(JOB, job);
  await f.worker.publish(job, 'claimed', 'awaiting_muse_decision');
  assert.equal(JSON.parse(await f.setup.check('/runtime')).action, 'wake');
  await f.worker.show(JOB);
  assert.equal(JSON.parse(await f.setup.check('/runtime')).action, 'silent');
  const transport = await f.worker.load();
  await f.worker.reconcile(transport, await f.worker.identity(transport));
  assert.equal(JSON.parse(await f.setup.check('/runtime')).action, 'silent');
  job.generation = 2;
  await f.worker.publish(job, 'claimed', 'awaiting_muse_decision');
  assert.equal(JSON.parse(await f.setup.check('/runtime')).action, 'wake');
});

test('failed setup exports verified bootstrap and later authorization rejection under incoming setup ID', async t => {
  const f = await setupFixture(t);
  await f.worker.configure('https://broker.example.test'); await f.worker.enroll(CODE);
  f.broker.denied = true;
  const io = { files: fs, system: f.state.sys, setup: f.io, network: f.net, env: {}, home: () => f.state.root, nodeVersion: process.version,
    input: async name => name === '-' ? CODE : encode({ level: 'INFO', msg: 'setup.archive_verified', setup_id: SETUP, expected_digest: 'a'.repeat(64), observed_digest: 'a'.repeat(64) }), stdout() {}, stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit' }) };
  assert.equal(await execute(['setup', '--state-dir', f.state.root, '--origin', 'https://broker.example.test', '--code-stdin', '--install-dir', join(f.state.root, 'installed'), '--setup-id', SETUP, '--bootstrap', '/receipt'], io), 1);
  assert.equal(await f.state.read('installation.json'), undefined);
  const exported = (await f.logger.capture.export({}, true)).trim().split('\n').map(JSON.parse);
  assert(exported[0].complete);
  const events = exported.filter(e => e.setup_id === SETUP);
  assert(events.some(e => e.msg === 'setup.archive_verified' && e.expected_digest === e.observed_digest));
  assert(events.some(e => e.msg === 'worker.command_failed' && e.cause === 'worker_unauthorized' && e.reason === 'unauthorized'));
  assert(!JSON.stringify(events).includes(KEY)); assert(!JSON.stringify(events).includes(CODE));
});

test('CLI imports bootstrap before unsafe credentials and setup-lock timeouts can reject attempts', async t => {
  for (const reason of ['unsafe_credential', 'setup_lock']) {
    await t.test(reason, async t => {
      const f = await setupFixture(t);
      await f.worker.configure('https://broker.example.test'); await f.worker.enroll(CODE);
      const output = [];
      const io = { files: fs, system: f.state.sys, setup: f.io, network: f.net, env: {}, home: () => f.state.root, nodeVersion: process.version,
        input: async name => name === '-' ? CODE : encode({ level: 'INFO', msg: 'setup.archive_verified', setup_id: SETUP, execution_started: false }), stdout: line => output.push(line), stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit' }) };
      let release;
      const wait = f.state.sys.wait;
      if (reason === 'unsafe_credential') await fs.chmod(f.state.path('credential.key'), 0o644);
      else { release = await f.state.lock('setup'); f.state.sys.wait = async () => f.advance(10001); }
      try {
        assert.equal(await execute(['setup', '--state-dir', f.state.root, '--origin', 'https://broker.example.test', '--code-stdin', '--install-dir', join(f.state.root, 'installed'), '--setup-id', SETUP, '--bootstrap', '/receipt'], io), 1);
      } finally {
        f.state.sys.wait = wait;
        if (release) await release();
        await fs.chmod(f.state.path('credential.key'), 0o600);
      }
      assert.equal(await execute(['diagnostics-export', '--state-dir', f.state.root, '--decode'], io), 0);
      const exported = output.at(-1).trim().split('\n').map(JSON.parse);
      assert(exported[0].complete);
      const events = exported.filter(e => e.setup_id === SETUP);
      assert(events.some(e => e.msg === 'setup.archive_verified'));
      const cause = reason === 'unsafe_credential' ? 'state_unsafe' : 'state_lock_timeout';
      assert(events.some(e => e.level === 'ERROR' && e.cause === cause));
      assert(!JSON.stringify(events).includes(KEY)); assert(!JSON.stringify(events).includes(CODE));
    });
  }
});
