import { diskBytes, formatBytes } from '@/lib/community/files';
import type { SourceFile } from '@/lib/community/types';
import { SourceFileDetails } from './SourceFileDetails';
import styles from '../community.module.css';

type Props = { id: string; files: SourceFile[] | null; error: string; onRetry: () => void };

/** The project behind the output, readable here; the ZIP is for working on it in another editor. */
export function HarnessFiles({ id, files, error, onRetry }: Props) {
  if (error) return <p className={styles.notice} role="status">{error}<button onClick={onRetry}>Retry</button></p>;
  if (!files) return <p className={styles.contextNote}>Loading files…</p>;
  return <div>
    {files.map(file => <SourceFileDetails key={file.path} className={styles.sourceFile} file={file}
      summary={<><code>{file.path}</code><small>{formatBytes(diskBytes(file))}</small></>}
      binary={<p className={styles.contextNote}>A binary file. Download the project to open it.</p>} />)}
    <p className={styles.contextNote}><a className={styles.textLink} href={`/hub/${id}/download`}>Download a ZIP</a> to open the project in another editor.</p>
  </div>;
}
