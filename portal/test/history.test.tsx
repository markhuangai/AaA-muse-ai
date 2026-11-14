import { afterEach, expect, test, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App } from '../src/app';
import { APIError } from '../src/api';
import { PortalController } from '../src/controller';
import { Identifier, ReplayBoundary, Requests } from '../src/history';
import { TestAPI, TestSystem, deferred, settle, worker } from './helpers';
import { detail, entry, execution, requestID, summary, workerID } from './history-fixtures';

const restores: (() => void)[] = [];
afterEach(() => { cleanup(); history.replaceState(null, '', '/'); restores.splice(0).forEach(restore => restore()); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
async function fixture() {
  const system = new TestSystem(), api = new TestAPI(system), portal = new PortalController(api, system);
  await portal.login('password'); portal.navigate('requests'); await settle();
  return { portal, api, controller: portal.history, system };
}
function dialogs() {
  for (const [name, open] of [['showModal', true], ['close', false]] as const) {
    const descriptor = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, name);
    Object.defineProperty(HTMLDialogElement.prototype, name, { configurable: true, value: function(this: HTMLDialogElement) { this.open = open; } });
    restores.push(() => { if (descriptor) Object.defineProperty(HTMLDialogElement.prototype, name, descriptor); else Reflect.deleteProperty(HTMLDialogElement.prototype, name); });
  }
}
test('request list filters and lookup use the real controller and render unsafe names as text', async () => {
  const f = await fixture(); f.api.workersWork = async () => ({ value: [worker(workerID, '<img src=x onerror=alert(1)>')], requestID: 'names' }); await f.controller.refresh();
  render(<Requests controller={f.controller} />);
  expect(document.querySelector('img')).toBeNull(); expect(screen.getByText(/Current name: <img/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Conversation ID'), { target: { value: 'owned-conversation' } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('Conversation ID').closest('form')!); await settle(); });
  expect(f.controller.snapshot().conversation).toBe('owned-conversation');
  fireEvent.change(screen.getByLabelText('Exact request ID'), { target: { value: requestID } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('Exact request ID').closest('form')!); await settle(); });
  expect(screen.getByRole('region', { name: 'Request detail' })).toBeTruthy(); expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('Input messages and client results').parentElement?.textContent).toContain('Exact input'); f.portal.dispose();
});
test('native detail keeps request-scoped instructions, accepted tools, raw events and boundary observations', async () => {
  const f = await fixture(); const value = detail();
  value.request.response_metadata = { instructions: 'Only this request', previous_response_id: 'resp_previous' };
  value.request.context_delivery_started_at = '2026-11-13T00:00:01Z'; value.request.context_delivery_written_at = '2026-11-13T00:00:02Z';
  value.request.output = { type: 'tool_call', call_id: 'client-call', name: 'read_file', arguments: { path: 'client-only.txt' } };
  value.assignment = { generation: 3, connection_generation: 4, held: true };
  f.api.detailWork = async () => ({ value, requestID: 'request-source' });
  f.api.timelineWork = async () => ({ value: { items: [entry(), { ...entry(1), kind: 'new.unknown.event', request_id: 'different', item: { source: 'server_observed', item: value.request.output }, details: { preserved: 'unknown future detail' } }, { ...entry(2), kind: 'dispatch.reassigned', time: null, request_id: null, provenance: 'unavailable', item: { item: { type: 'tool_result', call_id: 'client-call', output: 'Exact result' } } }] }, requestID: 'timeline-source' });
  await f.controller.select(requestID); render(<Requests controller={f.controller} />);
  expect(screen.getByText('Instructions for this request only').parentElement?.textContent).toContain('Only this request'); expect(screen.getByText(/calling client executes it/)).toBeTruthy();
  expect(screen.getByText('new.unknown.event')).toBeTruthy(); expect(screen.getByText(/unknown future detail/, { selector: 'pre' })).toBeTruthy(); expect(screen.getByText(/Time not recorded/)).toBeTruthy(); expect(screen.getByText(/Legacy provenance/)).toBeTruthy();
  expect(screen.getByText(/Decision accepted by the service/)).toBeTruthy(); expect(screen.getByText('request-source')).toBeTruthy(); f.portal.dispose();
});
test('legacy and unavailable states are explicit, with terminal cancellation disabled', async () => {
  const f = await fixture(); const value = { ...detail('interrupted'), kind: 'legacy' as const, assignment: null, delivery: null, provenance: 'unavailable' };
  value.request = { id: requestID, conversation_id: 'legacy-conversation', messages: [], tools: [], final_text: 'Legacy output' };
  value.execution = { ...execution('interrupted'), worker_id: null, current_job_id: '', remote_outcome: 'unknown', reason: 'lease_expired' };
  f.api.detailWork = async () => ({ value, requestID: 'legacy-source' }); f.api.timelineWork = async () => ({ value: { items: [] }, requestID: 'legacy-events' });
  await f.controller.select(requestID); render(<Requests controller={f.controller} />);
  expect(screen.getByText(/Legacy request ·/)).toBeTruthy(); expect(screen.getByText(/Legacy records do not establish/)).toBeTruthy(); expect(screen.getByText('No assignment recorded')).toBeTruthy(); expect(screen.getByText('Accepted decision / final output').parentElement?.textContent).toContain('Legacy output');
  expect((screen.getByRole('button', { name: 'Cancel request' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => { f.api.detailWork = async () => { throw new APIError('request_failed'); }; await f.controller.refresh(); });
  expect(screen.getByText(/Retained history snapshot/)).toBeTruthy(); expect(screen.getByText(/Could not load request history/)).toBeTruthy(); f.portal.dispose();
});
test('empty/loading/error list and detail frames expose bounded pagination controls', async () => {
  const f = await fixture(); f.api.requestsWork = async () => ({ value: { items: [] }, requestID: 'empty' }); await f.controller.refresh(); render(<Requests controller={f.controller} />);
  expect(screen.getByText(/No recorded requests match/)).toBeTruthy();
  f.api.requestsWork = async () => ({ value: { items: [summary()], next_cursor: 'older' }, requestID: 'pages' });
  await act(async () => { await f.controller.refresh(); fireEvent.click(screen.getByRole('button', { name: 'Next requests page' })); await settle(); });
  expect(screen.getByText(/Older request page/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Previous requests page' })); await settle(); fireEvent.click(screen.getByRole('button', { name: 'First requests page' })); });
  f.api.detailWork = async () => { throw new APIError('history_not_found', 404); };
  await act(async () => { await f.controller.select(requestID); }); expect(screen.getByText(/No request detail/)).toBeTruthy();
  f.controller.reset(); cleanup(); render(<Requests controller={f.controller} />); expect(screen.getByText(/Request history is unavailable/)).toBeTruthy(); f.portal.dispose();
  const system = new TestSystem(), api = new TestAPI(system), portal = new PortalController(api, system), pending = deferred<never>(); api.requestsWork = () => pending.promise;
  await portal.login('password'); portal.navigate('requests'); render(<Requests controller={portal.history} />); expect(screen.getByText('Loading recorded requests…')).toBeTruthy(); portal.dispose();
});
test('native confirmation issues one cancellation and back navigation preserves the list', async () => {
  dialogs(); vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { callback(0); return 1; }); const scrolling = vi.spyOn(window, 'scrollTo').mockImplementation(() => {});
  const f = await fixture(); let value = detail(); f.api.detailWork = async () => ({ value, requestID: 'detail' }); f.api.cancelWork = async () => { value = detail('cancelled'); return { value: value.execution, requestID: 'cancel' }; };
  render(<Requests controller={f.controller} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: requestID })); await settle(); });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' })); expect(screen.getByRole('dialog')).toBeTruthy(); fireEvent.click(screen.getByRole('button', { name: 'Keep request' })); expect(f.api.historyCalls.cancel).toBe(0);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' })); fireEvent(screen.getByRole('dialog'), new Event('cancel')); fireEvent(screen.getByRole('dialog', { hidden: true }), new Event('close'));
  fireEvent.click(screen.getByRole('button', { name: 'Cancel request' }));
  await act(async () => { fireEvent.submit(screen.getByRole('button', { name: 'Confirm cancellation' }).closest('form')!); await settle(); });
  expect(f.api.historyCalls.cancel).toBe(1); expect(screen.getByText(/Server recorded cancelled/)).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'All requests' })); await settle(); }); expect(scrolling).toHaveBeenCalled(); expect(screen.getByRole('region', { name: 'Recorded requests' })).toBeTruthy(); f.portal.dispose();
});
test('copy affordance preserves selectable identifiers when clipboard is unavailable', async () => {
  const copied: string[] = []; const good = render(<Identifier label="request ID" value={requestID} copy={async value => { copied.push(value); }} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy request ID' })); }); expect(copied).toEqual([requestID]); expect(screen.getByText('Copied.')).toBeTruthy(); good.unmount();
  render(<Identifier label="request ID" value={requestID} copy={async () => { throw new Error('unavailable'); }} />);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Copy request ID' })); }); expect(screen.getByText(/Copy failed/)).toBeTruthy(); expect(screen.getByText(requestID)).toBeTruthy();
});
test('boundary explanations distinguish output exposure, claim/context, safe movement and missing authority', () => {
  const value = detail(); value.request.output_started_at = '2026-11-13T00:00:00Z'; const rendered = render(<ReplayBoundary detail={value} />); expect(screen.getByText(/Output exposure/)).toBeTruthy();
  delete value.request.output_started_at; value.request.context_delivery_started_at = '2026-11-13T00:00:00Z'; rendered.rerender(<ReplayBoundary detail={value} />); expect(screen.getByText(/Context exposure/)).toBeTruthy();
  delete value.request.context_delivery_started_at; value.request.reassign_allowed = true; rendered.rerender(<ReplayBoundary detail={value} />); expect(screen.getByText(/offline-before-claim/)).toBeTruthy();
  value.request.reassign_allowed = false; rendered.rerender(<ReplayBoundary detail={value} />); expect(screen.getByText(/No safe prior/)).toBeTruthy();
});
test('same-origin shell includes Requests navigation and uses history-specific render correlation', async () => {
  const f = await fixture(); render(<App controller={f.portal} />);
  await act(async () => { fireEvent.click(screen.getByRole('link', { name: 'Requests' })); await settle(); }); expect(location.pathname).toBe('/requests');
  expect(screen.getByRole('heading', { name: 'Requests' })).toBeTruthy();
  await act(async () => { window.dispatchEvent(new Event('error')); await settle(); }); expect(f.api.reports.at(-1)?.component).toBe('history'); f.portal.dispose();
});
test('actual timeline render failure reports its own HTTP source and retains the other request panels', async () => {
  const f = await fixture(); await f.controller.select(requestID);
  const broken = { toJSON() { throw new Error('private serializer failure'); } };
  f.api.timelineWork = async () => ({ value: { items: [{ ...entry(), details: broken }] }, requestID: 'failing-timeline-source' });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  render(<Requests controller={f.controller} />);
  await act(async () => { await f.controller.refresh(); });
  expect(screen.getByRole('alert').textContent).toContain('could not be rendered');
  expect(screen.getByText('Recorded outcome')).toBeTruthy();
  expect(f.api.reports.at(-1)).toMatchObject({ event: 'portal.render_failed', query_kind: 'timeline', request_id: 'failing-timeline-source' });
  f.portal.dispose();
});
