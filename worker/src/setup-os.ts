import * as fs from 'node:fs/promises';
import { constants, fstatSync, ftruncateSync, writeSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isAbsolute } from 'node:path';
import { State } from './state.js';
import { cause, Failure, requireValue } from './errors.js';

export interface SetupIO {
  home: string;
  node: string;
  entry: string;
  asset(name: string): Promise<string>;
  launch(state: State, node: string, entry: string): Promise<number>;
  emit(runtime: string, action: 'wake' | 'silent', message: string): Promise<string>;
}

export function setupIO(home: string): SetupIO {
  return {
    home, node: process.execPath, entry: fileURLToPath(new URL('./main.js', import.meta.url)),
    asset: name => fs.readFile(fileURLToPath(new URL('../setup/' + name, import.meta.url)), 'utf8'),
    async launch(state, node, entry) {
      requireValue(isAbsolute(node) && isAbsolute(entry), 'absolute_launch_paths_required');
      await state.write('daemon.stderr', '');
      const handle = await state.io.open(state.path('daemon.stderr'), constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW);
      try {
        const child = spawn(node, [entry, 'run', '--state-dir', state.root, '--background'], { detached: true, stdio: ['ignore', 'ignore', handle.fd] });
        const pid = await new Promise<number>((resolve, reject) => {
          child.once('error', error => reject(new Failure('subscriber_launch_failed', { cause: cause(error) })));
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
