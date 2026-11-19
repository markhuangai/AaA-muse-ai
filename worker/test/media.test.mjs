import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, symlink, unlink, lstat, readdir, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { claimed, enrolled, fixture, JOB } from './helpers.mjs';
import { drainMedia, finishMedia } from '../dist/media.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const prompt = 'private-customer-prompt-sentinel';
const image = Buffer.from('private-image-sentinel');
const output = Buffer.from('private-original-output-sentinel');

async function setup(t, profile, motion = prompt) {
  const f = await fixture(t);
  const io = f.state.io;
  f.state.io = { ...io, async mkdtemp(prefix) {
    const directory = await io.mkdtemp(prefix);
    t.after(() => rm(directory, { recursive: true, force: true }));
    return directory;
  } };
  const transport = await enrolled(f);
  const j = claimed({ media: { profile, input_sha256: sha(image), input_size: image.length, input_type: 'image/png', prompt_sha256: sha(motion) } });
  f.broker.jobs.set(JOB, j);
  const api = f.net.fetch;
  const flags = { interrupt: false, loseAck: false, invalidAck: false, requests: [], wrongImage: false };
  f.net.fetch = async (url, options) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/media/prompt')) return new Response(motion);
    if (path.endsWith('/media/image')) return new Response(flags.wrongImage ? Buffer.from('wrong') : image, { headers: { 'content-type': 'image/png' } });
    if (!path.endsWith('/artifact')) return api(url, options);
    assert.equal(options.method, 'PUT');
    const body = Buffer.from(await new Response(options.body).arrayBuffer());
    assert.deepEqual(body, output);
    assert.equal(options.headers['X-Muse-Artifact-Sha256'], sha(output));
    flags.requests.push(sha(body));
    if (flags.interrupt) return new Response(null, { status: 503 });
    if (flags.invalidAck) return Response.json({ accepted: false });
    j.state = 'accepted'; j.held = false;
    j.media.artifact = { sha256: sha(output), size: output.length };
    if (flags.loseAck) throw new Error('response lost');
    return Response.json({ job_id: JOB, accepted: true, sha256: sha(output), size: output.length, expires_at: new Date(Date.now() + 600000).toISOString() });
  };
  const spool = join(f.state.root, 'media', JOB);
  return { ...f, transport, j, flags, spool, progress: join(spool, 'progress.json') };
}

for (const profile of ['image_video', 'prompt_video', 'native_mp3', 'offline_wav']) {
  test('job-bound system temporary media and durable confirmation for ' + profile, async t => {
    const motion = profile === 'prompt_video' ? '\uFEFF' + prompt : prompt;
    const f = await setup(t, profile, motion);
    await drainMedia(f.worker, f.transport);
    const shown = await f.worker.show(JOB);
    assert.match(shown.output_dir, new RegExp('^/tmp/aaa-muse-media-' + JOB + '-[A-Za-z0-9]+$'));
    const info = await lstat(shown.output_dir);
    assert.ok(info.isDirectory());
    assert.equal(info.uid, f.state.sys.uid);
    assert.equal(info.mode & 0o7777, 0o700);
    assert.equal(dirname(shown.output_path), shown.output_dir);
    assert.deepEqual(await readdir(f.spool), ['progress.json']);
    assert.equal(JSON.parse(await readFile(f.progress, 'utf8')).temporary_directory, shown.output_dir);
    if (profile === 'image_video') assert.deepEqual(await readFile(shown.reference_path), image);
    if (profile === 'prompt_video') await writeFile(shown.generated_still_path, image);
    if (profile.endsWith('video')) assert.equal(shown.prompt, motion);
    else assert.equal(shown.fixture_sha256, sha(image));
    assert.equal((await f.worker.show(JOB)).action, 'preserve_existing_generation');
    await assert.rejects(f.worker.submit(JOB, JSON.stringify({ type: 'final', text: prompt })), /media_upload_required/);
    await writeFile(shown.output_path, output);
    const sidecar = join(shown.output_dir, 'native-result.webp');
    await writeFile(sidecar, image);
    assert.equal((await finishMedia(f.worker, JOB)).state, 'ready');
    assert.equal((await finishMedia(f.worker, JOB)).state, 'ready');
    f.flags.interrupt = true;
    await drainMedia(f.worker, f.transport);
    assert.deepEqual(await readFile(shown.output_path), output);
    f.flags.interrupt = false; f.flags.loseAck = profile === 'image_video';
    await drainMedia(f.worker, f.transport);
    if (f.flags.loseAck) {
      assert.deepEqual(await readFile(shown.output_path), output);
      assert.equal(f.j.state, 'accepted');
      await rm(shown.output_dir, { recursive: true });
      await drainMedia(f.worker, f.transport);
    } else {
      assert.deepEqual(await readFile(shown.output_path), output);
      assert.deepEqual(await readFile(sidecar), image);
    }
    assert.equal(f.flags.requests.length, 2);
    await assert.rejects(access(f.progress), { code: 'ENOENT' });
    assert.equal((await finishMedia(f.worker, JOB)).state, 'accepted');
    const logs = await f.logger.capture.export({}, true);
    assert.ok(logs.includes('worker.media_upload_confirmed'));
    assert.ok(logs.includes('"local_output":"system_tmp"'));
    for (const value of [prompt, image.toString(), output.toString()]) assert.ok(!logs.includes(value));
  });
}

