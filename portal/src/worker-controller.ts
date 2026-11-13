import { APIError, type API, type BrowserReport } from './api';
import type { System } from './controller';
import type { Reports } from './reports';
import type { Enrollment, EnrollmentKind, Worker } from './worker-api';

export interface WorkersView {
  workers: Worker[] | null;
  selectedID: string;
  loading: boolean;
  stale: boolean;
  lastGood: number | null;
  message: string;
  requestID: string;
  operationID: string;
  pending: '' | 'rename' | 'revoke' | 'enrollment';
  actionMessage: string;
  actionRequestID: string;
  actionOperationID: string;
  enrollment: Enrollment | null;
  enrollmentKind: EnrollmentKind;
  enrollmentMessage: string;
}

const initial = (): WorkersView => ({ workers: null, selectedID: '', loading: false, stale: true, lastGood: null,
  message: '', requestID: '', operationID: '', pending: '', actionMessage: '', actionRequestID: '', actionOperationID: '',
  enrollment: null, enrollmentKind: 'prompt', enrollmentMessage: '' });

export async function browserCopy(text: string) {
  if (!navigator.clipboard) throw new Error('clipboard_unavailable');
  await navigator.clipboard.writeText(text);
}

export class WorkersController {
  #view = initial();
  #listeners = new Set<() => void>();
  #active = false;
  #generation = 0;
  #sequence = 0;
  #accepted = 0;
  #abort = new AbortController();
  #poll = () => {};
  #freshness = () => {};
  #expiry = () => {};
  #visibility = () => {};
  constructor(private api: API, private system: System, private reports: Reports, private authorized: () => boolean,
    private denied: () => void, private clipboard: (text: string) => Promise<void> = browserCopy) {}

  snapshot = () => this.#view;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  private change(patch: Partial<WorkersView>) { this.#view = { ...this.#view, ...patch }; for (const listener of this.#listeners) listener(); }
  private available() { return this.#active && this.authorized(); }

  reset() {
    this.#active = false;
    this.#generation++;
    this.#abort.abort(); this.#abort = new AbortController();
    this.#poll(); this.#freshness(); this.#expiry(); this.#visibility();
    this.#sequence = 0; this.#accepted = 0;
    this.#view = initial(); this.change({});
  }

  activate() {
    if (this.#active) return;
    this.#active = true;
    this.#visibility = this.system.watchVisibility(() => {
      this.expireEnrollment();
      if (this.system.visible()) void this.refresh();
    });
    this.poll();
    void this.refresh();
  }

