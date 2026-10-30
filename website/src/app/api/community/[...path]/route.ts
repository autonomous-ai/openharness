import { gzipType } from '@/lib/community/gzip';
import { communityApiOrigin } from '@/lib/community/server';

type Context = { params: Promise<{ path: string[] }> };
/**
 * The backend's community routes a browser may reach (`backend/src/routes/community*.ts`); anything
 * else is answered here. A route added there needs its path here too, or the Hub's page for it fails.
 */
const allowed = new RegExp(`^(?:${[
  String.raw`harnesses(?:/[a-z0-9-]{1,80}(?:/like|/social|/comments(?:/[a-f0-9-]{36})?)?)?`,
  String.raw`creators/[a-z0-9-]{1,80}(?:/follow)?`,
  String.raw`notifications(?:/unread|/read)?`,
  String.raw`reports(?:/review)?`,
  'translate',
].join('|')})$`);
/** A translation asks the model several times over (the backend gives it 50 seconds); every other request answers within the usual wait. */
const waitMs = (path: string) => path === 'translate' ? 58_000 : 12_000;
const coverPath = /^harnesses\/[a-f0-9-]{36}\/cover$/;
const coverTypes = new Set(['image/png', 'image/jpeg', 'image/webp']);
const unavailable = () => Response.json({ success: false, error: { message: 'The community is temporarily unavailable. Try again.' } }, { status: 503, headers: { 'Cache-Control': 'no-store' } });

/** A publication never changes once published, so its cover can be cached; an unpublished one goes stale within a day. */
async function cover(path: string): Promise<Response> {
  try {
    const response = await fetch(new URL(`/api/community/${path}`, communityApiOrigin()), { redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    const type = response.headers.get('content-type') || '';
    if (response.status === 404) return new Response(null, { status: 404, headers: { 'Cache-Control': 'no-store' } });
    if (!response.ok || !coverTypes.has(type)) return unavailable();
    return new Response(await response.arrayBuffer(), { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=86400', 'X-Content-Type-Options': 'nosniff' } });
  } catch {
    return unavailable();
  }
}

async function forward(request: Request, context: Context): Promise<Response> {
  const path = (await context.params).path.join('/');
  if ((request.method === 'GET' || request.method === 'HEAD') && coverPath.test(path)) return cover(path);
  const sessionPath = path === 'session' && request.method === 'GET' ? 'me'
    : path === 'session/refresh' && request.method === 'POST' ? 'refresh' : null;
  if (!sessionPath && !allowed.test(path)) return Response.json({ success: false, error: { message: 'Not found.' } }, { status: 404 });
  const headers = new Headers({ Accept: 'application/json' });
  for (const key of ['authorization', 'x-autonomous-env']) {
    const value = request.headers.get(key); if (value) headers.set(key, value);
  }
  // Bytes, as sent: a gzipped body (lib/community/gzip.ts) stays gzipped to the backend, which unpacks it.
  const bytes = ['GET', 'HEAD'].includes(request.method) ? undefined : new Uint8Array(await request.arrayBuffer());
  const body = bytes?.length ? bytes : undefined;
  if (body) headers.set('Content-Type', request.headers.get('content-type') === gzipType ? gzipType : 'application/json');
  if (body && body.length > 6_100_000) return Response.json({ success: false, error: { message: 'Keep the snapshot under 6 MB.' } }, { status: 413 });
  try {
    const url = new URL(request.url), target = new URL(sessionPath ? `/api/auth/${sessionPath}` : `/api/community/${path}`, communityApiOrigin());
    target.search = url.search;
    const response = await fetch(target, { method: request.method, headers, body, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(waitMs(path)) });
    const content = await response.json();
    return Response.json(content, { status: response.status, headers: { 'Cache-Control': 'no-store' } });
  } catch {
    return unavailable();
  }
}
export const GET = forward;
/** A link preview's crawler may ask for a cover's headers before its bytes. */
export const HEAD = forward;
export const POST = forward;
export const PUT = forward;
export const DELETE = forward;
