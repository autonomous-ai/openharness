import type { Crew } from './assign/crew.js'
import { labelOf } from './assign/crew.js'
import { TEAM } from './githubMentions.js'
import { ownVerdict, pullTalk, writersOf, type LedProject } from './githubMerge.js'
import { GitHubReads, PAGE, type GitHubGet } from './githubRest.js'
import { TRAIN_BRANCH } from './githubTrain.js'
import { plainName } from './pmNumbers.js'
import { object } from './wire.js'

/**
 * Each builder's steps over the last 24 hours, the lines the day's numbers post carries under its counts (pmNumbers.ts dayLine;
 * Swarm plan, step 8, "Prove it": "Numbers posted daily, per builder and per person. A total hid six missing agents for a week").
 * Read from the project's GitHub with its PM's person's gh, as the post goes, once a day. Each step as the Swarm study measured
 * lampOS's (docs/research/2026-11-10-swarm-study/lampos-pull-requests.md, "Cycle time"): ready to the first verdict, the last
 * READ-OK to landed, ready to landed, landed within three hours of opening, and how long a builder was free after one landed
 * before it took its next task (the claim `harness super-tab take` posts, githubClaim.ts). Every builder of the team has its
 * line, one with nothing landed too; its PM only on a day it landed. A builder is its person's one member of the project, so
 * per builder is per person. Only the team's own pull requests are read, a builder's or its PM's, as the merger lands only those
 * (assign/crew.ts teamOf). A pull request a train carried landed as the train merged (githubTrain.ts), and a train is no one's. A
 * verdict or a take counts only from the team's logins (githubMentions.ts TEAM), and a verdict never from the pull request's own
 * builder, as the merger reads them.
 *
 * Read beside the assigner's pass and never in it ([DaySteps]): read in it, a busy repository's hundreds of requests held every
 * project's assignments for minutes (code review of #4051). Each read has a cache of its own, let go once it is done: these pages are
 * read once a day, and kept under their ETags they would sit in memory for good.
 */

type Json = Record<string, unknown>

/** Pages read of the closed pull requests, and of the comments since the day before the window, the newest first, where the takes
 *  of its tasks are: a day of lampOS's (about a hundred landed and six hundred comments) fits well within them. A pull request's
 *  events come oldest first: its last time marked ready is within [EVENT_PAGES] of them. */
const PULL_PAGES = 5, COMMENT_PAGES = 20, EVENT_PAGES = 3
/** Pull requests read in full for one day: past them the day is said to be cut. */
const MAX_LANDED = 200
const HOUR_MS = 60 * 60_000, DAY_MS = 24 * HOUR_MS, LANDED_WITHIN_MS = 3 * HOUR_MS
const SELF = 'Harness'

/** One of the team, by its label's name (`juno-ray` for Juno Ray, assign/crew.ts labelOf), and its name as a line says it
 *  (pmNumbers.ts plainName): a name is its person's own words, and the post goes where an @ tags and a dot links. */
export interface Member { slug: string; name: string; pm?: true }
/** One landed pull request's steps, in minutes; null where a step cannot be told. Its builder is the team's member, by its
 *  slug, or null for one no member wrote; its task, the issue it closes. */
export interface Landed { builder: string | null; task: number | null; firstVerdict: number | null; okToLanded: number | null; readyToLanded: number
  within3h: boolean; mergedAt: number }
/** A builder's take of a task: who by its slug, when, and which issue. */
export interface Take { slug: string; at: number; issue: number }

/** Each project's steps for its day's post, read beside the assigner's pass: the first ask of a day starts the read and is
 *  answered undefined, as is every ask until it is done; then the text, or null for none or one that could not be read, which is
 *  said once. One read a day per project, kept until the next. */
export class DaySteps {
  private readonly kept = new Map<string, { day: string; text: string | null | undefined }>()
  constructor(private readonly read: (project: LedProject) => Promise<string | null>, private readonly log: (line: string) => void = line => console.warn(line)) {}

  of(project: LedProject, day: string): string | null | undefined {
    const known = this.kept.get(project.projectId)
    if (known?.day === day) return known.text
    const entry: { day: string; text: string | null | undefined } = { day, text: undefined }
    this.kept.set(project.projectId, entry)
    void this.read(project).then(text => { entry.text = text }, (error: unknown) => {
      entry.text = null
      this.log(`[super-tab] numbers: STEPS_UNREAD ${project.repo}: ${error instanceof Error ? error.message : String(error)}`)
    })
    return undefined
  }
}

/** The steps of [project]'s last 24 hours as the day's post says them, read with the PM's person's gh ([get]); null when its team
 *  landed and closed nothing then, as the post then has no numbers of its own either. */
