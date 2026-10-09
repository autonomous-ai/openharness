'use client';
import { useRef, useSyncExternalStore, type RefObject } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import { previewDocument } from '@/lib/community/preview';
import type { OpenHarness } from '@/lib/community/types';
import styles from '../community.module.css';

const onFullscreenChange = (notify: () => void) => {
  document.addEventListener('fullscreenchange', notify);
  return () => document.removeEventListener('fullscreenchange', notify);
};

/** Whether `target` fills the screen, and a toggle for it. The server draws no toggle. */
function useFullscreen(target: RefObject<HTMLElement | null>) {
  const supported = useSyncExternalStore(onFullscreenChange, () => document.fullscreenEnabled, () => false);
  const active = useSyncExternalStore(onFullscreenChange, () => !!target.current && document.fullscreenElement === target.current, () => false);
  const toggle = () => { void (document.fullscreenElement ? document.exitFullscreen() : target.current?.requestFullscreen()); };
  return { supported, active, toggle };
}

/**
 * The output beside its source conversation, or a starter's recorded run. The output can fill the
 * screen; it never opens in its own tab, where it would run on the Hub's origin instead of in the sandbox.
 */
export function Viewer({ harness }: { harness: OpenHarness }) {
  const section = useRef<HTMLElement>(null), fullscreen = useFullscreen(section);
  const html = harness.files.find(file => file.path === harness.viewerPath)?.content || '';
  if (harness.recording) return <section className={styles.viewer} aria-label="Output viewer">
    <video className={styles.recording} controls playsInline preload="metadata" poster={harness.cover} aria-label={`${harness.title} recorded run`} src={harness.recording} />
  </section>;
  return <section ref={section} className={styles.viewer} aria-label="Output viewer">
    <iframe title={`${harness.title} output`} srcDoc={previewDocument(html)} sandbox={harness.example ? 'allow-scripts allow-downloads allow-modals' : 'allow-scripts'} referrerPolicy="no-referrer" />
    {/* Under the output, never over it: a corner control would cover the page's own controls. */}
    {fullscreen.supported && <div className={styles.viewerBar}>
      <button type="button" onClick={fullscreen.toggle} aria-label={fullscreen.active ? 'Exit full screen' : 'View output full screen'}>
        {fullscreen.active ? <Minimize2 /> : <Maximize2 />}<span>{fullscreen.active ? 'Exit full screen' : 'Full screen'}</span>
      </button>
    </div>}
  </section>;
}
