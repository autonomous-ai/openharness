// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { POST } from './route';
const draft = { version: 1, title: '</script><script>alert(1)</script>', files: [{ path: 'preview.html', content: '<h1>Hello</h1>' }], viewerPath: 'preview.html', conversation: [{ role: 'user', text: 'A reviewed brief.' }] };
const request = (value: unknown) => { const body = new FormData(); body.set('draft', JSON.stringify(value)); return new Request('http://localhost/hub/import', { method: 'POST', body }); };
describe('private desktop draft handoff', () => {
  it('stores an escaped browser draft before review, without publishing or tokens', async () => {
    const response = await POST(request(draft)), html = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(response.headers.get('content-security-policy')).toContain("frame-ancestors 'none'");
    expect(html).toContain('indexedDB.open');
    expect(html).toContain('/hub/publish?draft=');
    expect(html).not.toContain('</script><script>alert');
    expect(html).not.toContain('/api/community/harnesses');
    expect(html).not.toContain('auth_access_token');
  });
  it('rejects malformed metadata and previews before saving them', async () => {
    expect((await POST(request({ ...draft, title: { invalid: true } }))).status).toBe(400);
    expect((await POST(request({ ...draft, viewerPath: 'missing.html' }))).status).toBe(400);
    expect((await POST(request({ ...draft, files: [null] }))).status).toBe(400);
  });
  it('bounds streamed input even without a content-length header', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(7_000_001)); controller.close(); } });
    const incoming = new Request('http://localhost/hub/import', { method: 'POST', body, duplex: 'half' } as RequestInit);
    expect((await POST(incoming)).status).toBe(413);
  });
});
