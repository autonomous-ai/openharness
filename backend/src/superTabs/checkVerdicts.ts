/**
 * Each checker's verdict on a task check (Diego, 2026-11-03, #2311): Review and Test record the same checks in parallel, so
 * a later pass by one checker used to erase another's failure and its evidence. A check keeps every checker's latest
 * verdict; `passedBy` and `evidence`, which every older reader reads, are derived from them with a failure winning.
 *
 * A verdict counts only at the pull request head it read (Dee, #3394): a newer head stops it counting unless the pull
 * request's own patch is the same (a plain rebase, or a main merge that leaves its diff unchanged). It replaces reading a
 * verdict's text: a stale pass passes nothing, and a stale failure fails nothing, until someone checks the new head.
 */
import type { Check, CheckVerdict, PullRequestHead } from './model.js'

/** Each linked pull request's head as the PR watch last read it (Conversation.pullRequestHeads). */
export type PullRequestHeads = Readonly<Record<string, PullRequestHead>>

/** Whether [head] names [full]: the same commit, written in full or shortened (seven characters at least). */
const sameHead = (full: string, head: string) => head.length >= 7 && full.toLowerCase().startsWith(head.toLowerCase())

/** Whether [verdict] counts against [heads]: one with no head, or on a pull request no head is known for, counts as verdicts
 *  always did; otherwise only at that head, or at a head whose patch id is its own. A patch nobody could read (null) matches
 *  nothing, so only the exact head counts there. */
export function verdictCounts(verdict: CheckVerdict, heads: PullRequestHeads | undefined): boolean {
  const current = verdict.pullRequest && verdict.head ? heads?.[verdict.pullRequest] : undefined
  if (!current) return true
  return sameHead(current.head, verdict.head!) || (!!verdict.patch && current.patch === verdict.patch)
}

/** [verdict] at a head whose patch id is known learns it: from [known] when that is the head it read. */
function learnPatch(verdict: CheckVerdict, known: PullRequestHead | undefined): void {
  if (verdict.patch || !verdict.head || !known?.patch || !sameHead(known.head, verdict.head)) return
  verdict.patch = known.patch
}

/** Derives [check]'s `passedBy` and `evidence` from the verdicts that count against [heads], and marks the others stale
 *  with the head they stopped at. It passes only while no counting verdict failed: its latest counting passer; its evidence
 *  is the latest counting failure's, else that pass's, else none (a check nobody checked at this head reads unchecked). */
export function deriveCheck(check: Check, heads: PullRequestHeads | undefined): void {
  const verdicts = check.verdicts ?? []
  for (const verdict of verdicts) {
    if (verdictCounts(verdict, heads)) delete verdict.stale
    else verdict.stale = heads![verdict.pullRequest!]!.head
  }
  const live = verdicts.filter(v => v.stale === undefined)
  const failed = live.findLast(v => !v.passed), passed = live.findLast(v => v.passed)
  check.passedBy = failed ? null : passed?.by ?? null
  check.evidence = (failed ?? passed)?.evidence ?? null
}

/** Records [verdict] on [check], in place of its checker's earlier one (`earlier`, undefined on its first). The verdicts are
 *  kept oldest first. A pass kept from before verdicts were is its checker's verdict; a failure from then names no checker,
 *  so it is not kept. A pass also drops the failures of the checkers [clears] names, and returns them (`cleared`) for the
 *  caller to record: those who left the Swarm, when someone accountable for the task passes it (#2656), as nobody else
 *  could ever pass it in their place. [heads]: the task's pull requests' heads, which the verdicts count against. */
export function recordCheckVerdict(check: Check, verdict: CheckVerdict, clears: (by: string) => boolean = () => false,
  heads?: PullRequestHeads): { earlier: CheckVerdict | undefined; cleared: CheckVerdict[] } {
  const kept = check.verdicts ?? (check.passedBy ? [{ by: check.passedBy, passed: true, evidence: check.evidence ?? '', at: 0 }] : [])
  const earlier = kept.find(v => v.by === verdict.by)
  const cleared = verdict.passed ? kept.filter(v => v !== earlier && !v.passed && clears(v.by)) : []
  if (verdict.pullRequest) learnPatch(verdict, heads?.[verdict.pullRequest])
  check.verdicts = [...kept.filter(v => v !== earlier && !cleared.includes(v)), verdict]
  deriveCheck(check, heads)
  return { earlier, cleared }
}

/** The PR watch read a new head of [url] (its head before: [previous]; every head now: [heads]): each verdict on it learns
 *  the patch id of the head it read, when the watch knows it, and [checks] are derived again. The checks that passed before
 *  and do not now, for the caller to tell. */
export function refreshChecks(checks: readonly Check[], url: string, previous: PullRequestHead | undefined, heads: PullRequestHeads): Check[] {
  const stopped: Check[] = []
  for (const check of checks) {
    if (!check.verdicts?.length) continue
    for (const verdict of check.verdicts) {
      if (verdict.pullRequest !== url) continue
      learnPatch(verdict, previous)
      learnPatch(verdict, heads[url])
    }
    const before = check.passedBy
    deriveCheck(check, heads)
    if (before && !check.passedBy) stopped.push(check)
  }
  return stopped
}
