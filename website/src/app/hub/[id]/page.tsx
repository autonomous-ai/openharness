import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { getPublicHarness } from '@/lib/community/server';
import type { OpenHarness } from '@/lib/community/types';
import Detail from '../components/Detail';
type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ comments?: string }> };

const validId = (id: string) => /^starter-[a-z-]+$/.test(id) || /^[a-f0-9-]{36}$/.test(id);

/**
 * Read once per request, for the metadata and the page. The server asks as a production reader, so a
 * staging publication (or an outage) comes back null and the page loads it in the browser instead.
 * The page draws only the output; the other files reach a fork through its own routes.
 */
const readHarness = cache(async (id: string): Promise<OpenHarness | null> => {
  if (!validId(id)) return null;
  // A slow backend must not hold the page: past this, the browser loads the harness itself.
  return getPublicHarness(id, { timeoutMs: 2500, viewerOnly: true }).catch(() => null);
});

/** A link preview's image: link unfurlers read raster covers, not a starter's SVG. */
const shareImage = (harness: OpenHarness) => harness.cover && !harness.cover.endsWith('.svg') ? harness.cover : undefined;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const harness = await readHarness((await params).id);
  if (!harness) return { title: 'Open harness' };
  const image = shareImage(harness), title = harness.title, description = harness.description;
  return {
    title, description,
    openGraph: { type: 'article', title, description, authors: [harness.authorName], ...(image ? { images: [{ url: image, width: 900, height: 600 }] } : {}) },
    twitter: { card: image ? 'summary_large_image' : 'summary', title, description },
  };
}

export default async function HarnessPage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!validId(id)) notFound();
  const initial = await readHarness(id);
  if (id.startsWith('starter-') && !initial) notFound();
  return <Detail key={id} id={id} initial={initial} initialComments={(await searchParams).comments !== undefined} />;
}
