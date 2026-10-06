import type { Metadata } from 'next';
import { notFound } from 'next/navigation';
import { getStarter } from '@/lib/community/server';
import { starterHarnesses } from '@/lib/community/starters';
import Detail from '../components/Detail';
type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ comments?: string }> };
export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params, starter = starterHarnesses.find(item => item.id === id);
  return { title: starter?.title || 'Open harness', description: starter?.description };
}
export default async function HarnessPage({ params, searchParams }: Props) {
  const { id } = await params;
  if (!/^starter-[a-z-]+$/.test(id) && !/^[a-f0-9-]{36}$/.test(id)) notFound();
  const initial = await getStarter(id);
  if (id.startsWith('starter-') && !initial) notFound();
  return <Detail key={id} id={id} initial={initial} initialComments={(await searchParams).comments !== undefined} />;
}
