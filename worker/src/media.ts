import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { FileHandle } from 'node:fs/promises';
import { State } from './state.js';
import { Failure, cause, requireValue } from './errors.js';
import { object, text, integer, encode, parse, identifier, type ObjectValue } from './json.js';
import { correlation } from './protocol.js';
import { digest } from './diagnostics.js';
import type { Transport } from './transport.js';
import type { Worker } from './worker.js';

const images: Record<string, string> = { 'image/png': 'reference.png', 'image/webp': 'reference.webp', 'image/jpeg': 'reference.jpg' };
const outputs: Record<string, [string, string]> = {
  image_video: ['result.mp4', 'video/mp4'], prompt_video: ['result.mp4', 'video/mp4'],
  native_mp3: ['result.mp3', 'audio/mpeg'], offline_wav: ['result.wav', 'audio/wav'],
};
const imageLimit = 8 * 1024 * 1024;
const artifactLimit = 32 * 1024 * 1024;
const timeout = 120_000;

function assignmentHeaders(t: Transport, j: ObjectValue): Record<string, string> {
  return { Authorization: 'Bearer ' + t.credential, 'X-Muse-Worker-Version': t.productVersion,
    'X-Muse-Connection-Id': identifier(j.connection_id), 'X-Muse-Connection-Generation': String(integer(j.connection_generation)),
    'X-Muse-Generation': String(integer(j.generation)), 'X-Muse-Lease-Id': identifier(j.lease_id) };
}

async function transfer<T>(t: Transport, job: ObjectValue, path: string, options: RequestInit, consume: (response: Response) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const timer = t.net.setTimer(() => controller.abort(), timeout);
  try {
    const response = await t.net.fetch(t.endpoint + '/api/v1/worker/jobs/' + identifier(job.id) + '/' + path, {
      ...options, redirect: 'manual', signal: controller.signal, headers: { ...assignmentHeaders(t, job), ...options.headers },
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Failure('media_transfer_rejected', { http_status: response.status, request_id: response.headers.get('x-request-id') ?? '', stage: path }, response.status === 429 || response.status >= 500);
    }
    return await consume(response);
  } finally { t.net.clearTimer(timer); }
}

function fileType(job: ObjectValue): [string, string] {
  const profile = text(object(job.media).profile);
  requireValue(Object.hasOwn(outputs, profile), 'unsupported_media_profile');
  return outputs[profile];
}

async function writeReference(spool: State, t: Transport, j: ObjectValue): Promise<string> {
  const m = object(j.media);
  const kind = text(m.input_type);
  requireValue(Object.hasOwn(images, kind) && integer(m.input_size) > 0 && integer(m.input_size) <= imageLimit, 'invalid_media_reference');
  const name = images[kind];
  const temp = spool.path('.input-' + spool.sys.uuid());
  const f = await spool.io.open(temp, 'wx', 0o600);
  try {
    await transfer(t, j, 'media/image', {}, async res => {
      requireValue(res.body && res.headers.get('content-type') === kind, 'media_reference_type_mismatch');
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of Readable.fromWeb(res.body as Parameters<typeof Readable.fromWeb>[0])) {
        size += chunk.length;
        requireValue(size <= integer(m.input_size), 'media_reference_size_mismatch');
        hash.update(chunk); await f.writeFile(chunk);
      }
      requireValue(size === integer(m.input_size) && hash.digest('hex') === m.input_sha256, 'media_reference_digest_mismatch');
      await f.sync();
    });
    await spool.io.rename(temp, spool.path(name));
    return spool.path(name);
  } finally {
    await f.close();
    try { await spool.io.unlink(temp); } catch (error) { if (cause(error) !== 'ENOENT') throw error; }
  }
}

function boundTo(j: ObjectValue, saved: ObjectValue, t: Transport): boolean {
  return saved.origin === t.endpoint && saved.worker_id === j.worker_id && saved.job_id === j.id &&
    saved.lease_id === j.lease_id && integer(saved.generation) === integer(j.generation) &&
    saved.connection_id === j.connection_id && integer(saved.connection_generation) === integer(j.connection_generation);
}

async function journal(spool: State): Promise<ObjectValue | undefined> {
  const value = await spool.read('progress.json');
  return value === undefined ? undefined : object(parse(value));
}

export async function prepareMedia(worker: Worker, t: Transport, j: ObjectValue): Promise<ObjectValue> {
  requireValue(j.state === 'claimed' && j.held === true, 'assignment_not_active');
  const m = object(j.media);
  const [file] = fileType(j);
  const spool = await (await worker.state.child('media')).child(identifier(j.id));
  return spool.withLock('prepare', async () => {
    const previous = await journal(spool);
    if (previous) {
      requireValue(boundTo(j, previous, t), 'media_assignment_changed');
      if (previous.state !== 'preparing') return { job_id: j.id, state: previous.state, action: 'preserve_existing_generation' };
      await clearInputs(spool);
    }
    const saved = { ...correlation(j), origin: t.endpoint, lease_id: j.lease_id, profile: m.profile, state: 'preparing' };
    if (!previous) await spool.write('progress.json', encode(saved));
    const result: ObjectValue = { job_id: j.id, profile: m.profile, output_path: spool.path(file), output_dir: spool.root, output_name: 'result' };
    if (m.profile === 'native_mp3' || m.profile === 'offline_wav') {
      result.action = 'stage_verified_audio_fixture';
      result.fixture_sha256 = m.input_sha256; result.fixture_bytes = m.input_size;
    } else {
      const prompt = await transfer(t, j, 'media/prompt', {}, res => t.body(res, 4096, { preserveBOM: true }));
      requireValue(digest(prompt) === m.prompt_sha256, 'media_prompt_digest_mismatch');
      result.prompt = prompt;
      if (m.profile === 'image_video') result.reference_path = await writeReference(spool, t, j);
      else result.generated_still_path = spool.path('generated.webp');
      result.action = m.profile === 'image_video' ? 'animate_reference' : 'generate_still_then_animate';
    }
    saved.state = 'generating';
    await spool.write('progress.json', encode(saved));
    await worker.logger.log('INFO', 'worker.media_prepared', { ...correlation(j), profile: m.profile, input_sha256: m.input_sha256 ?? null, prompt_sha256: m.prompt_sha256 ?? null });
    return result;
  });
}

