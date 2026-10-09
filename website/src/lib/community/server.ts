import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { starterHarnesses, starterConversation, starterSlug } from './starters';
import type { OpenHarness } from './types';

export function communityApiOrigin(): string {
  const url = new URL(process.env.COMMUNITY_API_URL || 'https://harness-api.autonomous.ai');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))
    throw new Error('COMMUNITY_API_URL must use HTTPS or loopback HTTP.');
  return url.origin;
}

/** `viewerOnly` reads just the page readers see: a harness page needs no source files, and a starter's run to megabytes. */
export type HarnessRead = { timeoutMs?: number; viewerOnly?: boolean };

const onlyViewer = (harness: OpenHarness): OpenHarness => ({ ...harness, files: harness.files.filter(file => file.path === harness.viewerPath) });

export async function getStarter(id: string, { viewerOnly = false }: HarnessRead = {}): Promise<OpenHarness | null> {
  const summary = starterHarnesses.find(item => item.id === id), slug = starterSlug(id);
  if (!summary || !slug) return null;
  const viewerPath = summary.recording ? 'preview.html' : 'index.html';
  const html = await readFile(path.join(process.cwd(), 'public/open-harnesses', slug, viewerPath), 'utf8');
  const files: OpenHarness['files'] = [{ path: viewerPath, content: html }];
  if (summary.harnessId && !viewerOnly) {
    const names: string[] = JSON.parse(await readFile(path.join(process.cwd(), 'public/open-harnesses', slug, 'source-files.json'), 'utf8'));
    for (const name of names) {
      const bytes = await readFile(path.join(process.cwd(), 'public/open-harnesses', slug, name));
      const binary = /\.(glb|pdf|mp4|png|jpg|jpeg|webp)$/.test(name);
      files.push({ path: name, content: bytes.toString(binary ? 'base64' : 'utf8'), ...(binary ? { encoding: 'base64' as const } : {}) });
    }
  }
  return { ...summary, viewerPath, files, conversation: starterConversation(id) };
}

export async function getPublicHarness(id: string, read: HarnessRead = {}): Promise<OpenHarness | null> {
  const starter = await getStarter(id, read);
  if (starter) return starter;
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  const query = read.viewerOnly ? '?files=viewer' : '';
  const response = await fetch(`${communityApiOrigin()}/api/community/harnesses/${id}${query}`, { cache: 'no-store', signal: AbortSignal.timeout(read.timeoutMs ?? 8000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Community service unavailable.');
  const harness: OpenHarness | null = (await response.json()).data.harness;
  // A backend older than `?files=viewer` still sends every file.
  return harness && read.viewerOnly ? onlyViewer(harness) : harness;
}
