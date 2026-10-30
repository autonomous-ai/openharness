import type { Metadata, Viewport } from 'next';
import { HubFooter } from './components/HubFooter';
import styles from './community.module.css';

/** Absolute addresses for link previews (a harness's cover); the Hub is served from this origin. */
const title = 'Harness Hub — Discover, fork, create', description = 'Discover what people make with agents. Like the work, join the conversation, fork your own version, and publish what you make.';
export const metadata: Metadata = {
  metadataBase: new URL('https://harness.autonomous.ai'), title: { default: title, template: '%s — Harness Hub' }, description,
  // A link to the Hub itself previews as the Hub; a harness or creator page sets its own.
  openGraph: { type: 'website', siteName: 'Harness Hub', title, description, url: '/hub' }, twitter: { card: 'summary', title, description },
};
export const viewport: Viewport = { themeColor: '#ffffff' };
export default function ExploreLayout({ children }: { children: React.ReactNode }) { return <div className={styles.page}>{children}<HubFooter /></div>; }
