import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as fs from 'node:fs/promises';
import { execute, argumentsFor, VERSION } from '../dist/cli.js';
import { fixture, CODE, KEY, JOB, claimed } from './helpers.mjs';

function adapters(f, changes = {}) {
  return { files: fs, system: f.state.sys, network: f.net, env: {}, home: () => f.state.root, nodeVersion: process.version, input: async () => CODE, stdout: line => f.stdout.push(line), stderr: line => f.output.push(line), signal: new AbortController().signal, metadata: async () => ({ source_sha: 'unit', source_dirty: true }), ...changes };
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
  const run = (...args) => execute([args[0], '--state-dir', f.state.root, ...args.slice(1)], io);
  assert.equal(await run('configure', '--origin', 'https://broker.example.test'), 0);
  assert.equal(await run('enroll', '--code-stdin'), 0);
  assert.equal(await run('status'), 0); assert.equal(await run('doctor'), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)).muse_runtime, 'unverified');
  f.broker.jobs.set(JOB, claimed());
  f.broker.jobs.get(JOB).context.tools[0].parameters = { type: 'object', properties: { token: { type: 'string' } } };
  assert.equal(await run('job-show', '--job-id', JOB), 0);
  assert.equal(JSON.parse(f.stdout.at(-1)).context.tools[0].parameters.properties.token.type, 'string');
  io.input = async () => '{"type":"final","text":"answer"}';
  assert.equal(await run('decision-submit', '--job-id', JOB, '--input', '-'), 0);
  assert.equal(await run('diagnostics-export', '--decode', '--operation-id', 'd'.repeat(32)), 0);
  const records = f.stdout.at(-1).trimEnd().split('\n').map(JSON.parse); assert.equal(records[0].type, 'export'); assert(records.some(e => e.msg === 'worker.decision_input'));
  assert.equal(await run('diagnostics-export', '--request-id', 'missing', '--since', '2000-01-01T00:00:00Z', '--until', '2100-01-01T00:00:00Z'), 0);
  for (const command of [['configure'], ['enroll'], ['job-show'], ['decision-submit'], ['decision-submit', '--job-id', JOB, '--input', '-', '--ack-idle']]) assert.equal(await run(...command), 1);
  f.broker.jobs.set(JOB, claimed({ state: 'interrupted' }));
  assert.equal(await run('decision-submit', '--job-id', JOB, '--ack-idle'), 0);
  const stopped = new AbortController(); stopped.abort();
  assert.equal(await execute(['run', '--state-dir', f.state.root], adapters(f, { signal: stopped.signal })), 0);
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
  f.broker.jobs.set(JOB, claimed());
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
  assert.equal(posts.length, 2); assert.equal(posts[0].options.body, posts[1].options.body);
  const results = f.stdout.map(JSON.parse); assert.equal(results[0].submission_id, results[1].submission_id);
  const journals = await f.state.child('journals');
  const saved = JSON.parse(await journals.read('operation-' + results[0].submission_id + '.json'));
  assert.equal(saved.state, 'accepted'); assert.equal(saved.body, posts[0].options.body);
  assert.equal((await f.state.read('credential.key')).trim(), KEY);
});
