import { communityHarnesses } from '@/lib/community/contract';
import type { HarnessSummary } from '@/lib/community/types';
import styles from '../community.module.css';

export function HarnessTags({ harness }: { harness: Pick<HarnessSummary, 'harnessId' | 'harnessName' | 'engine'> }) {
  const name = harness.harnessName || communityHarnesses[harness.harnessId || '']?.name;
  return <span className={styles.tags} aria-label="Harness and agent">
    {name && <span>{name}</span>}<span>{harness.engine}</span>
  </span>;
}
