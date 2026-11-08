import { logEvent, reportApiFailure } from './ci-log.mjs';

export const trustedActor = 'Z-M-Huang';
const shaPattern = /^[0-9a-f]{40}$/;
const workflowPath = '.github/workflows/ai-pr-review.yml';

export function bootstrapAllowed(payload, actor, triggeringActor, repositoryId) {
  const pull = payload.pull_request;
  return pull?.user?.login === trustedActor && actor === trustedActor &&
    triggeringActor === trustedActor && Number.isSafeInteger(repositoryId) &&
    repositoryId > 0 && pull.head?.repo?.id === repositoryId && pull.base?.repo?.id === repositoryId;
}

export function fenceReason(pull, expected) {
  if (!pull || pull.number !== expected.number) return 'wrong_pr';
  if (pull.base?.repo?.id !== expected.repositoryId) return 'wrong_repository';
  if (pull.state !== 'open') return 'closed';
  if (pull.draft !== false) return 'draft';
  if (pull.base?.ref !== 'main') return 'wrong_base';
  if (!shaPattern.test(pull.head?.sha ?? '') || pull.head.sha !== expected.head) return 'stale_head';
  if (!Number.isSafeInteger(pull.head?.repo?.id) || pull.head.repo.id < 1) return 'missing_head_repository';
  if (expected.headRepositoryId && pull.head.repo.id !== expected.headRepositoryId) return 'changed_head_repository';
  if (typeof pull.user?.login !== 'string' || !pull.user.login) return 'missing_author';
  return null;
}

export function workflowRunReason(run, eventRun, repositoryId, workflowId) {
  if (run.repository?.id !== repositoryId || run.id !== eventRun.id ||
      run.workflow_id !== workflowId || run.path !== '.github/workflows/codeql.yml') return 'wrong_workflow_repository';
  if (run.event !== 'pull_request' || run.status !== 'completed' || run.conclusion !== 'success') return 'unsuccessful_codeql';
  if (!shaPattern.test(run.head_sha ?? '') || run.head_sha !== eventRun.head_sha ||
      !Number.isSafeInteger(run.head_repository?.id) || !run.head_branch) return 'invalid_source';
  if (!run.actor?.login || !run.triggering_actor?.login ||
      run.actor.login !== eventRun.actor?.login ||
      run.triggering_actor.login !== eventRun.triggering_actor?.login) return 'changed_run_actor';
  return null;
}

export function markedReview(review, head, login) {
  const firstMarker = review.body?.match(/<!-- ai-pr-reviewer:[^\r\n]*?-->/)?.[0];
  return review.commit_id === head && review.user?.login === login &&
    ['COMMENTED', 'CHANGES_REQUESTED', 'APPROVED'].includes(review.state) &&
    Boolean(review.submitted_at) &&
    new RegExp(`^<!-- ai-pr-reviewer:v3:${head}:[0-9a-f]{64} -->$`).test(firstMarker ?? '');
}

export function duplicateReview(status, reviews, head, login) {
  return status?.state === 'success' && status.creator?.login === login &&
    reviews.some(review => markedReview(review, head, login));
}

export function finalReviewState(pull, expected, outcome, reviews, login) {
  const reason = fenceReason(pull, expected);
  if (reason) return { state: 'error', reason };
  if (outcome !== 'success') return { state: 'error', reason: 'incomplete_review' };
  const review = reviews.find(review => markedReview(review, expected.head, login));
  if (!review) return { state: 'error', reason: 'missing_marked_review' };
  return { state: 'success', reason: 'completed', review_id: review.id };
}

export function missingSettings(environment) {
  return ['PR_REVIEW_PAT', 'AI_ENDPOINT', 'LOCAL_AI_SECRET'].filter(name => !environment[name]?.trim());
}

export function validateSettings(environment = process.env) {
  const missing = missingSettings(environment);
  logEvent(null, missing.length ? 'error' : 'info', 'review.settings', {
    missing, outcome: missing.length ? 'failure' : 'success',
  });
  if (missing.length) throw new Error('Required review settings are missing; inspect review.settings.');
}

