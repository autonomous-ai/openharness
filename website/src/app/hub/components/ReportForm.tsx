'use client';
import { useState, type FormEvent } from 'react';
import { reportReasons, type ReportReason } from '@/lib/community/reports';
import styles from '../community.module.css';

type Props = { what: 'harness' | 'comment'; onReport: (reason: ReportReason) => Promise<boolean>; onCancel: () => void };

/** Why a reader reports a harness or comment: one fixed reason, no words of their own. */
export function ReportForm({ what, onReport, onCancel }: Props) {
  const [reason, setReason] = useState<ReportReason | null>(null), [sending, setSending] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!reason || sending) return;
    setSending(true);
    await onReport(reason);
    setSending(false);
  }
  return <form className={styles.reportForm} aria-label={`Report this ${what}`} onSubmit={event => void submit(event)}>
    <strong>Why are you reporting this {what}?</strong>
    {reportReasons.map(([value, label]) => <label key={value} className={styles.check}>
      <input type="radio" name="reason" value={value} checked={reason === value} onChange={() => setReason(value)} /><span>{label}</span>
    </label>)}
    <small>You will not see it again. The Hub’s reviewers see the reason, not who reported it.</small>
    <div className={styles.submitRow}>
      <button className={styles.primary} disabled={!reason || sending}>{sending ? 'Reporting…' : 'Report'}</button>
      <button type="button" onClick={onCancel}>Cancel</button>
    </div>
  </form>;
}
