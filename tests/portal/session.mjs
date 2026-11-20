import { expect } from '@playwright/test';

export async function checkBrowserSession(page, loginResponse, remember = false) {
  expect(await loginResponse.json()).toEqual({ authenticated: true });
  const [cookie] = await page.context().cookies(new URL(page.url()).origin);
  expect(cookie).toMatchObject({ name: '__Host-muse_portal', httpOnly: true, secure: true, sameSite: 'Strict', path: '/' });
  expect(/^muse_portal_[A-Za-z0-9_-]{43}$/.test(cookie.value)).toBe(true);
  expect(cookie.domain).toBe(new URL(page.url()).hostname);
  expect(remember ? cookie.expires > Date.now() / 1000 : cookie.expires === -1).toBe(true);
  expect(await page.evaluate(() => document.cookie)).toBe('');
  return cookie;
}

export function browserSessionHeaders(cookie, origin) {
  return { Cookie: `${cookie.name}=${cookie.value}`, Origin: new URL(origin).origin, 'X-Portal-Operation-Id': 'controlled-browser-session' };
}
