import { repository, need, sha, imageTags, sameDigest, sameRC, ReleaseFailure } from './release-manifest.mjs';
import { hasCompletionMarker, latestStableRelease, nextRCBase, readProductRelease, releaseAsset } from './release-history.mjs';
import { baseVersion, isFinalVersion, isNextStable, isRCTag, releaseVersion } from './release-versions.mjs';
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
    version: manifest.version, pr: merged[0].number, main_runs: runs, actor: context.actor,
    ...releaseOperation(context) });
}

export const listReleases = ({ github, context }) =>
  github.paginate(github.rest.repos.listReleases, { ...context.repo, per_page: 100 });

export async function latestCompleteRC({ github, context, token, fetcher = fetch, releases, prior }) {
  const activeBase = nextRCBase(prior);
  const candidates = releases.filter(release => !release.draft && release.prerelease && isRCTag(release.tag_name) &&
    baseVersion(releaseVersion(release.tag_name.slice(1))) === activeBase && hasCompletionMarker(release))
    .sort((a, b) => releaseVersion(b.tag_name.slice(1)).rc - releaseVersion(a.tag_name.slice(1)).rc);
  const release = candidates[0];
  need(release && candidates[1]?.tag_name !== release.tag_name, 'product_release_latest_rc_unavailable', { active_series: activeBase });
  return verifyRC({ github, context, token, fetcher, release });
}

export function historicalRC(tag) {
  return isRCTag(tag) && releaseVersion(tag.slice(1)).major === 0;
}

export async function verifyHistoricalRC({ github, context, token, fetcher, releases, tag }) {
  const matches = releases.filter(release => historicalRC(tag) && release.tag_name === tag &&
    !release.draft && release.prerelease && hasCompletionMarker(release));
  need(matches.length === 1, 'product_release_historical_rc_unavailable', { expected_rc: tag });
  return verifyRC({ github, context, token, fetcher, release: matches[0] });
}

async function verifyRC({ github, context, token, fetcher, release }) {
  const { manifest, manifestSHA256 } = await readProductRelease(release, fetcher);
  need(manifest.publication_kind === 'rc', 'product_release_rc_manifest_required');
  await verifyMainSource({ github, context, manifest });
  await verifyPublished({ tag: release.tag_name, sourceSHA: manifest.source_sha, manifestSHA256, token, fetcher });
  const source_rc = { tag: release.tag_name, manifest_sha256: manifestSHA256 };
  logEvent(null, 'info', 'product.release.latest_rc_verified', { ...releaseOperation(context), source_rc, source_sha: manifest.source_sha,
    tree_sha: manifest.tree_sha, version: manifest.version, outcome: 'verified' });
  return { source_rc, source_sha: manifest.source_sha, tree_sha: manifest.tree_sha };
}

export function requireCurrentRC(prepared, selected) {
  need(sameRC(prepared.source_rc, selected.source_rc) && prepared.source_sha === selected.source_sha && prepared.tree_sha === selected.tree_sha,
    'product_release_stale_rc', { expected_rc: prepared.source_rc.tag, observed_rc: selected.source_rc.tag,
      expected_digest: prepared.source_rc.manifest_sha256, observed_digest: selected.source_rc.manifest_sha256,
      expected_source: prepared.source_sha, observed_source: selected.source_sha });
}

export function requireStableTarget(version, prior) {
  need(isNextStable(version, prior?.version), 'product_release_stable_version_step_invalid', {
    observed_version: version, prior_stable_version: prior?.version ?? null, active_series: nextRCBase(prior),
  });
}

export function requireCutoverMajor(version, prereleaseTag) {
  const source = releaseVersion(prereleaseTag?.slice(1));
  const target = releaseVersion(version);
  need(source && target && source.major === target.major, 'product_release_source_target_major_mismatch', {
    source_rc: prereleaseTag, observed_version: version,
  });
}

