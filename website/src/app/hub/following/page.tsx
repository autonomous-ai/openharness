import { feedViewFromParams, type FeedViewParams } from '@/lib/community/feed';
import Feed from '../components/Feed';
type Props = { searchParams: Promise<FeedViewParams> };
export default async function FollowingPage({ searchParams }: Props) { return <Feed following initialView={await feedViewFromParams(searchParams)} />; }
