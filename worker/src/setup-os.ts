import * as fs from 'node:fs/promises';
import { constants, fstatSync, ftruncateSync, readFileSync, statSync, writeSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, isAbsolute, join } from 'node:path';
import { State, type LockOwner } from './state.js';
import { cause, Failure, requireValue } from './errors.js';
import { text, type ObjectValue } from './json.js';

type DirectoryRole = 'install_directory' | 'launcher_directory' | 'hook_directory' | 'skill_directory';
export interface SetupIO {
  home: string;
  node: string;
  entry: string;
  asset(name: string): Promise<string>;
  prepareDirectory(path: string, capability: DirectoryRole, workerID?: string, shared?: boolean): Promise<void>;
  launch(state: State, node: string, entry: string): Promise<number>;
  emit(runtime: string, action: 'wake' | 'silent', message: string): Promise<string>;
}

export function setupIO(home: string): SetupIO {
  return {
    home, node: process.execPath, entry: fileURLToPath(new URL('./main.js', import.meta.url)),
    asset: name => fs.readFile(fileURLToPath(new URL('../setup/' + name, import.meta.url)), 'utf8'),
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
    async launch(state, node, entry) {
      requireValue(isAbsolute(node) && isAbsolute(entry), 'absolute_launch_paths_required');
      await state.write('daemon.stderr', '');
      const handle = await state.io.open(state.path('daemon.stderr'), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        const child = spawn(node, [entry, 'run', '--state-dir', state.root, '--background'], { detached: true, stdio: ['ignore', 'ignore', handle.fd] });
        const pid = await new Promise<number>((resolve, reject) => {
          child.once('error', error => {
            const reason = cause(error);
            reject(new Failure('subscriber_launch_failed', { cause: reason }, reason === 'EAGAIN' || reason === 'EINTR'));
          });
          child.once('spawn', () => { child.unref(); resolve(child.pid!); });
        });
        return pid;
      } finally { await handle.close(); }
    },
    emit: (runtime, action, message) => new Promise((resolve, reject) => {
      execFile('bash', ['-c', 'set -euo pipefail; source "$1"; declare -F wake silent >/dev/null; "$2" "$3"', 'aaa-muse-hook', runtime, action, message],
        { timeout: 8000, maxBuffer: 65536 }, (error, stdout, stderr) => {
          if (error) reject(new Failure('hook_runtime_failed', { capability: 'HATCH_HOOK_RUNTIME wake/silent', cause: cause(error), exit_code: error.code ?? null, stdout, stderr }));
          else resolve(stdout);
        });
    }),
  };
}

export const upgradeIO = {
  async stage(root: string, entry: string): Promise<string> {
    const directory = await fs.mkdtemp(join(root, 'releases', 'upgrade.'));
    await fs.cp(dirname(dirname(entry)), join(directory, 'package'), { recursive: true, force: false, errorOnExist: true });
    return join(directory, 'package', 'dist', 'main.js');
  },
  stop(owner: LockOwner, stateDir: string, installation: ObjectValue): void {
    const proc = '/proc/' + owner.pid;
    const args = readFileSync(proc + '/cmdline', 'utf8').split('\0').slice(0, -1);
    const expected = [text(installation.node), text(installation.entry), 'run', '--state-dir', stateDir, '--background'];
    requireValue(statSync(proc).uid === process.geteuid?.() && args.length === expected.length &&
      args.every((arg, i) => arg === expected[i]), 'upgrade_subscriber_changed', { pid: owner.pid });
    process.kill(owner.pid, 'SIGTERM');
  },
};

export function backgroundStderr(line: string, fd = 2, io = { fstatSync, ftruncateSync, writeSync }): void {
  const info = io.fstatSync(fd);
  requireValue(info.isFile() && info.uid === process.getuid?.() && (info.mode & 0o7777) === 0o600 && info.nlink === 1, 'background_stderr_unsafe');
  if (Buffer.byteLength(line) > 61440) line = '{"level":"WARN","msg":"setup.stderr_payload_omitted","full_evidence":"protected_diagnostics_export"}\n';
  let offset = info.size;
  if (info.size + Buffer.byteLength(line) > 65536) {
    io.ftruncateSync(fd, 0);
    offset = io.writeSync(fd, '{"level":"WARN","msg":"setup.stderr_rotated","full_evidence":"protected_diagnostics_export"}\n', 0);
  }
  io.writeSync(fd, line, offset);
}
