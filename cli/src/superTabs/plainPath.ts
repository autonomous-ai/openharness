/** The most letters of a file's path a line says: its end, where its name is. */
const PATH_MAX = 100

/** A file's path as a line says it: its letters, digits, spaces and `. _ / + -`, the last [PATH_MAX] of them. A path is the
 *  text of whoever landed the file, and the line is typed to an agent and posted where an @ tags, a link is followed and a
 *  backtick ends its code span (pmNumbers.ts plainName, for a name). Its own file: the merger says one too, and through the
 *  numbers it imported itself again (githubMerge → pmNumbers → githubVerdict → githubMerge, review of #4177). */
export function plainPath(path: string): string {
  const letters = [...path.replace(/[^\p{L}\p{M}\p{N} ._/+-]/gu, '')]
  return letters.length > PATH_MAX ? `…${letters.slice(1 - PATH_MAX).join('')}` : letters.join('')
}
