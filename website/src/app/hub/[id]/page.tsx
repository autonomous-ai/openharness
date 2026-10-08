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
 */
const readHarness = cache(async (id: string): Promise<OpenHarness | null> => {
  if (!validId(id)) return null;
  // A slow backend must not hold the page: past this, the browser loads the harness itself.
  return getPublicHarness(id, 2500).catch(() => null);
});

/** The page draws only the output; the other files reach a fork through its own routes. */
function forViewer(harness: OpenHarness): OpenHarness {
  return { ...harness, files: harness.files.filter(file => file.path === harness.viewerPath) };
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const harness = await readHarness((await params).id);
  return { title: harness?.title || 'Open harness', description: harness?.description };
}

export default async function HarnessPage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!validId(id)) notFound();
  const initial = await readHarness(id);
  if (id.startsWith('starter-') && !initial) notFound();
  return <Detail key={id} id={id} initial={initial && forViewer(initial)} initialComments={(await searchParams).comments !== undefined} />;
}
