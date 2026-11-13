import { isEnrollment, isWorker, object, type Enrollment, type EnrollmentKind, type Worker } from './worker-api';

export const BUILD = import.meta.env.VITE_SOURCE_SHA || 'development';
export type Schedule = (callback: () => void, delay: number) => () => void;
export const schedule: Schedule = (callback, delay) => {
  const timer = globalThis.setTimeout(callback, delay);
  return () => globalThis.clearTimeout(timer);
};

export interface Session { session_token: string; expires_at: string }
export interface Settings {
  build: { revision: string; dirty: boolean };
  instance_id: string;
  public_origin: string;
  ready: boolean;
  database: string;
  schema_version: number;
  effective_yaml: string;
  capabilities: string[];
}
export interface BrowserReport {
  event: 'portal.state_stale' | 'portal.render_failed' | 'portal.worker_state_stale';
  build: string;
  component: 'settings' | 'shell' | 'login' | 'workers';
  cause: 'request_failed' | 'request_timeout' | 'service_unavailable' | 'session_expired' | 'build_mismatch' | 'render_exception' | 'stale_data' | 'obsolete_response';
  request_id: string;
  operation_id: string;
  expected_state: 'fresh' | 'rendered' | 'authenticated';
  observed_state: 'stale' | 'failed' | 'unauthenticated';
  last_good_at: string | null;
  duration_ms: number;
  attempt: number;
  omitted_reports: number;
  worker_id?: string;
  request_sequence?: number;
  accepted_sequence?: number;
  latest_sequence?: number;
  session_generation?: number;
}

export class APIError extends Error {
  constructor(public causeCode: string, public status = 0, public requestID = '', public retryAfter = 0) {
    super(causeCode);
  }
}

export interface API {
  setSession(token: string | null): void;
  login(password: string, operation: string, signal: AbortSignal): Promise<Session>;
  logout(operation: string, signal: AbortSignal): Promise<void>;
  settings(operation: string, signal: AbortSignal): Promise<{ value: Settings; requestID: string }>;
  workers(operation: string, signal: AbortSignal): Promise<{ value: Worker[]; requestID: string }>;
  renameWorker(id: string, name: string, operation: string, signal: AbortSignal): Promise<{ value: Worker; requestID: string }>;
  revokeWorker(id: string, operation: string, signal: AbortSignal): Promise<{ value: Worker; requestID: string }>;
  enrollment(kind: EnrollmentKind, operation: string, signal: AbortSignal): Promise<{ value: Enrollment; requestID: string }>;
  report(value: BrowserReport, signal: AbortSignal): Promise<void>;
}

