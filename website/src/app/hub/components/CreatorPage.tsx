'use client';
import type { FeedView } from '@/lib/community/feed';
import type { Creator } from '@/lib/community/types';
import { CreatorHead } from './CreatorHead';
import Feed from './Feed';
import { Unavailable } from './Unavailable';
import { useCreator } from './useCreator';

/** One creator: who they are and their harnesses, narrowed and ordered like any feed. */
export default function CreatorPage({ id, initial, initialView }: { id: string; initial: Creator | null; initialView: FeedView }) {
  const page = useCreator(id, initial);
  if (page.unavailable) return <Unavailable what="creator" />;
  return <Feed author={id} initialView={initialView} intro={<CreatorHead creator={page.creator} busy={page.busy} error={page.error} signIn={page.signIn} onFollow={() => void page.follow()} onRetry={() => void page.load()} />} />;
}
