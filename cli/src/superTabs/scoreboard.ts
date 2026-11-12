/**
 * The day's scoreboard: where a landed change waited, how many were told to rework, what the trains did, and the files most
 * landings touch (docs/design/2026-11-11-swarm-allocator, package 1). The allocator's four walls are merging, CPU, end-to-end
 * tests and disk, and the first is the one GitHub records: every change to the allocator after this is judged by these numbers,
 * week against week, so they go in the day's post beside its counts (pmNumbers.ts dayLine).
 *
 * Read from GitHub alone, with no record of its own: the trains from the closed list the assigner's pass has read already, by
 * the title each was closed with (githubTrain.ts trainEnd); the waits and the rework from the comments of the team's pull
 * requests that landed in the day; the files from the files of the ones that landed in the week; and which files a conflict was
 * likely on (the allocator's design, package 8: what it does for the files most landings touch is judged by them) from those
 * files and, for each change told it conflicts, its task's comments, which say when its work began. Read only as the day's post
 * is made, once a day (pmNumbers.ts keeps what it said with the project's record), the newest [CHANGES_MAX] of each, none of it
 * kept in memory: 100 requests on most days and 250 at the very most, in the PM's person's own name. lampOS had two accounts
 * banned for volume, so nothing here is read every minute. A part GitHub does not give is left out and said ([unread]).
 *
 * It says what it read and no more (its first review): the closed list is one page, which on a busy repository is hours and
 * not a day, so the words count the landings read ("Last 12 landed", "of the last 49 landings") and never name a window they
 * may not have covered; the trains say "at least" when that page was full of the day's.
 */
import { startedAt, tasksOf } from './assign/crew.js'
import { noteOf, verdictOf } from './githubMerge.js'
import { TEAM } from './githubMentions.js'
import { GitHubStop, PAGE, STOP_ASKING, type GitHubReads } from './githubRest.js'
import { trainEnd, type TrainEnd } from './githubTrain.js'
import { landedOf, listed, timeOf } from './pmNumbers.js'
import { plainPath } from './plainPath.js'
import { object } from './wire.js'

type Json = Record<string, unknown>

const MINUTE_MS = 60_000, DAY_MS = 24 * 60 * MINUTE_MS, WEEK_MS = 7 * DAY_MS
/** The most landed changes read for their waits, and for their files: the newest. */
export const CHANGES_MAX = 50
/** Pages of a hundred comments read of one landed change: past them a verdict is not counted. Harness's own notes and asks are
 *  said once for a head, so three hundred comments is a pull request of dozens of heads. */
const COMMENT_PAGES = 3
/** Requests in flight at once. One after another, a hundred requests of about a second each held the assigner's pass for two
 *  minutes, with no task given meanwhile (review, measured on this repository); six at once is a quarter of a minute, and
 *  far under what GitHub lets one login ask together. */
const AT_ONCE = 6
/** A file is named when more than one in [HOT_ONE_IN] of the week's landings touched it, and [HOT_LANDINGS] at least: of five
 *  landings one alone is a fifth, and says nothing. The [HOT_MAX] most touched are named. */
const HOT_ONE_IN = 10, HOT_LANDINGS = 3, HOT_MAX = 3

/** A wait in minutes, as the median over the changes that show it, and how many those were. */
interface Wait { minutes: number; of: number }

export interface Board {
  /** The day's landed changes that were read (the newest): how many; over them, the wait from opened to a first verdict and
   *  from the last READ-OK to landed (null when none shows one); and how many were told they were behind the base, or in
   *  conflict with it. Null when GitHub did not give their comments. */
  waits: { read: number; toVerdict: Wait | null; toLanded: Wait | null; behind: number; conflict: number } | null
  /** The day's trains: how many landed, and how many closed without landing, by why (githubTrain.ts TrainEnd). */
  trains: { landed: number; closed: Partial<Record<TrainEnd, number>> }
  /** The week's landed changes whose files were read (the newest), and the files most of them touched, the most first, each with
   *  how many touched it: by its path as GitHub gives it. Null when GitHub did not give their files. */
  hot: { landings: number; files: Array<[path: string, landings: number]> } | null
  /** The files the day's changes told they conflict shared with what landed while they were built, the most shared first, each with
   *  how many of those changes shared it. Null when GitHub did not give what they are read from. */
  conflicts: Array<[path: string, changes: number]> | null
}

/** The middle of [values], half way between the middle two of an even count, with how many they are; null of none. */
function median(values: number[]): Wait | null {
  const sorted = [...values].sort((a, b) => a - b), half = sorted.length >> 1
  return !sorted.length ? null : { minutes: sorted.length % 2 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2, of: sorted.length }
}

/** [read] of each of [items], [AT_ONCE] at a time, in their order. The first that fails fails them all, and no more are started. */
async function each<T, R>(items: readonly T[], read: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = []
  for (let at = 0; at < items.length; at += AT_ONCE) out.push(...await Promise.all(items.slice(at, at + AT_ONCE).map(read)))
  return out
}

