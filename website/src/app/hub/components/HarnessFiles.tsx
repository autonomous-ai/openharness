'use client';
import { useState } from 'react';
import type { SourceFile } from '@/lib/community/types';
import styles from '../community.module.css';

/** A file's size on disk: base64 holds three bytes in every four characters. */
const size = (file: SourceFile) => {
  const bytes = file.encoding ? Math.floor(file.content.length * 3 / 4) : new TextEncoder().encode(file.content).length;
  return bytes < 1024 ? `${bytes} B` : `${Math.ceil(bytes / 1024)} KB`;
};

/** One file, its text drawn only once it is opened: a project's files run to megabytes. */
function SourceFileRow({ file }: { file: SourceFile }) {
  const [open, setOpen] = useState(false);
  return <details className={styles.sourceFile} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><code>{file.path}</code><small>{size(file)}</small></summary>
    {open && (file.encoding ? <p className={styles.contextNote}>A binary file. Download the project to open it.</p> : <pre className={styles.sourceText}>{file.content}</pre>)}
  </details>;
}

type Props = { id: string; files: SourceFile[] | null; error: string; onRetry: () => void };

/** The project behind the output, readable here; the ZIP is for working on it in another editor. */
export function HarnessFiles({ id, files, error, onRetry }: Props) {
  if (error) return <p className={styles.notice} role="status">{error}<button onClick={onRetry}>Retry</button></p>;
  if (!files) return <p className={styles.contextNote}>Loading files…</p>;
  return <div>
    {files.map(file => <SourceFileRow key={file.path} file={file} />)}
    <p className={styles.contextNote}><a className={styles.textLink} href={`/hub/${id}/download`}>Download a ZIP</a> to open the project in another editor.</p>
  </div>;
}
