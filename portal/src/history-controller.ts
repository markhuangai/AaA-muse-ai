import { APIError, type API, type BrowserReport } from './api';
import type { System } from './controller';
import { historyID, type HistoryPage, type RequestDetail, type RequestSummary, type TimelineEntry } from './history-api';
import type { Reports } from './reports';
import type { Worker } from './worker-api';

export interface HistoryRead<T> {
  value: T | null; cursor: string; back: string[]; loading: boolean; stale: boolean; lastGood: number | null;
  message: string; requestID: string; operationID: string;
}
interface Values { list: HistoryPage<RequestSummary>; detail: RequestDetail; timeline: HistoryPage<TimelineEntry> }
export type HistoryResource = keyof Values;
type Resource = HistoryResource;
export interface HistoryView {
  list: HistoryRead<Values['list']>; detail: HistoryRead<Values['detail']>; timeline: HistoryRead<Values['timeline']>;
  conversation: string; selectedID: string; workers: Worker[] | null; namesStale: boolean;
  pending: boolean; actionMessage: string; actionRequestID: string; actionOperationID: string; unconfirmed: boolean;
}
const empty = <T>(): HistoryRead<T> => ({ value: null, cursor: '', back: [], loading: false, stale: true, lastGood: null, message: '', requestID: '', operationID: '' });
const initial = (): HistoryView => ({ list: empty(), detail: empty(), timeline: empty(), conversation: '', selectedID: '', workers: null, namesStale: true,
  pending: false, actionMessage: '', actionRequestID: '', actionOperationID: '', unconfirmed: false });
const queryKind = (resource: Resource): 'requests' | 'request' | 'timeline' => resource === 'list' ? 'requests' : resource === 'detail' ? 'request' : 'timeline';

