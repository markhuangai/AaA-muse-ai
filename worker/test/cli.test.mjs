import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import { execute, argumentsFor, VERSION } from '../dist/cli.js';
import { fixture, CODE, KEY, JOB, EXP, claimed } from './helpers.mjs';

const archivePin = 'a'.repeat(64);
function adapters(f, changes = {}) {
  const network = { ...f.net, fetch: async (url, options) => {
    assert(new URL(url).pathname.startsWith('/api/v1/worker/hook/'));
    const response = await f.net.fetch(url.replace('/api/v1/worker/hook/', '/api/v1/worker/'), options);
    response.headers.set('X-Muse-Paired-Worker-SHA256', archivePin);
    return response;
  } };
  return { files: fs, system: f.state.sys, network, env: {}, home: () => f.state.root, nodeVersion: process.version, input: async () => CODE, stdout: line => f.stdout.push(line), stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit', source_dirty: true }), ...changes };
}

async function nativeBrief(f, changes = {}) {
  const brief = claimed({ connection_id: '', connection_generation: 0, ...changes });
  await f.state.write('cron-claim.json', JSON.stringify({ job_id: JOB, operation_id: EXP, claim_id: brief.lease_id, launch_id: 'launch', generation: 1, brief }));
  return brief;
}
test('CLI validates options and runtime without echoing unknown argument values', async t => {
  const f = await fixture(t); f.stdout = [];
  const io = adapters(f);
  assert.equal(await execute([], io), 0); assert.match(f.stdout.pop(), /diagnostics-export/);
  assert.equal(await execute(['--version'], io), 0); assert.equal(f.stdout.pop().trim(), VERSION);
  assert.equal(await execute(['status', '--help'], io), 0);
  for (const args of [['unknown', KEY], ['status', '--unexpected', KEY], ['status', 'bare'], ['configure', '--origin'], ['status', '--state-dir', 'x', '--state-dir', 'y']]) {
    assert.equal(await execute(args, io), 1); assert(!f.output.at(-1).includes(KEY));
  }
  assert.equal(await execute(['status'], adapters(f, { nodeVersion: 'v22.11.0' })), 1);
  assert.equal(await execute(['status'], adapters(f, { env: { XDG_STATE_HOME: 'relative' } })), 1);
  assert.equal(argumentsFor(['enroll', '--code-stdin']).flags['code-stdin'], true);
});

test('CLI runs configure, enrollment, context, decision, status, doctor and export with real state logic', async t => {
  const f = await fixture(t); f.stdout = [];
  const io = adapters(f);
  await f.state.write('installation.json', JSON.stringify({ package_sha256: archivePin }));
  const run = (...args) => execute([args[0], '--state-dir', f.state.root, ...args.slice(1)], io);
  assert.equal(await run('configure', '--origin', 'https://broker.example.test'), 0);
  assert.equal(await run('enroll', '--code-stdin'), 0);
  assert.equal(await run('status'), 0); assert.equal(await run('doctor'), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)).muse_runtime, 'unverified');
  assert.equal(JSON.parse(f.stdout.at(-1)).inference_readiness, JSON.parse(f.stdout.at(-1)).worker.inference_readiness);
  f.broker.override = call => call.path.endsWith('/status') ? new Response(JSON.stringify({ id: 'a'.repeat(32), inference_readiness: 'verified', qualification: { evidence: { evidence_kind: 'controlled' } } }), { status: 200 }) : undefined;
  assert.equal(await run('status'), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)).inference_readiness, 'verified');
  assert.equal(JSON.parse(f.stdout.at(-1)).worker.qualification.evidence.evidence_kind, 'controlled');
  f.broker.override = undefined;
  const brief = await nativeBrief(f);
  f.broker.jobs.set(JOB, brief);
  io.input = async () => '{"type":"final","text":"answer"}';
  assert.equal(await run('decision-submit', '--job-id', JOB, '--input', '-'), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)).claim_id, brief.lease_id);
  assert.equal(await run('diagnostics-export', '--decode', '--operation-id', 'd'.repeat(32)), 0);
  const records = f.stdout.at(-1).trimEnd().split('\n').map(JSON.parse); assert.equal(records[0].type, 'export'); assert(records.some(e => e.msg === 'worker.decision_input'));
  assert.equal(await run('diagnostics-export', '--request-id', 'missing', '--since', '2000-01-01T00:00:00Z', '--until', '2100-01-01T00:00:00Z'), 0);
  for (const command of [['configure'], ['enroll'], ['job-show'], ['run'], ['decision-submit'], ['decision-submit', '--job-id', JOB, '--input', '-', '--ack-idle']]) assert.equal(await run(...command), 1);
  assert(!f.stdout.join('').includes(KEY)); assert(!f.output.join('').includes(KEY));
  await fs.chmod(f.state.path('credential.key'), 0o644);
  assert.equal(await run('doctor'), 1); assert.equal(JSON.parse(f.output.at(-1)).msg, 'worker.state_unsafe');
  await fs.chmod(f.state.root, 0o755);
  assert.equal(await run('doctor'), 1); assert.equal(JSON.parse(f.output.at(-1)).protected_capture_unavailable, true); await fs.chmod(f.state.root, 0o700);
});

