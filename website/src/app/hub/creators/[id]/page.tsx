import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { feedViewFromParams, type FeedViewParams } from '@/lib/community/feed';
import { getCreator, getFeedPage, serverReadMs } from '@/lib/community/server';
import CreatorPage from '../../components/CreatorPage';
type Props = { params: Promise<{ id: string }>; searchParams: Promise<FeedViewParams> };

const validId = (id: string) => /^[a-z0-9-]{1,80}$/.test(id);

/** Read once per request, for the metadata and the page; a slow Hub leaves it to the browser. */
const readCreator = cache(async (id: string) => validId(id) ? getCreator(id, serverReadMs) : null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const id = (await params).id, creator = await readCreator(id);
  // Not read here (no publications, or a slow Hub): nothing for a search engine to keep.
  if (!creator) return { title: 'Creator', robots: { index: false } };
  const title = creator.name, description = `What ${creator.name} made with agents, on Harness Hub: like it, join the conversation, and fork your own version.`;
  return { title, description, alternates: { canonical: `/hub/creators/${id}` }, openGraph: { type: 'profile', title, description, url: `/hub/creators/${id}`, siteName: 'Harness Hub' }, twitter: { card: 'summary', title, description } };
}

export default async function CreatorRoute({ params, searchParams }: Props) {
  const { id } = await params;
  if (!validId(id)) notFound();
  const view = await feedViewFromParams(searchParams);
  const [initial, initialPage] = await Promise.all([readCreator(id), getFeedPage({ ...view, author: id }, serverReadMs)]);
  return <CreatorPage key={id} id={id} initial={initial} initialView={view} initialPage={initialPage} />;
}
