'use client';
import { useEffect, useState } from 'react';
import { notificationsReadEvent, readUnread } from '@/lib/community/notifications';

/** How many of the reader's notifications are unread: read when signed in, again on returning to the tab, and none once their page marks them read. */
export function useUnread(signedIn: boolean | null): number {
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    if (!signedIn) return;
    // A read that started before the page marked them read must not bring the count back.
    let live = true, generation = 0;
    const update = () => {
      const current = ++generation;
      readUnread().then(count => { if (live && current === generation) setUnread(count); }, () => { /* The bell stays as it was. */ });
    };
    const clear = () => { generation++; setUnread(0); };
    update();
    window.addEventListener('focus', update);
    window.addEventListener(notificationsReadEvent, clear);
    return () => { live = false; window.removeEventListener('focus', update); window.removeEventListener(notificationsReadEvent, clear); };
  }, [signedIn]);
  return signedIn ? unread : 0;
}
