import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { logEvent } from './ci-log.mjs';

export function selectLanguages(paths) {
  const languages = ['actions'];
  if (paths.some(path => /\.go$/i.test(path))) languages.push('go');
  if (paths.some(path => /\.(?:[cm]?[jt]s|[jt]sx)$/i.test(path))) {
    languages.push('javascript-typescript');
  }
  return languages;
}

export function analysisProblems(languages, jobs, runAttempt) {
  if (!Array.isArray(languages) || !languages.includes('actions') ||
      new Set(languages).size !== languages.length ||
      languages.some(language => !['actions', 'go', 'javascript-typescript'].includes(language))) {
    throw new Error('Invalid required CodeQL language selection.');
  }
  if (!Number.isSafeInteger(runAttempt) || runAttempt < 1) {
    throw new Error('Invalid CodeQL run attempt.');
  }
  return languages.flatMap(language => {
    const executions = jobs.filter(job => job.name === `Analyze (${language})`);
    const malformed = executions.some(job => !Number.isSafeInteger(job.run_attempt) || job.run_attempt < 1);
    const eligible = executions.filter(job => job.run_attempt <= runAttempt);
    const latest = Math.max(0, ...eligible.map(job => job.run_attempt));
    const matches = eligible.filter(job => job.run_attempt === latest);
    if (malformed || matches.length !== 1 || matches[0].status !== 'completed' ||
        matches[0].conclusion !== 'success') {
      return [{ language, latest_attempt: latest, executions: matches.map(job => ({
        id: job.id, status: job.status, conclusion: job.conclusion,
      })), reason: malformed ? 'invalid_attempt_metadata' : 'no_unique_latest_success' }];
    }
    return [];
  });
}

export async function requireAnalyses({ github, context, core, languages, runAttempt }) {
  try {
    const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
      ...context.repo, run_id: context.runId, filter: 'all', per_page: 100,
    });
    const problems = analysisProblems(languages, jobs, runAttempt);
    logEvent(core, problems.length ? 'error' : 'info', 'codeql.result', {
      run_id: context.runId, run_attempt: runAttempt, source_sha: context.sha,
      languages, problems, outcome: problems.length ? 'failure' : 'success',
    });
    if (problems.length) core.setFailed('Every required CodeQL language needs a unique latest successful execution.');
    return problems;
  } catch (error) {
    logEvent(core, 'error', 'codeql.failed', {
      run_id: context.runId, reason: 'selection_or_jobs_unavailable',
      http_status: Number.isInteger(error?.status) ? error.status : null,
    });
    core.setFailed('Cannot establish complete CodeQL analysis evidence.');
    return null;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const paths = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  process.stdout.write(JSON.stringify(selectLanguages(paths)) + '\n');
}
