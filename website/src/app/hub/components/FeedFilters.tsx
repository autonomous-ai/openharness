'use client';
import { communityCategories } from '@/lib/community/contract';
import { feedSorts, type FeedSort } from '@/lib/community/feed';
import styles from '../community.module.css';

type Props = { category: string; sort: FeedSort; onCategory: (category: string) => void; onSort: (sort: FeedSort) => void };

const sortLabels: Record<FeedSort, string> = { newest: 'Newest', popular: 'Popular' };

/** One category at a time (All clears it), and the order: newest first or most liked first. */
export function FeedFilters({ category, sort, onCategory, onSort }: Props) {
  return <div className={styles.filters}>
    <div className={styles.chips} role="group" aria-label="Category">
      {['', ...communityCategories].map(value => <button key={value || 'all'} type="button" aria-pressed={category === value} onClick={() => onCategory(value)}>{value || 'All'}</button>)}
    </div>
    <div className={styles.sort} role="group" aria-label="Order">
      {feedSorts.map(value => <button key={value} type="button" aria-pressed={sort === value} onClick={() => onSort(value)}>{sortLabels[value]}</button>)}
    </div>
  </div>;
}
