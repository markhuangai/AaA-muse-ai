import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { execute, VERSION } from '../dist/cli.js';
import { Failure } from '../dist/errors.js';
import { Setup } from '../dist/setup.js';
import { setupIO } from '../dist/setup-os.js';
import { encode } from '../dist/json.js';
import { CODE, ID, JOB, KEY, fixture } from './helpers.mjs';

async function installed(t) {
  const f = await fixture(t);
  const { state } = f;
  const live = new Map();
  const oldAlive = state.sys.alive;
  const start = Date.parse('2026-11-20T17:04:00Z');
  let now = start;
  let launches = 0;
  let generation = 0;
  let wakeCount = 0;
  state.sys.now = () => now;
  state.sys.alive = pid => live.has(pid) ? live.get(pid) : oldAlive(pid);
  state.sys.wait = async ms => { now += ms; };
  const io = { ...setupIO(state.root), async launch() {
    const pid = 2_000_000_000 + ++launches;
    live.set(pid, true);
    const owner = await state.child('daemon.lock');
    await owner.write('owner.json', encode({ pid, owner: 'sub-' + pid }));
    return pid;
  }, async emit(_runtime, action) {
    if (action === 'wake') wakeCount++;
    return encode({ action }) + '\n';
  } };
  const setup = new Setup(f.worker, io, VERSION);
  const receipt = await setup.install('https://broker.example.test', CODE, join(state.root, 'installed'), 'setup');
  const run = async (command, options = {}) => {
    const stdout = [], stderr = [];
    const code = await execute([command, '--state-dir', options.directory ?? state.root], {
      files: fs, system: state.sys, setup: io, network: f.net, env: {}, home: () => state.root,
      nodeVersion: process.version, input: async () => { throw new Error('unexpected stdin'); },
      stdout: line => stdout.push(line), stderr: line => stderr.push(JSON.parse(line)),
      signal: options.signal ?? new AbortController().signal, metadata: async () => ({ source_sha: 'unit' }),
    });
    return { code, value: stdout.length ? JSON.parse(stdout.join('')) : undefined, stderr };
  };
  const ack = async (options = {}) => {
    const g = options.generation ?? ++generation;
    const pid = options.pid ?? 2_000_000_000 + launches;
    const at = new Date(now - (options.age ?? 0)).toISOString();
    const connectionID = 'connection-' + g;
    await state.write('connection.json', encode({ status: options.status ?? 'online', subscriber_pid: pid,
      subscriber_owner: 'sub-' + pid, subscriber_started_at: start, connection_id: connectionID, connection_generation: g,
      ...(options.missing ? {} : { last_heartbeat_at: at, last_acknowledged: { at, connection_id: options.old ?? connectionID,
        connection_generation: g, request_id: 'heartbeat-' + g } }) }));
  };
  return { ...f, setup, io, run, ack, live, receipt, launches: () => launches, wakeCount: () => wakeCount,
    advance: ms => { now += ms; }, start, poll: () => setup.check('/fixture-runtime') };
}

const kinds = result => result.value?.notices.map(notice => notice.kind) ?? [];

