import { previewDocument } from '@/lib/community/preview';
import type { OpenHarness } from '@/lib/community/types';
import styles from '../community.module.css';

/** A session that made nothing to look at: its source, readable in place. */
function SourceFiles({ harness }: { harness: OpenHarness }) {
  return <div className={styles.sourceFiles}>
    {harness.files.map(file => <details key={file.path}>
      <summary>{file.path}</summary>
      {file.encoding ? <p>Binary file, included when you fork.</p> : <pre className={styles.sourceText}>{file.content}</pre>}
    </details>)}
  </div>;
}

/** What a harness made: its running output, a starter's recorded run, or else its cover or its files. */
export function Viewer({ harness }: { harness: OpenHarness }) {
  const html = harness.viewerPath ? harness.files.find(file => file.path === harness.viewerPath)?.content : undefined;
  const body = harness.recording
    ? <video className={styles.recording} controls playsInline preload="metadata" poster={harness.cover} aria-label={`${harness.title} recorded run`} src={harness.recording} />
    : html !== undefined
      ? <iframe title={`${harness.title} output`} srcDoc={previewDocument(html)} sandbox={harness.example ? 'allow-scripts allow-downloads allow-modals' : 'allow-scripts'} referrerPolicy="no-referrer" />
      : harness.cover
        ? <img className={styles.viewerCover} src={harness.cover} alt={`${harness.title} cover`} />
        : <SourceFiles harness={harness} />;
  return <section className={styles.viewer} aria-label={html !== undefined || harness.recording ? 'Output viewer' : 'Project'}>{body}</section>;
}
