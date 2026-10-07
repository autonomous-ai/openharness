import { communityApiOrigin } from '@/lib/community/server';

type Context = { params: Promise<{ path: string[] }> };
const allowed = /^(?:harnesses(?:\/[a-z0-9-]{1,80}(?:\/like|\/comments(?:\/[a-f0-9-]{36})?)?)?|creators\/[a-z0-9-]{1,80}\/follow)$/;

async function forward(request: Request, context: Context): Promise<Response> {
  const path = (await context.params).path.join('/');
  const sessionPath = path === 'session' && request.method === 'GET' ? 'me'
    : path === 'session/refresh' && request.method === 'POST' ? 'refresh' : null;
  if (!sessionPath && !allowed.test(path)) return Response.json({ success: false, error: { message: 'Not found.' } }, { status: 404 });
  const headers = new Headers({ Accept: 'application/json' });
  for (const key of ['authorization', 'x-autonomous-env']) {
    const value = request.headers.get(key); if (value) headers.set(key, value);
  }
  const body = ['GET', 'HEAD'].includes(request.method) ? undefined : (await request.text() || undefined);
  if (body) headers.set('Content-Type', 'application/json');
  if (body && new TextEncoder().encode(body).length > 6_100_000) return Response.json({ success: false, error: { message: 'Keep the snapshot under 6 MB.' } }, { status: 413 });
  try {
    const url = new URL(request.url), target = new URL(sessionPath ? `/api/auth/${sessionPath}` : `/api/community/${path}`, communityApiOrigin());
    target.search = url.search;
    const response = await fetch(target, { method: request.method, headers, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    const content = await response.json();
    return Response.json(content, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return Response.json({ success: false, error: { message: 'The community is temporarily unavailable. Try again.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
export const GET = forward;
export const POST = forward;
export const PUT = forward;
export const DELETE = forward;
