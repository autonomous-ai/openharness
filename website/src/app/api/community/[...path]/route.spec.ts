// @vitest-environment node
import { gzipSync } from 'node:zlib';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DELETE, GET, HEAD, POST } from './route';

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
  it('forwards a translation with the longer wait it needs', async () => {
    vi.stubEnv('COMMUNITY_API_URL', 'http://127.0.0.1:54882');
    const timeout = vi.spyOn(AbortSignal, 'timeout');
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, data: {} })); vi.stubGlobal('fetch', fetcher);
    await POST(new Request('https://harness.example/api/community/translate', { method: 'POST', body: '{"title":"Tiêu đề"}' }), { params: Promise.resolve({ path: ['translate'] }) });
    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:54882/api/community/translate');
    expect(timeout).toHaveBeenCalledWith(58_000);
    expect((await POST(new Request('https://harness.example/api/community/translate/x', { method: 'POST' }), { params: Promise.resolve({ path: ['translate', 'x'] }) })).status).toBe(404);
    timeout.mockRestore();
  });
  it('forwards a gzipped body byte for byte, still gzipped', async () => {
    vi.stubEnv('COMMUNITY_API_URL', 'http://127.0.0.1:54882');
    const fetcher = vi.fn().mockResolvedValue(Response.json({ success: true, data: { id: 'x' } }, { status: 201 })); vi.stubGlobal('fetch', fetcher);
    const gzipped = gzipSync(JSON.stringify({ files: [{ path: 'index.html', content: '<script>go()</script>' }] }));
    const response = await POST(new Request('https://harness.example/api/community/harnesses', { method: 'POST', body: gzipped, headers: { 'content-type': 'application/gzip' } }), { params: Promise.resolve({ path: ['harnesses'] }) });
    expect(response.status).toBe(201);
    const options = fetcher.mock.calls[0][1];
    expect(options.headers.get('content-type')).toBe('application/gzip');
    expect(Buffer.from(options.body).equals(gzipped)).toBe(true);
  });
  it('forwards every route the Hub calls: notifications, reports, a creator and the rest', async () => {
    vi.stubEnv('COMMUNITY_API_URL', 'http://127.0.0.1:54882');
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ success: true, data: {} })); vi.stubGlobal('fetch', fetcher);
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    const paths = ['harnesses', `harnesses/${id}`, 'harnesses/pac-man-neon-maze-chase-0f8fad5b', `harnesses/${id}/like`, `harnesses/${id}/social`, `harnesses/${id}/comments`, `harnesses/${id}/comments/${id}`,
      'creators/alice', 'creators/alice/follow', 'notifications', 'notifications/unread', 'notifications/read', 'reports', 'reports/review', 'translate'];
    for (const path of paths) {
      const response = await GET(new Request(`https://harness.example/api/community/${path}`), { params: Promise.resolve({ path: path.split('/') }) });
      expect(response.status, path).toBe(200);
    }
    expect(fetcher).toHaveBeenCalledTimes(paths.length);
    for (const path of ['notifications/all', 'reports/x', 'creators/alice/followers']) {
      expect((await GET(new Request(`https://harness.example/api/community/${path}`), { params: Promise.resolve({ path: path.split('/') }) })).status, path).toBe(404);
    }
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
  it('answers a link preview’s HEAD for a cover as the image it is', async () => {
    const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(new Uint8Array([137, 80]), { headers: { 'Content-Type': 'image/png' } })));
    const response = await HEAD(new Request(`https://harness.example/api/community/harnesses/${id}/cover`, { method: 'HEAD' }), { params: Promise.resolve({ path: ['harnesses', id, 'cover'] }) });
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');
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
