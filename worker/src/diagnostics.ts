import { createHash } from 'node:crypto';
import { State } from './state.js';
import { cause, Failure, requireValue } from './errors.js';
import { encode, parse, object, text, integer, JsonNumber, type ObjectValue, type Value } from './json.js';

export class Redactor {
  readonly secrets: string[] = [];
  add(value: string): void { if (value && !this.secrets.includes(value)) this.secrets.push(value); }
  text(value: string): string {
    const spans: [number, number][] = [];
    for (const match of value.matchAll(/(?=(muse_(?:enroll|worker|portal|download)_[A-Za-z0-9_-]{43}|aaa_muse_ai_[a-f0-9]{64}|\bBearer\s+[A-Za-z0-9._~+/=-]{16,}))/gi)) spans.push([match.index!, match.index! + match[1].length]);
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
    const removals: string[] = [];
    for (let i = 0; i < files.length; i++) {
      const time = Number(files[i].split('-')[1]);
      if (total <= this.maxBytes && time >= this.state.sys.now() - this.retentionMs) break;
      metadata.pruned_through = new Date(Math.max(time, Date.parse(text(metadata.pruned_through)) || 0)).toISOString();
      removals.push(files[i]);
      total -= sizes[i];
    }
    // Persist the whole batch watermark before deletion so interruption cannot hide lost evidence.
    await this.state.write('retention.json', encode(metadata));
    for (const name of removals) await this.state.remove(name);
    return metadata;
  }
  async write(event: Record<string, Value>): Promise<void> {
    await this.state.withLock('capture', async () => {
      const id = this.state.sys.uuid();
      await this.state.write(`capture-${this.state.sys.now()}-${id}.ndjson`, captureChunks(event, id));
      await this.prune();
    });
  }
  async exportBounded(filter: Filter, decode: boolean, maxBytes: number, cursor: string, redactor: Redactor): Promise<ObjectValue> {
    validateFilter(filter);
    requireValue(Number.isInteger(maxBytes) && maxBytes >= 1 && maxBytes <= 512 * 1024, 'invalid_diagnostics_limit');
    const stop = this.state.sys.now() + 10_000;
    const fingerprint = digest(encode({ filter, decode }));
    const snapshot = await this.state.withLock('capture', async () => ({
      retained: await this.metadata(),
      names: (await this.state.list()).filter(isCaptureName).sort(),
    }));
    const boundary = cursor ? readExportCursor(cursor, fingerprint) : {
      fingerprint, after: '', end: snapshot.names.at(-1) ?? '', now: this.state.sys.now(),
    };
    const names = snapshot.names.filter(name => name > boundary.after && name <= boundary.end);
    const omissions = captureOmissions(filter, snapshot.retained, boundary.now);
    if (cursor && !snapshot.names.includes(boundary.after)) omissions.push('cursor_capture_no_longer_retained');
    const output: string[] = [];
    const page = (truncated: boolean, after: string) => ({
      decoded: decode, complete: !truncated && !omissions.length, truncated,
      omissions: truncated ? [...omissions, 'bounded_results_remaining'] : omissions,
      captures: output.length, output, ...(truncated ? { next_cursor: encodeExportCursor({ ...boundary, after }) } : {}),
    });
    let after = boundary.after;
    let truncated = false;
    for (const name of names) {
      if (output.length === 500 || this.state.sys.now() >= stop) {
        truncated = true;
        break;
      }
      const raw = await this.state.read(name);
      if (raw === undefined) {
        if (!omissions.includes('capture_removed_during_export')) omissions.push('capture_removed_during_export');
        after = name;
        continue;
      }
      let chunk: string | undefined;
      try {
        const { event, first } = decodeCapture(raw);
        if (matchesCapture(filter, event)) {
          const safe = object(redactor.value(event));
          chunk = decode ? encode(safe) + '\n' : captureChunks(safe, redactor.text(text(first.capture_id)));
        }
      } catch {
        if (!omissions.includes('incomplete_capture')) omissions.push('incomplete_capture');
      }
      if (chunk !== undefined) {
        output.push(chunk);
        if (Buffer.byteLength(encode(page(name !== names.at(-1), name))) > maxBytes) {
          output.pop();
          if (output.length !== 0) {
            truncated = true;
            break;
          }
          if (!omissions.includes('capture_exceeds_page_limit')) omissions.push('capture_exceeds_page_limit');
        }
      }
      after = name;
    }
    if (!output.length && !cursor && !truncated && (filter.operation_id || filter.request_id) && !omissions.length) {
      omissions.push('requested_identity_not_captured_in_interval');
    }
    const result = page(truncated, after);
    requireValue(Buffer.byteLength(encode(result)) <= maxBytes, 'diagnostics_limit_too_small');
    return result;
  }
  async export(filter: Filter, decode: boolean): Promise<string> {
    validateFilter(filter);
    const { now, retained, names } = await this.state.withLock('capture', async () => {
      const now = this.state.sys.now();
      const retained = await this.prune();
      const names = (await this.state.list()).filter(n => /^capture-.*\.ndjson$/.test(n)).sort();
      return { now, retained, names };
    });
    const omissions = captureOmissions(filter, retained, now);
    const captures: string[] = [];
    for (const name of names) {
      const raw = await this.state.read(name);
      if (raw === undefined) { omissions.push('capture_removed_during_export:' + name); continue; }
      try {
        const { event } = decodeCapture(raw);
        if (!matchesCapture(filter, event)) continue;
        captures.push(decode ? encode(event) + '\n' : raw);
      } catch { omissions.push('incomplete_capture:' + name); }
    }
    if (!captures.length && (filter.operation_id || filter.request_id)) omissions.push('requested_identity_not_captured_in_interval');
    return encode({ type: 'export', complete: omissions.length === 0, created_at: retained.created_at, snapshot_at: new Date(now).toISOString(), pruned_through: retained.pruned_through, captures: captures.length, omissions }) + '\n' + captures.join('');
  }
}

