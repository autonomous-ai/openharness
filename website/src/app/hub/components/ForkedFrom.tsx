import Link from 'next/link';
import { harnessPath } from '@/lib/community/slug';
import { starterHarnesses } from '@/lib/community/starters';
import type { OpenHarness } from '@/lib/community/types';
import styles from '../community.module.css';

/**
 * Where a fork came from, by name and creator. A starter's name is the website's own; one no longer
 * published is named without a link to a page that would say it is unavailable. An older backend
 * names none, and the link stays as it was.
 */
export function ForkedFrom({ harness }: { harness: Pick<OpenHarness, 'forkedFrom' | 'origin'> }) {
  const { forkedFrom, origin } = harness;
  if (!forkedFrom) return null;
  const source = starterHarnesses.find(item => item.id === forkedFrom) ?? origin;
  if (source === null) return <span>Forked from a harness that is no longer published</span>;
  return <Link className={styles.textLink} href={source ? harnessPath({ id: forkedFrom, title: source.title }) : `/hub/${forkedFrom}`}>
    {source ? `Forked from ${source.title} by ${source.authorName}` : 'Forked from an open harness'}
  </Link>;
}
