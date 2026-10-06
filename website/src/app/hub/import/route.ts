import { randomUUID } from 'node:crypto';
import { draftDatabase, validateDraft } from '@/lib/community/drafts';

/** Native Share hands off a draft, never a publication or a credential. */
export async function POST(request: Request): Promise<Response> {
  try {
    const reader = request.body?.getReader();
    if (!reader) return new Response('No draft was received.', { status: 400 });
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 7_000_000) { await reader.cancel(); return new Response('Keep the draft under 6 MB.', { status: 413 }); }
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const form = await new Response(bytes, { headers: { 'Content-Type': request.headers.get('Content-Type') || '' } }).formData();
    const raw = form.get('draft');
    if (typeof raw !== 'string' || new TextEncoder().encode(raw).length > 6_000_000) return new Response('Invalid draft.', { status: 400 });
    const draft = validateDraft(JSON.parse(raw));
    const id = randomUUID(), nonce = randomUUID();
    const payload = JSON.stringify(draft).replace(/</g, '\\u003c').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
    const html = `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Review your harness · Harness Hub</title><body><p id="status">Preparing your draft…</p><script nonce="${nonce}">const payload=${payload};const request=indexedDB.open(${JSON.stringify(draftDatabase)},1);request.onupgradeneeded=()=>request.result.createObjectStore('drafts');request.onerror=()=>document.getElementById('status').textContent='Your browser could not save the draft. Allow site storage and try again.';request.onsuccess=()=>{const db=request.result;const tx=db.transaction('drafts','readwrite');tx.objectStore('drafts').put(payload,${JSON.stringify(id)});tx.oncomplete=()=>{db.close();location.replace('/hub/publish?draft=${id}')};tx.onerror=()=>{db.close();document.getElementById('status').textContent='Your browser could not save the draft. Free some site storage and try again.'}};</script></body></html>`;
    return new Response(html, { headers: {
      'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; frame-ancestors 'none'; base-uri 'none'`,
      'X-Content-Type-Options': 'nosniff',
    } });
  } catch { return new Response('This draft could not be opened. Return to your harness and try publishing again.', { status: 400 }); }
}
