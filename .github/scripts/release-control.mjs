import { repository, need, sha, imageTags, sameRC, ReleaseFailure } from './release-manifest.mjs';
import { hasCompletionMarker, readProductRelease, latestStableRelease, nextPatch } from './release-history.mjs';
import { isFinalVersion, isRCTag, releaseVersion } from './release-versions.mjs';
import { npmPackage, registryImage } from './release-io.mjs';
import { verifyPublished } from './release-verify.mjs';
import { logEvent } from './ci-log.mjs';

export const workflowPath = '.github/workflows/release.yml';

export async function verifyReleaseDispatch({ github, context }) {
  need(context.eventName === 'workflow_dispatch' && context.ref === 'refs/heads/main' &&
    context.repo.owner + '/' + context.repo.repo === repository, 'product_release_untrusted_dispatch');
  const permission = (await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: context.actor })).data;
  need(permission.permission === 'admin', 'product_release_administrator_required');
}

export async function verifyMainSource({ github, context, manifest }) {
  const sourceSHA = manifest.source_sha;
  const verified = (await github.rest.repos.getCommit({ ...context.repo, ref: sourceSHA })).data;
  need(verified.sha === sourceSHA && verified.commit?.tree?.sha === manifest.tree_sha,
    'product_release_source_identity_mismatch', {
      expected_source: sourceSHA, observed_source: sha(verified.sha) ? verified.sha : 'invalid',
      expected_tree: manifest.tree_sha, observed_tree: sha(verified.commit?.tree?.sha) ? verified.commit.tree.sha : 'invalid' });
  const comparison = (await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: sourceSHA + '...main' })).data;
  need(comparison.merge_base_commit.sha === sourceSHA, 'product_release_source_not_on_main', {
    expected_source: sourceSHA, observed_source: comparison.merge_base_commit.sha });
  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { ...context.repo, commit_sha: sourceSHA, per_page: 100 });
  const merged = pulls.filter(pull => pull.merged_at && pull.merge_commit_sha === sourceSHA && pull.base.ref === 'main' &&
    pull.base.repo.full_name === repository);
  need(merged.length === 1, 'product_release_requires_merged_source', { source_sha: sourceSHA });
  const runs = [];
  for (const workflow_id of ['ci.yml', 'codeql.yml']) {
    const result = (await github.rest.actions.listWorkflowRuns({ ...context.repo, workflow_id, head_sha: sourceSHA, event: 'push', per_page: 100 })).data;
    const run = result.workflow_runs.filter(item => item.head_sha === sourceSHA && item.head_branch === 'main').sort((a, b) => b.id - a.id)[0];
    need(run?.status === 'completed' && run.conclusion === 'success', 'product_release_required_main_checks_missing', { workflow: workflow_id });
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...context.repo, run_id: run.id, filter: 'latest', per_page: 100 });
    need(jobs.length && jobs.every(job => job.conclusion === 'success'), 'product_release_main_jobs_incomplete', { workflow: workflow_id });
    if (workflow_id === 'ci.yml') need(jobs.some(job => job.name === 'Release / verify'), 'product_release_main_verifier_missing');
    runs.push(run.id);
  }
  logEvent(null, 'info', 'product.release.source_verified', { source_sha: sourceSHA, tree_sha: manifest.tree_sha,
    version: manifest.version, pr: merged[0].number, main_runs: runs, actor: context.actor, run_id: context.runId });
}

export const listReleases = ({ github, context }) =>
  github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });

export async function latestCompleteRC({ github, context, token, fetcher = fetch, releases, prior }) {
  const patch = nextPatch(prior);
  const candidates = releases.filter(release => !release.draft && release.prerelease && isRCTag(release.tag_name) &&
    releaseVersion(release.tag_name.slice(1)).patch === patch && hasCompletionMarker(release))
    .sort((a, b) => releaseVersion(b.tag_name.slice(1)).rc - releaseVersion(a.tag_name.slice(1)).rc);
  const release = candidates[0];
  need(release && candidates[1]?.tag_name !== release.tag_name, 'product_release_latest_rc_unavailable', { active_patch: patch });
  const { manifest, manifestSHA256 } = await readProductRelease(release, fetcher);
  need(manifest.publication_kind === 'rc', 'product_release_rc_manifest_required');
  await verifyMainSource({ github, context, manifest });
  await verifyPublished({ tag: release.tag_name, sourceSHA: manifest.source_sha, manifestSHA256, token, fetcher });
  const source_rc = { tag: release.tag_name, manifest_sha256: manifestSHA256 };
  logEvent(null, 'info', 'product.release.latest_rc_verified', { operation_id: operationID(context),
    run_id: context.runId, attempt: context.runAttempt ?? 1, source_rc, source_sha: manifest.source_sha,
    tree_sha: manifest.tree_sha, version: manifest.version, outcome: 'verified' });
  return { source_rc, source_sha: manifest.source_sha, tree_sha: manifest.tree_sha };
}

export function requireCurrentRC(prepared, selected) {
  need(sameRC(prepared.source_rc, selected.source_rc) && prepared.source_sha === selected.source_sha && prepared.tree_sha === selected.tree_sha,
    'product_release_stale_rc', { expected_rc: prepared.source_rc.tag, observed_rc: selected.source_rc.tag,
      expected_digest: prepared.source_rc.manifest_sha256, observed_digest: selected.source_rc.manifest_sha256,
      expected_source: prepared.source_sha, observed_source: selected.source_sha });
}

