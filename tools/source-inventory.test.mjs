import assert from 'node:assert/strict';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { componentsFor, inspectSource, isTest } from './source-inventory.mjs';
import { fixture } from './test/helpers.mjs';

test('component inventory includes every production module and activates a tracked portal immediately', () => {
  const inventory = componentsFor(['internal/rules.go', 'internal/rules_test.go', 'worker/src/main.ts', 'worker/test/helpers.mjs', '.github/scripts/policy.mjs', '.github/scripts/policy.test.mjs', 'tools/collect.mjs', 'tools/test/helpers.mjs', 'worker/scripts/build.mjs', 'portal/package.json', 'portal/src/view.tsx']);
  assert.deepEqual(Object.keys(inventory), ['service', 'worker', 'ci-helpers', 'tools', 'worker-scripts', 'portal']);
  assert.deepEqual(inventory.service, ['internal/rules.go']);
  assert.deepEqual(inventory.portal, ['portal/src/view.tsx']);
  assert.deepEqual(componentsFor(['portal/package.json']).portal, []);
  assert.deepEqual(componentsFor(['portal/src/style.css']).portal, []);
  assert(!Object.hasOwn(componentsFor(['worker/src/main.ts']), 'portal'));
  assert(isTest('tests/fixture.js')); assert(isTest('x/__tests__/fixture.mjs'));
  for (const path of ['other/helper.js', 'outside/main.ts']) assert.throws(() => componentsFor([path]), /unowned_production_module/);
});

test('working-source identity binds Git identity, complete bytes and filenames without optional Git locks', t => {
  const f = fixture(t);
  const calls = [];
  const execute = (file, args, options) => { calls.push({ file, args, options }); return f.execute(file, args); };
  const first = inspectSource(f.root, execute);
  assert.equal(first.identity.sha, 'a'.repeat(40)); assert.equal(first.identity.dirty, false);
  assert(calls.every(call => call.file === 'git' && call.args[0] === '--no-optional-locks' && call.options.cwd === f.root));
  writeFileSync(join(f.root, f.paths[0]), 'export const value = 2;\n');
  assert.notEqual(inspectSource(f.root, execute).identity.tree_sha256, first.identity.tree_sha256);
  const beforeMode = inspectSource(f.root, execute).identity.tree_sha256;
  chmodSync(join(f.root, f.paths[0]), 0o700);
  assert.notEqual(inspectSource(f.root, execute).identity.tree_sha256, beforeMode);
  const dirty = (_file, args) => args.includes('status') ? ' M tools/example.mjs\n' : f.execute(_file, args);
  assert.equal(inspectSource(f.root, dirty).identity.dirty, true);
  assert.throws(() => inspectSource(f.root, (_file, args) => args.includes('rev-parse') ? 'bad-sha' : f.execute(_file, args)), /invalid_source_sha/);
  assert.throws(() => inspectSource(f.root, execute, () => { throw new Error('unreadable source'); }), /unreadable source/);
  assert.equal(readFileSync(join(f.root, f.paths[0]), 'utf8'), 'export const value = 2;\n');
});
