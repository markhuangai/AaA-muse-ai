import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { test } from 'node:test';
import { Cron, processIdentity } from '../dist/cron.js';
import { CronSetup } from '../dist/cron-setup.js';
import { encode } from '../dist/json.js';
import { VERSION } from '../dist/version.js';
import { fixture, claimed, KEY, ID, JOB, EXP } from './helpers.mjs';

const claimID = 'claim-1';
const goal = 'installation-goal';
const checker = 'checker-job';
const workJob = 'native-once';
const run = 'native-execution';
const iso = value => new Date(value).toISOString();
const disconnect = () => Object.assign(new Error('controlled lost reply'), { code: 'ECONNRESET' });
const reply = data => new Response(JSON.stringify(data), { headers: { 'X-Muse-Service-Version': VERSION } });

async function installed(t) {
  const f = await fixture(t);
  await f.state.write('installation.json', encode({ command: "'/fixture/launcher'", launcher: '/fixture/launcher', worker_id: ID }));
  await f.state.write('config.json', encode({ protocol_version: 1, origin: 'https://broker.example.test', worker_id: ID }));
  await f.state.write('credential.key', KEY);
  const setup = new CronSetup(f.worker, {}, VERSION);
  const expected = await setup.describe(goal);
  const match = { ...expected, native_job_id: checker };
  await assert.rejects(setup.confirm(JSON.stringify({ matches: [{ ...match, every: '2m' }] })), /checker_definition_mismatch/);
  await setup.authorizeRegistration(JSON.stringify({ goal_id: goal, complete: true, matches: [] }));
  await assert.rejects(setup.authorizeRegistration(JSON.stringify({ goal_id: goal, complete: true, matches: [] })), /checker_registration_uncertain/);
  await setup.confirm(JSON.stringify({ matches: [match] }));
  const tick = (number, delay = 0) => ({ checker_job_id: checker, checker_run_id: `tick-${number}`, scheduled_at: iso(f.state.sys.now() - delay) });
  const cron = new Cron(f.worker);
  async function observe(input) {
    const latest = JSON.parse(await f.state.read('cron-occurrence.json'));
    return cron.observe({ checker_job_id: latest.checker_job_id, checker_run_id: latest.checker_run_id, ...input });
  }
  return { ...f, cron, tick, observe };
}

test('checker coalesces delayed ticks and replays the exact persisted empty pull', async t => {
  const f = await installed(t);
  let samples = 0;
  const readUsage = async () => ({ reading: { used_percent: ++samples } });
  const firstCron = new Cron(f.worker, undefined, undefined, readUsage);
  let lost = true;
  f.broker.override = ({ path }) => {
    assert.equal(path, '/api/v1/worker/pull');
    if (lost) { lost = false; throw disconnect(); }
    return reply({ job: null });
  };
  assert.equal((await firstCron.check(f.tick(0, 60_100))).outcome, 'coalesced');
  assert.equal(f.broker.calls.length, 0);
  const first = f.tick(1);
  await assert.rejects(firstCron.check(first), /broker_unreachable/);
  f.advance(60_000);
  const restartedCron = new Cron(f.worker, undefined, undefined, readUsage);
  assert.equal((await restartedCron.check(f.tick(2))).outcome, 'idle');
  assert.equal(f.broker.calls.length, 2);
  assert.equal(f.broker.calls[0].options.body, f.broker.calls[1].options.body);
  const reading = call => call.options.headers['X-Muse-Worker-Weekly-Usage'];
  assert.equal(reading(f.broker.calls[0]), reading(f.broker.calls[1]));
  assert.equal(JSON.parse(Buffer.from(reading(f.broker.calls[0]), 'base64url')).used_percent, 1);
  assert.equal(samples, 1);
  assert.equal((await restartedCron.check(first)).outcome, 'coalesced');
  assert.equal(f.broker.calls.length, 2);
});

test('overlapping delivered ticks do not send concurrent pulls', async t => {
  const f = await installed(t);
  const started = Promise.withResolvers();
  const response = Promise.withResolvers();
  f.broker.override = () => {
    started.resolve();
    return response.promise;
  };
  const first = f.cron.check(f.tick(1, 55_000));
  await started.promise;
  f.advance(5_000);
  try {
    assert.equal((await f.cron.check(f.tick(2))).outcome, 'coalesced');
    assert.equal(f.broker.calls.length, 1);
  } finally {
    response.resolve(reply({ job: null }));
    assert.equal((await first).outcome, 'idle');
  }
});