function finalAllocation(refs, releases, versions, selected, minimum) {
  const finals = refs.filter(ref => ref.ref.startsWith('refs/tags/v') && isFinalVersion(ref.ref.slice(11)));
  const reserved = finals.filter(ref => ref.object.type === 'commit' && ref.object.sha === selected.source_sha &&
    releaseVersion(ref.ref.slice(11)).patch >= minimum);
  need(reserved.length <= 1, 'product_release_ambiguous_final_reservation', { source_sha: selected.source_sha });
  if (reserved.length) return reserved[0].ref.slice(11);
  const occupied = [...finals.map(ref => ref.ref.slice(11)),
    ...releases.filter(release => release.tag_name?.startsWith('v')).map(release => release.tag_name.slice(1)), ...versions]
    .filter(isFinalVersion);
  const patch = occupied.reduce((next, version) => Math.max(next, releaseVersion(version).patch + 1), minimum);
  need(Number.isSafeInteger(patch), 'product_release_version_overflow');
  return '0.1.' + patch;
}

export async function prepareCandidate({ github, context, requestedVersion, resumeRunID, token, fetcher = fetch }) {
  const started = Date.now();
  let operation = 'dispatch_verification', prepared, selected;
  try {
    await verifyReleaseDispatch({ github, context });
    need(!requestedVersion, 'product_release_candidate_version_is_automatic', { expected_version: 'automatic',
      observed_version: isFinalVersion(requestedVersion) ? requestedVersion : 'invalid' });
    operation = 'latest_rc_selection';
    const releases = await listReleases({ github, context });
    const prior = await latestStableRelease(releases, fetcher);
    selected = await latestCompleteRC({ github, context, token, fetcher, releases, prior });
    operation = 'final_version_reservation';
    const refs = await github.paginate(github.rest.git.listMatchingRefs, { ...context.repo, ref: 'tags/v0.1.', per_page: 100 });
    const { versions } = await npmPackage({ token, fetcher });
    const version = finalAllocation(refs, releases, Object.keys(versions), selected, nextPatch(prior));
    prepared = { ...selected, version, tag: 'v' + version, candidate: true, paired: true, should_publish: true };
    const recovery = await candidateRecovery({ github, context, prepared, resumeRunID });
    if (!recovery) {
      need(!versions[version] && !releases.some(release => release.tag_name === prepared.tag), 'product_release_version_destination_conflict');
      for (const destination of [...imageTags({ ...prepared, publication_kind: 'candidate' }), version]) {
        const image = await registryImage(destination, { token, fetcher, actor: context.actor });
        need(!image.exists, 'product_release_version_destination_conflict', { destination, observed_digest: image.digest });
      }
    }
    logEvent(null, 'info', 'product.release.candidate_prepared', { ...prepared, operation_id: operationID(context),
      run_id: context.runId, attempt: context.runAttempt ?? 1, duration_ms: Date.now() - started,
      resume_run_id: recovery?.run_id ?? null });
    return { ...prepared, resume_run_id: recovery?.run_id ?? null };
  } catch (error) {
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_source_api_failed', {
      ...(error instanceof ReleaseFailure ? error.fields : {}),
      operation_id: operationID(context), run_id: context.runId, attempt: context.runAttempt ?? 1, operation,
      destination: error.fields?.destination ?? 'source_repository', source_sha: selected?.source_sha ?? error.fields?.source_sha ?? 'unavailable',
      version: prepared?.version ?? error.fields?.version ?? 'unavailable',
      expected_digest: error.fields?.expected_digest ?? selected?.source_rc.manifest_sha256 ?? 'unavailable',
      observed_digest: error.fields?.observed_digest ?? 'unavailable', duration_ms: Date.now() - started,
      completed_destinations: error.fields?.completed_destinations ?? [], missing_destinations: error.fields?.missing_destinations ?? [],
      outcome: 'blocked', raw_output_omitted: true, omission_reason: 'credential_protection',
      http_status: Number.isInteger(error.status) ? error.status : error.fields?.http_status ?? null,
      request_id: error.response?.headers?.['x-github-request-id'] ?? error.fields?.request_id ?? null });
  }
}

const operationID = context => 'release-' + context.runId + '-' + (context.runAttempt ?? 1);

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
      need(!jobs.some(job => job.name === candidateBuildName(prepared) &&
        job.steps?.some(step => step.name === 'Freeze original image and worker bytes before any publication' && step.conclusion === 'success')),
        'product_release_original_bundle_unavailable', { original_run_id: run.id, original_freeze_verified: true, artifact_record_missing: true });
    }
  }
  if (!runID) { need(!reserved, 'product_release_original_bundle_unavailable'); return null; }
  need(Number.isSafeInteger(runID) && runID > 0 && (runID !== context.runId || context.runAttempt > 1), 'product_release_resume_run_invalid');
  const run = (await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runID })).data;
  need(run.workflow_id === workflow.id && run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
    run.repository.full_name === repository && run.head_repository.full_name === repository, 'product_release_resume_run_untrusted');
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

export const candidateBuildName = prepared => 'Build final candidate ' + prepared.version + ' from ' + prepared.source_sha;
