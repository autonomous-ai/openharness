'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { communityRequest, sessionHeaders } from '@/lib/community/client';
import { readDraft, saveDraft, validateDraft, type HubDraft } from '@/lib/community/drafts';
import { previewDocument } from '@/lib/community/preview';
import type { ConversationTurn, HarnessSnapshot, SourceFile } from '@/lib/community/types';
import { Header, SignIn } from '../components/Header';
import styles from '../community.module.css';

const categories = ['Apps', 'Games', 'Motion', 'Music', 'Design', 'Data', 'Documents', 'Experiments'];
const engines = ['Codex', 'Claude Code', 'OpenCode', 'pi'];
export default function PublishPage() {
  const router = useRouter();
  const [title, setTitle] = useState(''), [description, setDescription] = useState(''), [category, setCategory] = useState('Apps'), [engine, setEngine] = useState('Codex');
  const [harnessId, setHarnessId] = useState<string | undefined>();
  const [files, setFiles] = useState<SourceFile[]>([]), [viewerPath, setViewerPath] = useState('index.html'), [cover, setCover] = useState<string | undefined>();
  const [conversation, setConversation] = useState<ConversationTurn[]>([{ role: 'user', text: '' }]), [forkedFrom, setForkedFrom] = useState<string | undefined>();
  const draftId = useRef<string | null>(null), publicationId = useRef<string | null>(null), submitting = useRef(false);
  const [draftReady, setDraftReady] = useState(false), [contextNote, setContextNote] = useState('');
  const [confirmed, setConfirmed] = useState(false), [signedIn, setSignedIn] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const update = () => setSignedIn(!!sessionHeaders().Authorization); update(); window.addEventListener('focus', update); window.addEventListener('storage', update); return () => { window.removeEventListener('focus', update); window.removeEventListener('storage', update); }; }, []);

  function applyDraft(bundle: HubDraft) {
    setTitle(String(bundle.title || '').slice(0, 100)); setDescription(String(bundle.description || '').slice(0, 300));
    setCategory(categories.includes(bundle.category || '') ? bundle.category! : 'Apps'); setEngine(engines.includes(bundle.engine || '') ? bundle.engine! : 'Codex');
    setHarnessId(bundle.harnessId); setFiles(bundle.files || []); setViewerPath(bundle.viewerPath || 'index.html');
    setConversation(bundle.conversation?.length ? bundle.conversation : [{ role: 'user', text: '' }]);
    setForkedFrom(bundle.forkedFrom); setCover(bundle.cover); setContextNote(bundle.contextNote || '');
    publicationId.current = bundle.clientId || crypto.randomUUID(); setConfirmed(false); setError('');
  }
  useEffect(() => {
    let disposed = false;
    const query = new URLSearchParams(window.location.search).get('draft');
    const id = query && /^[a-f0-9-]{36}$/.test(query) ? query : crypto.randomUUID();
    draftId.current = id; publicationId.current = crypto.randomUUID();
    if (!query) window.history.replaceState(null, '', `/hub/publish?draft=${id}`);
    void readDraft(id).then(saved => { if (!disposed && saved) applyDraft(saved); }).catch(() => { /* A fresh draft can still be composed. */ }).finally(() => { if (!disposed) setDraftReady(true); });
    return () => { disposed = true; };
  }, []);
  useEffect(() => {
    if (!draftReady || !draftId.current || submitting.current) return;
    const id = draftId.current;
    const timer = setTimeout(() => {
      if (submitting.current) return;
      void saveDraft(id, { version: 1, title, description, category, engine, harnessId, files, viewerPath, cover, conversation, forkedFrom, contextNote, clientId: publicationId.current || undefined }).catch(() => setError('Your browser could not save this draft. Keep this tab open until you publish.'));
    }, 300);
    return () => clearTimeout(timer);
  }, [draftReady, title, description, category, engine, harnessId, files, viewerPath, cover, conversation, forkedFrom, contextNote]);
  async function importBundle(file: File) {
    try {
      if (file.size > 6_000_000) throw new Error('Keep the project under 6 MB.');
      applyDraft(validateDraft(JSON.parse(await file.text())));
    } catch (e) { setError(e instanceof Error ? e.message : 'This bundle could not be read.'); }
  }
  async function importFiles(selected: FileList) {
    try {
      const entries: SourceFile[] = []; let size = 0;
      for (const file of Array.from(selected)) {
        const path = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
        if (path.split('/').some(part => part.startsWith('.') || ['node_modules', 'build', 'dist', 'target', 'vendor', '__pycache__'].includes(part))) continue;
        if (/^(AGENTS\.md|CLAUDE\.md|SESSION\.md|LICENSE|README\.md|harness\.json)$/i.test(file.name)) continue;
        if (file.name === 'OPEN-HARNESS.json') { const original = validateDraft(JSON.parse(await file.text())); setForkedFrom(original.forkedFrom); setHarnessId(original.harnessId); continue; }
        if (!/\.(html|css|js|mjs|ts|tsx|jsx|json|md|svg|py|typ|strudel|txt|csv|xml|sdf|png|jpe?g|webp|glb|pdf)$/i.test(path)) continue;
        if (entries.length === 30 || file.size > 3_000_000) throw new Error('Choose up to 30 portable files, under 3 MB each.');
        const binary = /\.(png|jpe?g|webp|glb|pdf)$/i.test(path);
        let content: string;
        if (binary) { let raw = ''; for (const byte of new Uint8Array(await file.arrayBuffer())) raw += String.fromCharCode(byte); content = btoa(raw); }
        else content = await file.text();
        size += new TextEncoder().encode(content).length;
        if (content.length > 3_000_000 || size > 5_600_000) throw new Error('Keep the project under 6 MB.');
        entries.push({ path, content, ...(binary ? { encoding: 'base64' as const } : {}) });
      }
      const output = entries.find(f => f.path === viewerPath) || entries.find(f => f.path === 'preview.html') || entries.find(f => f.path.endsWith('.html'));
      if (!output) throw new Error('Include a self-contained preview.html or index.html.');
      setFiles(entries); setViewerPath(output.path); setConfirmed(false); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'Could not read the project files.'); }
  }
  async function importOutput(file: File) {
    if (file.size > 3_000_000) { setError('Keep the self-contained HTML output under 3 MB.'); return; }
    const content = await file.text(); setFiles(previous => [...previous.filter(f => f.path !== viewerPath), { path: viewerPath, content }]); setConfirmed(false); setError('');
  }
  async function importCover(file: File) {
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 250_000) { setError('Choose a PNG, JPEG, or WebP image under 250 KB.'); return; }
    const bytes = new Uint8Array(await file.arrayBuffer()); let binary = ''; for (const byte of bytes) binary += String.fromCharCode(byte);
    setCover(`data:${file.type};base64,${btoa(binary)}`); setError('');
  }
  const html = files.find(f => f.path === viewerPath)?.content;
  return <><Header /><main className={`${styles.wrap} ${styles.publish}`}>
    <h1>Give someone a place to begin.</h1><p className={styles.forkIntro}>Publish one session: the working output, its source, and the conversation that got you there. People can inspect it and make their own version.</p>
    {!signedIn && <SignIn action="publish your harness" />}
    <form onChange={event => { if (!(event.target instanceof HTMLInputElement && event.target.name === 'confirmation')) setConfirmed(false); }} onSubmit={event => { event.preventDefault(); if (!signedIn || submitting.current) return; submitting.current = true; setBusy(true); setError(''); const snapshot: HarnessSnapshot = { title, description, category, engine, ...(harnessId ? { harnessId } : {}), files, viewerPath, conversation, ...(cover ? { cover } : {}), ...(forkedFrom ? { forkedFrom } : {}) }; void communityRequest<{ id: string }>('harnesses', { method: 'POST', body: { ...snapshot, confirmed, license: 'MIT', clientId: publicationId.current || undefined } }).then(async result => { if (draftId.current) await saveDraft(draftId.current, null).catch(() => {}); router.push(`/hub/${result.id}`); }).catch(e => setError(e instanceof Error ? e.message : 'Publication failed. Your draft is still here.')).finally(() => { submitting.current = false; setBusy(false); }); }}>
      <div className={styles.importActions}><strong>Bring your harness here.</strong><p>In the desktop app, open Share → Publish to Hub. Your current files and conversation arrive here for review.</p><p>You can also choose a project folder below. Include a self-contained HTML preview so everyone can see the result.</p></div>
      <div className={styles.publishForm}>
        <label className={`${styles.field} ${styles.wide}`}>Project folder<input type="file" multiple ref={element => { element?.setAttribute('webkitdirectory', ''); }} aria-label="Choose project folder" onChange={event => { if (event.target.files) void importFiles(event.target.files); }} /><small>Current source and output, up to 30 files and 6 MB. Hidden files and dependencies are excluded.</small></label>
        <label className={`${styles.field} ${styles.wide}`}>Start from your fork<input type="file" accept="application/json,.json" aria-label="Import fork bundle" onChange={event => { const file = event.target.files?.[0]; if (file) void importBundle(file); }} /><small>Optional. Import OPEN-HARNESS.json to keep the original project and attribution.</small></label>
        <label className={styles.field}>Title<input required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="What did you make?" /></label>
        <label className={styles.field}>Description<input required maxLength={300} value={description} onChange={event => setDescription(event.target.value)} placeholder="A short introduction to the work" /></label>
        <label className={styles.field}>Category<select value={category} onChange={event => setCategory(event.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
        <label className={styles.field}>Harness<select value={harnessId || ''} onChange={event => setHarnessId(event.target.value || undefined)}><option value="">General</option><option value="autonomous/blender">Blender</option><option value="autonomous/marp">Marp</option><option value="autonomous/typst">Typst</option><option value="autonomous/circuitjs">CircuitJS</option><option value="autonomous/godogen">Godogen</option><option value="autonomous/jev-sheets">Jev Sheets</option><option value="autonomous/mujoco">MuJoCo</option><option value="autonomous/rdkit">RDKit</option><option value="autonomous/strudel">Strudel</option></select></label>
        <label className={styles.field}>Agent<select value={engine} onChange={event => setEngine(event.target.value)}>{engines.map(e => <option key={e}>{e}</option>)}</select></label>
        <label className={styles.field}>Your output<input type="file" accept="text/html,.html" aria-label="Upload HTML output" onChange={event => { const file = event.target.files?.[0]; if (file) void importOutput(file); }} /><small>Self-contained HTML, up to 3 MB. Styles, scripts, and images should be included in the file; the public viewer cannot call external services.</small></label>
        <label className={styles.field}>Cover image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) void importCover(file); }} /><small>Optional. A 3:2 image, up to 250 KB. The title is used when there is no image.</small></label>
        <div className={`${styles.field} ${styles.wide}`}><span>Conversation</span><small>Review the published context. Remove private messages, credentials, and tool output you do not want to share.</small>
          {conversation.map((turn, index) => <div key={index} className={styles.field}><select aria-label={`Speaker ${index + 1}`} value={turn.role} onChange={event => setConversation(previous => previous.map((item, i) => i === index ? { ...item, role: event.target.value as ConversationTurn['role'] } : item))}><option value="user">You</option><option value="assistant">Agent</option><option value="tool">Tool output</option></select><textarea required aria-label={`Message ${index + 1}`} maxLength={12000} value={turn.text} onChange={event => setConversation(previous => previous.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /><button type="button" disabled={conversation.length === 1} onClick={() => setConversation(previous => previous.filter((_, i) => i !== index))}>Remove message</button></div>)}
          <button type="button" disabled={conversation.length >= 80} onClick={() => setConversation(previous => [...previous, { role: 'assistant', text: '' }])}>+ Add a message</button>
        </div>
      </div>
      {!!files.length && <details className={styles.filesReview}><summary>Review {files.length} source files</summary>{files.map(file => <div className={styles.fileRow} key={file.path}><details><summary>{file.path}</summary>{file.encoding ? <p>Binary artifact included in the fork.</p> : <pre className={styles.sourceText}>{file.content}</pre>}</details><small>{Math.ceil(new TextEncoder().encode(file.content).length / 1024)} KB</small><button type="button" disabled={file.path === viewerPath} onClick={() => { setFiles(previous => previous.filter(item => item.path !== file.path)); setConfirmed(false); }}>Remove</button></div>)}<label className={styles.field}>Output preview<select value={viewerPath} onChange={event => setViewerPath(event.target.value)}>{files.filter(file => file.path.endsWith('.html') && !file.encoding).map(file => <option key={file.path}>{file.path}</option>)}</select></label></details>}
      {contextNote && <p className={styles.notice}>{contextNote}</p>}
      {html && <section className={styles.publishPreview}><h2>Review your output</h2><iframe title="Publication preview" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument(html)} /></section>}
      {forkedFrom && <p className={styles.notice}>The original harness will stay credited on your publication.</p>}
      <label className={styles.check}><input required type="checkbox" name="confirmation" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I have permission to publish these files and this conversation under the MIT license. I have reviewed them for private information.</span></label>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.primary} disabled={busy || !signedIn || !html || !confirmed}>{busy ? 'Publishing…' : 'Publish harness'}</button>
    </form>
  </main></>;
}
