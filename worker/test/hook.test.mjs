import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { Cron } from '../dist/cron.js';
import { digest } from '../dist/diagnostics.js';
import { HookRunner, emitHook } from '../dist/hook.js';
import { HookSetup } from '../dist/hook-setup.js';
import { HookWatchdog } from '../dist/hook-watchdog.js';
import { Worker } from '../dist/worker.js';
import { VERSION } from '../dist/version.js';
import { fixture, claimed, CODE, ID, JOB, EXP, CONV, KEY } from './helpers.mjs';

const pin = 'a'.repeat(64);
const hookID = 'aaa-muse-worker-' + ID;
const scope = 'https://broker.example.test';
const claimID = 'hook-' + 'f'.repeat(32);
const startTime = Date.now();
function env(invocation) {
  return { HATCH_HOOK_RUNTIME: '/controlled/runtime', HATCH_HOOK_ID: hookID, HATCH_HOOK_INVOCATION_ID: invocation };
}
function hookReply(value, status = 200, version = VERSION, digest = pin) {
  return Response.json(value, { status, headers: { 'x-muse-service-version': version, 'x-muse-paired-worker-sha256': digest } });
}
async function setup(t) {
  const f = await fixture(t);
  await f.state.write('config.json', JSON.stringify({ protocol_version: 1, origin: scope, worker_id: ID }));
  await f.state.write('installation.json', JSON.stringify({ worker_id: ID, package_sha256: pin }));
  await f.state.write('credential.key', KEY);
  await f.state.write('hook-installation.json', JSON.stringify({ hook_id: hookID, worker_id: ID, watchdog_job_id: 'watchdog', confirmed_at: new Date(startTime).toISOString() }));
  const actions = [];
  const worker = new Worker(f.state, f.logger, f.net, VERSION, true);
  const updater = { contactHeaders: async () => ({}), recover: async () => undefined };
  let usages = 0;
  const cron = new Cron(worker, undefined, updater, async () => { usages++; return { reading: { used_percent: 33 } }; });
  const runner = new HookRunner(cron, updater, async (_, action) => { actions.push(action); return action.reason; }, async () => 'boot');
  return { ...f, worker, actions, runner, usages: () => usages };
}
function jobGrant() {
  return { job_id: JOB, operation_id: EXP, claim_id: claimID, generation: 1,
    claimed_at: new Date().toISOString(), deadline_at: new Date(Date.now() + 360_000).toISOString() };
}

test('idle ticks report a post-occurrence weekly reading at most every 45 seconds', async t => {
  const f = await setup(t);
  f.broker.override = call => { if (call.path.endsWith('/pull')) return hookReply({ job: null }); };
  assert.equal(await f.runner.check(env('tick1')), 'idle');
  f.advance(15_000);
  assert.equal(await f.runner.check(env('tick2')), 'idle');
  f.advance(15_000);
  assert.equal(await f.runner.check(env('tick3')), 'idle');
  f.advance(15_001);
  assert.equal(await f.runner.check(env('tick4')), 'idle');
  assert.equal(f.usages(), 2);
  assert.equal(await f.runner.check(env('tick4')), 'occurrence_replayed');
  const calls = f.broker.calls.filter(call => call.path.endsWith('/pull'));
  assert.equal(calls.length, 4);
  assert(calls.every(call => call.path === '/api/v1/worker/hook/pull' && call.options.headers['X-Muse-Worker-Hook-Proof'] === '1'));
  assert.equal(calls[1].options.headers['X-Muse-Worker-Weekly-Usage'], undefined);
  const used = JSON.parse(Buffer.from(calls[3].options.headers['X-Muse-Worker-Weekly-Usage'], 'base64url'));
  assert(used.observed_at >= calls[3].input.scheduled_at);
});

