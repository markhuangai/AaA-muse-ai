import { Failure, cause, requireValue } from './errors.js';
import { encode, parse, object, text, type ObjectValue, type Value } from './json.js';
import { Logger } from './diagnostics.js';
import { maxModelReportBytes } from './protocol.js';
import type { System } from './state.js';
import { VERSION } from './version.js';

export interface Network {
  fetch: typeof fetch;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}
export const network: Network = { fetch, setTimer: setTimeout, clearTimer: clearTimeout };
export const presenceTimeoutMs = 2500;
export interface Reply { data: ObjectValue; requestId: string; status: number }
export interface Event { id: string; type: string; data: ObjectValue }
function decoded(decoder: TextDecoder, bytes?: Uint8Array, streaming = false): string {
  try { return decoder.decode(bytes, { stream: streaming }); }
  catch { throw new Failure('invalid_utf8', { expected_encoding: 'utf-8', observed_encoding: 'invalid', observed_bytes: bytes?.length ?? 0 }); }
}
export function origin(input: string): string {
  let url: URL;
  try { url = new URL(input); } catch { throw new Failure('https_origin_required'); }
  requireValue(url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash, 'https_origin_required');
  return url.origin;
}
export function validateBody(input?: string): void {
  const limit = 1024 * 1024;
  const bytes = input === undefined ? 0 : Buffer.byteLength(input);
  requireValue(bytes <= limit, 'body_too_large', { max_bytes: limit, observed_bytes: bytes });
}

function controlRouteUnavailable(status: number, route: string, data: ObjectValue, credential: string): boolean {
  return !!credential && status === 404 && typeof data.error !== 'string' &&
    ['/api/v1/worker/status', '/api/v1/worker/events', '/api/v1/worker/heartbeat'].includes(route);
}

