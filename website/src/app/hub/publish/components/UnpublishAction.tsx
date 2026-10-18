import styles from '../../community.module.css';

/** Beside Save changes, the one way to take the harness off the Hub, asked twice. */
export function UnpublishAction({ busy, onUnpublish }: { busy: boolean; onUnpublish: () => void }) {
  const confirmThen = () => {
    if (window.confirm('Remove this harness from the public feed? Forks people already made keep their copy.')) onUnpublish();
  };
  return <button type="button" className={styles.danger} disabled={busy} onClick={confirmThen}>Unpublish this harness</button>;
}
