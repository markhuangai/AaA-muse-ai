import { afterEach, expect, test, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Appearance, applyTheme } from '../src/appearance';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  localStorage.clear();
  delete document.documentElement.dataset.theme;
});

test('appearance applies the saved mode and syncs a change from another tab', () => {
  applyTheme();
  expect(document.documentElement.dataset.theme).toBe('system');
  render(<Appearance />);
  fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'dark' } });
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(Object.entries(localStorage)).toEqual([['muse-portal-appearance', 'dark']]);
  applyTheme();
  expect(document.documentElement.dataset.theme).toBe('dark');
  localStorage.setItem('muse-portal-appearance', 'light');
  fireEvent(window, new StorageEvent('storage', { key: 'other' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  fireEvent(window, new StorageEvent('storage', { key: 'muse-portal-appearance' }));
  expect(document.documentElement.dataset.theme).toBe('light');
  expect((screen.getByLabelText('Appearance') as HTMLSelectElement).value).toBe('light');
});

test('a blocked preference store still permits a theme choice for this page', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('storage denied'); });
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied'); });
  applyTheme();
  expect(document.documentElement.dataset.theme).toBe('system');
  render(<Appearance />);
  fireEvent.change(screen.getByLabelText('Appearance'), { target: { value: 'dark' } });
  expect(document.documentElement.dataset.theme).toBe('dark');
});