test('health is local and read-only, and watchdog keeps both recorded poll gaps', async t => {
  const f = await installed(t);
  await f.ack();
  await f.poll();
  const fileBefore = await f.state.read('hook-poll.json');
  const logBefore = await f.state.io.readdir(f.state.path('diagnostics'));
  const callsBefore = f.broker.calls.length;
  assert.equal((await f.run('health')).value.subscriber.connection_status, 'online');
  assert.deepEqual(await f.state.io.readdir(f.state.path('diagnostics')), logBefore);
  assert.equal(await f.state.read('hook-poll.json'), fileBefore);
  assert.deepEqual(kinds(await f.run('watchdog-check')), []);
  assert.equal(f.broker.calls.length, callsBefore);
  f.advance(29_999);
  assert.equal((await f.run('health')).value.subscriber.connection_status, 'online');
  f.advance(1);
  assert.equal((await f.run('health')).value.subscriber.connection_status, 'expired');
  f.advance(90_000);
  assert.deepEqual(kinds(await f.run('watchdog-check')), []);
  f.advance(359_000);
  const beforeResume = await f.run('watchdog-check');
  assert.deepEqual(kinds(beforeResume), ['hook_stalled', 'subscriber_still_down']);
  assert.equal(f.launches(), 1);
  assert.equal(await f.state.read('hook-poll.json'), fileBefore);
  await f.ack({ generation: 1 });
  await f.poll();
  const restored = await f.run('watchdog-check');
  assert.deepEqual(kinds(restored), ['hook_gap', 'hook_recovered', 'subscriber_recovered']);
  assert.equal(restored.value.notices[0].last_gap.duration_ms, 480_000);
  assert.deepEqual(kinds(await f.run('watchdog-check')), []);
  f.advance(914_000);
  await f.ack({ generation: 1 });
  await f.poll();
  f.advance(5000);
  await f.poll();
  const missed = await f.run('watchdog-check');
  assert.deepEqual(kinds(missed), ['hook_gap', 'hook_recovered']);
  assert.equal(missed.value.notices[0].last_gap.duration_ms, 914_000);
  assert.equal((await f.run('health')).value.hook.gap_count, 2);
  const failureLogs = beforeResume.stderr.filter(e => e.msg.startsWith('watchdog.'));
  assert(failureLogs.every(e => e.level === 'WARN' && e.worker_id === ID && e.hook.attempt_age_ms > 120_000 && e.corrective_action));
  assert(f.output.some(line => line.includes('watchdog.hook_gap_observed')));
  assert(![...f.output, JSON.stringify(restored)].join('').includes(KEY));
});

test('watchdog rechecks a live stale subscriber with missing, future and historical heartbeats', async t => {
  const f = await installed(t);
  f.advance(130_000);
  await f.poll();
  for (const sample of [{ missing: true, status: 'connecting' }, { age: -500, status: 'connecting' },
    { age: 121_000, old: 'old-generation', status: 'offline' }]) {
    await f.ack(sample);
    const health = (await f.run('health')).value;
    assert.notEqual(health.subscriber.heartbeat_evidence, 'current');
    assert.equal(health.subscriber.owner_state, 'live');
    assert(!kinds(await f.run('watchdog-check')).includes('subscriber_recovered'));
  }
  assert.equal(f.launches(), 1);
  assert.equal(f.live.get(2_000_000_001), true);
  await f.ack();
  assert.deepEqual(kinds(await f.run('watchdog-check')), ['subscriber_recovered']);
});

test('only a genuine hook can consume an actionable job wake', async t => {
  const f = await installed(t);
  await f.ack();
  await f.poll();
  const saved = await f.state.read('hook-emission.json');
  const job = { job_id: JOB, conversation_id: 'scope', generation: 1, state: 'pending', needs_attention: true };
  await f.state.write('pending.json', encode({ worker_id: ID, jobs: [job] }));
  const result = await f.run('watchdog-check');
  assert.deepEqual(result.value.notices, [{ kind: 'actionable_work', count: 1 }]);
  assert(!encode(result.value).includes(JOB));
  assert.equal(await f.state.read('hook-emission.json'), saved);
  assert.deepEqual(kinds(await f.run('watchdog-check')), []);
  assert.equal(JSON.parse(await f.poll()).action, 'wake');
  assert.equal(JSON.parse(await f.poll()).action, 'silent');
  assert.equal(f.wakeCount(), 1);
  job.generation = 2;
  await f.state.write('pending.json', encode({ worker_id: ID, jobs: [job] }));
  assert.deepEqual(kinds(await f.run('watchdog-check')), ['actionable_work']);
});

test('watchdog serializes ticks and accepts only the new daemon heartbeat after retry', async t => {
  const f = await installed(t);
  await f.ack();
  await f.poll();
  f.live.set(2_000_000_001, false);
  const launch = f.io.launch;
  const originalWait = f.state.sys.wait;
  let entered;
  const launching = new Promise(resolve => { entered = resolve; });
  let continueLaunch;
  const waitForOverlap = new Promise(resolve => { continueLaunch = resolve; });
  let attempts = 0;
  f.io.launch = async () => {
    if (++attempts === 1) {
      entered();
      await waitForOverlap;
      throw new Failure('subscriber_launch_failed', { cause: 'EAGAIN' }, true);
    }
    return await launch();
  };
  f.state.sys.wait = async ms => {
    await originalWait(ms);
    if (ms === 1000 && attempts === 2) await f.ack();
  };
  const first = f.run('watchdog-check');
  await launching;
  try {
    assert.deepEqual(await f.run('watchdog-check'), { code: 0, value: undefined, stderr: [] });
  } finally { continueLaunch(); }
  const result = await first;
  assert.deepEqual(kinds(result), ['subscriber_recovered']);
  assert.equal(result.value.notices[0].connection_generation, 2);
  assert.equal(f.launches(), 2);
  const recovered = result.stderr.find(e => e.msg === 'watchdog.subscriber_recovered');
  assert.equal(recovered.level, 'INFO');
  assert.equal(recovered.attempts, 2);
  assert.equal(recovered.request_id, 'heartbeat-2');
  assert(!result.stderr.some(e => e.level === 'DEBUG'));
});

