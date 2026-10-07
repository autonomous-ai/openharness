import type { SecretFinding } from '@/lib/community/secrets';
import styles from '../../community.module.css';

type Props = {
  noOutput: boolean; unchanged: string | null; outside: string[]; missingMarker: string | null;
  findings: SecretFinding[]; acknowledged: boolean; onAcknowledge: (value: boolean) => void;
};

const listed = (items: string[]) => items.slice(0, 4).join(', ') + (items.length > 4 ? ` and ${items.length - 4} more` : '');

/** What readers would miss, and what stops a publication before the Hub would. */
export function PublishChecks({ noOutput, unchanged, outside, missingMarker, findings, acknowledged, onAcknowledge }: Props) {
  return <>
    {noOutput && <p className={styles.error} role="status">The Hub shows what a session made. Choose the page readers see under Output preview, or upload your output: one page that runs on its own.</p>}
    {unchanged && <p className={styles.error} role="status">{unchanged} is still the original&apos;s and has none of your changes. Ask your agent to update it to show the current result, or upload your output.</p>}
    {outside.length > 0 && <p className={styles.notice} role="status">Your output loads {listed(outside)}. The Hub&apos;s preview cannot reach other files or the internet, so readers would see it without them. Ask your agent to put them into the page.</p>}
    {missingMarker && <p className={styles.error} role="status">This harness needs {missingMarker} from its project. Choose its project folder, or set Harness to General.</p>}
    {findings.length > 0 && <div className={styles.notice} role="status">
      <strong>This may publish a credential.</strong>
      <ul>{findings.map(finding => <li key={`${finding.where}:${finding.kind}`}>{finding.where} looks like it holds {finding.kind}.</li>)}</ul>
      <p>Remove it from the file or the conversation. Anything published here is public.</p>
      <label className={styles.check}><input type="checkbox" name="secrets" checked={acknowledged} onChange={event => onAcknowledge(event.target.checked)} /><span>I checked these. None of them is a real credential.</span></label>
    </div>}
  </>;
}