export const readSteps = (deps: { get: GitHubGet; crew: (project: LedProject) => Promise<Crew>; now?: () => number }) =>
  async (project: LedProject): Promise<string | null> => {
    const now = deps.now ?? Date.now, reads = new GitHubReads(deps.get, now), { repo } = project, end = now(), start = end - DAY_MS
    const team = membersOf(await deps.crew(project), project.pm)
    const pulls = await reads.current(repo, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PAGE}`, PULL_PAGES)
    // A train is Harness's, no builder's, and each pull request it carried landed as it merged: GitHub marks one merged by a
    // merge commit, and one the train squashed is closed and named in the train's title (githubTrain.ts).
    const train = (pull: Json) => String(object(pull.head).ref).startsWith(TRAIN_BRANCH)
    const carried = new Map(pulls.filter(pull => train(pull) && pull.merged_at)
      .flatMap(one => [...String(one.title).matchAll(/#([1-9]\d{0,9})\b/g)].map(found => [Number(found[1]), one.merged_at] as const)))
    const own = pulls.filter(pull => !train(pull) && memberOf(pull, team) !== null)
      .map(pull => pull.merged_at ? pull : { ...pull, merged_at: carried.get(Number(pull.number)) ?? null })
    // The first to land first, so a day cut at [MAX_LANDED] keeps the first that landed.
    const merged = own.filter(pull => within(pull.merged_at, start, end)).sort((a, b) => Date.parse(String(a.merged_at)) - Date.parse(String(b.merged_at)))
    const dropped = own.filter(pull => !pull.merged_at && within(pull.closed_at, start, end)).length
    if (!merged.length && !dropped) return null
    const landed: Landed[] = []
    for (const pull of merged.slice(0, MAX_LANDED)) {
      const number = Number(pull.number)
      const talk = await pullTalk(reads, repo, number)
      const events = await reads.current(repo, `/repos/${repo}/issues/${number}/events?per_page=${PAGE}`, EVENT_PAGES)
      landed.push(stepsOf(pull, talk, events, team))
    }
    // The takes since the day before the window began: of each landed task, and of the next one its builder took.
    const takes = (await reads.current(repo, `/repos/${repo}/issues/comments?since=${new Date(start - DAY_MS).toISOString()}&sort=created&direction=desc&per_page=${PAGE}`,
      COMMENT_PAGES)).flatMap(comment => {
        const name = TEAM.has(comment.author_association) ? claimant(comment) : null, issue = Number(String(comment.issue_url).split('/').at(-1))
        return name && Number.isSafeInteger(issue) ? [{ slug: slugOf(name), at: Date.parse(String(comment.created_at)), issue }] : []
      })
    return stepsText(team, landed, dropped, takes, merged.length > MAX_LANDED)
  }

/** One landed pull request's steps, as the study measured them: ready is when it was last marked ready, or opened when it was
 *  opened ready; a verdict is a `READ-OK` or `HOLD` of a comment's or review's own (githubMerge.ts ownVerdict), never Harness's.
 *  Its builder is the member of [team] its builder label or branch names; its task, the issue its body says it closes, as a
 *  builder's pull request says ("Closes #N", lib/swarmSkills.ts). */
export function stepsOf(pull: Json, talk: Json[], events: Json[], team: readonly Member[]): Landed {
  const opened = Date.parse(String(pull.created_at)), mergedAt = Date.parse(String(pull.merged_at)), builder = memberOf(pull, team)
  const readied = events.filter(e => e.event === 'ready_for_review').map(e => Date.parse(String(e.created_at))).filter(at => at <= mergedAt)
  const ready = readied.length ? Math.max(...readied) : opened
  const said = talk.flatMap(item => {
    const first = String(item.body ?? '').split('\n').find(line => line.trim()) ?? ''
    // The merger's: from the team's logins, and never Harness's own or the pull request's builder's ("Pip, 10:02: READ-OK" on Pip's).
    const signer = /^\W*([^,:*]+?)\**\s*[,:]/.exec(first)?.[1]
    const verdict = !TEAM.has(item.author_association) || first.startsWith(`${SELF},`) || (signer !== undefined && slugOf(signer) === builder) ? null : ownVerdict(first)
    return verdict ? [{ verdict: verdict.verdict, at: Date.parse(String(item.created_at)) }] : []
  })
  const first = said.filter(s => s.at >= ready).map(s => s.at)
  const oks = said.filter(s => s.verdict === 'READ-OK' && s.at <= mergedAt).map(s => s.at)
  const task = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(String(pull.body ?? ''))
  return { builder, task: task ? Number(task[1]) : null, mergedAt, readyToLanded: minutes(mergedAt - ready),
    within3h: mergedAt - opened <= LANDED_WITHIN_MS, firstVerdict: first.length ? minutes(Math.min(...first) - ready) : null,
    okToLanded: oks.length ? minutes(mergedAt - Math.max(...oks)) : null }
}

/** The builder a comment is the claim of (`<name>, HH:MM: taken by <name>`, githubClaim.ts), or null. */
export function claimant(comment: Json): string | null {
  const found = /^(.+?), \d\d:\d\d: taken by (.+)$/.exec(String(comment.body ?? '').split('\n')[0]!.trim())
  return found && found[1] === found[2] ? found[1]! : null
}

/** The steps as the post says them: the team's line, then a line for each builder, one with nothing landed too (its PM only on
 *  a day it landed). [landed]: the team's, in the order it landed; [cut] when there were more than were read. */
export function stepsText(team: readonly Member[], landed: readonly Landed[], dropped: number, takes: readonly Take[], cut: boolean): string {
  // How long a builder was free after a pull request of its landed: to the first task it took after its last take of that pull
  // request's own, 0 when it took that next one before this one landed (it was not idle); null while it has taken none since.
  const free = landed.map(one => {
    const mine = takes.filter(t => t.slug === one.builder).sort((a, b) => a.at - b.at)
    const after = mine.findLast(t => t.issue === one.task && t.at <= one.mergedAt)?.at ?? one.mergedAt
    const next = mine.find(t => t.at > after && t.issue !== one.task)
    return { builder: one.builder, minutes: next ? minutes(next.at - one.mergedAt) : null }
  })
  const steps = (of: readonly Landed[], frees: typeof free, team = false): string[] => {
    const firsts = of.flatMap(l => l.firstVerdict === null ? [] : [l.firstVerdict]), oks = of.flatMap(l => l.okToLanded === null ? [] : [l.okToLanded])
    const waits = frees.flatMap(f => f.minutes === null ? [] : [f.minutes])
    return [
      ...firsts.length ? [`ready → first verdict ${span(median(firsts))}${team ? ` (p90 ${span(percentile(firsts, 0.9))})` : ''}`] : [],
      ...oks.length ? [`last READ-OK → landed ${span(median(oks))}`] : [],
      ...team && of.length ? [`ready → landed ${span(median(of.map(l => l.readyToLanded)))}`,
        `${Math.round(100 * of.filter(l => l.within3h).length / of.length)}% landed within 3 h of opening`] : [],
      ...waits.length ? [`free → next task ${span(median(waits))}`] : [],
    ]
  }
  const lines = [[`Steps${cut ? ` of the first ${MAX_LANDED} landed` : ''}`, ...steps(landed, free, true),
    ...dropped ? [`${dropped} closed without landing`] : []].join(' · ')]
  for (const member of team) {
    const own = landed.filter(l => l.builder === member.slug), frees = free.filter(f => f.builder === member.slug)
    if (member.pm && !own.length) continue
    lines.push(own.length ? [`${member.name}: ${own.length} landed`, ...steps(own, frees),
      ...frees.at(-1)?.minutes === null ? ['no task taken since its last landed'] : []].join(' · ') : `${member.name}: nothing landed`)
  }
  return lines.join('\n')
}

/** A name as a builder label spells it: `juno-ray` for Juno Ray (assign/crew.ts labelOf). */
const slugOf = (name: string): string => labelOf(name).slice('builder:'.length)

/** The team as its pull requests name it: every builder, away ones too, and its PM, once each. */
export function membersOf(crew: Crew, pm: string): Member[] {
  const all: Member[] = [...[...crew.builders, ...crew.away ?? []].map(b => ({ slug: b.label.slice('builder:'.length), name: plainName(b.name) })),
    { slug: slugOf(pm), name: plainName(pm), pm: true }]
  return all.filter((member, i) => all.findIndex(other => other.slug === member.slug) === i)
}

/** The member of [team] a pull request names as its writer (githubMerge.ts writersOf: its builder label, or its branch's first
 *  part), its label read in any case; null for one no member wrote. */
function memberOf(pull: Json, team: readonly Member[]): string | null {
  const writers = writersOf(pull).map(writer => writer.toLowerCase())
  return team.find(member => writers.includes(member.slug))?.slug ?? null
}

const minutes = (ms: number): number => Math.max(0, ms / 60_000)
const within = (at: unknown, start: number, end: number): boolean => { const t = Date.parse(String(at)); return t >= start && t < end }

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b), mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** The nearest-rank percentile, as the study's p90. */
function percentile(values: readonly number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)]!
}

/** A span as the study writes it: minutes under an hour, else hours to one place. */
function span(min: number): string {
  return min < 60 ? `${Math.round(min)} min` : `${(min / 60).toFixed(1).replace(/\.0$/, '')} h`
}
