import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { APIError } from '../src/api';
import { App } from '../src/app';
import { PortalController } from '../src/controller';
import { Workers, timestamp } from '../src/workers';
import { TestAPI, TestSystem, deferred, enrollment, settle, worker } from './helpers';

const dialogRestores: (() => void)[] = [];
afterEach(() => { cleanup(); history.replaceState(null, '', '/'); for (const restore of dialogRestores.splice(0)) restore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function dialogAdapter() {
  for (const [method, open] of [['showModal', true], ['close', false]] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method);
    Object.defineProperty(HTMLDialogElement.prototype, method, { configurable: true, value: function(this: HTMLDialogElement) { this.open = open; } });
    dialogRestores.push(() => { if (original) Object.defineProperty(HTMLDialogElement.prototype, method, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, method); });
  }
}
async function fixture() {
  dialogAdapter();
  const system = new TestSystem(); const api = new TestAPI(system); const portal = new PortalController(api, system);
  await portal.login('password'); portal.navigate('workers'); await settle();
  return { system, api, portal, controller: portal.workers };
}

test('actual worker components show facts separately, text-safe names and the server-accepted rename', async () => {
  const { portal, api, controller } = await fixture();
  api.workersWork = async () => ({ value: [{ ...worker(), name: '<img src=x onerror=alert(1)>', work_status: 'busy', connection_status: 'quiet',
    current_job: { job_id: 'job-observed', generation: 2 }, waiting_for_client_tool: 1,
    current_claim: { job_id: 'job-observed', claim_id: 'observed-claim', claimed_at: '2026-11-18T00:00:00Z', deadline_at: '2026-11-18T00:05:00Z' },
    last_poll_at: '2026-11-18T00:00:00Z', claim_stage: 'pending_native_start',
    weekly_usage: { used_percent: 33.25, observed_at: '2026-11-18T00:00:00Z', reset_label: 'Nov 29 at 7:49 AM EST', stale: false },
    model_report: { model_name: '<img src=x onerror=alert(2)>', context_window_tokens: 350000, reported_at: '2026-11-18T00:00:00Z' } },
  { ...worker('b'.repeat(32), 'New worker'), connection_status: 'not_observed', last_contact_at: null, last_poll_at: null, work_status: 'unknown' }], requestID: 'facts-request' });
  await controller.refresh(); render(<Workers controller={controller} />);
  expect(screen.getByText('66.75%', { exact: true })).toBeTruthy();
  expect(screen.queryByRole('columnheader', { name: 'Qualification' })).toBeNull();
  expect(within(screen.getByRole('button', { name: 'New worker' }).closest('tr')!).getByText('Never seen')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '<img src=x onerror=alert(1)>' })); });
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByRole('heading', { name: 'Reported by Muse during setup' })).toBeTruthy();
  expect(screen.getByText('<img src=x onerror=alert(2)>')).toBeTruthy();
  expect(screen.getByText('350,000 tokens')).toBeTruthy();
  expect(screen.getByText('Reported at').nextElementSibling?.textContent).toBe('2026-11-18 00:00:00 UTC');
  expect(screen.getByText('Last work poll').nextElementSibling?.textContent).toBe('2026-11-18 00:00:00 UTC');
  expect(screen.getByText('Installed version').parentElement?.textContent).toContain('Not reported'); expect(screen.getByText('Not independently observed')).toBeTruthy();
  expect(screen.getByText('job-observed')).toBeTruthy();
  expect(screen.getByText('observed-claim')).toBeTruthy();
  expect(screen.getByText('Pending native start')).toBeTruthy();
  expect(screen.getByText('2026-11-18 00:05:00 UTC')).toBeTruthy();
  expect(screen.queryByRole('heading', { name: 'Inference qualification' })).toBeNull();
  expect(screen.getByText('Valid until revoked')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: '  Accepted name  ' } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('Display name').closest('form')!); await settle(); });
  expect(screen.getByRole('heading', { name: 'Accepted name' })).toBeTruthy();
  expect(screen.getByText('rename-request')).toBeTruthy();
  expect(screen.getAllByText(worker().id).length).toBeGreaterThan(0);
  portal.dispose();
});

