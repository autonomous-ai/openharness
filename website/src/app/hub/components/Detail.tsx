'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { ArrowLeft, GitFork, Heart, MessageCircle, X } from 'lucide-react';
import { communityRequest, emptySocial, CommunityError } from '@/lib/community/client';
import { previewDocument } from '@/lib/community/preview';
import type { HarnessComment, OpenHarness, SocialState } from '@/lib/community/types';
import { Header, SignIn } from './Header';
import { HarnessTags } from './HarnessTags';
import { ForkButton } from './ForkButton';
import styles from '../community.module.css';

export default function Detail({ id, initial, initialComments = false }: { id: string; initial: OpenHarness | null; initialComments?: boolean }) {
  const [harness, setHarness] = useState(initial), [social, setSocial] = useState(emptySocial), [comments, setComments] = useState(initialComments);
  const [replyTo, setReplyTo] = useState<HarnessComment | null>(null);
  const [draft, setDraft] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [unavailable, setUnavailable] = useState(false);
  const requestId = useRef<string | null>(null), revision = useRef(0), writing = useRef(false);
  const load = useCallback(async () => {
    if (writing.current) return;
    const current = ++revision.current;
    try {
      const data = await communityRequest<{ harness: OpenHarness | null; social: SocialState }>(`harnesses/${id}`);
      if (current !== revision.current) return;
      if (data.harness) setHarness(data.harness); setSocial(data.social); setReady(true); setError('');
    } catch (e) {
      if (current !== revision.current) return;
      setReady(false);
      if (e instanceof CommunityError && e.status === 404) setUnavailable(true);
      else if (!initial) setError('This harness could not be loaded. Please try again.');
    }
  }, [id, initial]);
  useEffect(() => { void load(); const reload = () => { void load(); }; window.addEventListener('focus', reload); return () => { revision.current++; window.removeEventListener('focus', reload); }; }, [load]);
  async function mutate(action: () => Promise<void>) {
    if (!social.signedIn) { setComments(true); return; }
    if (writing.current) return;
    writing.current = true; revision.current++;
    setBusy(true); setError('');
    try { await action(); } catch (e) {
      if (e instanceof CommunityError && e.status === 401) { setSocial(value => ({ ...value, signedIn: false })); setComments(true); }
      setError(e instanceof CommunityError && e.status === 401 ? 'Your sign-in has expired. Sign in to Harness again to continue.' : e instanceof Error ? e.message : 'Please try again.');
    }
    finally { writing.current = false; setBusy(false); }
  }
  if (unavailable) return <><Header /><main className={`${styles.wrap} ${styles.empty}`}><h1>This harness is unavailable.</h1><Link className={styles.textLink} href="/hub">Back to Explore</Link></main></>;
  if (!harness) return <><Header /><main className={`${styles.wrap} ${styles.loading}`}>{error || 'Loading harness…'}{error && <button onClick={() => void load()}>Retry</button>}</main></>;
  const html = harness.files.find(file => file.path === harness.viewerPath)?.content || '';
  return <><Header /><main className={`${styles.wrap} ${styles.detail}`}>
    <Link className={styles.back} href="/hub"><ArrowLeft /> All harnesses</Link>
    <header className={styles.detailHead}><div className={styles.identity}><h1>{harness.title}</h1><div className={styles.byline}>
      <span>{harness.authorName}</span>{!social.mine && <button className={styles.follow} disabled={busy} aria-pressed={social.following} onClick={() => void mutate(async () => { const next = !social.following; await communityRequest(`creators/${harness.authorId}/follow`, { method: 'PUT', body: { following: next } }); setSocial(value => ({ ...value, following: next })); })}>{social.following ? 'Following' : 'Follow'}</button>}
      {harness.forkedFrom && <Link className={styles.textLink} href={`/hub/${harness.forkedFrom}`}>Forked from an open harness</Link>}
    </div></div><div className={styles.actions}>
      <button className={social.liked ? styles.liked : ''} disabled={busy} aria-label={social.liked ? 'Unlike harness' : 'Like harness'} aria-pressed={social.liked} onClick={() => void mutate(async () => { const result = await communityRequest<{ liked: boolean; likes: number }>(`harnesses/${id}/like`, { method: 'PUT', body: { liked: !social.liked } }); setSocial(value => ({ ...value, ...result })); })}><Heart /><span>{ready ? social.likes : 'Like'}</span></button>
      <button aria-label="Comments" aria-pressed={comments} onClick={() => setComments(value => !value)}><MessageCircle /><span>{ready ? social.comments.length : 'Comments'}</span></button>
      <ForkButton id={id}><GitFork /> Fork</ForkButton>
    </div></header>
    <div className={styles.split}><section className={styles.viewer} aria-label="Output viewer">{harness.recording ? <video className={styles.recording} controls playsInline preload="metadata" poster={harness.cover} aria-label={`${harness.title} recorded run`} src={harness.recording} /> : <iframe title={`${harness.title} output`} srcDoc={previewDocument(html)} sandbox={harness.example ? 'allow-scripts allow-downloads allow-modals' : 'allow-scripts'} referrerPolicy="no-referrer" />}</section>
      <aside className={styles.chat} aria-label={comments ? 'Comments' : 'Agent chat log'}>
        <div className={styles.chatHead}><h2>{comments ? `Comments${ready ? ` · ${social.comments.length}` : ''}` : 'Chat log'}</h2>{comments ? <button className={styles.icon} onClick={() => setComments(false)} aria-label="Back to chat log"><X /></button> : <HarnessTags harness={harness} />}</div>
        {comments ? <>
          {!ready && <p className={styles.notice}>Comments are unavailable right now. <button onClick={() => void load()}>Retry</button></p>}
          {ready && !social.comments.length && <p className={styles.notice}>What would you make from here?</p>}
          {social.comments.map(comment => <article className={`${styles.comment} ${comment.parentId ? styles.reply : ''}`} key={comment.id}><div className={styles.commentBy}><span>{comment.authorName}</span>{comment.creator && <em className={styles.creator}>Creator</em>}<small>{new Date(comment.createdAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</small>{comment.mine && <button disabled={busy} aria-label={`Delete comment by ${comment.authorName}`} onClick={() => void mutate(async () => { await communityRequest(`harnesses/${id}/comments/${comment.id}`, { method: 'DELETE' }); setSocial(value => ({ ...value, comments: value.comments.filter(item => item.id !== comment.id) })); })}>Delete</button>}</div>{comment.parentId && <small className={styles.replyContext}>Replying to {comment.parentAuthorName}</small>}<p>{comment.body}</p><button className={styles.replyButton} onClick={() => { setReplyTo(comment); requestId.current = null; document.getElementById('comment')?.focus(); }}>Reply</button></article>)}
          {social.signedIn ? <form className={styles.commentForm} onSubmit={event => { event.preventDefault(); if (!draft.trim()) return; requestId.current ??= crypto.randomUUID(); void mutate(async () => { const data = await communityRequest<{ comment: HarnessComment }>(`harnesses/${id}/comments`, { method: 'POST', body: { body: draft, clientId: requestId.current, ...(replyTo ? { parentId: replyTo.id } : {}) } }); setSocial(value => ({ ...value, comments: [...value.comments.filter(item => item.id !== data.comment.id), data.comment] })); setDraft(''); setReplyTo(null); requestId.current = null; }); }}><label htmlFor="comment">{replyTo ? `Reply to ${replyTo.authorName}` : 'Join the conversation'}</label>{replyTo && <button type="button" className={styles.replyButton} onClick={() => { setReplyTo(null); requestId.current = null; }}>Cancel reply</button>}<textarea id="comment" required maxLength={2000} value={draft} onChange={event => { setDraft(event.target.value); requestId.current = null; }} placeholder="Ask a question or share an idea…" /><button className={styles.primary} disabled={busy || !draft.trim()}>{replyTo ? 'Post reply' : 'Post comment'}</button></form> : <SignIn />}
        </> : <div className={styles.transcript}>
          {harness.example && <p className={styles.contextNote}>{harness.recording ? 'Featured Store project. Watch the recorded run; fork the editable source. This is its published brief, not the original session transcript.' : 'Example conversation. The output and source files are real, editable starter projects.'}</p>}
          {harness.conversation.map((turn, index) => turn.role === 'tool' ? <details className={styles.tool} key={index}><summary>Tool output</summary><p>{turn.text}</p></details> : <div className={styles.turn} key={index}><small>{turn.role === 'user' ? harness.authorName : harness.engine}</small><p>{turn.text}</p></div>)}
        </div>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </aside></div>
    {social.mine && <div className={styles.manage}><button disabled={busy} onClick={() => { if (window.confirm('Remove this harness from the public feed? Existing downloaded forks remain with their owners.')) void mutate(async () => { await communityRequest(`harnesses/${id}`, { method: 'DELETE' }); setUnavailable(true); }); }}>Unpublish this harness</button></div>}
  </main></>;
}
