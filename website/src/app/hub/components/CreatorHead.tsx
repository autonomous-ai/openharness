'use client';
import type { Creator } from '@/lib/community/types';
import { SignIn } from './Header';
import styles from '../community.module.css';

type Props = { creator: Creator | null; busy: boolean; error: string; signIn: boolean; onFollow: () => void; onRetry: () => void };

const followers = (count: number) => count === 1 ? '1 follower' : `${count} followers`;

/** Above a creator's harnesses: their name, who follows them, and Follow (not on your own page). */
export function CreatorHead({ creator, busy, error, signIn, onFollow, onRetry }: Props) {
  if (!creator) return <div className={styles.feedIntro}>{error ? <p className={styles.notice} role="status">{error}<button onClick={onRetry}>Retry</button></p> : <p>Loading creator…</p>}</div>;
  return <div className={styles.feedIntro}>
    <h1>{creator.name}</h1>
    <p className={styles.byline}>
      <span>{followers(creator.followers)}</span>
      {!creator.mine && <button className={styles.follow} disabled={busy} aria-pressed={creator.following} onClick={onFollow}>{creator.following ? 'Following' : 'Follow'}</button>}
    </p>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {signIn && <SignIn action={`follow ${creator.name}`} />}
  </div>;
}
