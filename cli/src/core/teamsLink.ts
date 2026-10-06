/**
 * The teams' prompt scopes in their own process, as the core sees them (`HARNESSD_SERVICES=teams`; the
 * process's side is services/teamsProcess.ts).
 *
 * A message's write needs one thing from the scopes at once: the undo that `prepare` returns, for a
 * write that fails. Here the core makes that itself, so a write never calls into the process or waits
 * on it, and nothing on this side can throw: teams can never cost a message its write (part 16).
 *
 * Every change (a message prepared or taken back, a prompt started, keys typed into a scoped terminal,
 * an agent forgotten, a question answered) is an event, numbered within this core's life and kept here
 * until the process says it has it. So none is lost to a process that is down, hung or restarting, and
 * the process applies each exactly once, in order:
 * - Each time it connects, it says which core it last heard from and the last event it applied
 *   (`hello`). The answer is the events it lacks.
 * - Or the answer tells it to start over: when it is new, when this core is (after a restart, as the
 *   scopes in the core's own process did), or when it missed events this side could no longer keep.
 *   Starting over loses no event this side still holds; what the old state knew goes, and fails
 *   closed.
 *
 * The socket's team features read an agent's scope back (`current`). The process reports each agent's
 * scope as it acknowledges events (`ack`), and the core answers from that report. While a change to an
 * agent's scope is on its way to the process, or after the process started over, the answer is null:
 * no team, never a wrong one. That is the fallback while the process is down, too.
 */
import { randomUUID } from 'node:crypto'
import type { PromptScopes, TeamsEvent } from './api.js'
import type { ServiceFrame } from './serviceLinks.js'

/** The most events kept for a process that has not taken them, and their rough size: past either, the
 *  oldest go, and the process starts over when it is back. Typing for half an hour fits. */
export const KEPT_EVENTS = 10_000
export const KEPT_BYTES = 16 * 1024 * 1024

export interface TeamsLinkOptions {
  /** Tell the teams' process something (core/serviceLinks.ts `notify`, for `teams`). */
  notify(frame: ServiceFrame): boolean
  now?: () => number
  newId?: () => string
  log?: (line: string) => void
  keptEvents?: number
  keptBytes?: number
}

type Change = TeamsEvent extends infer E ? E extends TeamsEvent ? Omit<E, 'seq' | 'core' | 'at'> : never : never

export function createTeamsLink(options: TeamsLinkOptions) {
  const now = options.now ?? Date.now
  const log = options.log ?? ((line: string) => console.warn(line))
  const keptEvents = options.keptEvents ?? KEPT_EVENTS
  const keptBytes = options.keptBytes ?? KEPT_BYTES
  /** This core's life: a process that heard another core's events starts over. */
  const core = (options.newId ?? randomUUID)()
  let seq = 0
  /** The last event the process said it applied. */
  let acked = 0
  /** Every event the process has not acknowledged, oldest first, and their rough size. */
  const journal: Array<{ event: TeamsEvent; size: number }> = []
  let journalBytes = 0
  let dropping = false
  /** Each agent's team as the process last reported it; only those with one. */
  const reported = new Map<string, string>()
  /** The last event that could move an agent's team: until the process has it, the team is unknown. */
  const moved = new Map<string, number>()

  const record = (change: Change, movesScope: boolean): number => {
    const event = { ...change, seq: ++seq, core, at: now() } as TeamsEvent
    const size = 256 + ('text' in event ? event.text.length : 0) + ('bytes' in event ? event.bytes.length : 0)
    journal.push({ event, size })
    journalBytes += size
    while (journal.length > keptEvents || journalBytes > keptBytes) {
      journalBytes -= journal.shift()!.size
      if (!dropping) log(`[teams] kept ${keptEvents} events or ${keptBytes} bytes for the teams process; it will start over when it is back`)
      dropping = true
    }
    if (movesScope) moved.set(change.agentId, event.seq)
    options.notify({ type: 'service_event', payload: { kind: 'event', event } })
    return event.seq
  }

  const scopes: PromptScopes = {
    prepare: (agentId, text, tabId, deliveryId) => {
      const of = record({ kind: 'prepare', agentId, text, tabId, deliveryId }, false)
      return () => { record({ kind: 'unprepare', agentId, of }, false) }
    },
    started: (agentId, text, source = 'transcript', engine) => { record({ kind: 'started', agentId, text, source, engine }, true) },
    raw: (agentId, bytes, tabId, pasted = false) => {
      record({ kind: 'raw', agentId, bytes: Buffer.from(bytes).toString('base64'), tabId, pasted }, false)
    },
    forget: (agentId) => { record({ kind: 'forget', agentId }, true) },
    replied: (agentId, teamId, questionId) => { record({ kind: 'replied', agentId, teamId, questionId }, true) },
    current: (agentId) => ((moved.get(agentId) ?? 0) > acked ? null : reported.get(agentId) ?? null),
  }

  /** The process connected: the events it lacks, or everything this side holds and a fresh start. */
  const hello = (payload: Record<string, unknown>): Record<string, unknown> => {
    const theirs = payload.core === core && typeof payload.applied === 'number' ? payload.applied : null
    const first = journal[0]?.event.seq
    const reset = theirs === null || theirs > seq || (first !== undefined && first > theirs + 1)
    if (reset) reported.clear()
    dropping = false
    const base = reset ? (first ?? seq + 1) - 1 : theirs
    return { core, reset, base, events: journal.filter((entry) => entry.event.seq > base).map((entry) => entry.event) }
  }

  /** The process applied every event up to `applied`, and says where each agent it touched stands. */
  const ack = (payload: Record<string, unknown>): Record<string, unknown> => {
    if (payload.core !== core || typeof payload.applied !== 'number') return { kept: false }
    const applied = payload.applied
    acked = Math.max(acked, applied)
    while (journal.length && journal[0].event.seq <= acked) journalBytes -= journal.shift()!.size
    const teams = payload.scopes && typeof payload.scopes === 'object' ? payload.scopes as Record<string, unknown> : {}
    for (const [agentId, teamId] of Object.entries(teams)) {
      // A report older than the agent's last move is not its team: the newer one is on its way.
      if ((moved.get(agentId) ?? 0) > applied) continue
      if (typeof teamId === 'string') reported.set(agentId, teamId)
      else { reported.delete(agentId); moved.delete(agentId) }
    }
    return { kept: true }
  }

  return {
    scopes,
    /** The core's answers to the teams' questions (core/serviceLinks.ts `answer`, for `teams`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      if (query === 'hello') return hello(payload)
      if (query === 'ack') return ack(payload)
      return { error: 'UNKNOWN_QUERY' }
    },
  }
}

export type TeamsLink = ReturnType<typeof createTeamsLink>
