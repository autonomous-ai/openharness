/**
 * What the merge train may merge, and how it groups pull requests (task #3402). Pure: the pass (train.ts) reads GitHub and the
 * Swarm and hands the answers here. Every unknown reads as "not yet": a pull request merged with too little evidence cannot
 * be taken back, and one that waits a pass costs ten minutes.
 */
import type { Check, CheckVerdict, Conversation } from '../model.js'
import { FAST_LANE, REVIEW_AREAS, SECURITY_READS, TRAIN_HOLD_LABELS } from './config.js'

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

/** The verdict fields task #3394 adds (checkVerdicts.ts there): the pull request and head it was given at, the head's patch
 *  id, and where it stopped counting. Optional here so this reads verdicts written before them, which never count. */
type HeadVerdict = CheckVerdict & { pullRequest?: string; head?: string; patch?: string | null; stale?: unknown }
interface PullRequestHead { head: string; patch: string | null; at: number }

/** The parts of a task, and of its steps, the train reads. */
export interface TrainTask {
  checks: Check[]
  /** Each linked pull request's head and patch id as the PR watch last read them (task #3394). */
  pullRequestHeads?: Record<string, PullRequestHead>
  steps: Array<Pick<Conversation, 'step' | 'title' | 'checks' | 'archived' | 'assignment'>>
}

const REVIEW_STEP = /review/i
const MIN_PREFIX = 7

/** Whether [verdict] counts at [url]'s current head [now]: given at that head (a 7+ character prefix of it, as #3394 reads
 *  one), or at a head whose patch is the same. A verdict with no head never counts here, though old clients still count it:
 *  merging needs the head it read. */
function countsAt(verdict: HeadVerdict, url: string, now: PullRequestHead): boolean {
  if (!verdict.head || verdict.stale || verdict.pullRequest !== url) return false
  if (verdict.head.length >= MIN_PREFIX && now.head.startsWith(verdict.head)) return true
  return !!verdict.patch && verdict.patch === now.patch
}

/** The checkers whose passes count on [check], or null when it has no pass that counts or a failure that does. */
function passers(check: Check, url: string, now: PullRequestHead): string[] | null {
  const counting = ((check.verdicts ?? []) as HeadVerdict[]).filter(v => countsAt(v, url, now))
  if (!counting.length || counting.some(v => !v.passed)) return null
  return counting.map(v => v.by)
}

/**
 * How many independent reads [task]'s pull request [url] has at [head], the head GitHub shows now: the reviewers whose review
 * steps passed there, each once. Null when it may not merge whatever the count: the PR watch has not seen this head yet, no
 * review step passed, or the task's own checks or another step (a test) did not pass at this head. A cancelled step does not
 * count either way; any other step must be done.
 */
export function headReads(task: TrainTask, url: string, head: string): number | null {
  const now = task.pullRequestHeads?.[url]
  if (!now || now.head !== head) return null
  if (!task.checks.every(check => passers(check, url, now))) return null
  const readers = new Set<string>()
  let reviewed = false
  for (const step of task.steps) {
    const status = step.assignment?.status
    if (status === 'cancelled') continue
    if (status !== 'done' || !step.checks.length) return null
    const found = step.checks.map(check => passers(check, url, now))
    if (found.some(list => !list)) return null
    if (REVIEW_STEP.test(step.step ?? step.title)) {
      reviewed = true
      for (const list of found) for (const by of list!) readers.add(by)
    }
  }
  return reviewed ? readers.size : null
}

/** The review table's part the train reads (task #3393 rules.reviews). */
export interface ReviewTable { defaultReads: number; rows: Array<{ area: string; reads: number }> }

/** The reads [files] need: the most any area they touch asks, never fewer than the default. Without a table, each security
 *  area needs [SECURITY_READS]. */
export function requiredReads(files: readonly string[], reviews?: ReviewTable): number {
  let reads = reviews?.defaultReads ?? 1
  for (const { area, paths } of REVIEW_AREAS) {
    if (!files.some(file => paths.test(file))) continue
    const row = reviews?.rows.find(r => r.area.toLowerCase() === area.toLowerCase())
    reads = Math.max(reads, reviews ? row?.reads ?? reviews.defaultReads : SECURITY_READS)
  }
  return reads
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
