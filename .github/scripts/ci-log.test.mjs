import assert from 'node:assert/strict';
import test from 'node:test';
import { logEvent, reportApiFailure } from './ci-log.mjs';

test('existing CI logger preserves structured fields and ERROR annotations', () => {
  const output = [], previous = console.log;
  console.log = line => output.push(line);
  try { logEvent(null, 'error', 'ci.coverage_rejected', { covered: 90, total: 100 }); logEvent(null, 'info', 'ci.unit_coverage', { component: 'worker' }); }
  finally { console.log = previous; }
  assert(output[0].startsWith('::error::'));
  assert.deepEqual(JSON.parse(output[0].slice(9)), { level: 'ERROR', event: 'ci.coverage_rejected', covered: 90, total: 100 });
  assert.equal(JSON.parse(output[1]).level, 'INFO');
  const errors = [], failed = [];
  const core = { error: line => errors.push(JSON.parse(line)), setFailed: line => failed.push(line) };
  reportApiFailure(core, 'listJobs', { status: 403, response: { headers: { 'x-github-request-id': 'request-1' } }, message: 'private raw error is not admitted' }, { source_sha: 'a'.repeat(40) });
  reportApiFailure(core, 'getCommit', {});
  assert.equal(errors[0].cause, 'permission_or_rate_limit'); assert.equal(errors[0].request_id, 'request-1');
  assert.equal(errors[1].http_status, null); assert.equal(errors[1].request_id, null);
  assert.equal(errors[1].cause, 'required_api_operation_failed'); assert.equal(failed.length, 2);
  assert(!JSON.stringify(errors).includes('private raw error'));
});
