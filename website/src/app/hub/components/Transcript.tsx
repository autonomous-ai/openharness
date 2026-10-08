import type { OpenHarness } from '@/lib/community/types';
import styles from '../community.module.css';

/** The published conversation: what was asked, what the agent answered, and folded tool output. */
export function Transcript({ harness }: { harness: OpenHarness }) {
  return <div className={styles.transcript}>
    {harness.example && <p className={styles.contextNote}>{harness.recording ? 'Featured Store project. Watch the recorded run; fork the editable source. This is its published brief, not the original session transcript.' : 'Example conversation. The output and source files are real, editable starter projects.'}</p>}
    {harness.conversation.map((turn, index) => turn.role === 'tool'
      ? <details className={styles.tool} key={index}><summary>Tool output</summary><p>{turn.text}</p></details>
      : <div className={styles.turn} key={index}><small>{turn.role === 'user' ? harness.authorName : harness.engine}</small><p>{turn.text}</p></div>)}
  </div>;
}