test('invalid source, uncertain native work and mismatched receipt preserve the output', async t => {
  const f = await setup(t, 'image_video');
  f.flags.wrongImage = true;
  await assert.rejects(f.worker.show(JOB), /media_reference_digest_mismatch/);
  f.flags.wrongImage = false;
  const shown = await f.worker.show(JOB);
  await symlink(shown.reference_path, shown.output_path);
  await assert.rejects(finishMedia(f.worker, JOB));
  await unlink(shown.output_path);
  await writeFile(shown.output_path, output);
  await finishMedia(f.worker, JOB);
  f.flags.invalidAck = true;
  await drainMedia(f.worker, f.transport);
  assert.deepEqual(await readFile(shown.output_path), output);
  f.j.state = 'interrupted';
  await drainMedia(f.worker, f.transport);
  assert.deepEqual(await readFile(shown.reference_path), image);
  assert.deepEqual(await readFile(shown.output_path), output);
  await access(f.progress);
  await assert.rejects(finishMedia(f.worker, JOB), /assignment_not_active/);
  f.j.held = false;
  await drainMedia(f.worker, f.transport);
  await assert.rejects(access(f.progress), { code: 'ENOENT' });
});

test('a failed generation handoff can stage again after the system removes its temporary directory', async t => {
  const f = await setup(t, 'image_video');
  const io = f.state.io;
  f.state.io = { ...io, open: async (path, ...args) => {
    if (String(path).includes('/.progress.json.')) {
      const saved = await readFile(f.progress, 'utf8').catch(error => { if (error.code !== 'ENOENT') throw error; });
      if (saved && await access(join(JSON.parse(saved).temporary_directory, 'reference.png')).then(() => true, () => false)) {
        throw Object.assign(new Error('injected journal failure'), { code: 'EIO' });
      }
    }
    return io.open(path, ...args);
  } };
  await assert.rejects(f.worker.show(JOB), { code: 'EIO' });
  const saved = JSON.parse(await readFile(f.progress, 'utf8'));
  assert.equal(saved.state, 'preparing');
  await assert.rejects(finishMedia(f.worker, JOB), /media_generation_not_started/);
  await rm(saved.temporary_directory, { recursive: true });
  f.state.io = io;
  const shown = await f.worker.show(JOB);
  assert.notEqual(shown.output_dir, saved.temporary_directory);
  assert.deepEqual(await readFile(shown.reference_path), image);
});

test('temporary media loss before acceptance preserves the assignment and prevents generation replay', async t => {
  const f = await setup(t, 'prompt_video');
  const shown = await f.worker.show(JOB);
  await writeFile(shown.output_path, output);
  await finishMedia(f.worker, JOB);
  await unlink(shown.output_path);
  await drainMedia(f.worker, f.transport);
  assert.match(await f.logger.capture.export({}, true), /media_output_missing/);
  await rm(shown.output_dir, { recursive: true });
  await assert.rejects(f.worker.show(JOB), /media_temporary_directory_missing/);
  await drainMedia(f.worker, f.transport);
  assert.match(await f.logger.capture.export({}, true), /media_temporary_directory_missing/);
  assert.equal(f.flags.requests.length, 0);
  assert.equal(f.j.held, true);
  assert.equal(JSON.parse(await readFile(f.progress, 'utf8')).state, 'ready');
});

test('an in-flight journal from an earlier release still uses its original media directory', async t => {
  const f = await setup(t, 'image_video');
  const spool = await (await f.state.child('media')).child(JOB);
  const { worker_id, lease_id, generation, connection_id, connection_generation } = f.j;
  await spool.write('progress.json', JSON.stringify({
    origin: f.transport.endpoint, job_id: JOB, worker_id, lease_id, generation, connection_id, connection_generation,
    profile: 'image_video', state: 'generating',
  }));
  await writeFile(spool.path('reference.png'), image);
  await writeFile(spool.path('result.mp4'), output);
  assert.equal((await f.worker.show(JOB)).action, 'preserve_existing_generation');
  await finishMedia(f.worker, JOB);
  await drainMedia(f.worker, f.transport);
  assert.equal(f.flags.requests.length, 1);
  await assert.rejects(access(spool.root), { code: 'ENOENT' });
});
