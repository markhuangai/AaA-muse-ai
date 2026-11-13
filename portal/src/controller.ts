import { APIError, BUILD, schedule, type API, type BrowserReport, type Schedule, type Settings } from './api';
import { Reports } from './reports';
import { WorkersController } from './worker-controller';

export interface System {
  now(): number;
  id(): string;
  schedule: Schedule;
  visible(): boolean;
  watchVisibility(callback: () => void): () => void;
}
export const browserSystem: System = {
  now: () => Date.now(), id: () => crypto.randomUUID(), schedule,
  visible: () => document.visibilityState !== 'hidden',
  watchVisibility: callback => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
};
export interface View {
  page: 'settings' | 'workers';
  phase: 'login' | 'signing_in' | 'authenticated';
  settings: Settings | null;
  loading: boolean;
  stale: boolean;
  lastGood: number | null;
  expiresAt: number | null;
  message: string;
  requestID: string;
  operationID: string;
}
const initial = (page: View['page'] = 'settings'): View => ({ page, phase: 'login', settings: null, loading: false, stale: false, lastGood: null, expiresAt: null, message: '', requestID: '', operationID: '' });

export class PortalController {
  #view = initial();
  #listeners = new Set<() => void>();
  #generation = 0;
  #abort = new AbortController();
  #expiry = () => {};
  #refreshTimer = () => {};
  #freshnessTimer = () => {};
  #visibility = () => {};
  #refreshing = false;
  #attempt = 0;
  readonly reports: Reports;
  readonly workers: WorkersController;
  constructor(private api: API, private system: System = browserSystem) {
    this.reports = new Reports(api);
    this.workers = new WorkersController(api, system, this.reports, () => {
      if (this.#view.phase !== 'authenticated') return false;
      if (this.#view.expiresAt !== null && system.now() >= this.#view.expiresAt) { this.expire(); return false; }
      return true;
    }, () => this.expire());
  }
  snapshot = () => this.#view;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  private change(patch: Partial<View>) { this.#view = { ...this.#view, ...patch }; for (const listener of this.#listeners) listener(); }
  private cancel() {
    this.#generation++;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#expiry(); this.#refreshTimer(); this.#freshnessTimer(); this.#visibility();
    this.#refreshing = false;
    this.reports.clear();
    this.workers.reset();
  }
  dispose() { this.cancel(); this.api.setSession(null); this.#listeners.clear(); }

  async login(password: string) {
    this.cancel();
    this.api.setSession(null);
    const generation = this.#generation;
    const operation = this.system.id();
    this.#view = initial(this.#view.page);
    this.change({ phase: 'signing_in', operationID: operation });
    try {
      const session = await this.api.login(password, operation, this.#abort.signal);
      if (generation !== this.#generation) return;
      const expiresAt = Date.parse(session.expires_at);
      if (expiresAt <= this.system.now()) { this.expire(); return; }
      this.api.setSession(session.session_token);
      this.change({ phase: 'authenticated', expiresAt });
      this.#expiry = this.system.schedule(() => this.expire(), expiresAt - this.system.now());
      this.#visibility = this.system.watchVisibility(() => { if (this.system.visible()) void this.refresh(); });
      this.tick();
      if (this.#view.page === 'workers') this.workers.activate();
      await this.refresh();
    } catch (error) {
      if (generation !== this.#generation) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      const message = failure.status === 401 ? 'Password not accepted. Try again.' : failure.status === 429 ? `Too many attempts. Try again in ${failure.retryAfter || 60} seconds.` : 'Could not sign in. Check the service connection and try again.';
      this.change({ phase: 'login', message, requestID: failure.requestID });
    }
  }

  private expire() {
    this.cancel();
    this.api.setSession(null);
    this.#view = initial(this.#view.page);
    this.change({ message: 'Your session ended. Sign in again.' });
  }

  navigate(page: View['page']) {
    if (page === this.#view.page) return;
    this.workers.reset();
    this.change({ page });
    if (page === 'workers' && this.#view.phase === 'authenticated') this.workers.activate();
  }

  private tick() {
    this.#refreshTimer = this.system.schedule(() => {
      if (this.#view.phase !== 'authenticated') return;
      if (this.system.visible()) void this.refresh();
      this.tick();
    }, 30_000);
  }

  private freshness() {
    this.#freshnessTimer();
    if (this.#view.phase !== 'authenticated' || this.#view.lastGood === null) return;
    const remaining = 60_000 - (this.system.now() - this.#view.lastGood);
    if (remaining > 0) {
      this.#freshnessTimer = this.system.schedule(() => this.freshness(), remaining);
    } else if (!this.#view.stale) {
      this.change({ stale: true, message: 'Settings are out of date. Refresh to check the service.' });
      this.report('stale_data', this.#view.operationID, '', 0);
    }
  }

  async refresh() {
    if (this.#view.phase !== 'authenticated') return;
    if (this.#view.expiresAt !== null && this.system.now() >= this.#view.expiresAt) { this.expire(); return; }
    this.freshness();
    if (this.#refreshing) return;
    this.#refreshing = true;
    const generation = this.#generation;
    const operation = this.system.id();
    const started = this.system.now();
    this.#attempt++;
    this.change({ loading: true, operationID: operation });
    try {
      const result = await this.api.settings(operation, this.#abort.signal);
      if (generation !== this.#generation) return;
      const mismatch = result.value.build.revision !== BUILD;
      this.change({ settings: result.value, lastGood: this.system.now(), stale: mismatch, message: mismatch ? 'The service build changed. Reload and sign in again.' : '', requestID: result.requestID });
      this.freshness();
      if (mismatch) this.report('build_mismatch', operation, result.requestID, this.system.now() - started);
      await this.reports.flush();
    } catch (error) {
      if (generation !== this.#generation) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.expire(); return; }
      this.change({ stale: true, message: 'Could not refresh settings. Check the connection and retry.', requestID: failure.requestID });
      this.report(failure.causeCode === 'request_timeout' ? 'request_timeout' : failure.causeCode === 'service_unavailable' ? 'service_unavailable' : 'request_failed', operation, failure.requestID, this.system.now() - started);
    } finally { if (generation === this.#generation) { this.#refreshing = false; this.change({ loading: false }); } }
  }

  private report(cause: BrowserReport['cause'], operation: string, requestID: string, duration: number) {
    this.reports.add({ event: 'portal.state_stale', component: 'settings', cause, request_id: requestID, operation_id: operation,
      expected_state: 'fresh', observed_state: 'stale', last_good_at: this.#view.lastGood === null ? null : new Date(this.#view.lastGood).toISOString(),
      duration_ms: Math.max(0, duration), attempt: this.#attempt || 1 });
  }

  renderFailed() {
    if (this.#view.phase !== 'authenticated') return;
    this.reports.add({ event: 'portal.render_failed', component: 'shell', cause: 'render_exception', request_id: this.#view.requestID,
      operation_id: this.system.id(), expected_state: 'rendered', observed_state: 'failed', last_good_at: this.#view.lastGood === null ? null : new Date(this.#view.lastGood).toISOString(), duration_ms: 0, attempt: 1 });
  }

  async logout() {
    this.cancel();
    const generation = this.#generation;
    const pending = this.api.logout(this.system.id(), this.#abort.signal);
    this.api.setSession(null);
    this.#view = initial(this.#view.page);
    this.change({ message: 'Signed out.' });
    try { await pending; }
    catch (error) {
      if (generation === this.#generation && !(error instanceof APIError && error.status === 401)) {
        this.change({ message: 'Signed out in this browser. Server sign-out could not be confirmed.' });
      }
    }
  }
}
