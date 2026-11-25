import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { BrowserAPI } from '../src/api';
import { Reports } from '../src/reports';
import { WorkerRemoteController } from '../src/worker-remote-controller';
import { WorkerRemoteSections } from '../src/worker-remote';
import { deferred, settle, TestAPI, TestSystem } from './helpers';
import type { Worker } from '../src/worker-api';

for (const key of ['showModal', 'close'] as const) {
  if (!HTMLDialogElement.prototype[key]) Object.defineProperty(HTMLDialogElement.prototype, key, { configurable: true, writable: true, value() {} });
}

afterEach(() => vi.unstubAllGlobals());

const workerID = 'a'.repeat(32);
const otherID = 'c'.repeat(32);
const taskID = 'b'.repeat(32);
const created = '2026-11-13T00:00:00Z';
const item = { id: taskID, worker_id: workerID, state: 'queued', held: false, created_at: created,
  deadline_at: '2026-11-13T00:05:00Z', title: 'Inspect fixture', remote_outcome: 'not_started' };
const worker = { id: workerID, name: 'Studio', worker_ops_ready: true, agent_tasks_ready: true } as Worker;
const response = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'X-Request-Id': 'remote-test' } });
const signal = () => new AbortController().signal;

test.each(['worker_already_paired', 'update_requires_newer_pair', 'update_target_unavailable'])('preserves the safe %s conflict reason', async reason => {
  const fetcher = vi.fn(async () => response({ error: reason }, 409));
  const api = new BrowserAPI(fetcher);
  await expect(api.workerRemote.submit(workerID, 'ops', { kind: 'retry_update' }, 'submitted', 'browser-op', signal()))
    .rejects.toMatchObject({ status: 409, causeCode: reason, requestID: 'remote-test' });
  expect(fetcher).toHaveBeenCalledTimes(1);
});

