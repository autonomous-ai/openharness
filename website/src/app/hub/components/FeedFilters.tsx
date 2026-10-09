'use client';
import { useEffect, useRef } from 'react';
import { communityCategories } from '@/lib/community/contract';
import { feedSorts, type FeedSort } from '@/lib/community/feed';
import styles from '../community.module.css';

type Props = { category: string; sort: FeedSort; onCategory: (category: string) => void; onSort: (sort: FeedSort) => void };

const sortLabels: Record<FeedSort, string> = { newest: 'Newest', popular: 'Popular' };

/**
 * One category at a time (All clears it), and the order: newest first or most liked first. Each pill
 * is drawn on the label, so a button keeps a phone's full touch height while the pill stays compact.
 */
export function FeedFilters({ category, sort, onCategory, onSort }: Props) {
  const chips = useRef<HTMLDivElement>(null);
  // A shared address can pick a category past a phone's edge: bring its chip into the row.
  useEffect(() => {
    const row = chips.current, chip = row?.querySelector<HTMLElement>('[aria-pressed=true]');
    if (row && chip) row.scrollTo?.({ left: chip.offsetLeft - row.offsetLeft - parseFloat(getComputedStyle(row).paddingLeft), behavior: 'smooth' });
  }, [category]);
  return <div className={styles.filters}>
    <div ref={chips} className={styles.chips} role="group" aria-label="Category">
      {['', ...communityCategories].map(value => <button key={value || 'all'} type="button" aria-pressed={category === value} onClick={() => onCategory(value)}><span>{value || 'All'}</span></button>)}
    </div>
    <div className={styles.sort} role="group" aria-label="Order">
      {feedSorts.map(value => <button key={value} type="button" aria-pressed={sort === value} onClick={() => onSort(value)}><span>{sortLabels[value]}</span></button>)}
    </div>
  </div>;
}