export class HistoryController {
  #view = initial();
  #listeners = new Set<() => void>();
  #active = false;
  #generation = 0;
  #queryGeneration = 0;
  #selectionGeneration = 0;
  #sequence = 0;
  #latest = { list: 0, detail: 0, timeline: 0, workers: 0 };
  #accepted = { list: 0, detail: 0, timeline: 0, workers: 0 };
  #abort = new AbortController();
  #poll = () => {};
  #freshness = () => {};
  #visibility = () => {};
  #pendingReads = new Map<number, { resource: Resource; operation: string; started: number; cursor: string; conversation: string; id: string }>();
  constructor(private api: API, private system: System, private reports: Reports, private authorized: () => boolean, private denied: () => void) {}
  snapshot = () => this.#view;
  subscribe = (listener: () => void) => { this.#listeners.add(listener); return () => { this.#listeners.delete(listener); }; };
  private change(patch: Partial<HistoryView>) { this.#view = { ...this.#view, ...patch }; for (const listener of this.#listeners) listener(); }
  private changeRead<K extends Resource>(resource: K, patch: Partial<HistoryRead<Values[K]>>) {
    this.change({ [resource]: { ...this.#view[resource], ...patch } });
  }
  private available() { return this.#active && this.authorized(); }
  private key(resource: Resource) {
    return resource === 'list' ? `${this.#view.conversation}:${this.#view.list.cursor}` : `${this.#view.selectedID}:${this.#view[resource].cursor}`;
  }

  reset() {
    this.#active = false; this.#generation++; this.#abort.abort(); this.#abort = new AbortController();
    this.#poll(); this.#freshness(); this.#visibility();
    this.#latest = { list: 0, detail: 0, timeline: 0, workers: 0 }; this.#accepted = { ...this.#latest };
    this.#view = initial(); this.change({});
    this.#pendingReads.clear();
  }
  hasPendingReads() { return this.#pendingReads.size > 0; }
  async abandon() {
    if (!this.available()) return;
    this.invalidate();
    for (const [sequence, pending] of this.#pendingReads) {
      this.report('portal.history_load_failed', 'obsolete_response', pending.resource, pending.operation, '', sequence, this.system.now() - pending.started, pending.cursor, pending.conversation, pending.id);
    }
    this.reset();
    await this.reports.drain();
  }
  activate() {
    if (this.#active) return;
    this.#active = true;
    this.#visibility = this.system.watchVisibility(() => { if (this.system.visible()) void this.refresh(false); });
    this.poll(); void this.refresh();
  }
  private poll() {
    this.#poll = this.system.schedule(() => {
      if (!this.available()) return;
      if (this.system.visible()) void this.refresh(false);
      this.poll();
    }, 30_000);
  }
  private freshness() {
    this.#freshness();
    if (!this.available()) return;
    let remaining = 60_000;
    for (const resource of ['list', 'detail', 'timeline'] as const) {
      const read = this.#view[resource];
      if (read.lastGood === null || read.stale) continue;
      const until = 60_000 - (this.system.now() - read.lastGood);
      if (until > 0) remaining = Math.min(remaining, until);
      else {
        this.changeRead(resource, { stale: true, message: 'This history snapshot is out of date. Refresh to reconcile the server state.' });
        this.report('portal.history_load_failed', 'stale_data', resource, read.operationID, read.requestID, this.#latest[resource], 0, read.cursor);
      }
    }
    this.#freshness = this.system.schedule(() => this.freshness(), remaining);
  }
  private report(event: BrowserReport['event'], cause: BrowserReport['cause'], resource: Resource | 'cancel' | 'workers', operation: string, requestID: string,
    sequence: number, duration: number, cursor = '', conversation = resource === 'list' ? this.#view.conversation : this.#view.detail.value?.request.conversation_id ?? this.#view.conversation, id = this.#view.selectedID) {
    const source = resource === 'cancel' ? 'detail' : resource;
    const read = source === 'workers' ? this.#view.list : this.#view[source];
    this.reports.add({ event, component: 'history', cause, request_id: requestID, operation_id: operation,
      expected_state: event === 'portal.render_failed' ? 'rendered' : 'fresh', observed_state: event === 'portal.render_failed' ? 'failed' : 'stale',
      last_good_at: read.lastGood === null ? null : new Date(read.lastGood).toISOString(), duration_ms: Math.max(0, Math.min(86_400_000, duration)), attempt: 1,
      query_kind: resource === 'cancel' || resource === 'workers' ? resource : queryKind(resource), cursor, conversation_id: conversation, request_record_id: id,
      request_sequence: Math.max(1, sequence), accepted_sequence: this.#accepted[source], latest_sequence: Math.max(1, sequence, this.#sequence), session_generation: this.#generation,
      query_generation: this.#queryGeneration, selection_generation: this.#selectionGeneration });
  }
  private async read<K extends Resource>(resource: K, load: (operation: string, signal: AbortSignal) => Promise<{ value: Values[K]; requestID: string }>) {
    if (!this.available() || this.#view.pending) return;
    const generation = this.#generation, key = this.key(resource), sequence = ++this.#sequence, operation = this.system.id(), started = this.system.now();
    const cursor = this.#view[resource].cursor, conversation = resource === 'list' ? this.#view.conversation : this.#view.detail.value?.request.conversation_id ?? '', id = this.#view.selectedID;
    this.#pendingReads.set(sequence, { resource, operation, started, cursor, conversation, id });
    this.#latest[resource] = sequence;
    this.changeRead(resource, { loading: true, operationID: operation });
    const current = () => this.key(resource) === key && sequence === this.#latest[resource];
    try {
      const result = await load(operation, this.#abort.signal);
      if (generation !== this.#generation || !this.available()) return;
      if (!current()) { this.report('portal.history_load_failed', 'obsolete_response', resource, operation, result.requestID, sequence, this.system.now() - started, cursor, conversation, id); return; }
      this.#accepted[resource] = sequence;
      this.changeRead(resource, { value: result.value, requestID: result.requestID, lastGood: this.system.now(), stale: false, message: '' });
      if (resource === 'detail' && this.#view.unconfirmed) this.change({ actionMessage: `Current server state: ${this.#view.detail.value!.execution.state}. The previous cancellation response was unconfirmed.`, unconfirmed: false });
      this.freshness(); await this.reports.flush();
    } catch (error) {
      if (generation !== this.#generation || !this.available()) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (!current()) { this.report('portal.history_load_failed', 'obsolete_response', resource, operation, failure.requestID, sequence, this.system.now() - started, cursor, conversation, id); return; }
      if (failure.status === 401) { this.denied(); return; }
      const message = failure.status === 404 ? 'The recorded request was not found.' : failure.causeCode === 'invalid_cursor' ? 'The page cursor was rejected. Return to the first page.' :
        failure.causeCode === 'invalid_response' ? 'The history response was invalid. Refresh or reload the matching portal build.' : 'Could not load request history. Check the connection and retry.';
      this.changeRead(resource, { stale: true, message, requestID: failure.requestID });
      this.report('portal.history_load_failed', failure.causeCode === 'request_timeout' ? 'request_timeout' : failure.causeCode === 'invalid_response' ? 'invalid_response' : failure.status >= 500 ? 'service_unavailable' : 'request_failed', resource, operation, failure.requestID, sequence, this.system.now() - started, cursor, conversation, id);
    } finally { this.#pendingReads.delete(sequence); if (generation === this.#generation && current()) this.changeRead(resource, { loading: false }); }
  }
  private loadList() { return this.read('list', (op, signal) => this.api.requests(this.#view.conversation, this.#view.list.cursor, op, signal)); }
  private loadTimeline() {
    const conversation = this.#view.detail.value?.request.conversation_id;
    if (!conversation) return Promise.resolve();
    return this.read('timeline', (op, signal) => this.api.timeline(conversation, this.#view.timeline.cursor, op, signal));
  }
  private async loadDetail(explicit: boolean) {
    const id = this.#view.selectedID;
    if (!id) return;
    await this.read('detail', (op, signal) => this.api.requestDetail(id, op, signal));
    if (id !== this.#view.selectedID || !this.available() || this.#view.detail.stale) return;
    if (explicit || !this.#view.timeline.value?.next_cursor) await this.loadTimeline();
  }
  private async loadNames() {
    const generation = this.#generation, sequence = ++this.#sequence, operation = this.system.id(), started = this.system.now();
    this.#latest.workers = sequence;
    try {
      const result = await this.api.workers(operation, this.#abort.signal);
      if (generation !== this.#generation || !this.available() || sequence !== this.#latest.workers) return;
      this.#accepted.workers = sequence; this.change({ workers: result.value, namesStale: false });
    } catch (error) {
      if (generation !== this.#generation || !this.available() || sequence !== this.#latest.workers) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.denied(); return; }
      this.change({ namesStale: true });
      this.report('portal.history_load_failed', 'request_failed', 'workers', operation, failure.requestID, sequence, this.system.now() - started);
    }
  }
  async refresh(explicit = true) {
    if (!this.available() || this.#view.pending) return;
    this.freshness();
    await Promise.all([explicit || !this.#view.list.cursor ? this.loadList() : undefined, this.loadDetail(explicit), this.loadNames()]);
  }
  async filter(conversation: string) {
    if (!this.available() || this.#view.pending) return;
    const value = conversation.trim();
    if (value && !historyID(value)) { this.changeRead('list', { message: 'Use a conversation ID containing letters, numbers, underscores or hyphens, up to 100 characters.' }); return; }
    this.invalidate();
    this.#queryGeneration++; this.#selectionGeneration++;
    this.change({ conversation: value, selectedID: '', list: empty(), detail: empty(), timeline: empty(), actionMessage: '' });
    await this.loadList();
  }
  async select(id: string) {
    if (!this.available() || this.#view.pending) return;
    if (id && !historyID(id)) { this.changeRead('list', { message: 'Enter a valid request ID.' }); return; }
    this.invalidate();
    this.#selectionGeneration++;
    this.change({ selectedID: id, detail: empty(), timeline: empty(), actionMessage: '', actionRequestID: '', actionOperationID: '', unconfirmed: false });
    await this.loadDetail(true);
  }
  async page(resource: 'list' | 'timeline', direction: 'next' | 'previous' | 'first') {
    if (!this.available() || this.#view.pending || this.#view[resource].loading) return;
    const read = this.#view[resource], back = [...read.back];
    let cursor = '';
    if (direction === 'next') { if (!read.value?.next_cursor) return; cursor = read.value.next_cursor; back.push(read.cursor); }
    else if (direction === 'previous') { if (!back.length) return; cursor = back.pop()!; }
    else back.length = 0;
    this.#latest[resource] = ++this.#sequence;
    this.#queryGeneration++;
    this.changeRead(resource, { cursor, back, message: '', stale: true });
    await (resource === 'list' ? this.loadList() : this.loadTimeline());
  }
  private invalidate() {
    for (const resource of ['list', 'detail', 'timeline'] as const) { this.#latest[resource] = ++this.#sequence; this.changeRead(resource, { loading: false }); }
  }
  canCancel() {
    const read = this.#view.detail;
    return this.available() && !this.#view.pending && !read.stale && !!read.value && ['queued', 'inference', 'waiting_for_tool'].includes(read.value.execution.state);
  }
  async cancel(id: string) {
    this.freshness();
    if (!this.canCancel() || id !== this.#view.selectedID) return;
    this.invalidate();
    const generation = this.#generation, operation = this.system.id(), sequence = ++this.#sequence, started = this.system.now();
    this.change({ pending: true, actionMessage: '', actionRequestID: '', actionOperationID: operation });
    let confirmed = false;
    try {
      const result = await this.api.cancelRequest(id, this.system.id(), operation, this.#abort.signal);
      if (generation !== this.#generation || !this.available()) return;
      this.change({ actionMessage: `Server recorded ${result.value.state}. Remote outcome: ${result.value.remote_outcome}. Remote execution stopping is not guaranteed.`, actionRequestID: result.requestID, unconfirmed: false });
      this.changeRead('detail', { stale: true, value: { ...this.#view.detail.value!, execution: result.value } });
      confirmed = true;
    } catch (error) {
      if (generation !== this.#generation || !this.available()) return;
      const failure = error instanceof APIError ? error : new APIError('request_failed');
      if (failure.status === 401) { this.denied(); return; }
      const rejected = failure.status >= 400 && failure.status < 500;
      this.change({ actionMessage: rejected ? 'The server rejected cancellation. Refresh to see its current state.' : 'Cancellation could not be confirmed. It may have completed. Refresh to reconcile; do not retry the action automatically.', actionRequestID: failure.requestID, unconfirmed: !rejected });
      this.changeRead('detail', { stale: true });
      if (!rejected) this.report('portal.cancel_result', failure.causeCode === 'request_timeout' ? 'request_timeout' : failure.causeCode === 'invalid_response' ? 'invalid_response' : 'request_failed', 'cancel', operation, failure.requestID, sequence, this.system.now() - started);
    } finally {
      if (generation === this.#generation) {
        this.change({ pending: false });
        if (confirmed) await this.refresh();
      }
    }
  }
  renderFailed(resource: Resource = this.#view.selectedID ? 'detail' : 'list') {
    if (!this.available()) return;
    const read = this.#view[resource];
    this.report('portal.render_failed', 'render_exception', resource, this.system.id(), read.requestID, this.#latest[resource] || 1, 0, read.cursor);
  }
}
