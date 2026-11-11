import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { Crew } from './assign/crew.js'
import { ownVerdict, pullTalk, writersOf, type LedProject } from './githubMerge.js'
import { GitHubReads, GitHubStop, PAGE, type GitHubGet } from './githubRest.js'
import { object } from './wire.js'

/**
 * A Swarm v4 team's numbers, posted once a day in its project's channel (Swarm plan, step 8, "Prove it": "Numbers posted daily,
 * per builder and per person. A total hid six missing agents for a week"). Read from the project's GitHub with its PM's person's
 * gh, where the merger and the assigner run, and posted as the PM. Each step as the Swarm study measured lampOS's
 * (docs/research/2026-11-10-swarm-study/lampos-pull-requests.md, "Cycle time"), for the pull requests that landed the day before:
 * ready to the first verdict, the last READ-OK to landed, ready to landed, landed within three hours of opening; and how long a
 * builder was free after one landed before it took its next task (the claim `harness super-tab take` posts, githubClaim.ts). Every
 * builder of the team has its line, one with nothing landed too. A builder is its person's one member of the project, so per
 * builder is per person.
 */

type Json = Record<string, unknown>

/** How often the loop looks whether a day's numbers are due: a look reads nothing until they are. */
export const NUMBERS_CHECK_MS = 10 * 60_000
/** The hour on the PM's computer from which the day before's numbers are posted: the morning, when the team starts. */
export const NUMBERS_HOUR = 9
/** Pages read of a day's closed pull requests, and of the comments since the day before it began, where the takes of its tasks
 *  are: a day of lampOS's (about a hundred landed and six hundred comments) fits well within them. */
const PULL_PAGES = 5, COMMENT_PAGES = 20
/** Pull requests read in full for one day: past them the day is said to be cut. */
const MAX_LANDED = 200
const HOUR_MS = 60 * 60_000, LANDED_WITHIN_MS = 3 * HOUR_MS
const SELF = 'Harness'

/** One landed pull request's steps, in minutes; null where a step cannot be told. Its builder is one of the team's, or null for one
 *  no builder of the team wrote; its task, the issue it closes. */
interface Landed { builder: string | null; task: number | null; firstVerdict: number | null; okToLanded: number | null; readyToLanded: number
  within3h: boolean; mergedAt: number }
/** A builder's take of a task: who, when, and which issue. */
interface Take { name: string; at: number; issue: number }

export class GitHubNumbers {
  private timer: NodeJS.Timeout | null = null
  private running: Promise<void> | null = null
  private readonly reads: GitHubReads
  private readonly now: () => number
  private readonly log: (line: string) => void
  /** The day whose numbers each repository last posted, as `YYYY-MM-DD` on this computer, kept in [file] across restarts. */
  private posted: Record<string, string>
  /** What was said of a failure today, once each, so a GitHub that stays down is not logged every ten minutes. */
  private said = { day: '', lines: new Set<string>() }
  private offUntil = 0

  constructor(private readonly deps: { projects: () => Promise<LedProject[]>; crew: (project: LedProject) => Promise<Crew>; get: GitHubGet
    /** Posts [text] in [project]'s channel as its PM, under [operationId]: the same post again is the first, on the server. */
    post: (project: LedProject, operationId: string, text: string) => Promise<unknown>
    file: string; now?: () => number; log?: (line: string) => void; intervalMs?: number }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
    this.reads = new GitHubReads(deps.get, this.now)
    this.posted = readPosted(deps.file)
  }

  start(): void {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, this.deps.intervalMs ?? NUMBERS_CHECK_MS)
    this.timer.unref?.()
    void this.tick()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** One look; one still running is not started twice. */
  tick(): Promise<void> {
    this.running ??= this.pass().catch(error => this.once('FAILED', reason(error)))
      .finally(() => { this.running = null })
    return this.running
  }

  private async pass(): Promise<void> {
    const today = new Date(this.now())
    if (today.getHours() < NUMBERS_HOUR || this.now() < this.offUntil) return
    const day = dayKey(today)
    const due = (await this.deps.projects()).filter(project => this.posted[project.repo] !== day)
    for (const project of due) {
      try {
        await this.deps.post(project, `numbers-${project.repo.replace(/[^A-Za-z0-9]/g, '-')}-${day}`, await this.numbers(project, today))
        this.posted[project.repo] = day
        this.save()
        this.log(`[super-tab] posted ${project.repo}'s numbers for the day before ${day}`)
      } catch (error) {
        this.reads.forget(project.repo)
        this.once(error instanceof GitHubStop ? error.code : 'NUMBERS_FAILED', `${project.repo}: ${reason(error)}`)
        // A stop of every repository this gh reads (signed out, out of requests): none is read again until it lifts.
        if (error instanceof GitHubStop && error.everywhere) { this.offUntil = error.until; return }
      }
    }
  }

