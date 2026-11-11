import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

export const componentNames = ['service', 'worker', 'ci-helpers', 'tools', 'worker-scripts', 'portal'];
export const isTest = path => /(?:^|\/)(?:test|tests|__tests__)\//.test(path) || /(?:\.test\.[cm]?[jt]sx?|_test\.go)$/.test(path);

export function componentsFor(paths) {
  const components = Object.fromEntries(componentNames.map(name => [name, []]));
  for (const path of paths) {
    if (isTest(path)) continue;
    if (path.endsWith('.go')) components.service.push(path);
    else if (/^worker\/src\/.*\.[cm]?[jt]sx?$/.test(path)) components.worker.push(path);
    else if (/^portal\/src\/.*\.[cm]?[jt]sx?$/.test(path)) components.portal.push(path);
    else if (/\.[cm]?js$/.test(path)) {
      const name = path.startsWith('.github/scripts/') ? 'ci-helpers' : path.startsWith('tools/') ? 'tools' : path.startsWith('worker/scripts/') ? 'worker-scripts' : null;
      if (!name) throw new Error(`unowned_production_module:${path}`);
      components[name].push(path);
    } else if (/\.[cm]?tsx?$/.test(path)) throw new Error(`unowned_production_module:${path}`);
  }
  return Object.fromEntries(Object.entries(components).filter(([name, files]) => files.length || (name === 'portal' && paths.some(path => path === 'portal/package.json' || path.startsWith('portal/src/')))).map(([name, files]) => [name, files.sort()]));
}

export function inspectSource(root = process.cwd(), execute = execFileSync, read = readFileSync, stat = statSync) {
  const git = args => execute('git', ['--no-optional-locks', ...args], { cwd: root, encoding: 'utf8' });
  const paths = [...new Set(git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean))].sort();
  const sha = git(['rev-parse', 'HEAD']).trim();
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('invalid_source_sha');
  const hash = createHash('sha256');
  for (const path of paths) hash.update(path + '\0' + Number((stat(join(root, path)).mode & 0o111) !== 0) + '\0').update(read(join(root, path))).update('\0');
  return { paths, components: componentsFor(paths), identity: { sha, dirty: !!git(['status', '--porcelain', '--untracked-files=all']).trim(), tree_sha256: hash.digest('hex') } };
}
