'use client';
import { useEffect } from 'react';
import Link from 'next/link';
import { countHub } from '@/lib/community/hubMeasure';
import { rememberHubReturn } from '@/lib/community/session';
import { webAppPath } from '@/lib/webApp';
import { useSignedIn } from './useSignedIn';
import styles from './explore.module.css';

/**
 * What the Hub is, for someone arriving at it: drawn by the server for search engines and a first
 * look. Until a sign-in is known, a visitor is assumed, and is offered the app and a sign-in.
 */
export function ExploreIntro() {
  const signedIn = useSignedIn();
  // The sign-in offered here is a prompt like any other, counted once it is known to be a visitor's.
  useEffect(() => { if (signedIn === false) countHub('hub_sign_in_prompt_shown'); }, [signedIn]);
  return <section className={styles.intro}>
    <h1>What people make with agents</h1>
    <p>Open the output, read the conversation that made it, and fork the project into Harness to make your own version.</p>
    {signedIn !== true && <div className={styles.cta}>
      <Link className={styles.get} href="/desktop" onClick={() => countHub('hub_get_app')}>Get the Harness desktop app</Link>
      <a className={styles.signIn} href={webAppPath} onClick={() => { countHub('hub_sign_in_prompt_click'); rememberHubReturn(); }}>Sign in</a>
    </div>}
  </section>;
}
