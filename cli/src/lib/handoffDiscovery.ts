// The session an unbound, live agent runs, found for "Change agent"'s handoff, and the wiring of the
// handoff provider's dependencies (cli.ts passes the real functions, specs pass fakes). Discovery is
// read-only: it never binds anything, and it answers only when the answer is certain — a Change agent
// must not guess whose conversation it hands over. Consumed by lib/agentHandoff.ts.
import type { AgentEngine } from '../engines/types.js'
import type { HandoffDeps } from './agentHandoff.js'
import { isSubagentTranscript } from './subagentTranscript.js'
import type { RecentRecap } from './recapReads.js'
import type { RegisteredSession } from './registry.js'
import type { RepairedSession } from './sessionRepair.js'
import type { TurnSource } from './sessionSearch/sessionTurns.js'
import { SQLITE_BACKED_ENGINES } from './sqliteAvailability.js'

export interface DiscoveryDeps {
  /** Engines other than Claude: the born, unique session of a process (sessionRepair findLiveSession). */
  findLiveSession(engine: AgentEngine, cwd: string, startedAtMs: number, opts: { bornOnly: true; pid: number; codexHome?: string }): Promise<RepairedSession | null>
  /** Claude: the session its per-process record names, or null. Never a scan of the project folder. */
  claudeProcessSession(pid: number, cwd: string, startedAtMs: number): Promise<RepairedSession | null>
  /** The agent has a live pane (not a stopped copy). */
  isLive(agentId: string): boolean
  /** Another agent, running or stopped, already holds this session. Must answer true when it cannot tell. */
  ownedByOther(sessionId: string, agentId: string): boolean
  isRecentlyDeleted(sessionId: string): boolean
}

/** Engines whose conversation is a database row: `findLiveSession` matches those on activity time, not birth. */
const DATABASE_ENGINES: ReadonlySet<string> = new Set(SQLITE_BACKED_ENGINES)

/**
 * `HandoffDeps.discoverSession`: the session a live, unbound, non-fork agent of a file engine runs, found by its
 * process (pid and start marker) — Claude only through its per-process record, the others only a session born to
 * that process — or null. Null too when the session is a subagent's, was just deleted, or another agent holds it.
 * One search per agent at a time: a second request while one runs shares it.
 */
export function sessionDiscovery(deps: DiscoveryDeps): (session: RegisteredSession) => Promise<TurnSource | null> {
  const pending = new Map<string, Promise<TurnSource | null>>()

  async function find(session: RegisteredSession, cwd: string, pid: number, startedAt: number): Promise<TurnSource | null> {
    try {
      const found = session.engine === 'claude'
        ? await deps.claudeProcessSession(pid, cwd, startedAt)
        : await deps.findLiveSession(session.engine, cwd, startedAt, { bornOnly: true, pid, codexHome: session.codexHome ?? undefined })
      const path = found?.transcriptPath
      if (!found || !found.sessionId || !path || isSubagentTranscript(path)) return null
      if (deps.isRecentlyDeleted(found.sessionId) || deps.ownedByOther(found.sessionId, session.agentId)) return null
      return { engine: session.engine, sessionId: found.sessionId, transcriptPath: path }
    } catch { return null }
  }

  return (session) => {
    if (session.sessionId || !session.cwd || session.forkedFrom != null) return Promise.resolve(null)
    if (DATABASE_ENGINES.has(session.engine)) return Promise.resolve(null)
    // As the repair sweep: the process itself, by its start and pid. Without them there is nothing certain to look for.
    const pid = session.processIdentity?.pid
    const startedAt = Date.parse(session.processIdentity?.startMarker ?? '')
    if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0 || !Number.isFinite(startedAt)) return Promise.resolve(null)
    let live = false
    try { live = deps.isLive(session.agentId) } catch { live = false }
    if (!live) return Promise.resolve(null)
    const running = pending.get(session.agentId)
    if (running) return running
    const promise = find(session, session.cwd, pid, startedAt).finally(() => { if (pending.get(session.agentId) === promise) pending.delete(session.agentId) })
    pending.set(session.agentId, promise)
    return promise
  }
}

