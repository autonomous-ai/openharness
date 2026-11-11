/**
 * A project's numbers, told to its PM when work runs short and posted once a day for its people (anh Dee, 2026-11-11: "Numbers
 * when work runs short").
 *
 * A builder's turn that ends is typed its next thing (nextThing.ts); its PM was told nothing. In the 1,000-agent run the harness
 * reminded the lead 19 times how much time was left, because agents stop early: its helpers judged 47 of 60 statements
 * infeasible in the first half hour, and most were then proved; "there is no reason to idle", the lead wrote, and moved them. How
 * fast work was cut into tasks, not how many agents there were, set that run's pace (docs/research/2026-11-10-swarm-study,
 * section 7). On lampOS a free agent waited 432 minutes at the median for its next task, and six agents were gone eight days
 * before anyone said so.
 *
 * So the assigner, which reads the project each minute (githubAssign.ts), counts what it read: the builders with nothing given
 * or taken after its plan, the sized tasks nobody holds, and what landed in the last day. Builders with nothing for
 * [SHORT_AFTER_MS] are told to the PM with the counts, then once an hour while nothing changes; the same told three times goes
 * to the PM's person instead and is not typed a fourth time, as an agent's next thing is. Once a day the counts are posted in
 * the project's channel, where its people read the team's talk. Nothing is read for it that the pass did not read already.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { AwayBuilder, Crew, Pick, Read } from './assign/crew.js'
import type { LedProject } from './githubMerge.js'
import { PAGE } from './githubRest.js'
import { hhmm } from './githubVerdict.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>

/** How long builders have nothing before their PM is told: a builder between two tasks is given its next within a pass or two,
 *  and the plan's gate is a free agent at its next task in under five minutes. */
export const SHORT_AFTER_MS = 5 * 60_000
/** How often the PM is told while builders still have nothing. */
export const SHORT_EVERY_MS = 60 * 60_000
/** How many times the same is told before it goes to the PM's person (nextThing.ts NEXT_TIMES). */
export const SHORT_TIMES = 3
/** The hour of this computer's day from which the day's numbers are posted, once. */
export const DAY_HOUR = 9
const DAY_MS = 24 * 60 * 60_000
/** The most names a line lists, and the most projects whose counts are kept. */
const NAMES_MAX = 5, MAX_KEPT = 200

/** One project's counts after an assigner's pass. `landedBy`: the team's pull requests merged in the last 24 hours, by builder,
 *  the most first. `more`: the closed list read was full of that day's, so there may be more than counted. */
export interface Numbers { builders: number; free: string[]; open: number; held: number; landed: number; landedBy: Array<[name: string, count: number]>; closed: number; more: boolean }

/**
 * The counts of a pass: [read] and [crew] as the assigner read them, the builders out of quota ([short]), the tasks it gave this
 * pass ([picks]), the repository's issues and pull requests closed last ([closed], one page) and the labels of the project's
 * [team]. A builder is free with nothing given or taken, room in its subscription and nothing given this pass.
 */
export function numbersOf(input: { now: number; crew: Crew; read: Read; short: readonly AwayBuilder[]; picks: readonly Pick[]; closed: readonly Json[]
  team: ReadonlySet<string> }): Numbers {
  const { now, crew, read, picks } = input
  const given = new Set(picks.map(pick => pick.builder)), out = new Set(input.short.map(away => away.label))
  const free = crew.builders.filter(b => (read.open.get(b.id) ?? 0) === 0 && !given.has(b.id) && !out.has(b.label)).map(b => b.name).sort((a, b) => a.localeCompare(b))
  const names = new Map([...crew.builders, ...crew.away ?? []].map(b => [b.label, b.name]))
  const within = (at: unknown) => { const time = Date.parse(String(at ?? '')); return Number.isFinite(time) && now - time < DAY_MS }
  const by = new Map<string, number>()
  let closed = 0
  for (const item of input.closed) {
    if (item.pull_request) {
      // The team's own, as the merger lands only those (assign/crew.ts teamOf): a person's pull request is theirs.
      const label = labelsOf(item).find(name => input.team.has(name))
      if (!label || !within(object(item.pull_request).merged_at)) continue
      const name = names.get(label) ?? label.slice('builder:'.length)
      by.set(name, (by.get(name) ?? 0) + 1)
    // A task closed as not planned ended without its work.
    } else if (within(item.closed_at) && (item.state_reason === undefined || item.state_reason === null || item.state_reason === 'completed')) closed++
  }
  const landedBy = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { builders: crew.builders.length, free, open: read.free.size - picks.length, held: [...read.open.values()].reduce((sum, count) => sum + count, 0) + picks.length,
    landed: landedBy.reduce((sum, [, count]) => sum + count, 0), landedBy, closed, more: input.closed.length >= PAGE && within(input.closed.at(-1)?.updated_at) }
}