  /** The day before [today]'s numbers for [project], as its channel reads them. */
  private async numbers(project: LedProject, today: Date): Promise<string> {
    const { repo } = project
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime()
    const start = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1).getTime()
    const crew = await this.deps.crew(project)
    const team = [...crew.builders.map(b => b.name), ...(crew.away ?? []).map(b => b.name)]
    const closed = (await this.reads.current(repo, `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${PAGE}`, PULL_PAGES))
      .filter(pull => within(pull.closed_at, start, end))
    const merged = closed.filter(pull => typeof pull.merged_at === 'string' && pull.merged_at)
    const landed: Landed[] = []
    for (const pull of merged.slice(0, MAX_LANDED)) {
      const number = Number(pull.number)
      const talk = await pullTalk(this.reads, repo, number)
      const events = await this.reads.current(repo, `/repos/${repo}/issues/${number}/events?per_page=${PAGE}`, 1)
      landed.push(stepsOf(pull, talk, events, team))
    }
    // The takes since the day before it began: of each landed task, and of the next one its builder took.
    const takes = (await this.reads.current(repo, `/repos/${repo}/issues/comments?since=${new Date(start - 24 * HOUR_MS).toISOString()}&per_page=${PAGE}`, COMMENT_PAGES))
      .flatMap(comment => {
        const name = claimant(comment), issue = Number(String(comment.issue_url).split('/').at(-1))
        return name && Number.isSafeInteger(issue) ? [{ name, at: Date.parse(String(comment.created_at)), issue }] : []
      })
    return numbersText(new Date(start), team, landed.sort((a, b) => a.mergedAt - b.mergedAt), closed.length - merged.length, takes, merged.length > MAX_LANDED)
  }

  private save(): void {
    try {
      writeFileSync(`${this.deps.file}.tmp`, JSON.stringify(this.posted), { mode: 0o600 })
      renameSync(`${this.deps.file}.tmp`, this.deps.file)
    } catch (error) {
      // Posted again after a restart, under the same operation, which the server answers with the first.
      this.once('NOT_SAVED', `the day posted was not saved: ${reason(error)}`)
    }
  }

  private once(code: string, detail: string): void {
    const day = dayKey(new Date(this.now())), line = `[super-tab] Daily numbers: ${code} ${detail}`
    if (this.said.day !== day) this.said = { day, lines: new Set() }
    if (this.said.lines.has(line)) return
    this.said.lines.add(line)
    this.log(line)
  }
}

/** One landed pull request's steps, as the study measured them: ready is when it was last marked ready, or opened when it was
 *  opened ready; a verdict is a `READ-OK` or `HOLD` of a comment's or review's own (githubMerge.ts ownVerdict), never Harness's.
 *  Its builder is the team's one its builder label or branch names (githubMerge.ts writersOf); its task, the issue its body says
 *  it closes, as a builder's pull request says ("Closes #N", lib/swarmSkills.ts). */
export function stepsOf(pull: Json, talk: Json[], events: Json[], team: readonly string[]): Landed {
  const opened = Date.parse(String(pull.created_at)), mergedAt = Date.parse(String(pull.merged_at))
  const readied = events.filter(e => e.event === 'ready_for_review').map(e => Date.parse(String(e.created_at))).filter(at => at <= mergedAt)
  const ready = readied.length ? Math.max(...readied) : opened
  const said = talk.flatMap(item => {
    const first = String(item.body ?? '').split('\n').find(line => line.trim()) ?? ''
    const verdict = first.startsWith(`${SELF},`) ? null : ownVerdict(first)
    return verdict ? [{ verdict: verdict.verdict, at: Date.parse(String(item.created_at)) }] : []
  })
  const first = said.filter(s => s.at >= ready).map(s => s.at)
  const oks = said.filter(s => s.verdict === 'READ-OK' && s.at <= mergedAt).map(s => s.at)
  const writers = writersOf(pull)
  const builder = team.find(name => writers.some(w => w.toLowerCase() === name.toLowerCase())) ?? null
  const task = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/i.exec(String(pull.body ?? ''))
  return { builder, task: task ? Number(task[1]) : null, mergedAt, readyToLanded: minutes(mergedAt - ready), within3h: mergedAt - opened <= LANDED_WITHIN_MS,
    firstVerdict: first.length ? minutes(Math.min(...first) - ready) : null, okToLanded: oks.length ? minutes(mergedAt - Math.max(...oks)) : null }
}

