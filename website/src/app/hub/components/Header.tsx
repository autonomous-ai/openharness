'use client';
import Link from 'next/link';
import { ArrowUpRight, Search } from 'lucide-react';
import { rememberHubReturn } from '@/lib/community/session';
import { useSignedIn } from './useSignedIn';
import styles from '../community.module.css';

export function Header({ following = false, mine = false, onSearch }: { following?: boolean; mine?: boolean; onSearch?: () => void }) {
  const signedIn = useSignedIn();
  return <header className={`${styles.wrap} ${styles.bar}`}>
    <Link className={styles.brand} href="/hub">Harness <span className={styles.hubWord}>Hub</span></Link>
    <nav className={styles.nav} aria-label="Harness community">
      <Link href="/hub" aria-current={!following && !mine ? 'page' : undefined}>Explore</Link>
      <Link href="/hub/following" aria-current={following ? 'page' : undefined}>Following</Link>
      {signedIn && <Link href="/hub/yours" aria-current={mine ? 'page' : undefined}>Yours</Link>}
      {onSearch && <button onClick={onSearch} aria-label="Search harnesses"><Search /></button>}
      <Link href="/hub/publish">Publish</Link>
      {signedIn === false && <a href="/" onClick={rememberHubReturn}>Sign in</a>}
      <a href="/" className={styles.openApp}>Open Harness <ArrowUpRight /></a>
    </nav>
  </header>;
}

export function SignIn({ action = 'join the conversation' }: { action?: string }) {
  return <p className={styles.signin}><a href="/" onClick={rememberHubReturn}>Sign in to Harness</a> to {action}. You’ll return here afterward.</p>;
}
