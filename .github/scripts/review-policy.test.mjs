import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
  beginReview, bootstrapAllowed, duplicateReview, fenceReason, finalReviewState,
  finishReview, markedReview, missingSettings, resolveReview, workflowRunReason,
} from './review-policy.mjs';

const head = 'a'.repeat(40);
const newerHead = 'b'.repeat(40);
const repositoryId = 42;
const login = 'review-service';
const expected = { number: 7, repositoryId, head, headRepositoryId: repositoryId };
const pull = () => ({ number: 7, state: 'open', draft: false, user: { login: 'Z-M-Huang' },
  base: { ref: 'main', repo: { id: repositoryId } },
  head: { sha: head, ref: 'ci/issue-1', repo: { id: repositoryId } } });
const review = () => ({ id: 19, commit_id: head, user: { login }, state: 'COMMENTED',
  submitted_at: '2026-11-08T19:00:00Z', body: `Complete\n<!-- ai-pr-reviewer:v3:${head}:${'d'.repeat(64)} -->` });
const run = () => ({ id: 100, workflow_id: 21, path: '.github/workflows/codeql.yml',
  repository: { id: repositoryId }, head_repository: { id: repositoryId },
  head_sha: head, head_branch: 'ci/issue-1', event: 'pull_request', status: 'completed',
  conclusion: 'success', actor: { login: 'Z-M-Huang' }, triggering_actor: { login: 'Z-M-Huang' } });

function harness(eventName = 'pull_request') {
  const state = { pull: pull(), reviews: [], statuses: [], run: run(), published: [], outputs: {}, failures: [], logs: [] };
  const core = Object.fromEntries(['info', 'notice', 'warning', 'error'].map(level => [level, line => state.logs.push(JSON.parse(line))]));
  core.setOutput = (key, value) => { state.outputs[key] = value; };
  core.setFailed = message => state.failures.push(message);
  const github = { rest: {
    pulls: { get: async () => ({ data: state.pull }), list: async () => ({ data: [state.pull] }), listReviews: async () => ({ data: state.reviews }) },
    repos: { listCommitStatusesForRef: async () => ({ data: state.statuses }), createCommitStatus: async value => { state.published.push(value); return { data: value }; } },
    users: { getAuthenticated: async () => ({ data: { login } }) },
    actions: { getWorkflow: async () => ({ data: { id: 21 } }), getWorkflowRun: async () => ({ data: state.run }) },
  }, paginate: async (method, params) => (await method(params)).data };
  const context = { eventName, repo: { owner: 'markhuangai', repo: 'AaA-muse-ai' },
    actor: 'Z-M-Huang', runId: 101, serverUrl: 'https://github.com',
    payload: { repository: { id: repositoryId }, pull_request: pull(), workflow_run: run() } };
  const env = { REPOSITORY_ID: String(repositoryId), HEAD_REPOSITORY_ID: String(repositoryId),
    TRIGGERING_ACTOR: 'Z-M-Huang', PR_NUMBER: '7', HEAD_SHA: head, GITHUB_RUN_ATTEMPT: '1', REVIEW_OUTCOME: 'success' };
  return { state, github, context, core, env };
}

test('direct bootstrap requires the trusted author, both actors, and the same repository', () => {
  const payload = { pull_request: pull() };
  assert.equal(bootstrapAllowed(payload, 'Z-M-Huang', 'Z-M-Huang', repositoryId), true);
  for (const candidate of [
    { pull_request: { ...pull(), user: { login: 'someone-else' } } },
    { pull_request: { ...pull(), head: { ...pull().head, repo: { id: 99 } } } },
    { pull_request: { ...pull(), base: { ...pull().base, repo: { id: 99 } } } }, {},
  ]) assert.equal(bootstrapAllowed(candidate, 'Z-M-Huang', 'Z-M-Huang', repositoryId), false);
  assert.equal(bootstrapAllowed(payload, 'other', 'Z-M-Huang', repositoryId), false);
  assert.equal(bootstrapAllowed(payload, 'Z-M-Huang', 'other', repositoryId), false);
  assert.equal(bootstrapAllowed(payload, 'Z-M-Huang', 'Z-M-Huang', undefined), false);
});

