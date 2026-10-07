'use client';
import { useEffect, useState } from 'react';
import { sessionHeaders } from '@/lib/community/client';

/** Whether this browser holds a Harness session: null until it has been read, so nothing flashes. */
export function useSignedIn(): boolean | null {
  const [signedIn, setSignedIn] = useState<boolean | null>(null);
  useEffect(() => {
    const update = () => setSignedIn(!!sessionHeaders().Authorization);
    const events = ['focus', 'storage', 'harness-session'];
    update();
    for (const event of events) window.addEventListener(event, update);
    return () => { for (const event of events) window.removeEventListener(event, update); };
  }, []);
  return signedIn;
}