test('the remote API validates worker ownership and detail identity', async () => {
  const api = new BrowserAPI(async input => String(input).endsWith('/hook-prompt') ?
    response({ worker_id: workerID, hook_id: 'aaa-muse-worker-' + workerID, prompt_contract: 'managed-hook-prompt-v2', upgrade_prompt: 'Use the installed launcher' }) :
    String(input).endsWith(taskID) ? response({ ...item, id: otherID }) : response({ items: [{ ...item, worker_id: otherID }] }));
  await expect(api.workerRemote.hookPrompt(workerID, 'op', signal())).resolves.toMatchObject({ value: 'Use the installed launcher' });
  await expect(api.workerRemote.list(workerID, 'agent-tasks', 'op', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
  await expect(api.workerRemote.detail(workerID, 'agent-tasks', taskID, 'op', signal())).rejects.toMatchObject({ causeCode: 'invalid_response' });
});

test('polls only during active work and fences old selections and unconfirmed writes', async () => {
  let reads = 0;
  let writes = 0;
  let selectedItems: unknown[] = [item];
  let deny = false;
  let drop = false;
  let started = false;
  const delayed = deferred<Response>();
  const system = new TestSystem();
  const fake = new TestAPI(system);
  const browser = new BrowserAPI(async (input, init) => {
    if (deny) return response({ error: 'unauthorized' }, 401);
    if (init?.method === 'POST') {
      writes++;
      if (drop) throw new Error('lost reply');
      if (String(input).endsWith('/cancel')) return response({ ...item, state: 'cancelled' });
      return response(item, 202);
    }
    if (String(input).endsWith(taskID)) {
      started = true;
      return delayed.promise;
    }
    reads++;
    return response({ items: String(input).includes(workerID) && String(input).endsWith('/agent-tasks') ? selectedItems : [] });
  });
  const denied = vi.fn();
  const controller = new WorkerRemoteController(browser.workerRemote, system, new Reports(fake), () => true, () => true, denied);
  controller.select(workerID);
  await settle();
  expect(controller.snapshot().items['agent-tasks']).toEqual([item]);
  await system.advance(4999);
  expect(reads).toBe(2);
  selectedItems = [{ ...item, state: 'completed' }];
  await system.advance(1);
  expect(reads).toBe(4);
  await system.advance(10_000);
  expect(reads).toBe(4);
  const detail = controller.detail('agent-tasks', taskID);
  expect(started).toBe(true);
  controller.select(otherID);
  delayed.resolve(response({ ...item, prompt: 'stale detail' }));
  await detail;
  await settle();
  expect(controller.snapshot().details['agent-tasks']).toBeNull();
  controller.select(workerID);
  await settle();
  drop = true;
  expect(await controller.mutate('agent-tasks', { prompt: 'controlled' })).toBe(false);
  expect(controller.snapshot().uncertain).toBe(true);
  expect(await controller.mutate('agent-tasks', { prompt: 'controlled' })).toBe(false);
  expect(writes).toBe(1);
  await controller.refresh(true);
  expect(controller.snapshot().uncertain).toBe(false);
  drop = false;
  expect(await controller.mutate('agent-tasks', {}, taskID)).toBe(true);
  expect(controller.snapshot().items['agent-tasks'][0].state).toBe('cancelled');
  deny = true;
  await controller.refresh();
  expect(denied).toHaveBeenCalledWith('remote-test', expect.any(String));
  controller.reset();
});

test('keeps a new detail selection when an automatic refresh completes first', async () => {
  const first = { ...item, state: 'running', held: true };
  const second = { ...item, id: otherID, state: 'completed' };
  const outstanding = deferred<Response>();
  const browser = new BrowserAPI(async input => {
    const path = String(input);
    if (path.endsWith(second.id)) return outstanding.promise;
    if (path.endsWith(first.id)) return response(first);
    return response({ items: path.endsWith('/agent-tasks') ? [second, first] : [] });
  });
  const system = new TestSystem();
  const controller = new WorkerRemoteController(browser.workerRemote, system, new Reports(new TestAPI(system)), () => true, () => true, vi.fn());
  try {
    controller.select(workerID);
    await settle();
    await controller.detail('agent-tasks', first.id);
    const selected = controller.detail('agent-tasks', second.id);
    await system.advance(5000);
    outstanding.resolve(response(second));
    await selected;
    expect(controller.snapshot().details['agent-tasks']?.id).toBe(second.id);
  } finally {
    controller.reset();
  }
});

test('names the target in the confirmation and displays task output as text', async () => {
  const show = vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) {
    this.setAttribute('open', '');
    this.querySelector<HTMLElement>('button')?.focus();
  });
  const close = vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
  const posts: unknown[] = [];
  const task = { ...item, state: 'completed', result: { result_text: '<img src=x onerror=alert(1)>', summary: 'Plain result' } };
  const api = new BrowserAPI(async (input, init) => {
    if (init?.method === 'POST') {
      posts.push(JSON.parse(init.body as string));
      return response(item, 202);
    }
    if (String(input).endsWith(taskID)) return response(task);
    return response({ items: String(input).endsWith('/agent-tasks') ? [task] : [] });
  });
  const system = new TestSystem();
  const controller = new WorkerRemoteController(api.workerRemote, system, new Reports(new TestAPI(system)), () => true, () => true, vi.fn());
  controller.select(workerID);
  await settle();
  const mounted = render(<WorkerRemoteSections controller={controller} worker={worker} stale={false} />);
  try {
    fireEvent.change(screen.getByLabelText('Task prompt'), { target: { value: 'Inspect the fixture' } });
    fireEvent.click(screen.getByRole('button', { name: 'Review task' }));
    const confirmation = screen.getByRole('dialog');
    expect(within(confirmation).getByText(workerID)).toBeTruthy();
    expect(within(confirmation).getByText(/permission approvals/)).toBeTruthy();
    expect(document.activeElement).toBe(within(confirmation).getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(confirmation).getByRole('button', { name: 'Confirm task' }));
    await act(settle);
    expect(posts).toEqual([{ prompt: 'Inspect the fixture', timeout_seconds: 300, protocol_version: 1, submission_id: expect.any(String) }]);
    fireEvent.click(screen.getByRole('button', { name: /Inspect fixture/ }));
    await act(settle);
    expect(screen.getByLabelText('Worker output').textContent).toContain('<img');
    expect(mounted.container.querySelector('img')).toBeNull();
  } finally {
    mounted.unmount();
    controller.reset();
    show.mockRestore();
    close.mockRestore();
  }
});

