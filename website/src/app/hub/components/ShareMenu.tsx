'use client';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Check, Link2, Share2 } from 'lucide-react';
import { harnessPath } from '@/lib/community/slug';
import { shareNetworks, shareUrl } from '@/lib/community/share';
import { SocialIcon } from './SocialIcons';
import { useDismiss } from './useDismiss';
import { useMenuKeys } from './useMenuKeys';
import { countHub } from '@/lib/community/hubMeasure';
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
  const [open, setOpen] = useState(false), root = useRef<HTMLSpanElement>(null), menu = useRef<HTMLDivElement>(null), button = useRef<HTMLButtonElement>(null);
  const sheet = useShareSheet(), close = useCallback(() => setOpen(false), []);
  const { copy, copyText } = useCopy(close);
  useDismiss(root, open, close);
  const onMenuKey = useMenuKeys(menu, button, open, close);
  const url = () => `${window.location.origin}${harnessPath(harness)}`;
  // A sheet closed without choosing anything is not a failure to report.
  const openSheet = () => { countHub('hub_share_sheet'); close(); void navigator.share({ title: harness.title, url: url() }).catch(() => undefined); };
  return <span ref={root} className={styles.share}>
    <button ref={button} type="button" className={community.actionButton} aria-haspopup="menu" aria-expanded={open} onClick={() => { if (!open) countHub('hub_share_open'); setOpen(!open); }}
      onKeyDown={event => { if (event.key === 'ArrowDown' && !open) { event.preventDefault(); countHub('hub_share_open'); setOpen(true); } }}>
      <Link2 /><span className={community.actionLabel}>Share</span>
    </button>
    {/* Focus leaving the menu (a click elsewhere, Tab past its end) closes it, as useDismiss does for the pointer. */}
    {open && <div ref={menu} className={styles.menu} role="menu" aria-label="Share this harness" onKeyDown={onMenuKey}
      onBlur={event => { if (!root.current?.contains(event.relatedTarget as Node | null)) close(); }}>
      <button type="button" role="menuitem" className={copy === 'copied' ? styles.done : ''} onClick={() => { countHub('hub_share_copy'); void copyText(url()); }}>
        {copy === 'copied' ? <Check /> : <Link2 />}<span aria-live="polite">{copyLabels[copy]}</span>
      </button>
      <hr />
      {shareNetworks.map(network => <a key={network.id} role="menuitem" href={shareUrl(network.id, url(), harness.title)} target="_blank" rel="noopener noreferrer" onClick={() => { countHub(`hub_share_${network.id}`); close(); }}>
        <SocialIcon network={network.id} /><span>{network.label}</span>
      </a>)}
      {sheet && <><hr /><button type="button" role="menuitem" onClick={openSheet}><Share2 /><span>More options…</span></button></>}
    </div>}
  </span>;
}