test('current PR fence rejects changed identity, state, base, and head', () => {
  assert.equal(fenceReason(pull(), expected), null);
  const cases = [
    [{ ...pull(), number: 8 }, 'wrong_pr'], [{ ...pull(), state: 'closed' }, 'closed'],
    [{ ...pull(), draft: true }, 'draft'],
    [{ ...pull(), base: { ...pull().base, ref: 'other' } }, 'wrong_base'],
    [{ ...pull(), base: { ...pull().base, repo: { id: 99 } } }, 'wrong_repository'],
    [{ ...pull(), head: { ...pull().head, sha: newerHead } }, 'stale_head'],
    [{ ...pull(), head: { ...pull().head, repo: null } }, 'missing_head_repository'],
    [{ ...pull(), head: { ...pull().head, repo: { id: 99 } } }, 'changed_head_repository'],
    [{ ...pull(), user: null }, 'missing_author'],
  ];
  for (const [candidate, reason] of cases) assert.equal(fenceReason(candidate, expected), reason);
});

test('CodeQL completion must be the verified successful workflow and original actors', () => {
  assert.equal(workflowRunReason(run(), run(), repositoryId, 21), null);
  for (const change of [
    { repository: { id: 99 } }, { id: 99 }, { workflow_id: 99 }, { path: '.github/workflows/forged.yml' },
    { event: 'push' }, { conclusion: 'failure' }, { status: 'in_progress' },
    { head_sha: newerHead }, { head_repository: null }, { actor: { login: 'other' } },
    { triggering_actor: { login: 'other' } },
  ]) assert.notEqual(workflowRunReason({ ...run(), ...change }, run(), repositoryId, 21), null);
});

test('review evidence binds the first marker, commit, authenticated author, and submitted state', () => {
  assert.equal(markedReview(review(), head, login), true);
  for (const candidate of [
    { ...review(), commit_id: newerHead }, { ...review(), user: { login: 'spoof' } },
    { ...review(), state: 'DISMISSED' }, { ...review(), state: 'PENDING' },
    { ...review(), submitted_at: null }, { ...review(), body: 'No marker' },
    { ...review(), body: `<!-- ai-pr-reviewer:v2:invalid -->\n${review().body}` },
  ]) assert.equal(markedReview(candidate, head, login), false);
});

test('duplicate suppression needs successful authenticated status and marked review evidence', () => {
  const status = { state: 'success', creator: { login } };
  assert.equal(duplicateReview(status, [review()], head, login), true);
  assert.equal(duplicateReview({ ...status, state: 'pending' }, [review()], head, login), false);
  assert.equal(duplicateReview({ ...status, creator: { login: 'spoof' } }, [review()], head, login), false);
  assert.equal(duplicateReview(status, [], head, login), false);
});

test('timeout, failure, missing review, and stale head cannot become success', () => {
  assert.equal(finalReviewState(pull(), expected, 'success', [review()], login).state, 'success');
  for (const outcome of ['failure', 'cancelled', 'skipped', 'timed_out', undefined]) {
    assert.deepEqual(finalReviewState(pull(), expected, outcome, [review()], login), { state: 'error', reason: 'incomplete_review' });
  }
  assert.equal(finalReviewState(pull(), expected, 'success', [], login).reason, 'missing_marked_review');
  assert.equal(finalReviewState({ ...pull(), head: { ...pull().head, sha: newerHead } }, expected, 'success', [review()], login).reason, 'stale_head');
});

test('resolver publishes only a verified current direct PR identity', async () => {
  const h = harness();
  await resolveReview(h);
  assert.equal(h.state.outputs.should_run, 'true');
  assert.equal(h.state.outputs.head_sha, head);
  assert.equal(h.state.outputs.pr_number, '7');
  assert.equal(h.state.logs.find(log => log.event === 'review.resolved').author, 'Z-M-Huang');
  h.state.pull.head.sha = newerHead;
  await resolveReview(h);
  assert.equal(h.state.outputs.should_run, 'false');
  assert.equal(h.state.logs.at(-1).reason, 'stale_head');
  assert.equal(h.state.published.length, 0);
});

test('resolver rejects untrusted direct and foreign-repository events before API use', async () => {
  const h = harness();
  h.context.payload.pull_request.head.repo.id = 99;
  await resolveReview(h);
  assert.equal(h.state.outputs.should_run, 'false');
  assert.equal(h.state.logs.at(-1).reason, 'untrusted_direct_event');
  h.context.payload.repository.id = 99;
  await resolveReview(h);
  assert.equal(h.state.logs.at(-1).reason, 'wrong_repository');
});

