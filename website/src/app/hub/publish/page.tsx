'use client';
import { useMemo, useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { communityLimits, missingMarker } from '@/lib/community/contract';
import { validateDraft } from '@/lib/community/drafts';
import { previewDocument } from '@/lib/community/preview';
import { outsideResources } from '@/lib/community/outputCheck';
import { secretsInConversation, secretsInFiles } from '@/lib/community/secrets';
import { Header, SignIn } from '../components/Header';
import { useSignedIn } from '../components/useSignedIn';
import { ConversationEditor } from './components/ConversationEditor';
import { EnglishNotice } from './components/EnglishNotice';
import { DetailsFields } from './components/DetailsFields';
import { FilesReview } from './components/FilesReview';
import { OutputInputs, SourceInputs } from './components/ProjectInputs';
import { PublishChecks } from './components/PublishChecks';
import { PublishTarget } from './components/PublishTarget';
import { UnpublishAction } from './components/UnpublishAction';
import { originalOutput, readCover, readProjectFolder } from './projectFiles';
import { harnessPath } from '@/lib/community/slug';
import { countHub } from '@/lib/community/hubMeasure';
import { useHubView } from '../components/useHubView';
import { submitPublication, unpublishPublication } from './publication';
import { usePublishDraft, type PublishDraft } from './usePublishDraft';
import { useEnglishDraft } from './useEnglishDraft';
import styles from '../community.module.css';

const reviewInputs = ['confirmation', 'secrets'];

export default function PublishPage() {
  const router = useRouter(), signedIn = useSignedIn();
  useHubView('publish');
  const { draft, update, applyBundle, saveError, loadError, publishOnce } = usePublishDraft();
  const english = useEnglishDraft(draft, update, signedIn);
  const [confirmed, setConfirmed] = useState(false), [checkedSecrets, setCheckedSecrets] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const fileFindings = useMemo(() => secretsInFiles(draft.files), [draft.files]);
  const turnFindings = useMemo(() => secretsInConversation(draft.conversation), [draft.conversation]);
  const findings = useMemo(() => [...fileFindings, ...turnFindings], [fileFindings, turnFindings]);
  // The acknowledgement is for these findings: a new one needs checking again.
  const findingsKey = JSON.stringify(findings), secretsChecked = !findings.length || checkedSecrets === findingsKey;
  const marker = missingMarker(draft.harnessId, draft.files.map(file => file.path));
  const html = draft.files.find(file => file.path === draft.viewerPath && !file.encoding)?.content;
  const outside = useMemo(() => html ? outsideResources(html) : [], [html]);
  const unchanged = html !== undefined && html === draft.originalOutput;
  const ready = !!signedIn && !!html && !unchanged && confirmed && !marker && secretsChecked && draft.english.status !== 'pending';

  /** A changed project has to be reviewed again before it is published. */
  function replaceProject(patch: Partial<PublishDraft>) { update(patch); setConfirmed(false); setError(''); }
  async function attempt(action: () => Promise<void>, fallback: string) {
    try { await action(); } catch (e) { setError(e instanceof Error ? e.message : fallback); }
  }
  const importBundle = (file: File) => attempt(async () => {
    if (file.size > communityLimits.snapshotBytes) throw new Error('Keep the project under 6 MB.');
    const bundle = validateDraft(JSON.parse(await file.text()));
    applyBundle(bundle); update({ originalOutput: originalOutput(bundle) }); setConfirmed(false); setError('');
  }, 'This bundle could not be read.');
  const importFolder = (files: FileList) => attempt(async () => {
    const folder = await readProjectFolder(Array.from(files), draft.viewerPath);
    const { output, ...origin } = folder.origin || {};
    replaceProject({ files: folder.files, viewerPath: folder.viewerPath, ...origin, ...(folder.origin ? { originalOutput: output } : {}) });
  }, 'Could not read the project files.');
  const importOutput = (file: File) => attempt(async () => {
    if (file.size > communityLimits.fileChars) throw new Error('Keep the self-contained HTML output under 3 MB.');
    const content = await file.text();
    replaceProject({ files: [...draft.files.filter(f => f.path !== draft.viewerPath), { path: draft.viewerPath, content }] });
  }, 'Could not read the output.');
  const importCover = (file: File) => attempt(async () => { update({ cover: await readCover(file) }); setError(''); }, 'Could not read the image.');

  function publish(event: FormEvent) {
    event.preventDefault();
    if (!ready || busy) return;
    setBusy(true); setError(''); countHub('hub_publish_started');
    void publishOnce(async clientId => {
      const id = await submitPublication(draft, clientId);
      countHub('hub_publish_ok');
      router.push(harnessPath({ id, title: draft.title }));
    }).catch(e => { countHub('hub_publish_failed'); setError(e instanceof Error ? e.message : 'Publication failed. Your draft is still here.'); }).finally(() => setBusy(false));
  }
  function unpublish() {
    if (!draft.updateId || busy) return;
    const id = draft.updateId;
    setBusy(true); setError('');
    void publishOnce(async () => { await unpublishPublication(id); router.push('/hub/yours'); })
      .catch(e => setError(e instanceof Error ? e.message : 'The harness could not be unpublished. Try again.')).finally(() => setBusy(false));
  }
  const updating = !!draft.updateId;

  return <><Header /><main className={`${styles.wrap} ${styles.publish}`}>
    {updating
      ? <><h1>Update your harness.</h1><p className={styles.forkIntro}>Save new output, source or conversation over your publication. Its address, likes and comments stay; forks keep the version they copied.</p></>
      : <><h1>Give someone a place to begin.</h1><p className={styles.forkIntro}>Publish one session: the working output, its source, and the conversation that got you there. People can inspect it and make their own version.</p></>}
    {signedIn === false && <SignIn action="publish your harness" />}
    <form onChange={event => { if (!(event.target instanceof HTMLInputElement && reviewInputs.includes(event.target.name))) setConfirmed(false); }} onSubmit={publish}>
      <div className={styles.importActions}><strong>Bring your harness here.</strong><p>In the desktop app, open Share → Publish to Hub. Your current files and conversation arrive here for review.</p><p>You can also choose a project folder below. Include a self-contained HTML preview so everyone can see the result.</p></div>
      <EnglishNotice english={draft.english} signedIn={signedIn} {...english} />
      <div className={styles.publishForm}>
        <PublishTarget signedIn={signedIn} updateId={draft.updateId} onChange={updateId => update({ updateId })} />
        <SourceInputs onFolder={files => void importFolder(files)} onBundle={file => void importBundle(file)} />
        <DetailsFields draft={draft} update={update} />
        <OutputInputs onOutput={file => void importOutput(file)} onCover={file => void importCover(file)} />
        <ConversationEditor turns={draft.conversation} onChange={conversation => update({ conversation })} />
      </div>
      <FilesReview files={draft.files} viewerPath={draft.viewerPath} onRemove={path => replaceProject({ files: draft.files.filter(file => file.path !== path) })} onViewer={viewerPath => update({ viewerPath })} />
      {draft.contextNote && <p className={styles.notice}>{draft.contextNote}</p>}
      {html && <section className={styles.publishPreview}><h2>Review your output</h2><iframe title="Publication preview" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument(html)} /></section>}
      {draft.forkedFrom && <p className={styles.notice}>The original harness will stay credited on your publication.</p>}
      <PublishChecks noOutput={!!draft.files.length && html === undefined} unchanged={unchanged ? draft.viewerPath : null} outside={outside} missingMarker={marker} findings={findings} acknowledged={secretsChecked} onAcknowledge={value => setCheckedSecrets(value ? findingsKey : '')} />
      <label className={styles.check}><input required type="checkbox" name="confirmation" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I have permission to publish these files and this conversation under the MIT license. I have reviewed them for private information.</span></label>
      {(error || loadError || saveError) && <p className={styles.error} role="alert">{error || loadError || saveError}</p>}
      <div className={styles.submitRow}>
        <button className={styles.primary} disabled={busy || !ready}>{updating ? (busy ? 'Saving…' : 'Save changes') : (busy ? 'Publishing…' : 'Publish harness')}</button>
        {updating && <UnpublishAction busy={busy} onUnpublish={unpublish} />}
      </div>
    </form>
  </main></>;
}
