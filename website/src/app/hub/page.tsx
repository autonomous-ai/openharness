import { feedViewFromParams, type FeedViewParams } from '@/lib/community/feed';
import { getFeedPage, serverReadMs } from '@/lib/community/server';
import Feed from './components/Feed';
type Props = { searchParams: Promise<FeedViewParams> };
/** Explore is drawn with its first page, for search engines and a first paint with cards; a slow Hub does not hold it. */
export default async function ExplorePage({ searchParams }: Props) {
  const view = await feedViewFromParams(searchParams);
  return <Feed initialView={view} initialPage={await getFeedPage(view, serverReadMs)} />;
}
