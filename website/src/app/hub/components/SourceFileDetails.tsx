'use client';
import { useState, type ReactNode } from 'react';
import type { SourceFile } from '@/lib/community/types';
import styles from '../community.module.css';

type Props = { file: SourceFile; summary: ReactNode; binary: ReactNode; className?: string };

/** One file under its summary, its text drawn only once it is opened: a project's files run to megabytes. */
export function SourceFileDetails({ file, summary, binary, className }: Props) {
  const [open, setOpen] = useState(false);
  return <details className={className} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>{summary}</summary>
    {open && (file.encoding ? binary : <pre className={styles.sourceText}>{file.content}</pre>)}
  </details>;
}
