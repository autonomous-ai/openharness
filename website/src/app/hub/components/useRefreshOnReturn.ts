'use client';
import { useEffect } from 'react';
import { sessionHeaders } from '@/lib/community/client';

const minGapMs = 30_000;

/**
 * Calls `refresh` when the reader comes back to this tab: at once after a sign-in or sign-out
 * elsewhere, otherwise at most every 30 seconds. Clicking into a page's output and back is not a return.
 */
export function useRefreshOnReturn(refresh: () => void) {
  useEffect(() => {
    let last = Date.now(), session = sessionHeaders().Authorization;
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      const current = sessionHeaders().Authorization;
      if (current === session && Date.now() - last < minGapMs) return;
      last = Date.now(); session = current; refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [refresh]);
}