const labelsOf = (item: Json): string[] => (Array.isArray(item.labels) ? item.labels.map(object) : []).map(label => String(label.name ?? '').toLowerCase())
const counted = (count: number, what: string): string => `${count} ${what}${count === 1 ? '' : 's'}`
/** "Pip", "Pip and Kai", "Pip, Kai and Ada", and past [NAMES_MAX] "Pip, Kai, Ada, Bo, Cy and 3 more". */
function listed(names: readonly string[]): string {
  const shown = names.length > NAMES_MAX ? [...names.slice(0, NAMES_MAX), `${names.length - NAMES_MAX} more`] : [...names]
  return shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}

/** What the PM is typed when builders have nothing: who, what is open, what landed, and what to do about it. */
export const shortLine = (n: Numbers, at: string): string => `Harness, ${at}: ${listed(n.free)} ${n.free.length === 1 ? 'has' : 'have'} nothing to do, and `
  + `${n.open > 0 ? `the ${counted(n.open, 'sized task')} open cannot start yet` : 'no sized task is open'}. ${counted(n.landed, 'pull request')} landed in the last 24 hours. `
  + 'Open the next tasks as issues, each with its part:, size: and p0-p2 labels. If the work is done, tell your person.'

/** What the PM's person is told once the PM was told [SHORT_TIMES] times and nothing changed. */
export const toldLine = (n: Numbers, pm: string, since: string): string =>
  `${listed(n.free)} ${n.free.length === 1 ? 'has' : 'have'} had nothing to do since ${since}. ${pm} was told ${SHORT_TIMES} times, and nothing changed.`

/** The day's numbers, for the project's people. */
export const dayLine = (n: Numbers): string => `Harness, the last 24 hours: ${counted(n.landed, 'pull request')}${n.more ? ' or more' : ''} landed`
  + `${n.landedBy.length ? ` (${n.landedBy.slice(0, NAMES_MAX).map(([name, count]) => `${name} ${count}`).join(', ')}${n.landedBy.length > NAMES_MAX ? ', others' : ''})` : ''}`
  + ` and ${counted(n.closed, 'task')} closed. Now: ${n.builders ? `${n.free.length} of ${counted(n.builders, 'builder')} with nothing to do` : 'no builder is running'}, `
  + `${counted(Math.max(0, n.open), 'task')} open and ${n.held} in hand.`

/** Where a project's numbers go, in the Swarm as its PM reads it ([state]): the PM's own chat with its person, or the project's
 *  channel. Null when the Swarm has none. */
export function placeOf(state: Json, project: LedProject, place: 'chat' | 'channel'): string | null {
  const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
  const id = place === 'channel' ? list(state.projects).find(p => p.id === project.projectId)?.leadConversationId
    : list(state.conversations).find(c => c.kind === 'agent-chat' && Array.isArray(c.agentIds) && c.agentIds.includes(project.pmAgentId))?.id
  return identifier(id) ? id : null
}

/** What is kept of a project: since when its builders had nothing, what was told last (who and how many tasks were open), how
 *  many times and when, whether its PM's person was told, and the day its numbers were last posted. */
interface Kept { since: number; key: string; times: number; typedAt: number; told: boolean; day: string }

