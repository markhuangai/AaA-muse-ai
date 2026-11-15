import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { cycle, ProductProtocol } from '../../tools/product-protocol.mjs';
import { need } from '../../tools/qualification-evidence.mjs';

const fixture = JSON.parse(readFileSync(process.argv[process.argv.indexOf('--fixture') + 1], 'utf8'));
const output = { outcome: 'failed', cases: [], cycles: [] };
const save = () => writeFileSync(join(fixture.directory, `product-client-${fixture.phase}-receipt.json`), JSON.stringify(output), { mode: 0o600 });
const driver = new ProductProtocol({ origin: fixture.origin, keys: fixture.keys,
  readFixture: async path => readFileSync(path, 'utf8'), save: async () => save() });
async function api(path, body) {
  const response = await fetch(fixture.origin + path, { method: body ? 'POST' : 'GET', redirect: 'error', headers: { Authorization: fixture.admin, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
  need(response.ok, 'product_management_failed');
  return response;
}
async function select(slot, retainApproval = false) {
  const { workers } = await (await api('/api/v1/admin/workers')).json();
  if (retainApproval) need(workers.some(worker => worker.id === fixture.workers.find(value => value.slot === slot).worker_id && worker.inference_readiness === 'verified' && worker.qualification?.evidence.action === 'approve'), 'retained_worker_approval_required');
  for (const worker of fixture.workers) {
    const approve = worker.slot === slot || slot === 'all', current = workers.find(value => value.id === worker.worker_id);
    if (approve && current?.inference_readiness === 'verified' || !approve && current?.qualification?.evidence.action === 'withdraw') continue;
    await api(`/api/v1/admin/workers/${worker.worker_id}/qualifications`, {
      protocol_version: 1, submission_id: randomUUID(), action: approve ? 'approve' : 'withdraw', evidence_kind: 'controlled',
      evidence_reference: 'Packed installer/subscriber controlled software flow; no live Muse qualification.',
      ...(approve ? worker.qualification : {}),
    });
  }
}
function make(id, slot, protocol = 'chat', stream = false) {
  const item = cycle({ id, slot, protocol, stream, fixture: fixture.fixtures[id], session: 'product-' + randomUUID() });
  output.cycles.push(item); return item;
}
async function capture(item) {
  const captured = await driver.correlate(item, async path => {
    const response = await api(path); return path.includes('/diagnostics/export') ? response.text() : response.json();
  });
  if (item.id !== 'replacement') need(captured.worker_ids.length === 1 && captured.worker_ids[0] === fixture.workers.find(worker => worker.slot === item.slot).worker_id, 'product_wrong_worker');
  return captured;
}
try {
  if (fixture.phase === 'matrix') {
    for (const slot of ['a', 'b']) {
      await select(slot);
      for (const protocol of ['chat', 'responses']) for (const stream of [false, true]) {
        const id = `${slot}.${protocol}.${stream ? 'sse' : 'json'}`, item = make(id, slot, protocol, stream);
        await driver.start(item); await driver.finish(item);
        await driver.followup(item, 'affinity-' + id);
        output.cases.push(await capture(item));
      }
    }
    const a = make('interleave-a', 'a'), b = make('interleave-b', 'b', 'responses', true);
    await select('a'); await driver.start(a);
    await select('b'); await driver.start(b);
    await select('all');
    await driver.finish(b); await driver.finish(a);
    const captured = await Promise.all([capture(a), capture(b)]);
    need(captured[0].conversation_id !== captured[1].conversation_id && captured[0].session_id !== captured[1].session_id, 'product_sessions_joined');
    output.cases.push({ id: 'sessions.interleaved', outcome: 'passed', cycles: captured });
    output.cases.push({ id: 'sessions.affinity', outcome: 'passed', request_ids: output.cycles.flatMap(item => item.turns.map(turn => turn.request_id)) });
    output.cases.push({ id: 'sessions.isolation', outcome: 'passed', cycles: captured });
    const boundary = await driver.rejectOtherClient(b);
    output.cases.push({ id: 'boundary.cross-client', outcome: 'passed', ...boundary });
  } else if (fixture.phase === 'prepare-restart') {
    await select('a');
    const item = make('restart', 'a'); await driver.start(item);
    await select('all');
    output.cases.push(await capture(item));
  } else if (fixture.phase === 'resume-restart') {
    const item = fixture.cycle; output.cycles.push(item);
    await driver.finish(item); output.cases.push({ ...await capture(item), id: 'recovery.broker-tool-wait' });
  } else if (fixture.phase === 'worker-recovery') {
    await select('b', true);
    const item = make('worker-probe', 'b'); await driver.start(item); await driver.finish(item);
    output.cases.push({ ...await capture(item), id: 'recovery.worker' });
  } else if (fixture.phase === 'replacement') {
    const item = fixture.cycle; item.replay_source_case_id = item.id; item.measured_from_turn = item.turns.length; item.id = 'replacement'; item.started_at = new Date().toISOString(); item.followup = undefined; output.cycles.push(item);
    await driver.followup(item, 'replacement-full-history');
    const captured = await capture(item);
    need(captured.worker_ids.length === 2, 'product_replacement_did_not_move');
    const last = item.turns.at(-1), detail = await (await api('/api/v1/admin/requests/' + last.operation_id)).json();
    const messages = detail.delivery.messages;
    need(detail.delivery.kind === 'full' && messages.some(message => message.type === 'tool_call' && message.call_id === item.call_id) && messages.some(message => message.type === 'tool_result' && message.call_id === item.call_id && message.output === item.fixture.contents), 'product_replacement_lost_history');
    output.cases.push({ ...captured, id: 'recovery.replacement-full-history', full_history: true, accepted_call_id: item.call_id });
  } else throw new Error('invalid_product_client_phase');
  output.outcome = 'passed'; save();
} catch (error) {
  output.cause = /^[a-z0-9_]+$/.test(error.message) ? error.message : 'product_client_failed'; save(); process.exitCode = 1;
}