test('empty, loading, stale and enrollment states keep usable controls without persisting sensitive text', async () => {
  const { portal, api, controller, system } = await fixture();
  api.workersWork = async () => ({ value: [], requestID: 'empty-workers' }); await controller.refresh(); render(<Workers controller={controller} />);
  expect(screen.getByText(/No workers have access/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate setup prompt' })); await settle(); });
  expect((screen.getByLabelText('Complete setup prompt') as HTMLTextAreaElement).value === enrollment().setup_prompt).toBe(true);
  const select = vi.spyOn(HTMLTextAreaElement.prototype, 'select'); fireEvent.click(screen.getByRole('button', { name: 'Select text' })); expect(select).toHaveBeenCalledOnce();
  fireEvent.change(screen.getByLabelText('Enrollment format'), { target: { value: 'code' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Generate enrollment code' })); await settle(); });
  expect((screen.getByLabelText('Single-use enrollment code') as HTMLTextAreaElement).value === enrollment('code').enrollment_code).toBe(true);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy enrollment code' })); await settle(); });
  expect(screen.getByText(/Clipboard access failed/)).toBeTruthy();
  await act(async () => { await system.advance(900_000); });
  expect(screen.queryByLabelText('Single-use enrollment code')).toBeNull(); expect(screen.getByText(/Enrollment expired/)).toBeTruthy();
  expect(localStorage.length).toBe(0); expect(sessionStorage.length).toBe(0); portal.dispose();
});

test('native-dialog callbacks issue revocation only after confirmation and expose accepted revocation', async () => {
  const { portal, controller } = await fixture();
  render(<Workers controller={controller} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Studio worker' })); });
  fireEvent.click(screen.getByRole('button', { name: 'Revoke worker' })); expect(screen.getByRole('dialog', { name: 'Revoke this worker?' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(controller.snapshot().workers?.[0].revoked_at).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke worker' }));
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Confirm revocation' }).closest('form')!); await settle(); });
  expect(screen.getByText(/server confirmed revocation/)).toBeTruthy();
  expect(screen.queryByRole('dialog', { name: 'Studio worker' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Studio worker' })).toBeNull();
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'Workers' })); portal.dispose();
});

test('shell navigation uses history in the same session and responds to back/forward', async () => {
  const system = new TestSystem(); const api = new TestAPI(system); const portal = new PortalController(api, system);
  await portal.login('password'); render(<App controller={portal} />);
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Workers' })); await settle(); });
  expect(location.pathname).toBe('/workers'); expect(screen.getByRole('heading', { name: 'Workers' })).toBeTruthy();
  await act(async () => { history.replaceState(null, '', '/settings'); window.dispatchEvent(new PopStateEvent('popstate')); await settle(); });
  expect(screen.getByRole('heading', { name: 'Service settings' })).toBeTruthy(); expect(api.loginCalls).toBe(1);
  expect(timestamp(null)).toBe('Not observed'); portal.dispose();
});

test('closing a worker drawer during rename returns focus to the row before and after the response', async () => {
  const { portal, controller, api } = await fixture();
  const rename = deferred<{ value: ReturnType<typeof worker>; requestID: string }>();
  api.renameWork = () => rename.promise;
  render(<Workers controller={controller} />);
  const opener = screen.getByRole('button', { name: 'Studio worker' });
  fireEvent.click(opener);
  fireEvent.change(screen.getByLabelText('Display name'), { target: { value: 'Updated worker' } });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Save name' })); await settle(); });
  fireEvent(screen.getByRole('dialog', { name: 'Studio worker' }), new Event('cancel', { cancelable: true, bubbles: true }));
  expect(document.activeElement).toBe(opener);
  await act(async () => { rename.resolve({ value: worker(undefined, 'Updated worker'), requestID: 'reply' }); await settle(); });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Updated worker' }));
  portal.dispose();
});

test('offline values age from each accepted row and freeze at the broker sample when stale', async () => {
  const { portal, controller, api, system } = await fixture();
  const first = { ...worker(), connection_status: 'offline', offline_for_ms: 0 };
  const second = { ...worker('b'.repeat(32), 'Second worker'), connection_status: 'offline', offline_for_ms: 90_123_000 };
  const legacy = { ...worker('c'.repeat(32), 'Older worker'), connection_status: 'offline' };
  api.workersWork = async () => ({ value: [first, second, legacy], requestID: 'offline-snapshot' });
  await controller.refresh();
  render(<Workers controller={controller} />);
  function value(name: string) {
    const row = screen.getByRole('button', { name }).closest('tr')!;
    return within(row).getAllByRole('cell')[2].querySelector('.num')?.textContent;
  }
  expect(value(first.name)).toBe('0h 0m 0s');
  expect(value(second.name)).toBe('25h 2m 3s');
  expect(value(legacy.name)).toBe('-');
  const calls = api.workersCalls;
  await act(async () => { await system.advance(2_000); });
  expect(value(first.name)).toBe('0h 0m 2s');
  expect(value(second.name)).toBe('25h 2m 5s');
  expect(api.workersCalls).toBe(calls);

  const outdated = deferred<{ value: typeof first[]; requestID: string }>();
  api.workersWork = () => outdated.promise;
  let read!: Promise<void>;
  act(() => { read = controller.refresh(); });
  const renamed = { ...first, name: 'First renamed', offline_for_ms: 3723000 };
  api.renameWork = async () => ({ value: renamed, requestID: 'renamed-during-outage' });
  await act(async () => { await controller.mutate('rename', first.id, renamed.name); });
  await act(async () => { outdated.resolve({ value: [first], requestID: 'obsolete-outage' }); await read; });
  expect(value(renamed.name)).toBe('1h 2m 3s');
  expect(value(second.name)).toBe('25h 2m 5s');

  const scheduledWhileVisible = system.timers.size;
  await act(async () => { await system.visibility(false); });
  expect(system.timers.size).toBe(scheduledWhileVisible - 1);
  await act(async () => { await system.advance(2000); });
  expect(value(renamed.name)).toBe('1h 2m 3s');
  api.workersWork = async () => { throw new APIError('service_unavailable', 503, 'outage'); };
  await act(async () => { await system.visibility(true); await system.advance(2000); });
  expect(value(renamed.name)).toBe('1h 2m 3s');
  expect(value(second.name)).toBe('25h 2m 3s');

  api.workersWork = async () => ({ value: [{ ...renamed, connection_status: 'recent', offline_for_ms: undefined }, second, legacy], requestID: 'reconnected' });
  await act(async () => { await controller.refresh(); await system.advance(1000); });
  expect(value(renamed.name)).toBe('-');
  expect(value(second.name)).toBe('25h 2m 4s');
  portal.dispose();
  expect(system.timers.size).toBe(0);
});
