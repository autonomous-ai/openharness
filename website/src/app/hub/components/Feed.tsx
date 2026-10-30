'use client';
import { useEffect, useRef, type ReactNode } from 'react';
import Link from 'next/link';
import { defaultFeedView, inFeedOrder, type FeedPage, type FeedView } from '@/lib/community/feed';
import { starterHarnesses } from '@/lib/community/starters';
import type { HarnessSummary } from '@/lib/community/types';
import { FeedCard, FeedSkeleton } from './FeedCard';
import { FeedFilters } from './FeedFilters';
import { FeedToast } from './FeedToast';
import { Header, SignIn } from './Header';
import { useFeed } from './useFeed';
import { useFeedView } from './useFeedView';
import { useHubView } from './useHubView';
import { countHub } from '@/lib/community/hubMeasure';
import styles from '../community.module.css';

/** Starters are the website's own, so they are matched here; publications are matched by the server. */
function matches(item: HarnessSummary, { query, category }: FeedView) {
  if (category && item.category !== category) return false;
  return `${item.title} ${item.description} ${item.authorName} ${item.category} ${item.engine} ${item.harnessName || ''}`.toLowerCase().includes(query.toLowerCase());
}

/** A search the reader settled on (the view's term is debounced), once each time it changes; not the one a page opened with. */
function useCountSearch(query: string) {
  const last = useRef(query);
  useEffect(() => {
    if (query === last.current) return;
    last.current = query;
    if (query) countHub('hub_feed_search');
  }, [query]);
}

function EmptyFeed({ narrowed, mine, author }: { narrowed: boolean; mine: boolean; author: boolean }) {
  if (narrowed) return <div className={styles.empty}><h1>Nothing here yet.</h1><p>Try a different search or category.</p></div>;
  if (author) return <div className={styles.empty}><h1>Nothing published here yet.</h1></div>;
  if (mine) return <div className={styles.empty}><h1>Your next idea belongs here.</h1><p>Publish a harness to give someone a place to begin.</p><Link className={styles.textLink} href="/hub/publish">Publish a harness</Link></div>;
  return <div className={styles.empty}><h1>Your people. Their next ideas.</h1><p>Follow a creator from a harness page to see their work here.</p></div>;
}

/**
 * `initialPage` is the first page of `initialView` as the server read it for a visitor (Explore, and a creator's page).
 * `author` narrows the feed to one creator's harnesses, under `intro` (their page's head).
 */
type Props = { following?: boolean; mine?: boolean; author?: string; intro?: ReactNode; initialView?: FeedView; initialPage?: FeedPage | null };

export default function Feed({ following = false, mine = false, author, intro, initialView = defaultFeedView, initialPage }: Props) {
  const search = useFeedView(initialView), { view } = search;
  useHubView(author ? 'creator' : 'feed'); useCountSearch(view.query);
  const { posts, order, follows, stats, cursor, settled, error, likeError, likePrompt, dismissLike, signedOut, busy, liking, more, load, like } = useFeed({ following, mine, author, ...view }, initialPage);
  const narrowed = !!(view.query || view.category);
  // Starters follow the last page: drawn sooner, every page loaded while scrolling would land above
  // them. A narrowed view or a failed page shows them at once: there is nothing to scroll past.
  const starters = !settled || mine || (cursor && !narrowed && !error) ? []
    : author ? starterHarnesses.filter(item => item.authorId === author)
    : following ? starterHarnesses.filter(item => follows.includes(item.authorId)) : starterHarnesses;
  // A popular feed's server ranks the starters among publications by likes, so they are drawn where it
  // put them; otherwise (or from an older backend) they follow the publications as above.
  const visible = order
    ? inFeedOrder(order, [...posts, ...starterHarnesses.filter(item => matches(item, view))])
    : [...posts, ...starters.filter(item => matches(item, view))];
  return <><Header tab={mine ? 'yours' : following ? 'following' : 'explore'} search={{ value: search.query, onChange: search.setQuery, onClear: search.clear }} />
    <main className={`${styles.wrap} ${styles.feed}`}>
      {mine && <div className={styles.feedIntro}><h1>Your harnesses</h1><p>See what people like, join the conversation, and share your next version.</p></div>}
      {intro}
      <FeedFilters category={view.category} sort={view.sort} onCategory={category => { if (category) countHub('hub_feed_category'); search.setCategory(category); }} onSort={sort => { countHub(`hub_feed_sort_${sort}`); search.setSort(sort); }} />
      {error && <p className={styles.notice} role="status">{error}<button onClick={() => void load()}>Retry</button></p>}
      {signedOut && <SignIn action={following ? 'see creators you follow' : 'join the Hub'} />}
      <div className={styles.grid} aria-busy={!settled}>
        {settled ? visible.map(item => <FeedCard key={item.id} item={item} stats={stats[item.id]} liking={liking.has(item.id)} onLike={() => void like(item.id)} />) : <FeedSkeleton />}
      </div>
      {settled && !visible.length && !busy && !signedOut && <EmptyFeed narrowed={narrowed} mine={mine} author={!!author} />}
      <div ref={more}>{cursor && <button className={styles.more} disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'More harnesses'}</button>}</div>
      <FeedToast error={likeError} signIn={likePrompt} onDismiss={dismissLike} />
    </main></>;
}
