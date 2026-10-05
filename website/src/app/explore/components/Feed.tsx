'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { Search, X } from 'lucide-react';
import { starterHarnesses } from '@/lib/community/starters';
import { communityRequest, CommunityError } from '@/lib/community/client';
import type { HarnessSummary } from '@/lib/community/types';
import { Header, SignIn } from './Header';
import { HarnessTags } from './HarnessTags';
import styles from '../community.module.css';

type FeedResult = { harnesses: HarnessSummary[]; nextCursor: string | null; following: string[] };
export default function Feed({ following = false }: { following?: boolean }) {
  const [posts, setPosts] = useState<HarnessSummary[]>([]), [follows, setFollows] = useState<string[]>([]);
  const [query, setQuery] = useState(''), [search, setSearch] = useState(false), [cursor, setCursor] = useState<string | null>(null);
  const [error, setError] = useState(''), [signedOut, setSignedOut] = useState(false), [busy, setBusy] = useState(false);
  const generation = useRef(0);
  const load = useCallback(async (more?: string) => {
    const requestId = ++generation.current;
    setBusy(true); setError(''); setSignedOut(false);
    try {
      const params = new URLSearchParams(); if (following) params.set('following', 'true'); if (more) params.set('cursor', more);
      const result = await communityRequest<FeedResult>(`harnesses?${params}`);
      if (requestId !== generation.current) return;
      setPosts(previous => more ? [...previous, ...result.harnesses.filter(item => !previous.some(p => p.id === item.id))] : result.harnesses);
      setCursor(result.nextCursor); setFollows(result.following);
    } catch (e) {
      if (requestId !== generation.current) return;
      if (e instanceof CommunityError && e.status === 401) setSignedOut(true);
      else setError('Community posts are temporarily unavailable. You can still explore and fork the starter projects.');
    } finally { if (requestId === generation.current) setBusy(false); }
  }, [following]);
  useEffect(() => { void load(); const reload = () => { void load(); }; window.addEventListener('focus', reload); return () => { generation.current++; window.removeEventListener('focus', reload); }; }, [load]);
  const starters = following ? starterHarnesses.filter(item => follows.includes(item.authorId)) : starterHarnesses;
  const visible = [...posts, ...starters].filter(item => `${item.title} ${item.description} ${item.authorName} ${item.category} ${item.engine} ${item.harnessName || ''}`.toLowerCase().includes(query.toLowerCase()));
  return <><Header following={following} onSearch={() => { setSearch(value => !value); setQuery(''); }} />
    <main className={`${styles.wrap} ${styles.feed}`}>
      {search && <div className={styles.search}><Search size={17} /><input autoFocus type="search" aria-label="Search harnesses" placeholder="Find a harness, creator, or idea" value={query} onChange={event => setQuery(event.target.value)} /><button className={styles.icon} aria-label="Close search" onClick={() => { setSearch(false); setQuery(''); }}><X /></button></div>}
      {error && <p className={styles.notice} role="status">{error}<button onClick={() => void load()}>Retry</button></p>}
      {signedOut && <SignIn action="see creators you follow" />}
      <div className={styles.grid}>{visible.map(item => <Link key={item.id} href={`/explore/${item.id}`} className={styles.card} aria-label={`Open ${item.title}`}>
        {item.cover ? <img className={styles.cover} src={item.cover} alt="" width={900} height={600} loading="lazy" /> : <div className={styles.blankCover}>{item.title}</div>}
        <h2>{item.title}</h2><p>{item.description}</p><div className={styles.cardMeta}><small>{item.authorName}{item.example ? ' · Starter' : ''}</small><HarnessTags harness={item} /></div>
      </Link>)}</div>
      {!visible.length && !busy && !signedOut && <div className={styles.empty}><h1>{query ? 'Nothing here yet.' : 'Your people. Their next ideas.'}</h1><p>{query ? 'Try a different search.' : 'Follow a creator from a harness page to see their work here.'}</p></div>}
      {cursor && <button className={styles.more} disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'More harnesses'}</button>}
    </main></>;
}
