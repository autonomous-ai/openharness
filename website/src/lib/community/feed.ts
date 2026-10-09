import { communityCategories } from './contract';

/** The longest feed search the backend accepts (`q` on GET /api/community/harnesses). */
export const searchMaxChars = 80;

export const feedSorts = ['newest', 'popular'] as const;
export type FeedSort = typeof feedSorts[number];

/** How a reader narrows a feed: a search, one category and an order. Kept in the page's address. */
export type FeedView = { query: string; category: string; sort: FeedSort };
export const defaultFeedView: FeedView = { query: '', category: '', sort: 'newest' };

/** Which publications one feed lists: a tab's, or one harness's forks, narrowed by a view. */
export type FeedQuery = Partial<FeedView> & { following?: boolean; mine?: boolean; forkedFrom?: string };

/** One page's request. Defaults are left out, so a backend without a filter reads the request as before. */
export function feedPath({ following, mine, forkedFrom, query, category, sort }: FeedQuery, after?: string): string {
  const params = new URLSearchParams();
  if (following) params.set('following', 'true');
  if (mine) params.set('mine', 'true');
  if (forkedFrom) params.set('forkedFrom', forkedFrom);
  if (query) params.set('q', query);
  if (category) params.set('category', category);
  if (sort && sort !== 'newest') params.set('sort', sort);
  if (after) params.set('cursor', after);
  return `harnesses?${params}`;
}

export type FeedViewParams = { q?: string | string[]; category?: string | string[]; sort?: string | string[] };
const single = (value?: string | string[]) => typeof value === 'string' ? value.trim() : '';

/** The view a page was opened with, from `?q=`, `?category=` and `?sort=`; anything unknown is dropped. */
export async function feedViewFromParams(searchParams: Promise<FeedViewParams>): Promise<FeedView> {
  const { q, category, sort } = await searchParams;
  return {
    query: single(q).slice(0, searchMaxChars),
    category: communityCategories.includes(single(category)) ? single(category) : '',
    sort: feedSorts.find(value => value === single(sort)) ?? 'newest',
  };
}

/** Writes these parameters into the address without a navigation; an empty value removes one. */
export function replaceAddressParams(values: Record<string, string>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value) url.searchParams.set(key, value);
    else url.searchParams.delete(key);
  }
  if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
}
