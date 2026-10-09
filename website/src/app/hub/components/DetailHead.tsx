'use client';
import Link from 'next/link';
import { FileCode2, GitFork, Heart, MessageCircle } from 'lucide-react';
import { commentTotal } from '@/lib/community/comments';
import type { OpenHarness, SocialState } from '@/lib/community/types';
import { ForkButton } from './ForkButton';
import { ShareButton } from './ShareButton';
import styles from '../community.module.css';

/** What the side of a harness page shows beside its output. */
export type Panel = 'log' | 'comments' | 'files';

type Props = {
  harness: OpenHarness; social: SocialState; ready: boolean; busy: boolean; panel: Panel;
  onFollow: () => void; onLike: () => void; onPanel: (panel: Panel) => void;
};

/** The harness's title and creator, and what a reader can do with it. */
export function DetailHead({ harness, social, ready, busy, panel, onFollow, onLike, onPanel }: Props) {
  return <header className={styles.detailHead}>
    <div className={styles.identity}><h1>{harness.title}</h1><div className={styles.byline}>
      <span>{harness.authorName}</span>
      {!social.mine && <button className={styles.follow} disabled={busy} aria-pressed={social.following} onClick={onFollow}>{social.following ? 'Following' : 'Follow'}</button>}
      {harness.forkedFrom && <Link className={styles.textLink} href={`/hub/${harness.forkedFrom}`}>Forked from an open harness</Link>}
      {!!social.forks && <a className={styles.textLink} href="#forks">{social.forks === 1 ? '1 fork' : `${social.forks} forks`}</a>}
    </div></div>
    <div className={styles.actions}>
      <button className={social.liked ? styles.liked : ''} disabled={busy} aria-label={social.liked ? 'Unlike harness' : 'Like harness'} aria-pressed={social.liked} onClick={onLike}><Heart /><span>{ready ? social.likes : 'Like'}</span></button>
      <button aria-label="Comments" aria-pressed={panel === 'comments'} onClick={() => onPanel('comments')}><MessageCircle /><span>{ready ? commentTotal(social) : 'Comments'}</span></button>
      <button aria-label="Source files" aria-pressed={panel === 'files'} onClick={() => onPanel('files')}><FileCode2 /><span className={styles.actionLabel}>Files</span></button>
      <ShareButton id={harness.id} />
      <ForkButton id={harness.id}><GitFork /> Fork</ForkButton>
    </div>
  </header>;
}
