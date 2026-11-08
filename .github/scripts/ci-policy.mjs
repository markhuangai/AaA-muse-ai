import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseDocument } from 'yaml';
import { logEvent } from './ci-log.mjs';

const standardRunners = new Set(['ubuntu-latest', 'ubuntu-24.04', 'ubuntu-22.04']);

export function checkWorkflow(source, filename = 'workflow') {
  const document = parseDocument(source, { uniqueKeys: true });
  if (document.errors.length) return [`${filename}: invalid YAML`];
  const workflow = document.toJS();
  if (!workflow || typeof workflow.jobs !== 'object' || Array.isArray(workflow.jobs) ||
      !workflow.jobs || !Object.keys(workflow.jobs).length) return [`${filename}: jobs are missing`];
  return Object.entries(workflow.jobs).flatMap(([name, job]) => {
    const errors = [];
    const prefix = `${filename}: jobs.${name}`;
    if (!job || typeof job !== 'object') return [`${prefix}: invalid job`];
    if (!standardRunners.has(job['runs-on'])) errors.push(`${prefix}: runs-on must be a literal standard hosted Ubuntu runner`);
    const timeout = job['timeout-minutes'];
    if (!Number.isInteger(timeout) || timeout < 1 || timeout > 30) {
      errors.push(`${prefix}: timeout-minutes must be a literal integer from 1 through 30`);
    }
    return errors;
  });
}

export function checkDirectory(directory) {
  const files = readdirSync(directory).filter(file => /\.ya?ml$/.test(file)).sort();
  if (!files.length) return ['No workflow files found.'];
  return files.flatMap(file => checkWorkflow(readFileSync(join(directory, file), 'utf8'), file));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const errors = checkDirectory(process.argv[2] ?? '.github/workflows');
  logEvent(null, errors.length ? 'error' : 'info', 'ci.policy', { errors, outcome: errors.length ? 'failure' : 'success' });
  if (errors.length) process.exitCode = 1;
}
