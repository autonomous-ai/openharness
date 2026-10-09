import { feedViewFromParams, type FeedViewParams } from '@/lib/community/feed';
import Feed from '../components/Feed';
type Props = { searchParams: Promise<FeedViewParams> };
export default async function YoursPage({ searchParams }: Props) { return <Feed mine initialView={await feedViewFromParams(searchParams)} />; }
