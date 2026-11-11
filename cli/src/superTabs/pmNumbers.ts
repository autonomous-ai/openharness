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
 * on after its plan, the sized tasks nobody holds, and what landed in the last day. While a builder has had nothing for
 * [SHORT_AFTER_MS] the PM is typed the counts, at most once an hour. Told [SHORT_TIMES] hours running with a builder still
 * waiting, its person is told once instead, and nobody again until the builders it named have work: a finished project falls
 * silent. Once a day the counts are posted in the project's channel, where its people read the team's talk. Nothing is read
 * for it that the pass did not read already.
 *
 * It says only what is so now: who has nothing, what is open, what landed. Its first two reviews found what a longer memory
 * cost: a person told of a night nobody watched, a message kept and typed three hours late, and a file written every five
 * minutes for a project at rest. So what a builder has waited is counted in memory, from this process's own passes, and four
 * things are kept on disk, written as they change: when the PM was last told, how many hours running, the builders its person
 * was told of, and the day last posted. A message's id is its project, its kind and its hour or day: the server takes each once, and answers one
 * sent again in other words as taken (OPERATION_REUSED).
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
import { identifier, object, SuperTabHostError } from './wire.js'

type Json = Record<string, unknown>

/** How long a builder has nothing before its PM is told: a builder between two tasks is given its next within a pass or two,
 *  and the plan's gate is a free agent at its next task in under five minutes. */
export const SHORT_AFTER_MS = 5 * 60_000
/** How often the PM is told while work is short. */
export const SHORT_EVERY_MS = 60 * 60_000
/** How many times the PM is told before its person is told instead (nextThing.ts NEXT_TIMES). */
export const SHORT_TIMES = 3
/** The hour of this computer's day from which the day's numbers are posted, once. */
export const DAY_HOUR = 9
const DAY_MS = 24 * 60 * 60_000
/** The most names a line lists, the most letters of a name it says, and the most projects whose counts are kept. */
const NAMES_MAX = 5, NAME_MAX = 24, MAX_KEPT = 200
/** The most builders kept as the ones a person was told of. */
const SAID_MAX = 100

/** One project's counts after an assigner's pass. `free`: its builders with nothing to work on, by id, with the name a line
 *  says. `unsized`: open issues nobody holds that have no size, which Harness gives nobody. `landedBy`: the team's pull requests
 *  landed in the last 24 hours, by builder, the most first. `more`: the closed list read was full of that day's, so there may be
 *  more landed and closed than counted. */
export interface Numbers { builders: number; free: Array<{ id: string; name: string }>; open: number; unsized: number; held: number
  landed: number; landedBy: Array<[name: string, count: number]>; closed: number; more: boolean }

/** A name as a line of Harness's says it: its letters, digits, spaces, dashes and underscores, [NAME_MAX] at most. An agent's
 *  name is its person's own words, and the line is typed to another person's agent and posted where an @ tags and a dot links. */
export const plainName = (name: string): string =>
  name.normalize('NFKC').replace(/\s+/g, ' ').replace(/[^\p{L}\p{M}\p{N} _-]/gu, '').replace(/ +/g, ' ').trim().slice(0, NAME_MAX).trim() || 'a builder'

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
  const free = crew.builders.filter(b => !working.has(b.label) && !given.has(b.id) && !out.has(b.label)).map(b => ({ id: b.id, name: plainName(b.name) }))
    .sort((a, b) => a.name.localeCompare(b.name))
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
    const label = labelsOf(pull).find(name => names.has(name))
    if (!label || !(within(object(pull.pull_request).merged_at) || carried.has(Number(pull.number)) && within(pull.closed_at))) continue
    by.set(label, (by.get(label) ?? 0) + 1)
  }
  // A task closed as not planned ended without its work.
  const closed = input.closed.filter(item => !item.pull_request && within(item.closed_at) && labelsOf(item).some(label => names.has(label))
    && (item.state_reason === undefined || item.state_reason === null || item.state_reason === 'completed')).length
  const landedBy = [...by].map(([label, count]): [string, number] => [names.get(label)!, count]).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  return { builders: crew.builders.length, free, open: read.free.size - picks.length,
    unsized: tasks.filter(task => !labelsOf(task).some(label => label.startsWith('size:') || label.startsWith('builder:') || label === 'status:taken')).length,
    held: [...read.open.values()].reduce((sum, count) => sum + count, 0) + picks.length,
    landed: landedBy.reduce((sum, [, count]) => sum + count, 0), landedBy, closed, more: input.closed.length >= PAGE && within(input.closed.at(-1)?.updated_at) }
}

