'use client';
import Link from 'next/link';
import { Heart, MessageCircle } from 'lucide-react';
import { starterHarnesses } from '@/lib/community/starters';
import type { HarnessSummary } from '@/lib/community/types';
import { Header, SignIn } from './Header';
import { HarnessTags } from './HarnessTags';
import { useFeed, type Stats } from './useFeed';
import { useFeedSearch } from './useFeedSearch';
import styles from '../community.module.css';

/** One harness in the grid: its cover, introduction, tags, likes and comments. */
function FeedCard({ item, stats, onLike }: { item: HarnessSummary; stats?: Stats; onLike: () => void }) {
  return <article className={styles.card}>
    <Link href={`/hub/${item.id}`} aria-label={`Open ${item.title}`}>
      {item.cover ? <img className={styles.cover} src={item.cover} alt="" width={900} height={600} loading="lazy" /> : <div className={styles.blankCover}>{item.title}</div>}
      <h2>{item.title}</h2><p>{item.description}</p>
    </Link>
    <div className={styles.cardMeta}><small>{item.authorName}{item.example ? ' · Starter' : ''}</small><HarnessTags harness={item} /></div>
    <div className={styles.cardSocial}>
      <button className={stats?.liked ? styles.liked : ''} aria-label={`${stats?.liked ? 'Unlike' : 'Like'} ${item.title}`} aria-pressed={!!stats?.liked} onClick={onLike}><Heart />{stats?.likes || 0}</button>
      <Link href={`/hub/${item.id}?comments=1`} aria-label={`Comments on ${item.title}`}><MessageCircle />{stats?.comments || 0}</Link>
    </div>
  </article>;
}

/** Starters are the website's own, so they are matched here; publications are matched by the server. */
const matches = (item: HarnessSummary, query: string) => `${item.title} ${item.description} ${item.authorName} ${item.category} ${item.engine} ${item.harnessName || ''}`.toLowerCase().includes(query.toLowerCase());

export default function Feed({ following = false, mine = false, initialQuery = '' }: { following?: boolean; mine?: boolean; initialQuery?: string }) {
  const search = useFeedSearch(initialQuery), query = search.term;
  const { posts, follows, stats, cursor, error, likeError, signedOut, busy, more, load, like } = useFeed({ following, mine, query });
  // Starters follow the last page: drawn sooner, every page loaded while scrolling would land above
  // them. A search or a failed page shows them at once: there is nothing to scroll past.
  const starters = mine || (cursor && !query && !error) ? [] : following ? starterHarnesses.filter(item => follows.includes(item.authorId)) : starterHarnesses;
  const visible = [...posts, ...starters.filter(item => matches(item, query))];
  return <><Header tab={mine ? 'yours' : following ? 'following' : 'explore'} search={{ value: search.query, onChange: search.setQuery, onClear: search.clear }} />
    <main className={`${styles.wrap} ${styles.feed}`}>
      {mine && <div className={styles.feedIntro}><h1>Your harnesses</h1><p>See what people like, join the conversation, and share your next version.</p></div>}
      {error && <p className={styles.notice} role="status">{error}<button onClick={() => void load()}>Retry</button></p>}
      {likeError && <p className={styles.notice} role="status">{likeError}</p>}
      {signedOut && <SignIn action={following ? 'see creators you follow' : 'join the Hub'} />}
      <div className={styles.grid}>{visible.map(item => <FeedCard key={item.id} item={item} stats={stats[item.id]} onLike={() => void like(item.id)} />)}</div>
      {!visible.length && !busy && !signedOut && <div className={styles.empty}><h1>{query ? 'Nothing here yet.' : mine ? 'Your next idea belongs here.' : 'Your people. Their next ideas.'}</h1><p>{query ? 'Try a different search.' : mine ? 'Publish a harness to give someone a place to begin.' : 'Follow a creator from a harness page to see their work here.'}</p>{mine && <Link className={styles.textLink} href="/hub/publish">Publish a harness</Link>}</div>}
      <div ref={more}>{cursor && <button className={styles.more} disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'More harnesses'}</button>}</div>
    </main></>;
}