/** The day's trains among the [closed]: a train's pull request merged is one landed; closed without merging, its title says
 *  why. The repository's own people's only: a title is anyone's to write, and on a public repository a stranger's thirty pull
 *  requests titled as red trains would be thirty trains lost. */
function trainsOf(closed: readonly Json[], now: number): Board['trains'] {
  const trains: Board['trains'] = { landed: 0, closed: {} }
  for (const pull of closed.filter(item => item.pull_request && TEAM.has(item.author_association))) {
    const end = trainEnd(String(pull.title ?? '')), merged = timeOf(object(pull.pull_request).merged_at)
    if (!end || now - (merged || timeOf(pull.closed_at)) >= DAY_MS) continue
    // Merged under a title a closed train has, it is neither: nothing the train does leaves one.
    if (!merged) trains.closed[end] = (trains.closed[end] ?? 0) + 1
    else if (end === 'other') trains.landed++
  }
  return trains
}

/**
 * The scoreboard of [repo] at [now], from the [closed] list the assigner's pass read (one page of the issues and pull requests
 * closed last) and the [team]'s labels (assign/crew.ts teamOf). [unread] is told the part GitHub did not give, and why: no more
 * of that part is asked, and the others are read all the same, unless GitHub said to stop asking (githubRest.ts STOP_ASKING).
 */
export async function boardOf(reads: GitHubReads, repo: string, input: { now: number; closed: readonly Json[]; team: ReadonlySet<string> },
  unread: (part: 'waits' | 'files' | 'conflicts', why: string) => void): Promise<Board> {
  const { now, closed, team } = input
  /** The team's pull requests that landed within [window], the last landed first. */
  const landed = (window: number) => landedOf(closed, team, now, window).filter(change => Number.isSafeInteger(change.pull.number) && now - change.at < window)
    .sort((a, b) => b.at - a.at)
  // What GitHub said when it told this login to stop asking: nothing more is asked after it.
  let stopped: string | null = null
  const part = <T>(name: 'waits' | 'files' | 'conflicts', read: () => Promise<T>): Promise<T | null> => (stopped === null ? read() : Promise.reject(new Error(stopped))).catch(error => {
    const why = error instanceof Error ? error.message : String(error)
    if (error instanceof GitHubStop && STOP_ASKING.has(error.code)) stopped = why
    unread(name, why)
    return null
  })
  // The day's are the newest of the week's: every change read for its waits is read for its files too.
  const day = landed(DAY_MS).slice(0, CHANGES_MAX), week = landed(WEEK_MS).slice(0, CHANGES_MAX)
  /** The day's changes told they conflict, as their comments say. */
  let conflicting: typeof day = []
  const waits = await part('waits', async () => {
    const read = await each(day, async ({ pull, at }) => {
      const comments = await reads.freshPages(repo, `/repos/${repo}/issues/${Number(pull.number)}/comments?per_page=${PAGE}`, COMMENT_PAGES)
      // A verdict as the merger reads one (verdictOf), by when it was made: whoever made it, and on whichever head. One made
      // after the change landed did not land it, and was waited for by nobody.
      const verdicts = comments.map(comment => ({ at: timeOf(comment.created_at), verdict: verdictOf(comment) })).filter(said => said.verdict && said.at && said.at <= at)
      const opened = timeOf(pull.created_at), first = Math.min(...verdicts.map(said => said.at))
      const lastOk = Math.max(...verdicts.filter(said => said.verdict === 'READ-OK').map(said => said.at))
      // Told once or ten times, it is one change told.
      const notes = new Set(comments.map(noteOf))
      return { toVerdict: opened && Number.isFinite(first) ? (first - opened) / MINUTE_MS : null, toLanded: Number.isFinite(lastOk) ? (at - lastOk) / MINUTE_MS : null,
        behind: notes.has('behind'), conflict: notes.has('dirty') }
    })
    const wait = (which: 'toVerdict' | 'toLanded') => median(read.flatMap(change => change[which] === null ? [] : [change[which]]))
    conflicting = day.filter((_, at) => read[at]!.conflict)
    return { read: read.length, toVerdict: wait('toVerdict'), toLanded: wait('toLanded'),
      behind: read.filter(change => change.behind).length, conflict: conflicting.length }
  })
  /** The paths each of the week's landings touched, by its pull request's number. */
  const touches = new Map<number, Set<string>>()
  const hot = await part('files', async () => {
    const touched = new Map<string, number>()
    // One page of each: a change of over a hundred files is counted by its first hundred.
    for (const [at, files] of (await each(week, ({ pull }) => reads.freshPages(repo, `/repos/${repo}/pulls/${Number(pull.number)}/files?per_page=${PAGE}`, 1))).entries()) {
      const paths = new Set(files.map(file => String(file.filename ?? '')).filter(Boolean))
      touches.set(Number(week[at]!.pull.number), paths)
      for (const path of paths) touched.set(path, (touched.get(path) ?? 0) + 1)
    }
    const files = [...touched].filter(([, landings]) => landings >= HOT_LANDINGS && landings * HOT_ONE_IN > week.length)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, HOT_MAX)
    return { landings: week.length, files }
  })
  const conflicts = waits && hot ? await part('conflicts', async () => {
    // Its work began as its task was given or taken (assign/crew.ts startedAt), and its branch was made from the base then: what
    // landed from then to its own landing is what it may have conflicted with. A change for no task, or whose task says
    // neither, is counted from its opening, which misses what landed while it was built.
    const began = await each(conflicting, async ({ pull }) => {
      const task = tasksOf(pull)[0]
      return (task === undefined ? null : startedAt(await reads.freshPages(repo, `/repos/${repo}/issues/${task}/comments?per_page=${PAGE}`, 1))) ?? timeOf(pull.created_at)
    })
    const shared = new Map<string, number>()
    for (const [at, { pull, at: landedAt }] of conflicting.entries()) {
      // GitHub gave no time of its opening: nothing says what landed while it was built.
      if (!began[at]) continue
      // Not what landed with it: the train that landed both found no conflict between them.
      const meanwhile = new Set(week.filter(other => other.at > began[at]! && other.at < landedAt).flatMap(other => [...touches.get(Number(other.pull.number))!]))
      for (const path of touches.get(Number(pull.number))!) if (meanwhile.has(path)) shared.set(path, (shared.get(path) ?? 0) + 1)
    }
    return [...shared].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, HOT_MAX)
  }) : null
  return { waits, trains: trainsOf(closed, now), hot, conflicts }
}

