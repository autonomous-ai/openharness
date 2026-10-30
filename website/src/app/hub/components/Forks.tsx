'use client';
import { useEffect, useRef } from 'react';
import { FeedCard, FeedSkeleton } from './FeedCard';
import { FeedToast } from './FeedToast';
import { useFeed } from './useFeed';
import styles from '../community.module.css';

/**
 * A `#forks` link (a card's fork count) arrives before this section exists, since it is drawn once the
 * harness's counts are read: the browser's own jump has passed, so the section takes the reader there.
 */
function useRevealForksLink() {
  const section = useRef<HTMLElement>(null);
  useEffect(() => { if (window.location.hash === '#forks') section.current?.scrollIntoView({ block: 'start' }); }, []);
  return section;
}

/** The public versions people made from this harness, newest first, paged like a feed. */
export function Forks({ id, count }: { id: string; count: number }) {
  const { posts, stats, cursor, settled, error, likeError, likePrompt, dismissLike, liking, busy, more, load, like } = useFeed({ forkedFrom: id });
  const section = useRevealForksLink();
  return <section ref={section} id="forks" className={styles.forks} aria-label="Forks">
    <h2>Forks · {count}</h2>
    {error && <p className={styles.notice} role="status">The forks could not be loaded.<button onClick={() => void load()}>Retry</button></p>}
    <div className={styles.grid} aria-busy={!settled}>
      {settled ? posts.map(item => <FeedCard key={item.id} item={item} stats={stats[item.id]} liking={liking.has(item.id)} onLike={() => void like(item.id)} />) : <FeedSkeleton count={3} />}
    </div>
    <div ref={more}>{cursor && <button className={styles.more} disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'More forks'}</button>}</div>
    <FeedToast error={likeError} signIn={likePrompt} onDismiss={dismissLike} />
  </section>;
}
