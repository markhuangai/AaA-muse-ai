import type { API, BrowserReport, Session, Settings } from '../src/api';
import type { System } from '../src/controller';
import type { Worker, Enrollment, EnrollmentKind } from '../src/worker-api';

export const token = 'muse_portal_' + 'a'.repeat(43);
export const settings = (): Settings => ({ build: { revision: 'development', dirty: false }, instance_id: 'instance-1', public_origin: 'https://muse.example.test', ready: true, database: 'available', schema_version: 5, effective_yaml: 'control-portal:\n  password: "[REDACTED]"\n', capabilities: ['Native requests', 'Buffered SSE lifecycle events'] });
export const settle = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };
export const worker = (id = 'a'.repeat(32), name = 'Studio worker'): Worker => ({ id, name, registered_at: '2026-11-13T00:00:00Z', revoked_at: null, last_contact_at: '2026-11-13T00:00:00Z', connection_status: 'online', work_status: 'idle', current_job: null, waiting_for_client_tool: 0, last_heartbeat_at: '2026-11-13T00:00:00Z', inference_readiness: 'unverified', qualification_history: [] });
export const enrollment = (kind: EnrollmentKind = 'prompt'): Enrollment => ({ enrollment_id: 'e'.repeat(32), created_at: '2026-11-13T00:00:00Z', expires_at: '2026-11-13T00:15:00Z', ...(kind === 'code' ? { enrollment_code: 'muse_enroll_' + 'e'.repeat(43) } : { setup_prompt: 'Complete pinned Muse setup\nKeep this single-use authority private.\nRegister the supported reconnection hook.\n', worker_package: { version: '0.1.0-rc.0', sha256: 'a'.repeat(64), url: 'https://example.test/worker.tgz' } }) });
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
  workersCalls = 0;
  workersWork: () => Promise<{ value: Worker[]; requestID: string }> = async () => ({ value: [worker()], requestID: 'workers-request' });
  renameWork: (id: string, name: string) => Promise<{ value: Worker; requestID: string }> = async (id, name) => ({ value: worker(id, name.trim()), requestID: 'rename-request' });
  revokeWork: (id: string) => Promise<{ value: Worker; requestID: string }> = async id => ({ value: { ...worker(id), revoked_at: '2026-11-13T00:01:00Z' }, requestID: 'revoke-request' });
  enrollmentWork: (kind: EnrollmentKind) => Promise<{ value: Enrollment; requestID: string }> = async kind => ({ value: enrollment(kind), requestID: 'enrollment-request' });
  constructor(public system: TestSystem) { this.loginWork = async () => ({ session_token: token, expires_at: new Date(system.time + 1_800_000).toISOString() }); }
  setSession(value: string | null) { this.credential = value; }
  async login() { this.loginCalls++; return this.loginWork(); }
  async settings() { this.settingsCalls++; return this.settingsWork(); }
  async logout() { this.logoutCalls++; return this.logoutWork(); }
  async report(value: BrowserReport) { this.reports.push(value); return this.reportWork(value); }
  async workers() { this.workersCalls++; return this.workersWork(); }
  async renameWorker(id: string, name: string) { return this.renameWork(id, name); }
  async revokeWorker(id: string) { return this.revokeWork(id); }
  async enrollment(kind: EnrollmentKind) { return this.enrollmentWork(kind); }
}
