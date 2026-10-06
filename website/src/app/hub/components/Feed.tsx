'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Heart, MessageCircle, Search, X } from 'lucide-react';
import { starterHarnesses } from '@/lib/community/starters';
import { communityRequest, CommunityError } from '@/lib/community/client';
import type { HarnessSummary } from '@/lib/community/types';
import { Header, SignIn } from './Header';
import { HarnessTags } from './HarnessTags';
import styles from '../community.module.css';

type Stats = { likes: number; comments: number; liked: boolean };
type FeedResult = { harnesses: HarnessSummary[]; nextCursor: string | null; following: string[]; stats?: Record<string, Stats>; signedIn?: boolean };
export default function Feed({ following = false, mine = false }: { following?: boolean; mine?: boolean }) {
  const [posts, setPosts] = useState<HarnessSummary[]>([]), [follows, setFollows] = useState<string[]>([]);
  const [stats, setStats] = useState<Record<string, Stats>>({}), [signedIn, setSignedIn] = useState(false);
  const [query, setQuery] = useState(''), [search, setSearch] = useState(false), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false), [busy, setBusy] = useState(false);
  const generation = useRef(0), loading = useRef(false), pendingLikes = useRef(new Set<string>()), more = useRef<HTMLDivElement>(null);
  const load = useCallback(async (after?: string) => {
    if (after && loading.current) return;
    const requestId = ++generation.current;
    loading.current = true; setBusy(true); setError(''); setSignedOut(false);
    try {
      const params = new URLSearchParams(); if (following) params.set('following', 'true'); if (mine) params.set('mine', 'true'); if (after) params.set('cursor', after);
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
  }, [following, mine]);
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
    pendingLikes.current.add(id);
    try {
      const result = await communityRequest<{ liked: boolean; likes: number }>(`harnesses/${id}/like`, { method: 'PUT', body: { liked: !stats[id]?.liked } });
      setStats(previous => ({ ...previous, [id]: { ...previous[id], comments: previous[id]?.comments || 0, ...result } }));
    } catch (e) {
      if (e instanceof CommunityError && e.status === 401) setSignedOut(true);
      else setError(e instanceof Error ? e.message : 'Could not save your like. Try again.');
    } finally { pendingLikes.current.delete(id); }
  }
  const starters = mine ? [] : following ? starterHarnesses.filter(item => follows.includes(item.authorId)) : starterHarnesses;
  const visible = [...posts, ...starters].filter(item => `${item.title} ${item.description} ${item.authorName} ${item.category} ${item.engine} ${item.harnessName || ''}`.toLowerCase().includes(query.toLowerCase()));
  return <><Header following={following} mine={mine} onSearch={() => { setSearch(value => !value); setQuery(''); }} />
    <main className={`${styles.wrap} ${styles.feed}`}>
      {mine && <div className={styles.feedIntro}><h1>Your harnesses</h1><p>See what people like, join the conversation, and share your next version.</p></div>}
      {search && <div className={styles.search}><Search size={17} /><input autoFocus type="search" aria-label="Search harnesses" placeholder="Find a harness, creator, or idea" value={query} onChange={event => setQuery(event.target.value)} /><button className={styles.icon} aria-label="Close search" onClick={() => { setSearch(false); setQuery(''); }}><X /></button></div>}
      {error && <p className={styles.notice} role="status">{error}<button onClick={() => void load()}>Retry</button></p>}
      {signedOut && <SignIn action={following ? 'see creators you follow' : 'join the Hub'} />}
      <div className={styles.grid}>{visible.map(item => <article key={item.id} className={styles.card}>
        <Link href={`/hub/${item.id}`} aria-label={`Open ${item.title}`}>
          {item.cover ? <img className={styles.cover} src={item.cover} alt="" width={900} height={600} loading="lazy" /> : <div className={styles.blankCover}>{item.title}</div>}
          <h2>{item.title}</h2><p>{item.description}</p>
        </Link>
        <div className={styles.cardMeta}><small>{item.authorName}{item.example ? ' · Starter' : ''}</small><HarnessTags harness={item} /></div>
        <div className={styles.cardSocial}>
          <button className={stats[item.id]?.liked ? styles.liked : ''} aria-label={`${stats[item.id]?.liked ? 'Unlike' : 'Like'} ${item.title}`} aria-pressed={!!stats[item.id]?.liked} onClick={() => void like(item.id)}><Heart />{stats[item.id]?.likes || 0}</button>
          <Link href={`/hub/${item.id}?comments=1`} aria-label={`Comments on ${item.title}`}><MessageCircle />{stats[item.id]?.comments || 0}</Link>
        </div>
      </article>)}</div>
      {!visible.length && !busy && !signedOut && <div className={styles.empty}><h1>{query ? 'Nothing here yet.' : mine ? 'Your next idea belongs here.' : 'Your people. Their next ideas.'}</h1><p>{query ? 'Try a different search.' : mine ? 'Publish a harness to give someone a place to begin.' : 'Follow a creator from a harness page to see their work here.'}</p>{mine && <Link className={styles.textLink} href="/hub/publish">Publish a harness</Link>}</div>}
      <div ref={more}>{cursor && <button className={styles.more} disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'More harnesses'}</button>}</div>
    </main></>;
}
