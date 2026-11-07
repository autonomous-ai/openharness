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
  /** Whether its Engineer set it done: only a done task hears why its pull request keeps waiting (skipReason). */
  done?: boolean
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

const FAILED = 'a failed verdict counts at this head'

/** The checkers whose passes count on [check], or in plain words why none does: a failure that counts, only the builders'
 *  passes (ignored), no verdict at this head and base, or no verdict at all. A verdict by an agent that has since left the
 *  project counts like any other: the train reads no roster. */
function passers(check: Check, url: string, heads: PullRequestHeads, ignored: ReadonlySet<string> = new Set()): string[] | string {
  const verdicts = check.verdicts ?? []
  const counting = verdicts.filter(v => countsFor(v, url, heads)), others = counting.filter(v => !ignored.has(v.by))
  if (others.some(v => !v.passed)) return FAILED
  if (others.length) return others.map(v => v.by)
  if (counting.length) return 'only the task\'s own builders passed it, and a builder is never its own review or test'
  return verdicts.length ? 'no verdict was read at this head on this base: it moved since, or the verdict is marked stale' : 'nobody has passed it yet'
}

/**
 * How many independent reads [task]'s pull request [url] has at [head], the head GitHub shows now: the reviewers whose review
 * steps passed there, each once. Otherwise, in plain words, the rule it fails: the PR watch has not seen this head yet, no
 * review step passed, or the task's own checks or another step (a test) did not pass at this head. A cancelled step does not
 * count either way; any other step must be done.
 */
export function headReads(task: TrainTask, url: string, head: string, base: string): number | string {
  const heads = task.pullRequestHeads, now = heads?.[url]
  // GitHub's live head and base must be the ones the watch read (task #3493, Ledger's case on #3218): a pull request retargeted
  // since then carries verdicts read against another branch, which the shared check still counts until the watch reads it.
  if (!heads || !now) return 'the pull request watch has not read this pull request yet'
  if (now.head.toLowerCase() !== head.toLowerCase()) return 'the pull request watch has not read its head on GitHub yet'
  if (!plainBase(now.base) || !plainBase(base) || now.base !== base) return 'its base branch is not the one the pull request watch recorded'
  const builders = new Set(task.builders ?? [])
  // A builder never passes its own check, here as on its steps (task #4561). A Done task's checks that nobody else passed at this
  // head stand in by its steps below; a failure that counts holds it whatever.
  for (const check of task.checks) {
    const found = passers(check, url, heads, builders)
    if (typeof found === 'string' && (!task.done || found === FAILED)) return `the task's check "${check.description.slice(0, 60)}": ${found}`
  }
  const readers = new Set<string>()
  let reviewed = false
  for (const step of task.steps) {
    const status = step.assignment?.status, name = step.step ?? step.title
    if (status === 'cancelled') continue
    if (status !== 'done') return `the ${name} step is not done`
    if (!step.checks.length) return `the ${name} step has no checks`
    const found = step.checks.map(check => passers(check, url, heads, builders))
    const refused = found.find((list): list is string => typeof list === 'string')
    if (refused) return `the ${name} step: ${refused}`
    if (REVIEW_STEP.test(name)) {
      reviewed = true
      for (const list of found) for (const by of list as string[]) readers.add(by)
    }
  }
  return reviewed ? readers.size : 'no Review step has passed'
}

/**
 * The descriptions of [task]'s own checks that count for its pull request [url] only through its steps (task #4561): nobody but
 * its builders passed them at this head, and nobody failed them. Once the task is Done, every step said Yes at the head and
 * ci/required is green, the train merges it on those steps and says so on the task.
 */
export function standsIn(task: TrainTask, url: string): string[] {
  const heads = task.pullRequestHeads ?? {}, builders = new Set(task.builders ?? [])
  return task.checks.filter(check => { const found = passers(check, url, heads, builders); return typeof found === 'string' && found !== FAILED })
    .map(check => check.description)
}

export type Ineligible = 'closed' | 'draft' | 'base' | 'hold' | 'ci' | 'mergeable' | 'conflict' | 'verdict' | 'reads'

/** Whether [candidate] may join a batch, given its [reads] at its head (headReads) and the reads its files need. */
export function eligible(candidate: TrainCandidate, reads: number | string, required: number): { ok: true } | { ok: false; why: Ineligible } {
  const no = (why: Ineligible) => ({ ok: false as const, why })
  if (candidate.state !== 'open') return no('closed')
  if (candidate.draft) return no('draft')
  if (candidate.base !== 'main') return no('base')
  if (candidate.labels.some(label => TRAIN_HOLD_LABELS.includes(label.toLowerCase()))) return no('hold')
  if (candidate.ciRequired !== 'success') return no('ci')
  if (candidate.mergeable === null) return no('mergeable')
  if (candidate.mergeable === false) return no('conflict')
  if (typeof reads === 'string') return no('verdict')
  if (reads < required) return no('reads')
  return { ok: true }
}

/** Why the train passes over [candidate] in plain words, with a key that changes only when the reason does; null when the
 *  Engineer already hears it as its own line (a conflict, too few reads) or there is nothing to say (closed). [verdict] is the
 *  rule headReads named. */
export function skipReason(why: Ineligible, candidate: TrainCandidate, verdict: string): { key: string; text: string } | null {
  switch (why) {
    case 'closed': case 'conflict': case 'reads': return null
    case 'draft': return { key: why, text: 'it is still a draft' }
    case 'base': return { key: why, text: `it targets ${candidate.base}, and the train merges only into main` }
    case 'hold': return { key: why, text: 'it has the hold label' }
    case 'ci': return { key: `${why}:${candidate.ciRequired}`, text: `ci/required is ${candidate.ciRequired ?? 'not reported'} at its head` }
    case 'mergeable': return { key: why, text: 'GitHub has not yet worked out whether it merges cleanly' }
    case 'verdict': return { key: `${why}:${verdict}`, text: `the train does not count its reviews and tests: ${verdict}` }
  }
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
