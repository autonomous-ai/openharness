/**
 * A project's goal, as its repository states it and its main branch's checks score it (anh Dee, 2026-11-11: "A goal file with
 * checks").
 *
 * In the 1,000-agent run the goal was 60 statements, each checked by a grader on main: a statement counted when the checker
 * accepted it there, and no agent decided what was done (docs/research/2026-11-10-swarm-study, section 7). In a Swarm, done
 * meant merged, and nothing said how far the project was from what it is for.
 *
 * So a project lists its milestones in `agents/GOAL.md`, a table of two columns: what must be true, and the command that
 * checks it, in backticks. The repository's own CI runs each command on its main branch as a check named `goal: <milestone>`
 * (the workflow `harness super-tab goal` writes does, goalStarter.ts); Harness runs nothing. Here the file is read from the
 * default branch, and the checks from the newest of that branch's last commits on which every milestone's check has ended: a
 * milestone passes when its check concluded success there, and fails when it concluded anything else. The branch's tip has
 * no run yet in the minutes after each landing, and never when it was pushed with `[skip ci]`: scored alone, a goal read "0
 * of 60 pass, 60 wait" most of the time (its first review). A project with no file, or no row, has no goal.
 *
 * Only counts leave here. A milestone's words are the repository's text, and none of them is typed to an agent.
 */
import type { GitHubReads } from './githubRest.js'
import { PAGE } from './githubRest.js'
import { object } from './wire.js'

type Json = Record<string, unknown>

export const GOAL_FILE = 'agents/GOAL.md'
/** How a milestone's check is named on GitHub, before the milestone as its row writes it. */
export const GOAL_CHECK = 'goal: '
/** The most milestones read, and the most each may be long: a check's name on GitHub is short, and a goal of hundreds of rows
 *  is several goals. The run's was 60. */
export const GOAL_MAX = 100, MILESTONE_MAX = 100
/** Pages of a hundred of a commit's checks read for them: a hundred milestones beside two hundred checks of the project's own. */
const CHECK_PAGES = 3
/** How many of the branch's last commits are looked at for one whose goal checks have all ended. */
const COMMITS = 5

/** A milestone and the command that checks it. */
export interface GoalRow { milestone: string; check: string }
/** How many milestones the goal has, and of them how many pass, fail and wait for their check. */
export interface Score { total: number; passed: number; failed: number; waiting: number }

/** The rows of a goal file: each table row whose second cell is a command in backticks, in the file's order. A header, a rule,
 *  a row with no command and any other line are none; a milestone named twice counts once, as its check has one name. The
 *  workflow's own reader is these lines again (goalStarter.ts GOAL_READER). */
export function goalRows(text: string | null): GoalRow[] {
  const rows = new Map<string, GoalRow>()
  for (const line of (text ?? '').split(/\r?\n/)) {
    const found = /^\|\s*(.+?)\s*\|\s*`([^`]+)`\s*\|\s*$/.exec(line.trim())
    const milestone = found?.[1]!.replace(/\s+/g, ' '), check = found?.[2]!.trim()
    if (!milestone || !check || milestone.length > MILESTONE_MAX || rows.has(milestone)) continue
    rows.set(milestone, { milestone, check })
    if (rows.size >= GOAL_MAX) break
  }
  return [...rows.values()]
}

/** The score of [rows] from the check [runs] of one commit: each milestone by the newest run of its name. */
export function scoreOf(rows: readonly GoalRow[], runs: readonly Json[]): Score {
  const newest = new Map<string, Json>()
  for (const run of runs) {
    const name = String(run.name ?? '')
    if (Number(run.id ?? 0) >= Number(newest.get(name)?.id ?? 0)) newest.set(name, run)
  }
  const score: Score = { total: rows.length, passed: 0, failed: 0, waiting: 0 }
  for (const { milestone } of rows) {
    const run = newest.get(`${GOAL_CHECK}${milestone}`)
    // Skipped, neutral or cancelled (a newer push took its place) says nothing of the milestone: it waits, as one not run.
    if (run?.status !== 'completed' || ['skipped', 'neutral', 'cancelled'].includes(String(run.conclusion))) score.waiting++
    else if (run.conclusion === 'success') score.passed++
    else score.failed++
  }
  return score
}

/** The goal of [repo] on its [base] branch as it is now, or null when it states none: scored on the newest of the branch's
 *  last [COMMITS] commits whose goal checks have all ended, or on its tip when none has. Unchanged, every read is a 304. */
export async function goalOf(reads: GitHubReads, repo: string, base: string): Promise<Score | null> {
  const rows = goalRows(await reads.file(repo, GOAL_FILE))
  if (!rows.length) return null
  const commits = (await reads.current(repo, `/repos/${repo}/commits?sha=${encodeURIComponent(base)}&per_page=${COMMITS}`, 1)).map(commit => String(commit.sha ?? ''))
  let tip: Score | null = null
  for (const sha of commits.filter(sha => /^[0-9a-f]{40}$/.test(sha))) {
    const runs: Json[] = []
    for (let page = 1; page <= CHECK_PAGES; page++) {
      const listed = object(await reads.one(repo, `/repos/${repo}/commits/${sha}/check-runs?per_page=${PAGE}${page > 1 ? `&page=${page}` : ''}`)).check_runs
      const found = Array.isArray(listed) ? listed.map(object) : []
      runs.push(...found)
      if (found.length < PAGE) break
    }
    const score = scoreOf(rows, runs)
    if (!score.waiting) return score
    tip ??= score
  }
  return tip ?? scoreOf(rows, [])
}