test('unconfirmed, overlapping and clock-regressed occurrences stay silent without another pull', async t => {
  const f = await setup(t);
  const saved = await f.state.read('hook-installation.json');
  await f.state.remove('hook-installation.json');
  assert.equal(await f.runner.check(env('unconfirmed')), 'registration_unverified');
  assert.equal(f.broker.calls.length, 0);
  await f.state.write('hook-installation.json', saved);
  await assert.rejects(f.runner.check({ ...env('foreign'), HATCH_HOOK_ID: 'another-hook' }), /foreign_hook/);
  const entered = Promise.withResolvers(), reply = Promise.withResolvers();
  f.broker.override = async call => {
    assert(call.path.endsWith('/pull'));
    entered.resolve();
    return await reply.promise;
  };
  const original = f.runner.check(env('original'));
  await entered.promise;
  try {
    assert.equal(await f.runner.check(env('overlap')), 'tick_in_flight');
    assert.equal(f.broker.calls.length, 1);
  } finally {
    reply.resolve(hookReply({ job: null }));
    assert.equal(await original, 'idle');
  }
  f.advance(-60_000);
  assert.equal(await f.runner.check(env('earlier')), 'clock_regressed');
  assert.equal(f.broker.calls.length, 1);
});

test('update recovery and a new exact offer do not emit work', async t => {
  const f = await setup(t);
  const target = { version: '1.2.0', sha256: 'b'.repeat(64), contract: 'managed-hook-v1' };
  const offer = { id: 'offered-update', target };
  f.runner.updater.recover = async () => ({ outcome: 'update_awaiting_confirmation' });
  assert.equal(await f.runner.check(env('recover')), 'update_awaiting_confirmation');
  assert.equal(f.broker.calls.length, 0);
  f.runner.updater.recover = async () => undefined;
  f.runner.updater.offer = async reported => {
    assert.deepEqual(reported, offer);
    assert.equal(JSON.parse(await f.state.read('cron-tick.json')).pending, undefined);
    return { outcome: 'update_failed' };
  };
  f.advance(15_000);
  f.broker.override = () => hookReply({ job: null, update: offer }, 200, target.version, target.sha256);
  assert.equal(await f.runner.check(env('offer')), 'update_failed');
  assert(f.actions.every(action => action.kind === 'silent'));
});

test('lost grant and bind replies retain the original bytes and wake the actual invocation once', async t => {
  const f = await setup(t);
  let pull = 0, bind = 0, start = 0;
  f.broker.override = call => {
    if (call.path.endsWith('/pull')) {
      if (++pull === 1) throw Object.assign(new Error('lost reply'), { code: 'ECONNRESET' });
      return hookReply({ job: jobGrant() });
    }
    if (call.path.endsWith('/bind')) {
      if (++bind === 1) throw Object.assign(new Error('lost bind'), { code: 'ECONNRESET' });
      return hookReply({ job_id: JOB, claim_id: claimID, invocation_id: call.input.invocation_id });
    }
    if (call.path.endsWith('/start')) {
      start++;
      return hookReply(claimed({ connection_id: '', connection_generation: 0, native_job_id: hookID,
        lease_id: claimID, launch_id: call.input.launch_id, started_at: new Date().toISOString() }));
    }
    if (call.path.endsWith('/presence')) return hookReply({ recorded: true, received_at: new Date().toISOString() });
    if (call.path.endsWith('/interrupt')) return hookReply({ job_id: JOB, claim_id: claimID, state: 'interrupted' });
  };
  await assert.rejects(f.runner.check(env('first')), /broker_unreachable/);
  f.advance(15_000);
  await assert.rejects(f.runner.check(env('second')), /broker_unreachable/);
  f.advance(15_000);
  assert.equal(await f.runner.check(env('third')), 'work_claimed');
  assert.equal(f.actions.length, 1);
  const wake = f.actions[0].payload;
  assert.equal(wake.expected_run_id, 'event-hook:third');
  const requests = f.broker.calls;
  assert.equal(requests[0].options.body, requests[1].options.body);
  assert.equal(requests[2].options.body, requests[3].options.body);
  assert.equal(requests[4].input.previous_invocation_id, 'second');
  await assert.rejects(f.runner.start(wake.launch_id, 'event-hook:first'), /hook_run_mismatch/);
  assert.equal(start, 0);
  assert.equal((await f.runner.start(wake.launch_id, 'event-hook:third')).outcome, 'authorized');
  assert.equal(start, 1);
  await assert.rejects(f.runner.start(wake.launch_id, 'event-hook:third'), /work_already_started/);
  f.advance(15_000);
  assert.equal(await f.runner.check(env('fourth')), 'claim_active');
  await f.runner.abort(wake.launch_id, 'event-hook:third', 'execution_failed');
  f.advance(15_000);
  assert.equal(await f.runner.check(env('fifth')), 'work_settled');
  assert.equal(await f.state.read('cron-claim.json'), undefined);
});

