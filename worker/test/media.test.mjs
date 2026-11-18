import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, symlink, unlink } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { claimed, enrolled, fixture, JOB } from './helpers.mjs';
import { drainMedia, finishMedia } from '../dist/media.js';

const sha = value => createHash('sha256').update(value).digest('hex');
const prompt = 'private-customer-prompt-sentinel';
const image = Buffer.from('private-image-sentinel');
const output = Buffer.from('private-original-output-sentinel');

async function setup(t, profile, motion = prompt) {
  const f = await fixture(t);
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
  return { ...f, transport, j, flags, spool: join(f.state.root, 'media', JOB) };
}

for (const profile of ['image_video', 'prompt_video', 'native_mp3', 'offline_wav']) {
  test('job-bound generation and confirmed cleanup for ' + profile, async t => {
    const motion = profile === 'prompt_video' ? '\uFEFF' + prompt : prompt;
    const f = await setup(t, profile, motion);
    await drainMedia(f.worker, f.transport);
    const shown = await f.worker.show(JOB);
    if (profile === 'image_video') assert.deepEqual(await readFile(shown.reference_path), image);
    if (profile === 'prompt_video') await writeFile(shown.generated_still_path, image);
    if (profile.endsWith('video')) assert.equal(shown.prompt, motion);
    else assert.equal(shown.fixture_sha256, sha(image));
    assert.equal((await f.worker.show(JOB)).action, 'preserve_existing_generation');
    await assert.rejects(f.worker.submit(JOB, JSON.stringify({ type: 'final', text: prompt })), /media_upload_required/);
    await writeFile(shown.output_path, output);
    assert.equal((await finishMedia(f.worker, JOB)).state, 'ready');
    assert.equal((await finishMedia(f.worker, JOB)).state, 'ready');
    f.flags.interrupt = true;
    await drainMedia(f.worker, f.transport);
    assert.deepEqual(await readFile(shown.output_path), output);
    f.flags.interrupt = false; f.flags.loseAck = profile === 'image_video';
    await drainMedia(f.worker, f.transport);
    if (f.flags.loseAck) {
      assert.deepEqual(await readFile(shown.output_path), output);
      await drainMedia(f.worker, f.transport);
    }
    assert.equal(f.flags.requests.length, 2);
    await assert.rejects(access(shown.output_path), { code: 'ENOENT' });
    assert.equal((await finishMedia(f.worker, JOB)).state, 'accepted');
    const logs = await f.logger.capture.export({}, true);
    assert.ok(logs.includes('worker.media_upload_confirmed'));
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
  await assert.rejects(access(shown.reference_path), { code: 'ENOENT' });
  assert.deepEqual(await readFile(shown.output_path), output);
  await assert.rejects(finishMedia(f.worker, JOB), /assignment_not_active/);
});

test('a failed generation handoff keeps a recoverable journal and terminal cleanup removes staged bytes', async t => {
  const f = await setup(t, 'image_video');
  const io = f.state.io;
  const reference = join(f.spool, 'reference.png');
  f.state.io = { ...io, open: async (...args) => {
    if (String(args[0]).includes('/.progress.json.') && await access(reference).then(() => true, () => false)) {
      throw Object.assign(new Error('injected journal failure'), { code: 'EIO' });
    }
    return io.open(...args);
  } };
  await assert.rejects(f.worker.show(JOB), { code: 'EIO' });
  assert.equal(JSON.parse(await readFile(join(f.spool, 'progress.json'), 'utf8')).state, 'preparing');
  await assert.rejects(finishMedia(f.worker, JOB), /media_generation_not_started/);
  const partial = join(f.spool, '.input-partial');
  await writeFile(partial, image);
  f.j.state = 'cancelled';
  await drainMedia(f.worker, f.transport);
  for (const path of [reference, partial]) await assert.rejects(access(path), { code: 'ENOENT' });
});
