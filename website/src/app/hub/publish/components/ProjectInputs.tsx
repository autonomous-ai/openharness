import styles from '../../community.module.css';

const first = (files: FileList | null, pick: (file: File) => void) => { const file = files?.[0]; if (file) pick(file); };

/** Where a project comes from: its folder, or the fork bundle it started as. */
export function SourceInputs({ onFolder, onBundle }: { onFolder: (files: FileList) => void; onBundle: (file: File) => void }) {
  return <>
    <label className={`${styles.field} ${styles.wide}`}>Project folder<input type="file" multiple ref={element => { element?.setAttribute('webkitdirectory', ''); }} aria-label="Choose project folder" onChange={event => { if (event.target.files) onFolder(event.target.files); }} /><small>Current source and output, up to 30 files and 6 MB. Hidden files and dependencies are excluded.</small></label>
    <label className={`${styles.field} ${styles.wide}`}>Start from your fork<input type="file" accept="application/json,.json" aria-label="Import fork bundle" onChange={event => first(event.target.files, onBundle)} /><small>Optional. Import OPEN-HARNESS.json to keep the original project and attribution.</small></label>
  </>;
}

/** What people see first: the HTML output and an optional cover. */
export function OutputInputs({ onOutput, onCover }: { onOutput: (file: File) => void; onCover: (file: File) => void }) {
  return <>
    <label className={styles.field}>Your output<input type="file" accept="text/html,.html" aria-label="Upload HTML output" onChange={event => first(event.target.files, onOutput)} /><small>Self-contained HTML, up to 3 MB. Styles, scripts, and images should be included in the file; the public viewer cannot call external services.</small></label>
    <label className={styles.field}>Cover image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => first(event.target.files, onCover)} /><small>Optional. A 3:2 image, up to 250 KB. The title is used when there is no image.</small></label>
  </>;
}