/** The builder a comment is the claim of (`<name>, HH:MM: taken by <name>`, githubClaim.ts), or null. */
export function claimant(comment: Json): string | null {
  const found = /^(.+?), \d\d:\d\d: taken by (.+)$/.exec(String(comment.body ?? '').split('\n')[0]!.trim())
  return found && found[1] === found[2] ? found[1]! : null
}

/** The day's numbers as its channel reads them: the team's first, then a line for each builder, one with nothing landed too, and
 *  one for what no builder of the team wrote. [landed] in the order it landed. */
export function numbersText(day: Date, team: readonly string[], landed: readonly Landed[], dropped: number, takes: readonly Take[], cut: boolean): string {
  const same = (a: string | null, b: string | null) => a !== null && b !== null && a.toLowerCase() === b.toLowerCase()
  // How long a builder was free after a pull request of its landed: to the first task it took after that pull request's own, none
  // when it took it before this one landed; null while it has taken none since.
  const free = landed.flatMap(one => {
    if (one.builder === null) return []
    const mine = takes.filter(t => same(t.name, one.builder)).sort((a, b) => a.at - b.at)
    const after = mine.find(t => t.issue === one.task)?.at ?? one.mergedAt
    const next = mine.find(t => t.at > after && t.issue !== one.task)
    return [{ builder: one.builder, minutes: next ? minutes(next.at - one.mergedAt) : null }]
  })
  const steps = (of: readonly Landed[], frees: typeof free, p90 = false): string[] => {
    const firsts = of.flatMap(l => l.firstVerdict === null ? [] : [l.firstVerdict]), oks = of.flatMap(l => l.okToLanded === null ? [] : [l.okToLanded])
    const waits = frees.flatMap(f => f.minutes === null ? [] : [f.minutes])
    return [
      ...firsts.length ? [`ready → first verdict ${span(median(firsts))}${p90 ? ` (p90 ${span(percentile(firsts, 0.9))})` : ''}`] : [],
      ...oks.length ? [`last READ-OK → landed ${span(median(oks))}`] : [],
      ...p90 && of.length ? [`ready → landed ${span(median(of.map(l => l.readyToLanded)))}`,
        `${Math.round(100 * of.filter(l => l.within3h).length / of.length)}% landed within 3 h of opening`] : [],
      ...waits.length ? [`free → next task ${span(median(waits))}`] : [],
    ]
  }
  const label = day.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' })
  const lines = [`Numbers for ${label}, from GitHub${cut ? ` (the first ${MAX_LANDED} landed)` : ''}:`,
    ['Team', `${landed.length} landed`, ...steps(landed, free, true), ...dropped ? [`${dropped} closed without landing`] : []].join(' · ')]
  for (const name of team) {
    const own = landed.filter(l => same(l.builder, name)), frees = free.filter(f => same(f.builder, name))
    lines.push(own.length ? [`${name}: ${own.length} landed`, ...steps(own, frees),
      ...frees.at(-1)?.minutes === null ? ['no task taken since its last landed'] : []].join(' · ') : `${name}: nothing landed`)
  }
  const others = landed.filter(l => l.builder === null)
  if (others.length) lines.push(`Others, no builder of the team: ${others.length} landed`)
  return lines.join('\n')
}

const minutes = (ms: number): number => Math.max(0, ms / 60_000)
const reason = (error: unknown): string => error instanceof Error ? error.message : String(error)
const within = (at: unknown, start: number, end: number): boolean => { const t = Date.parse(String(at)); return t >= start && t < end }
const dayKey = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`

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

function readPosted(file: string): Record<string, string> {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as unknown
    return Object.fromEntries(Object.entries(object(raw)).filter((e): e is [string, string] => typeof e[1] === 'string'))
  } catch { return {} }
}
