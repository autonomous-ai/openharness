'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { countHub } from '@/lib/community/hubMeasure';
import { rememberHubReturn } from '@/lib/community/session';
import { webAppPath } from '@/lib/webApp';
import { SearchField, type SearchFieldProps } from './SearchField';
import { useSignedIn } from './useSignedIn';
import { useUnread } from './useUnread';
import styles from '../community.module.css';

/** Sign in (and come back) while signed out; once signed in, the bar needs no way out of the Hub. */
function AccountLink({ signedIn }: { signedIn: boolean | null }) {
  if (signedIn !== false) return null;
  return <a href={webAppPath} onClick={rememberHubReturn}>Sign in</a>;
}

/** The reader's notifications, with how many are unread. */
function NotificationsLink({ unread }: { unread: number }) {
  const label = unread ? `Notifications, ${unread} unread` : 'Notifications';
  return <Link className={styles.bell} href="/hub/notifications" aria-label={label}><Bell />{unread > 0 && <span className={styles.badge}>{unread > 99 ? '99+' : unread}</span>}</Link>;
}

export type HubTab = 'explore' | 'following' | 'yours';

/** The Hub's bar. `tab` marks the feed being read; a harness, fork or publish page marks none. */
export function Header({ tab, search }: { tab?: HubTab; search?: SearchFieldProps }) {
  const signedIn = useSignedIn(), unread = useUnread(signedIn);
  return <header className={styles.topbar}><div className={`${styles.wrap} ${styles.bar}`}>
    <Link className={styles.brand} href="/hub">Harness <span className={styles.hubWord}>Hub</span></Link>
    <nav className={styles.nav} aria-label="Harness community">
      <Link href="/hub" aria-current={tab === 'explore' ? 'page' : undefined}>Explore</Link>
      <Link href="/hub/following" aria-current={tab === 'following' ? 'page' : undefined}>Following</Link>
      {signedIn && <Link href="/hub/yours" aria-current={tab === 'yours' ? 'page' : undefined}>Yours</Link>}
    </nav>
    <div className={styles.barActions}>
      {search && <SearchField {...search} />}
      {signedIn && <NotificationsLink unread={unread} />}
      <Link className={styles.primary} href="/hub/publish">Publish</Link>
      <AccountLink signedIn={signedIn} />
    </div>
  </div></header>;
}

/** Asks a visitor to sign in where an action needs an account; each time it is drawn and each click are counted. */
export function SignIn({ action = 'join the conversation' }: { action?: string }) {
  useEffect(() => { countHub('hub_sign_in_prompt_shown'); }, []);
  return <p className={styles.signin}><a href={webAppPath} onClick={() => { countHub('hub_sign_in_prompt_click'); rememberHubReturn(); }}>Sign in to Harness</a> to {action}. You’ll return here afterward.</p>;
}