export async function prepareStableRelease({ github, context, prereleaseTag, version, token, fetcher = fetch }) {
  const started = Date.now();
  let operation = 'dispatch_verification', prepared, selected;
  try {
    await verifyReleaseDispatch({ github, context });
    need(isRCTag(prereleaseTag) && isFinalVersion(version), 'product_release_dispatch_inputs_invalid');
    operation = 'final_version_reservation';
    const tag = 'v' + version;
    const releases = await listReleases({ github, context });
    const target = releases.find(release => release.tag_name === tag);
    const stable = await registryImage(version, { token, fetcher, actor: context.actor });
    const identity = { version, tag, candidate: true, paired: true, should_publish: true };
    let startedPromotion = false;
    if (target && hasCompletionMarker(target)) {
      const { manifest, manifestSHA256 } = await readProductRelease(target, fetcher);
      need(manifest.publication_kind === 'candidate' && manifest.source_rc?.tag === prereleaseTag,
        'product_release_version_destination_conflict', { destination: tag, expected_rc: prereleaseTag, observed_rc: manifest.source_rc?.tag ?? null,
          observed_source: manifest.source_sha, observed_digest: manifestSHA256 });
      prepared = { ...identity, source_sha: manifest.source_sha, tree_sha: manifest.tree_sha, source_rc: manifest.source_rc,
        candidate_ready: true, manifest_sha256: manifestSHA256 };
      startedPromotion = releaseAsset(target, 'promotion.json') !== undefined || (stable.exists && releaseAsset(target, 'promotion-intent.json') !== undefined);
      if (stable.exists && startedPromotion) sameDigest(stable.digest, manifest.image.split('@')[1], version);
    }
    need(!stable.exists || startedPromotion, 'product_release_version_destination_conflict', { destination: version, observed_digest: stable.digest });

    const recoveryOnly = !startedPromotion && historicalRC(prereleaseTag);
    if (recoveryOnly) {
      requireCutoverMajor(version, prereleaseTag);
      operation = 'historical_bundle_selection';
      selected = await verifyHistoricalRC({ github, context, token, fetcher, releases, tag: prereleaseTag });
      if (prepared) requireCurrentRC(prepared, selected);
      prepared ??= { ...selected, ...identity, candidate_ready: false };
      const recovery = await candidateRecovery({ github, context, prepared });
      need(recovery, 'product_release_original_bundle_unavailable');
      prepared.recovery_only = true;
      prepared.resume_run_id = recovery.run_id;
      prepared.resume_artifact_id = recovery.artifact_id;
      if (prepared.candidate_ready) await verifyPublished({ tag, sourceSHA: prepared.source_sha,
        manifestSHA256: prepared.manifest_sha256, token, fetcher });
    } else if (!startedPromotion) {
      requireCutoverMajor(version, prereleaseTag);
      operation = 'latest_rc_selection';
      const prior = await latestStableRelease(releases, fetcher);
      selected = await latestCompleteRC({ github, context, token, fetcher, releases, prior });
      need(selected.source_rc.tag === prereleaseTag, 'product_release_stale_rc', {
        expected_rc: prereleaseTag, observed_rc: selected.source_rc.tag, observed_source: selected.source_sha,
        observed_digest: selected.source_rc.manifest_sha256,
      });
      requireStableTarget(version, prior);
      if (prepared) requireCurrentRC(prepared, selected);
    }

    if (!prepared) {
      operation = 'final_version_reservation';
      prepared = { ...selected, ...identity, candidate_ready: false };
      const recovery = await candidateRecovery({ github, context, prepared });
      prepared.resume_run_id = recovery?.run_id ?? null;
      prepared.resume_artifact_id = recovery?.artifact_id ?? null;
      if (!recovery) {
        const { versions } = await npmPackage({ token, fetcher });
        need(!target && !versions[version], 'product_release_version_destination_conflict', {
          destination: target ? tag : 'github_packages', observed_version: version,
        });
        for (const destination of imageTags({ ...prepared, publication_kind: 'candidate' })) {
          const image = await registryImage(destination, { token, fetcher, actor: context.actor });
          need(!image.exists, 'product_release_version_destination_conflict', { destination, observed_digest: image.digest });
        }
      }
    }
    logEvent(null, 'info', 'product.release.stable_prepared', { ...prepared, ...releaseOperation(context),
      actor: context.actor, duration_ms: Date.now() - started });
    return prepared;
  } catch (error) {
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_source_api_failed', {
      ...(error instanceof ReleaseFailure ? error.fields : {}),
      ...releaseOperation(context), operation,
      prerelease_tag: isRCTag(prereleaseTag) ? prereleaseTag : 'invalid', actor: context.actor,
      destination: error.fields?.destination ?? 'source_repository', source_sha: selected?.source_sha ?? prepared?.source_sha ?? error.fields?.source_sha ?? 'unavailable',
      version: isFinalVersion(version) ? version : 'invalid',
      expected_digest: error.fields?.expected_digest ?? prepared?.source_rc.manifest_sha256 ?? 'unavailable',
      observed_digest: error.fields?.observed_digest ?? 'unavailable', duration_ms: Date.now() - started,
      completed_destinations: error.fields?.completed_destinations ?? [], missing_destinations: error.fields?.missing_destinations ?? [],
      outcome: 'blocked', raw_output_omitted: true, omission_reason: 'credential_protection',
      http_status: Number.isInteger(error.status) ? error.status : error.fields?.http_status ?? null,
      request_id: error.response?.headers?.['x-github-request-id'] ?? error.fields?.request_id ?? null });
  }
}

