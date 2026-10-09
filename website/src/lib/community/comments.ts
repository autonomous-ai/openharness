import type { HarnessComment } from './types';

/**
 * Comments in reading order: each conversation under the comment that started it, oldest first.
 * A reply whose comment is gone (deleted, or older than the comments read) stays where it was posted.
 */
export function threadComments(comments: HarnessComment[]): HarnessComment[] {
  const byId = new Map(comments.map(comment => [comment.id, comment]));
  const rootOf = (comment: HarnessComment) => {
    let current = comment;
    // Bounded by the list's length, so a malformed cycle cannot loop.
    for (let depth = 0; depth < comments.length; depth++) {
      const parent = current.parentId ? byId.get(current.parentId) : undefined;
      if (!parent) break;
      current = parent;
    }
    return current.id;
  };
  const threads = new Map<string, HarnessComment[]>();
  for (const comment of comments) {
    const root = rootOf(comment), thread = threads.get(root);
    if (thread) thread.push(comment);
    else threads.set(root, [comment]);
  }
  return [...threads.values()].flat();
}

/** How many comments a harness has: the backend's count, or the ones read from an older backend. */
export const commentTotal = (social: { comments: HarnessComment[]; commentCount?: number }) => social.commentCount ?? social.comments.length;
