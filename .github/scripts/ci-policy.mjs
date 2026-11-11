import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { logEvent } from './ci-log.mjs';

const standardRunners = new Set(['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04']);

export function workflowProblems(source, filename = 'workflow') {
  const document = parseDocument(source, { uniqueKeys: true });
  const invalid = (cause, message) => [{ workflow: filename, job: null, runner: null, timeout: null, maximum: 30, cause, message: `${filename}: ${message}` }];
  if (document.errors.length) return invalid('invalid_yaml', 'invalid YAML');
  const workflow = document.toJS();
  if (!workflow || typeof workflow.jobs !== 'object' || Array.isArray(workflow.jobs) ||
      !workflow.jobs || !Object.keys(workflow.jobs).length) return invalid('missing_jobs', 'jobs are missing');
  return Object.entries(workflow.jobs).flatMap(([name, job]) => {
    const errors = [];
    const prefix = `${filename}: jobs.${name}`;
    const maximum = filename === 'ai-pr-review.yml' && name === 'review' ? 45 : 30;
    const fields = { workflow: filename, job: name, runner: job?.['runs-on'] ?? null, timeout: job?.['timeout-minutes'] ?? null, maximum };
    if (!job || typeof job !== 'object' || Array.isArray(job)) return [{ ...fields, cause: 'invalid_job', message: `${prefix}: invalid job` }];
    if (!standardRunners.has(job['runs-on'])) errors.push({ ...fields, cause: 'unsupported_runner', message: `${prefix}: runs-on must be a literal standard hosted Ubuntu runner` });
    const timeout = job['timeout-minutes'];
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > maximum) {
      errors.push({ ...fields, cause: 'invalid_timeout', message: `${prefix}: timeout-minutes must be a literal integer from 1 through ${maximum}` });
    }
    return errors;
  });
}

export const checkWorkflow = (source, filename) => workflowProblems(source, filename).map(problem => problem.message);

export function directoryProblems(directory) {
  const files = readdirSync(directory).filter(file => /\.ya?ml$/.test(file)).sort();
  if (!files.length) return [{ workflow: directory, job: null, runner: null, timeout: null, maximum: 30, cause: 'missing_workflows', message: 'No workflow files found.' }];
  return files.flatMap(file => workflowProblems(readFileSync(join(directory, file), 'utf8'), file));
}

export const checkDirectory = directory => directoryProblems(directory).map(problem => problem.message);

export function main(directory = '.github/workflows', emit = logEvent) {
  try {
    const problems = directoryProblems(directory);
    for (const problem of problems) emit(null, 'error', 'ci.budget_rejected', problem);
    emit(null, 'info', 'ci.policy', { problems, outcome: problems.length ? 'failed' : 'passed' });
    return problems.length ? 1 : 0;
  } catch (error) {
    emit(null, 'error', 'ci.budget_rejected', { workflow: directory, job: null, runner: null, timeout: null, maximum: 30, cause: error.code ?? error.message });
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = main(process.argv[2]);
