import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound, permanentRedirect } from 'next/navigation';
import { getPublicHarness, serverReadMs } from '@/lib/community/server';
import { harnessPath, harnessSlug, isHarnessAddress, namesPublication } from '@/lib/community/slug';
import type { OpenHarness } from '@/lib/community/types';
import Detail from '../components/Detail';
type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ comments?: string }> };

/**
 * Read once per request, for the metadata and the page. The server asks as a production reader, so a
 * staging publication (or an outage) comes back null and the page loads it in the browser instead.
 * The page draws only the output; the other files reach a fork through its own routes.
 */
const readHarness = cache(async (id: string): Promise<OpenHarness | null> => {
  if (!isHarnessAddress(id)) return null;
  // A slow backend must not hold the page: past this, the browser loads the harness itself.
  return getPublicHarness(id, { timeoutMs: serverReadMs, viewerOnly: true }).catch(() => null);
});

/** A link preview's image: link unfurlers read raster covers, not a starter's SVG. */
const shareImage = (harness: OpenHarness) => harness.cover && !harness.cover.endsWith('.svg') ? harness.cover : undefined;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const harness = await readHarness((await params).id);
  // Not read here (unpublished, a staging publication, or a slow Hub): nothing for a search engine to keep.
  if (!harness) return { title: 'Open harness', robots: { index: false } };
  const image = shareImage(harness), title = harness.title, description = harness.description;
  return {
    title, description, alternates: { canonical: harnessPath(harness) },
    openGraph: { type: 'article', title, description, url: harnessPath(harness), siteName: 'Harness Hub', authors: [harness.authorName], ...(image ? { images: [{ url: image, width: 900, height: 600 }] } : {}) },
    twitter: { card: image ? 'summary_large_image' : 'summary', title, description },
  };
}

export default async function HarnessPage({ params, searchParams }: Props) {
  const { id } = await params, comments = (await searchParams).comments !== undefined;
  if (!isHarnessAddress(id)) notFound();
  const initial = await readHarness(id);
  // A starter is on disk, so only a publication can be missing here for now: the browser reads that one itself.
  if (!initial && !namesPublication(id)) notFound();
  // An id, or a slug from before its title was edited, moves to the address it has now.
  if (initial && id !== harnessSlug(initial)) permanentRedirect(`${harnessPath(initial)}${comments ? '?comments=1' : ''}`);
  return <Detail key={id} id={id} initial={initial} initialComments={comments} />;
}
