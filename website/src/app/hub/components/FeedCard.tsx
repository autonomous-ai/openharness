'use client';
import Link from 'next/link';
import { GitFork, Heart, MessageCircle } from 'lucide-react';
import type { HarnessSummary } from '@/lib/community/types';
import { HarnessTags } from './HarnessTags';
import type { Stats } from './useFeed';
import styles from '../community.module.css';

type Props = { item: HarnessSummary; stats?: Stats; liking: boolean; onLike: () => void };

/** One harness in a grid: its cover, introduction, tags, likes, comments and, once it has some, forks. */
export function FeedCard({ item, stats, liking, onLike }: Props) {
  return <article className={styles.card}>
    <Link href={`/hub/${item.id}`} aria-label={`Open ${item.title}`}>
      {item.cover ? <img className={styles.cover} src={item.cover} alt="" width={900} height={600} loading="lazy" /> : <div className={styles.blankCover}>{item.title}</div>}
      <h2>{item.title}</h2><p>{item.description}</p>
    </Link>
    <div className={styles.cardMeta}><small>{item.authorName}{item.example ? ' · Starter' : ''}</small><HarnessTags harness={item} /></div>
    <div className={styles.cardSocial}>
      <button className={stats?.liked ? styles.liked : ''} aria-label={`${stats?.liked ? 'Unlike' : 'Like'} ${item.title}`} aria-pressed={!!stats?.liked} aria-busy={liking} disabled={liking} onClick={onLike}><Heart />{stats?.likes || 0}</button>
      <Link href={`/hub/${item.id}?comments=1`} aria-label={`Comments on ${item.title}`}><MessageCircle />{stats?.comments || 0}</Link>
      {!!stats?.forks && <Link href={`/hub/${item.id}#forks`} aria-label={`Forks of ${item.title}`}><GitFork />{stats.forks}</Link>}
    </div>
  </article>;
}

/** Placeholder cards while the first page is on its way, so the grid does not jump when it lands. */
export function FeedSkeleton({ count = 6 }: { count?: number }) {
  return <>{Array.from({ length: count }, (_, index) => <div key={index} className={`${styles.card} ${styles.skeleton}`} aria-hidden><div className={styles.cover} /><span /><span /></div>)}</>;
}
