import { communityLimits } from '@/lib/community/contract';
import type { ConversationTurn } from '@/lib/community/types';
import styles from '../../community.module.css';

/** The published conversation, turn by turn, so the person removes what they do not want to share. */
export function ConversationEditor({ turns, onChange }: { turns: ConversationTurn[]; onChange: (turns: ConversationTurn[]) => void }) {
  const edit = (index: number, patch: Partial<ConversationTurn>) => onChange(turns.map((turn, i) => i === index ? { ...turn, ...patch } : turn));
  return <div className={`${styles.field} ${styles.wide}`}>
    <span>Conversation</span>
    <small>Review the published context. Remove private messages, credentials, and tool output you do not want to share.</small>
    {turns.map((turn, index) => <div key={index} className={styles.field}>
      <select aria-label={`Speaker ${index + 1}`} value={turn.role} onChange={event => edit(index, { role: event.target.value as ConversationTurn['role'] })}>
        <option value="user">You</option><option value="assistant">Agent</option><option value="tool">Tool output</option>
      </select>
      <textarea required aria-label={`Message ${index + 1}`} maxLength={communityLimits.turnChars} value={turn.text} onChange={event => edit(index, { text: event.target.value })} />
      <button type="button" disabled={turns.length === 1} onClick={() => onChange(turns.filter((_, i) => i !== index))}>Remove message</button>
    </div>)}
    <button type="button" disabled={turns.length >= communityLimits.turns} onClick={() => onChange([...turns, { role: 'assistant', text: '' }])}>+ Add a message</button>
  </div>;
}
