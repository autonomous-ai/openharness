'use client';
import { useEffect, useState } from 'react';
import { Check, Link2 } from 'lucide-react';
import styles from '../community.module.css';

type Copy = 'idle' | 'copied' | 'failed';
const labels: Record<Copy, string> = { idle: 'Share', copied: 'Link copied', failed: 'Copy failed' };

/** Copies the harness's address, and says so for two seconds. */
export function ShareButton({ id }: { id: string }) {
  const [copy, setCopy] = useState<Copy>('idle');
  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => setCopy('idle'), 2000);
    return () => clearTimeout(timer);
  }, [copy]);
  async function share() {
    try { await navigator.clipboard.writeText(`${window.location.origin}/hub/${id}`); setCopy('copied'); } catch { setCopy('failed'); }
  }
  return <button type="button" aria-label="Copy link to this harness" onClick={() => void share()}>
    {copy === 'copied' ? <Check /> : <Link2 />}<span className={styles.actionLabel} aria-live="polite">{labels[copy]}</span>
  </button>;
}
