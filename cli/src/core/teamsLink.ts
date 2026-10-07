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
 *
 * Teams is an experiment (core/api.ts `EXPERIMENTS`): its process runs only once it is on. Until then
 * (`off`), nothing is kept for it, and nothing it would read is said: the core keeps no journal for a process
 * no one asked for (`on`, once it is asked for or connects). The rest of what the core keeps of it:
 * - which of its deliveries may be written now (`canWrite`, asked in line as a team's turn is written,
 *   core/input.ts), as the process last reported them (`writable`); none before, so a team's turn waits;
 * - the two `team_delivery` questions about the scopes themselves (`prompt_scope`, `prompt_replied`), which
 *   the core answered while the scopes' process was down and still does (`route`), and the same two asked
 *   by the process itself for its teams (`team_scope`, `team_replied`).
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
  /** Teams is not on yet: nothing is kept for its process until `on`. */
  off?: boolean
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
  /** Whether teams is on: its process asked for, or connected. */
  let active = options.off !== true
  /** Each delivery the process says may be written now, and until when. */
  let writable = new Map<string, number>()

  const record = (change: Change, movesScope: boolean): number => {
    if (!active) return 0
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

  const scopes: PromptScopes & { canWrite(deliveryId: string): boolean } = {
    prepare: (agentId, text, tabId, deliveryId) => {
      const of = record({ kind: 'prepare', agentId, text, tabId, deliveryId }, false)
      return () => { if (of) record({ kind: 'unprepare', agentId, of }, false) }
    },
    started: (agentId, text, source = 'transcript', engine) => { record({ kind: 'started', agentId, text, source, engine }, true) },
    raw: (agentId, bytes, tabId, pasted = false) => {
      record({ kind: 'raw', agentId, bytes: Buffer.from(bytes).toString('base64'), tabId, pasted }, false)
    },
    forget: (agentId) => { record({ kind: 'forget', agentId }, true) },
    replied: (agentId, teamId, questionId) => { record({ kind: 'replied', agentId, teamId, questionId }, true) },
    current: (agentId) => ((moved.get(agentId) ?? 0) > acked ? null : reported.get(agentId) ?? null),
    canWrite: (deliveryId) => (writable.get(deliveryId) ?? 0) > now(),
  }

  const agentOf = (value: unknown): string | null => (typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null)
  const operationOf = (value: unknown): string | null => (typeof value === 'string' && /^[a-f0-9]{32}$/.test(value) ? value : null)
  /** A scope's own question, answered here: `{ teamId }` for `prompt_scope`, the reply taken for `prompt_replied`. */
  const scopeAnswer = (action: unknown, payload: Record<string, unknown>): Record<string, unknown> => {
    const agentId = agentOf(payload.agentId)
    if (!agentId) return { error: 'INVALID_REQUEST', detail: 'agentId: Invalid' }
    if (action === 'prompt_scope') return { teamId: scopes.current(agentId) }
    const teamId = operationOf(payload.teamId), questionId = operationOf(payload.questionId)
    if (!teamId || !questionId) return { error: 'INVALID_REQUEST', detail: `${teamId ? 'questionId' : 'teamId'}: Invalid` }
    scopes.replied(agentId, teamId, questionId)
    return { ok: true }
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
    /** Teams is on: keep everything for its process from now on. */
    on(): void { active = true },
    /** The core's answers to the teams' questions (core/serviceLinks.ts `answer`, for `teams`). */
    answer(query: string, payload: Record<string, unknown>): Record<string, unknown> {
      if (query === 'hello') return hello(payload)
      if (query === 'ack') return ack(payload)
      if (query === 'team_scope') return scopeAnswer('prompt_scope', payload)
      if (query === 'team_replied') return scopeAnswer('prompt_replied', payload)
      if (query === 'writable') {
        const reported = payload.deliveries && typeof payload.deliveries === 'object' ? payload.deliveries as Record<string, unknown> : {}
        writable = new Map(Object.entries(reported).flatMap(([id, until]) => (typeof until === 'number' ? [[id, until] as const] : [])))
        return {}
      }
      return { error: 'UNKNOWN_QUERY' }
    },
    /** A `team_delivery` question about the scopes themselves, answered here as it was while the scopes'
     *  process was down: false for every other request, which goes to the teams' process. */
    route(type: string, payload: Record<string, unknown>, asker: { owner: boolean }, reply: (result: Record<string, unknown>) => void): boolean {
      if (type !== 'team_delivery' || (payload.action !== 'prompt_scope' && payload.action !== 'prompt_replied')) return false
      reply(asker.owner ? scopeAnswer(payload.action, payload) : { error: 'OWNER_REQUIRED', detail: 'Team communication requires an owner connection.' })
      return true
    },
  }
}

export type TeamsLink = ReturnType<typeof createTeamsLink>

/**
 * Whether Tab collaboration runs in its own process: the prompt scopes (`teams`) and the teams beside them
 * (`collaboration`) both, or both in the core's. Named apart (`HARNESSD_SERVICES=collaboration`), they would
 * be two mailboxes on one folder: both run in the core's process then, and it says so.
 */
export function teamsOutOfProcess(outOfProcess: Set<string>, log: (line: string) => void = (line) => console.warn(line)): boolean {
  if (outOfProcess.has('teams') !== outOfProcess.has('collaboration')) {
    log('[services] the prompt scopes and the teams run in one process or none: both run in this one')
    outOfProcess.delete('teams')
    outOfProcess.delete('collaboration')
  }
  return outOfProcess.has('teams')
}
