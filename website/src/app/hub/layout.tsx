import type { Metadata, Viewport } from 'next';
import styles from './community.module.css';

export const metadata: Metadata = { title: { default: 'Harness Hub — Discover, fork, create', template: '%s — Harness Hub' }, description: 'Discover what people make with agents. Like the work, join the conversation, fork your own version, and publish what you make.' };
export const viewport: Viewport = { themeColor: '#ffffff' };
export default function ExploreLayout({ children }: { children: React.ReactNode }) { return <div className={styles.page}>{children}</div>; }
