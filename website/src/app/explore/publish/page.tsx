'use client';
import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { communityRequest, sessionHeaders } from '@/lib/community/client';
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
  const [confirmed, setConfirmed] = useState(false), [signedIn, setSignedIn] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const update = () => setSignedIn(!!sessionHeaders().Authorization); update(); window.addEventListener('focus', update); window.addEventListener('storage', update); return () => { window.removeEventListener('focus', update); window.removeEventListener('storage', update); }; }, []);

  async function importBundle(file: File) {
    try {
      if (file.size > 6_100_000) throw new Error('Keep the project under 6 MB.');
      const bundle = JSON.parse(await file.text());
      if (bundle.version !== 1 || !Array.isArray(bundle.files) || bundle.files.length > 30 || !bundle.files.every((f: SourceFile) => typeof f.path === 'string' && typeof f.content === 'string') || !Array.isArray(bundle.conversation) || !bundle.conversation.every((t: ConversationTurn) => ['user', 'assistant', 'tool'].includes(t.role) && typeof t.text === 'string')) throw new Error('Choose the OPEN-HARNESS.json from a downloaded fork.');
      if (typeof bundle.viewerPath !== 'string' || !bundle.files.some((f: SourceFile) => f.path === bundle.viewerPath)) throw new Error('The project is missing its HTML output.');
      setTitle(String(bundle.title || '').slice(0, 100)); setDescription(String(bundle.description || '').slice(0, 300));
      setCategory(categories.includes(bundle.category) ? bundle.category : 'Apps'); setEngine(engines.includes(bundle.engine) ? bundle.engine : 'Codex');
      setHarnessId(["autonomous/blender", "autonomous/marp", "autonomous/typst", "autonomous/circuitjs", "autonomous/godogen", "autonomous/jev-sheets", "autonomous/mujoco", "autonomous/rdkit", "autonomous/strudel"].includes(bundle.harnessId) ? bundle.harnessId : undefined);
      setFiles(bundle.files); setViewerPath(bundle.viewerPath); setConversation(bundle.conversation);
      setForkedFrom(typeof bundle.forkedFrom === 'string' ? bundle.forkedFrom : undefined); setConfirmed(false); setError('');
    } catch (e) { setError(e instanceof Error ? e.message : 'This bundle could not be read.'); }
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
    <form onSubmit={event => { event.preventDefault(); if (!signedIn || busy) return; setBusy(true); setError(''); const snapshot: HarnessSnapshot = { title, description, category, engine, ...(harnessId ? { harnessId } : {}), files, viewerPath, conversation, ...(cover ? { cover } : {}), ...(forkedFrom ? { forkedFrom } : {}) }; void communityRequest<{ id: string }>('harnesses', { method: 'POST', body: { ...snapshot, confirmed, license: 'MIT' } }).then(result => router.push(`/explore/${result.id}`)).catch(e => setError(e instanceof Error ? e.message : 'Publication failed. Your draft is still here.')).finally(() => setBusy(false)); }}>
      <div className={styles.publishForm}>
        <label className={`${styles.field} ${styles.wide}`}>Start from your fork<input type="file" accept="application/json,.json" aria-label="Import fork bundle" onChange={event => { const file = event.target.files?.[0]; if (file) void importBundle(file); }} /><small>Optional. Import OPEN-HARNESS.json to keep the original project and attribution.</small></label>
        <label className={styles.field}>Title<input required maxLength={100} value={title} onChange={event => setTitle(event.target.value)} placeholder="What did you make?" /></label>
        <label className={styles.field}>Description<input required maxLength={300} value={description} onChange={event => setDescription(event.target.value)} placeholder="A short introduction to the work" /></label>
        <label className={styles.field}>Category<select value={category} onChange={event => setCategory(event.target.value)}>{categories.map(c => <option key={c}>{c}</option>)}</select></label>
        <label className={styles.field}>Harness<select value={harnessId || ''} onChange={event => setHarnessId(event.target.value || undefined)}><option value="">General</option><option value="autonomous/blender">Blender</option><option value="autonomous/marp">Marp</option><option value="autonomous/typst">Typst</option><option value="autonomous/circuitjs">Circuitjs</option><option value="autonomous/godogen">Godogen</option><option value="autonomous/jev-sheets">Jev-Sheets</option><option value="autonomous/mujoco">Mujoco</option><option value="autonomous/rdkit">Rdkit</option><option value="autonomous/strudel">Strudel</option></select></label>
        <label className={styles.field}>Agent<select value={engine} onChange={event => setEngine(event.target.value)}>{engines.map(e => <option key={e}>{e}</option>)}</select></label>
        <label className={styles.field}>Your output<input type="file" accept="text/html,.html" aria-label="Upload HTML output" onChange={event => { const file = event.target.files?.[0]; if (file) void importOutput(file); }} /><small>Self-contained HTML, up to 200 KB. Styles, scripts, and images should be included in the file; the public viewer cannot call external services.</small></label>
        <label className={styles.field}>Cover image<input type="file" accept="image/png,image/jpeg,image/webp" onChange={event => { const file = event.target.files?.[0]; if (file) void importCover(file); }} /><small>Optional. A 3:2 image, up to 250 KB. The title is used when there is no image.</small></label>
        <div className={`${styles.field} ${styles.wide}`}><span>Conversation</span><small>Review the published context. Remove private messages, credentials, and tool output you do not want to share.</small>
          {conversation.map((turn, index) => <div key={index} className={styles.field}><select aria-label={`Speaker ${index + 1}`} value={turn.role} onChange={event => setConversation(previous => previous.map((item, i) => i === index ? { ...item, role: event.target.value as ConversationTurn['role'] } : item))}><option value="user">You</option><option value="assistant">Agent</option><option value="tool">Tool output</option></select><textarea required aria-label={`Message ${index + 1}`} maxLength={12000} value={turn.text} onChange={event => setConversation(previous => previous.map((item, i) => i === index ? { ...item, text: event.target.value } : item))} /><button type="button" disabled={conversation.length === 1} onClick={() => setConversation(previous => previous.filter((_, i) => i !== index))}>Remove message</button></div>)}
          <button type="button" disabled={conversation.length >= 80} onClick={() => setConversation(previous => [...previous, { role: 'assistant', text: '' }])}>+ Add a message</button>
        </div>
      </div>
      {html && <section className={styles.publishPreview}><h2>Review your output</h2><iframe title="Publication preview" sandbox="allow-scripts" referrerPolicy="no-referrer" srcDoc={previewDocument(html)} /></section>}
      {forkedFrom && <p className={styles.notice}>The original harness will stay credited on your publication.</p>}
      <label className={styles.check}><input required type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} /><span>I have permission to publish these files and this conversation under the MIT license. I have reviewed them for private information.</span></label>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.primary} disabled={busy || !signedIn || !html || !confirmed}>{busy ? 'Publishing…' : 'Publish harness'}</button>
    </form>
  </main></>;
}
