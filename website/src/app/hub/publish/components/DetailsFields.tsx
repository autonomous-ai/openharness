import { communityCategories, communityEngines, communityHarnesses } from '@/lib/community/contract';
import type { PublishDraft } from '../usePublishDraft';
import styles from '../../community.module.css';

/** How the harness is listed: title, introduction, category, harness and agent. */
export function DetailsFields({ draft, update }: { draft: PublishDraft; update: (patch: Partial<PublishDraft>) => void }) {
  return <>
    <label className={styles.field}>Title<input required maxLength={100} value={draft.title} onChange={event => update({ title: event.target.value })} placeholder="What did you make?" /></label>
    <label className={styles.field}>Description<input required maxLength={300} value={draft.description} onChange={event => update({ description: event.target.value })} placeholder="A short introduction to the work" /></label>
    <label className={styles.field}>Category<select value={draft.category} onChange={event => update({ category: event.target.value })}>{communityCategories.map(c => <option key={c}>{c}</option>)}</select></label>
    <label className={styles.field}>Harness<select value={draft.harnessId || ''} onChange={event => update({ harnessId: event.target.value || undefined })}>
      <option value="">General</option>
      {Object.entries(communityHarnesses).map(([id, { name }]) => <option key={id} value={id}>{name}</option>)}
    </select></label>
    <label className={styles.field}>Agent<select value={draft.engine} onChange={event => update({ engine: event.target.value })}>{communityEngines.map(e => <option key={e}>{e}</option>)}</select></label>
  </>;
}
