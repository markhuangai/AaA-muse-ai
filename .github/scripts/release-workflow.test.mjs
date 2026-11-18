import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';

test('release workflow keeps executable trust, original bundle retention, shared publication locking and explicit promotion separate', () => {
  const workflow = parse(readFileSync('.github/workflows/release.yml', 'utf8'));
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch']);
  assert.equal(workflow.concurrency.group, 'paired-product-release'); assert.equal(workflow.concurrency['cancel-in-progress'], false);
  for (const job of Object.values(workflow.jobs)) {
    assert.equal(job['runs-on'], 'ubuntu-latest'); assert(job['timeout-minutes'] <= 30);
    for (const step of job.steps.filter(step => step.uses === 'actions/checkout@v7' && step.with.path !== 'source')) assert.equal(step.with.ref, '${{ github.workflow_sha }}');
  }
  const build = workflow.jobs.build;
  assert.match(build.if, /resume_run_id == ''/);
  assert.match(build.name, /^Build final candidate /);
  assert(!Object.hasOwn(workflow.on.workflow_dispatch.inputs, 'source_sha'));
  assert.notEqual(workflow.on.workflow_dispatch.inputs.version.required, true);
  assert.match(JSON.stringify(workflow.jobs.resolve), /requestedVersion/);
  const upload = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with['retention-days'], 7); assert.equal(upload.with.overwrite, false);
  const freeze = build.steps.find(step => step.name === 'Freeze original image and worker bytes before any publication');
  assert.equal(upload.with.path, freeze.env.BUNDLE_DIR);
  const publish = workflow.jobs.publish;
  assert(publish.needs.includes('build'));
  assert(publish.steps.some(step => step.uses?.startsWith('actions/download-artifact@') && step.with['run-id']));
  assert.equal(publish.steps.find(step => step.uses?.startsWith('actions/download-artifact@')).with.path, upload.with.path);
  assert(!JSON.stringify(workflow.jobs.promote).includes('smoke-image'));
  assert(!JSON.stringify(workflow.jobs.promote).includes('SOURCE_SHA'));
  assert(JSON.stringify(workflow.jobs.promote).includes('QUALIFICATION_SHA256'));
  assert.match(JSON.stringify(workflow.jobs.promote), /promoteRelease/);
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.equal(ci.jobs.release.name, 'Release / verify'); assert(ci.jobs.release.steps.some(step => step.run === 'make verify-release'));
});
