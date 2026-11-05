/**
 * What the merge train may merge, and how it groups pull requests (task #3402). Pure: the pass (train.ts) reads GitHub and the
 * Swarm and hands the answers here. Every unknown reads as "not yet": a pull request merged with too little evidence cannot
 * be taken back, and one that waits a pass costs ten minutes.
 */
import { verdictCounts, type PullRequestHeads } from '../checkVerdicts.js'
import type { Check, CheckVerdict, Conversation, PullRequestHead } from '../model.js'
import { FAST_LANE, TRAIN_HOLD_LABELS } from './config.js'

/** A pull request as the train reads it from GitHub this pass. */
export interface TrainCandidate {
  url: string
  number: number
  head: string
  state: 'open' | 'closed'
  draft: boolean
  base: string
  /** False on a conflict; null while GitHub is still working it out. */
  mergeable: boolean | null
  labels: string[]
  files: string[]
  /** The head's ci/required check: null when it has none yet. */
  ciRequired: 'success' | 'failure' | 'pending' | null
}


/** The parts of a task, and of its steps, the train reads. */
export interface TrainTask {
  checks: Check[]
  /** Each linked pull request's head and patch id as the PR watch last read them (task #3394). */
  pullRequestHeads?: Record<string, PullRequestHead>
  steps: Array<Pick<Conversation, 'step' | 'title' | 'checks' | 'archived' | 'assignment'>>
  /** Who built the task, as verdicts name checkers (`agent:ID`): its assignee and every earlier attempt's agent. Their verdicts
   *  on its steps count for nothing: a builder is never its own review or test (review 1 of #3226). */
  builders?: string[]
}

const REVIEW_STEP = /review/i
/** A branch name with a control or format character (a zero-width space, a bidi override) can read as "main" on screen and
 *  be another branch: the train reads nothing from one (task #3493). */
const HIDDEN = /[\p{Cc}\p{Cf}]/u
const plainBase = (base: string | undefined): base is string => !!base && !HIDDEN.test(base)

/** Whether [verdict] counts for [url]: the shared verdict check (checkVerdicts.ts, #3394: its head on its base, or the same
 *  patch, whose id names its base), on a verdict naming this pull request and the head it read, and not marked stale (an
 *  empty mark too: its head not read yet). Never a verdict without them, though the shared check reads one of those
 *  against the task's latest watched head. */
const countsFor = (verdict: CheckVerdict, url: string, heads: PullRequestHeads): boolean =>
  verdict.pullRequest === url && !!verdict.head && verdict.stale === undefined && verdictCounts(verdict, heads)

/** The checkers whose passes count on [check], or null when it has no pass that counts or a failure that does. */
function passers(check: Check, url: string, heads: PullRequestHeads, ignored: ReadonlySet<string> = new Set()): string[] | null {
  const counting = (check.verdicts ?? []).filter(v => !ignored.has(v.by) && countsFor(v, url, heads))
  if (!counting.length || counting.some(v => !v.passed)) return null
  return counting.map(v => v.by)
}

/**
 * How many independent reads [task]'s pull request [url] has at [head], the head GitHub shows now: the reviewers whose review
 * steps passed there, each once. Null when it may not merge whatever the count: the PR watch has not seen this head yet, no
 * review step passed, or the task's own checks or another step (a test) did not pass at this head. A cancelled step does not
 * count either way; any other step must be done.
 */
export function headReads(task: TrainTask, url: string, head: string, base: string): number | null {
  const heads = task.pullRequestHeads, now = heads?.[url]
  // GitHub's live head and base must be the ones the watch read (task #3493, Ledger's case on #3218): a pull request retargeted
  // since then carries verdicts read against another branch, which the shared check still counts until the watch reads it.
  if (!heads || !now || now.head.toLowerCase() !== head.toLowerCase() || !plainBase(now.base) || !plainBase(base) || now.base !== base) return null
  if (!task.checks.every(check => passers(check, url, heads))) return null
  const readers = new Set<string>(), builders = new Set(task.builders ?? [])
  let reviewed = false
  for (const step of task.steps) {
    const status = step.assignment?.status
    if (status === 'cancelled') continue
    if (status !== 'done' || !step.checks.length) return null
    const found = step.checks.map(check => passers(check, url, heads, builders))
    if (found.some(list => !list)) return null
    if (REVIEW_STEP.test(step.step ?? step.title)) {
      reviewed = true
      for (const list of found) for (const by of list!) readers.add(by)
    }
  }
  return reviewed ? readers.size : null
}

export type Ineligible = 'closed' | 'draft' | 'base' | 'hold' | 'ci' | 'mergeable' | 'conflict' | 'verdict' | 'reads'

/** Whether [candidate] may join a batch, given its [reads] at its head (headReads) and the reads its files need. */
export function eligible(candidate: TrainCandidate, reads: number | null, required: number): { ok: true } | { ok: false; why: Ineligible } {
  const no = (why: Ineligible) => ({ ok: false as const, why })
  if (candidate.state !== 'open') return no('closed')
  if (candidate.draft) return no('draft')
  if (candidate.base !== 'main') return no('base')
  if (candidate.labels.some(label => TRAIN_HOLD_LABELS.includes(label.toLowerCase()))) return no('hold')
  if (candidate.ciRequired !== 'success') return no('ci')
  if (candidate.mergeable === null) return no('mergeable')
  if (candidate.mergeable === false) return no('conflict')
  if (reads === null) return no('verdict')
  if (reads < required) return no('reads')
  return { ok: true }
}

/** `fast` when every file only documents or scripts (FAST_LANE): such a pull request merges on its own green CI. */
export function laneOf(files: readonly string[]): 'fast' | 'code' {
  return files.length && files.every(file => FAST_LANE.some(lane => lane.test(file))) ? 'fast' : 'code'
}

/** The top folders [files] touch, `root` for files at the top, as one name: CI runs per component. */
export function componentOf(files: readonly string[]): string {
  return [...new Set(files.map(file => file.includes('/') ? file.slice(0, file.indexOf('/')) : 'root'))].sort().join('+')
}

/** How a red batch of [members] runs again: one batch per component, or the two halves of one component; a single member
 *  runs no more (it failed on its own). */
export function splitRed<T extends { files: readonly string[] }>(members: readonly T[]): T[][] {
  if (members.length <= 1) return []
  const groups = new Map<string, T[]>()
  for (const member of members) {
    const key = componentOf(member.files)
    groups.set(key, [...groups.get(key) ?? [], member])
  }
  if (groups.size > 1) return [...groups.values()]
  const half = Math.ceil(members.length / 2)
  return [members.slice(0, half), members.slice(half)]
}
