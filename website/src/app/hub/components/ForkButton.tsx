'use client';
import { useState, useSyncExternalStore, type ReactNode } from 'react';
import Link from 'next/link';
import { desktopForkLink, forkRequestId } from '@/lib/community/handoff';
import { harnessPath } from '@/lib/community/slug';
import { countHub } from '@/lib/community/hubMeasure';
import styles from '../community.module.css';

const desktop = '(hover: hover) and (pointer: fine)';
const onPointerChange = (notify: () => void) => {
  const query = window.matchMedia?.(desktop);
  query?.addEventListener('change', notify);
  return () => query?.removeEventListener('change', notify);
};
/** Whether this is a computer the desktop app could run on. The server draws the computer's button: the Hub is mouse-first. */
const useComputer = () => useSyncExternalStore(onPointerChange, () => window.matchMedia?.(desktop).matches ?? true, () => true);

type Props = { harness: { id: string; title: string }; children?: ReactNode; onForkPage?: boolean };

/**
 * Hands the harness to the desktop app by its id. A phone has no desktop app to open, so there the
 * button leads to the fork page, and on that page it copies the address to open on a computer.
 */
export function ForkButton({ harness, children = 'Open in Harness', onForkPage = false }: Props) {
  const [opened, setOpened] = useState(false), [copied, setCopied] = useState(false), computer = useComputer();
  const path = harnessPath(harness);
  if (!computer && !onForkPage) return <Link className={styles.primary} href={`${path}/fork`} onClick={() => countHub('hub_fork')}>{children}</Link>;
  if (!computer) return <span className={styles.handoff}>
    <button className={styles.primary} onClick={() => void navigator.clipboard.writeText(`${window.location.origin}${path}/fork`).then(() => setCopied(true), () => undefined)}>
      {copied ? 'Link copied' : 'Copy link for your computer'}
    </button>
    {copied && <span className={styles.handoffHelp} role="status">Open it on your computer to fork in Harness.</span>}
  </span>;
  return <span className={styles.handoff}>
    <button className={styles.primary} onClick={() => {
      // Stay in the click gesture: browsers can ask permission to open the app.
      countHub('hub_fork');
      window.location.href = desktopForkLink(harness.id, forkRequestId(harness.id)); setOpened(true);
    }}>{children}</button>
    {opened && <span className={styles.handoffHelp} role="status">Opening Harness… <Link href={`${path}/fork`} onClick={() => countHub('hub_fork_need_app')}>Need the app?</Link></span>}
  </span>;
}
