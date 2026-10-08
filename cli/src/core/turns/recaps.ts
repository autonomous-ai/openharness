/**
 * Recaps, as the core keeps them: only the turn's lifecycle, told to the recaps service as it happens
 * (services/recaps.ts, through `RecapsPort`), and what it holds of a session, read back in line. The cards
 * on the dial and in the window, the notifications on the phone and the recap files are the service's.
 *
 * The core never waits on it. Each call below is a notice the service may miss, or a read of what it last
 * said (in its own process, core/recapsLink.ts), or none while it is off: then a turn has no recap and
 * no card, and nothing else changes. A recap is stored under the engine session and asked for by agent.
 *
 * `mirror` keeps the calls the rest of the core made into the commander mirror when it ran here, so the
 * funnel, the heartbeats, cancel, fork, binding and purge each say what happened in their own words.
 */
import type { LiveEvent } from '../../engines/kit/events.js'
import { lastFullText, recentAsks, recentRecaps, type RecentRecap, type SessionRecaps } from '../../lib/recapReads.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'
import type { TurnActivity } from '../../lib/turnActivity.js'
import type { OrchestratorService } from '../../orchestrator/service.js'
import type { RecapSession, RecapsPort, RecapWatchers, TurnCardFrame, TurnLifecycle } from '../api.js'

export interface RecapDeps {
  /** The recaps service's port, or null while it is off. */
  port: () => RecapsPort | null
  turnActivity: Pick<TurnActivity, 'snapshot'>
  /** Whether a device actively renders this machine through the backend. */
  clients: { hasActiveCommander(): boolean }
  deviceIsWatching: () => boolean
  cableWatchingLocal: () => boolean
  bySession: (sessionId: string) => RegisteredSession | undefined
  resolve: (id: string) => RegisteredSession | undefined
  /** A stopped agent's archived record (stoppedAgents.get). */
  stopped: (agentId: string) => RegisteredSession | null
  /** The live agents: which of them are verifiably working, when a device joins. */
  live: () => RegisteredSession[]
  /** Whether a turn is open on the session: the core's own word, from its transcript. */
  sessionTurnOpen: (sessionId: string) => boolean
  /** The orchestrator's role for an agent: a specialist, or the director. */
  orchestratorRoleOf: OrchestratorService['roleOf']
}

/** The calls the core makes about a turn's recap. */
export interface TurnRecaps {
  /** A session's events, as one batch. */
  ingest(events: LiveEvent[], sessionId: string, options?: { replay?: boolean }): void
  /** The turn heartbeat: whether the devices' card for it is still busy, as the recaps last said. */
  heartbeat(sessionId: string): boolean
  cancel(sessionId: string): void
  forget(sessionId: string): void
  deleteHistory(sessionId: string): void
  inheritSummary(fromSessionId: string, toSessionId: string): void
  noteEngineStopped(sessionId: string): void
  replayAll(): void
  /** The session attached with its last turn already over: the recaps recap it if they have not. */
  settled(sessionId: string): void
  /** A turn is open on the session right now: a fork waits for it to end. */
  isBusy(sessionId: string): boolean
  recent(sessionId: string, n?: number): RecentRecap[]
  recentAsks(sessionId: string, n?: number): string[]
  lastFullText(sessionId: string): string | undefined
  /** The cards of every turn still at work, for a dial that just attached; none while the recaps are off. */
  liveCards(): Promise<TurnCardFrame[]>
}

