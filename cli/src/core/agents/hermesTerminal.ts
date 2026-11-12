/**
 * What the bind pass does with the record a Hermes keeps of its own terminal (`<home>/terminal-sessions/<terminal id>`,
 * docs/plans/2026-11-12-sandbox-hooks-design.md §3): the session to bind or switch the agent to now, a record to wait
 * on, or no record, and the repair goes on as before. It reads nothing itself: the pane's tty, the record and the
 * store are asked through its deps, and bind.ts commits what it answers.
 */
import { HERMES_TERMINAL_SAID } from '../../engines/hermes/contract.js'
import type { Terminal, TerminalRecordRead } from '../../engines/kit/terminalRecord.js'
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { START_SLACK_MS } from '../../lib/sessionRepair.js'
import type { DiscoveredTerminalAgent } from '../../lib/terminalAgentDiscovery.js'
import { terminalRouteKey } from '../../lib/terminalRuntime.js'
import type { TerminalPaneInfo, TerminalRuntimeRef } from '../../lib/terminalTypes.js'
import { REPAIR_RETRY_MS } from './bind.js'

/** Agents remembered; past it, those the registry no longer has are dropped, or all (one more read and line each). */
const MAX_AGENTS = 256

export interface HermesTerminalDeps {
  platform: NodeJS.Platform
  defaultHome: string
  registry: Pick<typeof registry, 'byAgent'>
  paneInfo: (runtime: TerminalRuntimeRef) => Promise<TerminalPaneInfo | null>
  names: (terminal: Terminal) => string[]
  stamp: (home: string, names: readonly string[]) => Promise<string>
  read: (home: string, names: readonly string[], sinceMs: number) => Promise<TerminalRecordRead>
  /** Throws when the store cannot be read. */
  kind: (home: string, sessionId: string) => Promise<'own' | 'waiting' | 'other'>
  /** Whether the session was ended at or after a moment. Throws when the store cannot be read. */
  endedSince: (home: string, sessionId: string, sinceMs: number) => Promise<boolean>
  /** What the home's store is now: changed by every write to it. */
  storeStamp: (home: string) => Promise<string>
  /** Told each time an agent's process is first seen keeping a record in a home. */
  recordSeen: (home: string) => void
  now: () => number
}
export type HermesObserved = Pick<DiscoveredTerminalAgent, 'processIdentity' | 'runtimes' | 'primaryRuntimeKey' | 'hermesHome'> & { sandboxed: boolean }
export interface HermesPass { current: () => boolean; mayClaim: (sessionId: string) => boolean; hold: (error: unknown) => void }
/** `'none'`: no record, the caller goes on as before. `'wait'`: nothing to do this pass. A session: commit it now. */
export type HermesFollow = 'none' | 'wait' | { sessionId: string; hermesHome?: string }

/**
 * What the record at a stamp said: the answer it settled on, or the session it names while that is decided, with the
 * store as it was when it last had no row for it or could not be read, and for a read that failed, when to ask anyway.
 */
type Known = { stamp: string; settled: HermesFollow } | { stamp: string; sessionId: string; asked?: { store: string; until?: number } }

/** What is kept of one process of an agent's. */
interface Run {
  /** `pid:startMarker`. */
  process: string
  names?: string[]
  known?: Known
  recordSeen: boolean
}

interface Entry {
  /** Kept across the agent's processes: each line is said once per agent. */
  said: Set<string>
  run?: Run
}

