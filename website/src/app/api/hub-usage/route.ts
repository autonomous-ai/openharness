import { communityApiOrigin } from '@/lib/community/server';

/**
 * The Hub's usage counts on their way to the backend (`POST /api/product-usage/hub`). The backend
 * takes them only without credentials, so they leave here with no cookie or sign-in: the sign-in a
 * browser sends is used only to leave out a reader who turned sharing off, and a preference that
 * cannot be read leaves them out too. The backend checks the counters themselves.
 */
const noContent = () => new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });

async function sharingOn(authorization: string): Promise<boolean> {
  try {
    const response = await fetch(new URL('/api/product-usage/settings', communityApiOrigin()), {
      headers: { Authorization: authorization, Accept: 'application/json' }, redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(3000),
    });
    if (!response.ok) return false;
    return (await response.json())?.data?.enabled === true;
  } catch { return false; }
}

export async function POST(request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > 4096) return new Response(null, { status: 413 });
  let report: unknown;
  try { report = JSON.parse(text); } catch { return new Response(null, { status: 400 }); }
  const authorization = request.headers.get('authorization');
  if (authorization && !await sharingOn(authorization)) return noContent();
  try {
    await fetch(new URL('/api/product-usage/hub', communityApiOrigin()), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(report),
      redirect: 'error', cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
  } catch { /* Measurement is lost, never the reader's page. */ }
  return noContent();
}
