import Link from 'next/link';
import { GitFork, MessageCircle, Reply, type LucideIcon } from 'lucide-react';
import { describeNotification, type HubNotification } from '@/lib/community/notifications';
import { timeAgo } from '@/lib/community/time';
import styles from './notifications.module.css';

const icons: Record<HubNotification['kind'], LucideIcon> = { comment: MessageCircle, reply: Reply, fork: GitFork };

/** One notification: who (their initial, with what they did as a badge), the sentence, and when. */
export function NotificationRow({ item, now }: { item: HubNotification; now: Date }) {
  const { text, verb, href } = describeNotification(item), Icon = icons[item.kind];
  return <li><Link href={href} className={`${styles.row} ${item.read ? '' : styles.unread}`} aria-label={`${text}${item.read ? '' : ', new'}`}>
    <span className={styles.avatar} aria-hidden>{item.actorName.trim().charAt(0).toUpperCase() || '?'}<span className={styles.kind}><Icon /></span></span>
    <span className={styles.text}><strong>{item.actorName}</strong> {verb} <strong>{item.harnessTitle}</strong></span>
    <time className={styles.time} dateTime={item.createdAt} title={new Date(item.createdAt).toLocaleString()}>{timeAgo(item.createdAt, now)}</time>
  </Link></li>;
}

/** Rows in the shape of the list while it loads, so it does not jump when it lands. */
export function NotificationSkeleton() {
  return <ul className={styles.list} aria-hidden>{[0, 1, 2, 3].map(index => <li key={index} className={styles.skeleton}><span /><span /></li>)}</ul>;
}
