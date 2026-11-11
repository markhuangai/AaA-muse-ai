import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'yaml';
import { checkDirectory, checkWorkflow, main, workflowProblems } from './ci-policy.mjs';

const workflow = (runner = 'ubuntu-latest', budget = '30') => `
name: fixture
on: pull_request
jobs:
  check:
    runs-on: ${runner}
    timeout-minutes: ${budget}
    strategy:
      matrix:
        language: [actions, go, javascript-typescript]
    steps:
      - run: true
`;

test('literal standard hosted Linux runners and bounded matrix jobs pass', () => {
  for (const runner of ['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04']) {
    assert.deepEqual(checkWorkflow(workflow(runner)), []);
  }
  assert.deepEqual(checkWorkflow(workflow('ubuntu-latest', '1')), []);
});

test('self-hosted, larger, non-Linux, group, list, and expression runners are rejected', () => {
  for (const runner of ['self-hosted', 'ubuntu-latest-8-cores', 'windows-latest', 'macos-latest',
    '[self-hosted, linux]', '{group: custom}', '${{ matrix.runner }}']) {
    assert.match(checkWorkflow(workflow(runner))[0], /literal standard hosted Ubuntu/);
  }
});

test('every job needs its own literal integer timeout from one through thirty minutes', () => {
  for (const budget of ['0', '-1', '31', '60', '1.5', '"30"', '${{ matrix.timeout }}', 'null']) {
    assert.match(checkWorkflow(workflow('ubuntu-latest', budget))[0], /timeout-minutes/);
  }
  const missing = workflow().replace('    timeout-minutes: 30\n', '');
  assert.match(checkWorkflow(missing)[0], /timeout-minutes/);
  assert.match(checkWorkflow(workflow() + '\n  forgotten:\n    runs-on: ubuntu-latest\n')[0], /jobs.forgotten/);
});

test('only the approved AI review job has a forty-five-minute budget with cleanup headroom', () => {
  const review = budget => workflow('ubuntu-latest', budget).replace('  check:', '  review:');
  assert.deepEqual(checkWorkflow(review('45'), 'ai-pr-review.yml'), []);
  assert.match(checkWorkflow(review('46'), 'ai-pr-review.yml')[0], /1 through 45/);
  assert.match(checkWorkflow(review('45'), 'other.yml')[0], /1 through 30/);
  assert.match(checkWorkflow(workflow('ubuntu-latest', '45'), 'ai-pr-review.yml')[0], /1 through 30/);
  for (const budget of ['0', '"45"', '44.5', '${{ matrix.timeout }}']) {
    assert.match(checkWorkflow(review(budget), 'ai-pr-review.yml')[0], /timeout-minutes/);
  }
  const config = parse(readFileSync(new URL('../workflows/ai-pr-review.yml', import.meta.url), 'utf8'));
  assert.equal(config.jobs.review['timeout-minutes'], 45);
  assert.equal(config.jobs.review.steps.find(step => step.id === 'reviewer')['timeout-minutes'], 40);
});

test('invalid YAML, duplicate keys, absent jobs, and unbounded reusable jobs fail closed', () => {
  for (const source of ['jobs: [', 'name: empty', 'jobs: []', 'jobs: {}', 'jobs:\n  job: null']) {
    assert.ok(checkWorkflow(source).length > 0);
  }
  assert.match(checkWorkflow(workflow().replace('    timeout-minutes: 30', '    timeout-minutes: 30\n    timeout-minutes: 10'))[0], /invalid YAML/);
  assert.ok(checkWorkflow('jobs:\n  inherited:\n    uses: owner/repo/.github/workflows/check.yml@main').length > 0);
});

test('directory scanner checks both YAML extensions and refuses an empty workflow set', () => {
  const directory = mkdtempSync(join(tmpdir(), 'aaa-muse-ci-policy-test-'));
  try {
    assert.equal(checkDirectory(directory).length, 1);
    writeFileSync(join(directory, 'good.yml'), workflow());
    writeFileSync(join(directory, 'bad.yaml'), workflow('self-hosted'));
    writeFileSync(join(directory, 'ignored.txt'), 'not YAML');
    const errors = checkDirectory(directory);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^bad.yaml:/);
  } finally {
    rmSync(directory, { recursive: true });
  }
});

