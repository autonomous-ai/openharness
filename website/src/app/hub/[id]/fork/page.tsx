import Link from 'next/link';
import { notFound } from 'next/navigation';
import { ArrowLeft } from 'lucide-react';
import { getPublicHarness } from '@/lib/community/server';
import { Header } from '../../components/Header';
import { ForkButton } from '../../components/ForkButton';
import { HarnessTags } from '../../components/HarnessTags';
import styles from '../../community.module.css';

export default async function ForkPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, harness = await getPublicHarness(id, { viewerOnly: true });
  if (!harness) notFound();
  return <><Header /><main className={`${styles.wrap} ${styles.fork}`}>
    <Link href={`/hub/${id}`} className={styles.back}><ArrowLeft /> {harness.title}</Link>
    <h1>Make it yours.</h1><p className={styles.forkIntro}>Open this project in Harness. The files and published conversation come with it. Your version stays private until you publish.</p>
    <div className={styles.forkColumns}><div>{harness.cover && <img src={harness.cover} alt="" width={900} height={600} />}<h2>{harness.title}</h2><HarnessTags harness={harness} /></div>
      <div><ForkButton id={id} /><h2>New to Harness?</h2><p><Link className={styles.textLink} href="/download" target="_blank" rel="noopener">Install the desktop app</Link>, then return here and open your fork. Harness prepares the project and its viewer for you.</p><p className={styles.notice}>Your browser may ask to open Harness. Choose Open to continue. Use the latest desktop version with community links.</p><details><summary>Get the source files</summary><p><a className={styles.textLink} href={`/hub/${id}/download`}>Download a ZIP</a> if you want to use a different editor.</p></details></div>
    </div>
  </main></>;
}
