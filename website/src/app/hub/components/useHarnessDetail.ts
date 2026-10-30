'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { communityRequest, emptySocial, CommunityError } from '@/lib/community/client';
import { commentTotal, keepEarlier } from '@/lib/community/comments';
import { postReport, type ReportReason } from '@/lib/community/reports';
import { putFollow, putLike } from '@/lib/community/social';
import type { HarnessComment, OpenHarness, SocialState } from '@/lib/community/types';
import { useRefreshOnReturn } from './useRefreshOnReturn';
import { countHub } from '@/lib/community/hubMeasure';

/**
 * One harness page's data and the reader's actions on it. Writes run one at a time, and a read that
 * started before a write never lands after it. `onSignIn` is called when an action needs an account.
 * `address` is the page's (an id or a slug); once read, every request names the publication by its id.
 */
export function useHarnessDetail(address: string, initial: OpenHarness | null, onSignIn: () => void) {
  const [harness, setHarness] = useState(initial), [social, setSocial] = useState(emptySocial);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [unavailable, setUnavailable] = useState(false);
  // A failed read of a page already drawn: said aloud, since without it the author's Edit silently vanishes.
  const [failed, setFailed] = useState(false);
  // This reader reported the harness: it is hidden from them from now on.
  const [reported, setReported] = useState(false);
  const revision = useRef(0), writing = useRef(false), loaded = useRef(!!initial), id = useRef(initial?.id ?? address);
  // When the publication drawn here was last edited: a refresh that reports a later edit reads it again.
  const version = useRef(initial?.updatedAt ?? null);

  /**
   * Once its files are here, a refresh reads only likes, follows and comments, unless its author has
   * edited it since. A backend older than `/social` answers 404 there, so the full read tells that
   * apart from an unpublished harness. The page draws only the output, so the full read asks for that file.
   */
  const read = useCallback(async () => {
    type Page = { harness?: OpenHarness | null; social: SocialState };
    if (loaded.current) {
      try {
        const page = await communityRequest<Page>(`harnesses/${id.current}/social`);
        // An older backend says nothing of edits: the drawn page stands, as it did.
        if (page.social.updatedAt === undefined || page.social.updatedAt === version.current) return page;
      } catch (e) {
        if (!(e instanceof CommunityError && e.status === 404)) throw e;
      }
    }
    return communityRequest<Page>(`harnesses/${id.current}?files=viewer`);
  }, []);
  const load = useCallback(async () => {
    if (writing.current) return;
    const current = ++revision.current;
    try {
      const data = await read();
      if (current !== revision.current) return;
      if (data.harness) { loaded.current = true; id.current = data.harness.id; version.current = data.harness.updatedAt ?? null; setHarness(data.harness); }
      setSocial(previous => ({ ...data.social, comments: keepEarlier(previous.comments, data.social.comments) })); setReady(true); setError(''); setFailed(false);
    } catch (e) {
      if (current !== revision.current) return;
      setReady(false);
      if (e instanceof CommunityError && e.status === 404) setUnavailable(true);
      else if (!initial) setError('This harness could not be loaded. Please try again.');
      else setFailed(true);
    }
  }, [read, initial]);
  useEffect(() => {
    void load();
    return () => { revision.current++; };
  }, [load]);
  const reload = useCallback(() => { void load(); }, [load]);
  useRefreshOnReturn(reload);

  /** Runs one write, reporting whether it succeeded. */
  async function mutate(action: () => Promise<void>): Promise<boolean> {
    if (!social.signedIn) { onSignIn(); return false; }
    if (writing.current) return false;
    writing.current = true; revision.current++;
    setBusy(true); setError('');
    try { await action(); return true; } catch (e) {
      const expired = e instanceof CommunityError && e.status === 401;
      if (expired) { setSocial(value => ({ ...value, signedIn: false })); onSignIn(); }
      setError(expired ? 'Your sign-in has expired. Sign in to Harness again to continue.' : e instanceof Error ? e.message : 'Please try again.');
      return false;
    } finally { writing.current = false; setBusy(false); }
  }

  const follow = () => mutate(async () => {
    if (!harness) return;
    countHub('hub_follow');
    const next = !social.following;
    await putFollow(harness.authorId, next);
    setSocial(value => ({ ...value, following: next }));
  });
  const like = () => mutate(async () => {
    countHub('hub_like');
    const result = await putLike(id.current, !social.liked);
    setSocial(value => ({ ...value, ...result }));
  });
  /** A comment gone from this page: deleted, or reported (hidden from its reporter at once). */
  const dropComment = (comment: HarnessComment) =>
    setSocial(value => ({ ...value, comments: value.comments.filter(item => item.id !== comment.id), commentCount: commentTotal(value) - 1 }));
  const removeComment = (comment: HarnessComment) => mutate(async () => {
    await communityRequest(`harnesses/${id.current}/comments/${comment.id}`, { method: 'DELETE' });
    dropComment(comment);
  });
  const report = (reason: ReportReason) => mutate(async () => { await postReport('harness', id.current, reason); countHub('hub_report'); setReported(true); });
  const reportComment = (comment: HarnessComment, reason: ReportReason) => mutate(async () => { await postReport('comment', comment.id, reason); countHub('hub_report'); dropComment(comment); });
  /** `clientId` makes a retried post return the same comment rather than a second one. */
  const postComment = (body: string, clientId: string, parentId?: string) => mutate(async () => {
    const data = await communityRequest<{ comment: HarnessComment }>(`harnesses/${id.current}/comments`, { method: 'POST', body: { body, clientId, ...(parentId ? { parentId } : {}) } });
    countHub('hub_comment_post');
    // A retried post answers with the comment it already made: replaced, not counted twice.
    setSocial(value => {
      const known = value.comments.some(item => item.id === data.comment.id);
      return { ...value, comments: [...value.comments.filter(item => item.id !== data.comment.id), data.comment], commentCount: commentTotal(value) + (known ? 0 : 1) };
    });
  });
  /** The page of comments before the oldest one here, which the page does not read at first; false when it could not be read. */
  const loadEarlier = async (): Promise<boolean> => {
    const oldest = social.comments[0];
    if (!oldest) return true;
    try {
      const { comments } = await communityRequest<{ comments: HarnessComment[] }>(`harnesses/${id.current}/comments?before=${oldest.id}`);
      setSocial(value => ({ ...value, comments: [...comments.filter(comment => !value.comments.some(known => known.id === comment.id)), ...value.comments] }));
      return true;
    } catch { return false; }
  };
  return { harness, social, ready, failed, error, busy, unavailable, reported, load, follow, like, removeComment, postComment, loadEarlier, report, reportComment };
}