test('mismatched and archived broker responses cannot emit a wake, and uncertain wake is held', async t => {
  const f = await setup(t);
  let mode = 'old';
  f.broker.override = call => {
    if (call.path.endsWith('/pull')) {
      if (mode === 'old') return Response.json({ error: 'not_found' }, { status: 404, headers: { 'x-muse-service-version': '1.1.0' } });
      if (mode === 'mismatch') return hookReply({ job: jobGrant() }, 200, '1.2.0');
      return hookReply({ job: jobGrant() });
    }
    if (call.path.endsWith('/bind')) return hookReply({ job_id: JOB, claim_id: claimID, invocation_id: call.input.invocation_id });
    if (call.path.endsWith('/presence')) return hookReply({ recorded: true, received_at: new Date().toISOString() });
  };
  await assert.rejects(f.runner.check(env('one')), /hook_broker_unavailable/);
  f.advance(15_000);
  mode = 'mismatch';
  await assert.rejects(f.runner.check(env('two')), /update_required/);
  assert.equal(await f.state.read('cron-claim.json'), undefined);
  f.advance(15_000);
  mode = 'good';
  f.runner.emit = async () => { throw new Error('no acknowledgement'); };
  await assert.rejects(f.runner.check(env('three')), /no acknowledgement/);
  f.runner.emit = async (_, action) => action.reason;
  f.advance(15_000);
  assert.equal(await f.runner.check(env('four')), 'claim_active');
});

test('terminal claims never expose a brief and settle with exact refusal evidence', async t => {
  for (const terminal of ['already_expired', 'before_start']) {
    const f = await setup(t);
    const grant = jobGrant();
    if (terminal === 'already_expired') {
      grant.claimed_at = new Date(f.state.sys.now() - 7_000).toISOString();
      grant.deadline_at = new Date(f.state.sys.now() - 1_000).toISOString();
    }
    f.broker.override = call => {
      if (call.path.endsWith('/pull')) return hookReply({ job: grant });
      if (call.path.endsWith('/start')) return hookReply({ error: 'hook_claim_terminal' }, 409);
      assert(call.path.endsWith('/interrupt'));
      assert.equal(call.input.reason, 'launch_not_authorized');
      assert.equal(call.input.native_run_id, '');
      assert.equal(call.input.verified_start, true);
      return hookReply({ job_id: JOB, claim_id: claimID, state: 'interrupted' });
    };
    if (terminal === 'already_expired') {
      assert.equal(await f.runner.check(env('expiry')), 'work_settled');
      assert(f.actions.every(action => action.kind === 'silent'));
    } else {
      assert.equal(await f.runner.check(env('refused')), 'work_claimed');
      const launch = f.actions[0].payload.launch_id;
      await assert.rejects(f.runner.start(launch, 'event-hook:refused'), { code: 'broker_rejected' });
      assert.equal((await f.runner.abort(launch, 'event-hook:refused', 'execution_refused')).outcome, 'abort_saved');
      f.advance(15_000);
      assert.equal(await f.runner.check(env('after')), 'work_settled');
    }
    assert.equal(await f.state.read('cron-claim.json'), undefined);
    assert.equal(JSON.parse(await f.state.read('cron-last-receipt.json')).claim_id, claimID);
  }
});

