import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../src/app';
import { PortalController } from '../src/controller';
import { Workers, timestamp } from '../src/workers';
import { TestAPI, TestSystem, enrollment, settle, worker } from './helpers';

const dialogRestores: (() => void)[] = [];
afterEach(() => { cleanup(); history.replaceState(null, '', '/'); for (const restore of dialogRestores.splice(0)) restore(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const system = new TestSystem(); const api = new TestAPI(system); const portal = new PortalController(api, system);
  await portal.login('password'); portal.navigate('workers'); await settle();
  return { system, api, portal, controller: portal.workers };
}

test('actual worker components show facts separately, text-safe names and the server-accepted rename', async () => {
  const { portal, api, controller } = await fixture();
  api.workersWork = async () => ({ value: [{ ...worker(), name: '<img src=x onerror=alert(1)>', work_status: 'busy', current_job: { job_id: 'job-observed', generation: 2 }, waiting_for_client_tool: 1,
    inference_readiness: 'verified', qualification: { id: 'approval', created_at: worker().registered_at, connection_id: 'connection-observed', connection_generation: 3, capabilities: ['text', 'function_tools'], evidence: { action: 'approve', evidence_kind: 'controlled', evidence_reference: 'Controlled trial' } },
    qualification_history: [{ id: 'old-approval', created_at: worker().registered_at, connection_id: 'old-connection', connection_generation: 2, capabilities: [], evidence: { action: 'withdraw', evidence_reference: 'Withdrawn' } }] }], requestID: 'facts-request' });
  await controller.refresh(); render(<Workers controller={controller} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: '<img src=x onerror=alert(1)>' })); });
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('Installed version').parentElement?.textContent).toContain('Not reported'); expect(screen.getByText('Not independently observed')).toBeTruthy();
  expect(screen.getByText('job-observed')).toBeTruthy(); expect(screen.getByText('Controlled software evidence')).toBeTruthy();
  expect(screen.getByText('No automatic expiry; valid until revoked')).toBeTruthy();
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
  expect(screen.getByText(/No workers are registered/)).toBeTruthy();
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
  for (const [method, open] of [['showModal', true], ['close', false]] as const) {
    const original = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, method);
    Object.defineProperty(HTMLDialogElement.prototype, method, { configurable: true, value: function(this: HTMLDialogElement) { this.open = open; } });
    dialogRestores.push(() => { if (original) Object.defineProperty(HTMLDialogElement.prototype, method, original); else Reflect.deleteProperty(HTMLDialogElement.prototype, method); });
  }
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; }); vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  render(<Workers controller={controller} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Studio worker' })); });
  fireEvent.click(screen.getByRole('button', { name: 'Revoke worker' })); expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' })); expect(controller.snapshot().workers?.[0].revoked_at).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Revoke worker' }));
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Confirm revocation' }).closest('form')!); await settle(); });
  expect(screen.getByText('Revoked registration')).toBeTruthy(); expect(screen.getByText(/server confirmed revocation/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'All workers' })); await settle(); });
  expect(screen.getByRole('button', { name: 'Studio worker' })).toBeTruthy(); portal.dispose();
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
