'use client';
import { useEffect } from 'react';
import { harnessPath } from '@/lib/community/slug';

/**
 * A harness page the browser read itself (the server could not: a staging publication, or a slow Hub)
 * shows the address the server would have moved it to, without reloading.
 */
export function useCanonicalAddress(harness: { id: string; title: string } | null) {
  const path = harness ? harnessPath(harness) : null;
  useEffect(() => {
    if (!path || window.location.pathname === path) return;
    window.history.replaceState(window.history.state, '', `${path}${window.location.search}${window.location.hash}`);
  }, [path]);
}