test('CodeQL path skips direct-path duplicates and safely resolves another author or fork', async () => {
  const h = harness('workflow_run');
  await resolveReview(h);
  assert.equal(h.state.outputs.should_run, 'false');
  assert.equal(h.state.logs.at(-1).reason, 'uses_direct_review_path');
  h.state.pull.user.login = 'other';
  h.state.pull.head.repo.id = 99;
  h.state.run.head_repository.id = 99;
  await resolveReview(h);
  assert.equal(h.state.outputs.should_run, 'true');
  assert.equal(h.state.outputs.head_repository_id, '99');
  h.state.pull.head.sha = newerHead;
  await resolveReview(h);
  assert.equal(h.state.outputs.should_run, 'false');
  assert.equal(h.state.logs.at(-1).reason, 'no_unique_current_pr');
});

test('begin gate rejects stale heads and skips only proven completed duplicates', async () => {
  const h = harness();
  await beginReview(h);
  assert.equal(h.state.published[0].sha, head);
  assert.equal(h.state.published[0].state, 'pending');
  h.state.statuses = [{ id: 2, context: 'AI PR review / PR #7', state: 'success', creator: { login } }];
  h.state.reviews = [review()];
  await beginReview(h);
  assert.equal(h.state.outputs.should_run, 'false');
  assert.equal(h.state.published.length, 1);
  h.state.pull.head.sha = newerHead;
  await beginReview(h);
  assert.equal(h.state.outputs.should_run, 'false');
  assert.equal(h.state.published.length, 1);
  assert.equal(h.state.failures.length, 1);
});

test('finalizer publishes success only for marked complete current-head review', async () => {
  const h = harness();
  h.state.reviews = [review()];
  await finishReview(h);
  assert.equal(h.state.published.at(-1).state, 'success');
  assert.equal(h.state.logs.at(-1).review_id, 19);
  h.env.REVIEW_OUTCOME = 'failure';
  await finishReview(h);
  assert.equal(h.state.published.at(-1).state, 'error');
  h.env.REVIEW_OUTCOME = 'success';
  h.state.pull.head.sha = newerHead;
  await finishReview(h);
  assert.equal(h.state.published.at(-1).state, 'error');
  assert.equal(h.state.published.at(-1).sha, head);
  assert.equal(h.state.logs.at(-1).observed_head, newerHead);
});

test('production settings logs reconstruct missing input without printing admitted credentials', () => {
  assert.deepEqual(missingSettings({ PR_REVIEW_PAT: 'value', AI_ENDPOINT: ' ', LOCAL_AI_SECRET: '' }), ['AI_ENDPOINT', 'LOCAL_AI_SECRET']);
  const sentinel = 'fixture-only-do-not-print';
  const result = spawnSync(process.execPath, ['--input-type=module', '-e',
    "import { validateSettings } from './.github/scripts/review-policy.mjs'; validateSettings();"], {
    encoding: 'utf8', cwd: new URL('../..', import.meta.url),
    env: { PR_REVIEW_PAT: sentinel, AI_ENDPOINT: '', LOCAL_AI_SECRET: sentinel },
  });
  assert.notEqual(result.status, 0);
  const line = result.stdout.trim().replace(/^::error::/, '');
  assert.deepEqual(JSON.parse(line), { level: 'ERROR', event: 'review.settings', missing: ['AI_ENDPOINT'], outcome: 'failure' });
  assert.equal((result.stdout + result.stderr).includes(sentinel), false);
});

test('production API failure logs expose causal metadata without raw error contents', () => {
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import { reportApiFailure } from './.github/scripts/ci-log.mjs';
    reportApiFailure({ error: console.log, setFailed() { process.exitCode = 1; } },
      'publish_status', { status: 403, message: 'fixture-only-secret', response: { headers: { 'x-github-request-id': 'req-1' } } },
      { pr: 7, expected_head: '${head}', run_id: 101 });
  `], { encoding: 'utf8', cwd: new URL('../..', import.meta.url), env: {} });
  assert.equal(result.status, 1);
  const record = JSON.parse(result.stdout);
  assert.equal(record.http_status, 403);
  assert.equal(record.operation, 'publish_status');
  assert.equal(record.cause, 'permission_or_rate_limit');
  assert.equal(record.request_id, 'req-1');
  assert.equal((result.stdout + result.stderr).includes('fixture-only-secret'), false);
});