function captureChunks(event: ObjectValue, id: string): string {
  const payload = Buffer.from(encode(event));
  const payloadHash = digest(payload);
  const records: string[] = [];
  const chunks = Math.ceil(payload.length / 2048);
  for (let i = 0; i < chunks; i++) {
    const record = encode({ type: 'event', time: event.time, event: event.msg, level: event.level, instance_id: event.instance_id,
      operation_id: event.operation_id, request_id: event.request_id, capture_id: id, chunk: i, chunks,
      payload_sha256: payloadHash, data_base64: payload.subarray(i * 2048, (i + 1) * 2048).toString('base64') });
    requireValue(Buffer.byteLength(record) + 1 <= 6144, 'capture_record_too_large');
    records.push(record);
  }
  return records.join('\n') + '\n';
}

function isCaptureName(value: string): boolean {
  return /^capture-\d+-[a-f0-9-]+\.ndjson$/.test(value);
}

function validateFilter(filter: Filter) {
  for (const time of [filter.since, filter.until]) if (time !== undefined) requireValue(/^\d{4}-\d\d-\d\dT/.test(time) &&
    Number.isFinite(Date.parse(time)), 'invalid_time_filter');
  requireValue(!filter.since || !filter.until || Date.parse(filter.since) <= Date.parse(filter.until), 'invalid_time_interval');
}

function captureOmissions(filter: Filter, retained: ObjectValue, now: number) {
  const omissions: string[] = [];
  const created = Date.parse(text(retained.created_at));
  const pruned = Date.parse(text(retained.pruned_through));
  if (Number.isFinite(pruned) && (!filter.since || Date.parse(filter.since) <= pruned)) omissions.push('expired_or_capacity_pruned_evidence');
  if ([filter.since, filter.until].some(t => t && Date.parse(t) < created)) omissions.push('requested_interval_precedes_capture');
  if ([filter.since, filter.until].some(t => t && Date.parse(t) > now)) omissions.push('requested_interval_extends_after_snapshot');
  return omissions;
}

function matchesCapture(filter: Filter, event: ObjectValue) {
  const time = Date.parse(text(event.time));
  return (!filter.operation_id || event.operation_id === filter.operation_id) &&
    (!filter.request_id || event.request_id === filter.request_id) && (!filter.since || time >= Date.parse(filter.since)) &&
    (!filter.until || time <= Date.parse(filter.until));
}

interface ExportCursor { fingerprint: string; after: string; end: string; now: number }

function encodeExportCursor(cursor: ExportCursor): string {
  return Buffer.from(encode(cursor)).toString('base64url');
}

function readExportCursor(cursor: string, fingerprint: string): ExportCursor {
  requireValue(/^[a-zA-Z0-9_-]{1,1024}$/.test(cursor), 'invalid_diagnostics_cursor');
  const raw = Buffer.from(cursor, 'base64url');
  requireValue(raw.toString('base64url') === cursor, 'invalid_diagnostics_cursor');
  const value = object(parse(raw.toString('utf8')));
  const after = text(value.after), end = text(value.end), now = integer(value.now);
  requireValue(value.fingerprint === fingerprint && (after === '' || isCaptureName(after)) && isCaptureName(end) &&
    after <= end && now > 0, 'invalid_diagnostics_cursor');
  return { fingerprint, after, end, now };
}

function decodeCapture(raw: string) {
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
  return { event, first };
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
