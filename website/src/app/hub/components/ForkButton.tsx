'use client';
import { useState, type ReactNode } from 'react';
import Link from 'next/link';
import { desktopForkLink, forkRequestId } from '@/lib/community/handoff';
import { harnessPath } from '@/lib/community/slug';
import styles from '../community.module.css';

/** Hands the harness to the desktop app by its id; the page for anyone without the app is at its web address. */
export function ForkButton({ harness, children = 'Open in Harness' }: { harness: { id: string; title: string }; children?: ReactNode }) {
  const [opened, setOpened] = useState(false), id = harness.id;
  return <span className={styles.handoff}>
    <button className={styles.primary} onClick={() => {
      // Stay in the click gesture: browsers can ask permission to open the app.
      window.location.href = desktopForkLink(id, forkRequestId(id)); setOpened(true);
    }}>{children}</button>
    {opened && <span className={styles.handoffHelp} role="status">Opening Harness… <Link href={`${harnessPath(harness)}/fork`}>Need the app?</Link></span>}
  </span>;
}
