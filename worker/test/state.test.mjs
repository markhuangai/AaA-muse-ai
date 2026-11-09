import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { State, system } from '../dist/state.js';
import { fixture } from './helpers.mjs';

test('real protected files, atomic replacement and unsafe-entry checks', async t => {
  const f = await fixture(t);
  await f.state.write('value.json', 'original');
  assert.equal(await f.state.read('value.json'), 'original');
  await f.state.write('value.json', 'replacement');
  assert.equal(await f.state.read('value.json'), 'replacement');
  assert.equal((await fs.stat(f.state.root)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(f.state.path('value.json'))).mode & 0o777, 0o600);
  assert.equal(await f.state.read('missing'), undefined);
  assert.throws(() => new State('relative')); assert.throws(() => f.state.path('../escape'));
  await fs.chmod(f.state.path('value.json'), 0o644);
  await assert.rejects(f.state.read('value.json'), /state_unsafe/);
  await assert.rejects(f.state.write('value.json', 'unsafe'), /state_unsafe/);
  await fs.chmod(f.state.path('value.json'), 0o600);
  await fs.symlink(f.state.path('value.json'), f.state.path('link'));
  await assert.rejects(f.state.read('link'), /state_unsafe/);
  await fs.link(f.state.path('value.json'), f.state.path('hardlink'));
  await assert.rejects(f.state.read('value.json'), /state_unsafe/);
  await fs.unlink(f.state.path('hardlink'));
  const wrongOwner = new State(f.state.root, fs, { ...system, uid: system.uid + 1 });
  await assert.rejects(wrongOwner.ensure(), /state_unsafe/);
  await assert.rejects(new State(f.state.root, fs, { ...system, uid: -1 }).ensure(), /posix_permissions_required/);
  const fault = new State(f.state.root, { ...fs, rename: async () => { throw Object.assign(new Error(), { code: 'ENOSPC' }); } });
  await assert.rejects(fault.write('value.json', 'lost'));
  assert.equal(await f.state.read('value.json'), 'replacement');
  const huge = await fs.open(f.state.path('large'), 'w', 0o600); await huge.truncate(16 * 1024 * 1024 + 1); await huge.close();
  await assert.rejects(f.state.read('large'), /state_file_too_large/);
  await f.state.remove('value.json'); await f.state.remove('missing');
  await fs.chmod(f.state.root, 0o755); await assert.rejects(f.state.ensure(), /state_unsafe/); await fs.chmod(f.state.root, 0o700);
});

test('locks serialize real mutations and recover only a proven dead owner', async t => {
  const f = await fixture(t);
  const release = await f.state.lock('daemon', false);
  await assert.rejects(f.state.lock('daemon', false), /subscriber_already_running/);
  await release();
  const seen = [];
  await Promise.all(Array.from({ length: 8 }, (_, i) => f.state.withLock('serial', async () => {
    seen.push(i); await f.state.write('counter', String(seen.length));
  })));
  assert.equal(seen.length, 8); assert.equal(await f.state.read('counter'), '8');
  const directory = await f.state.child('dead.lock');
  await directory.write('owner.json', '{"pid":2147483646,"owner":"dead"}');
  const recovered = await f.state.lock('dead', false); await recovered();
  const missing = await f.state.child('ambiguous.lock');
  await assert.rejects(f.state.lock('ambiguous', false), /subscriber_already_running/);
  await missing.write('owner.json', '{"pid":0,"owner":"bad"}');
  await assert.rejects(f.state.lock('ambiguous', false), /lock_owner_ambiguous/);
  await directory.ensure(); await directory.write('owner.json', '{"pid":2147483646,"owner":"dead"}');
  await f.state.child('recovery.lock');
  await assert.rejects(f.state.lock('dead', false), /lock_recovery_ambiguous/);
  const changed = await f.state.lock('changed', false);
  const owner = await f.state.child('changed.lock'); await owner.write('owner.json', '{"pid":1,"owner":"different"}');
  await assert.rejects(changed(), /lock_owner_changed/);
  assert.equal(typeof system.alive(process.pid), 'boolean'); assert.equal(system.alive(2147483646), false); await system.wait(1);
});

test('a concurrent atomic replacement preserves an already opened private snapshot', async t => {
  const f = await fixture(t);
  await f.state.write('snapshot', 'old');
  let replaced = false;
  const racing = new State(f.state.root, { ...fs, open: async (path, flags, ...rest) => {
    const handle = await fs.open(path, flags, ...rest);
    if (path === f.state.path('snapshot') && flags === (constants.O_RDONLY | constants.O_NOFOLLOW) && !replaced) {
      replaced = true;
      await f.state.write('snapshot', 'new');
      assert.equal((await handle.stat()).nlink, 0);
    }
    return handle;
  } }, f.state.sys);
  assert.equal(await racing.read('snapshot'), 'old');
  assert.equal(await f.state.read('snapshot'), 'new');
});
