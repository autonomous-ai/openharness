'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { communityRequest, emptySocial, CommunityError } from '@/lib/community/client';
import type { HarnessComment, OpenHarness, SocialState } from '@/lib/community/types';

/**
 * One harness page's data and the reader's actions on it. Writes run one at a time, and a read that
 * started before a write never lands after it. `onSignIn` is called when an action needs an account.
 */
export function useHarnessDetail(id: string, initial: OpenHarness | null, onSignIn: () => void) {
  const [harness, setHarness] = useState(initial), [social, setSocial] = useState(emptySocial);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [ready, setReady] = useState(false), [unavailable, setUnavailable] = useState(false);
  const revision = useRef(0), writing = useRef(false), loaded = useRef(!!initial);

  /**
   * A publication never changes: once its files are here, a refresh reads only likes, follows and
   * comments. A backend older than `/social` answers 404 there, so the full read tells that apart
   * from an unpublished harness.
   */
  const read = useCallback(async () => {
    type Page = { harness?: OpenHarness | null; social: SocialState };
    if (loaded.current) {
      try { return await communityRequest<Page>(`harnesses/${id}/social`); } catch (e) {
        if (!(e instanceof CommunityError && e.status === 404)) throw e;
      }
    }
    return communityRequest<Page>(`harnesses/${id}`);
  }, [id]);
  const load = useCallback(async () => {
    if (writing.current) return;
    const current = ++revision.current;
    try {
      const data = await read();
      if (current !== revision.current) return;
      if (data.harness) { loaded.current = true; setHarness(data.harness); }
      setSocial(data.social); setReady(true); setError('');
    } catch (e) {
      if (current !== revision.current) return;
      setReady(false);
      if (e instanceof CommunityError && e.status === 404) setUnavailable(true);
      else if (!initial) setError('This harness could not be loaded. Please try again.');
    }
  }, [read, initial]);
  useEffect(() => {
    void load();
    const reload = () => { void load(); };
    window.addEventListener('focus', reload);
    return () => { revision.current++; window.removeEventListener('focus', reload); };
  }, [load]);

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
    const next = !social.following;
    await communityRequest(`creators/${harness!.authorId}/follow`, { method: 'PUT', body: { following: next } });
    setSocial(value => ({ ...value, following: next }));
  });
  const like = () => mutate(async () => {
    const result = await communityRequest<{ liked: boolean; likes: number }>(`harnesses/${id}/like`, { method: 'PUT', body: { liked: !social.liked } });
    setSocial(value => ({ ...value, ...result }));
  });
  const removeComment = (comment: HarnessComment) => mutate(async () => {
    await communityRequest(`harnesses/${id}/comments/${comment.id}`, { method: 'DELETE' });
    setSocial(value => ({ ...value, comments: value.comments.filter(item => item.id !== comment.id) }));
  });
  /** `clientId` makes a retried post return the same comment rather than a second one. */
  const postComment = (body: string, clientId: string, parentId?: string) => mutate(async () => {
    const data = await communityRequest<{ comment: HarnessComment }>(`harnesses/${id}/comments`, { method: 'POST', body: { body, clientId, ...(parentId ? { parentId } : {}) } });
    setSocial(value => ({ ...value, comments: [...value.comments.filter(item => item.id !== data.comment.id), data.comment] }));
  });
  const unpublish = () => mutate(async () => {
    await communityRequest(`harnesses/${id}`, { method: 'DELETE' });
    setUnavailable(true);
  });

  return { harness, social, ready, error, busy, unavailable, load, follow, like, removeComment, postComment, unpublish };
}
