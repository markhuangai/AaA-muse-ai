import { expect, test } from 'vitest';
import { BrowserAPI } from '../src/api';
import { enrollment, worker } from './helpers';

const signal = () => new AbortController().signal;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'X-Request-Id': 'worker-api-request' } });

test('management calls use the real adapter, immutable IDs and accepted backend values', async () => {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const api = new BrowserAPI((async (path, options) => {
    const url = String(path);
    calls.push({ path: url, method: options!.method!, body: options!.body ? JSON.parse(String(options!.body)) : null });
    if (url.endsWith('/workers')) return json({ workers: [worker()] });
    if (url.endsWith('/setup-prompts')) return json(enrollment());
    if (url.endsWith('/enrollments')) return json(enrollment('code'));
    return json(worker('a'.repeat(32), 'Accepted name'));
  }) as typeof fetch);
  expect((await api.workers('list-operation', signal())).value[0].id).toBe(worker().id);
  expect((await api.renameWorker(worker().id, '  Accepted name  ', 'rename-operation', signal())).value.name).toBe('Accepted name');
  expect((await api.revokeWorker(worker().id, 'revoke-operation', signal())).requestID).toBe('worker-api-request');
  expect((await api.enrollment('prompt', 'prompt-operation', signal())).value.setup_prompt).toBe(enrollment().setup_prompt);
  expect((await api.enrollment('code', 'code-operation', signal())).value.enrollment_code === enrollment('code').enrollment_code).toBe(true);
  expect(calls.map(value => value.method)).toEqual(['GET', 'PATCH', 'POST', 'POST', 'POST']);
  expect(calls[1].body).toEqual({ name: '  Accepted name  ' });
  expect(calls.every(value => value.path.startsWith('/api/v1/admin/'))).toBe(true);
  await expect(api.renameWorker('../escape', 'name', 'operation', signal())).rejects.toMatchObject({ causeCode: 'invalid_worker_id' });
  expect(calls).toHaveLength(5);
});

test('worker boundary validation rejects malformed facts, duplicate identities and mismatched action targets', async () => {
  const qualification = { id: 'qualification', created_at: '2026-11-13T00:00:00Z', connection_id: 'connection', connection_generation: 1, capabilities: ['text'], evidence: { action: 'approve', evidence_kind: 'controlled', evidence_reference: 'Software fixture' } };
  const valid = { ...worker(), current_job: { job_id: 'job', generation: 1 }, qualification, qualification_history: [qualification] };
  const good = new BrowserAPI((async () => json({ workers: [valid] })) as typeof fetch);
  expect((await good.workers('operation', signal())).value[0].qualification?.evidence.evidence_kind).toBe('controlled');
  for (const data of [null, {}, { workers: null }, { workers: [worker(), worker()] }, ...[
    { id: 'wrong' }, { name: 1 }, { registered_at: 'wrong' }, { revoked_at: 'wrong' }, { last_contact_at: undefined },
    { connection_status: 1 }, { work_status: null }, { current_job: {} }, { waiting_for_client_tool: -1 }, { last_heartbeat_at: false },
    { inference_readiness: 1 }, { qualification: {} }, { qualification_history: [{}] }, { qualification_history: null },
    { qualification: { ...qualification, connection_generation: 0.5 } }, { qualification: { ...qualification, capabilities: [1] } },
    { qualification: { ...qualification, evidence: { ...qualification.evidence, evidence_kind: 1 } } },
  ].map(patch => ({ workers: [{ ...worker(), ...patch }] }))]) {
    const api = new BrowserAPI((async () => json(data)) as typeof fetch);
    await expect(api.workers('operation', signal())).rejects.toMatchObject({ causeCode: 'invalid_response', requestID: 'worker-api-request' });
  }
  const mismatch = new BrowserAPI((async () => json(worker('b'.repeat(32)))) as typeof fetch);
  await expect(mismatch.revokeWorker(worker().id, 'operation', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
});

test('enrollment validation and safe error parsing retain correlation without arbitrary upstream text', async () => {
  for (const kind of ['code', 'prompt'] as const) {
    for (const patch of [null, {}, { enrollment_id: 'invalid' }, { expires_at: 'invalid' }, { expires_at: '2026-11-12T00:00:00Z' },
      kind === 'code' ? { enrollment_code: 'wrong' } : { setup_prompt: '' }, kind === 'code' ? { enrollment_code: null } : { worker_package: {} }]) {
      const api = new BrowserAPI((async () => json(patch === null ? null : { ...enrollment(kind), ...patch })) as typeof fetch);
      if (patch && Object.keys(patch).length === 0) expect((await api.enrollment(kind, 'operation', signal())).value.enrollment_id).toBe('e'.repeat(32));
      else await expect(api.enrollment(kind, 'operation', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
    }
  }
  for (const [status, reason] of [[400, 'invalid_worker_name'], [404, 'worker_not_found'], [503, 'worker_package_unconfigured']] as const) {
    const api = new BrowserAPI((async () => json({ error: reason }, status)) as typeof fetch);
    await expect(api.renameWorker(worker().id, 'name', 'operation', signal())).rejects.toMatchObject({ status, causeCode: reason, requestID: 'worker-api-request' });
  }
  const untrusted = new BrowserAPI((async () => json({ error: 'private detail' }, 400)) as typeof fetch);
  await expect(untrusted.workers('operation', signal())).rejects.toMatchObject({ causeCode: 'request_failed', message: 'request_failed' });
  const invalid = new BrowserAPI((async () => new Response('{', { status: 503 })) as typeof fetch);
  await expect(invalid.workers('operation', signal())).rejects.toMatchObject({ causeCode: 'service_unavailable' });
});
