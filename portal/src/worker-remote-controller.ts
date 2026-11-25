import { APIError, type BrowserReport } from './api';
import type { System } from './controller';
import type { Reports } from './reports';
import { isActive, type ControlItem, type ControlLane, type WorkerRemoteAPI } from './worker-remote-api';

const lanes: ControlLane[] = ['ops', 'agent-tasks'];

type Entries<T> = Record<ControlLane, T>;
interface WorkerRemoteView {
  workerID: string;
  stale: boolean;
  loading: boolean;
  pending: boolean;
  uncertain: boolean;
  message: string;
  requestID: string;
  operationID: string;
  items: Entries<ControlItem[]>;
  details: Entries<ControlItem | null>;
  upgradePrompt: string;
  upgradeMessage: string;
}

const empty = (workerID = '', uncertain = false): WorkerRemoteView => ({ workerID, stale: true, loading: false, pending: false, uncertain,
  message: '', requestID: '', operationID: '', items: { ops: [], 'agent-tasks': [] }, details: { ops: null, 'agent-tasks': null },
  upgradePrompt: '', upgradeMessage: '' });

const errors = new Map([
  ['worker_revoked', 'Worker access was revoked. Refresh workers.'],
  ['unsupported_worker_migration', 'This worker needs managed-hook enrollment.'],
  ['worker_update_required', 'Wait for the worker to finish updating to the paired release.'],
  ['worker_op_queue_full', 'The operation queue is full.'],
  ['worker_op_already_pending', 'An update retry is already pending.'],
  ['worker_already_paired', 'The worker already runs the paired release.'],
  ['update_requires_newer_pair', 'An update requires a newer broker and worker release.'],
  ['update_target_unavailable', 'The broker has no verified update target.'],
  ['agent_task_queue_full', 'The task queue is full.'],
  ['worker_agent_tasks_unsupported', 'The worker must confirm its updated hook prompt.'],
  ['agent_task_already_terminal', 'This task has already ended. Refresh to see its outcome.'],
  ['worker_op_already_terminal', 'This operation has already ended. Refresh to see its outcome.'],
]);

export class WorkerRemoteController {
  #view = empty();
  #listeners = new Set<() => void>();
  #session = 0;
  #selection = 0;
  #sequence = 0;
  #accepted = 0;
  #detailSequence: Entries<number> = { ops: 0, 'agent-tasks': 0 };
  #promptSequence = 0;
  #lastGood: number | null = null;
  #uncertain = new Set<string>();
  #abort = new AbortController();
  #poll = () => {};
  #expiry = () => {};

  constructor(private api: WorkerRemoteAPI, private system: System, private reports: Reports, private authorized: () => boolean,
    private mainFresh: () => boolean, private denied: (requestID: string, operationID: string) => void) {}
  snapshot = () => this.#view;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };

