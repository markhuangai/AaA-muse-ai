import { logEvent } from './ci-log.mjs';

const repository = 'markhuangai/AaA-muse-ai';
const validSHA = /^[a-f0-9]{40}$/;
const writers = new Set(['admin', 'maintain', 'write']);

export function imageConfigDigest(inspected) {
  const digest = inspected.Descriptor ? inspected.Descriptor.annotations?.['config.digest'] : inspected.Id;
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) throw new Error('image_config_digest_unavailable');
  return digest;
}

export async function resolveCandidate({ github, context, sourceSHA }) {
  if (context.eventName !== 'workflow_dispatch' || context.ref !== 'refs/heads/main' ||
      `${context.repo.owner}/${context.repo.repo}` !== repository || !validSHA.test(sourceSHA)) {
    throw new Error('candidate_untrusted_trigger_or_source');
  }
  const permission = await github.rest.repos.getCollaboratorPermissionLevel({ ...context.repo, username: context.actor });
  if (!writers.has(permission.data.permission)) throw new Error('candidate_actor_not_authorized');
  const repo = (await github.rest.repos.get(context.repo)).data;
  if (repo.default_branch !== 'main') throw new Error('candidate_default_branch_mismatch');
  const commit = (await github.rest.repos.getCommit({ ...context.repo, ref: sourceSHA })).data;
  if (commit.sha !== sourceSHA || !validSHA.test(commit.commit.tree.sha)) throw new Error('candidate_source_identity_mismatch');
  const comparison = (await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${sourceSHA}...main` })).data;
  let pr = null;
  if (comparison.merge_base_commit.sha !== sourceSHA) {
    const pulls = await github.paginate(github.rest.pulls.list, { ...context.repo, state: 'open', base: 'main', per_page: 100 });
    const matches = pulls.filter(pull => !pull.draft && pull.state === 'open' && pull.base.ref === 'main' &&
      pull.base.repo.id === repo.id && pull.head.repo?.id === repo.id && pull.head.sha === sourceSHA);
    if (matches.length !== 1) throw new Error('candidate_requires_unique_current_same_repository_pr');
    pr = matches[0].number;
  }
  const result = { source_sha: sourceSHA, tree_sha: commit.commit.tree.sha, pr, actor: context.actor };
  logEvent(null, 'info', 'candidate.source_verified', result);
  return result;
}

export async function fenceCandidate({ github, context, sourceSHA, pr }) {
  if (pr) {
    const pull = (await github.rest.pulls.get({ ...context.repo, pull_number: Number(pr) })).data;
    if (pull.state !== 'open' || pull.draft || pull.base.ref !== 'main' ||
        pull.head.sha !== sourceSHA || pull.head.repo.full_name !== repository || pull.base.repo.full_name !== repository) {
      throw new Error('candidate_head_changed');
    }
  } else {
    const comparison = (await github.rest.repos.compareCommitsWithBasehead({ ...context.repo, basehead: `${sourceSHA}...main` })).data;
    if (comparison.merge_base_commit.sha !== sourceSHA) throw new Error('candidate_main_ancestry_changed');
  }
}

export async function resolvePublication({ github, context }) {
  const run = context.payload.workflow_run;
  if (context.eventName !== 'workflow_run' || `${context.repo.owner}/${context.repo.repo}` !== repository ||
      run?.event !== 'push' || run.conclusion !== 'success' || run.head_branch !== 'main' ||
      run.repository?.full_name !== repository || run.head_repository?.full_name !== repository || !validSHA.test(run.head_sha)) {
    throw new Error('publication_requires_successful_main_ci');
  }
  const workflow = (await github.rest.actions.getWorkflow({ ...context.repo, workflow_id: 'ci.yml' })).data;
  if (run.workflow_id !== workflow.id || workflow.path !== '.github/workflows/ci.yml') throw new Error('publication_untrusted_ci_workflow');
  const main = (await github.rest.repos.getBranch({ ...context.repo, branch: 'main' })).data;
  if (main.commit.sha !== run.head_sha) throw new Error('publication_main_head_changed');
  const pulls = await github.paginate(github.rest.repos.listPullRequestsAssociatedWithCommit, { ...context.repo, commit_sha: run.head_sha, per_page: 100 });
  const merged = pulls.filter(pull => pull.merged_at && pull.merge_commit_sha === run.head_sha &&
    pull.base.ref === 'main' && pull.base.repo.full_name === repository);
  if (merged.length !== 1) throw new Error('publication_requires_merged_pr');
  logEvent(null, 'info', 'publication.source_verified', { source_sha: run.head_sha, ci_run_id: run.id, pr: merged[0].number });
  return run.head_sha;
}

export async function registryManifest({ fetcher = fetch, token, image, tag, expectedConfig }) {
  const auth = await fetcher(`https://ghcr.io/token?service=ghcr.io&scope=repository:${image}:pull,push`, {
    headers: { Authorization: `Basic ${Buffer.from(`${process.env.GITHUB_ACTOR}:${token}`).toString('base64')}` },
  });
  if (!auth.ok) throw new Error(`registry_auth_failed_http_${auth.status}`);
  const bearer = (await auth.json()).token;
  if (!bearer) throw new Error('registry_token_missing');
  const response = await fetcher(`https://ghcr.io/v2/${image}/manifests/${tag}`, {
    headers: { Authorization: `Bearer ${bearer}`, Accept: 'application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' },
  });
  if (response.status === 404) return { exists: false };
  if (!response.ok) throw new Error(`registry_manifest_failed_http_${response.status}`);
  const manifest = await response.json();
  const digest = response.headers.get('docker-content-digest');
  if (manifest.config?.digest !== expectedConfig || !/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) {
    throw new Error('registry_existing_artifact_conflict');
  }
  return { exists: true, digest };
}
