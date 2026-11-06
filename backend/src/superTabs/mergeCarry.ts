/**
 * A verdict carries over a main merge git resolves by itself (task #3553, Dee's Swarm redesign, 11-06): about 40 review rounds
 * overnight only confirmed that a pull request's new head was its reviewed head plus a clean merge of main. A head carries its
 * first parent's verdicts (checkVerdicts.ts verdictCounts) only when it is exactly git's automatic merge of that parent and a
 * commit of the branch the pull request merges into, judged here from GitHub's own comparisons (github/app.ts mainMergeSides),
 * never from anything the pull request says.
 *
 * Exactly git's merge: no file is changed on both sides since their merge base (git would merge its lines, and nobody read
 * that result), and the merge commit changes from its first parent exactly the files main changed, each to main's own blob
 * with main's own status. Then every path of the merge holds either the reviewed blob or main's, as git's merge would; any
 * hand-resolved line, any added change, any file left out, is another blob or another file, and carries nothing. GitHub's
 * comparisons give no file mode, so a mode alone changed on a file main also changed is not seen (named in #3553's security
 * review).
 */
import type { PullRequestFile } from './pullRequestPatch.js'

/** What GitHub says of a head, to judge it (github/app.ts mainMergeSides): its parents; whether its second parent is on the
 *  branch the pull request merges into; and the files of each side since the merge base of its two parents (the pull
 *  request's side, from it to the first parent; main's, from it to the second), and from the first parent to the head. */
export interface MergeSides {
  parents: string[]
  onBase: boolean
  prSide: PullRequestFile[]
  mainSide: PullRequestFile[]
  mergeSide: PullRequestFile[]
}

/** Every path a side touches, a rename's old name too: a file renamed on one side and changed on the other is on both. */
const paths = (files: readonly PullRequestFile[]): Set<string> =>
  new Set(files.flatMap(f => f.previousFilename ? [f.filename, f.previousFilename] : [f.filename]))

/** A file as its blob, status and old name: what the merge must give it, as main has it. */
const as = (f: PullRequestFile) => `${f.status}\0${f.previousFilename ?? ''}\0${f.sha}`

/** The head whose verdicts [sides]' head carries, its first parent, when the head is exactly git's automatic merge of it and a
 *  commit of the base branch; else null. */
export function cleanMainMergeOf(sides: MergeSides): string | null {
  const [parent, merged] = sides.parents
  if (sides.parents.length !== 2 || !parent || !merged || !sides.onBase || !sides.mainSide.length) return null
  // A file both sides changed is merged line by line by git: a reviewer reads that result.
  const ours = paths(sides.prSide)
  if ([...paths(sides.mainSide)].some(path => ours.has(path))) return null
  // The merge changes exactly main's files, each as main has it.
  if (sides.mergeSide.length !== sides.mainSide.length || new Set(sides.mergeSide.map(f => f.filename)).size !== sides.mergeSide.length) return null
  const main = new Map(sides.mainSide.map(f => [f.filename, as(f)]))
  return sides.mergeSide.every(f => main.get(f.filename) === as(f)) && main.size === sides.mainSide.length ? parent : null
}

/** The most heads one head's verdicts may carry from: a chain of clean main merges, newest first. */
export const CARRIES_KEPT = 20
