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
const PIN = 'a'.repeat(64);

function managedNetwork(net) {
  return { ...net, fetch: async (...args) => {
    const response = await net.fetch(...args);
    response.headers.set('X-Muse-Paired-Worker-SHA256', PIN);
    return response;
  } };
}

async function setupFixture(t) {
  const f = await fixture(t);
  const emitted = [];
  let launches = 0;
  const pids = new Map();
  const systemAlive = f.state.sys.alive;
  f.state.sys.alive = pid => pids.has(pid) ? pids.get(pid) : systemAlive(pid);
  const io = { ...setupIO(f.state.root), async launch(state) {
    const pid = 2_000_000_000 + ++launches;
    pids.set(pid, true);
    const lock = await state.child('daemon.lock');
    await lock.write('owner.json', encode({ pid, owner: 'unit-owned' }));
    return pid;
  }, async emit(runtime, action, message) { emitted.push({ runtime, action, message }); return JSON.stringify({ action, message }) + '\n'; } };
  const setup = new Setup(f.worker, io, VERSION);
  const install = (input = CODE) => setup.install('https://broker.example.test', input, join(f.state.root, 'installed'), SETUP,
    encode({ level: 'INFO', msg: 'setup.archive_verified', setup_id: SETUP, execution_started: false }));
  const stop = async () => {
    const lock = await f.state.child('daemon.lock');
    for (const pid of pids.keys()) pids.set(pid, false);
    await lock.remove('owner.json');
    await f.state.io.rmdir(lock.root);
  };
  return { ...f, setup, io, install, emitted, stop, launches: () => launches };
}

test('setup saves dated model reports and keeps enrollment working when a report is rejected', async t => {
  const f = await setupFixture(t);
  f.state.sys.now = () => Date.parse('2026-11-18T01:02:03Z');
  const now = new Date(f.state.sys.now()).toISOString();
  for (const report of [{ model_name: 'Test Muse', context_window_tokens: 350000 }, { model_name: 'Partial' }, { context_window_tokens: 100 }]) {
    await f.install(CODE + '\n' + encode(report));
    assert.deepEqual(JSON.parse(await f.state.read('installation.json')).model_report, { ...report, reported_at: now });
  }
  for (const value of ['{}', '{', encode({ extra: true }), encode({ context_window_tokens: 0 }),
    encode({ model_name: '\n' }), encode({ model_name: 'x'.repeat(129) }), encode({ model_name: KEY }), 'x'.repeat(513)]) {
    const result = await f.install(CODE + '\n' + value);
    assert.equal(result.worker_id, ID);
    assert.equal(JSON.parse(await f.state.read('installation.json')).model_report, undefined);
  }
  const exported = (await f.logger.capture.export({}, true)).trim().split('\n').map(JSON.parse);
  assert(exported[0].complete);
  const warnings = exported.filter(e => e.msg === 'setup.model_report_rejected');
  assert.equal(warnings.length, 7);
  assert(warnings.every(e => e.worker_id === ID && e.setup_id === SETUP && e.level === 'WARN'));
  assert(!JSON.stringify(exported).includes(KEY));
});