const labelsOf = (item: Json): string[] => (Array.isArray(item.labels) ? item.labels.map(object) : []).map(label => String(label.name ?? '').toLowerCase())
const counted = (count: number, what: string): string => `${count} ${what}${count === 1 ? '' : 's'}`
/** "Pip", "Pip and Kai", "Pip, Kai and Ada", and past [NAMES_MAX] "Pip, Kai, Ada, Bo, Cy and 3 more". */
function listed(names: readonly string[]): string {
  const shown = names.length > NAMES_MAX ? [...names.slice(0, NAMES_MAX), `${names.length - NAMES_MAX} more`] : [...names]
  return shown.length < 2 ? shown.join('') : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`
}
const nothing = (names: readonly string[]): string => `${listed(names)} ${names.length === 1 ? 'has' : 'have'} nothing to do`
const landedWords = (n: Numbers): string => `${counted(n.landed, 'pull request')}${n.more ? ' or more' : ''} landed`

/** What the PM is typed when work is short: the builders with nothing ([names]), what is open, what landed, and what to do. */
export const shortLine = (names: readonly string[], n: Numbers, at: string): string => `Harness, ${at}: ${nothing(names)}, and `
  + (n.open > 0 ? `the ${counted(n.open, 'sized task')} open cannot start yet`
    : `no sized task is open${n.unsized ? ` (${counted(n.unsized, 'open issue')} ${n.unsized === 1 ? 'has' : 'have'} no size)` : ''}`)
  + `. ${landedWords(n)} in the last 24 hours. Open the next tasks as issues, each with its part:, size: and p0-p2 labels${n.unsized ? ', or size the ones that wait' : ''}. `
  + 'If the work is done, tell your person.'

/** What the PM's person is told once the PM was told [SHORT_TIMES] times and [names] still have nothing. */
export const toldLine = (names: readonly string[], pm: string): string => `${nothing(names)}. ${plainName(pm)} was told ${SHORT_TIMES} times.`

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
  // A PM its person stopped, or whose computer is down, is typed nothing: it would read it hours on, as it starts.
  const pm = how === 'tell' && Array.isArray(state.agents) ? state.agents.map(object).find(agent => agent.id === project.pmAgentId) : undefined
  if (pm?.workDecision === 'stop' || pm?.downSince) throw new Error(`${plainName(project.pm)} is not running.`)
  const conversationId = placeOf(state, project, how === 'post' ? 'channel' : 'chat')
  if (!conversationId) throw new Error(how === 'post' ? 'the project has no channel to post in.' : `${plainName(project.pm)} has no chat with its person.`)
  return { type: 'message.send', conversationId, replyTo: null, recipientIds: how === 'tell' ? [project.pmAgentId] : [], text, ...how === 'tell' ? { agentOnly: true } : {} }
}

/** Sends the numbers' messages into a Swarm: each as the project's PM, into the Swarm as the PM [read]s it, by a [post] to the
 *  server's commands. */
export const numbersSender = (read: (project: LedProject) => Promise<Json>, post: (path: string, body: Json) => Promise<unknown>) =>
  async (how: How, project: LedProject, operationId: string, text: string): Promise<unknown> =>
    post(`/api/super-tabs/${project.tabId}/commands`, { operationId, asAgentId: project.pmAgentId, command: messageOf(how, project, await read(project), text) })

/** What is kept of a project on disk: when its PM was last told, how many hours running, the builders its person was told
 *  of that still have nothing, and the day its numbers were last posted. */
interface Kept { typedAt: number; told: number; saidOf: string[]; day: string }

const dayOf = (at: Date): string => `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')}`
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export class PmNumbers {
  private memory: Record<string, Kept> | null = null
  /** Since when each free builder of each project has had nothing, as this process's passes saw it. */
  private readonly waits = new Map<string, Map<string, number>>()
  /** After a send the server did not take: how many in a row, and when the next goes, by project and kind. */
  private readonly retries = new Map<string, { misses: number; at: number }>()
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
    this.now = deps.now ?? (() => Date.now())
    this.log = deps.log ?? (line => console.warn(line))
  }

  /** One project's counts after an assigner's pass: its PM told, its person told or its day posted, as each is due. */
  async pass(project: LedProject, numbers: Numbers): Promise<void> {
    const memory = this.memory ??= this.load(), now = this.now(), at = new Date(now), id = project.projectId
    const kept = memory[id] ?? { typedAt: 0, told: 0, saidOf: [], day: '' }
    const before = JSON.stringify(kept)
    const waits = this.waits.get(id) ?? new Map<string, number>()
    for (const builder of waits.keys()) if (!numbers.free.some(free => free.id === builder)) waits.delete(builder)
    // New to waiting, or waiting since a moment still to come (a clock set back): from now.
    for (const free of numbers.free) if (!(waits.get(free.id)! <= now)) waits.set(free.id, now)
    if (waits.size) this.waits.set(id, waits)
    else this.waits.delete(id)
    const waiting = numbers.free.filter(free => now - waits.get(free.id)! >= SHORT_AFTER_MS)
    // The builders its person was told of have work again: the PM is told of the next that waits, from the first time.
    if (kept.saidOf.length && !kept.saidOf.some(builder => waits.has(builder))) Object.assign(kept, { saidOf: [], told: 0 })
    // A clock set back: the hour since the PM was told is not waited from a moment still to come.
    if (kept.typedAt > now) kept.typedAt = 0
    if (waiting.length && !kept.saidOf.length && now - kept.typedAt >= SHORT_EVERY_MS) {
      // Hours running: a tell with none due the hour before it starts the count again, as nobody waited then.
      const told = now - kept.typedAt >= 2 * SHORT_EVERY_MS ? 0 : kept.told, names = waiting.map(free => free.name)
      if (told >= SHORT_TIMES) {
        // Refused for good, it is not said again either: the log has it.
        if (await this.send('say', project, `${kept.typedAt}`, toldLine(names, project.pm)) !== 'later') kept.saidOf = waiting.map(free => free.id).slice(0, SAID_MAX)
      } else {
        const sent = await this.send('tell', project, `${Math.floor(now / SHORT_EVERY_MS)}`, shortLine(names, numbers, hhmm(now)))
        // Taken, it counts; refused for good, the hour passes all the same, and nothing is counted that was not typed.
        if (sent !== 'later') Object.assign(kept, { typedAt: now, told: told + (sent === 'taken' ? 1 : 0) })
      }
    }
    const day = dayOf(at)
    if (at.getHours() >= DAY_HOUR && day > kept.day) {
      // A day in which nothing landed and no task closed has no numbers to post.
      if (!numbers.landed && !numbers.closed
        || await this.send('post', project, day, dayLine(numbers, `${DAYS[at.getDay()]} ${at.getDate()} ${MONTHS[at.getMonth()]}`)) !== 'later') kept.day = day
    }
    if (JSON.stringify(kept) === before) return
    // Kept in the order they were last written, so the ones dropped past MAX_KEPT are the ones longest untouched.
    delete memory[id]
    memory[id] = kept
    this.save(memory)
  }

  /**
   * Sends one message, under an id of its project, its kind and [when] it is for: `taken` when the server has it (now, or
   * from an earlier try whose answer was lost, which it says by refusing the id with other words), `refused` when it will not
   * have it at all, and `later` when it did not answer: tried again from 30 s on, doubling to 15 minutes, and said once.
   */
  private async send(how: How, project: LedProject, when: string, text: string): Promise<'taken' | 'refused' | 'later'> {
    const key = `${project.projectId}\n${how}`, now = this.now()
    if ((this.retries.get(key)?.at ?? 0) > now) return 'later'
    try {
      await this.deps.send(how, project, `numbers-${createHash('sha256').update(`${key}\n${when}`).digest('hex').slice(0, 40)}`, text)
    } catch (error) {
      if (error instanceof SuperTabHostError && error.code === 'OPERATION_REUSED') return this.settled(key, 'taken')
      const why = error instanceof Error ? error.message : String(error)
      if (refusedForGood(error)) {
        this.once(`[super-tab] numbers: REFUSED ${project.repo}: ${why}`)
        return this.settled(key, 'refused')
      }
      const misses = (this.retries.get(key)?.misses ?? 0) + 1
      this.retries.set(key, { misses, at: now + retryIn(misses) })
      this.once(`[super-tab] numbers: NOT_SENT ${project.repo}: ${why}`)
      return 'later'
    }
    return this.settled(key, 'taken')
  }

  private settled<T>(key: string, how: T): T {
    this.retries.delete(key)
    return how
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
    try {
      for (const [id, value] of Object.entries(object(JSON.parse(readFileSync(this.deps.file, 'utf8'))))) {
        const row = object(value)
        if (identifier(id) && Number.isSafeInteger(row.typedAt) && Number.isSafeInteger(row.told) && typeof row.day === 'string'
          && Array.isArray(row.saidOf) && row.saidOf.length <= SAID_MAX && row.saidOf.every(builder => typeof builder === 'string')) {
          kept[id] = { typedAt: row.typedAt as number, told: row.told as number, saidOf: row.saidOf as string[], day: row.day }
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
