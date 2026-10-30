'use client';
import type { FeedPage, FeedView } from '@/lib/community/feed';
import type { Creator } from '@/lib/community/types';
import { CreatorHead } from './CreatorHead';
import Feed from './Feed';
import { Unavailable } from './Unavailable';
import { useCreator } from './useCreator';

type Props = { id: string; initial: Creator | null; initialView: FeedView; initialPage?: FeedPage | null };

/** One creator: who they are and their harnesses, narrowed and ordered like any feed; the server's first page draws their cards at once. */
export default function CreatorPage({ id, initial, initialView, initialPage }: Props) {
  const page = useCreator(id, initial);
  if (page.unavailable) return <Unavailable what="creator" />;
  return <Feed author={id} initialView={initialView} initialPage={initialPage} intro={<CreatorHead creator={page.creator} busy={page.busy} error={page.error} signIn={page.signIn} onFollow={() => void page.follow()} onRetry={() => void page.load()} />} />;
}
