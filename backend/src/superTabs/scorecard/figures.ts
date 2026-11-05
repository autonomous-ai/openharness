/**
 * A project's scorecard for one local day (task #3386, Dee: judge each change by numbers, daily), from the Swarm's own
 * records: the reader (records.ts) gathers them, this turns them into counts and minutes. Pure: no clock, no database.
 */
import { crewTimingOf } from '../crewTimes.js'
import { isAcknowledgement } from '../acknowledgements.js'

/** What the figures measure against, written into each row with them so an old row keeps its meaning. */
export const SCORECARD_LIMITS = { lostAfterMinutes: 10, askLookbackDays: 7 } as const
export type ScorecardLimits = { lostAfterMinutes: number; askLookbackDays: number }

/** A message row as the scorecard reads it. `source` null: an author's own post; set: a row the system wrote. */
export interface ScorecardMessage {
  id: string
  conversationId: string
  author: { kind: 'person' | 'agent'; id: string }
  source: Record<string, unknown> | null
  text: string
  replyTo: string | null
  thread: string | null
  createdAt: number
  /** People the post tagged. */
  mentions?: string[]
}

/** A group of the project other than its chat: a task or a step (`reviewOf`). */
export interface ScorecardTask {
  id: string
  number?: number
  reviewOf?: string
  askedAt?: number
  shippedAt?: number
  fixedAfterMergeAt?: number
  /** When each attempt was assigned (ledger runs): it is Working from then. */
  runs: number[]
  /** The project chat messages it was opened from: its task line's and its proposal's. */
  requestMessageIds: string[]
}

export interface ScorecardInput {
  start: number
  end: number
  chatId: string
  /** The project's PM: the project chat's coordinator. */
  pmAgentIds: string[]
  tasks: ScorecardTask[]
  /** The day's rows of the project's conversations, the chat's rows of the ask lookback, each task's last status row before
   *  the day, and the rows people replied to. A row given twice counts once. */
  messages: ScorecardMessage[]
  answeredDeliveries: Array<{ messageId: string; answeredAt: number }>
  starts: Array<{ conversationId: string; requestedAt: number; failed: boolean }>
  routeDecisions: Array<{ conversationId: string; createdAt: number }>
  limits?: ScorecardLimits
}

export interface ScorecardFigures {
  limits: ScorecardLimits
  asksShipped: number
  askToShipMedianMinutes: number | null
  askToShipMaxMinutes: number | null
  unansweredAsks: number
  oldestUnansweredAskMinutes: number | null
  idleMinutes: number
  lostLeftAlone: number
  lostLeftMinutes: number
  fixesAfterMerge: number
  corrections: number
  starts: number
  startsFailed: number
  routeDecisions: number
  typedIntoPm: number
  ackPosts: number
  agentPosts: number
  /** The day's crew wakes and moves, from start to running again (crewTimes.ts, task #3462). Absent on days stored before. */
  crewWake?: CrewTimes
  crewMove?: CrewTimes
}
/** How many of a kind finished in the day, and their median and slowest time in seconds (null with none). */
export interface CrewTimes { count: number; medianSeconds: number | null; slowestSeconds: number | null }

const MIN = 60_000
const DAY = 24 * 60 * MIN

/** UTC milliseconds of [day]'s local midnight and the next one in [timeZone] (a DST day is 23 or 25 hours). */
export function dayBounds(day: string, timeZone: string): { start: number; end: number } {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number]
  return { start: localMidnight(Date.UTC(y, m - 1, d), timeZone), end: localMidnight(Date.UTC(y, m - 1, d + 1), timeZone) }
}

function localMidnight(wall: number, timeZone: string): number {
  const first = wall - offset(wall, timeZone)
  return wall - offset(first, timeZone)
}

/** How far [timeZone]'s wall clock is ahead of UTC at [at]. */
function offset(at: number, timeZone: string): number {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit',
    minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(at).map(p => [p.type, Number(p.value)]))
  return Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour!, parts.minute!, parts.second!) - Math.floor(at / 1000) * 1000
}

type Phase = 'working' | 'waiting' | 'other' | 'closed'
const PHASE_OF_STATUS: Record<string, Phase> = { working: 'working', planned: 'waiting', lost: 'waiting', review: 'other', reconciling: 'other',
  needs_human: 'other', blocked: 'other', done: 'closed', stopped: 'closed', cancelled: 'closed' }

/** What a row says about its task's phase, or null. */
function phaseOf(row: ScorecardMessage): Phase | null {
  const kind = row.source?.kind
  if (kind === 'system' && typeof row.source!.status === 'string') return PHASE_OF_STATUS[row.source!.status as string] ?? null
  if (kind === 'work-lost') return 'waiting'
  if (kind === 'work-resumed') return 'working'
  return null
}

