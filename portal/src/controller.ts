import { APIError, BUILD, randomHex, schedule, type API, type BrowserReport, type Schedule, type Settings } from './api';
import { Reports } from './reports';
import { WorkersController } from './worker-controller';
import { HistoryController } from './history-controller';

type SignOutNotice = 'started' | 'confirmed';

export interface System {
  now(): number;
  monotonicNow(): number;
  id(): string;
  schedule: Schedule;
  visible(): boolean;
  watchVisibility(callback: () => void): () => void;
  watchSignOut(callback: (notice: SignOutNotice) => void): () => void;
  announceSignOut(notice: SignOutNotice): void;
}
const sessionChannel = 'muse-portal-session';
export const browserSystem: System = {
  now: () => Date.now(), monotonicNow: () => performance.now(), id: () => crypto.randomUUID?.() ?? randomHex(16), schedule,
  visible: () => document.visibilityState !== 'hidden',
  watchVisibility: callback => { document.addEventListener('visibilitychange', callback); return () => document.removeEventListener('visibilitychange', callback); },
  watchSignOut: callback => {
    if (!window.BroadcastChannel) return () => {};
    const channel = new BroadcastChannel(sessionChannel);
    channel.onmessage = event => { if (event.data === 'started' || event.data === 'confirmed') callback(event.data); };
    return () => channel.close();
  },
  announceSignOut: notice => {
    if (!window.BroadcastChannel) return;
    const channel = new BroadcastChannel(sessionChannel);
    channel.postMessage(notice);
    channel.close();
  },
};
export interface View {
  page: 'settings' | 'workers' | 'requests';
  phase: 'login' | 'signing_in' | 'restoring' | 'restore_failed' | 'authenticated' | 'signing_out' | 'logout_unconfirmed';
  settings: Settings | null;
  loading: boolean;
  stale: boolean;
  lastGood: number | null;
  message: string;
  requestID: string;
  operationID: string;
  keySave: { pending: boolean; message: string; requestID: string; operationID: string } | null;
}
const initial = (page: View['page'] = 'settings'): View => ({ page, phase: 'login', settings: null, loading: false, stale: false, lastGood: null, message: '', requestID: '', operationID: '', keySave: null });