test('budget rejection logs identify the actual runner, job, workflow, and allowed timeout', () => {
  const events = [], emit = (_core, level, event, fields) => events.push({ level, event, ...fields });
  const directory = mkdtempSync(join(tmpdir(), 'aaa-muse-ci-diagnostics-test-'));
  try {
    writeFileSync(join(directory, 'bad.yml'), workflow('self-hosted', '31'));
    assert.equal(main(directory, emit), 1);
    const rejected = events.filter(event => event.event === 'ci.budget_rejected');
    assert.equal(rejected.length, 2);
    assert(rejected.every(event => event.level === 'error' && event.workflow === 'bad.yml' && event.job === 'check' && event.runner === 'self-hosted' && event.timeout === 31 && event.maximum === 30));
    const captured = [], previous = console.log;
    console.log = line => captured.push(line);
    try { assert.equal(main(directory), 1); } finally { console.log = previous; }
    assert(captured.filter(line => line.startsWith('::error::')).map(line => JSON.parse(line.slice(9))).some(event => event.level === 'ERROR' && event.event === 'ci.budget_rejected' && event.workflow === 'bad.yml' && event.job === 'check' && event.runner === 'self-hosted' && event.timeout === 31 && event.maximum === 30));
    writeFileSync(join(directory, 'bad.yml'), workflow());
    assert.equal(main(directory, emit), 0);
    assert.equal(events.at(-1).outcome, 'passed');
    assert.equal(main(join(directory, 'missing'), emit), 1);
    assert.equal(events.at(-1).cause, 'ENOENT');
    for (const value of ['[]', 'false', 'invalid']) assert.equal(workflowProblems(`jobs:\n  job: ${value}`)[0].cause, 'invalid_job');
  } finally { rmSync(directory, { recursive: true }); }
});

test('actual pre-checkout workflow gate admits only trusted direct or successful completion events', async () => {
  const config = parse(readFileSync(new URL('../workflows/ai-pr-review.yml', import.meta.url), 'utf8'));
  const script = config.jobs.resolve.steps.find(step => step.id === 'trust').with.script;
  const execute = new (Object.getPrototypeOf(async function () {}).constructor)('context', 'core', 'process', script);
  const pull = { user: { login: 'Z-M-Huang' }, head: { repo: { id: 42 } }, base: { repo: { id: 42 } } };
  const cases = [
    [{ eventName: 'pull_request', actor: 'Z-M-Huang', payload: { pull_request: pull } }, 'Z-M-Huang', true],
    [{ eventName: 'pull_request', actor: 'other', payload: { pull_request: pull } }, 'Z-M-Huang', false],
    [{ eventName: 'pull_request', actor: 'Z-M-Huang', payload: { pull_request: pull } }, 'other', false],
    [{ eventName: 'pull_request', actor: 'Z-M-Huang', payload: { pull_request: { ...pull, head: { repo: { id: 99 } } } } }, 'Z-M-Huang', false],
    [{ eventName: 'workflow_run', payload: { workflow_run: { event: 'pull_request', conclusion: 'success' } } }, 'other', true],
    [{ eventName: 'workflow_run', payload: { workflow_run: { event: 'pull_request', conclusion: 'failure' } } }, 'other', false],
    [{ eventName: 'workflow_run', payload: { workflow_run: { event: 'push', conclusion: 'success' } } }, 'other', false],
  ];
  for (const [context, triggeringActor, expected] of cases) {
    const outputs = {};
    await execute(context, { setOutput: (key, value) => { outputs[key] = value; }, info() {} },
      { env: { REPOSITORY_ID: '42', TRIGGERING_ACTOR: triggeringActor } });
    assert.equal(outputs.allowed, String(expected));
  }
});
