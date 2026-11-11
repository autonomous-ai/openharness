/**
 * The day's scoreboard: where a landed change waited, how many were told to rework, what the trains did, and the files most
 * landings touch (docs/design/2026-11-11-swarm-allocator, package 1). The allocator's four walls are merging, CPU, end-to-end
 * tests and disk, and the first is the one GitHub records: every change to the allocator after this is judged by these numbers,
 * week against week, so they go in the day's post beside its counts (pmNumbers.ts dayLine).
 *
 * Read from GitHub alone, with no record of its own: the trains from the closed list the assigner's pass has read already, by
 * the title each was closed with (githubTrain.ts trainEnd); the waits and the rework from the comments of the team's pull
 * requests that landed in the day; the files from the files of the ones that landed in the week. Read only as the day's post is
 * made, once a day (pmNumbers.ts keeps what it said while a post is tried again), the newest [CHANGES_MAX] of each, none of it
 * kept in memory: 100 requests on most days and 200 at the very most, in the PM's person's own name. lampOS had two accounts
 * banned for volume, so nothing here is read every minute. A part GitHub does not give is left out and said ([unread]).
 */
import { noteOf, verdictOf } from './githubMerge.js'
import { PAGE, type GitHubReads } from './githubRest.js'
import { trainEnd, type TrainEnd } from './githubTrain.js'
import { landedOf, timeOf } from './pmNumbers.js'
import { object } from './wire.js'

type Json = Record<string, unknown>

const MINUTE_MS = 60_000, DAY_MS = 24 * 60 * MINUTE_MS, WEEK_MS = 7 * DAY_MS
/** The most landed changes read for their waits, and for their files: the newest. */
export const CHANGES_MAX = 50
/** Pages of a hundred comments read of one landed change: past them a verdict is not counted. Harness's own notes and asks are
 *  said once for a head, so three hundred comments is a pull request of dozens of heads. */
const COMMENT_PAGES = 3
/** A file is named when more than one in [HOT_ONE_IN] of the week's landings touched it, and [HOT_LANDINGS] at least: of five
 *  landings one alone is a fifth, and says nothing. The [HOT_MAX] most touched are named. */
const HOT_ONE_IN = 10, HOT_LANDINGS = 3, HOT_MAX = 3
/** The most letters of a file's path a line says: its end, where its name is. */
const PATH_MAX = 100

export interface Board {
  /** The day's landed changes: how many there were and how many were read (the newest); over the ones read, the median minutes
   *  from opened to a first verdict and from the last READ-OK to landed (null when none shows one), and how many were told they
   *  were behind the base, or in conflict with it. Null when GitHub did not give their comments. */
  waits: { landed: number; read: number; toVerdict: number | null; toLanded: number | null; behind: number; conflict: number } | null
  /** The day's trains: how many landed, and how many closed without landing, by why (githubTrain.ts TrainEnd). */
  trains: { landed: number; closed: Partial<Record<TrainEnd, number>> }
  /** The week's landed changes whose files were read (the newest), and the files most of them touched, the most first, each with
   *  how many touched it: by its path as GitHub gives it. Null when GitHub did not give their files. */
  hot: { landings: number; files: Array<[path: string, landings: number]> } | null
}

/** The middle of [values], half way between the middle two of an even count; null of none. */
function median(values: number[]): number | null {
  const sorted = [...values].sort((a, b) => a - b), half = sorted.length >> 1
  return !sorted.length ? null : sorted.length % 2 ? sorted[half]! : (sorted[half - 1]! + sorted[half]!) / 2
}

