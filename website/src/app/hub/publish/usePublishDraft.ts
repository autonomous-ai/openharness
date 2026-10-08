'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { readDraft, saveDraft, type HubDraft } from '@/lib/community/drafts';
import { communityCategories, communityEngines } from '@/lib/community/contract';
import type { HarnessSnapshot } from '@/lib/community/types';

/** `originalOutput` is the fork's output as it arrived: kept here to compare against, never published. */
export type PublishDraft = Omit<HarnessSnapshot, 'harnessName' | 'credits'> & { contextNote: string; originalOutput?: string };

const fresh: PublishDraft = { title: '', description: '', category: 'Apps', engine: 'Codex', files: [], viewerPath: 'preview.html', conversation: [{ role: 'user', text: '' }], contextNote: '' };

/** A handed-off or imported bundle, kept within what the form can show and the Hub accepts. */
function fromBundle(bundle: HubDraft): PublishDraft {
  return {
    title: String(bundle.title || '').slice(0, 100), description: String(bundle.description || '').slice(0, 300),
    category: communityCategories.includes(bundle.category || '') ? bundle.category! : 'Apps',
    engine: communityEngines.includes(bundle.engine || '') ? bundle.engine! : 'Codex',
    harnessId: bundle.harnessId, files: bundle.files || [], viewerPath: bundle.viewerPath || 'preview.html',
    conversation: bundle.conversation?.length ? bundle.conversation : fresh.conversation,
    forkedFrom: bundle.forkedFrom, cover: bundle.cover, contextNote: bundle.contextNote || '', originalOutput: bundle.originalOutput,
  };
}

/** What the Hub stores: the draft without the note that was only for the person reviewing it. */
export function toSnapshot(draft: PublishDraft): HarnessSnapshot {
  const { title, description, category, engine, harnessId, files, viewerPath, conversation, cover, forkedFrom } = draft;
  return { title, description, category, engine, ...(harnessId ? { harnessId } : {}), files, viewerPath, conversation, ...(cover ? { cover } : {}), ...(forkedFrom ? { forkedFrom } : {}) };
}

/**
 * The publish form's draft, kept in this browser under `?draft=<id>` so a reload or a sign-in keeps
 * it. `publicationId` makes a retried Publish return the same publication instead of a second one.
 */
export function usePublishDraft() {
  const [draft, setDraft] = useState(fresh), [ready, setReady] = useState(false), [saveError, setSaveError] = useState('');
  const draftId = useRef<string | null>(null), publicationId = useRef<string | null>(null), submitting = useRef(false);
  const update = useCallback((patch: Partial<PublishDraft>) => setDraft(value => ({ ...value, ...patch })), []);
  const applyBundle = useCallback((bundle: HubDraft) => {
    setDraft(fromBundle(bundle));
    publicationId.current = bundle.clientId || crypto.randomUUID();
  }, []);

  useEffect(() => {
    let disposed = false;
    const query = new URLSearchParams(window.location.search).get('draft');
    const id = query && /^[a-f0-9-]{36}$/.test(query) ? query : crypto.randomUUID();
    draftId.current = id; publicationId.current = crypto.randomUUID();
    if (!query) window.history.replaceState(null, '', `/hub/publish?draft=${id}`);
    void readDraft(id).then(saved => { if (!disposed && saved) applyBundle(saved); }).catch(() => { /* A fresh draft can still be composed. */ }).finally(() => { if (!disposed) setReady(true); });
    return () => { disposed = true; };
  }, [applyBundle]);

  useEffect(() => {
    if (!ready || !draftId.current || submitting.current) return;
    const id = draftId.current;
    const timer = setTimeout(() => {
      if (submitting.current) return;
      void saveDraft(id, { version: 1, ...draft, clientId: publicationId.current || undefined }).then(() => setSaveError(''), () => setSaveError('Your browser could not save this draft. Keep this tab open until you publish.'));
    }, 300);
    return () => clearTimeout(timer);
  }, [ready, draft]);

  /** Sends the publication once at a time with this draft's id, then forgets the draft. */
  const publishOnce = useCallback(async (send: (clientId: string | undefined) => Promise<void>) => {
    if (submitting.current) return;
    submitting.current = true;
    try {
      await send(publicationId.current || undefined);
      if (draftId.current) await saveDraft(draftId.current, null).catch(() => {});
    } finally { submitting.current = false; }
  }, []);
  return { draft, update, applyBundle, saveError, publishOnce };
}
