'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { CommunityError } from '@/lib/community/client';
import { markNotificationsRead, notificationsReadEvent, readNotifications, type HubNotification } from '@/lib/community/notifications';

export type NotificationsState =
  | { status: 'loading' } | { status: 'signedOut' } | { status: 'failed' }
  | { status: 'ready'; items: HubNotification[]; unread: number };

/**
 * The reader's notifications, latest first. Opening them marks them read on the Hub and clears the
 * bell; the ones that were new stay marked as new on this page until it is left.
 */
export function useNotifications() {
  const [state, setState] = useState<NotificationsState>({ status: 'loading' });
  const live = useRef(true);
  const load = useCallback(async () => {
    setState({ status: 'loading' });
    try {
      const { notifications, unread } = await readNotifications();
      if (!live.current) return;
      setState({ status: 'ready', items: notifications, unread });
      if (!unread) return;
      await markNotificationsRead();
      window.dispatchEvent(new Event(notificationsReadEvent));
    } catch (e) {
      if (!live.current) return;
      // Marking them read can fail after they are drawn: they stay unread for next time.
      setState(current => current.status === 'ready' ? current : { status: e instanceof CommunityError && e.status === 401 ? 'signedOut' : 'failed' });
    }
  }, []);
  useEffect(() => {
    live.current = true;
    void load();
    return () => { live.current = false; };
  }, [load]);
  return { state, retry: () => void load() };
}
