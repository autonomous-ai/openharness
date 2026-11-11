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
 * So the assigner, which reads the project each minute (githubAssign.ts), counts what it read: the builders with nothing to work
 * on after its plan, the sized tasks nobody holds, and what landed in the last day. A builder with nothing for [SHORT_AFTER_MS]
 * is told to the PM with the counts, then once an hour; so is a project whose sized tasks have run out while its builders' lists
 * are one deep or less. A builder the PM was told of three times goes to the PM's person instead, once, and is not told to the
 * PM a fourth time, as an agent's next thing is not. Once a day the counts are posted in the project's channel, where its
 * people read the team's talk. Nothing is read for it that the pass did not read already.
 *
 * Each wait is a builder's own, and counted only while passes follow each other: after a gap (the computer slept, the daemon
 * was stopped) nothing kept is what anyone saw, and it starts again. A message goes out under an id made of its own words, and
 * one the server did not take is sent again as it was, later each time; one it refuses for good is not sent again. The first
 * review found each of these missing: "landed" read 0 where the train lands squashed, a person was told of a night nobody
 * watched, and a message refused once was tried every minute for ever.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { labelOf, type AwayBuilder, type Crew, type Pick, type Read } from './assign/crew.js'
import { refusedForGood } from './githubMentions.js'
import type { LedProject } from './githubMerge.js'
import { PAGE, retryIn } from './githubRest.js'
import { TRAIN_TITLE } from './githubTrain.js'
import { hhmm } from './githubVerdict.js'
import { identifier, object } from './wire.js'

type Json = Record<string, unknown>

/** How long a builder has nothing before its PM is told: a builder between two tasks is given its next within a pass or two,
 *  and the plan's gate is a free agent at its next task in under five minutes. */
export const SHORT_AFTER_MS = 5 * 60_000
/** How often the PM is told while work is short. */
export const SHORT_EVERY_MS = 60 * 60_000
/** How many times the PM is told of a builder before its person is told instead (nextThing.ts NEXT_TIMES). */
export const SHORT_TIMES = 3
/** The hour of this computer's day from which the day's numbers are posted, once. */
export const DAY_HOUR = 9
/** How far apart two passes may be for the second to go on from what the first kept: the assigner passes each minute, and a
 *  computer asleep or a daemon stopped saw nothing meanwhile. How often that moment is written while something is watched. */
export const SEEN_GAP_MS = 10 * 60_000
const SEEN_SAVE_MS = 5 * 60_000
const DAY_MS = 24 * 60 * 60_000
/** The most names a line lists, the most letters of a name it says, and the most projects whose counts are kept. */
const NAMES_MAX = 5, NAME_MAX = 24, MAX_KEPT = 200

/** One project's counts after an assigner's pass. `free`: its builders with nothing to work on. `dry`: no sized task waits and
 *  its builders' lists are one deep or less, so the next to finish has nothing. `unsized`: open issues nobody holds that have no
 *  size, which Harness gives nobody. `landedBy`: the team's pull requests landed in the last 24 hours, by builder, the most
 *  first. `more`: the closed list read was full of that day's, so there may be more landed and closed than counted. */
export interface Numbers { builders: number; free: string[]; dry: boolean; open: number; unsized: number; held: number
  landed: number; landedBy: Array<[name: string, count: number]>; closed: number; more: boolean }

/** A name as a line of Harness's says it: its letters, digits, spaces, dots, dashes and underscores, [NAME_MAX] at most. An
 *  agent's name is its person's own words, and the line is typed to another person's agent and posted where an @ tags. */
export const plainName = (name: string): string =>
  name.normalize('NFKC').replace(/\s+/g, ' ').replace(/[^\p{L}\p{N} ._-]/gu, '').replace(/ +/g, ' ').trim().slice(0, NAME_MAX).trim() || 'a builder'

/**
 * The counts of a pass: the open [issues], [read] and [crew] as the assigner read them, the tasks whose pull request waits for
 * its readers or its merge ([withReaders]), the builders out of quota ([short]), the tasks given this pass ([picks]), the
 * repository's issues and pull requests closed last ([closed], one page), and the project's [pm]. A builder is free when every
 * task it holds waits on a pull request, it has room in its subscription and it was given nothing this pass.
 */
