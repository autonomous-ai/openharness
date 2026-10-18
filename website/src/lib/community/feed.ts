import { communityCategories } from './contract';
import type { HarnessSummary } from './types';

/** The longest feed search the backend accepts (`q` on GET /api/community/harnesses). */
export const searchMaxChars = 80;

/** As the backend's `feedSorts`; trending ranks this week's likes, popular every like. */
export const feedSorts = ['newest', 'trending', 'popular'] as const;
export type FeedSort = typeof feedSorts[number];

/** How a reader narrows a feed: a search, one category and an order. Kept in the page's address. */
export type FeedView = { query: string; category: string; sort: FeedSort };
export const defaultFeedView: FeedView = { query: '', category: '', sort: 'newest' };

/** A card's counts and the reader's like. `forks` comes from a backend that counts them; an older one leaves it out. */
export type Stats = { likes: number; comments: number; liked: boolean; forks?: number };

/** One page of a feed. `order` comes with a popular feed from a backend that ranks the starters too; an older one leaves it out. */
export type FeedPage = { harnesses: HarnessSummary[]; order?: string[]; nextCursor: string | null; following: string[]; stats?: Record<string, Stats>; signedIn?: boolean };

/** Which publications one feed lists: a tab's, one harness's forks or one creator's, narrowed by a view. */
export type FeedQuery = Partial<FeedView> & { following?: boolean; mine?: boolean; forkedFrom?: string; author?: string };

/** One page's request. Defaults are left out, so a backend without a filter reads the request as before. */
export function feedPath({ following, mine, forkedFrom, author, query, category, sort }: FeedQuery, after?: string): string {
  const params = new URLSearchParams();
  if (following) params.set('following', 'true');
  if (mine) params.set('mine', 'true');
  if (forkedFrom) params.set('forkedFrom', forkedFrom);
  if (author) params.set('author', author);
  if (query) params.set('q', query);
  if (category) params.set('category', category);
  if (sort && sort !== 'newest') params.set('sort', sort);
  if (after) params.set('cursor', after);
  return `harnesses?${params}`;
}

/**
 * A ranked feed's cards in the server's order: its publications and the website's starters, which a
 * popular feed ranks among them. Ids with no card here — a starter outside the view — are skipped.
 */
export function inFeedOrder(order: readonly string[], items: readonly HarnessSummary[]): HarnessSummary[] {
  const byId = new Map(items.map(item => [item.id, item]));
  return order.flatMap(id => byId.get(id) ?? []);
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
