import { useMemo } from 'react';
import { formatBytes, sentBytes } from '@/lib/community/files';
import type { SourceFile } from '@/lib/community/types';
import { SourceFileDetails } from '../../components/SourceFileDetails';
import styles from '../../community.module.css';

/** Every file that will be published, readable before it is, and which page the viewer opens. */
export function FilesReview({ files, viewerPath, onRemove, onViewer }: { files: SourceFile[]; viewerPath: string; onRemove: (path: string) => void; onViewer: (path: string) => void }) {
  // Measured once per project, not on every keystroke in the form around it.
  const sizes = useMemo(() => files.map(file => formatBytes(sentBytes(file))), [files]);
  if (!files.length) return null;
  const pages = files.filter(file => file.path.endsWith('.html') && !file.encoding);
  return <details className={styles.filesReview}>
    <summary>Review {files.length} source files</summary>
    {files.map((file, index) => <div className={styles.fileRow} key={file.path}>
      <SourceFileDetails file={file} summary={file.path} binary={<p>Binary artifact included in the fork.</p>} />
      <small>{sizes[index]}</small>
      <button type="button" disabled={file.path === viewerPath} onClick={() => onRemove(file.path)}>Remove</button>
    </div>)}
    <label className={styles.field}>Output preview<select value={pages.some(file => file.path === viewerPath) ? viewerPath : ''} onChange={event => onViewer(event.target.value)}>
      <option value="" disabled>Choose the page readers see</option>
      {pages.map(file => <option key={file.path}>{file.path}</option>)}
    </select></label>
  </details>;
}
