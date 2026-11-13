import { afterEach, expect, test } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { App, Configuration, Login, RenderBoundary } from '../src/app';
import { APIError } from '../src/api';
import { PortalController } from '../src/controller';
import { TestAPI, TestSystem, settings, settle } from './helpers';

afterEach(cleanup);
const fixture = () => { const system = new TestSystem(); const api = new TestAPI(system); const controller = new PortalController(api, system); return { api, system, controller }; };

test('actual React login clears the password, renders text-safe settings and signs out', async () => {
  const { controller, api } = fixture();
  api.settingsWork = async () => ({ value: { ...settings(), effective_yaml: 'name: "<img src=x onerror=alert(1)>"\n', build: { revision: 'development', dirty: true } }, requestID: 'render-request' });
  render(<App controller={controller} />);
  const input = screen.getByLabelText('Portal password') as HTMLInputElement;
  expect((screen.getByRole('button', { name: 'Sign in' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.change(input, { target: { value: 'private-password' } });
  await act(async () => { fireEvent.submit(input.closest('form')!); await settle(); });
  expect(input.value).toBe('');
  expect(screen.getByRole('heading', { name: 'Service settings' })).toBeTruthy();
  expect(screen.getByLabelText('Redacted effective YAML').textContent).toContain('<img src=x');
  expect(document.querySelector('img')).toBeNull();
  expect(screen.getByText('· working changes')).toBeTruthy();
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await settle(); });
  expect(api.settingsCalls).toBe(2);
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Sign out' })); await settle(); });
  expect(screen.getByRole('heading', { name: 'Service access' })).toBeTruthy();
  expect(screen.getByText('Signed out.')).toBeTruthy(); controller.dispose();
});

test('login failure and initial settings outage retain controls and show correlation', async () => {
  const { controller, api } = fixture(); api.loginWork = async () => { throw new APIError('unauthorized', 401, 'login-request'); };
  render(<App controller={controller} />);
  fireEvent.change(screen.getByLabelText('Portal password'), { target: { value: 'wrong-password' } });
  await act(async () => { fireEvent.submit(screen.getByLabelText('Portal password').closest('form')!); await settle(); });
  expect(screen.getByText('Password not accepted. Try again.')).toBeTruthy();
  expect(screen.getByText('login-request')).toBeTruthy();
  api.loginWork = async () => ({ session_token: 'muse_portal_'+'a'.repeat(43), expires_at: '2026-11-13T00:30:00Z' });
  api.settingsWork = async () => { throw new APIError('service_unavailable', 503, 'failed-settings'); };
  await act(async () => { await controller.login('password'); });
  expect(screen.getByText('No successful refresh yet')).toBeTruthy();
  expect(screen.getByText('Configuration is unavailable. Use Refresh to retry.')).toBeTruthy();
  expect(screen.getByText('failed-settings')).toBeTruthy();
  expect(screen.getByText('Stale snapshot')).toBeTruthy();
  api.settingsWork = async () => ({ value: { ...settings(), ready: false }, requestID: 'recovered-request' });
  await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Refresh' })); await settle(); });
  expect(screen.getByText('Database unavailable')).toBeTruthy(); controller.dispose();
});

test('loading states render the final layout and window failures report only safe metadata', async () => {
  const { controller, api } = fixture();
  const view = { ...controller.snapshot(), phase: 'authenticated' as const, loading: true };
  const result = render(<Configuration controller={controller} view={view} />);
  expect(screen.getByText('Loading effective configuration…')).toBeTruthy();
  expect(screen.getByText('Waiting for service details.')).toBeTruthy();
  expect((screen.getByRole('button', { name: 'Refreshing…' }) as HTMLButtonElement).disabled).toBe(true);
  result.unmount();
  render(<Login controller={controller} view={{ ...controller.snapshot(), phase: 'signing_in' }} />);
  expect(screen.getByRole('button', { name: 'Signing in…' })).toBeTruthy(); cleanup();
  await controller.login('password'); render(<App controller={controller} />);
  window.dispatchEvent(new ErrorEvent('error', { message: 'untrusted-browser-message' }));
  window.dispatchEvent(new Event('unhandledrejection')); await settle();
  expect(api.reports.filter(value => value.event === 'portal.render_failed')).toHaveLength(2);
  expect(JSON.stringify(api.reports).includes('untrusted-browser-message')).toBe(false);
  controller.dispose();
});

test('the actual error boundary reports the failure and offers reload', async () => {
  const { controller, api } = fixture(); await controller.login('password');
  let reloads = 0;
  function Failure(): never { throw new Error('controlled-render-failure'); }
  render(<RenderBoundary controller={controller} reload={() => { reloads++; }}><Failure /></RenderBoundary>);
  expect(screen.getByRole('heading', { name: 'Portal view could not be rendered' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Reload and sign in' })); await settle();
  expect(reloads).toBe(1); expect(api.reports.at(-1)?.cause).toBe('render_exception'); controller.dispose();
});
