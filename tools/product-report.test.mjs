import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productFixture } from './test/product-fixture.mjs';
import { validateProductReport, flowCases, liveCases } from './product-report.mjs';
import { validateReport } from './qualification-report.mjs';
import { main } from './qualify.mjs';

test('complete product evidence accounts for every case and keeps controlled success separate from live verdict', () => {
  for (const live of [false, true]) {
    const { report, evidence } = productFixture(live), result = validateReport(report, evidence);
    assert.deepEqual(result.errors, []); assert.deepEqual(result.missing, []);
    assert.equal(result.observed_result, 'pass'); assert.equal(result.verdict, live ? 'pass' : 'inconclusive');
    assert.equal(result.cases.length, (live ? liveCases : flowCases).length);
  }
});

test('product validation rejects omitted cases, substituted artifacts and unsupported nominal passes', () => {
  const mutations = [
    r => { r.cases.pop(); }, r => { r.cycles.pop(); }, r => { r.cycles[0].turns.pop(); },
    r => { r.source.worker_version = '0.2.0'; }, r => { r.source.image_digest = 'latest'; },
    r => { r.status_receipt.build.worker_package.sha256 = 'f'.repeat(64); }, r => { r.workers[1].account_ref = r.workers[0].account_ref; },
    r => { r.workers[0].installed_sha256 = undefined; }, r => { r.cycles[0].client_tool_executions = 2; },
    r => { r.cycles[0].call_id = 'foreign-call'; }, r => { r.cycles[0].fixture.owner = 'muse_vm'; },
    r => { r.cycles[0].turns[1].value.choices[0].message.content = 'invented'; },
    r => { r.cycles[0].result_body.messages.at(-1).tool_call_id = 'foreign'; },
    r => { r.cycles[0].initial_body.messages[1].content += r.cycles[0].fixture.contents; },
    r => { r.cycles[0].turns[1].job_id = 'missing-job'; }, r => { r.cycles[0].turns[2].operation_id = 'regenerated'; },
    r => { r.cycles[0].turns[0].finished_at = 'invalid'; }, r => { r.cycles[0].turns[0].worker_id = 'worker-b'; },
    r => { r.cycles[0].turns[0].session_id = 'foreign'; }, r => { r.cycles[0].turns[0].conversation_id = 'other'; },
    r => { r.cycles[0].turns[0].finished_at = new Date(Date.parse(r.cycles[0].turns[0].started_at) + 300000).toISOString(); },
    r => { r.cycles[0].protocol = 'responses'; }, r => { r.cycles[0].stream = true; },
    r => { r.cycles[1].fixture.path = r.cycles[0].fixture.path; },
    r => { r.cycles.push(structuredClone(r.cycles[0])); }, r => { r.cases.push(r.cases[0]); }, r => { r.cases[0].id = 'unknown'; },
    r => { r.cases.find(item => item.id === 'recovery.tool-dedup').client_tool_executions = 2; },
    r => { r.cases.find(item => item.id === 'recovery.replacement-full-history').full_history = false; },
    r => { r.cycles.find(item => item.id === 'interleave-b').session_id = r.cycles.find(item => item.id === 'interleave-a').session_id; },
    r => { r.cycles[0].followup.marker = 'incorrect'; }, r => { r.exports.push({ source: 'broker', file: 'absent.ndjson' }); },
  ];
  for (const [index, change] of mutations.entries()) {
    const { report, evidence } = productFixture(); change(report); report.verdict = 'pass';
    const result = validateReport(report, evidence);
    assert.notEqual(result.observed_result, 'pass', 'mutation ' + index); assert.equal(result.valid, false, 'mutation ' + index);
  }
  assert.equal(validateProductReport({}, []).valid, false);
  const broken = productFixture(); broken.report.cycles[0].turns = null;
  assert.equal(validateReport(broken.report, broken.evidence).valid, false);
});

test('native qualification needs independently observed accounts, current artifacts, wake and recovery provenance', () => {
  const changes = [
    r => { r.status_receipt.build.dirty = true; }, r => { r.observations = []; },
    r => { r.observations = r.observations.filter(entry => entry.kind !== 'model_turn'); },
    r => { r.observations = r.observations.filter(entry => entry.kind !== 'quiet_window'); },
    r => { r.observations.find(entry => entry.kind === 'setup_ended').worker_version = '0.1.0-rc.6'; },
    r => { r.observations.find(entry => entry.kind === 'refresh_approval').owner = false; },
    r => { r.observations.find(entry => entry.kind === 'refresh_reconnected').reenrolled = true; },
    r => { r.checkpoints.broker.after_instance = r.checkpoints.broker.before_instance; },
    r => { r.observations.push({ kind: 'intervention', time: r.cycles[0].started_at, observer: 'owner', source_ref: 'actual-manual-message' }); },
    r => { r.observations[0].source_ref = ''; },
    r => { r.evidence_import_failures = [{ source: 'worker', case_id: 'all', cause: 'capture_incomplete' }]; },
  ];
  for (const change of changes) {
    const { report, evidence } = productFixture(true); change(report);
    const result = validateReport(report, evidence);
    assert.notEqual(result.observed_result, 'pass'); assert.equal(result.valid, false);
  }
});

