'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { communityRequest, CommunityError } from '@/lib/community/client';
import { feedPath, type FeedQuery } from '@/lib/community/feed';
import type { HarnessSummary } from '@/lib/community/types';

/** `forks` comes from a backend that counts them; an older one leaves it out. */
export type Stats = { likes: number; comments: number; liked: boolean; forks?: number };
type FeedResult = { harnesses: HarnessSummary[]; nextCursor: string | null; following: string[]; stats?: Record<string, Stats>; signedIn?: boolean };

/**
 * One feed's pages, their likes, comments and forks, and the reader's likes. Pages load as `more`
 * scrolls into view; a newer load supersedes an older one, and a sign-in, a sign-out or a new view
 * (matched by the server across every publication) reloads. `settled` turns true once the first
 * page has answered, so what is drawn under the pages waits for them instead of jumping.
 */
export function useFeed({ following, mine, forkedFrom, query, category, sort }: FeedQuery) {
  const [posts, setPosts] = useState<HarnessSummary[]>([]), [follows, setFollows] = useState<string[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({}), [signedIn, setSignedIn] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null), [settled, setSettled] = useState(false);
  const [error, setError] = useState(''), [likeError, setLikeError] = useState(''), [signedOut, setSignedOut] = useState(false), [busy, setBusy] = useState(false);
  const [liking, setLiking] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0), loading = useRef(false), pendingLikes = useRef(new Set<string>()), more = useRef<HTMLDivElement>(null);
  const load = useCallback(async (after?: string) => {
    if (after && loading.current) return;
    const requestId = ++generation.current;
    loading.current = true; setBusy(true); setError(''); setSignedOut(false);
    try {
      const result = await communityRequest<FeedResult>(feedPath({ following, mine, forkedFrom, query, category, sort }, after));
      if (requestId !== generation.current) return;
      setPosts(previous => after ? [...previous, ...result.harnesses.filter(item => !previous.some(p => p.id === item.id))] : result.harnesses);
      setStats(previous => after ? { ...previous, ...result.stats } : result.stats || {});
      setCursor(result.nextCursor); setFollows(result.following); setSignedIn(!!result.signedIn);
    } catch (e) {
      if (requestId !== generation.current) return;
      if (e instanceof CommunityError && e.status === 401) setSignedOut(true);
      else setError('Community posts are temporarily unavailable. You can still explore and fork the starter projects.');
    } finally { if (requestId === generation.current) { loading.current = false; setBusy(false); setSettled(true); } }
  }, [following, mine, forkedFrom, query, category, sort]);
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
  /** Marks a like as sent or answered: the ref stops a second click at once, the state draws it. */
  const pending = (id: string, sending: boolean) => {
    if (sending) pendingLikes.current.add(id); else pendingLikes.current.delete(id);
    setLiking(new Set(pendingLikes.current));
  };
  async function like(id: string) {
    if (!signedIn) { setSignedOut(true); return; }
    if (pendingLikes.current.has(id)) return;
    pending(id, true); setLikeError('');
    try {
      const result = await communityRequest<{ liked: boolean; likes: number }>(`harnesses/${id}/like`, { method: 'PUT', body: { liked: !stats[id]?.liked } });
      setStats(previous => ({ ...previous, [id]: { ...previous[id], comments: previous[id]?.comments || 0, ...result } }));
    } catch (e) {
      if (e instanceof CommunityError && e.status === 401) setSignedOut(true);
      // Not the feed's error: that one offers to reload the feed and pauses its paging.
      else setLikeError(e instanceof Error ? e.message : 'Could not save your like. Try again.');
    } finally { pending(id, false); }
  }
  return { posts, follows, stats, cursor, settled, error, likeError, signedOut, busy, liking, more, load, like };
}
