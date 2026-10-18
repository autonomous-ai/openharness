'use client';
import { useEffect, useState } from 'react';
import { sessionHeaders } from '@/lib/community/client';
import { onSessionChange } from '@/lib/community/session';

/** Whether this browser holds a Harness session: null until it has been read, so nothing flashes. */
export function useSignedIn(): boolean | null {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    const update = () => setSignedIn(!!sessionHeaders().Authorization);
    update();
    const stop = onSessionChange(update);
    window.addEventListener('focus', update);
    return () => { stop(); window.removeEventListener('focus', update); };
  }, []);
  return signedIn;
}