test('shipped main executes with real process adapters, signals, stdin and files', async t => {
  const f = await fixture(t);
  const binary = fileURLToPath(new URL('../dist/main.js', import.meta.url));
  const call = (args, input) => spawnSync(process.execPath, [binary, ...args], { input, encoding: 'utf8', env: { ...process.env, XDG_STATE_HOME: f.state.root } });
  assert.equal(call(['--version']).stdout.trim(), VERSION);
  assert.equal(call(['configure', '--origin', 'https://example.test']).status, 0);
  const result = call(['enroll', '--code-stdin'], 'invalid'); assert.equal(result.status, 1); assert(!result.stderr.includes('invalid\n'));
  const inputFile = f.state.path('input.json'); await f.state.write('input.json', '{}');
  assert.equal(call(['decision-submit', '--job-id', JOB, '--input', inputFile]).status, 1);
  assert.equal(call(['decision-submit', '--job-id', JOB, '--input', f.state.path('missing')]).status, 1);
  assert.equal(call(['enroll', '--code-stdin'], 'x'.repeat(1024 * 1024 + 1)).status, 1);
});

test('overlapping CLI decision commands reuse one journal and reject conflicting input before transport', async t => {
  const f = await fixture(t); f.stdout = [];
  await f.worker.configure('https://broker.example.test'); await f.worker.enroll(CODE);
  const brief = await nativeBrief(f);
  await f.state.write('installation.json', JSON.stringify({ package_sha256: archivePin }));
  f.broker.jobs.set(JOB, brief);
  const input = '{"type":"final","text":"same decision with exact identity"}';
  let release, reached;
  const blocked = new Promise(done => { release = done; });
  const entered = new Promise(done => { reached = done; });
  let firstRequest = true;
  f.broker.override = async call => {
    if (call.path.endsWith('/decisions') && firstRequest) { firstRequest = false; reached(); await blocked; }
  };
  const args = ['decision-submit', '--state-dir', f.state.root, '--job-id', JOB, '--input', '-'];
  const first = execute(args, adapters(f, { input: async () => input }));
  await entered;
  let conflict, identical;
  try {
    conflict = await execute(args, adapters(f, { input: async () => '{"type":"final","text":"conflicting"}' }));
    identical = await execute(args, adapters(f, { input: async () => input }));
  } finally { release(); }
  assert.equal(await first, 0); assert.equal(identical, 0); assert.equal(conflict, 1);
  const posts = f.broker.calls.filter(c => c.path.endsWith('/decisions'));
  assert.equal(posts.length, 1);
  const results = f.stdout.map(JSON.parse);
  assert(results.every(result => result.claim_id === brief.lease_id));
  assert.deepEqual(results.map(result => result.outcome), ['recovery_pending', 'accepted']);
  assert.equal(results[0].cause, 'result_delivery_active');
  const journals = await f.state.child('journals');
  const pointer = JSON.parse(await journals.read('decision-' + JOB + '.json'));
  const saved = JSON.parse(await journals.read('operation-' + pointer.submission_id + '.json'));
  assert.equal(saved.state, 'accepted'); assert.equal(saved.body, posts[0].options.body);
  assert.equal((await f.state.read('credential.key')).trim(), KEY);
});

test('CLI delivers authorized background task text and records a pre-start abort', async t => {
  const f = await fixture(t); f.stdout = [];
  const workerID = 'a'.repeat(32);
  const hookID = 'aaa-muse-worker-' + workerID;
  const io = adapters(f);
  const run = (...args) => execute([args[0], '--state-dir', f.state.root, ...args.slice(1)], io);
  const lease = { id: JOB, operation_id: JOB, claim_id: 'task-claim', generation: 1, checker_job_id: hookID,
    launch_id: 'launch', wake_invocation_id: 'task-invocation', wake_attempted_at: new Date().toISOString() };
  const due = new Date(Date.now() + 90_000).toISOString();
  await f.state.write('config.json', JSON.stringify({ protocol_version: 1, origin: 'https://broker.example.test', worker_id: workerID }));
  await f.state.write('credential.key', KEY);
  await f.state.write('installation.json', JSON.stringify({ worker_id: workerID, package_sha256: archivePin, launcher: '/fixture/worker', detector: '/fixture/detector.sh' }));
  await f.state.write('hook-installation.json', JSON.stringify({ worker_id: workerID, hook_id: hookID, watchdog_job_id: 'watchdog' }));
  await f.state.write('hook-task.json', JSON.stringify(lease));
  f.broker.override = call => {
    if (call.path.endsWith('/start')) return Response.json({ id: JOB, worker_id: workerID, state: 'running',
      claim: { claim_id: lease.claim_id, generation: lease.generation }, prompt: 'Use the scoped fixture', started_at: new Date().toISOString(), deadline_at: due });
    if (call.path.endsWith('/result')) return Response.json({ id: JOB, held: true, state: 'completed' });
  };
  assert.equal(await run('hook-upgrade-describe', '--worker-id', workerID, '--goal-id', 'goal'), 0);
  assert(JSON.parse(f.stdout.at(-1)).hook.prompt.includes('hook-task-start'));
  assert.equal(await run('hook-task-start', '--launch-id', 'launch', '--run-id', 'event-hook:task-invocation'), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)).prompt, 'Use the scoped fixture');
  io.input = async () => '{"result_text":"finished from the controlled brief","summary":"done"}';
  assert.equal(await run('hook-task-finish', '--task-id', JOB, '--input', '-'), 0);
  const delivered = JSON.parse(await f.state.read('hook-task.json'));
  assert.equal(delivered.pending_result.result_text, 'finished from the controlled brief');
  assert.equal(delivered.failure.reason, 'execution_confirmed_stopped');
  await f.state.write('hook-task.json', JSON.stringify(lease));
  assert.equal(await run('hook-task-abort', '--launch-id', 'launch', '--run-id', 'event-hook:task-invocation',
    '--reason', 'execution_failed', '--summary', 'controlled abort'), 0);
  assert.equal(JSON.parse(await f.state.read('hook-task.json')).failure.reason, 'execution_confirmed_stopped');
});
