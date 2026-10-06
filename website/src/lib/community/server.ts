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

export async function getStarter(id: string): Promise<OpenHarness | null> {
  const summary = starterHarnesses.find(item => item.id === id), slug = starterSlug(id);
  if (!summary || !slug) return null;
  const viewerPath = summary.recording ? 'preview.html' : 'index.html';
  const html = await readFile(path.join(process.cwd(), 'public/open-harnesses', slug, viewerPath), 'utf8');
  const files: OpenHarness['files'] = [{ path: viewerPath, content: html }];
  if (summary.harnessId) {
    const names: string[] = JSON.parse(await readFile(path.join(process.cwd(), 'public/open-harnesses', slug, 'source-files.json'), 'utf8'));
    for (const name of names) {
      const bytes = await readFile(path.join(process.cwd(), 'public/open-harnesses', slug, name));
      const binary = /\.(glb|pdf|mp4|png|jpg|jpeg|webp)$/.test(name);
      files.push({ path: name, content: bytes.toString(binary ? 'base64' : 'utf8'), ...(binary ? { encoding: 'base64' as const } : {}) });
    }
  }
  return { ...summary, viewerPath, files, conversation: starterConversation(id) };
}

export async function getPublicHarness(id: string): Promise<OpenHarness | null> {
  const starter = await getStarter(id);
  if (starter) return starter;
  if (!/^[a-f0-9-]{36}$/.test(id)) return null;
  const response = await fetch(`${communityApiOrigin()}/api/community/harnesses/${id}`, { cache: 'no-store', signal: AbortSignal.timeout(8000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error('Community service unavailable.');
  const body = await response.json();
  return body.data.harness;
}