export function numbersOf(input: { now: number; crew: Crew; pm: string; issues: readonly Json[]; read: Read; withReaders: ReadonlySet<number>
  short: readonly AwayBuilder[]; picks: readonly Pick[]; closed: readonly Json[] }): Numbers {
  const { now, crew, read, picks } = input
  const tasks = input.issues.filter(issue => !issue.pull_request)
  const given = new Set(picks.map(pick => pick.builder)), out = new Set(input.short.map(away => away.label))
  const working = new Set(tasks.filter(task => !input.withReaders.has(Number(task.number))).flatMap(labelsOf))
  const free = [...new Set(crew.builders.filter(b => !working.has(b.label) && !given.has(b.id) && !out.has(b.label)).map(b => plainName(b.name)))]
    .sort((a, b) => a.localeCompare(b))
  // The team's own, as the merger lands only those (assign/crew.ts teamOf): a person's pull request, or an issue anyone
  // opened and closed, is theirs.
  const names = new Map([...crew.builders, ...crew.away ?? [], { label: labelOf(input.pm), name: input.pm }].map(b => [b.label, plainName(b.name)]))
  const within = (at: unknown) => { const time = Date.parse(String(at ?? '')); return Number.isFinite(time) && now - time < DAY_MS }
  const pulls = input.closed.filter(item => item.pull_request)
  // A train that landed squashed closed its members and merged only itself (githubTrain.ts): its title names them.
  const carried = new Set(pulls.filter(pull => String(pull.title ?? '').startsWith(TRAIN_TITLE) && within(object(pull.pull_request).merged_at))
    .flatMap(train => [...String(train.title).matchAll(/#([1-9]\d{0,9})\b/g)].map(found => Number(found[1]))))
  const by = new Map<string, number>()
  for (const pull of pulls) {
    const name = labelsOf(pull).map(label => names.get(label)).find(Boolean)
    if (!name || !(within(object(pull.pull_request).merged_at) || carried.has(Number(pull.number)) && within(pull.closed_at))) continue
    by.set(name, (by.get(name) ?? 0) + 1)
  }
  // A task closed as not planned ended without its work.
  const closed = input.closed.filter(item => !item.pull_request && within(item.closed_at) && labelsOf(item).some(label => names.has(label))
    && (item.state_reason === undefined || item.state_reason === null || item.state_reason === 'completed')).length
  const landedBy = [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const open = read.free.size - picks.length, held = [...read.open.values()].reduce((sum, count) => sum + count, 0) + picks.length
  return { builders: crew.builders.length, free, dry: crew.builders.length > 0 && open <= 0 && held <= crew.builders.length, open,
    unsized: tasks.filter(task => !labelsOf(task).some(label => label.startsWith('size:') || label.startsWith('builder:') || label === 'status:taken')).length,
    held, landed: landedBy.reduce((sum, [, count]) => sum + count, 0), landedBy, closed, more: input.closed.length >= PAGE && within(input.closed.at(-1)?.updated_at) }
}

const labelsOf = (item: Json): string[] => (Array.isArray(item.labels) ? item.labels.map(object) : []).map(label => String(label.name ?? '').toLowerCase())
const counted = (count: number, what: string): string => `${count} ${what}${count === 1 ? '' : 's'}`
/** "Pip", "Pip and Kai", "Pip, Kai and Ada", and past [NAMES_MAX] "Pip, Kai, Ada, Bo, Cy and 3 more". */
function listed(names: readonly string[]): string {
  const shown = names.length > NAMES_MAX ? [...names.slice(0, NAMES_MAX), `${names.length - NAMES_MAX} more`] : [...names]
  return shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}
const landedWords = (n: Numbers): string => `${counted(n.landed, 'pull request')}${n.more ? ' or more' : ''} landed`
const openWords = (n: Numbers): string => n.open > 0 ? `the ${counted(n.open, 'sized task')} open cannot start yet`
  : `no sized task is open${n.unsized ? ` (${counted(n.unsized, 'open issue')} ${n.unsized === 1 ? 'has' : 'have'} no size)` : ''}`

/** What the PM is typed when work is short: the builders with nothing ([names]; none when only the tasks ran out), what is open,
 *  what landed, and what to do about it. */
export const shortLine = (names: readonly string[], n: Numbers, at: string): string => `Harness, ${at}: `
  + (names.length ? `${listed(names)} ${names.length === 1 ? 'has' : 'have'} nothing to do, and ${openWords(n)}`
    : `${openWords(n)}, and ${counted(n.builders, 'builder')} ${n.builders === 1 ? 'has' : 'have'} ${counted(n.held, 'task')} in hand`)
  + `. ${landedWords(n)} in the last 24 hours. Open the next tasks as issues, each with its part:, size: and p0-p2 labels${n.unsized ? ', or size the ones that wait' : ''}. `
  + 'If the work is done, tell your person.'

/** What the PM's person is told once the PM was told [SHORT_TIMES] times of [names], or of tasks run out with none, [since]. */
export const toldLine = (names: readonly string[], pm: string, since: string): string =>
  `${names.length ? `${listed(names)} ${names.length === 1 ? 'has' : 'have'} had nothing to do` : 'No sized task has been open'} since ${since}. `
  + `${plainName(pm)} was told ${SHORT_TIMES} times, and nothing changed.`

/** The day's numbers, for the project's people, with the [day] they are posted on. */
export const dayLine = (n: Numbers, day: string): string => `Harness, ${day}, the last 24 hours: ${landedWords(n)}`
  + `${n.landedBy.length ? ` (${n.landedBy.slice(0, NAMES_MAX).map(([name, count]) => `${name} ${count}`).join(', ')}${n.landedBy.length > NAMES_MAX ? ', others' : ''})` : ''}`
  + ` and ${counted(n.closed, 'task')}${n.more ? ' or more' : ''} closed. Now: ${n.builders ? `${n.free.length} of ${counted(n.builders, 'builder')} with nothing to do` : 'no builder is running'}, `
  + `${counted(Math.max(0, n.open), 'task')} open and ${n.held} in hand.`

/** Where a project's numbers go, in the Swarm as its PM reads it ([state]): the PM's own chat with its person, or the project's
 *  channel. Null when the Swarm has none. */
export function placeOf(state: Json, project: LedProject, place: 'chat' | 'channel'): string | null {
  const list = (value: unknown) => Array.isArray(value) ? value.map(object) : []
  const id = place === 'channel' ? list(state.projects).find(p => p.id === project.projectId)?.leadConversationId
    : list(state.conversations).find(c => c.kind === 'agent-chat' && Array.isArray(c.agentIds) && c.agentIds.includes(project.pmAgentId))?.id
  return identifier(id) ? id : null
}

/** How each of the numbers' messages goes: typed to the PM alone, said to its person in the PM's chat, or posted in the channel. */
export type How = 'tell' | 'say' | 'post'

/** The post that carries [text] [how] it goes, as the PM, in the Swarm as the PM reads it ([state]): to itself alone in its own
 *  chat, which types it and shows it to nobody; for its person to read there; or in its project's channel, to no agent. */
export function messageOf(how: How, project: LedProject, state: Json, text: string): Json {
  const conversationId = placeOf(state, project, how === 'post' ? 'channel' : 'chat')
  if (!conversationId) throw new Error(how === 'post' ? 'the project has no channel to post in.' : `${plainName(project.pm)} has no chat with its person.`)
  return { type: 'message.send', conversationId, replyTo: null, recipientIds: how === 'tell' ? [project.pmAgentId] : [], text, ...how === 'tell' ? { agentOnly: true } : {} }
}

/** A wait: since when, how many times the PM was told of it, and whether its person was. */
interface Wait { since: number; told: number; said: boolean }
/** A message made and not yet taken by the server, sent again as it is: what it settles once it is (the builders it names,
 *  whether it is of tasks run out, the day it posts). */
interface Pending { how: How; id: string; text: string; names: string[]; dry: boolean; day: string }
/** What is kept of a project: each free builder's wait and the wait of tasks run out, when the PM was last told, when the last
 *  pass was, the day its numbers were last posted, and a message on its way with how often it failed and when it goes next. */
interface Kept { free: Record<string, Wait>; dry: Wait | null; typedAt: number; seenAt: number; day: string; pending: Pending | null; misses: number; retryAt: number }

const dayOf = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "Wed 11 Nov". */
const dateWords = (at: Date): string => `${DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`
/** A moment as a line says it at [now]: its time, with its date when it is another day's. */
const sinceWords = (since: number, now: number): string =>
  dayOf(new Date(since)) === dayOf(new Date(now)) ? hhmm(since) : `${dateWords(new Date(since))}, ${hhmm(since)}`

export class PmNumbers {
  private memory: Record<string, Kept> | null = null
  /** When each project's last pass was written, so it is written no more than every [SEEN_SAVE_MS] while nothing else changes. */
  private readonly saved = new Map<string, number>()
  private readonly said = new Set<string>()
  private readonly now: () => number
  private readonly log: (line: string) => void

  constructor(private readonly deps: {
    /** Sends [text] [how] it goes (messageOf), under [operationId]: the server takes each operation once. */
    send: (how: How, project: LedProject, operationId: string, text: string) => Promise<unknown>
    file: string
    now?: () => number
    log?: (line: string) => void
  }) {
    this.now = deps.now ?? Date.now
    this.log = deps.log ?? (line => console.warn(line))
  }

  /** One project's counts after an assigner's pass: what is due is made, and what is made is sent until the server takes it. */
  async pass(project: LedProject, numbers: Numbers): Promise<void> {
    const memory = this.memory ??= this.load(), now = this.now()
    const kept = memory[project.projectId] ?? { free: {}, dry: null, typedAt: 0, seenAt: 0, day: '', pending: null, misses: 0, retryAt: 0 }
    const before = JSON.stringify({ ...kept, seenAt: 0 })
    // Nobody watched since the last pass, or the clock went back: every wait starts again, and a message of before is not sent.
    if (now - kept.seenAt > SEEN_GAP_MS || kept.seenAt > now) Object.assign(kept, { free: {}, dry: null, pending: null, misses: 0, retryAt: 0 })
    if (kept.typedAt > now) kept.typedAt = 0
    kept.seenAt = now
    for (const name of Object.keys(kept.free)) if (!numbers.free.includes(name)) delete kept.free[name]
    for (const name of numbers.free) kept.free[name] ??= { since: now, told: 0, said: false }
    kept.dry = numbers.dry ? kept.dry ?? { since: now, told: 0, said: false } : null
    kept.pending ??= this.due(project, numbers, kept, now)
    if (kept.pending && now >= kept.retryAt) await this.send(project, kept, now)
    // Written when it changed, and its last pass's moment every few minutes while it watches something: at rest, nothing.
    const watching = Object.keys(kept.free).length > 0 || kept.dry !== null || kept.pending !== null
    if (JSON.stringify({ ...kept, seenAt: 0 }) === before && !(watching && now - (this.saved.get(project.projectId) ?? 0) >= SEEN_SAVE_MS)) return
    memory[project.projectId] = kept
    this.saved.set(project.projectId, now)
    this.save(memory)
  }

  /** The message that is due now, or null: the PM's person told of the builders the PM was told of [SHORT_TIMES] times, else the
   *  PM told of the builders waiting, else of tasks run out, an hour after it was last told; else the day's numbers. */
  private due(project: LedProject, numbers: Numbers, kept: Kept, now: number): Pending | null {
    const at = new Date(now), day = dayOf(at)
    const made = (how: How, text: string, names: string[], dry: boolean): Pending => ({ how, text, names, dry, day,
      // Of its own words and its day: sent again it is the same operation, and the same words another day are another.
      id: `numbers-${createHash('sha256').update(`${project.projectId}\n${how}\n${day}\n${text}`).digest('hex').slice(0, 40)}` })
    if (now - kept.typedAt >= SHORT_EVERY_MS) {
      const waits = Object.entries(kept.free).filter(([, wait]) => !wait.said && now - wait.since >= SHORT_AFTER_MS)
      const stuck = waits.filter(([, wait]) => wait.told >= SHORT_TIMES)
      if (stuck.length) return made('say', toldLine(stuck.map(([name]) => name), project.pm, sinceWords(Math.min(...stuck.map(([, wait]) => wait.since)), now)), stuck.map(([name]) => name), false)
      if (waits.length) return made('tell', shortLine(waits.map(([name]) => name), numbers, hhmm(now)), waits.map(([name]) => name), false)
      // Tasks run out with every builder at work: said only while nobody waits, as a builder that waits says more.
      const dry = !Object.keys(kept.free).length && kept.dry && !kept.dry.said && now - kept.dry.since >= SHORT_AFTER_MS ? kept.dry : null
      if (dry) return dry.told >= SHORT_TIMES ? made('say', toldLine([], project.pm, sinceWords(dry.since, now)), [], true) : made('tell', shortLine([], numbers, hhmm(now)), [], true)
    }
    if (at.getHours() >= DAY_HOUR && day > kept.day) {
      // A day in which nothing landed and no task closed has no numbers to post.
      if (numbers.landed || numbers.closed) return made('post', dayLine(numbers, dateWords(at)), [], false)
      kept.day = day
    }
    return null
  }

  /** Sends the message on its way and settles what it was about. One the server did not take waits longer each time (30 s
   *  doubling to 15 minutes), said once; one it refuses for good, as it would again, is settled unsent and said. */
  private async send(project: LedProject, kept: Kept, now: number): Promise<void> {
    const pending = kept.pending!
    try { await this.deps.send(pending.how, project, pending.id, pending.text) } catch (error) {
      const why = error instanceof Error ? error.message : String(error)
      if (!refusedForGood(error)) {
        kept.retryAt = now + retryIn(++kept.misses)
        return this.once(`[super-tab] numbers: NOT_SENT ${project.repo}: ${why}`)
      }
      this.once(`[super-tab] numbers: REFUSED ${project.repo}: ${why}`)
    }
    Object.assign(kept, { pending: null, misses: 0, retryAt: 0 })
    const waits = [...pending.names.map(name => kept.free[name]), pending.dry ? kept.dry : null].filter((wait): wait is Wait => !!wait)
    if (pending.how === 'post') kept.day = pending.day
    else if (pending.how === 'say') for (const wait of waits) wait.said = true
    else { kept.typedAt = now; for (const wait of waits) wait.told++ }
  }

  /** Says [line] the first time only; the memory is bounded, oldest first. */
  private once(line: string): void {
    if (this.said.has(line)) return
    this.said.add(line)
    if (this.said.size > MAX_KEPT) this.said.delete(this.said.values().next().value!)
    this.log(line)
  }

  private load(): Record<string, Kept> {
    const kept: Record<string, Kept> = {}
    const wait = (value: unknown): Wait | null => {
      const row = object(value)
      return Number.isSafeInteger(row.since) && Number.isSafeInteger(row.told) && typeof row.said === 'boolean' ? { since: row.since as number, told: row.told as number, said: row.said } : null
    }
    try {
      for (const [id, value] of Object.entries(object(JSON.parse(readFileSync(this.deps.file, 'utf8'))))) {
        const row = object(value), free = Object.entries(object(row.free)).map(([name, held]) => [name, wait(held)] as const), pending = object(row.pending)
        if (!identifier(id) || !Number.isSafeInteger(row.typedAt) || !Number.isSafeInteger(row.seenAt) || typeof row.day !== 'string'
          || !Number.isSafeInteger(row.misses) || !Number.isSafeInteger(row.retryAt)) continue
        const sending = (pending.how === 'tell' || pending.how === 'say' || pending.how === 'post') && identifier(pending.id) && typeof pending.text === 'string'
          && Array.isArray(pending.names) && pending.names.every(name => typeof name === 'string') && typeof pending.dry === 'boolean' && typeof pending.day === 'string'
        kept[id] = { free: Object.fromEntries(free.filter(([, held]) => held)) as Record<string, Wait>, dry: wait(row.dry), typedAt: row.typedAt as number, seenAt: row.seenAt as number, day: row.day,
          pending: sending ? pending as unknown as Pending : null, misses: row.misses as number, retryAt: row.retryAt as number }
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
