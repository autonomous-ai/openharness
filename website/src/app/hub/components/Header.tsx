'use client';
import Link from 'next/link';
import { ArrowUpRight } from 'lucide-react';
import { rememberHubReturn } from '@/lib/community/session';
import { SearchField, type SearchFieldProps } from './SearchField';
import { useSignedIn } from './useSignedIn';
import styles from '../community.module.css';

/** One way out to the app: sign in (and come back) while signed out, open it once signed in. */
function AccountLink({ signedIn }: { signedIn: boolean | null }) {
  if (signedIn === null) return null;
  if (!signedIn) return <a href="/" onClick={rememberHubReturn}>Sign in</a>;
  return <a href="/" className={styles.openApp}>Open Harness <ArrowUpRight /></a>;
}

export type HubTab = 'explore' | 'following' | 'yours';

/** The Hub's bar. `tab` marks the feed being read; a harness, fork or publish page marks none. */
export function Header({ tab, search }: { tab?: HubTab; search?: SearchFieldProps }) {
  const signedIn = useSignedIn();
  return <header className={styles.topbar}><div className={`${styles.wrap} ${styles.bar}`}>
    <Link className={styles.brand} href="/hub">Harness <span className={styles.hubWord}>Hub</span></Link>
    <nav className={styles.nav} aria-label="Harness community">
      <Link href="/hub" aria-current={tab === 'explore' ? 'page' : undefined}>Explore</Link>
      <Link href="/hub/following" aria-current={tab === 'following' ? 'page' : undefined}>Following</Link>
      {signedIn && <Link href="/hub/yours" aria-current={tab === 'yours' ? 'page' : undefined}>Yours</Link>}
    </nav>
    <div className={styles.barActions}>
      {search && <SearchField {...search} />}
      <Link className={styles.primary} href="/hub/publish">Publish</Link>
      <AccountLink signedIn={signedIn} />
    </div>
  </div></header>;
}

export function SignIn({ action = 'join the conversation' }: { action?: string }) {
  return <p className={styles.signin}><a href="/" onClick={rememberHubReturn}>Sign in to Harness</a> to {action}. You’ll return here afterward.</p>;
}
