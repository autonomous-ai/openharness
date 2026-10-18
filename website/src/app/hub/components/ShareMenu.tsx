'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Link2, Share2 } from 'lucide-react';
import { harnessPath } from '@/lib/community/slug';
import { shareNetworks, shareUrl } from '@/lib/community/share';
import { SocialIcon } from './SocialIcons';
import { useDismiss } from './useDismiss';
import community from '../community.module.css';
import styles from './share.module.css';

type Copy = 'idle' | 'copied' | 'failed';
const copyLabels: Record<Copy, string> = { idle: 'Copy link', copied: 'Link copied', failed: 'Copy failed' };

const noChange = () => () => {};
/** Whether this browser has a share sheet of its own; the server draws the menu without it. */
const useShareSheet = () => useSyncExternalStore(noChange, () => typeof navigator.share === 'function', () => false);

/** The copied link says so for two seconds, then the menu closes. */
function useCopy(onDone: () => void) {
  const [copy, setCopy] = useState<Copy>('idle');
  useEffect(() => {
    if (copy === 'idle') return;
    const timer = setTimeout(() => { setCopy('idle'); if (copy === 'copied') onDone(); }, copy === 'copied' ? 1200 : 2000);
    return () => clearTimeout(timer);
  }, [copy, onDone]);
  const copyText = (text: string) => navigator.clipboard.writeText(text).then(() => setCopy('copied'), () => setCopy('failed'));
  return { copy, copyText };
}

/** Share opens a menu: copy the harness's address, post it to X, Facebook or LinkedIn, or use the device's own sheet. */
export function ShareMenu({ harness }: { harness: { id: string; title: string } }) {
  const [open, setOpen] = useState(false), root = useRef<HTMLSpanElement>(null), sheet = useShareSheet();
  const close = useCallback(() => setOpen(false), []);
  const { copy, copyText } = useCopy(close);
  useDismiss(root, open, close);
  const url = () => `${window.location.origin}${harnessPath(harness)}`;
  // A sheet closed without choosing anything is not a failure to report.
  const openSheet = () => { close(); void navigator.share({ title: harness.title, url: url() }).catch(() => undefined); };
  return <span ref={root} className={styles.share}>
    <button type="button" className={community.actionButton} aria-haspopup="menu" aria-expanded={open} aria-pressed={open} onClick={() => setOpen(value => !value)}>
      <Link2 /><span className={community.actionLabel}>Share</span>
    </button>
    {open && <div className={styles.menu} role="menu" aria-label="Share this harness">
      <button type="button" role="menuitem" className={copy === 'copied' ? styles.done : ''} onClick={() => void copyText(url())}>
        {copy === 'copied' ? <Check /> : <Link2 />}<span aria-live="polite">{copyLabels[copy]}</span>
      </button>
      <hr />
      {shareNetworks.map(network => <a key={network.id} role="menuitem" href={shareUrl(network.id, url(), harness.title)} target="_blank" rel="noopener noreferrer" onClick={close}>
        <SocialIcon network={network.id} /><span>{network.label}</span>
      </a>)}
      {sheet && <><hr /><button type="button" role="menuitem" onClick={openSheet}><Share2 /><span>More options…</span></button></>}
    </div>}
  </span>;
}
