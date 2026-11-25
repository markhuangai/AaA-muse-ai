import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { promisify } from 'node:util';
import { Failure, cause, requireValue } from './errors.js';
import { object, parse, text, type ObjectValue, type Value } from './json.js';
import { prepareManagedAssets, renderManagedAssets, type InstallationIO } from './install-io.js';
import type { State } from './state.js';

export const updateContract = 'managed-hook-v1';
const packageName = '@markhuangai/aaa-muse-worker';
const releaseBase = 'https://github.com/markhuangai/AaA-muse-ai/releases/download/';
const versionPattern = /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-(dev|rc)\.(0|[1-9][0-9]*))?$/;
export const archiveDigest = /^[a-f0-9]{64}$/;
const command = promisify(execFile);

export function updateTarget(value: Value | undefined): ObjectValue {
  const target = object(value);
  const version = text(target.version);
  requireValue(version.length <= 100 && version.startsWith('1.') && versionPattern.test(version) && !version.includes('-dev.') &&
    target.name === packageName && target.contract === updateContract &&
    archiveDigest.test(text(target.sha256)) && /^[a-f0-9]{40}$/.test(text(target.source_sha)) &&
    /^(?:[1-9][0-9]*(?:,[1-9][0-9]*)*)?$/.test(text(target.from_majors)) &&
    target.url === releaseBase + 'v' + version + '/markhuangai-aaa-muse-worker-' + version + '.tgz', 'candidate_incompatible');
  return target;
}

function releaseOrder(version: string): bigint[] | undefined {
  const parts = version.length <= 100 ? versionPattern.exec(version) : null;
  if (parts?.[1] !== '1') return;
  const [, , minor, patch, prerelease, number] = parts;
  return [BigInt(minor), BigInt(patch), prerelease === 'dev' ? 0n : prerelease === 'rc' ? 1n : 2n, BigInt(number ?? 0)];
}

export function supportsSource(target: ObjectValue, version: string): boolean {
  const from = releaseOrder(version), to = releaseOrder(text(target.version));
  if (!from || !to) return false;
  const firstDifference = to.findIndex((part, index) => part !== from[index]);
  return firstDifference >= 0 && to[firstDifference] > from[firstDifference];
}

async function verifyAssetTemplates(entry: string): Promise<void> {
  const setup = join(dirname(dirname(entry)), 'setup');
  try {
    await renderManagedAssets(file => readFile(join(setup, file), 'utf8'),
      { launcher: '/launcher', worker_id: 'worker', origin: 'https://example.invalid' }, '/state');
    await command('bash', ['-n', join(setup, 'hook.sh')], { timeout: 2_000, maxBuffer: 4096 });
  } catch (error) {
    throw new Failure('candidate_incompatible', { stage: 'managed_asset_verification', asset_error: cause(error) });
  }
}

export async function preflightLegacyUpdate(io: InstallationIO, state: State, version: string, hookID: string): Promise<void> {
  if (!/^update\.[A-Za-z0-9]+$/.test(basename(dirname(dirname(dirname(io.entry)))))) return;
  const raw = await state.read('cron-update.json');
  if (!raw) return;
  const attempt = object(parse(raw));
  if (attempt.stage !== 'downloading' || object(attempt.target).version !== version) return;
  const installed = await state.read('installation.json');
  requireValue(installed, 'worker_setup_required');
  const installation = object(parse(installed));
  if (installation.skill_path !== undefined) return;
  requireValue(hookID === 'aaa-muse-worker-' + installation.worker_id && installation.entry !== io.entry, 'worker_identity_mismatch');
  verifyInstallEntry(text(installation.root), io.entry);
  await verifyAssetTemplates(io.entry);
  await prepareManagedAssets(io, state, installation, true);
}

export async function verifyCandidate(io: InstallationIO, entry: string, target: ObjectValue): Promise<void> {
  const root = dirname(dirname(entry));
  const build = object(parse(await readFile(join(root, 'dist/build.json'), 'utf8')));
  const metadata = object(parse(await readFile(join(root, 'package.json'), 'utf8')));
  const supported = object(metadata.aaa_muse_update);
  requireValue(metadata.name === target.name && metadata.version === target.version && build.package_version === target.version &&
    build.source_sha === target.source_sha && supported.contract === target.contract && supported.from_majors === target.from_majors, 'candidate_incompatible', {
    expected_source: target.source_sha, observed_source: build.source_sha, expected_version: target.version, observed_version: metadata.version,
    expected_contract: target.contract, observed_contract: supported.contract, expected_from_majors: target.from_majors, observed_from_majors: supported.from_majors,
  });
  await verifyAssetTemplates(entry);
  const { stdout } = await command(io.node, [entry, '--version'], { timeout: 5_000, maxBuffer: 4096 });
  requireValue(stdout.trim() === target.version, 'candidate_incompatible', { expected_version: target.version, observed_version: stdout.trim() });
}

export interface UpdateArchiveIO {
  stage(root: string, target: ObjectValue): Promise<{ entry: string; observed_digest: string; http_status: string }>;
  verify(entry: string, target: ObjectValue): Promise<void>;
}

export function updateArchiveIO(io: InstallationIO): UpdateArchiveIO {
  return {
    verify: (entry, target) => verifyCandidate(io, entry, target),
    async stage(root, target) {
      const releases = join(root, 'releases');
      await io.prepareDirectory(releases, 'install_directory');
      const staging = await mkdtemp(join(releases, 'update.'));
      const archive = join(staging, 'worker.tgz');
      let httpStatus = '';
      try {
        try {
          const result = await command('curl', ['-q', '--fail', '--silent', '--show-error', '--location', '--max-redirs', '5',
            '--proto', '=https', '--proto-redir', '=https', '--connect-timeout', '8', '--max-time', '25',
            '--max-filesize', '16777216', '--write-out', '%{http_code}', '--output', archive, text(target.url)], { maxBuffer: 4096, timeout: 27_000 });
          httpStatus = result.stdout;
        } catch (error) {
          const failed = error as { stdout?: string; code?: number | string };
          throw new Failure(failed.stdout === '404' ? 'archive_unavailable' : 'download_failed',
            { http_status: failed.stdout ?? '', download_exit: failed.code ?? '' });
        }
        const observed = createHash('sha256').update(await readFile(archive)).digest('hex');
        requireValue(observed === target.sha256, 'archive_digest_mismatch', { observed_digest: observed, http_status: httpStatus });
        try {
          const extractor = await io.asset('extract.sh');
          await command('bash', ['-c', extractor, 'aaa-muse-extract', archive, staging], { maxBuffer: 4096, timeout: 8_000 });
        } catch (error) {
          throw new Failure('archive_invalid', { observed_digest: observed, http_status: httpStatus, cause: cause(error) });
        }
        const entry = join(staging, 'package/dist/main.js');
        await verifyCandidate(io, entry, target);
        await rm(archive);
        return { entry, observed_digest: observed, http_status: httpStatus };
      } catch (error) {
        await rm(staging, { recursive: true, force: true });
        throw error;
      }
    },
  };
}

export function verifyInstallEntry(root: string, entry: string): void {
  const path = relative(join(root, 'releases'), entry);
  const parts = path.split('/');
  requireValue(resolve(entry) === entry && parts.length === 4 && /^(bundle|update)\.[A-Za-z0-9]+$/.test(parts[0]) &&
    parts[1] === 'package' && parts[2] === 'dist' && basename(entry) === 'main.js', 'update_entry_outside_installation');
}
