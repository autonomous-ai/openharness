import { searchFromParams } from '@/lib/community/search';
import Feed from '../components/Feed';
type Props = { searchParams: Promise<{ q?: string | string[] }> };
export default async function FollowingPage({ searchParams }: Props) { return <Feed following initialQuery={await searchFromParams(searchParams)} />; }
