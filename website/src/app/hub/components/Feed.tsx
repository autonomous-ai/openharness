'use client';
import Link from 'next/link';
import { defaultFeedView, type FeedView } from '@/lib/community/feed';
import { starterHarnesses } from '@/lib/community/starters';
import type { HarnessSummary } from '@/lib/community/types';
import { FeedCard, FeedSkeleton } from './FeedCard';
import { FeedFilters } from './FeedFilters';
import { Header, SignIn } from './Header';
import { useFeed } from './useFeed';
import { useFeedView } from './useFeedView';
import styles from '../community.module.css';

/** Starters are the website's own, so they are matched here; publications are matched by the server. */
function matches(item: HarnessSummary, { query, category }: FeedView) {
  if (category && item.category !== category) return false;
  return `${item.title} ${item.description} ${item.authorName} ${item.category} ${item.engine} ${item.harnessName || ''}`.toLowerCase().includes(query.toLowerCase());
}

function EmptyFeed({ narrowed, mine }: { narrowed: boolean; mine: boolean }) {
  if (narrowed) return <div className={styles.empty}><h1>Nothing here yet.</h1><p>Try a different search or category.</p></div>;
  if (mine) return <div className={styles.empty}><h1>Your next idea belongs here.</h1><p>Publish a harness to give someone a place to begin.</p><Link className={styles.textLink} href="/hub/publish">Publish a harness</Link></div>;
  return <div className={styles.empty}><h1>Your people. Their next ideas.</h1><p>Follow a creator from a harness page to see their work here.</p></div>;
}

type Props = { following?: boolean; mine?: boolean; initialView?: FeedView };

export default function Feed({ following = false, mine = false, initialView = defaultFeedView }: Props) {
  const search = useFeedView(initialView), { view } = search;
  const { posts, follows, stats, cursor, settled, error, likeError, signedOut, busy, liking, more, load, like } = useFeed({ following, mine, ...view });
  const narrowed = !!(view.query || view.category);
  // Starters follow the last page: drawn sooner, every page loaded while scrolling would land above
  // them. A narrowed view or a failed page shows them at once: there is nothing to scroll past.
  const starters = !settled || mine || (cursor && !narrowed && !error) ? [] : following ? starterHarnesses.filter(item => follows.includes(item.authorId)) : starterHarnesses;
  const visible = [...posts, ...starters.filter(item => matches(item, view))];
  return <><Header tab={mine ? 'yours' : following ? 'following' : 'explore'} search={{ value: search.query, onChange: search.setQuery, onClear: search.clear }} />
    <main className={`${styles.wrap} ${styles.feed}`}>
      {mine && <div className={styles.feedIntro}><h1>Your harnesses</h1><p>See what people like, join the conversation, and share your next version.</p></div>}
      <FeedFilters category={view.category} sort={view.sort} onCategory={search.setCategory} onSort={search.setSort} />
      {error && <p className={styles.notice} role="status">{error}<button onClick={() => void load()}>Retry</button></p>}
      {likeError && <p className={styles.notice} role="status">{likeError}</p>}
      {signedOut && <SignIn action={following ? 'see creators you follow' : 'join the Hub'} />}
      <div className={styles.grid} aria-busy={!settled}>
        {settled ? visible.map(item => <FeedCard key={item.id} item={item} stats={stats[item.id]} liking={liking.has(item.id)} onLike={() => void like(item.id)} />) : <FeedSkeleton />}
      </div>
      {settled && !visible.length && !busy && !signedOut && <EmptyFeed narrowed={narrowed} mine={mine} />}
      <div ref={more}>{cursor && <button className={styles.more} disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'More harnesses'}</button>}</div>
    </main></>;
}