export class BrowserAPI implements API {
  #token: string | null = null;
  constructor(private fetcher: typeof fetch = globalThis.fetch.bind(globalThis), private timer: Schedule = schedule) {}
  setSession(token: string | null) { this.#token = token; }

  private async request(path: string, method: string, operation: string, signal: AbortSignal, body?: unknown, authenticated = true) {
    const abort = new AbortController();
    let timedOut = false;
    const cancel = () => abort.abort();
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    const stop = this.timer(() => { timedOut = true; abort.abort(); }, 10_000);
    const headers: Record<string, string> = { 'X-Portal-Operation-Id': operation };
    if (authenticated && this.#token) headers.Authorization = `Bearer ${this.#token}`;
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      const response = await this.fetcher(path, { method, headers, signal: abort.signal, body: body === undefined ? undefined : JSON.stringify(body), credentials: 'omit', cache: 'no-store', redirect: 'error' });
      const requestID = response.headers.get('X-Request-Id') || '';
      if (!response.ok) {
        let reason = response.status === 401 ? 'unauthorized' : response.status === 429 ? 'throttled' : response.status >= 500 ? 'service_unavailable' : 'request_failed';
        try {
          const data: unknown = await response.json();
          if (object(data) && ['invalid_worker_name', 'worker_not_found', 'worker_package_unconfigured'].includes(String(data.error))) reason = String(data.error);
        } catch { /* Error bodies are untrusted; retain the HTTP classification. */ }
        const retry = Number(response.headers.get('Retry-After'));
        throw new APIError(reason, response.status, requestID, Number.isFinite(retry) ? Math.max(0, Math.min(3600, retry)) : 0);
      }
      if (response.status === 204) return { data: null, requestID };
      let data: unknown;
      try { data = await response.json(); } catch {
        throw new APIError(abort.signal.aborted ? timedOut ? 'request_timeout' : 'request_aborted' : 'invalid_response', response.status, requestID);
      }
      return { data, requestID };
    } catch (error) {
      if (error instanceof APIError) throw error;
      throw new APIError(timedOut ? 'request_timeout' : signal.aborted ? 'request_aborted' : 'request_failed');
    } finally {
      stop();
      signal.removeEventListener('abort', cancel);
    }
  }

  async login(password: string, operation: string, signal: AbortSignal): Promise<Session> {
    const result = await this.request('/api/v1/portal/login', 'POST', operation, signal, { password }, false);
    const data = result.data;
    if (!object(data) || typeof data.session_token !== 'string' || !/^muse_portal_[A-Za-z0-9_-]{43}$/.test(data.session_token) || typeof data.expires_at !== 'string' || !Number.isFinite(Date.parse(data.expires_at))) {
      throw new APIError('invalid_response', 200, result.requestID);
    }
    return { session_token: data.session_token, expires_at: data.expires_at };
  }

  async logout(operation: string, signal: AbortSignal) {
    await this.request('/api/v1/portal/logout', 'POST', operation, signal);
  }

  async settings(operation: string, signal: AbortSignal) {
    const result = await this.request('/api/v1/portal/settings', 'GET', operation, signal);
    const data = result.data;
    if (!object(data) || !object(data.build) || typeof data.build.revision !== 'string' || typeof data.build.dirty !== 'boolean' ||
      typeof data.instance_id !== 'string' || typeof data.public_origin !== 'string' || typeof data.ready !== 'boolean' ||
      typeof data.database !== 'string' || !Number.isSafeInteger(data.schema_version) || typeof data.effective_yaml !== 'string' ||
      !Array.isArray(data.capabilities) || !data.capabilities.every(value => typeof value === 'string')) {
      throw new APIError('invalid_response', 200, result.requestID);
    }
    return { value: data as unknown as Settings, requestID: result.requestID };
  }

  async report(value: BrowserReport, signal: AbortSignal) {
    await this.request('/api/v1/portal/events', 'POST', value.operation_id, signal, value);
  }

  async workers(operation: string, signal: AbortSignal) {
    const result = await this.request('/api/v1/admin/workers', 'GET', operation, signal);
    if (!object(result.data) || !Array.isArray(result.data.workers) || !result.data.workers.every(isWorker) ||
      new Set(result.data.workers.map(worker => worker.id)).size !== result.data.workers.length) throw new APIError('invalid_response', 200, result.requestID);
    return { value: result.data.workers, requestID: result.requestID };
  }

  private async workerAction(id: string, method: string, suffix: string, operation: string, signal: AbortSignal, body?: unknown) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new APIError('invalid_worker_id');
    const result = await this.request(`/api/v1/admin/workers/${id}${suffix}`, method, operation, signal, body);
    if (!isWorker(result.data) || result.data.id !== id) throw new APIError('invalid_response', 200, result.requestID);
    return { value: result.data, requestID: result.requestID };
  }

  async renameWorker(id: string, name: string, operation: string, signal: AbortSignal) {
    return this.workerAction(id, 'PATCH', '', operation, signal, { name });
  }

  async revokeWorker(id: string, operation: string, signal: AbortSignal) {
    return this.workerAction(id, 'POST', '/revoke', operation, signal);
  }

  async enrollment(kind: EnrollmentKind, operation: string, signal: AbortSignal) {
    const result = await this.request(kind === 'prompt' ? '/api/v1/admin/setup-prompts' : '/api/v1/admin/enrollments', 'POST', operation, signal);
    if (!isEnrollment(result.data, kind)) throw new APIError('invalid_response', 201, result.requestID);
    return { value: result.data, requestID: result.requestID };
  }
}