/** Rows that move a task on: a status, a loss or resume, a route. */
const handles = (row: ScorecardMessage): boolean => phaseOf(row) !== null || row.source?.kind === 'route' || row.source?.kind === 'route-override'

/** A person's own post, or the proposal their Buddy wrote for them: what a person asks the project. A task card's line is
 *  the person's too, and asks nothing. */
export const isAsk = (m: Pick<ScorecardMessage, 'author' | 'source'>): boolean =>
  m.author.kind === 'person' && (!m.source || m.source.kind === 'buddy-proposal')

const median = (values: number[]): number | null => {
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}
const minutes = (ms: number) => Math.round(ms / MIN)

export function scorecardDay(input: ScorecardInput): ScorecardFigures {
  const { start, end } = input
  const limits = input.limits ?? { ...SCORECARD_LIMITS }
  const inDay = (t: number) => t >= start && t < end
  const messages = [...new Map(input.messages.map(m => [m.id, m])).values()].sort((a, b) => a.createdAt - b.createdAt)
  const byId = new Map(messages.map(m => [m.id, m]))
  const pm = new Set(input.pmAgentIds)
  const dayRows = messages.filter(m => inDay(m.createdAt))
  const asks = input.tasks.filter(t => t.number !== undefined && !t.reviewOf)

  const shipped = asks.filter(t => t.shippedAt !== undefined && inDay(t.shippedAt))
  const shipTimes = shipped.filter(t => t.askedAt !== undefined).map(t => minutes(t.shippedAt! - t.askedAt!))

  const unanswered = unansweredAsks(input, messages, limits)
  const lostLeft = lostLeftAlone(input, messages, limits)
  const ownPosts = dayRows.filter(m => m.author.kind === 'agent' && !m.source)

  return {
    limits,
    asksShipped: shipped.length,
    askToShipMedianMinutes: median(shipTimes),
    askToShipMaxMinutes: shipTimes.length ? Math.max(...shipTimes) : null,
    unansweredAsks: unanswered.length,
    oldestUnansweredAskMinutes: unanswered.length ? minutes(end - Math.min(...unanswered.map(m => m.createdAt))) : null,
    idleMinutes: minutes(idleMs(input, messages)),
    lostLeftAlone: lostLeft.length,
    lostLeftMinutes: minutes(lostLeft.reduce((sum, ms) => sum + ms, 0)),
    fixesAfterMerge: input.tasks.filter(t => t.fixedAfterMergeAt !== undefined && inDay(t.fixedAfterMergeAt)).length,
    // A reply to the PM's own post (not a row the Swarm writes in its name) that the post did not ask of that person.
    corrections: dayRows.filter(m => {
      if (m.author.kind !== 'person' || m.source || !m.replyTo) return false
      const target = byId.get(m.replyTo)
      return !!target && target.author.kind === 'agent' && pm.has(target.author.id) && !target.source && !target.mentions?.includes(m.author.id)
    }).length,
    starts: input.starts.filter(s => inDay(s.requestedAt)).length,
    startsFailed: input.starts.filter(s => s.failed && inDay(s.requestedAt)).length,
    routeDecisions: input.routeDecisions.filter(d => inDay(d.createdAt)).length,
    typedIntoPm: dayRows.filter(m => m.source?.kind === 'terminal-input' && pm.has(m.source.agentId as string)).length,
    ackPosts: ownPosts.filter(m => isAcknowledgement(m.text)).length,
    agentPosts: ownPosts.length,
    ...crewTimesOf(dayRows, input.chatId),
  }
}

/** The day's crew wakes and moves (crewTimes.ts): the server's timing rows in the project chat, never a person's row or one in
 *  another conversation. The chat is read back further than the day, so the rows are the day's already (dayRows). */
function crewTimesOf(dayRows: ScorecardMessage[], chatId: string): { crewWake: CrewTimes; crewMove: CrewTimes } {
  const timings = dayRows.filter(m => m.conversationId === chatId && m.author.kind === 'agent').flatMap(m => crewTimingOf(m.source) ?? [])
  const of = (what: 'wake' | 'move'): CrewTimes => {
    const times = timings.filter(t => t.what === what).map(t => Math.round((t.runningAt - t.startedAt) / 1000))
    return { count: times.length, medianSeconds: median(times), slowestSeconds: times.length ? Math.max(...times) : null }
  }
  return { crewWake: of('wake'), crewMove: of('move') }
}

/** People's top-level asks in the project chat in the lookback (isAsk) that nothing answered by day end: no agent's row in their
 *  thread or replying to them, no delivery answered, no task opened from them. */
