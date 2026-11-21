import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { EnrolledUpgrade } from '../dist/upgrade.js';
import { oldOutage, checkLocalWork } from '../dist/upgrade-evidence.js';
import { Setup } from '../dist/setup.js';
import { setupIO } from '../dist/setup-os.js';
import { encode } from '../dist/json.js';
import { fixture, enrolled, ID, CONN, CODE, JOB, claimed } from './helpers.mjs';

const version = '0.4.0';
const sha = 'e'.repeat(64);
const setupID = 'd'.repeat(32);

async function installed(t) {
  const f = await fixture(t);
  await enrolled(f);
  const owner = { pid: 2_000_000_001, owner: 'old-owner' };
  const root = join(f.state.root, 'installed');
  const local = { package_version: '0.3.0', worker_id: ID, setup_id: setupID,
    origin: f.worker.config.origin, root, node: process.execPath, entry: join(root, 'old.js'),
    model_report: { model_name: 'Stored' } };
  await f.state.write('installation.json', encode(local));
  const now = f.state.sys.now();
  const start = now - 50;
  await f.state.write('launch.json', encode({ pid: owner.pid, started_at: start }));
  let pid = owner.pid;
  let online = true;
  let reservation;
  let stops = 0;
  let stages = 0;
  const lock = await f.state.child('daemon.lock');
  await lock.write('owner.json', encode(owner));
  f.state.sys.alive = value => value === pid;
  f.broker.override = call => {
    if (call.path.endsWith('/status')) return Response.json({ id: ID, work_status: reservation?.expires_at ? 'upgrading' : online ? 'idle' : 'unknown', current_job: null,
      waiting_for_client_tool: 0, upgrade_reservation_generation: reservation?.generation ?? 0,
      connection_status: online ? 'online' : 'offline', worker_package: { version, sha256: sha } });
    if (!call.path.endsWith('/upgrade-reservation')) return;
    const input = JSON.parse(call.options.body);
    if (input.action === 'acquire') reservation = { operation_id: input.operation_id, generation: input.generation + 1 };
    else if (input.operation_id !== reservation?.operation_id || (input.action === 'renew' && !reservation.expires_at)) {
      return Response.json({ error: 'upgrade_reservation_fenced' }, { status: 409 });
    }
    if (input.action === 'release') delete reservation.expires_at;
    else reservation.expires_at = new Date(f.state.sys.now() + 120_000).toISOString();
    return Response.json(reservation);
  };
  const setup = new Setup(f.worker, { ...setupIO(f.state.root), async launch() {
    pid = owner.pid + 1;
    online = true;
    const since = f.state.sys.now();
    await (await f.state.child('daemon.lock')).write('owner.json', encode({ pid, owner: 'new-owner' }));
    await f.state.write('connection.json', encode({ connection_id: CONN, connection_generation: 2, subscriber_owner: 'new-owner',
      subscriber_pid: pid, subscriber_started_at: since, status: 'online',
      last_acknowledged: { connection_id: CONN, connection_generation: 2, at: new Date(since).toISOString(), request_id: 'new-heartbeat' } }));
    return pid;
  } }, version);
  const control = { async stage() { stages++; return join(root, 'fixed.js'); }, stop(expected) {
    assert.deepEqual(expected, owner);
    assert(reservation?.expires_at, 'subscriber stopped without reserve');
    stops++;
    pid = 0;
    online = false;
  } };
  return { ...f, local, owner, setup, control, install: new EnrolledUpgrade(setup, control, sha),
    counts: () => ({ stops, stages }), offline() { online = false; pid = 0; } };
}

test('enrolled upgrade reserves before shutdown, resumes, and preserves the old identity while replacing assets', async t => {
  const f = await installed(t);
  const key = await f.state.read('credential.key');
  await assert.rejects(f.install.run('apply'), /upgrade_prepare_required/);
  assert.equal((await f.install.run('prepare')).outcome, 'reserved');
  assert.equal((await f.install.run('prepare')).outcome, 'reserved');
  assert.deepEqual(f.counts(), { stops: 0, stages: 0 });
  const result = await new EnrolledUpgrade(f.setup, f.control, sha).run('apply');
  assert.equal(result.outcome, 'upgraded');
  assert.equal(result.connection_generation, 2);
  assert.equal(result.request_id, 'new-heartbeat');
  assert.equal(result.watchdog.id, 'aaa-muse-worker-watchdog');
  assert.equal((await f.install.run('prepare')).outcome, 'already_current');
  assert.deepEqual(f.counts(), { stops: 1, stages: 1 });
  assert.equal(await f.state.read('credential.key'), key);
  assert.equal((await f.state.read('installation.json')).includes('Stored'), true);
  assert.equal(f.broker.calls.filter(call => call.path.endsWith('/enroll')).length, 1);
});

