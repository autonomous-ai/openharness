// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Script } from 'node:vm';
import { getStarter } from './server';
import { starterHarnesses } from './starters';
import { forkFiles, zipFiles } from './bundle';
import { previewDocument } from './preview';

describe('portable starter projects', () => {
  it('ships eighteen real outputs with parseable scripts, covers, and a complete installable fork', async () => {
    expect(starterHarnesses).toHaveLength(18);
    for (const summary of starterHarnesses) {
      const harness = (await getStarter(summary.id))!;
      expect(harness.files.length).toBeGreaterThanOrEqual(1);
      for (const match of harness.files[0].content.matchAll(/<script>([\s\S]*?)<\/script>/g)) expect(() => new Script(match[1])).not.toThrow();
      expect((await readFile(`public${summary.cover}`)).length).toBeGreaterThan(100);
      const files = forkFiles(harness), manifest = JSON.parse(files.find(f => f.path.endsWith('/harness.json'))!.content);
      expect(manifest.viewer.use).toBe('autonomous/web-viewer');
      expect(manifest.viewer.url).toBe('http://127.0.0.1:${port}/?file=' + harness.viewerPath);
      expect(files.some(f => f.path.endsWith(`/template/${manifest.workspace.marker}`))).toBe(true);
      expect(files.find(f => f.path.endsWith('/AGENTS.md'))?.content).toContain('SESSION.md');
      expect(files.find(f => f.path.endsWith('/template/SESSION.md'))?.content).toContain('Example conversation');
      const bundle = JSON.parse(files.find(f => f.path.endsWith('/OPEN-HARNESS.json'))!.content);
      expect(bundle.files).toEqual(harness.files); expect(bundle.forkedFrom).toBe(harness.id);
      const zip = zipFiles(files); expect(new DataView(zip.buffer).getUint32(0, true)).toBe(0x04034b50);
      expect(new TextDecoder().decode(zip)).toContain(harness.files[0].content);
    }
  });
  it('rejects path traversal and retains copyright from the fork lineage', async () => {
    expect(() => zipFiles([{ path: '../evil', content: 'oops' }])).toThrow('Invalid project path');
    const harness = (await getStarter('starter-orbit'))!;
    const files = forkFiles({ ...harness, authorName: 'New creator', credits: [{ id: 'starter-orbit', authorName: 'Harness' }] });
    const license = files.find(f => f.path.endsWith('/LICENSE'))!.content;
    expect(license).toContain('Copyright (c) 2026 Harness'); expect(license).toContain('Copyright (c) 2026 New creator');
  });
  it('places the restrictive CSP before author content', () => {
    const html = '<script>parent.document.body.innerHTML = "bad"</script>';
    const preview = previewDocument(html);
    expect(preview.indexOf('Content-Security-Policy')).toBeLessThan(preview.indexOf(html));
    expect(preview).toContain("connect-src 'none'"); expect(preview).toContain("form-action 'none'");
  });
});
