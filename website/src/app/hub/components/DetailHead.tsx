'use client';
import Link from 'next/link';
import { FileCode2, Flag, GitFork, Heart, MessageCircle, Pencil } from 'lucide-react';
import { commentTotal } from '@/lib/community/comments';
import type { OpenHarness, SocialState } from '@/lib/community/types';
import { ForkButton } from './ForkButton';
import { ForkedFrom } from './ForkedFrom';
import { ShareMenu } from './ShareMenu';
import styles from '../community.module.css';

/** What the side of a harness page shows beside its output. */
export type Panel = 'log' | 'comments' | 'files';

type Props = {
  harness: OpenHarness; social: SocialState; ready: boolean; busy: boolean; panel: Panel;
  onFollow: () => void; onLike: () => void; onPanel: (panel: Panel) => void; onReport: () => void;
};

/** The harness's title and creator, and what a reader can do with it; its author can also edit (and unpublish) it there. */
export function DetailHead({ harness, social, ready, busy, panel, onFollow, onLike, onPanel, onReport }: Props) {
  return <header className={styles.detailHead}>
    <div className={styles.identity}><h1>{harness.title}</h1><div className={styles.byline}>
      <Link className={styles.authorLink} href={`/hub/creators/${harness.authorId}`}>{harness.authorName}</Link>
      {/* Shown once the reader is known: an author must not see Follow on their own harness, even for a moment. */}
      {ready && !social.mine && <button className={styles.follow} disabled={busy} aria-pressed={social.following} onClick={onFollow}>{social.following ? 'Following' : 'Follow'}</button>}
      <ForkedFrom harness={harness} />
      {!!social.forks && <a className={styles.textLink} href="#forks">{social.forks === 1 ? '1 fork' : `${social.forks} forks`}</a>}
    </div></div>
    <div className={styles.actions}>
      <button className={social.liked ? styles.liked : ''} disabled={busy || !ready} aria-label={social.liked ? 'Unlike harness' : 'Like harness'} aria-pressed={social.liked} onClick={onLike}><Heart /><span>{ready ? social.likes : '–'}</span></button>
      <button aria-label="Comments" aria-pressed={panel === 'comments'} onClick={() => onPanel('comments')}><MessageCircle /><span>{ready ? commentTotal(social) : '–'}</span></button>
      <button aria-label="Source files" aria-pressed={panel === 'files'} onClick={() => onPanel('files')}><FileCode2 /><span className={styles.actionLabel}>Files</span></button>
      <ShareMenu harness={harness} />
      {social.mine && <Link href={`/hub/publish?edit=${harness.id}`}><Pencil /><span>Edit</span></Link>}
      {/* Not your own, and not a starter: those are the Hub's. */}
      {ready && !social.mine && !harness.example && <button aria-label="Report harness" onClick={onReport}><Flag /><span className={styles.actionLabel}>Report</span></button>}
      <ForkButton harness={harness}><GitFork /> Fork</ForkButton>
    </div>
  </header>;
}
