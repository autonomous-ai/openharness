import type { SourceFile } from '@/lib/community/types';
import styles from '../../community.module.css';

const kilobytes = (file: SourceFile) => Math.ceil(new TextEncoder().encode(file.content).length / 1024);
type Props = { files: SourceFile[]; viewerPath?: string; onRemove: (path: string) => void; onViewer: (path: string | undefined) => void };

/** Every file that will be published, readable before it is, and which page (if any) readers see. */
export function FilesReview({ files, viewerPath, onRemove, onViewer }: Props) {
  if (!files.length) return null;
  const pages = files.filter(file => file.path.endsWith('.html') && !file.encoding);
  return <details className={styles.filesReview}>
    <summary>Review {files.length} source files</summary>
    {files.map(file => <div className={styles.fileRow} key={file.path}>
      <details><summary>{file.path}</summary>{file.encoding ? <p>Binary artifact included in the fork.</p> : <pre className={styles.sourceText}>{file.content}</pre>}</details>
      <small>{kilobytes(file)} KB</small>
      <button type="button" disabled={files.length === 1} onClick={() => onRemove(file.path)}>Remove</button>
    </div>)}
    <label className={styles.field}>Output preview<select value={viewerPath || ''} onChange={event => onViewer(event.target.value || undefined)}>
      <option value="">No output preview</option>
      {pages.map(file => <option key={file.path}>{file.path}</option>)}
    </select><small>Readers see this page running. Without one, they see your cover, or else the files.</small></label>
  </details>;
}
