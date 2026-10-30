'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { communityRequest, CommunityError, sessionHeaders } from '@/lib/community/client';
import { feedPath, type FeedPage, type FeedQuery, type Stats } from '@/lib/community/feed';
import { onSessionChange } from '@/lib/community/session';
import { putLike } from '@/lib/community/social';
import type { HarnessSummary } from '@/lib/community/types';
import { countHub } from '@/lib/community/hubMeasure';


/**
 * One feed's pages, their likes, comments and forks, and the reader's likes. Pages load as `more`
 * scrolls into view; a newer load supersedes an older one, and a sign-in, a sign-out or a new view
 * (matched by the server across every publication) reloads. `settled` turns true once the first
 * page has answered, so what is drawn under the pages waits for them instead of jumping.
 * `initial` is that page as the server read it for a visitor: drawn at once, then read again here
 * with the reader's sign-in, which is only in this browser.
 */
export function useFeed({ following, mine, forkedFrom, author, query, category, sort }: FeedQuery, initial?: FeedPage | null) {
  const [posts, setPosts] = useState<HarnessSummary[]>(initial?.harnesses ?? []), [follows, setFollows] = useState<string[]>(initial?.following ?? []);
  const [stats, setStats] = useState<Record<string, Stats>>(initial?.stats ?? {}), [signedIn, setSignedIn] = useState(false);
  const [cursor, setCursor] = useState<string | null>(initial?.nextCursor ?? null), [settled, setSettled] = useState(!!initial);
  const [order, setOrder] = useState<string[] | null>(initial?.order ?? null);
  const [error, setError] = useState(''), [likeError, setLikeError] = useState(''), [signedOut, setSignedOut] = useState(false), [busy, setBusy] = useState(false);
  // A like that needs an account: said where the reader is (FeedToast), not as the feed's own sign-in.
  const [likePrompt, setLikePrompt] = useState(false);
  const [liking, setLiking] = useState<ReadonlySet<string>>(new Set());
  const generation = useRef(0), loading = useRef(false), pendingLikes = useRef(new Set<string>()), more = useRef<HTMLDivElement>(null);
  const load = useCallback(async (after?: string) => {
    if (after && loading.current) return;
    if (after) countHub('hub_feed_more');
    const requestId = ++generation.current;
    loading.current = true; setBusy(true); setError(''); setSignedOut(false);
    try {
      const result = await communityRequest<FeedPage>(feedPath({ following, mine, forkedFrom, author, query, category, sort }, after));
      if (requestId !== generation.current) return;
      setPosts(previous => after ? [...previous, ...result.harnesses.filter(item => !previous.some(p => p.id === item.id))] : result.harnesses);
      setStats(previous => after ? { ...previous, ...result.stats } : result.stats || {});
      setOrder(previous => !result.order ? null : after && previous ? [...previous, ...result.order.filter(id => !previous.includes(id))] : result.order);
      setCursor(result.nextCursor); setFollows(result.following); setSignedIn(!!result.signedIn);
    } catch (e) {
      if (requestId !== generation.current) return;
      if (e instanceof CommunityError && e.status === 401) setSignedOut(true);
      else setError('Community posts are temporarily unavailable. You can still explore and fork the starter projects.');
    } finally { if (requestId === generation.current) { loading.current = false; setBusy(false); setSettled(true); } }
  }, [following, mine, forkedFrom, author, query, category, sort]);
  useEffect(() => {
    void load();
    const stop = onSessionChange(() => { void load(); });
    return () => { generation.current++; stop(); };
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
    // Before the first page answers the feed cannot say who is reading: a browser holding a sign-in tries, and the Hub decides.
    if (!signedIn && !sessionHeaders().Authorization) { setLikePrompt(true); return; }
    if (pendingLikes.current.has(id)) return;
    countHub('hub_like');
    pending(id, true); setLikeError(''); setLikePrompt(false);
    try {
      const result = await putLike(id, !stats[id]?.liked);
      setStats(previous => ({ ...previous, [id]: { ...previous[id], comments: previous[id]?.comments || 0, ...result } }));
    } catch (e) {
      if (e instanceof CommunityError && e.status === 401) setLikePrompt(true);
      // Not the feed's error: that one offers to reload the feed and pauses its paging.
      else setLikeError(e instanceof Error ? e.message : 'Could not save your like. Try again.');
    } finally { pending(id, false); }
  }
  const dismissLike = useCallback(() => { setLikeError(''); setLikePrompt(false); }, []);
  return { posts, order, follows, stats, cursor, settled, error, likeError, likePrompt, dismissLike, signedOut, busy, liking, more, load, like };
}