test('affirmative registration rejection rotates only the launch and an unstarted cancellation settles', async t => {
  const f = await installed(t);
  const stamp = f.state.sys.now();
  f.broker.override = ({ path, input }) => {
    if (path.endsWith('/pull')) return reply({ job: { job_id: JOB, operation_id: EXP, claim_id: claimID,
      generation: 1, claimed_at: iso(stamp), deadline_at: iso(stamp + 300_000) } });
    assert.ok(path.endsWith('/interrupt'));
    assert.equal(input.claim_id, claimID);
    assert.equal(input.reason, 'native_cancelled_before_start');
    assert.equal(input.native_run_id, '');
    return reply({ job_id: JOB, claim_id: claimID, state: 'interrupted' });
  };
  const first = await f.cron.check(f.tick(1));
  const registration = await f.cron.prepare({ claim_id: claimID, launch_id: first.launch_id, due_at: iso(stamp + 5_000) });
  const observed = { claim_id: claimID, launch_id: first.launch_id, observed_at: iso(f.state.sys.now()), matches: [] };
  const proof = { ...registration.work, outcome: 'not_created', native_operation_id: 'rejected-operation' };
  assert.equal((await f.observe(observed)).outcome, 'recovery_pending');
  await assert.rejects(f.observe({ ...observed, registration_rejection: { ...proof, goal_id: 'foreign-goal' } }), /native_non_delivery_unverified/);
  const resumed = await f.observe({ ...observed, registration_rejection: proof });
  assert.equal(resumed.outcome, 'prepare');
  assert.equal(resumed.claim_id, claimID);
  assert.notEqual(resumed.launch_id, first.launch_id);
  await assert.rejects(f.observe(observed), /stale_native_observation/);
  const next = await f.cron.prepare({ claim_id: claimID, launch_id: resumed.launch_id, due_at: iso(stamp + 5_000) });
  const cancelled = { ...next.work, native_job_id: workJob, status: 'cancelled' };
  const latest = { ...observed, launch_id: resumed.launch_id, observed_at: iso(f.state.sys.now()) };
  assert.equal((await f.observe({ ...latest, matches: [cancelled] })).outcome, 'recovery_pending');
  assert.equal((await f.observe({ ...latest, matches: [{ ...cancelled, execution_never_started: true }] })).outcome, 'settled');
  assert.equal(f.broker.calls.length, 2);
});

test('a legacy producer holds the claim until its exact process stops and settlement replays', async t => {
  const f = await installed(t);
  let pulled = false;
  let loseInterrupt = true;
  let startCount = 0;
  const stamp = f.state.sys.now();
  const grant = { job_id: JOB, operation_id: EXP, claim_id: claimID, generation: 1, claimed_at: iso(stamp), deadline_at: iso(stamp + 300_000) };
  f.broker.override = ({ path, input }) => {
    if (path.endsWith('/pull')) {
      if (pulled) return reply({ job: null });
      pulled = true;
      return reply({ job: grant });
    }
    if (path.endsWith('/start')) {
      startCount++;
      return reply(claimed({ connection_id: '', connection_generation: 0, native_job_id: workJob, launch_id: input.launch_id,
        lease_id: claimID, started_at: iso(f.state.sys.now()), deadline_at: grant.deadline_at }));
    }
    if (path.endsWith('/presence')) {
      return new Response('{"error":"not_found"}', { status: 404, headers: { 'X-Muse-Service-Version': '1.0.0-rc.1' } });
    }
    assert.ok(path.endsWith('/interrupt'));
    if (loseInterrupt) { loseInterrupt = false; throw disconnect(); }
    return reply({ job_id: JOB, claim_id: claimID, state: 'interrupted' });
  };
  const initial = await f.cron.check(f.tick(1));
  assert.equal(initial.outcome, 'prepare');
  const legacy = JSON.parse(await f.state.read('cron-claim.json'));
  delete legacy.producer_mode;
  delete legacy.start_proof;
  await f.state.write('cron-claim.json', encode(legacy));
  const request = { claim_id: claimID, launch_id: initial.launch_id, due_at: iso(stamp + 5_000) };
  const registered = await f.cron.prepare(request);
  assert.equal(registered.outcome, 'register');
  assert.equal((await f.cron.prepare(request)).outcome, 'recovery_pending');
  const observed = matches => ({ claim_id: claimID, launch_id: initial.launch_id, observed_at: iso(f.state.sys.now()), matches });
  const status = (state, id = run, parent = workJob) => ({ ...registered.work, native_job_id: workJob, status: state,
    execution: { native_job_id: parent, native_run_id: id, status: state } });
  assert.equal((await f.observe(observed([]))).outcome, 'recovery_pending');
  assert.equal((await f.observe(observed([status('queued'), status('queued')]))).outcome, 'recovery_pending');
  for (const foreign of [workJob, checker, 'tick-1']) {
    const wrongExecution = await f.observe(observed([status('failed', foreign)]));
    assert.equal(wrongExecution.outcome, 'recovery_pending');
    assert.equal(wrongExecution.native_run_id, null);
  }
  assert.equal((await f.observe(observed([status('failed', run, 'other-job')]))).outcome, 'recovery_pending');
  await assert.rejects(f.cron.start(initial.launch_id, checker), /native_job_id_is_checker_id/);
  assert.equal((await f.observe(observed([status('queued')]))).outcome, 'queued');
  assert.equal((await f.cron.start(initial.launch_id, workJob)).outcome, 'authorized');
  await assert.rejects(f.cron.start(initial.launch_id, workJob), /work_already_started/);
  assert.equal(startCount, 1);
  assert.equal((await f.observe(observed([status('running')]))).outcome, 'running');

  const producer = await f.cron.producerIntent(initial.launch_id);
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60_000)'], { stdio: 'ignore' });
  const stopped = once(child, 'exit');
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  await once(child, 'spawn');
  assert.equal((await f.observe(observed([status('failed')]))).cause, 'producer_launch_unobservable');
  f.advance(60_000);
  assert.equal((await f.cron.check(f.tick(2))).cause, 'producer_launch_unobservable');
  assert.equal((await f.cron.check(f.tick(2))).outcome, 'coalesced');
  assert.equal((await f.observe(observed([status('failed')]))).outcome, 'recovery_pending');
  await f.cron.producer(initial.launch_id, producer.producer_id, child.pid);
  assert.equal((await f.observe(observed([status('failed')]))).outcome, 'recovery_pending');
  const actual = await processIdentity(child.pid);
  const occurrence = JSON.parse(await f.state.read('cron-occurrence.json'));
  const replaced = new Cron(f.worker, async pid => {
    assert.equal(pid, child.pid);
    return { ...actual, start: (BigInt(actual.start) + 1n).toString(), running: false };
  });
  assert.equal((await replaced.observe({ checker_job_id: occurrence.checker_job_id, checker_run_id: occurrence.checker_run_id,
    ...observed([status('failed')]) })).outcome, 'recovery_pending');
  const presences = f.broker.calls.filter(call => call.path.endsWith('/presence'));
  assert.equal(presences.length, 1);
  assert.equal(presences[0].input.hold_reason, 'producer_launch_unobservable');
  child.kill();
  await stopped;
  f.advance(60_000);
  await assert.rejects(f.cron.check(f.tick(3)), /broker_unreachable/);
  f.advance(60_000);
  assert.equal((await f.cron.check(f.tick(4))).outcome, 'settled');
  const attempts = f.broker.calls.filter(call => call.path.endsWith('/interrupt'));
  assert.equal(attempts.length, 2);
  assert.equal(attempts[0].options.body, attempts[1].options.body);
  f.advance(60_000);
  assert.equal((await f.cron.check(f.tick(5))).outcome, 'idle');
});