export interface OwnershipDeps {
  bySession(sessionId: string): { agentId: string } | null | undefined
  /** The ids of every stopped record on disk, readable or not. */
  stoppedIds(): string[]
  /** One stopped record; throws when it cannot be read. */
  stopped(agentId: string): { agentId: string; sessionId: string } | null
}

/**
 * Does an agent other than `agentId` hold `sessionId`, running or stopped? Fails closed, record by record: a
 * stopped record that cannot be read (or is unusable) might be the holder, so it counts as one. (The store's
 * `list()` skips such records silently, which would fail open.)
 */
export function ownedByOther(deps: OwnershipDeps, sessionId: string, agentId: string): boolean {
  try {
    const owner = deps.bySession(sessionId)
    if (owner && owner.agentId !== agentId) return true
    for (const id of deps.stoppedIds()) {
      if (id === agentId) continue
      const record = deps.stopped(id)
      if (!record || (record.sessionId === sessionId && record.agentId !== agentId)) return true
    }
    return false
  } catch { return true }
}

/** The real functions the provider is built from (cli.ts), so a spec can pass fakes and see each one reached. */
export interface HandoffWiring {
  registry: {
    resolve(id: string): RegisteredSession | null | undefined
    byAgent(id: string): unknown
    bySession(sessionId: string): { agentId: string } | null | undefined
  }
  stopped: { get(id: string): RegisteredSession | null; ids(): string[] }
  /** The recaps, as the core reads them back (core/turns/recaps.ts). */
  mirror: {
    recentAsks(sessionId: string, n?: number): string[]
    lastFullText(sessionId: string): string | undefined
    recent(sessionId: string, n?: number): RecentRecap[]
  }
  databaseHistory: HandoffDeps['readHistory']
  findLiveSession: DiscoveryDeps['findLiveSession']
  claudeProcessSession: DiscoveryDeps['claudeProcessSession']
  isRecentlyDeleted(sessionId: string): boolean
  findResumedTranscript: NonNullable<HandoffDeps['findTranscript']>
  validTranscriptPath(engine: AgentEngine, path: string, codexHome?: string): boolean
}

/**
 * The dependencies of `prepareAgentHandoff`. Call it ONCE: the discovery made here holds the one-search-per-agent
 * state, which must outlive any single request.
 */
export function handoffProviderDeps(w: HandoffWiring): HandoffDeps {
  return {
    resolve: (id) => w.registry.resolve(id) ?? w.stopped.get(id),
    readHistory: w.databaseHistory,
    recentAsks: (sid, n) => w.mirror.recentAsks(sid, n),
    lastFullText: (sid) => w.mirror.lastFullText(sid),
    recaps: (sid, n) => w.mirror.recent(sid, n).filter((e) => e.kind === 'summary').map((e) => e.recap || e.text).filter(Boolean),
    // A pane that has not found its session yet (a repair still pending): the session it runs, only when it is
    // certain. Never a fork, never a database engine, never one another agent holds.
    discoverSession: sessionDiscovery({
      findLiveSession: w.findLiveSession,
      claudeProcessSession: w.claudeProcessSession,
      isLive: (id) => !!w.registry.byAgent(id),
      ownedByOther: (sid, id) => ownedByOther({
        bySession: (s) => w.registry.bySession(s), stoppedIds: () => w.stopped.ids(), stopped: (s) => w.stopped.get(s),
      }, sid, id),
      isRecentlyDeleted: (sid) => w.isRecentlyDeleted(sid),
    }),
    findTranscript: (engine, sid, opts) => w.findResumedTranscript(engine, sid, opts),
    transcriptOk: (engine, path, home) => w.validTranscriptPath(engine, path, home ?? undefined),
  }
}
