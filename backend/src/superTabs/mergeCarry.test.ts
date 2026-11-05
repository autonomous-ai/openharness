/**
 * A verdict carries over a main merge git resolves by itself (task #3553, 11-06): about 40 review rounds overnight only
 * confirmed that a new head was the reviewed head plus a clean merge of main. A head carries its first parent's verdicts only
 * when it is exactly git's automatic merge of that parent and a commit of the base branch; any hand-resolved line, any other
 * change, or any file both sides changed needs a reviewer again.
 */
import { describe, expect, it } from 'vitest'
import { cleanMainMergeOf, type MergeSides } from './mergeCarry.js'
import type { PullRequestFile } from './pullRequestPatch.js'

const H = 'a'.repeat(40), B = 'b'.repeat(40)
const file = (filename: string, sha: string, status = 'modified', previousFilename?: string): PullRequestFile =>
  ({ filename, status, sha, ...previousFilename ? { previousFilename } : {} })
/** The pull request changed app.ts; main changed README.md and lib.ts; the merge brought exactly main's two files. */
const clean = (): MergeSides => ({
  parents: [H, B], onBase: true,
  prSide: [file('app.ts', 'p1')],
  mainSide: [file('README.md', 'm1'), file('lib.ts', 'm2')],
  mergeSide: [file('lib.ts', 'm2'), file('README.md', 'm1')],
})

describe('a head that is a clean main merge', () => {
  it('carries its first parent\'s verdicts when it is exactly git\'s automatic merge', () => {
    expect(cleanMainMergeOf(clean())).toBe(H)
    // Main added and removed files too: the merge brings them as main has them.
    expect(cleanMainMergeOf({ ...clean(), mainSide: [file('new.ts', 'n1', 'added'), file('old.ts', 'o1', 'removed')],
      mergeSide: [file('new.ts', 'n1', 'added'), file('old.ts', 'o1', 'removed')] })).toBe(H)
  })

  it('carries nothing when a line was resolved or changed by hand in the merge', () => {
    // lib.ts as main has it is m2; the merge commit has another blob.
    expect(cleanMainMergeOf({ ...clean(), mergeSide: [file('lib.ts', 'edited'), file('README.md', 'm1')] })).toBeNull()
    // A file main never changed, changed in the merge commit.
    expect(cleanMainMergeOf({ ...clean(), mergeSide: [...clean().mergeSide, file('app.ts', 'p2')] })).toBeNull()
    // A file main changed, left out of the merge.
    expect(cleanMainMergeOf({ ...clean(), mergeSide: [file('lib.ts', 'm2')] })).toBeNull()
    // The same blob with another status (a removal kept, a rename made a copy).
    expect(cleanMainMergeOf({ ...clean(), mainSide: [file('old.ts', 'o1', 'removed')], mergeSide: [file('old.ts', 'o1', 'modified')] })).toBeNull()
  })

  it('carries nothing when both sides changed a file: git merges its lines, which needs a reviewer to read', () => {
    expect(cleanMainMergeOf({ ...clean(), mainSide: [file('app.ts', 'm3')], mergeSide: [file('app.ts', 'm3')] })).toBeNull()
    // A rename on one side of a file the other changed is both sides too.
    expect(cleanMainMergeOf({ ...clean(), mainSide: [file('app2.ts', 'm4', 'renamed', 'app.ts')], mergeSide: [file('app2.ts', 'm4', 'renamed', 'app.ts')] })).toBeNull()
  })

  it('carries nothing for a commit that is not a merge of main', () => {
    expect(cleanMainMergeOf({ ...clean(), parents: [H] })).toBeNull()
    expect(cleanMainMergeOf({ ...clean(), parents: [H, B, 'c'.repeat(40)] })).toBeNull()
    // Its second parent is not on the branch the pull request merges into.
    expect(cleanMainMergeOf({ ...clean(), onBase: false })).toBeNull()
    // A merge that brought nothing from main is no main merge.
    expect(cleanMainMergeOf({ ...clean(), mainSide: [], mergeSide: [] })).toBeNull()
  })
})
