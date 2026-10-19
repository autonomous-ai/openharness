'use client';
import type { ReactNode } from 'react';
import Link from 'next/link';
import { Bell } from 'lucide-react';
import { Header, SignIn } from '../components/Header';
import { NotificationRow, NotificationSkeleton } from './NotificationRow';
import { useNotifications, type NotificationsState } from './useNotifications';
import { useHubView } from '../components/useHubView';
import community from '../community.module.css';
import styles from './notifications.module.css';

const subtitle = (state: NotificationsState) => state.status !== 'ready' || !state.items.length ? 'Comments, replies and forks of your work.'
  : state.unread ? `${state.unread} new` : 'You’re all caught up.';

/** A message in place of the list: no notifications yet, signed out, or a failed read. */
function Placeholder({ title, children }: { title: string; children: ReactNode }) {
  return <div className={styles.placeholder}><span className={styles.placeholderIcon} aria-hidden><Bell /></span><h2>{title}</h2>{children}</div>;
}

function Body({ state, retry }: ReturnType<typeof useNotifications>) {
  if (state.status === 'loading') return <NotificationSkeleton />;
  if (state.status === 'signedOut') return <Placeholder title="Sign in to see your notifications"><SignIn action="see your notifications" /></Placeholder>;
  if (state.status === 'failed') return <Placeholder title="Your notifications could not be loaded"><p role="alert">Check your connection and try again.</p><button type="button" className={styles.retry} onClick={retry}>Try again</button></Placeholder>;
  if (!state.items.length) return <Placeholder title="No notifications yet"><p>When someone comments on, replies to or forks your work, you’ll see it here.</p><Link className={community.textLink} href="/hub">Explore the Hub</Link></Placeholder>;
  const now = new Date();
  return <ul className={styles.list}>{state.items.map(item => <NotificationRow key={item.id} item={item} now={now} />)}</ul>;
}

/** The reader's notifications, latest first. */
export default function NotificationsPage() {
  const notifications = useNotifications();
  useHubView('notifications');
  return <><Header /><main className={`${community.wrap} ${styles.inbox}`}>
    <header className={styles.head}><h1>Notifications</h1><p>{subtitle(notifications.state)}</p></header>
    <Body {...notifications} />
  </main></>;
}
