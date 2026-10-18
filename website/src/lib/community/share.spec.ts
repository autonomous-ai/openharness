import { describe, expect, it } from 'vitest';
import { shareUrl } from './share';

describe('share links', () => {
  const url = 'https://harness.autonomous.ai/hub/pac-man-neon-maze-chase-fb726d28', title = 'PAC-MAN: Neon Maze Chase';
  it('opens each network’s share page with the harness address in it', () => {
    expect(shareUrl('x', url, title)).toBe('https://x.com/intent/tweet?text=PAC-MAN%3A%20Neon%20Maze%20Chase&url=https%3A%2F%2Fharness.autonomous.ai%2Fhub%2Fpac-man-neon-maze-chase-fb726d28');
    expect(shareUrl('facebook', url, title)).toBe('https://www.facebook.com/sharer/sharer.php?u=https%3A%2F%2Fharness.autonomous.ai%2Fhub%2Fpac-man-neon-maze-chase-fb726d28');
    expect(shareUrl('linkedin', url, title)).toBe('https://www.linkedin.com/sharing/share-offsite/?url=https%3A%2F%2Fharness.autonomous.ai%2Fhub%2Fpac-man-neon-maze-chase-fb726d28');
  });
  it('keeps a title’s own characters out of the address', () => {
    expect(shareUrl('x', url, 'Rock & roll #1?')).toContain('text=Rock%20%26%20roll%20%231%3F&url=');
  });
});
