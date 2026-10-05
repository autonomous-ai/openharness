import { afterEach, describe, expect, it, vi } from 'vitest';
import { communityRequest } from './client';

afterEach(() => { vi.unstubAllGlobals(); localStorage.clear(); });
describe('existing workspace sign-in', () => {
  it('keeps public browsing available after an access token expires', async () => {
    localStorage.setItem('harness.web.v1.auth_access_token', 'expired-fixture');
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ success: false }, { status: 401 }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { social: { signedIn: false } } }));
    vi.stubGlobal('fetch', fetcher);
    expect(await communityRequest('harnesses/starter-orbit')).toEqual({ social: { signedIn: false } });
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer expired-fixture');
    expect(fetcher.mock.calls[1][1].headers.Authorization).toBeUndefined();
  });
  it.each([['harnesses?following=true', 'GET'], ['harnesses/starter-orbit/like', 'PUT']])('never retries an authenticated action anonymously: %s', async (path, method) => {
    localStorage.setItem('harness.web.v1.auth_access_token', 'expired-fixture');
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: false, error: { message: 'Sign in again.' } }, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    await expect(communityRequest(path, { method })).rejects.toMatchObject({ status: 401 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});
