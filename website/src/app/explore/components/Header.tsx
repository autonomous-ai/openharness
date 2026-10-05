import Link from 'next/link';
import { ArrowUpRight, Search } from 'lucide-react';
import styles from '../community.module.css';

export function Header({ following = false, onSearch }: { following?: boolean; onSearch?: () => void }) {
  return <header className={`${styles.wrap} ${styles.bar}`}>
    <Link className={styles.brand} href="/explore">Harness</Link>
    <nav className={styles.nav} aria-label="Harness community">
      <Link href="/explore" aria-current={!following ? 'page' : undefined}>Explore</Link>
      <Link href="/explore/following" aria-current={following ? 'page' : undefined}>Following</Link>
      {onSearch && <button onClick={onSearch} aria-label="Search harnesses"><Search /></button>}
      <Link href="/explore/publish">Publish</Link>
      <a href="/" className={styles.openApp}>Open Harness <ArrowUpRight /></a>
    </nav>
  </header>;
}

export function SignIn({ action = 'join the conversation' }: { action?: string }) {
  return <p className={styles.signin}><a href="/" target="_blank" rel="noopener">Sign in to Harness</a> to {action}. Return here after signing in.</p>;
}
