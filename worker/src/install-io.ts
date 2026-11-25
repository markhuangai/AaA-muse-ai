import { access, readFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { dirname, join } from 'node:path';
import { State } from './state.js';
import { digest } from './diagnostics.js';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Logger } from './diagnostics.js';
import { Failure, requireValue } from './errors.js';
import { identifier, object, parse, text, type ObjectValue } from './json.js';

export function shellQuote(value: string): string { return "'" + value.replaceAll("'", "'\\''") + "'"; }

export function launcherScript(node: string, entry: string, state: string): string {
  return '#!/usr/bin/env bash\nset -euo pipefail\nexec ' + shellQuote(node) + ' ' + shellQuote(entry) + ' "$@" --state-dir ' + shellQuote(state) + '\n';
}

export interface InstallationIO {
  home: string;
  node: string;
  entry: string;
  asset(name: string): Promise<string>;
  writable?(path: string): Promise<void>;
  prepareDirectory(path: string, capability: 'install_directory' | 'launcher_directory' | 'hook_directory' | 'skill_directory', workerID?: string, shared?: boolean): Promise<void>;
}

export function installationIO(home: string): InstallationIO {
  return {
    home, node: process.execPath, entry: fileURLToPath(new URL('./main.js', import.meta.url)),
    writable: path => access(path, constants.W_OK),
    asset: name => readFile(fileURLToPath(new URL('../setup/' + name, import.meta.url)), 'utf8'),
    prepareDirectory: (path, capability, workerID, shared = false) => new Promise((resolve, reject) => {
      const helper = fileURLToPath(new URL('../setup/private-directory.sh', import.meta.url));
      execFile('bash', [helper, path, shared ? 'shared' : 'private'], { timeout: 8000, maxBuffer: 4096 }, (error, stdout) => {
        if (!error) { resolve(); return; }
        const result = /^([a-z_]+) (unavailable|mode_[0-7]{1,4}_uid_\d+)$/.exec(stdout.trim());
        reject(new Failure('state_unsafe', {
          capability, worker_id: workerID, stage: 'worker', expected_state: shared ? 'real_writable_parent' : 'mode_700_uid_' + process.geteuid?.(),
          observed_state: result?.[2] ?? 'unavailable', cause: result?.[1] ?? 'directory_helper_failed',
        }));
      });
    }),
  };
}

export async function captureBootstrap(logger: Logger, setupID: string, bootstrap: string): Promise<void> {
  identifier(setupID);
  for (const line of bootstrap.trim().split('\n')) {
    requireValue(Buffer.byteLength(line) <= 6144, 'bootstrap_record_too_large');
    const event = object(parse(line));
    requireValue(event.setup_id === setupID && ['INFO', 'ERROR'].includes(text(event.level)), 'invalid_bootstrap_record');
    await logger.log(event.level as 'INFO' | 'ERROR', text(event.msg), { ...event, setup_id: setupID, operation_id: setupID });
  }
}

export function managedAssetPaths(home: string, workerID: string) {
  requireValue(/^[a-f0-9]{32}$/.test(workerID), 'worker_identity_mismatch');
  const name = 'aaa-muse-worker-' + workerID;
  const hook = join(home, 'hooks', 'scripts', name);
  const skill = join(home, 'workspace', 'skills', name);
  return { hook, skill, detector: join(hook, 'detector.sh'), skill_path: join(skill, 'SKILL.md') };
}

export async function renderManagedAssets(read: InstallationIO['asset'], installation: ObjectValue, state: string) {
  const [script, skill] = await Promise.all([read('hook.sh'), read('SKILL.md')]);
  const tokens = { '@LAUNCHER@': text(installation.launcher), '@STATE@': state,
    '@WORKER@': text(installation.worker_id), '@ORIGIN@': text(installation.origin) };
  requireValue(script.includes('@LAUNCHER@') && Object.keys(tokens).every(token => skill.includes(token)), 'candidate_incompatible');
  return {
    detector: script.replaceAll('@LAUNCHER@', () => shellQuote(tokens['@LAUNCHER@'])),
    skill: skill.replace(/@(?:LAUNCHER|STATE|WORKER|ORIGIN)@/g, token => tokens[token as keyof typeof tokens]),
  };
}

export async function prepareManagedAssets(io: InstallationIO, state: State, installation: ObjectValue, verifyExisting: boolean) {
  const id = text(installation.worker_id);
  const paths = managedAssetPaths(io.home, id);
  requireValue((installation.detector === undefined || installation.detector === paths.detector) &&
    (installation.skill_path === undefined || installation.skill_path === paths.skill_path), 'managed_asset_path_mismatch');
  for (const [path, kind] of [[paths.hook, 'hook_directory'], [paths.skill, 'skill_directory']] as const) {
    await io.prepareDirectory(dirname(path), kind, id, true);
    await io.prepareDirectory(path, kind, id);
    await io.writable?.(path);
  }
  const hook = new State(paths.hook, state.io, state.sys);
  const skill = new State(paths.skill, state.io, state.sys);
  if (verifyExisting) {
    await hook.read('detector.sh', 0o700);
    await skill.read('SKILL.md');
  }
  return { paths, hook, skill };
}

export async function writeManagedAssets(io: InstallationIO, state: State, installation: ObjectValue) {
  const targets = await prepareManagedAssets(io, state, installation, false);
  const assets = await renderManagedAssets(io.asset, installation, state.root);
  const detectorHash = digest(assets.detector);
  const skillHash = digest(assets.skill);
  const script = await targets.hook.read('detector.sh', 0o700);
  const skill = await targets.skill.read('SKILL.md');
  if (script === undefined || digest(script) !== detectorHash) await targets.hook.write('detector.sh', assets.detector, 0o700);
  if (skill === undefined || digest(skill) !== skillHash) await targets.skill.write('SKILL.md', assets.skill);
  return { detector: targets.paths.detector, skill_path: targets.paths.skill_path, detector_sha256: detectorHash, skill_sha256: skillHash };
}