export class PmNumbers {
  private memory: Record<string, Kept> | null = null
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: {
    /** Types [text] into the project's PM, as Harness (an agent-only message in its chat). */
    tell: (project: LedProject, operationId: string, text: string) => Promise<unknown>
    /** Says [text] to the PM's person, in the PM's chat. */
    say: (project: LedProject, operationId: string, text: string) => Promise<unknown>
    /** Posts [text] in the project's channel. */
    post: (project: LedProject, operationId: string, text: string) => Promise<unknown>
    file: string
    now?: () => number
    log?: (line: string) => void
  }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
  }

  /** One project's counts after an assigner's pass: told, said or posted as they are due. A message the server did not take is
   *  said in the log and due again next pass, under the same id, so it is never posted twice. */
  async pass(project: LedProject, numbers: Numbers): Promise<void> {
    const memory = this.memory ??= this.load(), now = this.now()
    const kept = memory[project.projectId] ?? { since: 0, key: '', times: 0, typedAt: 0, told: false, day: '' }
    const before = JSON.stringify(kept)
    const send = async (how: 'tell' | 'say' | 'post', id: string, text: string): Promise<boolean> => {
      try { await this.deps[how](project, this.operation(project, id), text); return true } catch (error) {
        this.log(`[super-tab] numbers: NOT_SENT ${project.repo}: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    }
    if (!numbers.free.length) Object.assign(kept, { since: 0, key: '', times: 0, told: false })
    else {
      const key = `${numbers.free.join('\n')}\n${numbers.open}`
      // Who has nothing or what is open changed: it is told anew, and still no more than once an hour.
      if (kept.key !== key) Object.assign(kept, { since: kept.since || now, key, times: 0, told: false })
      if (!kept.told && now - kept.since >= SHORT_AFTER_MS && now - kept.typedAt >= SHORT_EVERY_MS) {
        const hour = Math.floor(now / SHORT_EVERY_MS)
        if (kept.times >= SHORT_TIMES) {
          if (await send('say', `said ${key} ${kept.since}`, toldLine(numbers, project.pm, hhmm(kept.since)))) kept.told = true
        } else if (await send('tell', `short ${hour}`, shortLine(numbers, hhmm(now)))) Object.assign(kept, { times: kept.times + 1, typedAt: now })
      }
    }
    const at = new Date(now), day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
    if (at.getHours() >= DAY_HOUR && kept.day !== day) {
      // A day in which nothing landed and no task closed has no numbers to post.
      if (!numbers.landed && !numbers.closed || await send('post', `day ${day}`, dayLine(numbers))) kept.day = day
    }
    if (JSON.stringify(kept) === before) return
    memory[project.projectId] = kept
    this.save(memory)
  }

  /** The same for the same message, so one sent again is posted once (the server keeps each operation's answer). */
  private operation(project: LedProject, id: string): string {
    return `numbers-${createHash('sha256').update(`${project.projectId}\n${id}`).digest('hex').slice(0, 40)}`
  }

  private load(): Record<string, Kept> {
    const kept: Record<string, Kept> = {}
    try {
      for (const [id, value] of Object.entries(object(JSON.parse(readFileSync(this.deps.file, 'utf8'))))) {
        const row = object(value)
        if (identifier(id) && Number.isSafeInteger(row.since) && typeof row.key === 'string' && Number.isSafeInteger(row.times) && Number.isSafeInteger(row.typedAt)
          && typeof row.told === 'boolean' && typeof row.day === 'string') {
          kept[id] = { since: row.since as number, key: row.key, times: row.times as number, typedAt: row.typedAt as number, told: row.told, day: row.day }
        }
      }
    } catch { /* none kept yet, or unreadable: counted from now */ }
    return kept
  }

  private save(memory: Record<string, Kept>): void {
    for (const id of Object.keys(memory).slice(0, Math.max(0, Object.keys(memory).length - MAX_KEPT))) delete memory[id]
    try {
      mkdirSync(dirname(this.deps.file), { recursive: true })
      const temporary = `${this.deps.file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(memory), { mode: 0o600 })
      renameSync(temporary, this.deps.file)
    } catch (error) { this.log(`[super-tab] could not save the numbers: ${String(error)}`) }
  }
}
