import { object } from './worker-api';

const runtime = JSON as typeof JSON & { rawJSON(value: string): unknown };
class RecordedNumber {
  constructor(private source: string) {}
  toJSON() { return runtime.rawJSON(this.source); }
}
export function parseRecordedJSON(source: string): unknown {
  return JSON.parse(source, (_key: string, value: unknown, context?: { source?: string }) => {
    if (typeof value !== 'number') return value;
    if (!context?.source) throw new Error('lossless_json_runtime_required');
    return JSON.stringify(value) === context.source ? value : new RecordedNumber(context.source);
  });
}

export const historyID = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
export const historyCursor = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9_-]{0,1024}$/.test(value);
const date = (value: unknown): value is string => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableID = (value: unknown) => value === null || value === '' || historyID(value);
export interface HistoryPage<T> { items: T[]; next_cursor?: string }
export interface RequestSummary {
  kind: 'native' | 'legacy'; id: string; conversation_id: string; client_id: string | null; session_id: string | null;
  worker_id: string | null; state: string; reason?: string | null; created_at: string; provenance: string; response_id?: string | null;
}
export interface Execution {
  id: string; worker_id: string | null; state: string; reason?: string | null; remote_outcome: string;
  created_at: string; deadline_at: string; current_job_id: string;
}
export interface RequestDetail {
  kind: 'native' | 'legacy'; request: Record<string, unknown> & { id: string; conversation_id: string };
  execution: Execution; assignment: Record<string, unknown> | null; delivery: Record<string, unknown> | null;
  history?: Record<string, unknown>[] | null; provenance?: string;
}
export interface TimelineEntry {
  sequence: number; time: string | null; kind: string; level?: string | null; request_id: string | null;
  details?: Record<string, unknown> | null; item?: Record<string, unknown> | null; provenance?: string;
}

export function isSummary(value: unknown): value is RequestSummary {
  return object(value) && (value.kind === 'native' || value.kind === 'legacy') && historyID(value.id) && historyID(value.conversation_id) &&
    (value.client_id === null || typeof value.client_id === 'string') && nullableID(value.session_id) && nullableID(value.worker_id) &&
    typeof value.state === 'string' && date(value.created_at) && typeof value.provenance === 'string' &&
    (value.reason == null || typeof value.reason === 'string') && (value.response_id == null || historyID(value.response_id));
}

export function isExecution(value: unknown): value is Execution {
  return object(value) && historyID(value.id) && nullableID(value.worker_id) && typeof value.state === 'string' &&
    (value.reason == null || typeof value.reason === 'string') && typeof value.remote_outcome === 'string' &&
    date(value.created_at) && date(value.deadline_at) && (value.current_job_id === '' || historyID(value.current_job_id));
}

export function isDetail(value: unknown): value is RequestDetail {
  return object(value) && (value.kind === 'native' || value.kind === 'legacy') && object(value.request) && historyID(value.request.id) &&
    historyID(value.request.conversation_id) && isExecution(value.execution) && value.request.id === value.execution.id &&
    (value.assignment === null || object(value.assignment)) && (value.delivery === null || object(value.delivery)) &&
    (value.history == null || (Array.isArray(value.history) && value.history.every(object)));
}

export function isTimelineEntry(value: unknown): value is TimelineEntry {
  return object(value) && Number.isSafeInteger(value.sequence) && Number(value.sequence) >= 0 &&
    (value.time === null || date(value.time)) && typeof value.kind === 'string' && (value.request_id === null || historyID(value.request_id)) &&
    (value.level == null || typeof value.level === 'string') && (value.details == null || object(value.details)) && (value.item == null || object(value.item));
}

export function isHistoryPage<T>(value: unknown, entry: (item: unknown) => item is T): value is HistoryPage<T> {
  return object(value) && Array.isArray(value.items) && value.items.length <= 50 && value.items.every(entry) &&
    (value.next_cursor === undefined || (historyCursor(value.next_cursor) && value.next_cursor.length > 0));
}
