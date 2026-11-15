import test from 'node:test';
import assert from 'node:assert/strict';
import { brokerBoundary, recoveryBoundary } from './product-recovery.mjs';
import { productFixture, stamp } from './test/product-fixture.mjs';

test('broker recovery joins the accepted tool, authenticated process identities and one resumed execution', () => {
  for (const live of [false, true]) {
    const { report, broker } = productFixture(live), item = report.cases.find(item => item.id === 'recovery.broker-tool-wait');
    assert.equal(brokerBoundary(report, broker, item), report.checkpoints.broker);
  }
});

test('placeholder checkpoints, unrelated recovery and changed tool/session identities cannot prove broker recovery', () => {
  for (const change of [
    ({ report }) => { delete report.checkpoints; },
    ({ report }) => { report.cycles = report.cycles.filter(item => item.id !== report.checkpoints.broker.cycle_id); },
    ({ report }) => { report.checkpoints.broker.pending_call_id = 'foreign-call'; },
    ({ report }) => { report.checkpoints.broker.completed_request_id = 'unrelated-operation'; },
    ({ report }) => { report.checkpoints.broker.prepared_at = stamp(100); },
    ({ report }) => { report.checkpoints.broker.resumed_at = stamp(900); },
    ({ report }) => { report.cycles.find(item => item.id === 'broker-wait').client_tool_executions = 2; },
    ({ item }) => { item.session_id = 'another-session'; },
    ({ item }) => { item.worker_ids = ['worker-b']; },
    ({ report }) => { report.observations.find(entry => entry.case_id === 'recovery.broker-tool-wait').operation_ids = ['unrelated-operation']; },
    ({ report }) => { report.checkpoints.broker.before_status.instance_id = 'forged-process'; },
    ({ report }) => { report.checkpoints.broker.before_instance = report.checkpoints.broker.after_instance; report.checkpoints.broker.before_status = report.checkpoints.broker.after_status; },
    ({ broker }) => { broker.find(event => event.msg === 'request.exchange').response = 'malformed'; },
    ({ broker }) => { broker.find(event => event.msg === 'request.exchange').role = 'client'; },
    ({ broker }) => { broker.find(event => event.msg === 'request.exchange').instance_id = 'unrelated-process'; },
    ({ broker }) => { broker.find(event => event.msg === 'recovery.started').time = stamp(1); },
    ({ broker }) => { broker.find(event => event.msg === 'decision.accepted' && event.operation_id === 'broker-wait-0').call_id = 'foreign-call'; },
    ({ broker }) => { broker.find(event => event.msg === 'recovery.restored').operation_id = 'unrelated-operation'; },
    ({ broker }) => { broker.find(event => event.msg === 'recovery.restored').pending_call_id = 'foreign-call'; },
    ({ broker }) => { broker.find(event => event.msg === 'recovery.restored').pinned_worker_id = 'worker-b'; },
    ({ broker }) => { broker.find(event => event.msg === 'decision.accepted' && event.operation_id === 'broker-wait-1').instance_id = 'old-process'; },
  ]) {
    const fixture = productFixture(true); fixture.item = fixture.report.cases.find(item => item.id === 'recovery.broker-tool-wait'); change(fixture);
    assert.throws(() => brokerBoundary(fixture.report, fixture.broker, fixture.item));
  }
});

test('recovery binds the retained task, post-action subscriber and current probe generation', () => {
  for (const id of ['recovery.worker', 'recovery.refresh']) {
    const { report, workers } = productFixture(true), item = report.cases.find(item => item.id === id);
    const result = recoveryBoundary(report, id, workers, { item });
    assert.equal(result.worker_id, 'worker-a'); assert.equal(result.hook_id, 'hook-a'); assert.ok(result.connection_generation > result.before_connection_generation);
    assert.equal(recoveryBoundary(report, id, workers, { probe: false }).connection_id, result.connection_id);
  }
});

test('initial installation, another hook/worker, wrong action ordering or stale probes cannot prove recovery', () => {
  for (const change of [
    ({ report }) => { report.observations.find(entry => entry.case_id === 'recovery.worker').action_at = ''; },
    ({ report }) => { report.observations.find(entry => entry.case_id === 'recovery.worker').hook_id = 'different-hook'; },
    ({ report }) => { report.observations.find(entry => entry.case_id === 'recovery.worker').before_connection_id = ''; },
    ({ report }) => { report.observations.find(entry => entry.kind === 'worker_reconnected').connection_generation = 1; },
    ({ report }) => { report.observations.find(entry => entry.kind === 'worker_reconnected').reenrolled = true; },
    fixture => { fixture.workers = fixture.workers.filter(event => event.msg !== 'setup.subscriber_started' || event.time === stamp(1)); },
    fixture => { fixture.workers = fixture.workers.filter(event => event.msg !== 'worker.supervision_started'); },
    ({ workers }) => { workers.find(event => event.msg === 'worker.connected').connection_id = 'wrong-generation'; },
    ({ workers }) => { workers.push({ msg: 'setup.assets', worker_id: 'worker-a', time: stamp(605) }); },
    ({ workers }) => { workers.find(event => event.operation_id === 'operation-recovery-worker').connection_generation = 1; },
  ]) {
    const fixture = productFixture(true); change(fixture);
    assert.throws(() => recoveryBoundary(fixture.report, 'recovery.worker', fixture.workers, { item: fixture.report.cases.find(item => item.id === 'recovery.worker') }));
  }
  const fixture = productFixture(true); fixture.report.observations.find(entry => entry.kind === 'refresh_approval').owner = false;
  assert.throws(() => recoveryBoundary(fixture.report, 'recovery.refresh', fixture.workers, { probe: false }), /approved_scoped_refresh_sequence_required/);
});
