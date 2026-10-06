import { getPublicHarness } from '@/lib/community/server';

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const harness = await getPublicHarness((await params).id);
    if (!harness) return Response.json({ error: 'Harness unavailable.' }, { status: 404 });
    return Response.json({ version: 1, harness }, { headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  } catch { return Response.json({ error: 'Please try again.' }, { status: 503 }); }
}
