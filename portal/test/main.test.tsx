import { act } from '@testing-library/react';
import { expect, test } from 'vitest';
import { TestAPI, TestSystem } from './helpers';
import { PortalController } from '../src/controller';

test('the production entrypoint mounts the real app and disposes the injected controller', async () => {
  const entry = await import('../src/main');
  const element = document.createElement('div'); document.body.append(element);
  const system = new TestSystem(); const api = new TestAPI(system); const controller = new PortalController(api, system);
  let stop = () => {};
  await act(async () => { stop = entry.mount(element, controller); });
  expect(element.textContent).toContain('Service access');
  await act(async () => { await controller.login('password'); });
  expect(element.textContent).toContain('Service settings');
  await act(async () => { stop(); });
  expect(element.childNodes).toHaveLength(0); expect(api.credential).toBeNull(); element.remove();
  const other = document.createElement('div'); document.body.append(other);
  await act(async () => { stop = entry.mount(other); });
  expect(other.textContent).toContain('Service access'); await act(async () => { stop(); }); other.remove();
});