  private poll() {
    this.#poll = this.system.schedule(() => {
      if (!this.available()) return;
      if (this.system.visible()) void this.refresh();
      this.poll();
    }, 30_000);
  }

  private freshness() {
    this.#freshness();
    if (!this.available() || this.#view.lastGood === null) return;
    const remaining = 60_000 - (this.system.now() - this.#view.lastGood);
    if (remaining > 0) this.#freshness = this.system.schedule(() => this.freshness(), remaining);
    else if (!this.#view.stale) {
      this.change({ stale: true, message: 'Worker state is out of date. Refresh before making changes.' });
      this.report('stale_data', this.#view.operationID, this.#view.requestID, this.#sequence, 0);
    }
  }

  private report(cause: BrowserReport['cause'], operation: string, requestID: string, sequence: number, duration: number, workerID = '') {
    this.reports.add({ event: 'portal.worker_state_stale', component: 'workers', cause, request_id: requestID, operation_id: operation,
      expected_state: 'fresh', observed_state: 'stale', last_good_at: this.#view.lastGood === null ? null : new Date(this.#view.lastGood).toISOString(),
      duration_ms: Math.max(0, Math.min(86_400_000, duration)), attempt: 1, worker_id: workerID,
      request_sequence: sequence, accepted_sequence: this.#accepted, latest_sequence: this.#sequence, session_generation: this.#generation });
  }

  async refresh() {
    if (!this.available()) return;
    this.expireEnrollment(); this.freshness();
    if (this.#view.pending) return;
    const generation = this.#generation;
    const sequence = ++this.#sequence;
    const operation = this.system.id();
    const started = this.system.now();
    this.change({ loading: true, operationID: operation });
    try {
      const result = await this.api.workers(operation, this.#abort.signal);
      if (generation !== this.#generation || !this.available()) return;
      if (sequence !== this.#sequence) { this.report('obsolete_response', operation, result.requestID, sequence, this.system.now() - started); return; }
      this.#accepted = sequence;
      this.change({ workers: result.value, selectedID: result.value.some(worker => worker.id === this.#view.selectedID) ? this.#view.selectedID : '',
        stale: false, lastGood: this.system.now(), message: '', requestID: result.requestID });
      this.freshness();
      await this.reports.flush();
    } catch (error) {
      if (generation !== this.#generation || !this.available()) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (sequence !== this.#sequence) { this.report('obsolete_response', operation, failure.requestID, sequence, this.system.now() - started); return; }
      if (failure.status === 401) { this.denied(); return; }
      this.change({ stale: true, message: failure.status === 403 ? 'Access to worker management was denied.' : 'Could not refresh workers. Check the connection and retry.', requestID: failure.requestID });
      this.report(failure.causeCode === 'request_timeout' ? 'request_timeout' : failure.status >= 500 ? 'service_unavailable' : 'request_failed', operation, failure.requestID, sequence, this.system.now() - started);
    } finally { if (generation === this.#generation && sequence === this.#sequence) this.change({ loading: false }); }
  }

  select(id: string) {
    if (this.#view.pending || (id && !this.#view.workers?.some(worker => worker.id === id))) return;
    this.change({ selectedID: id, actionMessage: '', actionRequestID: '', actionOperationID: '' });
  }

  async mutate(kind: 'rename' | 'revoke', id: string, name = '') {
    if (!this.available()) return;
    this.freshness();
    if (this.#view.stale || this.#view.pending || !this.#view.workers?.some(worker => worker.id === id)) return;
    const generation = this.#generation;
    const sequence = ++this.#sequence;
    const operation = this.system.id();
    const started = this.system.now();
    this.change({ pending: kind, loading: false, actionMessage: '', actionRequestID: '', actionOperationID: operation });
    try {
      const result = kind === 'rename' ? await this.api.renameWorker(id, name, operation, this.#abort.signal) : await this.api.revokeWorker(id, operation, this.#abort.signal);
      if (generation !== this.#generation || !this.available()) return;
      this.#accepted = sequence;
      this.change({ workers: this.#view.workers!.map(worker => worker.id === id ? result.value : worker), actionRequestID: result.requestID,
        actionMessage: kind === 'rename' ? 'Display name saved. The accepted name is shown above.' : 'The server confirmed revocation. History is retained; remote activity may remain unknown.' });
    } catch (error) {
      if (generation !== this.#generation || !this.available()) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.denied(); return; }
      const rejected = failure.status >= 400 && failure.status < 500;
      const message = failure.causeCode === 'invalid_worker_name' ? 'Name not accepted. Use 1–100 Unicode characters, with no control characters; surrounding spaces are trimmed.' :
        failure.status === 403 ? 'The server denied this action.' : failure.status === 404 ? 'The worker was not found. Refresh the list.' :
        rejected ? 'The server rejected this action. Refresh before trying again.' : 'The action could not be confirmed. It may have completed. Refresh to reconcile the server state before trying again.';
      this.change({ actionMessage: message, actionRequestID: failure.requestID, stale: this.#view.stale || failure.causeCode !== 'invalid_worker_name' });
      if (!rejected) this.report(failure.causeCode === 'request_timeout' ? 'request_timeout' : 'request_failed', operation, failure.requestID, sequence, this.system.now() - started, id);
    } finally { if (generation === this.#generation) this.change({ pending: '' }); }
  }

  private expireEnrollment() {
    this.#expiry();
    const enrollment = this.#view.enrollment;
    if (!enrollment) return;
    const remaining = Date.parse(enrollment.expires_at) - this.system.now();
    if (remaining <= 0) this.change({ enrollment: null, enrollmentMessage: 'Enrollment expired. Generate fresh setup text or a new code.' });
    else this.#expiry = this.system.schedule(() => this.expireEnrollment(), remaining);
  }

  async createEnrollment(kind: EnrollmentKind) {
    if (!this.available() || this.#view.pending) return;
    const generation = this.#generation;
    const operation = this.system.id();
    this.#expiry();
    this.change({ enrollment: null, enrollmentKind: kind, enrollmentMessage: '', pending: 'enrollment', actionMessage: '', actionRequestID: '', actionOperationID: operation });
    try {
      const result = await this.api.enrollment(kind, operation, this.#abort.signal);
      if (generation !== this.#generation || !this.available()) return;
      this.change({ enrollment: result.value, actionRequestID: result.requestID });
      this.expireEnrollment();
    } catch (error) {
      if (generation !== this.#generation || !this.available()) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.denied(); return; }
      this.change({ enrollmentMessage: failure.causeCode === 'worker_package_unconfigured' ? 'Setup text is unavailable. Configure the worker package version and digest on the broker, then try again.' :
        failure.status === 403 ? 'The server denied enrollment creation.' : 'Enrollment creation could not be confirmed. No setup text is available. Generate a new enrollment to try again.', actionRequestID: failure.requestID });
    } finally { if (generation === this.#generation) this.change({ pending: '' }); }
  }

  async copyEnrollment() {
    if (!this.available()) return;
    this.expireEnrollment();
    const enrollment = this.#view.enrollment;
    if (!enrollment) return;
    const generation = this.#generation;
    try {
      await this.clipboard(enrollment.setup_prompt ?? enrollment.enrollment_code!);
      if (generation === this.#generation && this.#view.enrollment === enrollment) {
        this.expireEnrollment();
        if (this.#view.enrollment) this.change({ enrollmentMessage: 'Copied. Keep this single-use enrollment private.' });
      }
    } catch {
      if (generation === this.#generation && this.#view.enrollment === enrollment) this.change({ enrollmentMessage: 'Clipboard access failed. Select the text below and copy it manually.' });
    }
  }
}