test('authenticated archives must contain the exact tools, canonical history and accepted client result', () => {
  for (const change of [
    fixture => { fixture.broker.find(event => event.msg === 'inference.context').context.tools = []; },
    fixture => { fixture.broker.find(event => event.msg === 'inference.context').context.messages.pop(); },
    fixture => { fixture.broker.find(event => event.msg === 'inference.context').context.messages.push({ type: 'message', role: 'user', text: 'sibling session data' }); },
    fixture => { fixture.broker.find(event => event.msg === 'inference.decision').decision.arguments.path = 'wrong-vm-path'; },
    fixture => { fixture.broker.find(event => event.msg === 'inference.decision' && event.decision.type === 'final').decision.text = 'invented'; },
    fixture => { fixture.broker.find(event => event.msg === 'inference.decision').canonical_messages = []; },
    fixture => { fixture.broker.find(event => event.msg === 'chat.input').input = {}; },
    fixture => { fixture.broker.find(event => event.msg === 'chat.accepted_decision').decision = { type: 'final', text: 'wrong' }; },
    fixture => { fixture.broker.find(event => event.msg === 'chat.request_admitted').session_id = 'sibling-session'; },
    fixture => { fixture.workers.find(event => event.msg === 'worker.context').context = {}; },
    fixture => { fixture.report.native_cases[0].observed.final_text = 'wrong independent readiness'; },
  ]) {
    const fixture = productFixture(true); change(fixture);
    assert.notEqual(validateReport(fixture.report, fixture.evidence).observed_result, 'pass');
  }
});

test('cross-worker rejection is insufficient evidence for a stale decision fence', () => {
  const fixture = productFixture(true), item = fixture.report.cases.find(item => item.id === 'recovery.stale-result');
  const event = fixture.broker.find(event => event.msg === 'lease.fenced' && event.request_id === item.request_id);
  Object.assign(event, { msg: 'lease.rejected', operation: 'job_read', reason: 'worker_scope_denied' });
  const result = validateReport(fixture.report, fixture.evidence);
  assert.ok(result.missing.includes('recovery.stale-result:correlated_stale_decision_fence'));
});

test('a generic broker restoration and placeholder checkpoint cannot satisfy the tool-wait case', () => {
  const fixture = productFixture(true);
  fixture.report.checkpoints.broker = { before_instance: 'old', after_instance: 'new', pending_call_id: 'accepted-call', completed_request_id: 'final-request' };
  fixture.broker.push({ msg: 'recovery.restored', time: fixture.report.finished_at });
  const result = validateReport(fixture.report, fixture.evidence);
  assert.ok(result.missing.includes('recovery.broker-tool-wait:pending_broker_cycle_required'));
});

test('manual input during the fourth turn invalidates affinity even when the old cycle endpoint predates it', () => {
  const fixture = productFixture(true), item = fixture.report.cycles[0], fourth = item.turns[3];
  item.finished_at = item.turns[2].finished_at;
  fixture.report.observations.push({ kind: 'intervention', time: fourth.started_at, observer: 'owner', source_ref: 'manual-fourth-turn-message' });
  assert.ok(validateReport(fixture.report, fixture.evidence).missing.includes(item.id + ':intervened'));
});

test('captures are mandatory and case failures remain distinct from missing evidence', () => {
  for (const change of [
    refs => refs.splice(0, 1), refs => { refs[0].error = 'capture_incomplete'; }, refs => { refs[0].metadata.complete = false; },
    refs => { refs[1].events = []; }, refs => { refs[0].events = []; },
  ]) {
    const { report, evidence } = productFixture(); change(evidence);
    assert.notEqual(validateReport(report, evidence).observed_result, 'pass');
  }
  const { report, evidence } = productFixture(); report.cases[0].outcome = 'failed';
  const result = validateReport(report, evidence); assert.equal(result.observed_result, 'fail'); assert.equal(result.verdict, 'inconclusive');
  report.finished_at = 'invalid'; assert.equal(validateReport(report, evidence).valid, false);
});

test('CLI completion gate rejects truthful incomplete evidence while historical validation stays available', async t => {
  const directory = await fs.mkdtemp(join(tmpdir(), 'aaa-product-report-'));
  t.after(() => fs.rm(directory, { recursive: true }));
  const { report, files } = productFixture();
  for (const [name, content] of files) await fs.writeFile(join(directory, name), content, { mode: 0o600 });
  const path = join(directory, 'report.json');
  await fs.writeFile(path, JSON.stringify(report), { mode: 0o600 });
  assert.equal(await main(['validate-report', '--report', path, '--synthetic', '--require-complete'], () => {}), 0);
  report.cases.pop(); await fs.writeFile(path, JSON.stringify(report), { mode: 0o600 });
  assert.equal(await main(['validate-report', '--report', path, '--synthetic'], () => {}), 0);
  assert.equal(await main(['validate-report', '--report', path, '--synthetic', '--require-complete'], () => {}), 1);
});