test('cancelled or rejected upgrade keeps the running owner and permits a fresh attempt', async t => {
  const f = await installed(t);
  await f.install.run('prepare');
  assert.equal((await f.install.run('cancel')).outcome, 'cancelled');
  await assert.rejects(f.install.run('apply'), /upgrade_prepare_required/);
  await f.state.write('pending.json', encode({ worker_id: ID, jobs: [{ job_id: JOB }] }));
  await assert.rejects(f.install.run('prepare'), /upgrade_local_work_unresolved/);
  await f.state.remove('pending.json');
  assert.equal((await f.install.run('prepare')).outcome, 'reserved');
  await (await f.state.child('daemon.lock')).write('owner.json', encode({ ...f.owner, owner: 'other-process' }));
  await assert.rejects(f.install.run('apply'), /upgrade_subscriber_changed/);
  assert.equal(f.counts().stops, 0);
});

test('resumes a staged upgrade after the old process stopped and the lease was released', async t => {
  const f = await installed(t);
  const stop = f.control.stop;
  f.control.stop = (...args) => { stop(...args); throw Object.assign(new Error('interrupted after stop'), { code: 'EINTR' }); };
  await f.install.run('prepare');
  await assert.rejects(f.install.run('apply'), /interrupted after stop/);
  const staged = JSON.parse(await f.state.read('upgrade.json')).staged_entry;
  assert.equal((await f.install.run('prepare')).outcome, 'reserved');
  assert.equal(JSON.parse(await f.state.read('upgrade.json')).staged_entry, staged);
  assert.equal((await f.install.run('apply')).outcome, 'upgraded');
  assert.deepEqual(f.counts(), { stops: 1, stages: 1 });
});

test('legacy archived stop proof requires the exact guarded status exchange', async t => {
  const f = await installed(t);
  f.offline();
  const since = f.state.sys.now();
  await f.state.write('launch.json', encode({ pid: f.owner.pid, started_at: since }));
  await f.logger.log('INFO', 'worker.supervision_started', { pid: f.owner.pid, background: true, worker_id: ID, setup_id: setupID });
  const request_id = 'status-404';
  await f.logger.log('DEBUG', 'worker.http_exchange', { request_id, endpoint: f.local.origin, method: 'GET', route: '/api/v1/worker/status',
    http_status: 404, response_validation_cause: 'invalid_json', output: '404 page not found' });
  const stopped_at = f.state.sys.now();
  const raw = encode({ cause: 'broker_rejected', pid: f.owner.pid, stopped_at, requires_operator_action: true });
  await f.state.write('run-stop.json', raw);
  await assert.rejects(oldOutage(f.setup, f.local), /upgrade_outage_request_unconfirmed/);
  await f.logger.log('ERROR', 'worker.command_failed', { request_id, cause: 'broker_rejected', stopped_operation: 'run',
    http_status: 404, response_validation_cause: 'invalid_json' });
  await assert.rejects(oldOutage(f.setup, { ...f.local, origin: 'https://other.example.test' }), /upgrade_outage_request_unconfirmed/);
  await f.install.run('prepare');
  await f.install.run('apply');
  const archive = (await f.state.list()).find(name => name.endsWith('.archived.json'));
  assert(archive);
  assert.equal(await f.state.read(archive), raw);
  assert.equal(await f.state.read('run-stop.json'), undefined);
  assert.equal(f.counts().stops, 0);
});

test('revocation, unproven markers and work journals continue to block unsafe upgrades', async t => {
  const f = await installed(t);
  const transport = await f.worker.load();
  await f.state.write('run-stop.json', encode({ cause: 'worker_unauthorized', pid: f.owner.pid, stopped_at: f.state.sys.now(), requires_operator_action: true }));
  f.offline();
  await assert.rejects(f.install.run('prepare'), /upgrade_terminal_stop_requires_operator/);
  assert(await f.state.read('run-stop.json'));
  const journal = await f.state.child('journals');
  const op = { worker_id: ID, origin: f.local.origin, job_id: JOB, state: 'uncertain' };
  await journal.write('operation-saved.json', encode(op));
  f.broker.jobs.set(JOB, claimed());
  await assert.rejects(checkLocalWork(f.setup, transport), /upgrade_local_work_unresolved/);
  Object.assign(f.broker.jobs.get(JOB), { state: 'accepted', held: false });
  await checkLocalWork(f.setup, transport);
  assert.equal(await journal.read('operation-saved.json'), encode(op));
  const ack = await f.state.child('acks');
  await ack.write('saved.json', '{"state":"queued"}');
  await assert.rejects(checkLocalWork(f.setup, transport), /upgrade_local_work_unresolved/);
  await fs.unlink(ack.path('saved.json'));
  const noKey = new Setup(f.worker, f.setup.io, version);
  await f.state.remove('credential.key');
  await assert.rejects(noKey.install(f.local.origin, CODE, f.local.root, setupID, undefined, true), /worker_not_enrolled/);
  assert.equal(f.broker.calls.filter(call => call.path.endsWith('/enroll')).length, 1);
});
