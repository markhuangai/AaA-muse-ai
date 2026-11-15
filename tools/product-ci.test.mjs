import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { boundaryCases, flowCases } from './product-report.mjs';
import { collectShards, main, validateShards } from './product-ci.mjs';

const source = { sha: 'a'.repeat(40), dirty: false, tree_sha256: 'b'.repeat(64) };
const expected = { source, runID: '123', attempt: '1' };
function receipts() {
  return ['flow', 'boundaries'].map(shard => ({ schema_version: 1, suite: 'product-e2e', shard, source, run_id: '123', run_attempt: '1', outcome: 'passed', evidence_kind: 'synthetic', qualifies_live_muse: false, duration_ms: 1000, capture_complete: true,
    cases: (shard === 'flow' ? flowCases : boundaryCases).map(id => ({ id, outcome: 'passed' })), image_digest: 'sha256:' + 'c'.repeat(64), installer_sha256: 'd'.repeat(64), report_sha256: 'e'.repeat(64), exports: [{}, {}, {}], cleanup: { failures: [] },
    worker_version: '0.1.0-rc.7', worker_sha256: 'f'.repeat(64), images: ['sha256:' + 'c'.repeat(64), 'sha256:' + 'c'.repeat(64)] }));
}

test('product aggregate requires complete case/source/run/artifact/budget evidence from both shards', () => {
  const result = validateShards(receipts(), expected);
  assert.equal(result.outcome, 'passed'); assert.equal(result.qualifies_live_muse, false);
  for (const change of [
    rows => rows.pop(), rows => rows.push(rows[0]), rows => { rows[0].outcome = 'failed'; }, rows => { rows[0].evidence_kind = 'live'; },
    rows => { rows[0].source = {}; }, rows => { rows[0].run_attempt = '2'; }, rows => { rows[0].duration_ms = 1500001; }, rows => { rows[0].capture_complete = false; },
    rows => { rows[0].cases.pop(); }, rows => { rows[0].cleanup.failures.push('leftover'); }, rows => { rows[0].image_digest = 'latest'; },
    rows => { rows[1].worker_sha256 = '0'.repeat(64); }, rows => { rows[1].images = []; }, rows => { rows[0].cases.push(rows[0].cases[0]); },
  ]) { const rows = receipts(); change(rows); assert.throws(() => validateShards(rows, expected)); }
});

test('aggregate discovers real shard files and returns explicit failure diagnostics', t => {
  const root = mkdtempSync(join(tmpdir(), 'aaa-product-ci-')); t.after(() => rmSync(root, { recursive: true }));
  const rows = receipts(); mkdirSync(join(root, 'flow'));
  writeFileSync(join(root, 'flow', 'flow.json'), JSON.stringify(rows[0])); writeFileSync(join(root, 'boundaries.json'), JSON.stringify(rows[1])); writeFileSync(join(root, 'ignored.json'), '{}');
  assert.equal(collectShards(root).length, 2);
  const lines = [], options = { source: () => source, env: { GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '1' }, output: line => lines.push(JSON.parse(line)) };
  assert.equal(main([root], options), 0); assert.equal(lines.at(-1).msg, 'e2e.completed');
  assert.equal(main([], options), 1); assert.equal(lines.at(-1).cause, 'e2e_receipt_directory_required');
  assert.equal(main([root], { ...options, collect: () => { throw new Error('unsafe /path/error'); } }), 1);
  assert.equal(lines.at(-1).cause, 'e2e_receipt_read_failed');
  assert.equal(main([root], { ...options, env: {}, collect: () => rows }), 1);
});
