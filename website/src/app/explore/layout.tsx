import type { Metadata, Viewport } from 'next';
import styles from './community.module.css';

export const metadata: Metadata = { title: { default: 'Explore — Harness', template: '%s — Harness' }, description: 'Discover what people make with agents. Inspect the work, read the session, and fork your own version.' };
export const viewport: Viewport = { themeColor: '#ffffff' };
export default function ExploreLayout({ children }: { children: React.ReactNode }) { return <div className={styles.page}>{children}</div>; }
