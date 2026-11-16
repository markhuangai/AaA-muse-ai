import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeTurnObserved } from './native-proof.mjs';
import { backgroundTurn } from './test/native-proof-fixture.mjs';
import { completeFixture } from './qualification-fixtures.mjs';
import { inspectCase } from './qualification-case.mjs';
import { validateReport } from './qualification-report.mjs';
import { productFixture } from './test/product-fixture.mjs';
import { validateProductReport } from './product-report.mjs';

function receipt() {
  const entry = { job_id: 'job', worker_id: 'worker' }, events = [{ msg: 'worker.context', worker_id: 'worker', job_id: 'job' }];
  const decision = { type: 'final', text: 'observed answer' };
  return { entry: backgroundTurn(entry, events, 1, decision), events, decision };
}

function backgroundCase(report, evidence, item) {
  const events = evidence.find(ref => ref.source === 'worker' && ref.case_id === item.id).events;
  const broker = evidence.find(ref => ref.source === 'broker' && ref.case_id === item.id).events;
  const entries = report.observations.filter(entry => entry.kind === 'model_turn' && entry.case_id === item.id);
  entries.forEach((entry, index) => {
    const first = item.observed.messages[item.request.messages.length];
    const decision = index === 0 && first?.type === 'tool_call' ? first : { type: 'final', text: item.observed.final_text };
    broker.push({ ...broker.find(event => event.msg === 'decision.accepted' && event.job_id === entry.job_id), msg: 'inference.decision', decision });
    backgroundTurn(entry, events, index + 1, decision);
  });
  return entries;
}

test('background proof uses native execution receipts and keeps conversations absent', () => {
  const { entry, events, decision } = receipt();
  assert.equal(entry.native_conversation_id, null);
  assert.equal(nativeTurnObserved(entry, events, decision), true);
  entry.native_invocation_id = 'event-hook:' + entry.native_invocation_id;
  assert.equal(nativeTurnObserved(entry, events, decision), true);
  for (const status of ['completed_notified', 'completed_noop']) for (const agentStatus of ['shutdown', 'completed']) {
    entry.native_execution.status = status; entry.native_execution.agent_status = agentStatus;
    assert.equal(nativeTurnObserved(entry, events, decision), true);
    assert.equal(nativeTurnObserved(entry, events.slice(0, -1), decision), false);
  }
  assert.equal(nativeTurnObserved({ native_conversation_id: 'observed-conversation' }), true);
  assert.equal(nativeTurnObserved(), false);
});

