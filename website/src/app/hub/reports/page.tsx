'use client';
import Link from 'next/link';
import { reportReasons, type ReportedItem } from '@/lib/community/reports';
import { Header } from '../components/Header';
import { useReviewQueue } from './useReviewQueue';
import styles from '../community.module.css';

const reasonLabel = new Map<string, string>(reportReasons);
const stateLabel: Record<ReportedItem['state'], string> = { visible: 'Still shown', hidden: 'Hidden after reports', restored: 'Restored', removed: 'Removed' };
const reasons = (item: ReportedItem) => Object.entries(item.reasons).map(([reason, count]) => `${reasonLabel.get(reason) ?? reason} ${count}`).join(' · ');

function ReportedRow({ item, busy, onReview }: { item: ReportedItem; busy: boolean; onReview: (decision: 'restore' | 'remove') => void }) {
  const remove = () => { if (window.confirm(item.targetType === 'harness' ? 'Unpublish this harness?' : 'Delete this comment?')) onReview('remove'); };
  return <article className={styles.review}>
    <strong>{item.targetType === 'harness' ? 'Harness' : 'Comment'} · {item.reports} {item.reports === 1 ? 'report' : 'reports'} · {stateLabel[item.state]}</strong>
    <p>{item.text ?? 'No longer available.'}{item.authorName ? ` — ${item.authorName}` : ''}</p>
    <small>{reasons(item)}</small>
    <Link className={styles.textLink} href={`/hub/${item.harnessId}`}>Open the harness</Link>
    {item.state !== 'removed' && <div className={styles.submitRow}>
      {item.state !== 'restored' && <button type="button" disabled={busy} onClick={() => onReview('restore')}>Restore</button>}
      <button type="button" className={styles.danger} disabled={busy} onClick={remove}>Remove</button>
    </div>}
  </article>;
}

/** Where the Hub's reviewers decide on what readers reported: restore it, or remove it. */
export default function ReportsPage() {
  const queue = useReviewQueue();
  return <><Header /><main className={`${styles.wrap} ${styles.publish}`}>
    <h1>Reports</h1>
    {queue.forbidden && <p className={styles.notice}>Only the Hub’s reviewers can see reports.</p>}
    {queue.error && <p className={styles.error} role="alert">{queue.error}<button onClick={() => void queue.load()}>Retry</button></p>}
    {queue.items && !queue.items.length && <p className={styles.notice}>Nothing has been reported.</p>}
    {queue.items?.map(item => <ReportedRow key={`${item.targetType}:${item.targetId}`} item={item} busy={queue.busy} onReview={decision => void queue.review(item, decision)} />)}
  </main></>;
}
