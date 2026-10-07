import type { SecretFinding } from '@/lib/community/secrets';
import styles from '../../community.module.css';

type Props = { findings: SecretFinding[]; acknowledged: boolean; onAcknowledge: (value: boolean) => void; missingMarker: string | null };

/** What stops a publication before the Hub would: a missing harness source, or what looks like a credential. */
export function PublishChecks({ findings, acknowledged, onAcknowledge, missingMarker }: Props) {
  return <>
    {missingMarker && <p className={styles.error} role="status">This harness needs {missingMarker} from its project. Choose its project folder, or set Harness to General.</p>}
    {findings.length > 0 && <div className={styles.notice} role="status">
      <strong>This may publish a credential.</strong>
      <ul>{findings.map(finding => <li key={`${finding.where}:${finding.kind}`}>{finding.where} looks like it holds {finding.kind}.</li>)}</ul>
      <p>Remove it from the file or the conversation. Anything published here is public.</p>
      <label className={styles.check}><input type="checkbox" name="secrets" checked={acknowledged} onChange={event => onAcknowledge(event.target.checked)} /><span>I checked these. None of them is a real credential.</span></label>
    </div>}
  </>;
}