/** The day's trains among the [closed]: a train's pull request merged is one landed; closed without merging, its title says why. */
function trainsOf(closed: readonly Json[], now: number): Board['trains'] {
  const trains: Board['trains'] = { landed: 0, closed: {} }
  for (const pull of closed.filter(item => item.pull_request)) {
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
 * of that part is asked, and the others are read all the same.
 */
export async function boardOf(reads: GitHubReads, repo: string, input: { now: number; closed: readonly Json[]; team: ReadonlySet<string> },
  unread: (part: 'waits' | 'files', why: string) => void): Promise<Board> {
  const { now, closed, team } = input
  /** The team's pull requests that landed within [window], the last landed first. */
  const landed = (window: number) => landedOf(closed, team, now, window).filter(change => Number.isSafeInteger(change.pull.number) && now - change.at < window)
    .sort((a, b) => b.at - a.at)
  const part = <T>(name: 'waits' | 'files', read: () => Promise<T>): Promise<T | null> => read().catch(error => {
    unread(name, error instanceof Error ? error.message : String(error))
    return null
  })
  const day = landed(DAY_MS), week = landed(WEEK_MS).slice(0, CHANGES_MAX)
  const waits = await part('waits', async () => {
    const toVerdict: number[] = [], toLanded: number[] = []
    let behind = 0, conflict = 0
    for (const { pull, at } of day.slice(0, CHANGES_MAX)) {
      const comments = await reads.freshPages(repo, `/repos/${repo}/issues/${Number(pull.number)}/comments?per_page=${PAGE}`, COMMENT_PAGES)
      // A verdict as the merger reads one (verdictOf), by when it was made: whoever made it, and on whichever head.
      const verdicts = comments.map(comment => ({ at: timeOf(comment.created_at), verdict: verdictOf(comment) })).filter(said => said.verdict && said.at)
      const opened = timeOf(pull.created_at), first = Math.min(...verdicts.map(said => said.at))
      // A READ-OK made after it landed did not land it.
      const lastOk = Math.max(...verdicts.filter(said => said.verdict === 'READ-OK' && said.at <= at).map(said => said.at))
      if (opened && Number.isFinite(first)) toVerdict.push(Math.max(0, first - opened) / MINUTE_MS)
      if (Number.isFinite(lastOk)) toLanded.push((at - lastOk) / MINUTE_MS)
      // Told once or ten times, it is one change told.
      const notes = new Set(comments.map(noteOf))
      if (notes.has('behind')) behind++
      if (notes.has('dirty')) conflict++
    }
    return { landed: day.length, read: Math.min(day.length, CHANGES_MAX), toVerdict: median(toVerdict), toLanded: median(toLanded), behind, conflict }
  })
  const hot = await part('files', async () => {
    const touched = new Map<string, number>()
    for (const { pull } of week) {
      // One page: a change of over a hundred files is counted by its first hundred.
      const files = await reads.freshPages(repo, `/repos/${repo}/pulls/${Number(pull.number)}/files?per_page=${PAGE}`, 1)
      for (const path of new Set(files.map(file => String(file.filename ?? '')).filter(Boolean))) touched.set(path, (touched.get(path) ?? 0) + 1)
    }
    const files = [...touched].filter(([, landings]) => landings >= HOT_LANDINGS && landings * HOT_ONE_IN > week.length)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, HOT_MAX)
    return { landings: week.length, files }
  })
  return { waits, trains: trainsOf(closed, now), hot }
}

/** A wait as a line says it: in minutes, and in hours from two. */
const span = (minutes: number): string => minutes < 120 ? `${Math.round(minutes)} min` : `${Math.round(minutes / 6) / 10} h`

/** A file's path as a line says it: its letters, digits, spaces and `. _ / + -`, the last [PATH_MAX] of them. A path is the
 *  text of whoever landed the file, and the line is posted where an @ tags, a link is followed and a backtick ends its code
 *  span (pmNumbers.ts plainName, for a name). */
function plainPath(path: string): string {
  const letters = [...path.replace(/[^\p{L}\p{M}\p{N} ._/+-]/gu, '')]
  return letters.length > PATH_MAX ? `…${letters.slice(1 - PATH_MAX).join('')}` : letters.join('')
}

/** Why trains closed without landing, as a line says each, in the order two of one count are said. */
const ENDED: ReadonlyArray<[TrainEnd, string]> = [['red', 'checks failed'], ['moved', 'base moved'], ['changed', 'rider changed'], ['late', 'out of time'], ['other', 'other']]

/**
 * What the day's post says of a [board], a sentence for each part that has something to say, or nothing: "A landed change
 * waited 7 min for its first verdict and 34 min from its last READ-OK to landing (medians). Told to rework: 5 behind, 2 in
 * conflict. Trains: 4 landed, 3 closed without landing (base moved 2, checks failed 1). Files touched most in 7 days (43
 * landings): `backend/src/superTabs/commands.ts` 28%."
 */
export function boardWords(board: Board): string {
  const { waits, trains, hot } = board, said: string[] = []
  if (waits?.read) {
    const known = [...waits.toVerdict === null ? [] : [`${span(waits.toVerdict)} for its first verdict`],
      ...waits.toLanded === null ? [] : [`${span(waits.toLanded)} from its last READ-OK to landing`]]
    const parts = [...known.length ? [`a landed change waited ${known.join(' and ')} (median${known.length > 1 ? 's' : ''}).`] : [],
      // None told is said too: a count gone to none is what a change to the merger is judged by.
      waits.behind || waits.conflict ? `told to rework: ${waits.behind} behind, ${waits.conflict} in conflict.` : 'none was told to rework.']
    // More landed than were read: said of the ones read.
    const lead = waits.read < waits.landed ? `Of the newest ${waits.read}: ` : ''
    said.push(...parts.map((words, at) => at === 0 && lead ? `${lead}${words}` : `${words[0]!.toUpperCase()}${words.slice(1)}`))
  }
  const closed = ENDED.map(([end, words]): [string, number] => [words, trains.closed[end] ?? 0]).filter(([, count]) => count).sort((a, b) => b[1] - a[1])
  if (trains.landed || closed.length) {
    said.push(`Trains: ${trains.landed} landed${closed.length ? `, ${closed.reduce((sum, [, count]) => sum + count, 0)} closed without landing (${closed.map(([words, count]) => `${words} ${count}`).join(', ')})` : ''}.`)
  }
  if (hot?.files.length) {
    said.push(`Files touched most in 7 days (${hot.landings} landings): ${hot.files.map(([path, landings]) => `\`${plainPath(path)}\` ${Math.round(100 * landings / hot.landings)}%`).join(', ')}.`)
  }
  return said.join(' ')
}