function metadata(context, env) {
  return {
    trigger: context.eventName, repository: `${context.repo.owner}/${context.repo.repo}`,
    repository_id: Number(env.REPOSITORY_ID), actor: context.actor,
    triggering_actor: env.TRIGGERING_ACTOR, run_id: context.runId,
    run_attempt: Number(env.GITHUB_RUN_ATTEMPT),
  };
}

function reject(core, details, reason, fields = {}) {
  logEvent(core, 'notice', 'review.rejected', { ...details, ...fields, reason });
  core.setOutput('should_run', 'false');
}

export async function resolveReview({ github, context, core, env = process.env }) {
  const details = metadata(context, env);
  const repositoryId = details.repository_id;
  core.setOutput('should_run', 'false');
  logEvent(core, 'info', 'review.trigger', details);
  try {
    if (!Number.isSafeInteger(repositoryId) || repositoryId < 1 ||
        context.payload.repository?.id !== repositoryId) return reject(core, details, 'wrong_repository');
    let number;
    let head;
    let headRepositoryId;
    let run;
    if (context.eventName === 'pull_request') {
      if (!bootstrapAllowed(context.payload, context.actor, env.TRIGGERING_ACTOR, repositoryId)) {
        return reject(core, details, 'untrusted_direct_event');
      }
      number = context.payload.pull_request.number;
      head = context.payload.pull_request.head.sha;
      headRepositoryId = context.payload.pull_request.head.repo.id;
    } else if (context.eventName === 'workflow_run') {
      const eventRun = context.payload.workflow_run;
      if (!Number.isSafeInteger(eventRun?.id) || eventRun.id < 1) return reject(core, details, 'missing_run');
      const { data: workflow } = await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: '.github/workflows/codeql.yml' });
      ({ data: run } = await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: eventRun.id }));
      const reason = workflowRunReason(run, eventRun, repositoryId, workflow.id);
      if (reason) return reject(core, details, reason);
      const pulls = await github.paginate(github.rest.pulls.list, { ...context.repo, state: 'open', base: 'main', per_page: 100 });
      const matches = pulls.filter(pull => pull.head.sha === run.head_sha &&
        pull.head.ref === run.head_branch && pull.head.repo?.id === run.head_repository.id);
      if (matches.length !== 1) return reject(core, details, 'no_unique_current_pr', { matches: matches.length, expected_head: run.head_sha });
      number = matches[0].number;
      head = run.head_sha;
      headRepositoryId = run.head_repository.id;
    } else return reject(core, details, 'unsupported_trigger');
    if (!Number.isSafeInteger(number) || number < 1 || !shaPattern.test(head ?? '')) {
      return reject(core, details, 'invalid_pr_identity');
    }
    const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: number });
    const expected = { number, repositoryId, head, headRepositoryId };
    const reason = fenceReason(pull, expected);
    if (reason) return reject(core, details, reason, { pr: number, expected_head: head, observed_head: pull.head?.sha });
    if (context.eventName === 'pull_request' && pull.user.login !== trustedActor) {
      return reject(core, details, 'changed_author');
    }
    if (run && pull.user.login === trustedActor && pull.head.repo.id === repositoryId &&
        run.actor.login === trustedActor && run.triggering_actor.login === trustedActor) {
      return reject(core, details, 'uses_direct_review_path', { pr: number, expected_head: head });
    }
    logEvent(core, 'info', 'review.resolved', { ...details, pr: number, expected_head: head,
      observed_head: pull.head.sha, author: pull.user.login, head_repository_id: headRepositoryId });
    for (const [key, value] of Object.entries({
      should_run: 'true', pr_number: number, head_sha: head, head_repository_id: headRepositoryId,
      status_context: `AI PR review / PR #${number}`,
    })) core.setOutput(key, String(value));
  } catch (error) {
    reportApiFailure(core, 'resolve_review', error, details);
  }
}

function expectedFromEnv(env) {
  const expected = { number: Number(env.PR_NUMBER), repositoryId: Number(env.REPOSITORY_ID),
    head: env.HEAD_SHA, headRepositoryId: Number(env.HEAD_REPOSITORY_ID) };
  if (!Number.isSafeInteger(expected.number) || expected.number < 1 ||
      !Number.isSafeInteger(expected.repositoryId) || expected.repositoryId < 1 ||
      !Number.isSafeInteger(expected.headRepositoryId) || expected.headRepositoryId < 1 ||
      !shaPattern.test(expected.head ?? '')) throw new Error('Invalid resolved review identity.');
  return expected;
}

