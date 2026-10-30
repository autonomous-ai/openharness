'use client';
import { useEffect } from 'react';
import { X } from 'lucide-react';
import { SignIn } from './Header';
import styles from './toast.module.css';

type Props = { error: string; signIn: boolean; onDismiss: () => void };

/** What became of a like, at the bottom of the screen where the reader can see it, whichever card they are at; it leaves after a while. */
export function FeedToast({ error, signIn, onDismiss }: Props) {
  const open = signIn || !!error;
  useEffect(() => {
    if (!open) return;
    const timer = setTimeout(onDismiss, 8000);
    return () => clearTimeout(timer);
  }, [open, error, signIn, onDismiss]);
  if (!open) return null;
  return <div className={styles.toast} role="status">
    {signIn ? <SignIn action="like harnesses and follow creators" /> : <p>{error}</p>}
    <button type="button" aria-label="Dismiss" onClick={onDismiss}><X /></button>
  </div>;
}
