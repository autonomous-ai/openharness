import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getPublicHarness } from '@/lib/community/server';
import { harnessPath } from '@/lib/community/slug';
import { Header } from '../../components/Header';
import { ForkButton } from '../../components/ForkButton';
import { HarnessTags } from '../../components/HarnessTags';
import { HubView } from '../../components/HubView';
import { privateMetadata } from '../../privatePage';
import styles from '../../community.module.css';

/** A step on the way to a fork, not a page of its own to find: the harness's page is. */
export const metadata = privateMetadata('Make it yours');

/** The harness, null once it is not published, or 'down' when the Hub cannot be reached right now. */
async function readForFork(id: string) {
  try { return await getPublicHarness(id, { viewerOnly: true }); } catch { return 'down' as const; }
}

export default async function ForkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, harness = await readForFork(id);
  if (!harness) notFound();
  if (harness === 'down') return <><Header /><main className={`${styles.wrap} ${styles.fork}`}>
    <h1>Make it yours.</h1><p className={styles.notice} role="alert">The Hub could not be reached just now. <a href={`/hub/${id}/fork`}>Try again</a></p>
  </main></>;
  const path = harnessPath(harness);
  return <><Header /><HubView page="fork" /><main className={`${styles.wrap} ${styles.fork}`}>
    <Link href={path} className={styles.back}><ArrowLeft /> {harness.title}</Link>
    <h1>Make it yours.</h1><p className={styles.forkIntro}>Open this project in Harness. The files and published conversation come with it. Your version stays private until you publish.</p>
    <div className={styles.forkColumns}><div>{harness.cover && <img src={harness.cover} alt="" width={900} height={600} />}<h2>{harness.title}</h2><HarnessTags harness={harness} /></div>
      <div><ForkButton harness={harness} onForkPage /><h2>New to Harness?</h2><p><Link className={styles.textLink} href="/download" target="_blank" rel="noopener">Install the desktop app</Link>, then return here and open your fork. Harness prepares the project and its viewer for you.</p><p className={styles.notice}>Your browser may ask to open Harness. Choose Open to continue. Use the latest desktop version with community links.</p><details><summary>Get the source files</summary><p><a className={styles.textLink} href={`${path}/download`}>Download a ZIP</a> if you want to use a different editor.</p></details></div>
    </div>
  </main></>;
}
