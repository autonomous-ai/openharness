// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, POST } from './route';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe('community API boundary', () => {
  it('forwards only the community path and identity headers without caching', async () => {
    vi.stubEnv('COMMUNITY_API_URL', 'http://127.0.0.1:54882');
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, data: {} })); vi.stubGlobal('fetch', fetcher);
    const response = await GET(new Request('https://harness.example/api/community/harnesses?following=true', { headers: { authorization: 'Bearer fixture', 'x-autonomous-env': 'stag', cookie: 'private=value' } }), { params: Promise.resolve({ path: ['harnesses'] }) });
    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:54882/api/community/harnesses?following=true');
    const options = fetcher.mock.calls[0][1];
    expect(options.headers.get('authorization')).toBe('Bearer fixture');
    expect(options.headers.get('x-autonomous-env')).toBe('stag');
    expect(options.headers.get('cookie')).toBeNull();
    expect(options.redirect).toBe('error'); expect(response.headers.get('cache-control')).toBe('no-store');
  });
  it('rejects arbitrary proxy destinations and oversized publications before forwarding', async () => {
    const fetcher = vi.fn(); vi.stubGlobal('fetch', fetcher);
    expect((await GET(new Request('https://harness.example/api/community/auth'), { params: Promise.resolve({ path: ['..', 'auth'] }) })).status).toBe(404);
    expect((await POST(new Request('https://harness.example/api/community/harnesses', { method: 'POST', body: 'x'.repeat(6_100_001) }), { params: Promise.resolve({ path: ['harnesses'] }) })).status).toBe(413);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('does not label bodyless deletes as JSON', async () => {
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, data: { removed: true } })); vi.stubGlobal('fetch', fetcher);
    const response = await DELETE(new Request('https://harness.example/api/community/harnesses/starter-orbit', { method: 'DELETE' }), { params: Promise.resolve({ path: ['harnesses', 'starter-orbit'] }) });
    expect(response.status).toBe(200);
    expect(fetcher.mock.calls[0][1].headers.has('content-type')).toBe(false);
    expect(fetcher.mock.calls[0][1].body).toBeUndefined();
  });
  it('serves a cover as a cacheable image, and only an image', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e', context = { params: Promise.resolve({ path: ['harnesses', id, 'cover'] }) };
    const request = new Request(`https://harness.example/api/community/harnesses/${id}/cover`, { headers: { authorization: 'Bearer fixture' } });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(new Uint8Array([137, 80]), { headers: { 'Content-Type': 'image/png' } }))
      .mockResolvedValueOnce(new Response('<svg onload=alert(1)>', { headers: { 'Content-Type': 'image/svg+xml' } }))
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 404 }));
    vi.stubGlobal('fetch', fetcher);
    const image = await GET(request, context);
    expect(image.headers.get('content-type')).toBe('image/png');
    expect(image.headers.get('cache-control')).toBe('public, max-age=86400');
    expect(new Uint8Array(await image.arrayBuffer())).toEqual(new Uint8Array([137, 80]));
    expect(fetcher.mock.calls[0][1].headers).toBeUndefined();
    expect((await GET(request, context)).status).toBe(503);
    expect((await GET(request, context)).status).toBe(404);
  });
  it('preserves backend permission errors and handles service outages', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ success: false, error: { message: 'Sign in.' } }, { status: 401 })).mockRejectedValueOnce(new Error('offline'));
    vi.stubGlobal('fetch', fetcher);
    const context = { params: Promise.resolve({ path: ['harnesses'] }) }, request = new Request('https://harness.example/api/community/harnesses');
    expect((await GET(request, context)).status).toBe(401);
    expect((await GET(request, context)).status).toBe(503);
  });
});
