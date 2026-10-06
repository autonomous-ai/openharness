import { getPublicHarness } from '@/lib/community/server';
import { forkFiles, zipFiles } from '@/lib/community/bundle';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }): Promise<Response> {
  try {
    const { id } = await context.params, harness = await getPublicHarness(id);
    if (!harness) return new Response('Harness not found.', { status: 404 });
    const zip = zipFiles(forkFiles(harness));
    return new Response(new Blob([zip as Uint8Array<ArrayBuffer>]), { headers: {
      'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="harness-${harness.id}.zip"`,
      'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff',
    } });
  } catch { return new Response('The project could not be downloaded. Please try again.', { status: 503 }); }
}
