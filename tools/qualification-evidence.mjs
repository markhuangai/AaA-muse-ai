import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import * as fs from 'node:fs/promises';
import { dirname, isAbsolute, resolve, sep } from 'node:path';
import { Capture, Logger, Redactor } from '../worker/dist/diagnostics.js';
import { State, system } from '../worker/dist/state.js';

export const hash = value => createHash('sha256').update(value).digest('hex');
export const same = (a, b) => JSON.stringify(sort(a)) === JSON.stringify(sort(b));
function sort(value) {
  if (Array.isArray(value)) return value.map(sort);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, sort(value[key])]));
  return value;
}
export function need(condition, reason) {
  if (!condition) throw new Error(reason);
}
export const instant = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value));
export const identifier = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);

export async function privateRead(path) {
  need(isAbsolute(path), 'absolute_private_path_required');
  const state = new State(dirname(path));
  await state.check(state.root, true);
  const info = await fs.lstat(path);
  need(info.isFile() && !info.isSymbolicLink() && info.uid === system.uid && (info.mode & 0o7777) === 0o600 && info.nlink === 1, 'private_file_unsafe');
  const file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await file.stat();
    need(opened.ino === info.ino && opened.dev === info.dev && opened.size <= 16 * 1024 * 1024, 'private_file_changed_or_too_large');
    return await file.readFile('utf8');
  } finally { await file.close(); }
}

export function publicOrigin(value) {
  const url = new URL(value);
  need(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 'https_origin_required');
  return url.origin;
}

export async function openEvidence(directory, { now = Date.now, uuid = system.uuid, stderr = line => process.stderr.write(line) } = {}) {
  need(isAbsolute(directory), 'absolute_evidence_directory_required');
  const checkout = resolve(new URL('..', import.meta.url).pathname);
  need(resolve(directory) !== checkout && !resolve(directory).startsWith(checkout + sep), 'private_evidence_must_be_outside_checkout');
  const state = new State(directory, fs, { ...system, now, uuid });
  await state.ensure();
  const capture = new Capture(await state.child('diagnostics'));
  const logger = new Logger(state, capture, stderr, { component: 'qualification', runtime_level: 'INFO', capture_level: 'DEBUG' });
  return { state, capture, logger };
}

export function decodeExport(raw) {
  const lines = raw.trimEnd().split('\n');
  const metadata = JSON.parse(lines.shift());
  need(metadata.type === 'export' && metadata.complete === true && Array.isArray(metadata.omissions) && !metadata.omissions.length, 'capture_incomplete');
  const groups = new Map();
  for (const line of lines) {
    need(Buffer.byteLength(line) + 1 <= 6144, 'capture_chunk_too_large');
    const row = JSON.parse(line);
    need(row.type === 'event' && typeof row.capture_id === 'string' && Number.isInteger(row.chunks) && row.chunks > 0 && Number.isInteger(row.chunk) && row.chunk >= 0 && row.chunk < row.chunks, 'invalid_capture_chunk');
    const rows = groups.get(row.capture_id) ?? [];
    need(!rows.some(item => item.chunk === row.chunk), 'duplicate_capture_chunk');
    rows.push(row);
    groups.set(row.capture_id, rows);
  }
  need(groups.size === metadata.captures, 'capture_count_mismatch');
  const events = [];
  for (const rows of groups.values()) {
    const first = rows[0];
    need(rows.length === first.chunks && rows.every(row => row.chunks === first.chunks && row.payload_sha256 === first.payload_sha256), 'capture_chunks_missing');
    const payload = Buffer.concat(rows.sort((a, b) => a.chunk - b.chunk).map(row => {
      need(typeof row.data_base64 === 'string' && Buffer.from(row.data_base64, 'base64').toString('base64') === row.data_base64, 'invalid_capture_encoding');
      return Buffer.from(row.data_base64, 'base64');
    }));
    need(hash(payload) === first.payload_sha256, 'capture_digest_mismatch');
    const event = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(payload));
    need(event.time === first.time && event.msg === first.event && event.level === first.level && event.operation_id === first.operation_id && event.request_id === first.request_id, 'capture_envelope_mismatch');
    events.push(event);
  }
  return { metadata, events };
}

export async function attachExport(state, source, caseID, raw, redactor = new Redactor()) {
  need(['broker', 'worker'].includes(source) && identifier(caseID), 'invalid_export_identity');
  const safe = redactor.text(raw);
  need(safe === raw, 'unredacted_export');
  decodeExport(raw);
  const name = `${source}-${caseID}-${hash(raw).slice(0,16)}.ndjson`;
  await state.write(name, raw);
  return { source, case_id: caseID, file: name, sha256: hash(raw) };
}

export async function readExports(report, read) {
  const evidence = [];
  for (const ref of report.exports ?? []) {
    try {
      need(['broker', 'worker'].includes(ref.source) && /^[A-Za-z0-9_.-]+\.ndjson$/.test(ref.file), 'invalid_export_reference');
      const raw = await read(ref.file);
      need(typeof raw === 'string' && hash(raw) === ref.sha256, 'export_digest_mismatch');
      evidence.push({ ...ref, ...decodeExport(raw) });
    } catch (error) { evidence.push({ ...ref, error: error.message }); }
  }
  return evidence;
}
