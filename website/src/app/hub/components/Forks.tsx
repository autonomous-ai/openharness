'use client';
import { FeedCard, FeedSkeleton } from './FeedCard';
import { useFeed } from './useFeed';
import styles from '../community.module.css';

/** The public versions people made from this harness, newest first, paged like a feed. */
export function Forks({ id, count }: { id: string; count: number }) {
  const { posts, stats, cursor, settled, error, likeError, liking, busy, more, load, like } = useFeed({ forkedFrom: id });
  return <section id="forks" className={styles.forks} aria-label="Forks">
    <h2>Forks · {count}</h2>
    {error && <p className={styles.notice} role="status">The forks could not be loaded.<button onClick={() => void load()}>Retry</button></p>}
    {likeError && <p className={styles.notice} role="status">{likeError}</p>}
    <div className={styles.grid} aria-busy={!settled}>
      {settled ? posts.map(item => <FeedCard key={item.id} item={item} stats={stats[item.id]} liking={liking.has(item.id)} onLike={() => void like(item.id)} />) : <FeedSkeleton count={3} />}
    </div>
    <div ref={more}>{cursor && <button className={styles.more} disabled={busy} onClick={() => void load(cursor)}>{busy ? 'Loading…' : 'More forks'}</button>}</div>
  </section>;
}