test('unsafe paths, terminal stop and ambiguous ownership block launches', async t => {
  const f = await installed(t);
  await f.ack();
  await f.poll();
  await fs.unlink(f.receipt.skill_path);
  const missing = await f.run('watchdog-check');
  assert.equal(missing.value.notices[0].cause, 'required_paths_unavailable');
  assert.deepEqual(missing.value.notices[0].paths, [{ role: 'skill', status: 'missing' }]);
  assert.deepEqual(kinds(await f.run('watchdog-check')), []);
  await fs.writeFile(f.receipt.skill_path, 'fixture', { mode: 0o600 });
  await f.state.write('run-stop.json', encode({ cause: 'worker_unauthorized', reason: KEY }));
  const terminal = await f.run('watchdog-check');
  assert.equal(terminal.value.notices[0].cause, 'subscriber_terminal_stop');
  assert(!encode((await f.run('health')).value).includes(KEY));
  assert(!encode(terminal).includes(KEY));
  await f.state.remove('run-stop.json');
  const owner = await f.state.child('daemon.lock');
  await owner.remove('owner.json');
  await fs.rmdir(owner.root);
  assert.equal((await f.run('watchdog-check')).value.notices[0].cause, 'subscriber_owner_ambiguous');
  assert.equal(f.launches(), 1);
  const none = join(f.state.root, 'absent');
  for (const command of ['health', 'watchdog-check']) {
    const result = await f.run(command, { directory: none });
    assert.equal(result.code, 1);
    assert.equal(result.stderr[0].cause, 'worker_state_missing');
    assert.equal(result.stderr[0].protected_capture_unavailable, true);
  }
  await assert.rejects(fs.lstat(none), { code: 'ENOENT' });
});

test('a live replacement without a new heartbeat exhausts observation without another launch', async t => {
  const f = await installed(t);
  await f.ack();
  await f.poll();
  f.live.set(2_000_000_001, false);
  const result = await f.run('watchdog-check');
  assert.deepEqual(result.value.notices, [{ kind: 'subscriber_still_down', cause: 'subscriber_recovery_unconfirmed' }]);
  const failure = result.stderr.find(e => e.msg === 'watchdog.recovery_failed');
  assert.equal(failure.level, 'ERROR');
  assert.equal(failure.attempts, 1);
  assert.equal(failure.duration_ms, 30_000);
  assert.equal(failure.subscriber.heartbeat_evidence, 'historical');
  assert.equal(f.launches(), 2);
});

test('unexplained child exits before ownership and before heartbeat never justify a retry', async t => {
  for (const owned of [false, true]) {
    await t.test(owned ? 'during observation' : 'before ownership', async t => {
      const f = await installed(t);
      await f.ack();
      await f.poll();
      f.live.set(2_000_000_001, false);
      const launch = f.io.launch;
      const wait = f.state.sys.wait;
      let attempts = 0;
      f.io.launch = async state => {
        attempts++;
        if (owned) return await launch(state);
        return 2_000_000_002;
      };
      if (owned) f.state.sys.wait = async ms => {
        await wait(ms);
        f.live.set(2_000_000_002, false);
      };
      const result = await f.run('watchdog-check');
      assert.deepEqual(kinds(result), ['subscriber_still_down']);
      assert.equal(attempts, 1);
      const failure = result.stderr.find(e => e.msg === 'watchdog.recovery_failed');
      assert.equal(failure.cause, owned ? 'subscriber_recovery_unconfirmed' : 'subscriber_start_not_observed');
    });
  }
});
