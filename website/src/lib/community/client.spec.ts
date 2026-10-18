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
describe('request bodies', () => {
  it('sends a body as gzip, so what people made never reaches the edge as raw HTML', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, data: { id: 'x' } }));
    vi.stubGlobal('fetch', fetcher);
    const body = { files: [{ path: 'index.html', content: '<script>go()</script>' }] };
    await communityRequest('harnesses', { method: 'POST', body });
    const sent = fetcher.mock.calls[0][1];
    expect(sent.headers['Content-Type']).toBe('application/gzip');
    const unpacked = new Response(sent.body as Uint8Array<ArrayBuffer>).body!.pipeThrough(new DecompressionStream('gzip'));
    expect(JSON.parse(await new Response(unpacked).text())).toEqual(body);
  });
});

it('says the community is unavailable when a proxy answers with an HTML error page', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('<html>502 Bad Gateway</html>', { status: 502, headers: { 'Content-Type': 'text/html' } })));
  await expect(communityRequest('harnesses')).rejects.toMatchObject({ status: 502, message: 'The community is temporarily unavailable. Try again.' });
});