test('queues typed operations and downloads, copies, and continues a filtered export', async () => {
  const id = 'd'.repeat(32);
  const typed = { ...item, id, title: undefined, kind: 'diagnostics_export', state: 'succeeded',
    claim: { params: { operation_id: 'existing-operation', decode: true } },
    result: { complete: false, truncated: true, next_cursor: 'another-page', omissions: ['bounded_results_remaining'], output: ['{"msg":"controlled"}\n'] } };
  const posts: { path: string; body: Record<string, unknown> }[] = [];
  const api = new BrowserAPI(async (input, init) => {
    const path = String(input);
    if (path.endsWith('/hook-prompt')) return response({ worker_id: workerID, hook_id: 'aaa-muse-worker-' + workerID,
      prompt_contract: 'managed-hook-prompt-v2', upgrade_prompt: 'Use the installed launcher for ' + workerID });
    if (init?.method === 'POST') {
      const body = JSON.parse(init.body as string);
      posts.push({ path, body });
      return response({ ...item, id: 'e'.repeat(31) + String(posts.length), kind: body.kind }, 202);
    }
    if (path.endsWith(id)) return response(typed);
    return response({ items: path.endsWith('/ops') ? [typed] : [] });
  });
  const clipboard = { writeText: vi.fn(async (_value: string) => {}) };
  vi.stubGlobal('navigator', { clipboard });
  const originalURL = URL;
  const objectURL = vi.fn(() => 'blob:test');
  const revokeURL = vi.fn();
  class DownloadURL extends originalURL {
    static createObjectURL = objectURL;
    static revokeObjectURL = revokeURL;
  }
  vi.stubGlobal('URL', DownloadURL);
  const download = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toEqual(`worker-diagnostics-${id}.ndjson`);
  });
  const system = new TestSystem();
  const controller = new WorkerRemoteController(api.workerRemote, system, new Reports(new TestAPI(system)), () => true, () => true, vi.fn());
  controller.select(workerID);
  await settle();
  const selected = { ...worker, agent_tasks_ready: false, worker_update: { state: 'failed' } };
  const mounted = render(<WorkerRemoteSections controller={controller} worker={selected} stale={false} />);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Show hook upgrade prompt' }));
    await act(settle);
    const instructions = screen.getByLabelText('Main chat upgrade prompt') as HTMLTextAreaElement;
    expect(instructions.getAttribute('data-sensitive')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Copy upgrade prompt' }));
    await act(settle);
    expect(clipboard.writeText).toHaveBeenCalledWith(instructions.value);

    fireEvent.click(screen.getByRole('button', { name: 'Run doctor' }));
    await act(settle);
    fireEvent.click(screen.getByRole('button', { name: 'Retry update' }));
    await act(settle);
    fireEvent.click(screen.getByText('Export diagnostics'));
    fireEvent.change(screen.getByLabelText('Operation ID'), { target: { value: 'browser-filter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Queue export' }));
    await act(settle);
    // The terminal item is distinct from the queued export.
    fireEvent.click(screen.getByRole('button', { name: /Diagnostics export.*Succeeded/ }));
    await act(settle);
    expect(screen.getByLabelText('Worker output').textContent).toContain('controlled');
    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    await act(settle);
    expect(clipboard.writeText).toHaveBeenCalledWith('{"msg":"controlled"}\n');
    clipboard.writeText.mockRejectedValueOnce(new Error('denied'));
    fireEvent.click(screen.getByRole('button', { name: 'Copy output' }));
    await act(settle);
    expect(screen.getByText('Clipboard unavailable. Copy the selected text.')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Download' }));
    expect(objectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(download).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export next page' }));
    await act(settle);
    expect(posts.map(call => call.body.kind)).toEqual(['doctor', 'retry_update', 'diagnostics_export', 'diagnostics_export']);
    expect(posts[2].body.params).toEqual({ decode: true, operation_id: 'browser-filter' });
    expect(posts[3].body.params).toEqual({ decode: true, operation_id: 'existing-operation', cursor: 'another-page' });
  } finally {
    mounted.unmount();
    controller.reset();
    download.mockRestore();
  }
});

test('cancellation names the selected worker and an open dialog respects stale state', async () => {
  vi.spyOn(HTMLDialogElement.prototype, 'showModal').mockImplementation(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  vi.spyOn(HTMLDialogElement.prototype, 'close').mockImplementation(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
  const posts: string[] = [];
  const api = new BrowserAPI(async (input, init) => {
    const path = String(input);
    if (init?.method === 'POST') {
      posts.push(path);
      return response({ ...item, state: 'cancelled' });
    }
    return response({ items: path.endsWith('/agent-tasks') ? [item] : [] });
  });
  const system = new TestSystem();
  const controller = new WorkerRemoteController(api.workerRemote, system, new Reports(new TestAPI(system)), () => true, () => true, vi.fn());
  controller.select(workerID);
  await settle();
  const mounted = render(<WorkerRemoteSections controller={controller} worker={worker} stale={false} />);
  try {
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }));
    const dialog = screen.getByRole('dialog', { name: 'Cancel this background task?' });
    expect(within(dialog).getByText(workerID)).toBeTruthy();
    mounted.rerender(<WorkerRemoteSections controller={controller} worker={worker} stale />);
    const confirm = within(dialog).getByRole('button', { name: 'Confirm cancellation' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    mounted.rerender(<WorkerRemoteSections controller={controller} worker={worker} stale={false} />);
    fireEvent.click(confirm);
    await act(settle);
    expect(posts).toEqual([`/api/v1/admin/workers/${workerID}/agent-tasks/${taskID}/cancel`]);
  } finally {
    mounted.unmount();
    controller.reset();
    vi.restoreAllMocks();
  }
});
