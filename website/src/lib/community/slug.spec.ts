import { describe, expect, it } from 'vitest';
import { harnessPath, harnessSlug, isHarnessAddress, namesPublication, slugifyTitle } from './slug';

const id = 'fb726d28-ce56-4417-bfc4-acf3625d0fc2';

describe('harness web addresses', () => {
  it('names a publication by its title and the first characters of its id', () => {
    expect(harnessSlug({ id, title: 'PAC-MAN: Neon Maze Chase' })).toBe('pac-man-neon-maze-chase-fb726d28');
    expect(harnessPath({ id, title: 'Phở bò, đậm đà!' })).toBe('/hub/pho-bo-dam-da-fb726d28');
  });
  it('keeps a long title to whole words, and a title with no letters to the id', () => {
    const slug = slugifyTitle('A very long title that keeps going well past the sixty characters a slug holds');
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug).toBe('a-very-long-title-that-keeps-going-well-past-the-sixty');
    expect(harnessSlug({ id, title: '日本語' })).toBe('fb726d28');
  });
  it('leaves a starter at its own id', () => {
    expect(harnessSlug({ id: 'starter-pocket-film', title: 'Pocket film' })).toBe('starter-pocket-film');
  });
  it('tells which addresses can name a publication', () => {
    expect(isHarnessAddress('pac-man-neon-maze-chase-fb726d28')).toBe(true);
    expect(isHarnessAddress('Bad Address')).toBe(false);
    expect(namesPublication(id)).toBe(true);
    expect(namesPublication('pac-man-neon-maze-chase-fb726d28')).toBe(true);
    expect(namesPublication('starter-pocket-film')).toBe(false);
  });
});
