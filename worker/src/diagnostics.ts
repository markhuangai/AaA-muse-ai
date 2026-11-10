import { createHash } from 'node:crypto';
import { State } from './state.js';
import { cause, Failure, requireValue } from './errors.js';
import { encode, parse, object, text, JsonNumber, type Value } from './json.js';

export class Redactor {
  readonly secrets: string[] = [];
  add(value: string): void { if (value && !this.secrets.includes(value)) this.secrets.push(value); }
  text(value: string): string {
    const spans: [number, number][] = [];
    for (const match of value.matchAll(/(?=(muse_(?:enroll|worker)_[A-Za-z0-9_-]{43}))/g)) spans.push([match.index!, match.index! + match[1].length]);
    for (const secret of this.secrets) {
      for (let offset = 0; offset < value.length;) {
        const index = value.indexOf(secret, offset);
        if (index < 0) break;
        spans.push([index, index + secret.length]);
        offset = index + 1;
      }
    }
    spans.sort((a, b) => a[0] - b[0]);
    let result = '', offset = 0;
    for (let i = 0; i < spans.length;) {
      const start = spans[i][0];
      let end = spans[i++][1];
      while (i < spans.length && spans[i][0] <= end) end = Math.max(end, spans[i++][1]);
      result += value.slice(offset, start) + '[REDACTED]';
      offset = end;
    }
    return result + value.slice(offset);
  }
  value(value: Value, key = '', maskFields = true): Value {
    if (maskFields && (/password|authorization|cookie|secret|token|credential|enrollment_code/i.test(key) || /^(key|api_key|client_keys)$/i.test(key))) return '[REDACTED]';
    if (typeof value === 'string') return this.text(value);
    if (value === null || value instanceof JsonNumber || typeof value !== 'object') return value;
    if (Array.isArray(value)) return value.map(v => this.value(v, '', maskFields));
    const output: Record<string, Value> = Object.create(null);
    const entries = Object.entries(value).sort(([a], [b]) => Number(this.text(a) !== a) - Number(this.text(b) !== b));
    for (const [name, item] of entries) {
      const base = this.text(name);
      let safe = base, suffix = 2;
      while (Object.hasOwn(output, safe)) safe = base + '#' + suffix++;
      output[safe] = this.value(item, name, maskFields);
    }
    return output;
  }
}

export interface Filter { operation_id?: string; request_id?: string; since?: string; until?: string }
export const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');

