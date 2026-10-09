'use client';
import { useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import { commentTotal } from '@/lib/community/comments';
import type { HarnessComment, OpenHarness, SocialState } from '@/lib/community/types';
import { Comments } from './Comments';
import type { Panel } from './DetailHead';
import { HarnessFiles } from './HarnessFiles';
import { HarnessTags } from './HarnessTags';
import { Transcript } from './Transcript';
import { useHarnessFiles } from './useHarnessFiles';
import styles from '../community.module.css';

type Props = {
  harness: OpenHarness; social: SocialState; ready: boolean; busy: boolean; panel: Panel; error: string;
  onClose: () => void; onRetry: () => void; onRemove: (comment: HarnessComment) => void;
  onPost: (body: string, clientId: string, parentId?: string) => Promise<boolean>;
};

const titles: Record<Panel, string> = { log: 'Chat log', comments: 'Comments', files: 'Source files' };

/** On a phone the panel sits under the output: one the reader opens is brought into view, not left below it. */
function useRevealOnOpen(panel: Panel) {
  const aside = useRef<HTMLElement>(null), opened = useRef(panel);
  useEffect(() => {
    if (panel === opened.current) return;
    opened.current = panel;
    if (panel !== 'log' && window.matchMedia?.('(max-width: 760px)').matches) aside.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [panel]);
  return aside;
}

/** Beside the output: the agent's chat log, or the comments, or the project's files. */
export function SidePanel({ harness, social, ready, busy, panel, error, onClose, onRetry, onRemove, onPost }: Props) {
  const files = useHarnessFiles(harness.id, panel === 'files'), aside = useRevealOnOpen(panel);
  const title = panel === 'comments' && ready ? `Comments · ${commentTotal(social)}` : titles[panel];
  return <aside ref={aside} className={styles.chat} aria-label={panel === 'log' ? 'Agent chat log' : titles[panel]}>
    <div className={styles.chatHead}><h2>{title}</h2>{panel === 'log' ? <HarnessTags harness={harness} /> : <button className={styles.icon} onClick={onClose} aria-label="Back to chat log"><X /></button>}</div>
    {panel === 'log' && <Transcript harness={harness} />}
    {panel === 'comments' && <Comments social={social} ready={ready} busy={busy} onRetry={onRetry} onRemove={onRemove} onPost={onPost} />}
    {panel === 'files' && <HarnessFiles id={harness.id} files={files.files} error={files.error} onRetry={() => void files.load()} />}
    {error && <p className={styles.error} role="alert">{error}</p>}
  </aside>;
}
