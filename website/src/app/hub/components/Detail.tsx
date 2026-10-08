'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, GitFork, Heart, MessageCircle, X } from 'lucide-react';
import { previewDocument } from '@/lib/community/preview';
import type { OpenHarness } from '@/lib/community/types';
import { Comments } from './Comments';
import { ForkButton } from './ForkButton';
import { HarnessTags } from './HarnessTags';
import { Header } from './Header';
import { Transcript } from './Transcript';
import { useHarnessDetail } from './useHarnessDetail';
import styles from '../community.module.css';

/** The output beside its source conversation, or a starter's recorded run. */
function Viewer({ harness }: { harness: OpenHarness }) {
  const html = harness.files.find(file => file.path === harness.viewerPath)?.content || '';
  return <section className={styles.viewer} aria-label="Output viewer">{harness.recording
    ? <video className={styles.recording} controls playsInline preload="metadata" poster={harness.cover} aria-label={`${harness.title} recorded run`} src={harness.recording} />
    : <iframe title={`${harness.title} output`} srcDoc={previewDocument(html)} sandbox={harness.example ? 'allow-scripts allow-downloads allow-modals' : 'allow-scripts'} referrerPolicy="no-referrer" />}</section>;
}

export default function Detail({ id, initial, initialComments = false }: { id: string; initial: OpenHarness | null; initialComments?: boolean }) {
  const [comments, setComments] = useState(initialComments);
  const page = useHarnessDetail(id, initial, () => setComments(true));
  const { harness, social, ready, busy } = page;
  if (page.unavailable) return <><Header /><main className={`${styles.wrap} ${styles.empty}`}><h1>This harness is unavailable.</h1><Link className={styles.textLink} href="/hub">Back to Explore</Link></main></>;
  if (!harness) return <><Header /><main className={`${styles.wrap} ${styles.loading}`}>{page.error || 'Loading harness…'}{page.error && <button onClick={() => void page.load()}>Retry</button>}</main></>;
  const unpublish = () => { if (window.confirm('Remove this harness from the public feed? Existing downloaded forks remain with their owners.')) void page.unpublish(); };
  return <><Header /><main className={`${styles.wrap} ${styles.detail}`}>
    <Link className={styles.back} href="/hub"><ArrowLeft /> All harnesses</Link>
    <header className={styles.detailHead}><div className={styles.identity}><h1>{harness.title}</h1><div className={styles.byline}>
      <span>{harness.authorName}</span>{!social.mine && <button className={styles.follow} disabled={busy} aria-pressed={social.following} onClick={() => void page.follow()}>{social.following ? 'Following' : 'Follow'}</button>}
      {harness.forkedFrom && <Link className={styles.textLink} href={`/hub/${harness.forkedFrom}`}>Forked from an open harness</Link>}
    </div></div><div className={styles.actions}>
      <button className={social.liked ? styles.liked : ''} disabled={busy} aria-label={social.liked ? 'Unlike harness' : 'Like harness'} aria-pressed={social.liked} onClick={() => void page.like()}><Heart /><span>{ready ? social.likes : 'Like'}</span></button>
      <button aria-label="Comments" aria-pressed={comments} onClick={() => setComments(value => !value)}><MessageCircle /><span>{ready ? social.comments.length : 'Comments'}</span></button>
      <ForkButton id={id}><GitFork /> Fork</ForkButton>
    </div></header>
    <div className={styles.split}><Viewer harness={harness} />
      <aside className={styles.chat} aria-label={comments ? 'Comments' : 'Agent chat log'}>
        <div className={styles.chatHead}><h2>{comments ? `Comments${ready ? ` · ${social.comments.length}` : ''}` : 'Chat log'}</h2>{comments ? <button className={styles.icon} onClick={() => setComments(false)} aria-label="Back to chat log"><X /></button> : <HarnessTags harness={harness} />}</div>
        {comments ? <Comments social={social} ready={ready} busy={busy} onRetry={() => void page.load()} onRemove={comment => void page.removeComment(comment)} onPost={page.postComment} /> : <Transcript harness={harness} />}
        {page.error && <p className={styles.error} role="alert">{page.error}</p>}
      </aside></div>
    {social.mine && <div className={styles.manage}><button disabled={busy} onClick={unpublish}>Unpublish this harness</button></div>}
  </main></>;
}