export function createRecaps({
  port, turnActivity, clients, deviceIsWatching, cableWatchingLocal, bySession, resolve, stopped, live, sessionTurnOpen,
  orchestratorRoleOf,
}: RecapDeps) {
  /**
   * A turn that belongs to a SUB-AGENT: an Orchestrator specialist, or its Director while specialists
   * are still out.
   *
   * The dial is not the only screen that has to know. The recaps learn it with the turn's end and put it
   * on the summary card as `silent`; the window and the phone learn it as `subagent` on `turn_ended` (see
   * the funnel) — the phone notifies on neither. One rule, asked twice — the two surfaces used to disagree
   * here, and a four-specialist project put ONE row on the dial and FIVE marks in the window.
   */
  const isSubagentSession = (sessionId: string): boolean => {
    const agentId = bySession(sessionId)?.agentId
    if (!agentId) return false
    // Asked at every turn's end, from the transcript's line handler. Reading the orchestrator makes its
    // folder, which throws on a full disk (e2e/diskfull.e2e.ts): announced as anyone's, the turn keeps its end.
    let role: ReturnType<typeof orchestratorRoleOf>
    try { role = orchestratorRoleOf(agentId) } catch { return false }
    return role?.role === 'worker' || (role?.role === 'director' && role.busy)
  }
  /** Who watches the cards now: the recaps read it as they emit one. A plugged-in dial is always watching. */
  const watchers = (): RecapWatchers => ({ device: deviceIsWatching(), active: clients.hasActiveCommander() || cableWatchingLocal() })
  /** A session as the recaps address its cards. Whether it is a sub-agent's is asked only where a turn
   *  ends (it reads the orchestrator); elsewhere the recaps keep what they were last told. */
  const session = (sessionId: string, subagent?: boolean): RecapSession => {
    const known = bySession(sessionId)
    return {
      sessionId,
      agentId: known?.agentId ?? sessionId,
      ...(known ? { name: projectDisplayName(known) } : {}),
      ...(known?.transcriptPath ? { transcriptPath: known.transcriptPath } : {}),
      ...(subagent === undefined ? {} : { subagent }),
    }
  }
  const tell = (event: TurnLifecycle): void => { port()?.lifecycle(event, watchers()) }
  const read = (sessionId: string): SessionRecaps | null => port()?.recaps(sessionId) ?? null

  const mirror: TurnRecaps = {
    ingest: (events, sessionId, options) => {
      const ends = events.some((event) => event.type === 'turn_ended')
      tell({ kind: 'events', session: session(sessionId, ends ? isSubagentSession(sessionId) : undefined), events, replay: !!options?.replay })
    },
    heartbeat: (sessionId) => {
      tell({ kind: 'beat', session: session(sessionId), working: turnActivity.snapshot(sessionId)?.state === 'working' })
      return read(sessionId)?.busy ?? false
    },
    cancel: (sessionId) => { tell({ kind: 'cancelled', session: session(sessionId, isSubagentSession(sessionId)) }) },
    forget: (sessionId) => { tell({ kind: 'forgotten', session: session(sessionId, isSubagentSession(sessionId)) }) },
    deleteHistory: (sessionId) => { tell({ kind: 'purged', sessionId }) },
    inheritSummary: (from, to) => { tell({ kind: 'rebound', from, to }) },
    noteEngineStopped: (sessionId) => { tell({ kind: 'stopped', sessionId }) },
    replayAll: () => {
      const working = live().map((s) => s.sessionId).filter((sessionId) => !!sessionId && turnActivity.snapshot(sessionId)?.state === 'working')
      tell({ kind: 'rejoined', working })
    },
    settled: (sessionId) => { tell({ kind: 'settled', session: session(sessionId) }) },
    isBusy: (sessionId) => sessionTurnOpen(sessionId),
    recent: (sessionId, n) => recentRecaps(read(sessionId), n),
    recentAsks: (sessionId, n) => recentAsks(read(sessionId), n),
    lastFullText: (sessionId) => lastFullText(read(sessionId)),
    liveCards: () => port()?.liveCards() ?? Promise.resolve([]),
  }
  /** A question put to the person, or answered: a turn waiting on one is not announced as done. */
  const question = (kind: 'asked' | 'answered', sessionId: string, requestId: string): void => { tell({ kind, sessionId, requestId }) }
  // Recaps are STORED under the engine session id — that is what lets `--resume` bring the last recap
  // back under a brand-new agent — but they are ASKED FOR by agent id, which is the only id the device
  // and the voice router know. Resolve across the two, or every tile restores empty.
  const recent = (id: string, n: number) => mirror.recent(resolve(id)?.sessionId || stopped(id)?.sessionId || id, n)
  const recentAsksOf = (id: string, n?: number) => mirror.recentAsks(resolve(id)?.sessionId || stopped(id)?.sessionId || id, n)
  /**
   * The reply to `agent_recent`: an agent's last turn summaries and the person's last questions. Asked
   * by a device restoring its tiles at boot, so it holds only what was summarized (recap and body),
   * never a resurrected full-text card, and nothing until a turn was summarized.
   *
   * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
   */
  const agentRecent = (payload: Record<string, unknown>): Record<string, unknown> => {
    const projectId = payload.agentId as string | undefined
    if (!projectId) return { error: 'MISSING_AGENT_ID' }
    const n = Math.max(1, Math.min(5, Number(payload.n) || 2))
    const events = recent(projectId, n)
    // ASKS TRAVEL AS THEIR OWN LIST, beside the events rather than inside them. A question exists
    // the moment it is asked; a recap exists once the turn has been answered and summarised. They
    // are different lengths on any machine where a turn ended without one, so a reply that folds
    // the questions into the event rows loses exactly the newest ones — and a REMOTE agent then
    // reaches the router with nothing but its name.
    const asks = recentAsksOf(projectId, n)
    return { agentId: projectId, events, asks }
  }
  return { mirror, isSubagentSession, question, recent, recentAsks: recentAsksOf, agentRecent }
}

export type Recaps = ReturnType<typeof createRecaps>