export class PortalController {
  #view = initial();
  #listeners = new Set<() => void>();
  #generation = 0;
  #abort = new AbortController();
  #refreshTimer = () => {};
  #freshnessTimer = () => {};
  #visibility = () => {};
  #refreshing = false;
  #settingsVersion = 0;
  #attempt = 0;
  #loggingOut = false;
  #stopSignOut: () => void;
  readonly reports: Reports;
  readonly workers: WorkersController;
  readonly history: HistoryController;
  constructor(private api: API, private system: System = browserSystem) {
    this.reports = new Reports(api);
    const authenticated = () => this.#view.phase === 'authenticated';
    const denied = (requestID: string, operationID: string) => this.endSession('Your session ended. Sign in again.', requestID, operationID);
    this.workers = new WorkersController(api, system, this.reports, authenticated, denied);
    this.history = new HistoryController(api, system, this.reports, authenticated, denied);
    this.#stopSignOut = system.watchSignOut(notice => {
      if (notice === 'confirmed') {
        this.endSession('Signed out.');
      } else if (['authenticated', 'restoring', 'signing_in'].includes(this.#view.phase) && !this.#loggingOut) {
        this.cancel();
        this.#view = initial(this.#view.page);
        this.change({ phase: 'logout_unconfirmed', message: 'Sign-out started in another tab. Retry to confirm this browser’s session ended.' });
      }
    });
  }
  snapshot = () => this.#view;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  private change(patch: Partial<View>) { this.#view = { ...this.#view, ...patch }; for (const listener of this.#listeners) listener(); }
  private cancel() {
    this.#generation++;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#refreshTimer(); this.#freshnessTimer(); this.#visibility();
    this.#refreshing = false;
    this.reports.clear();
    this.workers.reset();
    this.history.reset();
  }
  dispose() { this.cancel(); this.#stopSignOut(); this.#listeners.clear(); }

  private async enterSession() {
    this.change({ phase: 'authenticated', message: '', requestID: '' });
    this.#visibility = this.system.watchVisibility(() => { if (this.system.visible()) void this.refresh(); });
    this.tick();
    if (this.#view.page === 'workers') this.workers.activate();
    if (this.#view.page === 'requests') this.history.activate();
    await this.refresh();
  }

  async restore() {
    if (this.#view.phase !== 'login' && this.#view.phase !== 'restore_failed') return;
    this.cancel();
    const generation = this.#generation;
    const operation = this.system.id();
    this.change({ phase: 'restoring', message: 'Checking your session…', requestID: '', operationID: operation });
    try {
      await this.api.restore(operation, this.#abort.signal);
      if (generation === this.#generation) await this.enterSession();
    } catch (error) {
      if (generation !== this.#generation) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401 && failure.causeCode === 'invalid_session') {
        this.endSession('Your session ended. Sign in again.', failure.requestID, operation);
      } else if (failure.status === 401) {
        this.change({ phase: 'login', message: '', operationID: '' });
      } else {
        this.change({ phase: 'restore_failed', message: 'Could not check your session. Check the connection and retry.', requestID: failure.requestID });
      }
    }
  }

  async login(password: string, remember = false) {
    this.cancel();
    const generation = this.#generation;
    const operation = this.system.id();
    this.#view = initial(this.#view.page);
    this.change({ phase: 'signing_in', operationID: operation });
    try {
      await this.api.login(password, remember, operation, this.#abort.signal);
      if (generation === this.#generation) await this.enterSession();
    } catch (error) {
      if (generation !== this.#generation) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      const message = failure.status === 401 ? 'Password not accepted. Try again.' :
        failure.status === 429 ? `Too many attempts. Try again in ${failure.retryAfter || 60} seconds.` :
        failure.causeCode === 'session_capacity_exhausted' ? 'The portal has reached its session limit. Sign out another browser or rotate the portal password.' :
        'Could not sign in. Check the service connection and try again.';
      this.change({ phase: 'login', message, requestID: failure.requestID });
    }
  }

  private endSession(message: string, requestID = '', operationID = '') {
    this.cancel();
    this.#view = initial(this.#view.page);
    this.change({ message, requestID, operationID });
  }

  navigate(page: View['page']) {
    if (page === this.#view.page) return;
    this.workers.reset();
    this.history.reset();
    this.change({ page });
    if (page === 'workers' && this.#view.phase === 'authenticated') this.workers.activate();
    if (page === 'requests' && this.#view.phase === 'authenticated') this.history.activate();
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
    this.freshness();
    if (this.#refreshing) return;
    this.#refreshing = true;
    const generation = this.#generation;
    const version = this.#settingsVersion;
    const operation = this.system.id();
    const started = this.system.now();
    this.#attempt++;
    this.change({ loading: true, operationID: operation });
    try {
      const result = await this.api.settings(operation, this.#abort.signal);
      if (generation !== this.#generation || version !== this.#settingsVersion) return;
      const mismatch = result.value.build.revision !== BUILD;
      this.change({ settings: result.value, lastGood: this.system.now(), stale: mismatch, message: mismatch ? 'The service build changed. Reload the portal.' : '', requestID: result.requestID });
      this.freshness();
      if (mismatch) this.report('build_mismatch', operation, result.requestID, this.system.now() - started);
      await this.reports.flush();
    } catch (error) {
      if (generation !== this.#generation || version !== this.#settingsVersion) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.endSession('Your session ended. Sign in again.', failure.requestID, operation); return; }
      this.change({ stale: true, message: 'Could not refresh settings. Check the connection and retry.', requestID: failure.requestID });
      this.report(failure.causeCode === 'request_timeout' ? 'request_timeout' : failure.causeCode === 'service_unavailable' ? 'service_unavailable' : 'request_failed', operation, failure.requestID, this.system.now() - started);
    } finally {
      if (generation === this.#generation) {
        this.#refreshing = false;
        this.change({ loading: false });
        if (version !== this.#settingsVersion) void this.refresh();
      }
    }
  }

  async createClientKey(name: string, key: string) {
    if (this.#view.phase !== 'authenticated' || this.#view.keySave?.pending) return;
    const generation = this.#generation;
    const operationID = this.system.id();
    this.change({ keySave: { pending: true, message: '', requestID: '', operationID } });
    try {
      const result = await this.api.createClientKey(name, key, operationID, this.#abort.signal);
      if (generation !== this.#generation) return;
      const settings = this.#view.settings;
      this.#settingsVersion++;
      this.change({
        settings: settings && { ...settings, client_key_names: [...new Set([...settings.client_key_names, result.value])].sort() },
        keySave: { pending: false, message: 'Client key saved.', requestID: result.requestID, operationID },
      });
      void this.refresh();
    } catch (error) {
      if (generation !== this.#generation) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.endSession('Your session ended. Sign in again.', failure.requestID, operationID); return; }
      const message = failure.causeCode === 'client_key_conflict' ? 'The name or key is already in use, or the configuration changed. Review the current client keys.' :
        failure.causeCode === 'invalid_client_key' ? 'Enter a valid name and bearer key.' :
        failure.causeCode === 'client_key_save_failed' ? 'The broker could not write config.yaml. Check its configuration directory permissions and broker logs.' :
        'The save could not be confirmed. Check config.yaml before retrying.';
      this.change({ keySave: { pending: false, message, requestID: failure.requestID, operationID } });
    }
  }

  private report(cause: BrowserReport['cause'], operation: string, requestID: string, duration: number) {
    this.reports.add({ event: 'portal.state_stale', component: 'settings', cause, request_id: requestID, operation_id: operation,
      expected_state: 'fresh', observed_state: 'stale', last_good_at: this.#view.lastGood === null ? null : new Date(this.#view.lastGood).toISOString(),
      duration_ms: Math.max(0, duration), attempt: this.#attempt || 1 });
  }

  renderFailed() {
    if (this.#view.phase !== 'authenticated') return;
    if (this.#view.page === 'requests') { this.history.renderFailed(); return; }
    this.reports.add({ event: 'portal.render_failed', component: 'shell', cause: 'render_exception', request_id: this.#view.requestID,
      operation_id: this.system.id(), expected_state: 'rendered', observed_state: 'failed', last_good_at: this.#view.lastGood === null ? null : new Date(this.#view.lastGood).toISOString(), duration_ms: 0, attempt: 1 });
  }

  async logout() {
    if (this.#loggingOut || this.#view.phase === 'signing_out') return;
    this.#loggingOut = true;
    const previous = this.#generation;
    if (this.history.hasPendingReads()) await this.history.abandon();
    this.#loggingOut = false;
    if (previous !== this.#generation) return;
    this.cancel();
    const generation = this.#generation;
    const operationID = this.system.id();
    this.#view = initial(this.#view.page);
    this.change({ phase: 'signing_out', message: 'Signing out…', operationID });
    this.system.announceSignOut('started');
    try {
      await this.api.logout(operationID, this.#abort.signal);
      if (generation !== this.#generation) return;
      this.endSession('Signed out.');
      this.system.announceSignOut('confirmed');
    }
    catch (error) {
      if (generation !== this.#generation) return;
      this.change({ phase: 'logout_unconfirmed', message: 'Sign-out could not be confirmed. Retry to end this browser’s session.',
        requestID: error instanceof APIError ? error.requestID : '' });
    }
  }
}
