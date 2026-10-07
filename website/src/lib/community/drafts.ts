import type { HarnessSnapshot } from './types';

export type HubDraft = Partial<HarnessSnapshot> & { version?: number; clientId?: string; contextNote?: string };
export const draftDatabase = 'harness.hub.drafts';

export function validateDraft(value: unknown): HubDraft {
  if (!value || typeof value !== 'object') throw new Error('Choose a Harness project bundle.');
  const draft = value as HubDraft;
  for (const key of ['title', 'description', 'category', 'engine', 'viewerPath', 'cover', 'harnessId', 'forkedFrom', 'clientId', 'contextNote'] as const) {
    if (draft[key] !== undefined && typeof draft[key] !== 'string') throw new Error('Invalid draft metadata.');
  }
  if (draft.version !== 1 || !Array.isArray(draft.files) || draft.files.length > 30 || !draft.files.every(file => typeof file.path === 'string' && typeof file.content === 'string' && file.content.length <= 3_000_000 && (!file.encoding || file.encoding === 'base64')) || !Array.isArray(draft.conversation) || draft.conversation.length > 80 || !draft.conversation.every(turn => ['user', 'assistant', 'tool'].includes(turn.role) && typeof turn.text === 'string' && turn.text.length <= 12000)) throw new Error('Choose the OPEN-HARNESS.json from your harness.');
  if (typeof draft.viewerPath !== 'string' || !draft.files.some(file => file.path === draft.viewerPath && !file.encoding && file.path.endsWith('.html'))) throw new Error('Include a self-contained HTML preview of your output.');
  return draft;
}

function database(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(draftDatabase, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('drafts');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(new Error('Your browser could not save this draft.'));
  });
}
export async function readDraft(id: string): Promise<HubDraft | undefined> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts');
    const request = transaction.objectStore('drafts').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
    transaction.oncomplete = () => db.close();
  });
}
export async function saveDraft(id: string, draft: HubDraft | null): Promise<void> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const transaction = db.transaction('drafts', 'readwrite');
    if (draft) transaction.objectStore('drafts').put(draft, id);
    else transaction.objectStore('drafts').delete(id);
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => { db.close(); reject(new Error('Your browser could not save this draft.')); };
  });
}
