import assert from 'node:assert/strict';
import test from 'node:test';
import { analysisProblems, requireAnalyses, selectLanguages } from './codeql-policy.mjs';

const execution = (language, run_attempt = 1, conclusion = 'success') => ({
  id: 10, name: `Analyze (${language})`, run_attempt, status: 'completed', conclusion,
});

test('Actions is always selected and tracked Go or JavaScript/TypeScript sources add analyses', () => {
  assert.deepEqual(selectLanguages([]), ['actions']);
  assert.deepEqual(selectLanguages(['README.md', '.github/workflows/ci.yml']), ['actions']);
  assert.deepEqual(selectLanguages(['nested/main.go']), ['actions', 'go']);
  for (const extension of ['js', 'jsx', 'mjs', 'cjs', 'ts', 'tsx', 'mts', 'cts']) {
    assert.deepEqual(selectLanguages([`.github/scripts/policy.${extension}`]), ['actions', 'javascript-typescript']);
  }
  assert.deepEqual(selectLanguages(['main.go', 'worker.ts', 'portal.tsx']), ['actions', 'go', 'javascript-typescript']);
});

test('all required languages need completed, unique, latest successful executions', () => {
  const languages = ['actions', 'javascript-typescript'];
  assert.deepEqual(analysisProblems(languages, languages.map(language => execution(language)), 1), []);
  assert.equal(analysisProblems(languages, [execution('actions')], 1)[0].language, 'javascript-typescript');
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', null]) {
    assert.equal(analysisProblems(['actions'], [execution('actions', 1, conclusion)], 1).length, 1);
  }
  assert.equal(analysisProblems(['actions'], [{ ...execution('actions'), status: 'in_progress' }], 1).length, 1);
  assert.equal(analysisProblems(['actions'], [execution('actions'), execution('actions')], 1).length, 1);
});

test('reruns reuse earlier language successes but cannot conceal a newer failed execution', () => {
  const jobs = [execution('actions'), execution('javascript-typescript', 1, 'failure'), execution('javascript-typescript', 2)];
  assert.deepEqual(analysisProblems(['actions', 'javascript-typescript'], jobs, 2), []);
  assert.equal(analysisProblems(['actions'], [execution('actions'), execution('actions', 2, 'failure')], 2).length, 1);
  assert.equal(analysisProblems(['actions'], [execution('actions', 2)], 1).length, 1);
  assert.equal(analysisProblems(['actions'], [{ ...execution('actions'), run_attempt: undefined }], 1).length, 1);
});

test('missing, duplicate, or unsupported required language selection fails explicitly', () => {
  for (const languages of [undefined, [], ['go'], ['actions', 'actions'], ['actions', 'python']]) {
    assert.throws(() => analysisProblems(languages, [], 1), /Invalid required/);
  }
  assert.throws(() => analysisProblems(['actions'], [], 0), /Invalid CodeQL run attempt/);
});

test('production aggregator fails the gate and records missing-language evidence', async () => {
  const logs = [];
  const failures = [];
  const github = { rest: { actions: { listJobsForWorkflowRun: async () => {} } }, paginate: async () => [execution('actions')] };
  const core = { error: line => logs.push(JSON.parse(line)), setFailed: message => failures.push(message) };
  const problems = await requireAnalyses({ github, core,
    context: { repo: { owner: 'markhuangai', repo: 'AaA-muse-ai' }, runId: 100, sha: 'a'.repeat(40) },
    languages: ['actions', 'go'], runAttempt: 1 });
  assert.equal(problems[0].language, 'go');
  assert.equal(failures.length, 1);
  assert.equal(logs[0].outcome, 'failure');
  assert.equal(logs[0].source_sha, 'a'.repeat(40));
  assert.equal(logs[0].problems[0].latest_attempt, 0);
});
