import { describe, expect, it } from 'vitest';
import { desktopForkLink, forkRequestId } from './handoff';
import { getStarter } from './server';
import { starterHarnesses } from './starters';
import { zipFiles } from './bundle';

describe('desktop fork handoff', () => {
  it('uses a stable receipt across installing and retrying', () => {
    const id = forkRequestId('starter-moonlight');
    expect(forkRequestId('starter-moonlight')).toBe(id);
    expect(desktopForkLink('starter-moonlight', id)).toBe(`harness://fork/starter-moonlight?request=${id}`);
    expect(() => desktopForkLink('../escape', id)).toThrow();
    expect(() => desktopForkLink('starter-moonlight', 'https://example.com')).toThrow();
  });
  it('includes original domain source and native output in every reused example', async () => {
    for (const [id, source, output] of [['starter-ribbon-lamp', 'scenes/hello.py', 'out/model.glb'], ['starter-harness-keynote', 'deck.md', 'assets/hero.svg'], ['starter-portable-light', 'main.typ', 'out/main.pdf']]) {
      const snapshot = await getStarter(id);
      expect(snapshot?.files.find(f => f.path === source)?.content.length).toBeGreaterThan(500);
      expect(snapshot?.files.find(f => f.path === output)).toBeTruthy();
      expect(snapshot?.harnessId).toMatch(/^autonomous\//);
    }
    expect(starterHarnesses).toHaveLength(18);
    expect(starterHarnesses.filter(h => !h.harnessId).every(h => h.engine === 'Codex')).toBe(true);
  });
  it('writes actual binary ZIP content, not base64 text', () => {
    const bytes = zipFiles([{ path: 'model.glb', content: 'Z2xURg==', encoding: 'base64' }]);
    expect(new TextDecoder().decode(bytes.slice(39, 43))).toBe('glTF');
  });
});
