// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from './route';

const report = { schemaVersion: 1, id: '0f8fad5b-d9cb-469f-a165-70867728950e', day: '2026-10-19', counters: { hub_like: 2 } };
const send = (headers: Record<string, string> = {}, body = JSON.stringify(report)) =>
  POST(new Request('https://harness.example/api/hub-usage', { method: 'POST', body, headers: { 'content-type': 'application/json', ...headers } }));

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe('Hub usage on its way to the backend', () => {
  it('forwards a visitor’s counts with no cookie or sign-in', async () => {
    vi.stubEnv('COMMUNITY_API_URL', 'http://127.0.0.1:54882');
    const fetcher = vi.fn(async () => Response.json({ success: true })); vi.stubGlobal('fetch', fetcher);
    expect((await send({ cookie: 'rid=campaign' })).status).toBe(204);
    const [url, init] = fetcher.mock.calls[0] as unknown as [URL, RequestInit];
    expect(String(url)).toBe('http://127.0.0.1:54882/api/product-usage/hub');
    expect(Object.keys(init.headers as Record<string, string>)).toEqual(['Content-Type']);
    expect(JSON.parse(String(init.body))).toEqual(report);
  });
  it('checks a member’s sharing first, and leaves them out when it is off or cannot be read', async () => {
    vi.stubEnv('COMMUNITY_API_URL', 'http://127.0.0.1:54882');
    const fetcher = vi.fn()
      .mockResolvedValueOnce(Response.json({ success: true, data: { enabled: true, revision: 1 } }))
      .mockResolvedValueOnce(Response.json({ success: true }))
      .mockResolvedValueOnce(Response.json({ success: true, data: { enabled: false, revision: 2 } }))
      .mockResolvedValueOnce(Response.json({ success: false }, { status: 401 }));
    vi.stubGlobal('fetch', fetcher);
    await send({ authorization: 'Bearer member' });
    expect(String(fetcher.mock.calls[0][0])).toBe('http://127.0.0.1:54882/api/product-usage/settings');
    expect(fetcher.mock.calls[0][1].headers.Authorization).toBe('Bearer member');
    expect(fetcher.mock.calls[1][1].headers).toEqual({ 'Content-Type': 'application/json' });
    await send({ authorization: 'Bearer off' });
    await send({ authorization: 'Bearer expired' });
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
  it('refuses what is not a report, and never fails the page when the Hub is down', async () => {
    const fetcher = vi.fn(async () => { throw new Error('down'); }); vi.stubGlobal('fetch', fetcher);
    expect((await send({}, 'not json')).status).toBe(400);
    expect((await send({}, 'x'.repeat(4097))).status).toBe(413);
    expect((await send()).status).toBe(204);
  });
});
