'use client';
import { useRef, useState } from 'react';
import { commentTotal, threadComments } from '@/lib/community/comments';
import type { HarnessComment, SocialState } from '@/lib/community/types';
import { SignIn } from './Header';
import styles from '../community.module.css';

type Props = {
  social: SocialState; ready: boolean; busy: boolean; onRetry: () => void;
  onRemove: (comment: HarnessComment) => void; onPost: (body: string, clientId: string, parentId?: string) => Promise<boolean>;
};

const day = (createdAt: string) => new Date(createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

function Comment({ comment, busy, canReply, onReply, onRemove }: { comment: HarnessComment; busy: boolean; canReply: boolean; onReply: () => void; onRemove: () => void }) {
  return <article className={`${styles.comment} ${comment.parentId ? styles.reply : ''}`}>
    <div className={styles.commentBy}>
      <span>{comment.authorName}</span>{comment.creator && <em className={styles.creator}>Creator</em>}<small>{day(comment.createdAt)}</small>
      {comment.mine && <button disabled={busy} aria-label={`Delete comment by ${comment.authorName}`} onClick={onRemove}>Delete</button>}
    </div>
    {comment.parentId && <small className={styles.replyContext}>Replying to {comment.parentAuthorName}</small>}
    <p>{comment.body}</p>
    {canReply && <button className={styles.replyButton} onClick={onReply}>Reply</button>}
  </article>;
}

/** The conversation under a harness: the comments, each reply under its thread, and a form to add one or reply to one. */
export function Comments({ social, ready, busy, onRetry, onRemove, onPost }: Props) {
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
    {!ready && <p className={styles.notice}>Comments are unavailable right now. <button onClick={onRetry}>Retry</button></p>}
    {ready && !social.comments.length && <p className={styles.notice}>What would you make from here?</p>}
    {ready && commentTotal(social) > social.comments.length && <p className={styles.notice}>Showing the latest {social.comments.length} of {commentTotal(social)} comments.</p>}
    {threadComments(social.comments).map(comment => <Comment key={comment.id} comment={comment} busy={busy} canReply={social.signedIn} onReply={() => reply(comment)} onRemove={() => onRemove(comment)} />)}
    {social.signedIn ? <form className={styles.commentForm} onSubmit={event => { event.preventDefault(); void submit(); }}>
      <label htmlFor="comment">{replyTo ? `Reply to ${replyTo.authorName}` : 'Join the conversation'}</label>
      {replyTo && <button type="button" className={styles.replyButton} onClick={() => reply(null)}>Cancel reply</button>}
      <textarea id="comment" required maxLength={2000} value={draft} onChange={event => { setDraft(event.target.value); requestId.current = null; }} placeholder="Ask a question or share an idea…" />
      <button className={styles.primary} disabled={busy || !draft.trim()}>{replyTo ? 'Post reply' : 'Post comment'}</button>
    </form> : <SignIn />}
  </>;
}
