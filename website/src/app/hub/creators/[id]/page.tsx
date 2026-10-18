import type { Metadata } from 'next';
import { cache } from 'react';
import { notFound } from 'next/navigation';
import { feedViewFromParams, type FeedViewParams } from '@/lib/community/feed';
import { getCreator, serverReadMs } from '@/lib/community/server';
import CreatorPage from '../../components/CreatorPage';
type Props = { params: Promise<{ id: string }>; searchParams: Promise<FeedViewParams> };

const validId = (id: string) => /^[a-z0-9-]{1,80}$/.test(id);

/** Read once per request, for the metadata and the page; a slow Hub leaves it to the browser. */
const readCreator = cache(async (id: string) => validId(id) ? getCreator(id, serverReadMs) : null);

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const creator = await readCreator((await params).id);
  return { title: creator?.name ?? 'Creator' };
}

export default async function CreatorRoute({ params, searchParams }: Props) {
  const { id } = await params;
  if (!validId(id)) notFound();
  return <CreatorPage key={id} id={id} initial={await readCreator(id)} initialView={await feedViewFromParams(searchParams)} />;
}
