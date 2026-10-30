'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import type { OpenHarness } from '@/lib/community/types';
import { DetailHead, type Panel } from './DetailHead';
import { DetailNotice } from './DetailNotice';
import { Forks } from './Forks';
import { Header } from './Header';
import { ReportForm } from './ReportForm';
import { SidePanel } from './SidePanel';
import { useCanonicalAddress } from './useCanonicalAddress';
import { useHarnessDwell, useHubView } from './useHubView';
import { countHub } from '@/lib/community/hubMeasure';
import { Unavailable } from './Unavailable';
import { useHarnessDetail } from './useHarnessDetail';
import { Viewer } from './Viewer';
import styles from '../community.module.css';

export default function Detail({ id, initial, initialComments = false }: { id: string; initial: OpenHarness | null; initialComments?: boolean }) {
  const [panel, setPanel] = useState<Panel>(initialComments ? 'comments' : 'log'), [reporting, setReporting] = useState(false);
  const page = useHarnessDetail(id, initial, () => setPanel('comments'));
  const { harness, social, ready, busy } = page;
  useCanonicalAddress(harness); useHubView('harness'); useHarnessDwell();
  if (page.unavailable || page.reported) return <Unavailable what="harness" reported={page.reported} />;
  if (!harness) return <><Header /><main className={`${styles.wrap} ${styles.loading}`}>{page.error || 'Loading harness…'}{page.error && <button onClick={() => void page.load()}>Retry</button>}</main></>;
  // A panel's button opens it; pressed again, it returns to the chat log.
  const toggle = (next: Panel) => {
    if (panel !== next && next !== 'log') countHub(next === 'comments' ? 'hub_comments_open' : 'hub_files_open');
    setPanel(current => current === next ? 'log' : next);
  };
  return <><Header /><main className={`${styles.wrap} ${styles.detail}`}>
    <Link className={styles.back} href="/hub"><ArrowLeft /> All harnesses</Link>
    <DetailHead harness={harness} social={social} ready={ready} busy={busy} panel={panel} onFollow={() => void page.follow()} onLike={() => void page.like()} onPanel={toggle} onReport={() => setReporting(true)} />
    {reporting && <ReportForm what="harness" onReport={page.report} onCancel={() => setReporting(false)} />}
    <DetailNotice social={social} ready={ready} failed={page.failed} onRetry={() => void page.load()} />
    <div className={styles.split}><Viewer harness={harness} />
      <SidePanel harness={harness} social={social} ready={ready} failed={page.failed || !!page.error} busy={busy} panel={panel} error={page.error}
        onClose={() => setPanel('log')} onRetry={() => void page.load()} onEarlier={page.loadEarlier} onReport={page.reportComment} onRemove={comment => void page.removeComment(comment)} onPost={page.postComment} />
    </div>
    {!!social.forks && <Forks id={harness.id} count={social.forks} />}
  </main></>;
}
