'use client';
import { useRef, useState } from 'react';
import { commentTotal, threadComments } from '@/lib/community/comments';
import type { ReportReason } from '@/lib/community/reports';
import type { HarnessComment, SocialState } from '@/lib/community/types';
import { timeAgo } from '@/lib/community/time';
import { SignIn } from './Header';
import { ReportForm } from './ReportForm';
import styles from '../community.module.css';

type Props = {
  social: SocialState; ready: boolean; failed: boolean; busy: boolean; onRetry: () => void; onEarlier: () => Promise<boolean>;
  onRemove: (comment: HarnessComment) => void; onPost: (body: string, clientId: string, parentId?: string) => Promise<boolean>;
  onReport: (comment: HarnessComment, reason: ReportReason) => Promise<boolean>;
};

type CommentProps = { comment: HarnessComment; busy: boolean; canReply: boolean; onReply: () => void; onRemove: () => void; onReport: (reason: ReportReason) => Promise<boolean> };

function Comment({ comment, busy, canReply, onReply, onRemove, onReport }: CommentProps) {
  const [reporting, setReporting] = useState(false);
  return <article className={`${styles.comment} ${comment.parentId ? styles.reply : ''}`}>
    <div className={styles.commentBy}>
      <span>{comment.authorName}</span>{comment.creator && <em className={styles.creator}>Creator</em>}<small><time dateTime={comment.createdAt} title={new Date(comment.createdAt).toLocaleString()}>{timeAgo(comment.createdAt)}</time></small>
      {comment.mine && <button disabled={busy} aria-label={`Delete comment by ${comment.authorName}`} onClick={() => { if (window.confirm('Delete this comment? This cannot be undone.')) onRemove(); }}>Delete</button>}
      {!comment.mine && canReply && <button disabled={busy} aria-label={`Report comment by ${comment.authorName}`} onClick={() => setReporting(true)}>Report</button>}
    </div>
    {comment.parentId && <small className={styles.replyContext}>Replying to {comment.parentAuthorName}</small>}
    <p>{comment.body}</p>
    {canReply && <button className={styles.replyButton} onClick={onReply}>Reply</button>}
    {reporting && <ReportForm what="comment" onReport={onReport} onCancel={() => setReporting(false)} />}
  </article>;
}

/** How many of the comments are shown, and a way further back: a page at a time, said when one fails. */
function EarlierComments({ shown, total, onEarlier }: { shown: number; total: number; onEarlier: () => Promise<boolean> }) {
  const [state, setState] = useState<'idle' | 'loading' | 'failed'>('idle');
  const load = async () => { setState('loading'); setState(await onEarlier() ? 'idle' : 'failed'); };
  return <p className={styles.notice}>
    {state === 'failed' ? 'Earlier comments could not be loaded.' : `Showing the latest ${shown} of ${total} comments.`}
    <button type="button" disabled={state === 'loading'} onClick={() => void load()}>{state === 'loading' ? 'Loading…' : state === 'failed' ? 'Retry' : 'Show earlier'}</button>
  </p>;
}

/** The conversation under a harness: the comments, each reply under its thread, and a form to add one or reply to one. */
export function Comments({ social, ready, failed, busy, onRetry, onEarlier, onRemove, onReport, onPost }: Props) {
  const [draft, setDraft] = useState(''), [replyTo, setReplyTo] = useState<HarnessComment | null>(null);
  // Kept across a failed post, so a retry of the same text is recognised as the same comment.
  const requestId = useRef<string | null>(null);
  const reply = (comment: HarnessComment | null) => { setReplyTo(comment); requestId.current = null; if (comment) document.getElementById('comment')?.focus(); };
  async function submit() {
    if (!draft.trim()) return;
    requestId.current ??= crypto.randomUUID();
    if (!await onPost(draft, requestId.current, replyTo?.id)) return;
    setDraft(''); setReplyTo(null); requestId.current = null;
  }
  return <>
    {/* Until the first read lands the panel is loading, not failed, and does not yet know who is reading. */}
    {!ready && !failed && <div className={styles.skeleton} aria-busy aria-label="Loading comments"><span /><span /></div>}
    {!ready && failed && <p className={styles.notice}>Comments are unavailable right now. <button onClick={onRetry}>Retry</button></p>}
    {ready && !social.comments.length && <p className={styles.notice}>What would you make from here?</p>}
    {ready && commentTotal(social) > social.comments.length && <EarlierComments shown={social.comments.length} total={commentTotal(social)} onEarlier={onEarlier} />}
    {threadComments(social.comments).map(comment => <Comment key={comment.id} comment={comment} busy={busy} canReply={social.signedIn} onReply={() => reply(comment)} onRemove={() => onRemove(comment)} onReport={reason => onReport(comment, reason)} />)}
    {ready && (social.signedIn ? <form className={styles.commentForm} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor="comment">{replyTo ? `Reply to ${replyTo.authorName}` : 'Join the conversation'}</label>
      {replyTo && <button type="button" className={styles.replyButton} onClick={() => reply(null)}>Cancel reply</button>}
      <textarea id="comment" required maxLength={2000} value={draft} onChange={event => { setDraft(event.target.value); requestId.current = null; }} placeholder="Ask a question or share an idea…" />
      <button className={styles.primary} disabled={busy || !draft.trim()}>{replyTo ? 'Post reply' : 'Post comment'}</button>
    </form> : <SignIn />)}
  </>;
}
