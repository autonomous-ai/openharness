'use client';
import { useEffect, useState } from 'react';
import { replaceAddressParams, type FeedSort, type FeedView } from '@/lib/community/feed';

const settleMs = 250;

/**
 * How the reader narrows the feed. `query` is what they are typing; the view carries the settled
 * search the feed asks the server for. The view is kept in the page's `?q=`, `?category=` and
 * `?sort=`, so it can be shared and survives a reload; clearing the search takes effect at once.
 */
export function useFeedView(initial: FeedView) {
  const [query, setQuery] = useState(initial.query), [term, setTerm] = useState(initial.query);
  const [category, setCategory] = useState(initial.category), [sort, setSort] = useState<FeedSort>(initial.sort);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), settleMs);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => replaceAddressParams({ q: term, category, sort: sort === 'newest' ? '' : sort }), [term, category, sort]);
  const clear = () => { setQuery(''); setTerm(''); };
  const view: FeedView = { query: term, category, sort };
  return { view, query, setQuery, clear, setCategory, setSort };
}
