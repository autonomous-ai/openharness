import { describe, expect, it } from 'vitest';
import { commentTotal, keepEarlier, threadComments } from './comments';
import type { HarnessComment } from './types';

const comment = (id: string, parentId?: string): HarnessComment => ({ id, parentId, body: id, authorName: 'A', createdAt: '2026-10-09', mine: false });

describe('threadComments', () => {
  it('draws each reply, and a reply to a reply, under the comment that started the conversation', () => {
    const ordered = threadComments([comment('a'), comment('b'), comment('a1', 'a'), comment('b1', 'b'), comment('a2', 'a1')]);
    expect(ordered.map(item => item.id)).toEqual(['a', 'a1', 'a2', 'b', 'b1']);
  });
  it('keeps a reply to a missing comment where it was posted, and survives a cycle', () => {
    expect(threadComments([comment('a'), comment('x1', 'gone'), comment('b')]).map(item => item.id)).toEqual(['a', 'x1', 'b']);
    expect(threadComments([comment('p', 'q'), comment('q', 'p')])).toHaveLength(2);
  });
  it('counts every comment when the backend says how many there are', () => {
    expect(commentTotal({ comments: [comment('a')], commentCount: 140 })).toBe(140);
    expect(commentTotal({ comments: [comment('a')] })).toBe(1);
  });
});

describe('earlier comments across a refresh', () => {
  const at = (id: string, createdAt: string): HarnessComment => ({ ...comment(id), createdAt });
  it('keeps what was read further back before the refreshed latest page, with no gap where it moved', () => {
    const before = [at('old', '2026-10-01'), at('older-page-end', '2026-10-02'), at('latest-1', '2026-10-03'), at('latest-2', '2026-10-04')];
    // A new comment pushed latest-1 out of the latest page: it is still read, so it stays.
    const latest = [at('latest-2', '2026-10-04'), at('new', '2026-10-05')];
    expect(keepEarlier(before, latest).map(item => item.id)).toEqual(['old', 'older-page-end', 'latest-1', 'latest-2', 'new']);
    expect(keepEarlier(before, [])).toEqual([]);
  });
});