  select(workerID: string) {
    if (this.#view.workerID === workerID) return;
    if (this.#view.pending) this.#uncertain.add(this.#view.workerID);
    this.#selection++;
    this.#abort.abort();
    this.#abort = new AbortController();
    this.#expiry();
    this.#lastGood = null;
    this.#view = empty(workerID, this.#uncertain.has(workerID));
    this.change({});
    if (workerID) void this.refresh();
  }

  reset() {
    this.#session++;
    this.select('');
    this.#uncertain.clear();
  }

  private change(patch: Partial<WorkerRemoteView>) {
    this.#view = { ...this.#view, ...patch };
    this.#poll();
    if (this.#view.workerID && !this.#view.loading && !this.#view.pending &&
      lanes.some(lane => this.#view.items[lane].some(isActive))) {
      this.#poll = this.system.schedule(() => {
        if (this.system.visible()) void this.refresh();
        else this.change({});
      }, 5000);
    }
    for (const listener of this.#listeners) listener();
  }

  private current(selection: number) { return this.#selection === selection && this.authorized(); }

  private report(cause: BrowserReport['cause'], operation: string, requestID: string, sequence: number, started: number) {
    this.reports.add({ event: 'portal.worker_state_stale', component: 'workers', cause, request_id: requestID, operation_id: operation,
      expected_state: 'fresh', observed_state: 'stale', last_good_at: this.#lastGood === null ? null : new Date(this.#lastGood).toISOString(),
      worker_id: this.#view.workerID, duration_ms: Math.max(0, Math.min(86_400_000, this.system.now() - started)), attempt: 1,
      request_sequence: sequence, accepted_sequence: this.#accepted, latest_sequence: this.#sequence, session_generation: this.#session });
  }

  private expired() {
    if (this.#lastGood !== null && this.system.now() - this.#lastGood >= 60_000 && !this.#view.stale) {
      this.change({ stale: true });
    }
  }

  async refresh(reconcile = false) {
    if (!this.authorized() || !this.#view.workerID || this.#view.pending) return;
    const selection = this.#selection;
    const sequence = ++this.#sequence;
    const operation = this.system.id();
    const { workerID } = this.#view;
    const started = this.system.now();
    this.change({ loading: true });
    try {
      const results = await Promise.all(lanes.map(lane => this.api.list(workerID, lane, operation, this.#abort.signal)));
      if (!this.current(selection)) return;
      if (sequence !== this.#sequence) {
        this.report('obsolete_response', operation, results[0].requestID, sequence, started);
        return;
      }
      this.#accepted = sequence;
      this.#lastGood = this.system.now();
      this.#expiry();
      this.#expiry = this.system.schedule(() => this.expired(), 60_000);
      if (reconcile) this.#uncertain.delete(workerID);
      const details = this.#view.details;
      this.change({ stale: false, uncertain: this.#uncertain.has(workerID), items: { ops: results[0].value.items, 'agent-tasks': results[1].value.items },
        ...(reconcile ? { message: 'Recent worker activity refreshed.', requestID: results[0].requestID, operationID: operation } : {}) });
      for (const lane of lanes) {
        const detail = details[lane];
        if (detail && isActive(detail)) void this.detail(lane, detail.id);
      }
      await this.reports.flush();
    } catch (error) {
      if (!this.current(selection)) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (sequence !== this.#sequence) {
        this.report('obsolete_response', operation, failure.requestID, sequence, started);
        return;
      }
      if (failure.status === 401) { this.denied(failure.requestID, operation); return; }
      this.change({ stale: true, message: 'Could not refresh remote activity.', requestID: failure.requestID, operationID: operation });
      this.report(readCause(failure), operation, failure.requestID, sequence, started);
    } finally {
      if (this.current(selection) && sequence === this.#sequence) this.change({ loading: false });
    }
  }

  async detail(lane: ControlLane, id: string) {
    if (!this.authorized() || !this.#view.workerID) return;
    const selection = this.#selection;
    const sequence = ++this.#detailSequence[lane];
    const operation = this.system.id();
    const selected = this.#view.details[lane];
    if (selected && selected.id !== id) {
      this.change({ details: { ...this.#view.details, [lane]: null } });
    }
    try {
      const result = await this.api.detail(this.#view.workerID, lane, id, operation, this.#abort.signal);
      if (this.current(selection) && sequence === this.#detailSequence[lane]) {
        this.change({ details: { ...this.#view.details, [lane]: result.value } });
      }
    } catch (error) {
      if (!this.current(selection) || sequence !== this.#detailSequence[lane]) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.denied(failure.requestID, operation); return; }
      this.change({ message: 'Could not load details.', requestID: failure.requestID, operationID: operation });
    }
  }

  async hookPrompt() {
    if (!this.authorized() || !this.#view.workerID) return;
    const selection = this.#selection;
    const sequence = ++this.#promptSequence;
    const operation = this.system.id();
    this.change({ upgradeMessage: 'Loading upgrade prompt…', upgradePrompt: '' });
    try {
      const result = await this.api.hookPrompt(this.#view.workerID, operation, this.#abort.signal);
      if (this.current(selection) && sequence === this.#promptSequence) this.change({ upgradePrompt: result.value, upgradeMessage: '' });
    } catch (error) {
      if (!this.current(selection) || sequence !== this.#promptSequence) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.denied(failure.requestID, operation); return; }
      this.change({ upgradeMessage: errors.get(failure.causeCode) ?? 'Could not load the hook upgrade prompt.' });
    }
  }

  async mutate(lane: ControlLane, payload: Record<string, unknown>, cancelID = '') {
    this.expired();
    const { workerID, stale, pending, uncertain } = this.#view;
    if (!workerID || stale || pending || uncertain || !this.authorized() || !this.mainFresh()) return false;
    const selection = this.#selection;
    const sequence = ++this.#sequence;
    ++this.#detailSequence[lane];
    const operation = this.system.id();
    const submission = this.system.id();
    const started = this.system.now();
    this.change({ pending: true, loading: false, message: '', operationID: operation, requestID: '' });
    try {
      const result = cancelID ? await this.api.cancel(workerID, lane, cancelID, submission, operation, this.#abort.signal) :
        await this.api.submit(workerID, lane, payload, submission, operation, this.#abort.signal);
      if (!this.current(selection)) return false;
      this.#accepted = sequence;
      const previous = this.#view.items[lane].filter(item => item.id !== result.value.id);
      const details = this.#view.details;
      const detail = details[lane];
      this.change({ items: { ...this.#view.items, [lane]: [result.value, ...previous].slice(0, 25) }, requestID: result.requestID,
        details: detail && detail.id === result.value.id ? { ...details, [lane]: { ...detail, ...result.value } } : details,
        message: cancelID ? 'The broker confirmed cancellation.' : 'The broker queued the request.' });
      return true;
    } catch (error) {
      if (!this.current(selection)) return false;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.denied(failure.requestID, operation); return false; }
      const rejected = failure.status >= 400 && failure.status < 500;
      if (!rejected) {
        this.#uncertain.add(workerID);
        this.report(readCause(failure), operation, failure.requestID, sequence, started);
      }
      this.change({ stale: true, uncertain: !rejected, requestID: failure.requestID,
        message: !rejected ? 'The broker response was unconfirmed. Refresh remote activity before submitting again.' :
          errors.get(failure.causeCode) ?? 'The broker rejected the request. Refresh before trying again.' });
      return false;
    } finally {
      if (this.current(selection)) this.change({ pending: false });
    }
  }
}

function readCause(failure: APIError): BrowserReport['cause'] {
  if (failure.causeCode === 'request_timeout' || failure.causeCode === 'invalid_response') return failure.causeCode;
  return failure.status >= 500 ? 'service_unavailable' : 'request_failed';
}