test('an uncertain decision fences abort until the same result receipt and settlement are observed', async t => {
  const f = await setup(t);
  let available = false;
  f.broker.override = call => {
    if (call.path.endsWith('/pull')) return hookReply({ job: jobGrant() });
    if (call.path.endsWith('/start')) return hookReply(claimed({ lease_id: claimID, native_job_id: hookID,
      launch_id: call.input.launch_id, connection_id: '', connection_generation: 0, started_at: new Date().toISOString() }));
    if (call.path.endsWith('/decisions')) {
      if (!available) throw Object.assign(new Error(), { code: 'ECONNRESET' });
      return hookReply({ id: EXP, worker_id: ID, conversation_id: CONV, state: 'completed' });
    }
    if (call.path.endsWith('/interrupt')) return hookReply({ job_id: JOB, claim_id: claimID, state: 'accepted' });
  };
  await f.runner.check(env('delivery'));
  const launch = f.actions[0].payload.launch_id;
  await f.runner.start(launch, 'event-hook:delivery');
  await assert.rejects(f.runner.claims.submit(JOB, '{"type":"final","text":"retained"}'), /broker_unreachable/);
  await assert.rejects(f.runner.abort(launch, 'event-hook:delivery', 'execution_failed'), /hook_abort_uncertain/);
  available = true;
  f.advance(15_000);
  assert.equal(await f.runner.check(env('settle')), 'work_settled');
  const attempts = f.broker.calls.filter(call => call.path.endsWith('/decisions'));
  assert.equal(attempts.length, 4);
  assert(attempts.every(call => call.options.body === attempts[0].options.body));
  assert.equal(JSON.parse(await f.state.read('cron-last-receipt.json')).receipt.state, 'accepted');
});

test('media start verifies the paired binary response before exposing a native destination', async t => {
  const f = await setup(t);
  const io = f.state.io;
  f.state.io = { ...io, async mkdtemp(prefix) {
    const directory = await io.mkdtemp(prefix);
    t.after(() => fs.rm(directory, { recursive: true }));
    return directory;
  } };
  const prompt = 'controlled media generation';
  f.broker.override = call => {
    if (call.path.endsWith('/pull')) return hookReply({ job: jobGrant() });
    if (call.path.endsWith('/start')) return hookReply(claimed({ lease_id: claimID, native_job_id: hookID,
      launch_id: call.input.launch_id, connection_id: '', connection_generation: 0, started_at: new Date().toISOString(),
      media: { profile: 'prompt_wav', prompt_sha256: digest(prompt) } }));
    if (call.path.endsWith('/media/prompt')) {
      assert.equal(call.options.headers['X-Muse-Worker-SHA256'], pin);
      return new Response(prompt, { headers: { 'x-muse-service-version': VERSION, 'x-muse-paired-worker-sha256': pin } });
    }
  };
  await f.runner.check(env('media'));
  const launch = f.actions[0].payload.launch_id;
  const brief = await f.runner.start(launch, 'event-hook:media');
  assert.equal(brief.action, 'generate_wav_from_prompt');
  assert.equal(brief.prompt, prompt);
  assert.equal((await fs.lstat(brief.output_dir)).mode & 0o777, 0o700);
  await assert.rejects(f.runner.start(launch, 'event-hook:media'), /work_already_started/);
});

