import { searchFromParams } from '@/lib/community/search';
import Feed from '../components/Feed';
type Props = { searchParams: Promise<{ q?: string | string[] }> };
export default async function YoursPage({ searchParams }: Props) { return <Feed mine initialQuery={await searchFromParams(searchParams)} />; }
