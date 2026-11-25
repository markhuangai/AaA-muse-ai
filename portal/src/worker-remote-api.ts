import { APIError } from './api';
import { object } from './worker-api';

export type ControlLane = 'ops' | 'agent-tasks';
export type OpKind = 'doctor' | 'diagnostics_export' | 'retry_update';
export interface DiagnosticFilters {
  operation_id?: string;
  request_id?: string;
  since?: string;
  until?: string;
  decode: boolean;
  cursor?: string;
}
export interface ControlItem {
  id: string;
  worker_id: string;
  kind?: OpKind;
  title?: string;
  state: string;
  held: boolean;
  created_at: string;
  deadline_at: string;
  reason?: string;
  reason_message?: string;
  remote_outcome: string;
  prompt?: string;
  claim?: { params?: Partial<DiagnosticFilters> };
  result?: unknown;
}
interface ControlPage { items: ControlItem[]; next_cursor?: string }
type RequestResult = { data: unknown; requestID: string; status: number };
type Request = (path: string, method: string, operation: string, signal: AbortSignal, body?: unknown) => Promise<RequestResult>;
const identifier = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const isActive = (item: ControlItem) => item.held || ['queued', 'claimed', 'running'].includes(item.state);

export function isControlItem(value: unknown): value is ControlItem {
  return object(value) && identifier(value.id) && identifier(value.worker_id) &&
    (value.kind === undefined || ['doctor', 'diagnostics_export', 'retry_update'].includes(String(value.kind))) &&
    ['queued', 'claimed', 'running', 'succeeded', 'completed', 'failed', 'refused', 'cancelled', 'interrupted'].includes(String(value.state)) &&
    typeof value.held === 'boolean' && date(value.created_at) && date(value.deadline_at) &&
    typeof value.remote_outcome === 'string' && [value.title, value.reason, value.reason_message, value.prompt].every(field => field === undefined || typeof field === 'string');
}

function controlPath(worker: string, suffix: string) {
  return '/api/v1/admin/workers/' + encodeURIComponent(worker) + '/' + suffix;
}

function itemResult(result: RequestResult, worker: string, status: number, id?: string) {
  if (result.status !== status || !isControlItem(result.data) || result.data.worker_id !== worker || (id !== undefined && result.data.id !== id)) {
    throw new APIError('invalid_response', result.status, result.requestID);
  }
  return { value: result.data, requestID: result.requestID };
}

export class WorkerRemoteAPI {
  constructor(private request: Request) {}

  async list(worker: string, lane: ControlLane, operation: string, signal: AbortSignal) {
    const result = await this.request(controlPath(worker, lane), 'GET', operation, signal);
    const data = result.data;
    if (!object(data) || !Array.isArray(data.items) || !data.items.every(item => isControlItem(item) && item.worker_id === worker) ||
      !(data.next_cursor === undefined || typeof data.next_cursor === 'string')) {
      throw new APIError('invalid_response', result.status, result.requestID);
    }
    return { value: data as unknown as ControlPage, requestID: result.requestID };
  }

  async detail(worker: string, lane: ControlLane, id: string, operation: string, signal: AbortSignal) {
    return itemResult(await this.request(controlPath(worker, lane + '/' + encodeURIComponent(id)), 'GET', operation, signal), worker, 200, id);
  }

  async submit(worker: string, lane: ControlLane, payload: Record<string, unknown>, submission: string, operation: string, signal: AbortSignal) {
    return itemResult(await this.request(controlPath(worker, lane), 'POST', operation, signal, {
      ...payload, protocol_version: 1, submission_id: submission,
    }), worker, 202);
  }

  async cancel(worker: string, lane: ControlLane, id: string, submission: string, operation: string, signal: AbortSignal) {
    return itemResult(await this.request(controlPath(worker, lane + '/' + encodeURIComponent(id) + '/cancel'), 'POST', operation, signal, {
      protocol_version: 1, submission_id: submission,
    }), worker, 200, id);
  }

  async hookPrompt(worker: string, operation: string, signal: AbortSignal) {
    const result = await this.request(controlPath(worker, 'hook-prompt'), 'GET', operation, signal);
    if (!object(result.data) || result.data.worker_id !== worker || result.data.hook_id !== 'aaa-muse-worker-' + worker ||
      result.data.prompt_contract !== 'managed-hook-prompt-v2' || typeof result.data.upgrade_prompt !== 'string' || !result.data.upgrade_prompt) {
      throw new APIError('invalid_response', result.status, result.requestID);
    }
    return { value: result.data.upgrade_prompt, requestID: result.requestID };
  }
}
