import type { Metadata } from 'next';
import type { ReactNode } from 'react';

/** A page that is one reader's own (their notifications, what they follow, a draft): its own title, and nothing for a search engine to keep. */
export const privateMetadata = (title: string): Metadata => ({ title, robots: { index: false, follow: true } });

/** A route's layout that only names its page. */
export const PassThrough = ({ children }: { children: ReactNode }) => children;
