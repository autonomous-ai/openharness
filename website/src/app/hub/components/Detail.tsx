'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { OpenHarness } from '@/lib/community/types';
import { DetailHead, type Panel } from './DetailHead';
import { Forks } from './Forks';
import { Header } from './Header';
import { SidePanel } from './SidePanel';
import { useHarnessDetail } from './useHarnessDetail';
import { Viewer } from './Viewer';
import styles from '../community.module.css';

export default function Detail({ id, initial, initialComments = false }: { id: string; initial: OpenHarness | null; initialComments?: boolean }) {
  const [panel, setPanel] = useState<Panel>(initialComments ? 'comments' : 'log');
  const page = useHarnessDetail(id, initial, () => setPanel('comments'));
  const { harness, social, ready, busy } = page;
  if (page.unavailable) return <><Header /><main className={`${styles.wrap} ${styles.empty}`}><h1>This harness is unavailable.</h1><Link className={styles.textLink} href="/hub">Back to Explore</Link></main></>;
  if (!harness) return <><Header /><main className={`${styles.wrap} ${styles.loading}`}>{page.error || 'Loading harness…'}{page.error && <button onClick={() => void page.load()}>Retry</button>}</main></>;
  const unpublish = () => { if (window.confirm('Remove this harness from the public feed? Existing downloaded forks remain with their owners.')) void page.unpublish(); };
  // A panel's button opens it; pressed again, it returns to the chat log.
  const toggle = (next: Panel) => setPanel(current => current === next ? 'log' : next);
  return <><Header /><main className={`${styles.wrap} ${styles.detail}`}>
    <Link className={styles.back} href="/hub"><ArrowLeft /> All harnesses</Link>
    <DetailHead harness={harness} social={social} ready={ready} busy={busy} panel={panel} onFollow={() => void page.follow()} onLike={() => void page.like()} onPanel={toggle} />
    <div className={styles.split}><Viewer harness={harness} />
      <SidePanel harness={harness} social={social} ready={ready} busy={busy} panel={panel} error={page.error}
        onClose={() => setPanel('log')} onRetry={() => void page.load()} onRemove={comment => void page.removeComment(comment)} onPost={page.postComment} />
    </div>
    {!!social.forks && <Forks id={id} count={social.forks} />}
    {social.mine && <div className={styles.manage}><button disabled={busy} onClick={unpublish}>Unpublish this harness</button></div>}
  </main></>;
}