for (const [scenario, cause] of [
  ['missing execution', 'native_execution_unobservable'],
  ['conflicting execution', 'native_execution_record_mismatch'],
  ['ambiguous list', 'native_registration_ambiguous'],
  ['conflicting rejection', 'native_registration_ambiguous'],
]) {
  test(`an exact definition remains registered after ${scenario}`, async t => {
    const f = await installed(t);
    const stamp = f.state.sys.now();
    const grant = { job_id: JOB, operation_id: EXP, claim_id: claimID, generation: 1, claimed_at: iso(stamp), deadline_at: iso(stamp + 300_000) };
    f.broker.override = ({ path, input }) => path.endsWith('/pull') ? reply({ job: grant }) : reply(claimed({
      connection_id: '', connection_generation: 0, native_job_id: workJob, launch_id: input.launch_id,
      lease_id: claimID, started_at: iso(stamp), deadline_at: grant.deadline_at,
    }));
    const check = await f.cron.check(f.tick(1));
    const scope = { claim_id: claimID, launch_id: check.launch_id };
    const definition = (await f.cron.prepare({ ...scope, due_at: iso(stamp + 5000) })).work;
    const execution = { native_job_id: workJob, native_run_id: run, status: 'running' };
    const match = { ...definition, native_job_id: workJob, status: 'running' };
    const observation = { ...scope, observed_at: iso(f.state.sys.now()) };
    const registrationRejection = { ...definition, outcome: 'not_created', native_operation_id: 'false-rejection' };
    const evidence = {
      'missing execution': { matches: [match] },
      'conflicting execution': { matches: [{ ...match, execution }], execution: { ...execution, native_run_id: 'other-run' } },
      'ambiguous list': { matches: [match, { ...match, native_job_id: 'other-job' }] },
      'conflicting rejection': { matches: [match], registration_rejection: registrationRejection },
    };
    const pending = await f.observe({ ...observation, ...evidence[scenario] });
    assert.equal(pending.cause, cause);
    assert.equal(pending.native_job_id, null);
    assert.equal(pending.native_run_id, null);
    await assert.rejects(f.observe({ ...observation, matches: [], registration_rejection: registrationRejection }), /native_registration_already_delivered/);
    assert.equal((await f.cron.start(check.launch_id, { matches: [{ ...match, execution }] })).outcome, 'authorized');
  });
}

