import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { openSync, closeSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { setupIO, backgroundStderr } from '../dist/setup-os.js';
import { fixture, until } from './helpers.mjs';

test('production process adapter uses real native runtime output and rejects errors', async t => {
  const f = await fixture(t); const io = setupIO(f.state.root);
  assert.match(await io.asset('SKILL.md'), /client-tool/);
  const runtime = f.state.path('runtime.sh');
  await f.state.write('runtime.sh', 'wake(){ printf "wake:%s\\n" "$1"; }; silent(){ printf "silent:%s\\n" "$1"; };\n');
  assert.equal(await io.emit(runtime, 'wake', 'exact message'), 'wake:exact message\n');
  assert.equal(await io.emit(runtime, 'silent', 'idle'), 'silent:idle\n');
  await assert.rejects(io.emit(f.state.path('missing'), 'wake', 'message'), /hook_runtime_failed/);
  await assert.rejects(io.launch(f.state, 'relative', '/main.js'), /absolute_launch_paths_required/);
  const child = f.state.path('child.mjs');
  await f.state.write('child.mjs', 'setInterval(()=>{},1000);\n');
  const pid = await io.launch(f.state, process.execPath, child);
  assert.equal(f.state.sys.alive(pid), true);
  process.kill(pid, 'SIGTERM');
  await until(() => f.state.sys.alive(pid) === false);
  await assert.rejects(io.launch(f.state, '/not-a-runtime', child), /subscriber_launch_failed/);
  const hook = (await io.asset('hook.sh')).replaceAll('@LAUNCHER@', "'/does-not-exist'").replaceAll('@STATE@', "'/does-not-exist'");
  const path = f.state.path('hook.sh'); await f.state.write('hook.sh', hook, 0o700);
  const before = (await fs.readdir(f.state.root)).sort();
  const result = spawnSync('bash', [path], { encoding: 'utf8', env: { ...process.env, HATCH_HOOK_RUNTIME: runtime, HATCH_HOOK_DRY_RUN: '1' } });
  assert.equal(result.status, 0); assert.match(result.stdout, /Dry run/);
  assert.deepEqual((await fs.readdir(f.state.root)).sort(), before);
  assert.equal(spawnSync('bash', [path, 'argument'], { encoding: 'utf8' }).status, 1);
  assert.equal(spawnSync('bash', [path], { env: { PATH: process.env.PATH, HATCH_HOOK_DRY_RUN: '1' }, encoding: 'utf8' }).status, 1);
  await f.state.write('runtime.sh', 'silent(){ :; };\n');
  assert.equal(spawnSync('bash', [path], { env: { ...process.env, HATCH_HOOK_RUNTIME: runtime, HATCH_HOOK_DRY_RUN: '1' }, encoding: 'utf8' }).status, 1);
});

test('background stderr is private and bounded while full events remain in protected capture', async t => {
  const f = await fixture(t); const path = join(f.state.root, 'background.log');
  const fd = openSync(path, 'wx+', 0o600);
  try {
    backgroundStderr('a'.repeat(60000), fd);
    backgroundStderr('b'.repeat(10000), fd);
    assert(statSync(path).size <= 65536); assert.match(readFileSync(path, 'utf8'), /setup.stderr_rotated/);
    backgroundStderr('x'.repeat(70000), fd);
    assert(statSync(path).size <= 65536); assert.match(readFileSync(path, 'utf8'), /setup.stderr_payload_omitted/);
    for (let i = 0; i < 10; i++) backgroundStderr('z'.repeat(10000), fd);
    assert(statSync(path).size <= 65536);
    await fs.chmod(path, 0o644);
    assert.throws(() => backgroundStderr('unsafe', fd), /background_stderr_unsafe/);
  } finally { closeSync(fd); }
});