function unansweredAsks(input: ScorecardInput, messages: ScorecardMessage[], limits: ScorecardLimits): ScorecardMessage[] {
  const { end } = input
  const answered = new Set<string>()
  for (const m of messages) {
    if (m.author.kind !== 'agent' || m.createdAt >= end) continue
    if (m.replyTo) answered.add(m.replyTo)
    if (m.thread && m.thread !== m.id) answered.add(m.thread)
  }
  for (const d of input.answeredDeliveries) if (d.answeredAt < end) answered.add(d.messageId)
  for (const t of input.tasks) if (t.askedAt === undefined || t.askedAt < end) t.requestMessageIds.forEach(id => answered.add(id))
  const from = end - limits.askLookbackDays * DAY
  return messages.filter(m => m.conversationId === input.chatId && isAsk(m) && !m.replyTo
    && (!m.thread || m.thread === m.id) && m.createdAt >= from && m.createdAt < end && !answered.has(m.id))
}

/** Each task's phase changes in time order: opened (waiting), assigned (working), and what its rows say. */
function timelines(input: ScorecardInput, messages: ScorecardMessage[]): Map<string, Array<{ at: number; phase: Phase }>> {
  const lines = new Map<string, Array<{ at: number; phase: Phase }>>()
  for (const t of input.tasks) {
    lines.set(t.id, [...t.askedAt !== undefined ? [{ at: t.askedAt, phase: 'waiting' as const }] : [], ...t.runs.map(at => ({ at, phase: 'working' as const }))])
  }
  for (const m of messages) {
    const phase = phaseOf(m)
    if (phase) lines.get(m.conversationId)?.push({ at: m.createdAt, phase })
  }
  for (const line of lines.values()) line.sort((a, b) => a.at - b.at)
  // A step ends with its task: a cancel or archive leaves an unassigned step as it was, and an assigned one's row says no status.
  for (const t of input.tasks) {
    // Its task's last word, when that closed it: a task done and then reopened has not ended its steps.
    const last = t.reviewOf ? lines.get(t.reviewOf)?.at(-1) : undefined
    const closed = last?.phase === 'closed' ? last : undefined
    if (closed) {
      const line = lines.get(t.id)!
      line.push({ at: closed.at, phase: 'closed' })
      line.sort((a, b) => a.at - b.at)
      lines.set(t.id, line.filter(e => e.at <= closed.at))
    }
  }
  return lines
}

/** Time in the day with no task or step Working while one waits for an agent (unassigned, planned or lost). */
function idleMs(input: ScorecardInput, messages: ScorecardMessage[]): number {
  const { start, end } = input
  const deltas = new Map<number, { working: number; waiting: number }>()
  const add = (at: number, phase: Phase, by: number) => {
    if (phase !== 'working' && phase !== 'waiting') return
    const d = deltas.get(at) ?? { working: 0, waiting: 0 }
    d[phase] += by
    deltas.set(at, d)
  }
  for (const line of timelines(input, messages).values()) {
    for (let i = 0; i < line.length; i++) {
      const from = Math.max(line[i]!.at, start), to = Math.min(line[i + 1]?.at ?? end, end)
      if (from >= to) continue
      add(from, line[i]!.phase, 1)
      add(to, line[i]!.phase, -1)
    }
  }
  let idle = 0, working = 0, waiting = 0, last = start
  for (const at of [...deltas.keys()].sort((a, b) => a - b)) {
    if (working === 0 && waiting > 0) idle += at - last
    const d = deltas.get(at)!
    working += d.working
    waiting += d.waiting
    last = at
  }
  return idle
}

/** For each task lost in the day and left alone past the limit, the time past it: until its next assignment, status,
 *  route or start, or the day's end. */
function lostLeftAlone(input: ScorecardInput, messages: ScorecardMessage[], limits: ScorecardLimits): number[] {
  const { start, end } = input
  const limit = limits.lostAfterMinutes * MIN
  const next = new Map<string, number[]>()
  const note = (id: string, at: number) => next.set(id, [...next.get(id) ?? [], at])
  for (const t of input.tasks) t.runs.forEach(at => note(t.id, at))
  for (const s of input.starts) note(s.conversationId, s.requestedAt)
  for (const m of messages) if (handles(m) && m.source?.kind !== 'work-lost') note(m.conversationId, m.createdAt)
  // One loss writes a row for the PM and one for the agent.
  const losses = new Map(messages.filter(m => m.source?.kind === 'work-lost' && m.createdAt >= start && m.createdAt < end)
    .map(m => [JSON.stringify([m.conversationId, m.source!.assignmentId, m.createdAt]), m]))
  return [...losses.values()].flatMap(m => {
    const after = (next.get(m.conversationId) ?? []).filter(at => at > m.createdAt)
    const left = Math.min(after.length ? Math.min(...after) : end, end) - m.createdAt
    return left > limit ? [left - limit] : []
  })
}
