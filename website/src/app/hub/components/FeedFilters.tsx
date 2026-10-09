'use client';
import { useEffect } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { communityCategories } from '@/lib/community/contract';
import { feedSorts, type FeedSort } from '@/lib/community/feed';
import { useScrollRow } from './useScrollRow';
import styles from '../community.module.css';

type Props = { category: string; sort: FeedSort; onCategory: (category: string) => void; onSort: (sort: FeedSort) => void };

const sortLabels: Record<FeedSort, string> = { newest: 'Newest', popular: 'Popular' };

/**
 * The categories, one at a time (All clears it). When they do not fit, the row scrolls by finger,
 * wheel or its arrows, and a fade marks each end that hides more. The chosen chip moves to the middle.
 */
function CategoryChips({ category, onCategory }: Pick<Props, 'category' | 'onCategory'>) {
  const { row, edges, step, center } = useScrollRow<HTMLDivElement>();
  useEffect(() => center(row.current?.querySelector<HTMLElement>('[aria-pressed=true]')), [category, center, row]);
  // The arrows are for a pointer; a keyboard reaches every chip with Tab, which scrolls it into view.
  return <div className={styles.chipsWrap}>
    {edges.left && <button type="button" className={`${styles.chipArrow} ${styles.chipArrowLeft}`} tabIndex={-1} aria-hidden onClick={() => step(-1)}><ChevronLeft /></button>}
    <div ref={row} className={styles.chips} data-fade-left={edges.left || undefined} data-fade-right={edges.right || undefined} role="group" aria-label="Category">
      {['', ...communityCategories].map(value => <button key={value || 'all'} type="button" aria-pressed={category === value} onClick={() => onCategory(value)}><span>{value || 'All'}</span></button>)}
    </div>
    {edges.right && <button type="button" className={`${styles.chipArrow} ${styles.chipArrowRight}`} tabIndex={-1} aria-hidden onClick={() => step(1)}><ChevronRight /></button>}
  </div>;
}

/** Each pill is drawn on its label, so a button keeps a phone's full touch height while the pill stays compact. */
export function FeedFilters({ category, sort, onCategory, onSort }: Props) {
  return <div className={styles.filters}>
    <CategoryChips category={category} onCategory={onCategory} />
    <div className={styles.sort} role="group" aria-label="Order">
      {feedSorts.map(value => <button key={value} type="button" aria-pressed={sort === value} onClick={() => onSort(value)}><span>{sortLabels[value]}</span></button>)}
    </div>
  </div>;
}
