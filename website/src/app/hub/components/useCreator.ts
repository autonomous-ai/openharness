'use client';
import { useCallback, useEffect, useState } from 'react';
import { CommunityError, communityRequest } from '@/lib/community/client';
import { onSessionChange } from '@/lib/community/session';
import { putFollow } from '@/lib/community/social';
import type { Creator } from '@/lib/community/types';
import { countHub } from '@/lib/community/hubMeasure';

/**
 * A creator's page: who they are, read again with the reader's sign-in (the server read it as a
 * visitor), and following them. `unavailable` once the Hub says there is no such creator.
 */
export function useCreator(id: string, initial: Creator | null) {
  const [creator, setCreator] = useState(initial), [unavailable, setUnavailable] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [signIn, setSignIn] = useState(false);
  const load = useCallback(async () => {
    try {
      setCreator((await communityRequest<{ creator: Creator }>(`creators/${id}`)).creator); setError('');
    } catch (e) {
      if (e instanceof CommunityError && e.status === 404) setUnavailable(true);
      else setError('This creator could not be loaded. Please try again.');
    }
  }, [id]);
  useEffect(() => {
    void load();
    return onSessionChange(() => { void load(); });
  }, [load]);
  async function follow() {
    if (!creator || busy) return;
    if (!creator.signedIn) { setSignIn(true); return; }
    countHub('hub_follow');
    const next = !creator.following;
    setBusy(true); setError('');
    try {
      await putFollow(id, next);
      setCreator(value => value && { ...value, following: next, followers: Math.max(0, value.followers + (next ? 1 : -1)) });
    } catch (e) {
      if (e instanceof CommunityError && e.status === 401) setSignIn(true);
      else setError(e instanceof Error ? e.message : 'Please try again.');
    } finally { setBusy(false); }
  }
  return { creator, unavailable, busy, error, signIn, load, follow };
}
