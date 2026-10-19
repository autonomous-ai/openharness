import community from '../community.module.css';
import styles from './footer.module.css';

const links = [
  { href: '/desktop', label: 'Harness desktop app' }, { href: '/download', label: 'Download' },
  { href: '/agents', label: 'For agents' }, { href: '/os', label: 'Harness operating system' },
];

/** Under every Hub page: where Harness itself is, for a reader who arrived at a harness first. Plain links: they leave the Hub. */
export function HubFooter() {
  return <footer className={styles.footer}><div className={`${community.wrap} ${styles.inner}`}>
    <span>Harness by Autonomous</span>
    <nav aria-label="Harness">{links.map(link => <a key={link.href} href={link.href}>{link.label}</a>)}</nav>
  </div></footer>;
}
