'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { desktopForkLink, forkRequestId } from '@/lib/community/handoff';
import styles from '../community.module.css';

export function ForkButton({ id, children = 'Open in Harness' }: { id: string; children?: ReactNode }) {
  const [opened, setOpened] = useState(false);
  return <span className={styles.handoff}>
    <button className={styles.primary} onClick={() => {
      // Stay in the click gesture: browsers can ask permission to open the app.
      window.location.href = desktopForkLink(id, forkRequestId(id)); setOpened(true);
    }}>{children}</button>
    {opened && <span className={styles.handoffHelp} role="status">Opening Harness… <Link href={`/hub/${id}/fork`}>Need the app?</Link></span>}
  </span>;
}