export function createHermesTerminal(deps: HermesTerminalDeps) {
  const entries = new Map<string, Entry>()
  const entryOf = (agentId: string): Entry => {
    const known = entries.get(agentId)
    if (known) return known
    if (entries.size >= MAX_AGENTS) {
      for (const id of entries.keys()) if (!deps.registry.byAgent(id)) entries.delete(id)
      if (entries.size >= MAX_AGENTS) entries.clear()
    }
    const entry: Entry = { said: new Set() }
    entries.set(agentId, entry)
    return entry
  }
  const say = (agentId: string, entry: Entry, text: string): void => {
    if (entry.said.has(text)) return
    entry.said.add(text)
    console.log(`[discovery] ${sid(agentId)} ${text}`)
  }

  const follow = async (agent: RegisteredSession, observed: HermesObserved, pass: HermesPass): Promise<HermesFollow> => {
    // Hooks follow a switch there.
    if (deps.platform === 'win32') return 'none'
    const entry = entryOf(agent.agentId)
    const { pid, startMarker } = observed.processIdentity
    const process = `${pid}:${startMarker}`
    const startedAtMs = Date.parse(startMarker)
    if (entry.run?.process !== process) entry.run = { process, recordSeen: false }
    const run = entry.run
    let names = run.names
    if (!names) {
      const runtime = observed.runtimes.find(one => terminalRouteKey(one) === observed.primaryRuntimeKey) ?? observed.runtimes[0]
      const tty = (await deps.paneInfo(runtime))?.tty || null
      names = deps.names({ tty, tmuxPane: runtime.backend === 'tmux' ? runtime.paneId : null })
      // Hermes names its terminal by its tty first: one not named now is asked for again on the next pass.
      if (tty) run.names = names
    }
    if (!names.length) return 'none'
    const home = agent.hermesHome ?? observed.hermesHome ?? deps.defaultHome
    const stamp = await deps.stamp(home, names)
    let known = run.known
    if (known?.stamp !== stamp) {
      const read: TerminalRecordRead = Number.isFinite(startedAtMs)
        ? await deps.read(home, names, startedAtMs - START_SLACK_MS)
        : { state: 'none' }
      if (read.state === 'ignored') say(agent.agentId, entry, HERMES_TERMINAL_SAID.ignored(read.reason === 'stale' ? 'older than its process' : read.reason))
      if (read.state !== 'record') {
        run.known = { stamp, settled: 'none' }
        return 'none'
      }
      known = run.known = { stamp, sessionId: read.sessionId }
    }
    if ('settled' in known) return known.settled
    const { sessionId } = known
    if (!run.recordSeen) {
      run.recordSeen = true
      deps.recordSeen(home)
      if (observed.sandboxed) say(agent.agentId, entry, HERMES_TERMINAL_SAID.sandbox)
    }
    if (sessionId === agent.sessionId) {
      // The registry fails a resumed row that reports another conversation until something confirms its own; with no
      // hook, the record does, once (the commit stamps `lastHookAt`).
      if (agent.resumeOnly && agent.lastHookAt === 0) return { sessionId }
      run.known = { stamp, settled: 'wait' }
      return 'wait'
    }
    if (!pass.mayClaim(sessionId)) return 'wait'
    // Hermes writes a CLI session's row on its first turn (run_agent.py `_ensure_db_session`), however long after the
    // record names it. A store that had no row, or could not be read, is asked again on the first pass after it changed:
    // a first message after any idle binds within a pass, where the repair's minute made it wait up to one. A read can
    // also fail on the daemon's side (its read threads busy past the deadline) with nothing written since: that one is
    // asked again in the repair's minute too.
    const store = await deps.storeStamp(home)
    if (known.asked?.store === store && (known.asked.until === undefined || deps.now() < known.asked.until)) return 'wait'
    const failed = (): 'wait' => {
      known.asked = { store, until: deps.now() + REPAIR_RETRY_MS }
      return 'wait'
    }
    // A resume not yet confirmed is failed by any other session (registry.ts RESUME_SESSION_MISMATCH), and a `/new` typed
    // before a pass read the record leaves it naming only the new one. Hermes ends the session a terminal leaves: the
    // resumed one ended since this process started was open in it, and is confirmed first; the next pass follows.
    if (agent.resumeOnly && agent.lastHookAt === 0 && agent.sessionId) {
      let left: boolean
      try {
        left = await deps.endedSince(home, agent.sessionId, startedAtMs - START_SLACK_MS)
      } catch {
        return failed()
      }
      if (!pass.current()) return 'wait'
      if (left) return { sessionId: agent.sessionId }
    }
    let kind: Awaited<ReturnType<HermesTerminalDeps['kind']>>
    try {
      kind = await deps.kind(home, sessionId)
    } catch (error) {
      // A bound agent keeps the session it is on; an unbound one is held, as the repair's unreadable store holds it.
      if (!agent.sessionId) pass.hold(error)
      return failed()
    }
    if (!pass.current()) return 'wait'
    // A fresh record never falls back: the repair could only bind a session this terminal is not on. Waiting for the
    // row is how every new session starts, so nothing is said of it.
    if (kind === 'waiting') {
      known.asked = { store }
      return 'wait'
    }
    if (kind === 'other') {
      say(agent.agentId, entry, HERMES_TERMINAL_SAID.ignored("its session is not a pane's own"))
      run.known = { stamp, settled: 'wait' }
      return 'wait'
    }
    // A record replaced while the store was read is older than what the terminal is on now (core rule 7).
    if (await deps.stamp(home, names) !== stamp || !pass.current() || !pass.mayClaim(sessionId)) return 'wait'
    return !agent.hermesHome && home !== deps.defaultHome ? { sessionId, hermesHome: home } : { sessionId }
  }

  return {
    follow,
    fellBack(agentId: string): void {
      if (deps.platform !== 'win32') say(agentId, entryOf(agentId), HERMES_TERMINAL_SAID.fallback)
    },
  }
}
