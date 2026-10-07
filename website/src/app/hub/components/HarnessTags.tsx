import type { HarnessSummary } from '@/lib/community/types';
import styles from '../community.module.css';

const names: Record<string, string> = {
  'autonomous/blender': 'Blender', 'autonomous/marp': 'Marp', 'autonomous/typst': 'Typst',
  'autonomous/circuitjs': 'CircuitJS', 'autonomous/godogen': 'Godogen',
  'autonomous/jev-sheets': 'Jev Sheets', 'autonomous/mujoco': 'MuJoCo',
  'autonomous/rdkit': 'RDKit', 'autonomous/strudel': 'Strudel',
};

export function HarnessTags({ harness }: { harness: Pick<HarnessSummary, 'harnessId' | 'harnessName' | 'engine'> }) {
  const name = harness.harnessName || names[harness.harnessId || ''];
  return <span className={styles.tags} aria-label="Harness and agent">
    {name && <span>{name}</span>}<span>{harness.engine}</span>
  </span>;
}
