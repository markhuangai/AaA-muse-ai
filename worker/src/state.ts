import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Failure, cause, requireValue } from './errors.js';
import { encode, parse, object, text, integer } from './json.js';

export type Files = Pick<typeof fs, 'mkdir' | 'lstat' | 'open' | 'rename' | 'unlink' | 'rmdir' | 'readdir'>;
export interface System {
  now(): number;
  uuid(): string;
  uid: number;
  pid: number;
  alive(pid: number): boolean | undefined;
  wait(ms: number): Promise<void>;
}
export const system: System = {
  now: Date.now, uuid: randomUUID, uid: process.getuid?.() ?? -1, pid: process.pid,
  alive(pid) {
    try { process.kill(pid, 0); return true; }
    catch (error) { return cause(error) === 'ESRCH' ? false : undefined; }
  },
  wait: ms => new Promise(resolveWait => setTimeout(resolveWait, ms)),
};

export class State {
  readonly root: string;
  constructor(root: string, readonly io: Files = fs, readonly sys: System = system) {
    requireValue(isAbsolute(root), 'absolute_state_directory_required');
    this.root = resolve(root);
  }
  path(name: string): string {
    requireValue(/^[A-Za-z0-9_.-]+$/.test(name) && name !== '.' && name !== '..', 'invalid_state_name');
    return join(this.root, name);
  }
  async ensure(): Promise<void> {
    requireValue(this.sys.uid >= 0, 'posix_permissions_required');
    await this.io.mkdir(this.root, { recursive: true, mode: 0o700 });
    await this.check(this.root, true);
  }
  async check(path: string, directory = false): Promise<void> {
    const info = await this.io.lstat(path);
    const mode = directory ? 0o700 : 0o600;
    // An atomic replacement can unlink a private inode after lookup while its snapshot remains valid.
    requireValue((directory ? info.isDirectory() : info.isFile()) && !info.isSymbolicLink() && info.uid === this.sys.uid && (info.mode & 0o7777) === mode && (directory || info.nlink <= 1), 'state_unsafe', {
      path_kind: directory ? 'state_directory' : 'state_file', entry: path === this.root ? '.' : path.slice(this.root.length + 1), expected_mode: mode.toString(8), observed_mode: (info.mode & 0o7777).toString(8), expected_uid: this.sys.uid, observed_uid: info.uid, observed_links: info.nlink, observed_type: info.isSymbolicLink() ? 'symlink' : info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
    });
  }
  async read(name: string): Promise<string | undefined> {
    await this.check(this.root, true);
    const path = this.path(name);
    try {
      await this.check(path);
      const f = await this.io.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const info = await f.stat();
        requireValue(info.isFile() && info.uid === this.sys.uid && (info.mode & 0o7777) === 0o600 && info.nlink <= 1, 'state_unsafe', { entry: name, expected_mode: '600', observed_mode: (info.mode & 0o7777).toString(8), expected_uid: this.sys.uid, observed_uid: info.uid, observed_links: info.nlink });
        requireValue(info.size <= 16 * 1024 * 1024, 'state_file_too_large');
        return await f.readFile('utf8');
      } finally { await f.close(); }
    } catch (error) { if (cause(error) === 'ENOENT') return undefined; throw error; }
  }
  async write(name: string, value: string): Promise<void> {
    await this.check(this.root, true);
    const target = this.path(name);
    try { await this.check(target); } catch (error) { if (cause(error) !== 'ENOENT') throw error; }
    const tmp = this.path(`.${name}.${this.sys.uuid()}.tmp`);
    const f = await this.io.open(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try { await f.writeFile(value); await f.sync(); } finally { await f.close(); }
    await this.io.rename(tmp, target);
    const directory = await this.io.open(this.root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try { await directory.sync(); } finally { await directory.close(); }
  }
  async remove(name: string): Promise<void> {
    if (await this.read(name) !== undefined) await this.io.unlink(this.path(name));
  }
  async child(name: string): Promise<State> {
    const child = new State(this.path(name), this.io, this.sys);
    await child.ensure();
    return child;
  }
  async list(): Promise<string[]> {
    await this.check(this.root, true);
    return await this.io.readdir(this.root);
  }
  async lock(name: string, wait = true): Promise<() => Promise<void>> {
    const path = this.path(`${name}.lock`);
    const token = this.sys.uuid();
    const deadline = this.sys.now() + (wait ? 10_000 : 0);
    for (;;) {
      await this.check(this.root, true);
      try {
        await this.io.mkdir(path, { mode: 0o700 });
        const owner = new State(path, this.io, this.sys);
        await owner.write('owner.json', encode({ pid: this.sys.pid, owner: token }));
        return async () => {
          const current = object(parse((await owner.read('owner.json')) ?? '{}'));
          requireValue(current.owner === token, 'lock_owner_changed');
          await owner.remove('owner.json');
          await this.io.rmdir(path);
        };
      } catch (error) {
        if (cause(error) !== 'EEXIST') throw error;
      }
      const owner = new State(path, this.io, this.sys);
      let raw: string | undefined;
      try { await owner.check(path, true); raw = await owner.read('owner.json'); }
      catch (error) { if (cause(error) === 'ENOENT') continue; throw error; }
      if (raw) {
        const value = object(parse(raw));
        const pid = integer(value.pid);
        requireValue(pid > 0, 'lock_owner_ambiguous');
        text(value.owner);
        if (this.sys.alive(pid) === false) {
          // The recovery guard serializes stale-owner deletion; an abandoned guard fails closed.
          const guard = this.path('recovery.lock');
          try {
            await this.io.mkdir(guard, { mode: 0o700 });
          } catch (error) { throw new Failure('lock_recovery_ambiguous', { cause: cause(error) }); }
          try {
            const current = await owner.read('owner.json');
            if (current === raw) { await owner.remove('owner.json'); await this.io.rmdir(path); }
          } finally { await this.io.rmdir(guard); }
          continue;
        }
      }
      if (this.sys.now() >= deadline) throw new Failure(wait ? 'state_lock_timeout' : 'subscriber_already_running', { lock: name });
      await this.sys.wait(20);
    }
  }
  async withLock<T>(name: string, action: () => Promise<T>): Promise<T> {
    const release = await this.lock(name);
    try { return await action(); } finally { await release(); }
  }
}