async function openOutput(spool: State, name: string): Promise<FileHandle> {
  const file = await spool.io.open(spool.path(name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const st = await file.stat();
    requireValue(st.isFile() && st.uid === spool.sys.uid && st.nlink === 1 && st.size > 0 && st.size <= artifactLimit, 'invalid_media_output');
    await file.chmod(0o600);
    return file;
  } catch (error) { await file.close(); throw error; }
}

async function* fileChunks(file: FileHandle): AsyncGenerator<Buffer> {
  let position = 0;
  for (;;) {
    const buffer = Buffer.allocUnsafe(64 * 1024);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, position);
    if (bytesRead === 0) return;
    position += bytesRead;
    requireValue(position <= artifactLimit, 'invalid_media_output');
    yield buffer.subarray(0, bytesRead);
  }
}

async function hashFile(file: FileHandle): Promise<{ sha256: string; size: number }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of fileChunks(file)) {
    size += chunk.length;
    requireValue(size <= artifactLimit, 'invalid_media_output');
    hash.update(chunk);
  }
  return { sha256: hash.digest('hex'), size };
}

export async function finishMedia(worker: Worker, id: string): Promise<ObjectValue> {
  const t = await worker.load();
  const j = await worker.getJob(t, id);
  const [name] = fileType(j);
  if (j.state === 'accepted') return { job_id: id, state: 'accepted' };
  requireValue(j.state === 'claimed' && j.held === true, 'assignment_not_active');
  const spool = await (await worker.state.child('media')).child(id);
  return spool.withLock('prepare', async () => {
    const saved = await journal(spool);
    requireValue(saved && boundTo(j, saved, t), 'media_assignment_changed');
    requireValue(saved.state === 'generating' || saved.state === 'ready', 'media_generation_not_started');
    if (saved.state === 'generating') {
      const file = await openOutput(spool, name);
      let receipt;
      try { receipt = await hashFile(file); } finally { await file.close(); }
      Object.assign(saved, receipt, { state: 'ready' });
      await spool.write('progress.json', encode(saved));
      await worker.logger.log('INFO', 'worker.media_upload_queued', { ...correlation(j), ...receipt });
    }
    return { job_id: id, state: saved.state };
  });
}

async function clearInputs(spool: State): Promise<void> {
  const partials = (await spool.list()).filter(name => name.startsWith('.input-'));
  for (const name of [...Object.values(images), 'generated.webp', ...partials]) {
    try { await spool.io.unlink(spool.path(name)); } catch (error) { if (cause(error) !== 'ENOENT') throw error; }
  }
}

async function reconcileJob(worker: Worker, t: Transport, spool: State, id: string): Promise<boolean> {
  const saved = await journal(spool);
  if (!saved) return false;
  const j = await worker.getJob(t, id);
  requireValue(boundTo(j, saved, t), 'media_assignment_changed');
  const [name, kind] = fileType(j);
  if (j.state === 'cancelled' || j.state === 'interrupted') {
    await spool.withLock('prepare', () => clearInputs(spool));
    return false;
  }
  if (saved.state !== 'ready') return false;
  const size = integer(saved.size), hash = text(saved.sha256);
  if (j.state === 'claimed') {
    const f = await openOutput(spool, name);
    try {
      const body = Readable.toWeb(Readable.from(fileChunks(f)));
      const options = {method: 'PUT', duplex: 'half', body: body as BodyInit, headers: { 'Content-Type': kind, 'Content-Length': String(size), 'X-Muse-Artifact-Sha256': hash }};
      await transfer(t, j, 'artifact', options, async res => {
        const ack = object(parse(await t.body(res, 4096)));
        requireValue(ack.accepted === true && ack.job_id === id && ack.sha256 === hash && integer(ack.size) === size && Number.isFinite(Date.parse(text(ack.expires_at))), 'invalid_media_receipt');
      });
    } finally { await f.close(); }
  } else {
    const artifact = object(object(j.media).artifact);
    requireValue(j.state === 'accepted' && artifact.sha256 === hash && integer(artifact.size) === size, 'invalid_media_receipt');
  }
  await clearInputs(spool);
  try { await spool.io.unlink(spool.path(name)); } catch (error) { if (cause(error) !== 'ENOENT') throw error; }
  await worker.publish(j, 'completed', 'media_upload_confirmed');
  await worker.logger.log('INFO', 'worker.media_upload_confirmed', { ...correlation(j), sha256: hash, bytes: size, local_output: 'deleted' });
  await spool.remove('progress.json');
  return true;
}

export async function drainMedia(worker: Worker, t: Transport): Promise<void> {
  if (!(await worker.state.list()).includes('media')) return;
  const root = await worker.state.child('media');
  for (const id of (await root.list()).filter(name => /^[a-f0-9]{32}$/.test(name))) {
    try {
      const spool = await root.child(id);
      const confirmed = await reconcileJob(worker, t, spool, id);
      if (confirmed && !(await spool.list()).length) await root.io.rmdir(spool.root);
    } catch (error) {
      await worker.logger.log('WARN', 'worker.media_transfer_pending', { job_id: id, operation_id: id, cause: cause(error), ...(error instanceof Failure ? error.fields : {}), local_output: 'preserved' });
    }
  }
}