/** A wait as a line says it: in minutes, and in hours from two. */
const span = (minutes: number): string => minutes < 120 ? `${Math.round(minutes)} min` : `${Math.round(minutes / 6) / 10} h`

/** Why trains closed without landing, as a line says each, in the order two of one count are said. */
const ENDED: ReadonlyArray<[TrainEnd, string]> = [['red', 'checks failed'], ['moved', 'base moved'], ['changed', 'rider changed'], ['late', 'out of time'], ['other', 'other']]

/**
 * What the day's post says of a [board], a sentence for each part that has something to say, or nothing: "Last 12 landed:
 * 7 min from opened to a first verdict (median of 9), 34 min from the last READ-OK to landing (median of 11); told it was
 * behind: 5; told it conflicts: 2, sharing with what landed meanwhile `backend/src/superTabs/commands.ts` 2. Trains: 4 landed,
 * 3 closed without landing (base moved 2, checks failed 1). Files touched most, of the last 43 landings:
 * `backend/src/superTabs/commands.ts` 28%." A wait counts from the pull request's opening, a draft's time with it, and says how
 * many changes it is the median of. [more]: the closed list read was full of the day's, so there may be more trains than it held.
 */
export function boardWords(board: Board, more: boolean): string {
  const { waits, trains, hot } = board, said: string[] = []
  if (waits?.read) {
    const known = [...waits.toVerdict ? [`${span(waits.toVerdict.minutes)} from opened to a first verdict (median of ${waits.toVerdict.of})`] : [],
      ...waits.toLanded ? [`${span(waits.toLanded.minutes)} from the last READ-OK to landing (median of ${waits.toLanded.of})`] : []]
    // Which files they shared with what landed while they were built: which ones a conflict was likely on, said as that.
    const on = board.conflicts?.length ? `, sharing with what landed meanwhile ${listed(board.conflicts.map(([path, changes]) => `\`${plainPath(path)}\` ${changes}`))}` : ''
    // None told is said too: a count gone to none is what a change to the merger is judged by.
    const told = waits.behind || waits.conflict ? `told it was behind: ${waits.behind}; told it conflicts: ${waits.conflict}${on}` : 'none was told it was behind or in conflict'
    said.push(`Last ${waits.read} landed: ${known.length ? `${known.join(', ')}; ` : ''}${told}.`)
  }
  const closed = ENDED.map(([end, words]): [string, number] => [words, trains.closed[end] ?? 0]).filter(([, count]) => count).sort((a, b) => b[1] - a[1])
  if (trains.landed || closed.length) {
    said.push(`Trains${more ? ', at least' : ''}: ${trains.landed} landed${closed.length ? `, ${closed.reduce((sum, [, count]) => sum + count, 0)} closed without landing (${closed.map(([words, count]) => `${words} ${count}`).join(', ')})` : ''}.`)
  }
  if (hot?.files.length) {
    said.push(`Files touched most, of the last ${hot.landings} landings: ${hot.files.map(([path, landings]) => `\`${plainPath(path)}\` ${Math.round(100 * landings / hot.landings)}%`).join(', ')}.`)
  }
  return said.join(' ')
}
