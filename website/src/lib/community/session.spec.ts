import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshHubSession, rememberHubReturn } from './session';
const key = (name: string) => `harness.web.v1.${name}`;
let queue = Promise.resolve();
beforeEach(() => {
  queue = Promise.resolve();
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn((_name, action) => { const result = queue.then(action); queue = result.then(() => {}, () => {}); return result; }) } });
  localStorage.setItem(key('auth_access_token'), 'old'); localStorage.setItem(key('auth_refresh_token'), 'refresh');
  localStorage.setItem(key('auth_sso_client_id'), 'harness-web'); localStorage.setItem(key('auth_generation'), 'account-a');
});
afterEach(() => { localStorage.clear(); sessionStorage.clear(); vi.unstubAllGlobals(); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); });
describe('shared Harness sign-in', () => {
  it('serializes refreshes under Flutter’s lock and retains the issued client', async () => {
    const fetcher = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => Response.json({ success: true, data: { token: 'new', refreshToken: 'rotated', expiresIn: 3600 } })); vi.stubGlobal('fetch', fetcher);
    expect(await Promise.all([refreshHubSession('Bearer old'), refreshHubSession('Bearer old')])).toEqual([true, true]);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetcher.mock.calls[0][1]?.body))).toMatchObject({ clientId: 'harness-web', autonomousEnv: 'prod' });
    expect(localStorage.getItem(key('auth_refresh_token'))).toBe('rotated');
    expect(navigator.locks.request).toHaveBeenCalledWith('harness.web.v1.auth', expect.any(Function));
  });
  it('does not erase a session on a temporary authentication outage', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ success: false }, { status: 503 })));
    await expect(refreshHubSession('Bearer old')).rejects.toThrow('Could not renew');
    expect(localStorage.getItem(key('auth_refresh_token'))).toBe('refresh');
  });
  it('cannot restore an account signed out while its refresh was pending', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { localStorage.setItem(key('auth_generation'), 'signed-out'); localStorage.removeItem(key('auth_access_token')); return Response.json({ success: true, data: { token: 'stale' } }); }));
    expect(await refreshHubSession('Bearer old')).toBe(false);
    expect(localStorage.getItem(key('auth_access_token'))).toBeNull();
  });
  it('returns to the same Hub page after using the existing sign-in', () => {
    window.history.replaceState(null, '', '/hub/publish?draft=123'); rememberHubReturn();
    expect(sessionStorage.getItem('harness.hub.returnTo')).toBe('/hub/publish?draft=123');
    window.history.replaceState(null, '', '/');
  });
});
