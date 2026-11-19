import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { parse } from 'yaml';

test('two required inputs carry the named RC and frozen final pair through a single stable run', () => {
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
  assert.equal(workflow.name, 'Publish stable release');
  const inputs = workflow.on.workflow_dispatch.inputs;
  assert.deepEqual(Object.keys(inputs), ['prerelease_tag', 'stable_version']);
  assert(Object.values(inputs).every(input => input.type === 'string' && input.required === true));
  assert.match(JSON.stringify(workflow.jobs.resolve), /prepareStableRelease/);
  assert.match(build.if, /candidate_ready == 'false'/);
  const upload = build.steps.find(step => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(upload.with['retention-days'], 7); assert.equal(upload.with.overwrite, false);
  const freeze = build.steps.find(step => step.name === 'Freeze original image and worker bytes before any publication');
  assert.equal(upload.with.path, freeze.env.BUNDLE_DIR);
  const publish = workflow.jobs.publish;
  assert(publish.needs.includes('build'));
  assert.match(publish.if, /needs\.build\.result == 'skipped' && needs\.resolve\.outputs\.resume_run_id != ''/);
  assert(publish.steps.some(step => step.uses?.startsWith('actions/download-artifact@') && step.with['run-id']));
  assert.equal(publish.steps.find(step => step.uses?.startsWith('actions/download-artifact@')).with.path, upload.with.path);
  const promote = workflow.jobs.promote;
  assert.deepEqual(promote.needs, ['resolve', 'publish']);
  assert.match(promote.if, /needs\.publish\.result == 'skipped' && needs\.resolve\.outputs\.candidate_ready == 'true'/);
  const step = promote.steps.find(step => step.uses === 'actions/github-script@v9');
  assert.match(step.with.script, /promoteStable/);
  assert.match(step.env.MANIFEST_SHA256, /needs\.publish\.outputs\.manifest_sha256/);
  assert(!JSON.stringify(promote).includes('smoke-image'));
  const paired = parse(readFileSync('.github/workflows/publish-image.yml', 'utf8'));
  assert.deepEqual(paired.on.workflow_run, { workflows: ['CI'], types: ['completed'] });
  assert.equal(paired.concurrency.group, workflow.concurrency.group);
  assert(!existsSync('.github/workflows/candidate.yml'));
  const ci = parse(readFileSync('.github/workflows/ci.yml', 'utf8'));
  assert.equal(ci.jobs.release.name, 'Release / verify'); assert(ci.jobs.release.steps.some(step => step.run === 'make verify-release'));
});