export class Capture {
  constructor(readonly state: State, readonly maxBytes = 128 * 1024 * 1024, readonly retentionMs = 7 * 86400_000) {}
  async metadata(): Promise<Record<string, Value>> {
    const saved = await this.state.read('retention.json');
    return saved ? object(parse(saved)) : { created_at: new Date(this.state.sys.now()).toISOString(), pruned_through: '' };
  }
  async prune(): Promise<Record<string, Value>> {
    const metadata = await this.metadata();
    const files = (await this.state.list()).filter(n => /^capture-\d+-[a-f0-9-]+\.ndjson$/.test(n)).sort((a, b) => Number(a.split('-')[1]) - Number(b.split('-')[1]));
    const sizes = await Promise.all(files.map(async name => (await this.state.io.lstat(this.state.path(name))).size));
    let total = sizes.reduce((a, b) => a + b, 0);
    for (let i = 0; i < files.length; i++) {
      const time = Number(files[i].split('-')[1]);
      if (total <= this.maxBytes && time >= this.state.sys.now() - this.retentionMs) break;
      metadata.pruned_through = new Date(Math.max(time, Date.parse(text(metadata.pruned_through)) || 0)).toISOString();
      await this.state.write('retention.json', encode(metadata));
      await this.state.remove(files[i]);
      total -= sizes[i];
    }
    await this.state.write('retention.json', encode(metadata));
    return metadata;
  }
  async write(event: Record<string, Value>): Promise<void> {
    await this.state.withLock('capture', async () => {
      const payload = Buffer.from(encode(event));
      const payloadHash = digest(payload);
      const id = this.state.sys.uuid();
      const records: string[] = [];
      const chunks = Math.ceil(payload.length / 2048);
      for (let i = 0; i < chunks; i++) {
        const record = encode({ type: 'event', time: event.time, event: event.msg, level: event.level, instance_id: event.instance_id, operation_id: event.operation_id, request_id: event.request_id, capture_id: id, chunk: i, chunks, payload_sha256: payloadHash, data_base64: payload.subarray(i * 2048, (i + 1) * 2048).toString('base64') });
        requireValue(Buffer.byteLength(record) + 1 <= 6144, 'capture_record_too_large');
        records.push(record);
      }
      await this.state.write(`capture-${this.state.sys.now()}-${id}.ndjson`, records.join('\n') + '\n');
      await this.prune();
    });
  }
  async export(filter: Filter, decode: boolean): Promise<string> {
    return await this.state.withLock('capture', async () => {
      const now = this.state.sys.now();
      for (const time of [filter.since, filter.until]) if (time !== undefined) requireValue(/^\d{4}-\d\d-\d\dT/.test(time) && Number.isFinite(Date.parse(time)), 'invalid_time_filter');
      requireValue(!filter.since || !filter.until || Date.parse(filter.since) <= Date.parse(filter.until), 'invalid_time_interval');
      const retained = await this.prune();
      const omissions: string[] = [];
      const created = Date.parse(text(retained.created_at));
      const pruned = Date.parse(text(retained.pruned_through));
      if (Number.isFinite(pruned) && (!filter.since || Date.parse(filter.since) <= pruned)) omissions.push('expired_or_capacity_pruned_evidence');
      if ([filter.since, filter.until].some(t => t && Date.parse(t) < created)) omissions.push('requested_interval_precedes_capture');
      if ([filter.since, filter.until].some(t => t && Date.parse(t) > now)) omissions.push('requested_interval_extends_after_snapshot');
      const captures: string[] = [];
      for (const name of (await this.state.list()).filter(n => /^capture-.*\.ndjson$/.test(n)).sort()) {
        const raw = (await this.state.read(name))!;
        try {
          const rows = raw.trimEnd().split('\n').map(line => { requireValue(Buffer.byteLength(line) + 1 <= 6144, 'invalid_capture'); return object(parse(line)); });
          const first = rows[0];
          requireValue(first && Number(textNumber(first.chunks)) === rows.length, 'invalid_capture');
          const buffers = rows.map((r, i) => {
            requireValue(r.type === 'event' && Number(textNumber(r.chunk)) === i && r.capture_id === first.capture_id && textNumber(r.chunks) === textNumber(first.chunks) && r.payload_sha256 === first.payload_sha256 && /^[A-Za-z0-9+/]*={0,2}$/.test(text(r.data_base64)), 'invalid_capture');
            const bytes = Buffer.from(text(r.data_base64), 'base64');
            requireValue(bytes.toString('base64') === r.data_base64, 'invalid_capture');
            return bytes;
          });
          const payload = Buffer.concat(buffers);
          requireValue(digest(payload) === first.payload_sha256, 'invalid_capture');
          const event = object(parse(new TextDecoder('utf8', { fatal: true }).decode(payload)));
          const time = Date.parse(text(event.time));
          if ((filter.operation_id && event.operation_id !== filter.operation_id) || (filter.request_id && event.request_id !== filter.request_id) || (filter.since && time < Date.parse(filter.since)) || (filter.until && time > Date.parse(filter.until))) continue;
          captures.push(decode ? encode(event) + '\n' : raw);
        } catch { omissions.push('incomplete_capture:' + name); }
      }
      if (!captures.length && (filter.operation_id || filter.request_id)) omissions.push('requested_identity_not_captured_in_interval');
      return encode({ type: 'export', complete: omissions.length === 0, created_at: retained.created_at, snapshot_at: new Date(now).toISOString(), pruned_through: retained.pruned_through, captures: captures.length, omissions }) + '\n' + captures.join('');
    });
  }
}

function textNumber(value: Value | undefined): string {
  requireValue(value instanceof JsonNumber, 'invalid_capture');
  return value.raw;
}

export class Logger {
  readonly redactor = new Redactor();
  readonly instance: string;
  constructor(readonly state: State, readonly capture: Capture, readonly stderr: (line: string) => void, readonly base: Record<string, Value> = {}) { this.instance = state.sys.uuid(); }
  async log(level: 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', msg: string, fields: Record<string, unknown> = {}): Promise<void> {
    const event = object(this.redactor.value(parse(encode({ time: new Date(this.state.sys.now()).toISOString(), level, msg, instance_id: this.instance, ...this.base, ...fields }))));
    try { await this.capture.write(event); }
    catch (error) {
      this.stderr(encode({ time: event.time, level: 'ERROR', msg: 'worker.capture_failed', cause: cause(error), stopped_operation: msg }) + '\n');
      throw new Failure('diagnostics_unavailable', {}, false);
    }
    if (level !== 'DEBUG') this.stderr(encode(event) + '\n');
  }
}
