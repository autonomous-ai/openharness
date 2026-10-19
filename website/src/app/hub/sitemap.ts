import type { MetadataRoute } from 'next';
import type { FeedPage } from '@/lib/community/feed';
import { getFeedPage } from '@/lib/community/server';
import { harnessPath } from '@/lib/community/slug';
import { starterHarnesses } from '@/lib/community/starters';

const origin = 'https://harness.autonomous.ai';
/** Read again at most hourly; a slow or failing Hub leaves out what it could not read, never the starters. */
export const revalidate = 3600;
/** Newest first, a page at a time, up to this many: past it the oldest publications wait for the next read. */
const maxPages = 40, readMs = 4000;

/** The Hub for search engines (`/hub/sitemap.xml`, named in robots.txt): Explore, every starter and publication, and their creators. */
export default async function sitemap(): Promise<MetadataRoute.Sitemap> {
  const publications: FeedPage['harnesses'] = [];
  let cursor: string | null = null;
  for (let page = 0; page < maxPages; page++) {
    const read: FeedPage | null = await getFeedPage({ sort: 'newest' }, readMs, cursor ?? undefined);
    if (!read) break;
    publications.push(...read.harnesses.filter(item => !item.example));
    cursor = read.nextCursor;
    if (!cursor) break;
  }
  const creators = [...new Set(publications.map(item => item.authorId))];
  return [
    { url: `${origin}/hub`, changeFrequency: 'hourly', priority: 1 },
    ...starterHarnesses.map(item => ({ url: `${origin}${harnessPath(item)}`, changeFrequency: 'monthly' as const, priority: 0.6 })),
    ...publications.map(item => ({ url: `${origin}${harnessPath(item)}`, lastModified: item.updatedAt ?? item.createdAt, changeFrequency: 'weekly' as const, priority: 0.8 })),
    ...creators.map(id => ({ url: `${origin}/hub/creators/${id}`, changeFrequency: 'weekly' as const, priority: 0.5 })),
  ];
}
