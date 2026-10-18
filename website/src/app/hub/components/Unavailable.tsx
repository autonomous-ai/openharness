import Link from 'next/link';
import { Header } from './Header';
import styles from '../community.module.css';

/** A page the Hub says is gone (a harness unpublished, a creator with nothing published), or one this reader reported. */
export function Unavailable({ what, reported = false }: { what: string; reported?: boolean }) {
  return <><Header /><main className={`${styles.wrap} ${styles.empty}`}>
    <h1>{reported ? 'Thanks for reporting.' : `This ${what} is unavailable.`}</h1>
    {reported && <p>You will not see this {what} on the Hub again.</p>}
    <Link className={styles.textLink} href="/hub">Back to Explore</Link>
  </main></>;
}