export function releaseOperation(context) {
  const attempt = context.runAttempt ?? Number(process.env.GITHUB_RUN_ATTEMPT ?? 1);
  return { operation_id: `release-${context.runId}-${attempt}`, run_id: context.runId, attempt };
}

export async function candidateRecovery({ github, context, prepared }) {
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
    let runID;
  operation = 'original_bundle_discovery';
    const runs = await github.paginate(github.rest.actions.listWorkflowRuns, {
      ...context.repo, workflow_id: workflow.id, event: 'workflow_dispatch', branch: 'main', per_page: 100,
    });
    const { attempt } = releaseOperation(context);
    for (const run of runs.filter(run => run.id !== context.runId || attempt > 1).sort((a, b) => a.id - b.id)) {
      const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...context.repo, run_id: run.id, per_page: 100 });
      const matches = artifacts.filter(artifact => artifact.name === bundleName(prepared));
      if (matches.length) {
        need(matches.length === 1 && !matches[0].expired, 'product_release_original_bundle_unavailable', { original_run_id: run.id, bundle_expired: matches.some(artifact => artifact.expired) });
        runID = run.id; break;
      }
      const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, { ...context.repo, run_id: run.id, filter: 'all', per_page: 100 });
      need(!jobs.some(job => job.name === candidateBuildName(prepared) &&
        job.steps?.some(step => step.name === 'Freeze original image and worker bytes before any publication' && step.conclusion === 'success')),
        'product_release_original_bundle_unavailable', { original_run_id: run.id, original_freeze_verified: true, artifact_record_missing: true });
    }
  if (!runID) { need(!reserved, 'product_release_original_bundle_unavailable'); return null; }
  need(Number.isSafeInteger(runID) && runID > 0, 'product_release_resume_run_invalid');
  const run = (await github.rest.actions.getWorkflowRun({ ...context.repo, run_id: runID })).data;
  need(run.workflow_id === workflow.id && run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
    run.repository.full_name === repository && run.head_repository.full_name === repository, 'product_release_resume_run_untrusted');
  const artifacts = await github.paginate(github.rest.actions.listWorkflowRunArtifacts, { ...context.repo, run_id: runID, per_page: 100 });
  const matches = artifacts.filter(artifact => artifact.name === bundleName(prepared));
  need(matches.length === 1 && !matches[0].expired && Number.isSafeInteger(matches[0].id) && matches[0].id > 0,
    'product_release_original_bundle_unavailable');
  logEvent(null, 'info', 'product.release.bundle_resumed', { ...releaseOperation(context),
    source_sha: prepared.source_sha, version: prepared.version, source_rc: prepared.source_rc, original_run_id: runID, artifact_id: matches[0].id });
  return { run_id: runID, artifact_id: matches[0].id };
  } catch (error) {
    throw new ReleaseFailure(error instanceof ReleaseFailure ? error.message : 'product_release_recovery_api_failed', {
      ...releaseOperation(context), operation, destination: operation === 'version_reservation_lookup' ? 'git_tag/' + prepared.tag : 'original_bundle',
      source_sha: prepared.source_sha, version: prepared.version, expected_source: prepared.source_sha, observed_source: 'unavailable',
      expected_digest: 'unavailable', observed_digest: 'unavailable', duration_ms: Date.now() - started,
      ...(error instanceof ReleaseFailure ? error.fields : {}), http_status: Number.isInteger(error.status) ? error.status : null,
      raw_output_omitted: true, omission_reason: 'credential_protection', outcome: 'blocked' });
  }
}

export const bundleName = prepared => `release-bundle-${prepared.version}-${prepared.source_sha}`;

export const candidateBuildName = prepared => 'Build final candidate ' + prepared.version + ' from ' + prepared.source_sha;
