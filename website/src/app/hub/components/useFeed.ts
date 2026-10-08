'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { communityRequest, CommunityError } from '@/lib/community/client';
import type { HarnessSummary } from '@/lib/community/types';

export type Stats = { likes: number; comments: number; liked: boolean };
type FeedResult = { harnesses: HarnessSummary[]; nextCursor: string | null; following: string[]; stats?: Record<string, Stats>; signedIn?: boolean };

/**
 * One feed's pages, their likes and comment counts, and the reader's likes. Pages load as `more`
 * scrolls into view; a newer load supersedes an older one, and a sign-in, a sign-out or a new search
 * (`query`, matched by the server across every publication) reloads.
 */
export function useFeed({ following, mine, query }: { following: boolean; mine: boolean; query: string }) {
  const [posts, setPosts] = useState<HarnessSummary[]>([]), [follows, setFollows] = useState<string[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({}), [signedIn, setSignedIn] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(''), [likeError, setLikeError] = useState(''), [signedOut, setSignedOut] = useState(false), [busy, setBusy] = useState(false);
  const generation = useRef(0), loading = useRef(false), pendingLikes = useRef(new Set<string>()), more = useRef<HTMLDivElement>(null);
  const load = useCallback(async (after?: string) => {
    if (after && loading.current) return;
    const requestId = ++generation.current;
    loading.current = true; setBusy(true); setError(''); setSignedOut(false);
    try {
      const params = new URLSearchParams(); if (following) params.set('following', 'true'); if (mine) params.set('mine', 'true'); if (query) params.set('q', query); if (after) params.set('cursor', after);
      const result = await communityRequest<FeedResult>(`harnesses?${params}`);
      if (requestId !== generation.current) return;
      setPosts(previous => after ? [...previous, ...result.harnesses.filter(item => !previous.some(p => p.id === item.id))] : result.harnesses);
      setStats(previous => after ? { ...previous, ...result.stats } : result.stats || {});
      setCursor(result.nextCursor); setFollows(result.following); setSignedIn(!!result.signedIn);
    } catch (e) {
      if (requestId !== generation.current) return;
      if (e instanceof CommunityError && e.status === 401) setSignedOut(true);
      else setError('Community posts are temporarily unavailable. You can still explore and fork the starter projects.');
    } finally { if (requestId === generation.current) { loading.current = false; setBusy(false); } }
  }, [following, mine, query]);
  useEffect(() => {
    void load(); const reload = () => { void load(); };
    window.addEventListener('storage', reload); window.addEventListener('harness-session', reload);
    return () => { generation.current++; window.removeEventListener('storage', reload); window.removeEventListener('harness-session', reload); };
  }, [load]);
  useEffect(() => {
    if (!cursor || busy || error || !more.current || !('IntersectionObserver' in window)) return;
    const observer = new IntersectionObserver(entries => { if (entries.some(entry => entry.isIntersecting)) void load(cursor); }, { rootMargin: '500px' });
    observer.observe(more.current); return () => observer.disconnect();
  }, [cursor, busy, error, load]);
  async function like(id: string) {
    if (!signedIn) { setSignedOut(true); return; }
    if (pendingLikes.current.has(id)) return;
    pendingLikes.current.add(id); setLikeError('');
    try {
      const result = await communityRequest<{ liked: boolean; likes: number }>(`harnesses/${id}/like`, { method: 'PUT', body: { liked: !stats[id]?.liked } });
      setStats(previous => ({ ...previous, [id]: { ...previous[id], comments: previous[id]?.comments || 0, ...result } }));
    } catch (e) {
      if (e instanceof CommunityError && e.status === 401) setSignedOut(true);
      // Not the feed's error: that one offers to reload the feed and pauses its paging.
      else setLikeError(e instanceof Error ? e.message : 'Could not save your like. Try again.');
    } finally { pendingLikes.current.delete(id); }
  }
  return { posts, follows, stats, cursor, error, likeError, signedOut, busy, more, load, like };
}