export class Transport {
  constructor(readonly endpoint: string, readonly credential: string, readonly logger: Logger, readonly sys: System, readonly net: Network = network, readonly productVersion = VERSION) { origin(endpoint); }
  compatibility(response: Response, route: string, data: ObjectValue = {}, updateCapable = false): void {
    const declared = response.headers.get('x-muse-service-version');
    const major = (value: string): string | undefined => /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-(dev|rc)\.(0|[1-9][0-9]*))?$/.exec(value)?.[1];
    if (declared !== null) requireValue(major(declared) !== undefined, 'invalid_service_version');
    const retryable = response.status === 429 || response.status >= 500 || (route.endsWith('/events') && response.status === 409) ||
      controlRouteUnavailable(response.status, route, data, this.credential);
    if (declared === null && retryable && data.error !== 'update_required') return;
    const checked = route.endsWith('/enroll') || (route.endsWith('/status') && !this.credential) || route.endsWith('/pull') || route.endsWith('/start') || route.endsWith('/events') || route.endsWith('/claim');
    const updateOnly = updateCapable && route === '/api/v1/worker/pull' && response.ok && data.job === null;
    if (data.error === 'update_required' || (checked && !updateOnly && major(this.productVersion) !== (declared === null ? '0' : major(declared)))) {
      const recommended = data.worker_package ?? (declared === null ? null : { version: declared, release_url: 'https://github.com/markhuangai/AaA-muse-ai/releases/tag/v' + declared });
      throw new Failure('update_required', { worker_version: this.productVersion, service_version: declared ?? 'legacy-major-zero', recommended_worker: recommended, automatic_update: false, corrective_action: 'Install the service-paired worker manually, or align the service major; preserve worker identity and journals.', http_status: response.status, request_id: response.headers.get('x-request-id') ?? '' });
    }
  }
  async enrollmentCompatibility(): Promise<void> {
    if (this.productVersion.startsWith('0.')) return;
    try { await this.request('/api/v1/worker/status'); }
    catch (error) { if (!(error instanceof Failure && error.code === 'worker_unauthorized')) throw error; }
  }
  // Final receipts duplicate answer text from the bounded canonical context and add broker metadata.
  async body(response: Response, limit = 3 * 1024 * 1024, { preserveBOM = false } = {}): Promise<string> {
    if (!response.body) return '';
    const reader = response.body.getReader();
    const buffers: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.length;
        requireValue(size <= limit, 'response_too_large', { max_bytes: limit, observed_bytes: size });
        buffers.push(item.value);
      }
      return decoded(new TextDecoder('utf8', { fatal: true, ignoreBOM: preserveBOM }), Buffer.concat(buffers));
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  async request(route: string, method = 'GET', input?: string, correlation: Record<string, Value> = {}, attempts = 3, timeoutMs = 10_000, metadata: Record<string, string> = {}): Promise<Reply> {
    requireValue(/^\/api\/v1\/worker\/[a-z0-9/_-]+$/.test(route), 'invalid_worker_route');
    validateBody(input);
    for (let attempt = 1; ; attempt++) {
      const started = this.sys.now();
      const controller = new AbortController();
      const timer = this.net.setTimer(() => controller.abort(), timeoutMs);
      let requestId = this.sys.uuid();
      try {
        const response = await this.net.fetch(this.endpoint + route, { method, body: input, redirect: 'manual', signal: controller.signal, headers: { ...(this.credential ? { Authorization: 'Bearer ' + this.credential } : {}), Accept: 'application/json', ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Request-Id': requestId, 'X-Muse-Worker-Version': this.productVersion, ...metadata } });
        requestId = response.headers.get('x-request-id') || requestId;
        requireValue(response.status < 300 || response.status >= 400, 'redirect_forbidden');
        const raw = await this.body(response);
        let data: ObjectValue = {};
        let responseValidation = '';
        try { data = object(parse(raw)); }
        catch (error) {
          if (response.ok || !(error instanceof Failure)) throw error;
          responseValidation = error.code;
        }
        const validation = responseValidation ? { response_validation_cause: responseValidation } : {};
        await this.logger.log('DEBUG', 'worker.http_exchange', { ...correlation, ...validation, request_id: requestId, endpoint: this.endpoint, route, method, attempt, duration_ms: this.sys.now() - started, http_status: response.status, input: input === undefined ? null : parse(input), output: responseValidation ? raw : data });
        this.compatibility(response, route, data, !!metadata['X-Muse-Worker-Updater']);
        if (!response.ok) throw new Failure(response.status === 401 ? 'worker_unauthorized' : 'broker_rejected', { ...correlation, ...validation, request_id: requestId, route, method, http_status: response.status, reason: typeof data.error === 'string' ? data.error : 'invalid_error_response' }, response.status === 429 || response.status >= 500 || controlRouteUnavailable(response.status, route, data, this.credential));
        return { data, requestId, status: response.status };
      } catch (error) {
        const failure = error instanceof Failure ? error : new Failure('broker_unreachable', { ...correlation, cause: cause(error), request_id: requestId, route, method, attempt, duration_ms: this.sys.now() - started }, !/CERT|TLS|SSL/.test(cause(error)));
        // An unstructured control-route 404 must return the subscriber to reconciliation.
        if (!failure.retryable || failure.fields.http_status === 404 || attempt >= attempts) throw failure;
        await this.logger.log('WARN', 'worker.http_retrying', { ...correlation, ...failure.fields, endpoint: this.endpoint, route, method, attempt, delay_ms: attempt * 1000, cause: failure.code, duration_ms: this.sys.now() - started });
        await this.sys.wait(attempt * 1000);
      } finally { this.net.clearTimer(timer); }
    }
  }
  async *events(signal: AbortSignal, modelReport?: Value): AsyncGenerator<Event> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    let timer = this.net.setTimer(abort, 10_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const requestedID = this.sys.uuid();
      const headers: Record<string, string> = { Authorization: 'Bearer ' + this.credential, Accept: 'text/event-stream', 'X-Request-Id': requestedID, 'X-Muse-Media-Jobs': '1', 'X-Muse-Prompt-Wav': '1', 'X-Muse-Worker-Version': this.productVersion };
      if (modelReport !== undefined) {
        const report = Buffer.from(encode(modelReport));
        if (report.length <= maxModelReportBytes) {
          headers['X-Muse-Worker-Model-Report'] = report.toString('base64url');
        } else {
          await this.logger.log('WARN', 'worker.model_report_rejected', { cause: 'model_report_too_large', outcome: 'unavailable' });
        }
      }
      const route = '/api/v1/worker/events';
      const response = await this.net.fetch(this.endpoint + route, { redirect: 'manual', signal: controller.signal, headers });
      this.net.clearTimer(timer);
      const requestId = response.headers.get('x-request-id') || requestedID;
      requireValue(response.status < 300 || response.status >= 400, 'redirect_forbidden');
      let rejection: ObjectValue = {};
      let validation: ObjectValue = {};
      if (response.status === 404 || response.status === 426) {
        timer = this.net.setTimer(abort, 10_000);
        const raw = await this.body(response);
        this.net.clearTimer(timer);
        try { rejection = object(parse(raw)); }
        catch (error) {
          if (response.status === 426 || !(error instanceof Failure)) throw error;
          validation = { response_validation_cause: error.code };
        }
        await this.logger.log('DEBUG', 'worker.http_exchange', { ...validation, route, method: 'GET', request_id: requestId, endpoint: this.endpoint,
          http_status: response.status, output: validation.response_validation_cause ? raw : rejection, input: null });
      }
      this.compatibility(response, route, rejection);
      if (response.status !== 200) throw new Failure(response.status === 401 ? 'worker_unauthorized' : 'stream_rejected', { ...validation, route, request_id: requestId, http_status: response.status, ...(typeof rejection.error === 'string' && { reason: rejection.error }) },
        response.status === 409 || response.status === 429 || response.status >= 500 || controlRouteUnavailable(response.status, route, rejection, this.credential));
      requireValue(response.headers.get('content-type')?.split(';')[0].trim() === 'text/event-stream' && response.body, 'invalid_stream_response');
      reader = response.body.getReader();
      const decoder = new TextDecoder('utf8', { fatal: true });
      let buffer = '', eventType = '', eventId = '', data: string[] = [], frameBytes = 0;
      while (!signal.aborted) {
        timer = this.net.setTimer(abort, 30_000);
        const item = await reader.read();
        this.net.clearTimer(timer);
        if (item.done) break;
        buffer += decoded(decoder, item.value, true);
        for (;;) {
          const index = buffer.search(/[\r\n]/);
          if (index < 0 || (buffer[index] === '\r' && index === buffer.length - 1)) break;
          const line = buffer.slice(0, index);
          buffer = buffer.slice(index + (buffer.slice(index, index + 2) === '\r\n' ? 2 : 1));
          frameBytes += Buffer.byteLength(line) + 1;
          requireValue(frameBytes <= 65_536, 'sse_frame_too_large');
          if (!line) {
            if (data.length) {
              requireValue(['connection.opened', 'health.challenge', 'job.available', 'job.cancelled'].includes(eventType) && !!eventId && !/[\u0000-\u001f]/.test(eventId), 'unsupported_stream_event');
              const event = { id: eventId, type: eventType, data: object(parse(data.join('\n'))) };
              await this.logger.log('DEBUG', 'worker.sse_event', { request_id: requestId, event_id: eventId, event_type: eventType, payload: event.data });
              yield event;
            }
            eventType = ''; eventId = ''; data = []; frameBytes = 0;
          } else if (!line.startsWith(':')) {
            const separator = line.indexOf(':');
            const key = separator < 0 ? line : line.slice(0, separator);
            const value = separator < 0 ? '' : line.slice(separator + 1).replace(/^ /, '');
            if (key === 'event') eventType = value;
            if (key === 'id') eventId = value;
            if (key === 'data') data.push(value);
          }
        }
        requireValue(Buffer.byteLength(buffer) + frameBytes <= 65_536, 'sse_frame_too_large');
      }
      if (!signal.aborted) { decoded(decoder); throw new Failure('stream_interrupted', { incomplete_frame: !!buffer || data.length > 0 }, true); }
    } catch (error) {
      if (!signal.aborted) throw error instanceof Failure ? error : new Failure('stream_interrupted', { cause: cause(error) }, !/CERT|TLS|SSL/.test(cause(error)));
    } finally {
      this.net.clearTimer(timer);
      signal.removeEventListener('abort', abort);
      controller.abort();
      if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
    }
  }
}
