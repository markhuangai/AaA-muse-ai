import { repository, need, sha } from './release-manifest.mjs';
import { logEvent } from './ci-log.mjs';
import { ReleaseFailure } from './worker-release.mjs';

export const workflowPath = '.github/workflows/release.yml';

export async function resolveStableSource({ github, context, sourceSHA, phase, version }) {
  const started = Date.now();
  let operation = 'dispatch_verification', observedSource = 'unavailable', observedTree = 'unavailable';
  try {
  need(context.eventName === 'workflow_dispatch' && context.ref === 'refs/heads/main' &&
    `${context.repo.owner}/${context.repo.repo}` === repository && sha(sourceSHA) &&
    ['candidate', 'promote'].includes(phase) && version === '0.1.0', 'product_release_untrusted_dispatch');
  const permission = (await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: context.actor })).data;
  need(permission.permission === 'admin', 'product_release_administrator_required');
  operation = 'source_identity_verification';
  const source = (await github.rest.repos.getCommit({ ...context.repo, ref: sourceSHA })).data;
  observedSource = source.sha; observedTree = source.commit?.tree?.sha ?? 'unavailable';
  need(source.sha === sourceSHA && sha(source.commit.tree.sha), 'product_release_source_identity_mismatch');
  const comparison = (await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${sourceSHA}...main` })).data;
  operation = 'main_ancestry_verification';
  need(comparison.merge_base_commit.sha === sourceSHA, 'product_release_source_not_on_main', { observed_main_merge_base: comparison.merge_base_commit.sha });
  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { ...context.repo, commit_sha: sourceSHA, per_page: 100 });
  const merged = pulls.filter(pull => pull.merged_at && pull.merge_commit_sha === sourceSHA && pull.base.ref === 'main' &&
    pull.base.repo.full_name === repository && pull.head.repo?.full_name === repository && pull.user.login === 'Z-M-Huang');
  need(merged.length === 1, 'product_release_requires_delivery_merge');
  const files = await github.paginate(github.rest.pulls.listFiles, { ...context.repo, pull_number: merged[0].number, per_page: 100 });
  need(files.some(file => file.filename === workflowPath && file.status === 'added'), 'product_release_requires_issue_19_delivery');
  const runs = [];
  operation = 'main_check_verification';
  for (const workflow_id of ['ci.yml', 'codeql.yml']) {
    const result = (await github.rest.actions.listWorkflowRuns({ ...context.repo, workflow_id, head_sha: sourceSHA, event: 'push', per_page: 100 })).data;
    const run = result.workflow_runs.filter(run => run.head_sha === sourceSHA && run.head_branch === 'main').sort((a, b) => b.id - a.id)[0];
    need(run?.status === 'completed' && run.conclusion === 'success', 'product_release_required_main_checks_missing', { workflow: workflow_id });
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...context.repo, run_id: run.id, filter: 'latest', per_page: 100 });
    need(jobs.length && jobs.every(job => job.conclusion === 'success'), 'product_release_main_jobs_incomplete', { workflow: workflow_id });
    if (workflow_id === 'ci.yml') need(jobs.some(job => job.name === 'Release / verify'), 'product_release_main_verifier_missing');
    runs.push(run.id);
  }
  const prepared = { source_sha: sourceSHA, tree_sha: source.commit.tree.sha, version, tag: 'v' + version,
    candidate: true, paired: true, should_publish: true, phase, pr: merged[0].number, main_runs: runs };
  logEvent(null, 'info', 'product.release.source_verified', { ...prepared, actor: context.actor, run_id: context.runId });
  return prepared;
  } catch (error) {
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_source_api_failed', {
      operation_id: `release-${context.runId}-${context.runAttempt ?? 1}`, run_id: context.runId, attempt: context.runAttempt ?? 1,
      operation, destination: 'source_repository', source_sha: sha(sourceSHA) ? sourceSHA : 'invalid', version: version === '0.1.0' ? version : 'invalid',
      expected_source: sha(sourceSHA) ? sourceSHA : 'invalid', observed_source: sha(observedSource) ? observedSource : 'unavailable',
      observed_tree: sha(observedTree) ? observedTree : 'unavailable', expected_digest: 'not_applicable', observed_digest: 'not_applicable',
      duration_ms: Date.now() - started, ...(error instanceof ReleaseFailure ? error.fields : {}),
      http_status: Number.isInteger(error.status) ? error.status : null, request_id: error.response?.headers?.['x-github-request-id'] ?? null,
      outcome: 'blocked', raw_output_omitted: true, omission_reason: 'credential_protection' });
  }
}

export async function candidateRecovery({ github, context, prepared, resumeRunID }) {
  const started = Date.now();
  let operation = 'version_reservation_lookup';
  try {
  const ref = 'tags/' + prepared.tag;
  let reserved = false;
  try {
    const tag = (await github.rest.git.getRef({ ...context.repo, ref })).data;
    need(tag.object.type === 'commit' && tag.object.sha === prepared.source_sha, 'product_release_version_reserved_for_other_source', {
      expected_source: prepared.source_sha, observed_source: sha(tag.object.sha) ? tag.object.sha : 'unavailable', observed_object_type: tag.object.type });
    reserved = true;
  } catch (error) { if (error.status !== 404) throw error; }
  const workflow = (await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: workflowPath })).data;
  let runID = resumeRunID ? Number(resumeRunID) : null;
  operation = 'original_bundle_discovery';
  {
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, { ...context.repo, workflow_id: workflow.id, event: 'workflow_dispatch', per_page: 100 });
    for (const run of runs.filter(run => run.id !== context.runId || context.runAttempt > 1).sort((a, b) => a.id - b.id)) {
      const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...context.repo, run_id: run.id, per_page: 100 });
      const matches = artifacts.filter(artifact => artifact.name === bundleName(prepared));
      if (matches.length) {
        need(matches.length === 1 && !matches[0].expired, 'product_release_original_bundle_unavailable', { original_run_id: run.id, bundle_expired: matches.some(artifact => artifact.expired) });
        need(!runID || runID === run.id, 'product_release_resume_must_use_original_bundle', { original_run_id: run.id });
        runID = run.id; break;
      }
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...context.repo, run_id: run.id, filter: 'all', per_page: 100 });
      need(!jobs.some(job => job.steps?.some(step => step.name === 'Freeze original image and worker bytes before any publication' && step.conclusion === 'success')),
        'product_release_original_bundle_unavailable', { original_run_id: run.id, original_freeze_verified: true, artifact_record_missing: true });
    }
  }
  if (!runID) { need(!reserved, 'product_release_original_bundle_unavailable'); return null; }
  need(Number.isSafeInteger(runID) && runID > 0 && (runID !== context.runId || context.runAttempt > 1), 'product_release_resume_run_invalid');
  const run = (await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runID })).data;
  need(run.workflow_id === workflow.id && run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
    run.repository.full_name === repository && run.head_repository.full_name === repository && run.actor.login === 'Z-M-Huang', 'product_release_resume_run_untrusted');
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...context.repo, run_id: runID, per_page: 100 });
  const matches = artifacts.filter(artifact => artifact.name === bundleName(prepared) && !artifact.expired);
  need(matches.length === 1, 'product_release_original_bundle_unavailable');
  logEvent(null, 'info', 'product.release.bundle_resumed', { source_sha: prepared.source_sha, version: prepared.version, original_run_id: runID, artifact_id: matches[0].id });
  return { run_id: runID, artifact_id: matches[0].id };
  } catch (error) {
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_recovery_api_failed', {
      operation_id: `release-${context.runId}-${context.runAttempt ?? 1}`, run_id: context.runId, attempt: context.runAttempt ?? 1,
      operation, destination: operation === 'version_reservation_lookup' ? 'git_tag/' + prepared.tag : 'original_bundle',
      source_sha: prepared.source_sha, version: prepared.version, expected_source: prepared.source_sha, observed_source: 'unavailable',
      expected_digest: 'unavailable', observed_digest: 'unavailable', duration_ms: Date.now() - started,
      ...(error instanceof ReleaseFailure ? error.fields : {}), http_status: Number.isInteger(error.status) ? error.status : null,
      raw_output_omitted: true, omission_reason: 'credential_protection', outcome: 'blocked' });
  }
}

export const bundleName = prepared => `release-bundle-${prepared.version}-${prepared.source_sha}`;