test('setup preserves identity, protects executable assets, and owns one subscriber across repeats', async t => {
  const f = await setupFixture(t);
  const first = await f.install();
  const key = await f.state.read('credential.key');
  assert.equal(first.worker_id, ID); assert.equal(first.inference_readiness, 'unverified');
  assert.deepEqual(first.watchdog, { id: 'aaa-muse-worker-watchdog', interval_seconds: 300, timeout_seconds: 300,
    command: `'${first.launcher}' watchdog-check --state-dir '${f.state.root}'`, registration: 'unverified' });
  for (const path of [first.hook_path, first.launcher]) assert.equal((await fs.stat(path)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(first.skill_path)).mode & 0o777, 0o600);
  assert(!(await fs.readFile(first.skill_path, 'utf8')).includes(KEY));
  assert.match(await fs.readFile(first.hook_path, 'utf8'), /HATCH_HOOK_DRY_RUN/);
  assert.match(await fs.readFile(first.skill_path, 'utf8'), /calling client executes/);
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
  await f.state.remove('launch.json');
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

test('preflight checks an existing asset target before reusing enrollment', async t => {
  const f = await setupFixture(t);
  const installed = await f.install();
  const target = installed.skill_path;
  await fs.chmod(target, 0o644);
  const before = f.broker.calls.length;
  await assert.rejects(f.install(), error => error.code === 'state_unsafe' && error.fields.stage === 'pre_enrollment' && error.fields.capability === 'skill_directory');
  assert.equal(f.broker.calls.length, before);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o644);
  await fs.chmod(target, 0o600);
});

test('setup CLI installs protected worker state without starting a daemon or enabling a hook', async t => {
  const f = await setupFixture(t); const output = [];
  let now = Date.parse('2026-11-25T12:00:00Z');
  f.state.sys.now = () => now;
  const io = { files: fs, system: f.state.sys, setup: f.io, network: managedNetwork(f.net), env: { HATCH_HOOK_RUNTIME: '/runtime' },
    emitHook: async (_runtime, action) => encode(action), home: () => f.state.root, nodeVersion: process.version,
    input: async name => name === '-' ? CODE : encode({ level: 'INFO', msg: 'setup.archive_verified', setup_id: SETUP }), stdout: line => output.push(line), stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit' }) };
  const call = (...args) => execute([args[0], '--state-dir', f.state.root, ...args.slice(1)], io);
  assert.equal(await call('setup'), 1);
  assert.equal(await call('setup', '--origin', 'https://broker.example.test', '--code-stdin', '--install-dir', join(f.state.root, 'installed'),
    '--setup-id', SETUP, '--bootstrap', '/receipt', '--archive-digest', PIN), 0);
  assert.equal(JSON.parse(output.at(-1)).registration, 'pending');
  const requests = f.broker.calls.length;
  assert.equal(await call('hook-check'), 0);
  assert.deepEqual(JSON.parse(output.at(-1)), { kind: 'silent', reason: 'registration_unverified' });
  assert.equal(f.broker.calls.length, requests);
  assert.equal(await call('hook-describe', '--goal-id', 'cli-goal'), 0);
  const { hook, watchdog } = JSON.parse(output.at(-1));
  assert.equal(hook.poll_interval_secs, 15);
  assert.equal(hook.script_timeout_secs, 120);
  assert.equal(watchdog.every, '5m');
  assert.equal(watchdog.kind, 'agent');
  assert.equal(watchdog.enabled, true);
  const listing = { goal_id: 'cli-goal', complete: true, hooks: [], watchdogs: [], target: 'hook' };
  io.input = async () => encode(listing);
  assert.equal(await call('hook-authorize-registration', '--input', '-'), 0);
  assert.equal(JSON.parse(output.at(-1)).add_hook, true);
  const readback = { ...listing, target: 'watchdog', hooks: [hook],
    watchdogs: [{ ...watchdog, native_job_id: 'cli-watchdog' }], dry_run: 'silent' };
  io.input = async () => encode({ ...readback, watchdogs: [{ ...readback.watchdogs[0], every: '1h' }] });
  assert.equal(await call('hook-authorize-registration', '--input', '-'), 1);
  assert.equal(await call('hook-confirm', '--input', '-'), 1);
  io.input = async () => encode(readback);
  assert.equal(await call('hook-confirm', '--input', '-'), 0);
  assert.equal(JSON.parse(output.at(-1)).outcome, 'registered');

  const expected = JSON.parse(await f.state.read('hook-expected.json'));
  const hourly = encode({ ...expected, watchdog: { ...expected.watchdog, every: '1h' } });
  await f.state.write('hook-expected.json', hourly);
  assert.equal(await call('hook-describe', '--goal-id', 'cli-goal'), 1);
  assert.equal(await f.state.read('hook-expected.json'), hourly);

  const check = async () => {
    assert.equal(await call('watchdog-check'), 0);
    return JSON.parse(output.at(-1));
  };
  const tick = new Date(now - 300_000).toISOString();
  await f.state.write('hook-tick-health.json', encode({ boot_id: 'previous-boot', last_tick_at: tick, last_success_at: tick }));
  const fresh = await check();
  assert.equal(fresh.boot_changed, true);
  assert.equal(fresh.notify, false);
  now++;
  const stale = await check();
  assert.equal(stale.notify, true);
  assert.equal(stale.incidents[0].kind, 'hook_tick_stale');
  now++;
  assert.equal((await check()).notify, false);

  now++;
  io.env.HATCH_HOOK_ID = hook.id;
  io.env.HATCH_HOOK_INVOCATION_ID = 'cli-recovery-tick';
  await f.state.write('cron-tick.json', encode({ last_usage_at: new Date(now).toISOString() }));
  f.broker.override = ({ path }) => { if (path.endsWith('/pull')) return Response.json({ job: null }); };
  assert.equal(await call('hook-check'), 0);
  assert.deepEqual(JSON.parse(output.at(-1)), { kind: 'silent', reason: 'idle' });
  assert.equal((await check()).outcome, 'recovered');
  now++;
  assert.equal((await check()).notify, false);

  assert.equal(await call('diagnostics-export', '--operation-id', SETUP, '--decode'), 0);
  const raw = output.at(-1);
  const [metadata, ...events] = raw.trimEnd().split('\n').map(line => JSON.parse(line));
  assert.equal(metadata.complete, true);
  assert.deepEqual(metadata.omissions, []);
  const errors = events.filter(event => event.msg === 'worker.command_failed' &&
    ['hook-authorize-registration', 'hook-confirm'].includes(event.stopped_operation));
  assert.equal(errors.length, 2);
  for (const event of errors) {
    assert.equal(event.level, 'ERROR');
    assert.equal(event.worker_id, ID);
    assert.equal(event.setup_id, SETUP);
    assert.equal(event.operation_id, SETUP);
  }
  const authorization = errors.find(event => event.stopped_operation === 'hook-authorize-registration');
  assert.equal(authorization.cause, 'watchdog_definition_mismatch');
  assert.equal(authorization.expected.every, '5m');
  assert.equal(authorization.observed.every, '1h');
  const confirmation = errors.find(event => event.stopped_operation === 'hook-confirm');
  assert.equal(confirmation.cause, 'hook_readback_mismatch');
  assert.equal(confirmation.expected.watchdog.every, '5m');
  assert.equal(confirmation.observed.watchdog.every, '1h');
  const retry = events.find(event => event.msg === 'worker.command_failed' && event.stopped_operation === 'hook-describe');
  assert.equal(retry.level, 'ERROR');
  assert.equal(retry.cause, 'hook_definition_changed');
  assert.equal(retry.worker_id, ID);
  assert.equal(retry.setup_id, SETUP);
  const verified = events.find(event => event.msg === 'setup.hook_registration_verified');
  assert.equal(verified.level, 'INFO');
  assert.equal(verified.watchdog.every, '5m');
  assert.equal(verified.watchdog.native_job_id, 'cli-watchdog');

  const checks = events.filter(event => /^hook\.watchdog_(check|notice)$/.test(event.msg))
    .sort((a, b) => a.checked_at.localeCompare(b.checked_at));
  assert.deepEqual(checks.map(event => [event.msg, event.level, event.notify, event.outcome, event.boot_changed]), [
    ['hook.watchdog_check', 'DEBUG', false, 'healthy', true],
    ['hook.watchdog_notice', 'WARN', true, 'incident', true],
    ['hook.watchdog_check', 'DEBUG', false, 'incident', true],
    ['hook.watchdog_notice', 'INFO', true, 'recovered', false],
    ['hook.watchdog_check', 'DEBUG', false, 'healthy', false],
  ]);
  for (const event of checks) {
    assert.equal(event.watchdog_every, '5m');
    assert.equal(event.expected_staleness_ms, 300_000);
    assert.equal(event.hook_id, hook.id);
    assert.equal(event.watchdog_job_id, 'cli-watchdog');
    assert.equal(event.worker_id, ID);
  }
  assert.equal(checks[1].last_tick_boot_id, 'previous-boot');
  assert.equal(checks[1].incidents[0].observed_age_ms, 300_001);
  const healthyTick = events.find(event => event.msg === 'hook.check' && event.outcome === 'idle');
  assert.equal(healthyTick.watchdog_every, '5m');
  assert.equal(healthyTick.hook_poll_seconds, 15);
  const stderr = f.output.map(line => JSON.parse(line));
  assert(stderr.every(event => event.level !== 'DEBUG'));
  for (const event of [...errors, retry, checks[1], checks[3]]) {
    assert(stderr.some(line => line.msg === event.msg && line.command_id === event.command_id && line.level === event.level));
  }
  for (const secret of [CODE, KEY]) {
    assert(!raw.includes(secret) && !f.output.join('').includes(secret), 'diagnostics exposed a credential');
  }
  assert.equal(await call('run', '--background'), 1);
  assert.equal(await f.state.read('run-stop.json'), undefined);
  assert.equal(await f.state.read('hook-poll.json'), undefined);
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
  const io = { files: fs, system: f.state.sys, setup: f.io, network: managedNetwork(f.net), env: {}, home: () => f.state.root, nodeVersion: process.version,
    input: async name => name === '-' ? CODE : encode({ level: 'INFO', msg: 'setup.archive_verified', setup_id: SETUP, expected_digest: 'a'.repeat(64), observed_digest: 'a'.repeat(64) }), stdout() {}, stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit' }) };
  assert.equal(await execute(['setup', '--state-dir', f.state.root, '--origin', 'https://broker.example.test', '--code-stdin', '--install-dir',
    join(f.state.root, 'installed'), '--setup-id', SETUP, '--bootstrap', '/receipt', '--archive-digest', PIN], io), 1);
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
        assert.equal(await execute(['setup', '--state-dir', f.state.root, '--origin', 'https://broker.example.test', '--code-stdin', '--install-dir',
          join(f.state.root, 'installed'), '--setup-id', SETUP, '--bootstrap', '/receipt', '--archive-digest', PIN], io), 1);
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
