import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { Logger } from './diagnostics.js';
import { Failure, requireValue } from './errors.js';
import { identifier, object, parse, text } from './json.js';

export interface InstallationIO {
  home: string;
  node: string;
  entry: string;
  asset(name: string): Promise<string>;
  prepareDirectory(path: string, capability: 'install_directory' | 'launcher_directory' | 'hook_directory' | 'skill_directory', workerID?: string, shared?: boolean): Promise<void>;
}

export function installationIO(home: string): InstallationIO {
  return {
    home, node: process.execPath, entry: fileURLToPath(new URL('./main.js', import.meta.url)),
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
