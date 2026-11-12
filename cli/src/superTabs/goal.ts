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
 * (the workflow `harness super-tab goal write` writes does, goalStarter.ts); Harness runs nothing. Here the file is read from the
 * default branch, and the checks from the newest of that branch's last landings on which every milestone's check has ended: a
 * milestone passes when its check concluded success there, fails when it concluded any other way that is a verdict (a failure, or cancelled as one that ran past its limit is), and waits
 * otherwise. The
 * branch's tip has no run yet in the minutes after each landing, and never when it was pushed with `[skip ci]`: scored alone,
 * a goal read "0 of 60 pass, 60 wait" most of the time (its first review). A landing is a commit on the branch's first-parent
 * line: a train that lands as a merge commit brings its members' commits with it, which were never pushed to the branch and
 * carry no check of it (its second review). A project with no file, or no row, has no goal.
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
/** How many of the branch's last landings are looked at for one whose goal checks have all ended, among how many of its last
 *  commits: a train of twenty brings twenty merge commits and their pull requests' own. */
const LANDINGS = 5
/** The longest line read as a row: a milestone, a command and a few bars. It bounds a check's command, which goes to CI whole. */
export const LINE_MAX = 1_000

/** A milestone and the command that checks it. */
interface GoalRow { milestone: string; check: string }
/** How many milestones the goal has, and of them how many pass, fail and wait for their check. */
export interface Score { total: number; passed: number; failed: number; waiting: number }

/** The rows of a goal file: each table row whose second cell is a command in backticks, in the file's order. A header, a rule,
 *  a row with no command and any other line are none; a milestone named twice counts once, as its check has one name. The
 *  workflow's own reader is these lines again (goalStarter.ts GOAL_READER). */
export function goalRows(text: string | null): GoalRow[] {
  const rows = new Map<string, GoalRow>()
  for (const line of (text ?? '').split(/\r?\n/)) {
    if (line.length > LINE_MAX) continue
    // `| milestone | \`check\` |`, found from the row's end by plain searches: the check is between its last two backticks, with
    // a bar after them and a bar before. As one pattern this took time by the cube of the line's length (a 1,000-character line
    // of spaces a fifth of a second, a file of them minutes: review of the Desktop score, 2026-11-11).
    const row = line.trim(), cell = row.slice(0, -1).trimEnd(), open = cell.lastIndexOf('`', cell.length - 2)
    const head = cell.slice(0, open).trimEnd(), named = head.slice(1, -1).trim()
    if (!row.startsWith('|') || !row.endsWith('|') || !cell.endsWith('`') || open < 0 || !head.endsWith('|')) continue
    // A milestone is one line's words: one with a line's end inside it is none.
    const milestone = /[\r\u2028\u2029]/.test(named) ? '' : named.replace(/\s+/g, ' '), check = cell.slice(open + 1, -1).trim()
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
    // Skipped or neutral says nothing of the milestone: it waits, as one not run. Cancelled fails: GitHub ends a check that ran
    // past its limit as `cancelled` (seen on a real run, 2026-11-11), and counted as waiting, a hang was never told the PM.
    if (run?.status !== 'completed' || ['skipped', 'neutral'].includes(String(run.conclusion))) score.waiting++
    else if (run.conclusion === 'success') score.passed++
    else score.failed++
  }
  return score
}

/** The goal of [repo] on its [base] branch as it is now, or null when it states none: scored on the newest of the branch's
 *  last [LANDINGS] landings whose goal checks have all ended, or, when none has, on the one with the fewest still waiting (the
 *  newest of those). The commits and their checks are asked outright and not kept: they are large, and asked for once. */
export async function goalOf(reads: GitHubReads, repo: string, base: string): Promise<Score | null> {
  const rows = goalRows(await reads.file(repo, GOAL_FILE))
  if (!rows.length) return null
  const listed = await reads.fresh(repo, `/repos/${repo}/commits?sha=${encodeURIComponent(base)}&per_page=${PAGE}`)
  const commits = (Array.isArray(listed) ? listed.map(object) : []).filter(commit => /^[0-9a-f]{40}$/.test(String(commit.sha)))
  const parent = new Map(commits.map(commit => [String(commit.sha), String(object(Array.isArray(commit.parents) ? commit.parents[0] : undefined).sha ?? '')]))
  let best: Score | null = null
  for (let sha = String(commits[0]?.sha ?? ''), landing = 0; parent.has(sha) && landing < LANDINGS; sha = parent.get(sha)!, landing++) {
    const runs: Json[] = []
    for (let page = 1; page <= CHECK_PAGES; page++) {
      const found = object(await reads.fresh(repo, `/repos/${repo}/commits/${sha}/check-runs?per_page=${PAGE}${page > 1 ? `&page=${page}` : ''}`)).check_runs
      // Only what a score reads of a run is held.
      const held = Array.isArray(found) ? found.map(object).map(run => ({ id: run.id, name: run.name, status: run.status, conclusion: run.conclusion })) : []
      runs.push(...held)
      if (held.length < PAGE) break
    }
    const score = scoreOf(rows, runs)
    if (!score.waiting) return score
    if (!best || score.waiting < best.waiting) best = score
  }
  return best ?? scoreOf(rows, [])
}
