import { feedViewFromParams, type FeedViewParams } from '@/lib/community/feed';
import Feed from './components/Feed';
type Props = { searchParams: Promise<FeedViewParams> };
export default async function ExplorePage({ searchParams }: Props) { return <Feed initialView={await feedViewFromParams(searchParams)} />; }