test('settles only normalized execution evidence bound to the same native job and run', async t => {
  const f = await installed(t);
  const stamp = f.state.sys.now();
  const claim = 'verified-' + claimID;
  const grant = { job_id: JOB, operation_id: EXP, claim_id: claim, generation: 1, claimed_at: iso(stamp), deadline_at: iso(stamp + 300_000) };
  f.broker.override = ({ path, input }) => {
    if (path.endsWith('/pull')) return reply({ job: grant });
    if (path.endsWith('/presence')) return reply({ recorded: true, received_at: iso(f.state.sys.now()) });
    if (path.endsWith('/start')) {
      assert.deepEqual(JSON.parse(encode(input.verification)), { reference: claim, ...record('running') });
      return reply(claimed({ native_job_id: workJob, launch_id: input.launch_id,
        lease_id: claim, started_at: iso(stamp), deadline_at: grant.deadline_at }));
    }
    assert.ok(path.endsWith('/interrupt'));
    assert.equal(input.verified_start, true);
    assert.equal(input.native_job_id, workJob);
    assert.equal(input.native_run_id, run);
    return reply({ job_id: JOB, claim_id: claim, state: 'interrupted' });
  };
  const check = await f.cron.check(f.tick(1));
  const scope = { claim_id: claim, launch_id: check.launch_id };
  const definition = (await f.cron.prepare({ ...scope, due_at: iso(stamp + 5000) })).work;
  assert.equal(definition.reference, claim);
  const match = { ...definition, native_job_id: workJob };
  const record = (status, parent = workJob, id = run) => ({ native_job_id: parent, native_run_id: id, status });
  const observe = (matches, execution) => f.observe({ ...scope, observed_at: iso(f.state.sys.now()), matches, execution });
  assert.equal((await observe([], record('succeeded'))).cause, 'native_registration_unobservable');
  const running = { ...match, status: 'running', execution: record('running') };
  const start = matches => f.cron.start(check.launch_id, { matches });
  await assert.rejects(f.cron.start(check.launch_id, 'unrelated-occurrence'), /native_start_definition_required/);
  await assert.rejects(start([running, running]), /native_start_definition_required/);
  await assert.rejects(start([{ ...running, prompt: 'old one-shot' }]), /native_start_definition_mismatch/);
  await assert.rejects(start([{ ...running, execution: record('running', 'foreign-parent') }]), /native_start_execution_mismatch/);
  await assert.rejects(f.cron.start(check.launch_id, { matches: [running], execution: record('running', 'foreign-parent') }),
    /unsupported_or_missing_fields/);
  for (const foreign of [workJob, checker, 'tick-1']) {
    await assert.rejects(start([{ ...running, execution: record('running', workJob, foreign) }]), /native_start_(execution_mismatch|checker_id)/);
  }
  assert.equal((await observe([{ ...match, native_job_id: 'unrelated-occurrence', status: 'unobservable' }])).native_job_id, null);
  await assert.rejects(f.observe({ ...scope, observed_at: iso(f.state.sys.now()), matches: [],
    registration_rejection: { ...definition, outcome: 'not_created', native_operation_id: 'late-rejection' } }), /native_registration_already_delivered/);
  assert.equal((await observe([{ ...match, native_job_id: 'unrelated-occurrence', status: 'queued' }])).native_job_id, null);
  assert.equal(f.broker.calls.filter(call => call.path.endsWith('/start')).length, 0);
  assert.equal((await start([running])).outcome, 'authorized');
  assert.equal((await observe([{ ...match, status: 'unobservable' }])).native_run_id, run);
  const reserved = await f.cron.producerIntent(check.launch_id);
  assert.equal(reserved.mode, 'guarded');
  await assert.rejects(f.cron.producer(check.launch_id, reserved.producer_id, process.pid), /producer_guard_required/);
  assert.equal((await observe([{ ...match, status: 'completed', execution: record('failed') }], record('succeeded'))).cause,
    'native_execution_record_mismatch');
  assert.equal((await observe([], record('succeeded', 'foreign-job'))).cause, 'native_registration_unobservable');
  assert.equal((await observe([], record('succeeded', workJob, 'foreign-run'))).cause, 'native_registration_unobservable');
  f.advance(60_000);
  const later = await f.cron.check(f.tick(2));
  assert.equal(later.history_lookup.native_run_id, run);
  assert.equal((await observe([], record('succeeded'))).outcome, 'settled');
  await assert.rejects(f.cron.producer(check.launch_id, reserved.producer_id, process.pid, true), /stale_native_launch/);
  assert.equal(f.broker.calls.filter(call => call.path.endsWith('/interrupt')).length, 1);
});