test('wake-only, contradictory, incomplete and foreign command receipts cannot qualify a native turn', () => {
  const mutations = [
    e => { delete e.native_execution; }, e => { delete e.native_conversation_id; }, e => { e.native_conversation_id = 'delivery-target'; },
    e => { e.native_execution.kind = 'hook_wake'; }, e => { e.native_execution.agent_id = 'not-a-native-agent'; },
    e => { e.native_execution.status = 'running'; }, e => { e.native_execution.agent_status = 'running'; },
    e => { e.native_execution.session_id = 'undocumented-session'; }, e => { e.native_execution.source_ref = ''; },
    e => { e.worker_id = ''; }, e => { e.job_id = ''; }, e => { e.native_invocation_id = 7; },
    e => { e.native_invocation_id = 'wake-without-run'; }, e => { e.native_execution.run_id = 'event-hook:foreign'; },
    e => { e.native_execution.commands = null; }, e => { e.native_execution.commands.pop(); },
    e => { e.native_execution.commands[0] = null; }, e => { e.native_execution.commands[1].action = 'job-show'; },
    e => { delete e.context_command_id; }, e => { e.decision_command_id = e.context_command_id; },
    e => { e.native_execution.commands[0].agent_id = 'foreign-agent'; }, e => { e.native_execution.commands[0].job_id = 'foreign-job'; },
    e => { e.native_execution.commands[0].command_id = 'foreign-command'; }, e => { e.native_execution.commands[0].call_id = ''; },
    e => { e.native_execution.commands[0].tool_call_item_id = 0; }, e => { e.native_execution.commands[0].tool_output_item_id = 0; },
    e => { e.native_execution.commands[0].call_names_job_id = false; }, e => { e.native_execution.commands[0].output_success = false; },
    e => { e.native_execution.commands[0].worker_command_id_matches_captured = false; },
    e => { e.native_execution.commands[1].call_id = e.native_execution.commands[0].call_id; },
    e => { e.native_execution.commands[1].tool_output_item_id = e.native_execution.commands[0].tool_call_item_id; },
  ];
  for (const [index, change] of mutations.entries()) {
    const { entry, events, decision } = receipt(); change(entry);
    assert.equal(nativeTurnObserved(entry, events, decision), false, 'mutation ' + index);
  }
  const { entry, events, decision } = receipt();
  assert.equal(nativeTurnObserved(entry, null, decision), false);
  assert.equal(nativeTurnObserved(entry), false);
  assert.equal(nativeTurnObserved(entry, events), false);
  assert.equal(nativeTurnObserved(entry, events, { type: 'unsupported' }), false);
  assert.equal(nativeTurnObserved(entry, events, { type: 'final', text: 'different accepted decision' }), false);
  for (const event of events) {
    const other = structuredClone(events); other.splice(events.indexOf(event), 1);
    assert.equal(nativeTurnObserved(entry, other, decision), false);
  }
  for (const change of [e => { e.worker_id = 'foreign'; }, e => { e.job_id = 'foreign'; }, e => { e.command_id = 'foreign'; }, e => { e.input_complete = false; }, e => { delete e.input; }]) {
    const other = structuredClone(events); change(other[1]); assert.equal(nativeTurnObserved(entry, other, decision), false);
  }
  const other = structuredClone(events); other[2].operation = 'claim'; assert.equal(nativeTurnObserved(entry, other, decision), false);
  assert.equal(nativeTurnObserved(entry, [null, ...events], decision), true);
});

test('real qualification logic accepts witnessed background tool turns without inventing conversations', () => {
  const { report, evidence } = completeFixture(), item = report.cases.find(c => c.id === 'trial-1');
  const entries = backgroundCase(report, evidence, item);
  assert.deepEqual(inspectCase(item, report, evidence).missing, []);
  assert.deepEqual(inspectCase(item, report, evidence).failed, []);
  entries[0].native_execution.commands[1].agent_id = 'foreign';
  assert.ok(inspectCase(item, report, evidence).missing.includes('trial-1:native_model_turn'));
});

test('background identities do not prove a shared delta base or a fresh native conversation', () => {
  for (const id of ['delta', 'replay']) {
    const { report, evidence } = completeFixture(), item = report.cases.find(c => c.id === id);
    backgroundCase(report, evidence, item);
    if (id === 'replay') report.observations.find(entry => entry.kind === 'fresh_conversation').native_conversation_id = null;
    const result = inspectCase(item, report, evidence);
    assert.ok(result.missing.includes(id === 'delta' ? 'delta:delta_native_base' : 'replay:fresh_native_conversation'));
    if (id === 'delta') {
      report.context_strategy.delta = 'rejected_candidate';
      const assessment = validateReport(report, evidence);
      assert.equal(assessment.observed_result, 'inconclusive');
      assert.ok(assessment.missing.includes('delta:delta_native_base'));
    }
  }
});

test('product validation requires the same native receipt chain for JSON, SSE and retry turns', () => {
  for (const id of ['a.chat.json', 'a.chat.sse', 'a.responses.json', 'a.responses.sse']) {
    const { report, evidence, workers, broker } = productFixture(true), item = report.cycles.find(c => c.id === id);
    const selected = report.observations.filter(entry => entry.kind === 'model_turn' && entry.case_id === item.id);
    report.observations = report.observations.filter(entry => !selected.includes(entry));
    [...new Map(selected.map(entry => [entry.job_id, entry])).values()].forEach((entry, index) => report.observations.push(backgroundTurn(entry, workers, index + 1, broker.find(event => event.msg === 'inference.decision' && event.job_id === entry.job_id).decision)));
    assert.equal(validateProductReport(report, evidence).verdict, 'pass');
    const entry = report.observations.find(entry => entry.native_execution);
    entry.native_execution.commands[1].worker_command_id_matches_captured = false;
    assert.ok(validateProductReport(report, evidence).missing.includes(item.id + ':native_model_turn'));
  }
});