test('watchdog deduplicates stale ticks and retained update failures, then reports recovery', async t => {
  const f = await setup(t);
  const watcher = new HookWatchdog(f.worker, async () => 'current-boot');
  assert.equal((await watcher.check()).notify, false);
  const old = new Date(startTime - 900_000).toISOString();
  await f.state.write('hook-tick-health.json', JSON.stringify({ last_tick_at: old, last_success_at: old, boot_id: 'old-boot' }));
  await f.state.write('cron-claim.json', JSON.stringify({ ...jobGrant(), deadline_at: old }));
  await f.state.write('hook-update-health.json', JSON.stringify({ operation_id: 'update', target_version: '1.2.0', cause: 'archive_digest_mismatch' }));
  const first = await watcher.check();
  assert(first.notify && first.boot_changed);
  assert.deepEqual(first.incidents.map(item => item.kind), ['hook_tick_stale', 'claim_deadline_exceeded', 'update_failed']);
  assert.equal((await watcher.check()).notify, false);
  await f.state.remove('cron-claim.json');
  await f.state.remove('hook-update-health.json');
  await f.state.write('hook-tick-health.json', JSON.stringify({ last_tick_at: new Date().toISOString(), last_success_at: new Date().toISOString(), boot_id: 'current-boot' }));
  assert.equal((await watcher.check()).outcome, 'recovered');
  assert.equal((await watcher.check()).notify, false);
  await f.state.write('cron-update.json', JSON.stringify({ id: 'stalled-update', target: { version: '1.3.0' },
    stage: 'downloading', started_at_ms: startTime - 900_000 }));
  assert.equal((await watcher.check()).incidents[0].kind, 'update_stalled');
});

test('setup prepares private detector and resumes native registrations by exact readback', async t => {
  const f = await fixture(t);
  const wire = { ...f.net, fetch: async (...args) => {
    const response = await f.net.fetch(...args);
    response.headers.set('X-Muse-Paired-Worker-SHA256', pin);
    return response;
  } };
  const worker = new Worker(f.state, f.logger, wire, VERSION, true);
  const io = { home: f.state.root, node: process.execPath, entry: '/packed/main.js',
    asset: name => fs.readFile(new URL('../setup/' + name, import.meta.url), 'utf8'),
    prepareDirectory: path => fs.mkdir(path, { recursive: true, mode: 0o700 }) };
  const setup = new HookSetup(worker, io);
  const installed = await setup.install(scope, CODE, join(f.state.root, 'install'), '9'.repeat(32), pin);
  assert.equal(installed.worker_id, ID);
  assert.equal((await fs.stat(installed.detector)).mode & 0o777, 0o700);
  const { hook, watchdog } = await setup.describe('owned-goal');
  const blank = { goal_id: 'owned-goal', complete: true, hooks: [], watchdogs: [], target: 'hook' };
  assert((await setup.authorizeRegistration(JSON.stringify(blank))).add_hook);
  await assert.rejects(setup.authorizeRegistration(JSON.stringify(blank)), /hook_registration_uncertain/);
  const second = { ...blank, hooks: [hook], target: 'watchdog' };
  assert((await setup.authorizeRegistration(JSON.stringify(second))).add_watchdog);
  const actual = { ...second, dry_run: 'silent', watchdogs: [{ ...watchdog, native_job_id: 'native-watchdog' }] };
  assert.equal((await setup.confirm(JSON.stringify(actual))).outcome, 'registered');
  await assert.rejects(setup.confirm(JSON.stringify({ ...actual, hooks: [{ ...hook, enabled: false }] })), /hook_readback_mismatch/);
});

test('the real Bash adapter emits exactly one native action with an inert payload', async t => {
  const f = await fixture(t);
  const runtime = f.state.path('runtime');
  await fs.writeFile(runtime, 'silent() { printf "%s\\n" "$1"; }; wake() { printf "%s\\n%s\\n" "$1" "$2"; }\n');
  assert.equal(await emitHook(runtime, { kind: 'silent', reason: 'idle' }), 'idle\n');
  assert.equal(await emitHook(runtime, { kind: 'wake', reason: 'work_claimed', payload: { invocation: 'actual' } }),
    'work_claimed\n{"invocation":"actual"}\n');
  await assert.rejects(emitHook(f.state.path('missing'), { kind: 'silent', reason: 'idle' }), /hook_runtime_failed/);
});
