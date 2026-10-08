import { validateDraft, type HubDraft } from '@/lib/community/drafts';
import { communityLimits } from '@/lib/community/contract';
import type { SourceFile } from '@/lib/community/types';

const skippedFolders = ['node_modules', 'build', 'dist', 'target', 'vendor', '__pycache__'];
const bundleFiles = /^(AGENTS\.md|CLAUDE\.md|SESSION\.md|LICENSE|README\.md|harness\.json)$/i;
const portable = /\.(html|css|js|mjs|ts|tsx|jsx|json|md|svg|py|typ|strudel|txt|csv|xml|sdf|png|jpe?g|webp|glb|pdf)$/i;
const binary = /\.(png|jpe?g|webp|glb|pdf)$/i;
const sentNote = 'Images count about a third larger than on disk.';

export type ProjectFolder = { files: SourceFile[]; viewerPath: string; origin?: Pick<HubDraft, 'forkedFrom' | 'harnessId'> & { output?: string } };

/** A fork bundle's output page as it arrived, to tell a new version from the original. */
export const originalOutput = (bundle: HubDraft) => bundle.files?.find(file => file.path === bundle.viewerPath)?.content;

function base64(bytes: Uint8Array): string {
  let raw = '';
  for (let at = 0; at < bytes.length; at += 0x8000) raw += String.fromCharCode(...bytes.subarray(at, at + 0x8000));
  return btoa(raw);
}

/** A file's size as sent, known before reading it: base64 for binary, at least its characters for text. */
const sentSize = (file: File, encoded: boolean) => encoded ? Math.ceil(file.size / 3) * 4 : file.size;

/** A chosen project folder as the Hub stores it: portable files only, measured as they will be sent. */
export async function readProjectFolder(selected: Iterable<File>, preferredViewer: string): Promise<ProjectFolder> {
  const files: SourceFile[] = [];
  let size = 0, origin: ProjectFolder['origin'];
  for (const file of selected) {
    const path = file.webkitRelativePath ? file.webkitRelativePath.split('/').slice(1).join('/') : file.name;
    if (path.split('/').some(part => part.startsWith('.') || skippedFolders.includes(part))) continue;
    if (bundleFiles.test(file.name)) continue;
    if (file.name === 'OPEN-HARNESS.json') {
      const original = validateDraft(JSON.parse(await file.text()));
      origin = { forkedFrom: original.forkedFrom, harnessId: original.harnessId, output: originalOutput(original) };
      continue;
    }
    if (!portable.test(path)) continue;
    if (files.length === communityLimits.files) throw new Error(`Choose up to ${communityLimits.files} portable files.`);
    const encoded = binary.test(path);
    // Refused by size before it is read: a large model or video would otherwise freeze the tab.
    if (encoded && sentSize(file, encoded) > communityLimits.fileChars) throw new Error(`${path} is over 3 MB as sent. ${sentNote}`);
    if (size + sentSize(file, encoded) > communityLimits.projectBytes) throw new Error(`Keep the project under 6 MB as sent. ${sentNote}`);
    const content = encoded ? base64(new Uint8Array(await file.arrayBuffer())) : await file.text();
    if (content.length > communityLimits.fileChars) throw new Error(`${path} is over 3 MB as sent. ${sentNote}`);
    size += new TextEncoder().encode(content).length;
    if (size > communityLimits.projectBytes) throw new Error(`Keep the project under 6 MB as sent. ${sentNote}`);
    files.push({ path, content, ...(encoded ? { encoding: 'base64' as const } : {}) });
  }
  // The page already chosen, or else preview.html. Any other page is offered, never assumed: an app's
  // index.html usually needs files the Hub's sandbox cannot load.
  const viewer = [preferredViewer, 'preview.html'].map(name => files.find(f => f.path === name && f.path.endsWith('.html') && !f.encoding)).find(Boolean);
  if (!files.length) throw new Error('This folder has no portable project files.');
  return { files, viewerPath: viewer?.path ?? preferredViewer, origin };
}

/** A cover as the data URL the Hub stores, or an error naming what it accepts. */
export async function readCover(file: File): Promise<string> {
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type) || file.size > 250_000) throw new Error('Choose a PNG, JPEG, or WebP image under 250 KB.');
  return `data:${file.type};base64,${base64(new Uint8Array(await file.arrayBuffer()))}`;
}
