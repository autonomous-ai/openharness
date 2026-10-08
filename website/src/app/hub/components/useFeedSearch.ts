'use client';
import { useEffect, useState } from 'react';

const settleMs = 250;

/**
 * What the reader is typing, and the settled term the feed asks the server for. The term is kept in
 * the page's `?q=`, so a search can be shared and survives a reload; clearing takes effect at once.
 */
export function useFeedSearch(initial = '') {
  const [query, setQuery] = useState(initial), [term, setTerm] = useState(initial);
  useEffect(() => {
    const timer = setTimeout(() => setTerm(query.trim()), settleMs);
    return () => clearTimeout(timer);
  }, [query]);
  useEffect(() => {
    const url = new URL(window.location.href);
    if (term) url.searchParams.set('q', term);
    else url.searchParams.delete('q');
    if (url.href !== window.location.href) window.history.replaceState(window.history.state, '', url);
  }, [term]);
  const clear = () => { setQuery(''); setTerm(''); };
  return { query, setQuery, term, clear };
}