async function publishStatus(github, context, expected, state, reason) {
  await github.rest.repos.createCommitStatus({ ...context.repo, sha: expected.head, state,
    context: `AI PR review / PR #${expected.number}`,
    description: state === 'success' ? 'AI pull request review completed.' :
      state === 'pending' ? 'AI pull request review is running.' : `AI review failed: ${reason}; inspect the run.`,
    target_url: `${context.serverUrl}/${context.repo.owner}/${context.repo.repo}/actions/runs/${context.runId}`,
  });
}

export async function beginReview({ github, context, core, env = process.env }) {
  core.setOutput('should_run', 'false');
  try {
    const expected = expectedFromEnv(env);
    const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: expected.number });
    const reason = fenceReason(pull, expected);
    if (reason) {
      reject(core, metadata(context, env), reason, { pr: expected.number, expected_head: expected.head, observed_head: pull.head?.sha });
      core.setFailed('PR changed before review; no pending status was published.');
      return;
    }
    const { data: user } = await github.rest.users.getAuthenticated();
    const statuses = await github.paginate(github.rest.repos.listCommitStatusesForRef, {
      ...context.repo, ref: expected.head, per_page: 100,
    });
    const status = statuses.filter(status => status.context === `AI PR review / PR #${expected.number}`)
      .sort((left, right) => right.id - left.id)[0];
    const reviews = await github.paginate(github.rest.pulls.listReviews, { ...context.repo, pull_number: expected.number, per_page: 100 });
    if (duplicateReview(status, reviews, expected.head, user.login)) {
      return reject(core, metadata(context, env), 'completed_duplicate', { pr: expected.number, expected_head: expected.head });
    }
    await publishStatus(github, context, expected, 'pending', 'running');
    logEvent(core, 'info', 'review.status', { ...metadata(context, env), pr: expected.number,
      expected_head: expected.head, state: 'pending' });
    core.setOutput('should_run', 'true');
  } catch (error) {
    reportApiFailure(core, 'begin_review', error, metadata(context, env));
  }
}

export async function finishReview({ github, context, core, env = process.env }) {
  try {
    const expected = expectedFromEnv(env);
    const { data: user } = await github.rest.users.getAuthenticated();
    const reviews = await github.paginate(github.rest.pulls.listReviews, { ...context.repo, pull_number: expected.number, per_page: 100 });
    const { data: pull } = await github.rest.pulls.get({ ...context.repo, pull_number: expected.number });
    const result = finalReviewState(pull, expected, env.REVIEW_OUTCOME, reviews, user.login);
    await publishStatus(github, context, expected, result.state, result.reason);
    logEvent(core, result.state === 'success' ? 'info' : 'error', 'review.status', {
      ...metadata(context, env), pr: expected.number, expected_head: expected.head,
      observed_head: pull.head?.sha, review_outcome: env.REVIEW_OUTCOME || 'missing', ...result,
    });
    if (result.state !== 'success') core.setFailed('Review incomplete or stale; its status remains blocking.');
  } catch (error) {
    reportApiFailure(core, 'finish_review', error, metadata(context, env));
  }
}

export async function recordReviewerRelease({ github, core }) {
  const repo = { owner: 'markhuangai', repo: 'ai-pr-reviewer' };
  const { data: reference } = await github.rest.git.getRef({ ...repo, ref: 'tags/v1' });
  if (reference.object.type !== 'tag') throw new Error('Reviewer v1 must resolve through an annotated stable release alias.');
  const { data: tag } = await github.rest.git.getTag({ ...repo, tag_sha: reference.object.sha });
  const release = tag.message.trim();
  if (!/^v1\.\d+\.\d+$/.test(release) || tag.object.type !== 'commit' || !shaPattern.test(tag.object.sha)) {
    throw new Error('Reviewer v1 has invalid stable release metadata.');
  }
  logEvent(core, 'info', 'review.release', { action_ref: 'v1', observed_release: release, observed_source_sha: tag.object.sha });
}
