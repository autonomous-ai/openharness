import { searchFromParams } from '@/lib/community/search';
import Feed from './components/Feed';
type Props = { searchParams: Promise<{ q?: string | string[] }> };
export default async function ExplorePage({ searchParams }: Props) { return <Feed initialQuery={await searchFromParams(searchParams)} />; }
