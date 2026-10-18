import { communityRequest } from './client';
import { harnessPath } from './slug';

/** Something that happened to the reader's work: who did it and where, never what they wrote. */
export type HubNotification = {
  id: string; kind: 'comment' | 'reply' | 'fork'; harnessId: string; harnessTitle: string;
  actorName: string; targetId: string; createdAt: string; read: boolean;
};

export const readNotifications = () => communityRequest<{ notifications: HubNotification[]; unread: number }>('notifications');
export const readUnread = async () => (await communityRequest<{ unread: number }>('notifications/unread')).unread;
export const markNotificationsRead = () => communityRequest('notifications/read', { method: 'POST' });

const verbs: Record<HubNotification['kind'], string> = { comment: 'commented on', reply: 'replied to your comment on', fork: 'forked' };

/** What a notification says (who, what they did, to which harness), and where it leads: the comments it is about, or the fork. */
export function describeNotification({ kind, actorName, harnessTitle, harnessId, targetId }: HubNotification): { text: string; verb: string; href: string } {
  const verb = verbs[kind], text = `${actorName} ${verb} ${harnessTitle}`;
  if (kind === 'fork') return { text, verb, href: `/hub/${targetId}` };
  return { text, verb, href: `${harnessPath({ id: harnessId, title: harnessTitle })}?comments=1` };
}

/** Said when the notifications page marks them read, so the bell clears without waiting for the next read. */
export const notificationsReadEvent = 'hub:notifications-read';
