import { Failure, cause, requireValue } from './errors.js';
import { encode, parse, object, text, type ObjectValue, type Value } from './json.js';
import { Logger } from './diagnostics.js';
import type { System } from './state.js';

export interface Network {
  fetch: typeof fetch;
  setTimer(fn: () => void, ms: number): ReturnType<typeof setTimeout>;
  clearTimer(timer: ReturnType<typeof setTimeout>): void;
}
export const network: Network = { fetch, setTimer: setTimeout, clearTimer: clearTimeout };
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

export class Transport {
  constructor(readonly endpoint: string, readonly credential: string, readonly logger: Logger, readonly sys: System, readonly net: Network = network) { origin(endpoint); }
  async body(response: Response, limit = 2 * 1024 * 1024): Promise<string> {
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
      return decoded(new TextDecoder('utf8', { fatal: true }), Buffer.concat(buffers));
    } finally { await reader.cancel(); reader.releaseLock(); }
  }
  async request(route: string, method = 'GET', input?: string, correlation: Record<string, Value> = {}, attempts = 3): Promise<Reply> {
    requireValue(/^\/api\/v1\/worker\/[a-z0-9/_-]+$/.test(route), 'invalid_worker_route');
    validateBody(input);
    for (let attempt = 1; ; attempt++) {
      const started = this.sys.now();
      const controller = new AbortController();
      const timer = this.net.setTimer(() => controller.abort(), 10_000);
      let requestId = '';
      try {
        const response = await this.net.fetch(this.endpoint + route, { method, body: input, redirect: 'manual', signal: controller.signal, headers: { ...(this.credential ? { Authorization: 'Bearer ' + this.credential } : {}), Accept: 'application/json', ...(input === undefined ? {} : { 'Content-Type': 'application/json' }), 'X-Request-Id': this.sys.uuid() } });
        requestId = response.headers.get('x-request-id') ?? '';
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
        if (!response.ok) throw new Failure(response.status === 401 ? 'worker_unauthorized' : 'broker_rejected', { ...correlation, ...validation, request_id: requestId, http_status: response.status, reason: typeof data.error === 'string' ? data.error : 'invalid_error_response' }, response.status === 429 || response.status >= 500);
        return { data, requestId, status: response.status };
      } catch (error) {
        const failure = error instanceof Failure ? error : new Failure('broker_unreachable', { cause: cause(error), request_id: requestId }, !/CERT|TLS|SSL/.test(cause(error)));
        if (!failure.retryable || attempt >= attempts) throw failure;
        await this.logger.log('WARN', 'worker.http_retrying', { ...correlation, ...failure.fields, endpoint: this.endpoint, route, method, attempt, delay_ms: attempt * 1000, cause: failure.code, duration_ms: this.sys.now() - started });
        await this.sys.wait(attempt * 1000);
      } finally { this.net.clearTimer(timer); }
    }
  }
  async *events(signal: AbortSignal): AsyncGenerator<Event> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) controller.abort();
    let timer = this.net.setTimer(abort, 10_000);
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.net.fetch(this.endpoint + '/api/v1/worker/events', { redirect: 'manual', signal: controller.signal, headers: { Authorization: 'Bearer ' + this.credential, Accept: 'text/event-stream' } });
      this.net.clearTimer(timer);
      const requestId = response.headers.get('x-request-id') ?? '';
      requireValue(response.status < 300 || response.status >= 400, 'redirect_forbidden');
      if (response.status !== 200) throw new Failure(response.status === 401 ? 'worker_unauthorized' : 'stream_rejected', { request_id: requestId, http_status: response.status }, response.status === 409 || response.status === 429 || response.status >= 500);
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
