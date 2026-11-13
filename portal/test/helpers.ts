import type { API, BrowserReport, Session, Settings } from '../src/api';
import type { System } from '../src/controller';

export const token = 'muse_portal_' + 'a'.repeat(43);
export const settings = (): Settings => ({ build: { revision: 'development', dirty: false }, instance_id: 'instance-1', public_origin: 'https://muse.example.test', ready: true, database: 'available', schema_version: 5, effective_yaml: 'control-portal:\n  password: "[REDACTED]"\n', capabilities: ['Native requests', 'Buffered SSE lifecycle events'] });
export const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
export function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

export class TestSystem implements System {
  time = Date.parse('2026-11-13T00:00:00Z');
  showing = true;
  sequence = 0;
  next = 0;
  timers = new Map<number, { at: number; callback: () => void }>();
  listeners = new Set<() => void>();
  now = () => this.time;
  id = () => `operation-${++this.sequence}`;
  visible = () => this.showing;
  schedule = (callback: () => void, delay: number) => {
    const id = ++this.next;
    this.timers.set(id, { at: this.time + delay, callback });
    return () => { this.timers.delete(id); };
  };
  watchVisibility = (callback: () => void) => { this.listeners.add(callback); return () => { this.listeners.delete(callback); }; };
  async advance(milliseconds: number) {
    const until = this.time + milliseconds;
    for (;;) {
      const entry = [...this.timers.entries()].filter(([, value]) => value.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!entry) break;
      this.time = entry[1].at;
      this.timers.delete(entry[0]);
      entry[1].callback();
      await settle();
    }
    this.time = until;
    await settle();
  }
  async visibility(value: boolean) { this.showing = value; for (const callback of this.listeners) callback(); await settle(); }
}

export class TestAPI implements API {
  credential: string | null = null;
  reports: BrowserReport[] = [];
  loginCalls = 0;
  settingsCalls = 0;
  logoutCalls = 0;
  loginWork: () => Promise<Session>;
  settingsWork = async () => ({ value: settings(), requestID: 'request-1' });
  logoutWork = async () => {};
  reportWork = async (_report: BrowserReport) => {};
  constructor(public system: TestSystem) { this.loginWork = async () => ({ session_token: token, expires_at: new Date(system.time + 1_800_000).toISOString() }); }
  setSession(value: string | null) { this.credential = value; }
  async login() { this.loginCalls++; return this.loginWork(); }
  async settings() { this.settingsCalls++; return this.settingsWork(); }
  async logout() { this.logoutCalls++; return this.logoutWork(); }
  async report(value: BrowserReport) { this.reports.push(value); return this.reportWork(value); }
}
