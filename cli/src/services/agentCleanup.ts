/**
 * Cleaning up after agents (docs/design/2026-10-11-agent-client.md, "Cleaning up"). Every harness an agent starts
 * spends the person's tokens while it works and sits in their windows while it waits, and its starter may forget it:
 * Harness closes the ones nobody needs any more (owner, October 12: "we need to properly clean up after too").
 *
 * - **With its starter.** A harness closed, by the person (a window, the phone, `harness close`) or by the agent that
 *   started it, closes the harnesses it started on this machine at once, working or not (`now`): nobody reads what an
 *   orphan does, and one that keeps working spends tokens for no one. The core tells this after every stop
 *   (core/agents/lifecycle.ts `stopped`).
 * - **When idle.** A harness another agent started that has sat `IDLE_CLOSE_MS` after its last answer is closed, once
 *   its screen says it is idle (`idle`): never one that works, waits for the person or holds a draft. Looked at every
 *   `LOOK_EVERY_MS`, by when its conversation last moved (`CoreApi.agents.lastActivity`), so a look costs no screen
 *   read until one has been quiet that long. Its process starting again counts as moving: a resume writes nothing a
 *   conversation's time is read from, and a harness the person resumed to read its answer was closed again within a
 *   minute (the review of #1234). Nor one that still runs background commands (a dev server, a test watcher), which the
 *   core refuses with their count (`SESSION_NOT_IDLE`, `backgroundCommands`), said once: until it has sat
 *   `BACKGROUND_CLOSE_MS` after its last answer, when it is closed whatever runs. An agent often leaves a server or a
 *   watcher running on purpose and a stale Hermes entry never ends, so without a ceiling it would stay open for ever.
 * - **Never the person's.** Neither touches a harness the person typed or pasted into from a window or the phone: it is
 *   theirs from then on, and kept so in `<data>/agent-cleanup.json` across restarts. A harness the person started is
 *   never one this may close: the core refuses (`CoreApi.agents.closeStarted`).
 * - **Never what Hachi started.** However the Hachi harness closes, what it started is handed to the person instead of
 *   closed, and is never closed for sitting idle after (services/hachiHandOver.ts).
 *
 * A close keeps the conversation, as `harness close` does: the person can resume it, and `harness show` still reads its
 * answer. One line in the log for each close.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Ledger, ledgerPath } from '../agentClient/ledger.js'
import type { AgentCleanupPort, CoreApi, CorePorts } from '../core/api.js'
import { backgroundSaid } from '../lib/backgroundSaid.js'
import type { AgentCloseResult } from '../lib/closeAgentService.js'
import type { RegisteredSession } from '../lib/registry.js'
import { createMessagesRpc } from '../messages/rpc.js'
import { createHachiHandOver } from './hachiHandOver.js'
import { removeSwarmLeftovers } from './swarmLeftovers.js'

/** How long a harness another agent started may sit idle after its last answer before it is closed. */
export const IDLE_CLOSE_MS = 30 * 60_000
/** How long one that still runs background commands may sit after its last answer before it is closed whatever runs. */
export const BACKGROUND_CLOSE_MS = 2 * 60 * 60_000
/** How often the harnesses agents started are looked at. */
export const LOOK_EVERY_MS = 60_000
/** How long one that would not close (working after all, waiting for the person) is left before it is asked again. */
export const ASK_AGAIN_MS = 5 * 60_000
/** How often a starter's harnesses are tried, and how far apart: a close can fail for a moment (its conversation's
 *  identity between two writes, `IDENTITY_UNAVAILABLE`), and one left open may go on working for no one. */
export const CASCADE_TRIES = 3
export const CASCADE_RETRY_MS = 5_000
/** The harnesses the person joined that are remembered, the newest. */
export const JOINED_MAX = 1_000

/** How long a delete's erase waits for the ledger's lock: a writer holds it for one appended line. The wait blocks this
 *  process, which the edge host's other services share, so it is a quarter of a second and not the ledger's own two:
 *  refused, the delete has deleted nothing yet and is asked again. */
export const FORGET_LOCK_WAIT_MS = 250

/** Where the harnesses the person joined are kept, in the daemon's data folder. */
export const joinedPath = (dataDir: string): string => join(dataDir, 'agent-cleanup.json')

export interface AgentCleanupDeps {
  now?: () => number
  log?: (line: string) => void
  /** Before each look and each close of a starter's harnesses: a cleanup in its own process asks the core for the live
   *  agents then (services/agentCleanupProcess.ts). */
  refresh?: () => Promise<void>
  /** Runs [look] every [ms]; returns how to stop. */
  every?: (ms: number, look: () => void) => () => void
  /** Waits [ms] before a starter's harnesses are tried again. */
  wait?: (ms: number) => Promise<void>
  /** How long a delete's erase waits for the ledger's lock (`FORGET_LOCK_WAIT_MS`). */
  forgetLockWaitMs?: number
  /** Asks another of the owner's machines' messages service (messages/service.ts), as `harness tell` does: a hand-over
   *  of what Hachi started there. By default over this daemon's own socket. */
  tell?: (machineId: string, payload: Record<string, unknown>) => Promise<unknown>
}


function readJoined(file: string): Map<string, number> {
  try {
    const saved = (JSON.parse(readFileSync(file, 'utf8')) as { joined?: Record<string, unknown> }).joined ?? {}
    return new Map(Object.entries(saved).filter((entry): entry is [string, number] => typeof entry[1] === 'number'))
  } catch {
    return new Map()
  }
}

/** One run of a harness's process: a resume, a restore or a restart is another. */
const incarnation = (s: RegisteredSession): string => `${s.agentId}|${s.processIdentity?.pid ?? ''}|${s.processIdentity?.startMarker ?? ''}`

const label = (s: RegisteredSession): string => `${s.defaultName || s.title || 'a harness'} (${s.agentId.slice(0, 8)})`
const reason = (error: unknown): string => (error instanceof Error ? error.message : String(error))
const STARTER_CLOSED = 'the harness that started it was closed'

export function createAgentCleanup(core: CoreApi, deps: AgentCleanupDeps = {}) {
  const now = deps.now ?? Date.now
  const log = deps.log ?? ((line: string) => console.log(line))
  const refresh = deps.refresh ?? (async () => {})
  const wait = deps.wait ?? ((ms: number) => new Promise<void>((done) => { setTimeout(done, ms).unref() }))
  const file = joinedPath(core.dataDir)
  const joined = readJoined(file)
  /** When one that would not close may be asked again. */
  const askAgainAt = new Map<string, number>()
  /** The ones whose close failed for more than their state, said once each. */
  const said = new Set<string>()
  /** The ones left open for their background commands, said once each. */
  const leftOpen = new Set<string>()
  /** When each run of a harness was first seen here: one seen since less than IDLE_CLOSE_MS is not closed, whatever
   *  its conversation says. A cleanup that just started has seen every run just now, so it closes nothing for its
   *  first half hour: not the harnesses the person typed into before it kept them (`joined`). */
  const seen = new Map<string, number>()
  /** The starters whose harnesses are being closed: two stops of one harness tell this twice. */
  const cascading = new Set<string>()
  const rpc = deps.tell ? null : createMessagesRpc()
  const ledger = new Ledger(ledgerPath(core.dataDir))
  const hachi = createHachiHandOver({
    ledger,
    self: () => core.daemon.machineId(),
    tell: deps.tell ?? ((machineId, payload) => rpc!({ port: core.daemon.port, dataDir: core.dataDir, machineId }, payload)),
    now, log,
    count: (metric) => core.count?.(metric),
  })
  let looking = false
  let stopped = false

  const save = (): void => {
    try {
      mkdirSync(dirname(file), { recursive: true })
      // Written whole and renamed: a crash mid-write leaves the last list, never half of one.
      writeFileSync(`${file}.tmp`, JSON.stringify({ version: 1, joined: Object.fromEntries(joined) }), { mode: 0o600 })
      renameSync(`${file}.tmp`, file)
    } catch (error) {
      log(`[agent-cleanup] could not keep which harnesses the person joined: ${reason(error)}`)
    }
  }

  /** Closes [s] as the core lets this, whatever background commands it runs once [pastCeiling]; a close done is said. */
  const close = async (s: RegisteredSession, mode: 'idle' | 'now', why: string, pastCeiling = false): Promise<AgentCloseResult> => {
    // The ceiling is passed only when reached, so a core from before it is asked as it always was.
    const closing = pastCeiling ? core.agents.closeStarted?.(s.agentId, mode, true) : core.agents.closeStarted?.(s.agentId, mode)
    const result: AgentCloseResult = await (closing ?? Promise.resolve({ error: 'UNSUPPORTED' }))
    const running = result.backgroundCommands ?? 0
    if (result.closed) log(`[agent-cleanup] closed ${label(s)}: ${why}${running > 0 ? `, with ${backgroundSaid(running)}` : ''}. Its conversation is kept.`)
    return result
  }
  const failed = (s: RegisteredSession, why: string, result: AgentCloseResult): void =>
    log(`[agent-cleanup] could not close ${label(s)} (${why}): ${result.detail ?? result.error}`)

  /** The harnesses [parentId] started here, closed now: told after it stopped. Tried again a moment later when one
   *  would not close, and said once the tries are spent. */
  const closeStartedBy = async (parentId: string): Promise<void> => {
    if (cascading.has(parentId)) return
    cascading.add(parentId)
    try { await closeOrphans(parentId) } finally { cascading.delete(parentId) }
  }
  const closeOrphans = async (parentId: string): Promise<void> => {
    for (let attempt = 1; ; attempt++) {
      await refresh()
      const live = core.agents.live()
      // Its starter is back (resumed while this notice was held, or between tries): its harnesses are its again.
      if (live.some((s) => s.agentId === parentId)) return
      // The Hachi harness: what it started is the person's now, never closed with it.
      await hachi.over(parentId)
      const orphans = live.filter((s) => s.parentAgentId === parentId && s.startedBy === 'agent' && !joined.has(s.agentId)
        && !hachi.handed(s.agentId))
      const left: Array<[RegisteredSession, AgentCloseResult]> = []
      // One at a time: each close saves a screen and stops a process, and a starter may have several.
      for (const s of orphans) {
        const result = await close(s, 'now', STARTER_CLOSED)
        if (!result.closed) left.push([s, result])
      }
      if (!left.length || stopped) return
      if (attempt >= CASCADE_TRIES) {
        for (const [s, result] of left) failed(s, STARTER_CLOSED, result)
        return
      }
      await wait(CASCADE_RETRY_MS)
    }
  }

  /** One look at the harnesses agents started: each quiet for IDLE_CLOSE_MS is closed if it is idle. */
  const look = async (): Promise<void> => {
    if (looking || stopped) return
    looking = true
    try {
      await refresh()
      const live = core.agents.live()
      const gone = (id: string) => !live.some((s) => s.agentId === id)
      for (const id of askAgainAt.keys()) if (gone(id)) askAgainAt.delete(id)
      for (const id of said) if (gone(id)) said.delete(id)
      for (const id of leftOpen) if (gone(id)) leftOpen.delete(id)
      const runs = new Set(live.map(incarnation))
      for (const run of seen.keys()) if (!runs.has(run)) seen.delete(run)
      for (const s of live) if (!seen.has(incarnation(s))) seen.set(incarnation(s), now())
      // A Hachi harness gone without a stop hands what it started to the person, as a stopped one does.
      const handing = hachi.look(live)
      if (handing) await handing
      for (const s of live) {
        if (stopped) return
        if (s.startedBy !== 'agent' || joined.has(s.agentId) || (askAgainAt.get(s.agentId) ?? 0) > now()
          || hachi.handed(s.agentId)) continue
        // Not before this run of it has been here that long; then by when its conversation last moved, its last answer
        // or later. Not known (an engine that keeps no dated transcript), it is left alone.
        const since = seen.get(incarnation(s))!
        if (now() - since < IDLE_CLOSE_MS) continue
        const last = await (core.agents.lastActivity?.(s.agentId) ?? Promise.resolve(null))
        if (last === null) continue
        const quiet = now() - Math.max(last, since)
        if (quiet < IDLE_CLOSE_MS) continue
        const why = `another agent started it, and it has sat idle ${Math.round(quiet / 60_000)} minutes`
        const result = await close(s, 'idle', why, quiet >= BACKGROUND_CLOSE_MS)
        if (result.closed) continue
        askAgainAt.set(s.agentId, now() + ASK_AGAIN_MS)
        const running = result.backgroundCommands ?? 0
        if (running > 0 && !leftOpen.has(s.agentId)) {
          leftOpen.add(s.agentId)
          log(`[agent-cleanup] left ${label(s)} open: ${backgroundSaid(running)}`)
        }
        // Working after all, or waiting for the person: asked again later, nothing to say. Anything else is said once.
        if (result.error !== 'SESSION_NOT_IDLE' && !said.has(s.agentId)) {
          said.add(s.agentId)
          failed(s, why, result)
        }
      }
    } finally {
      looking = false
    }
  }

  const every = deps.every ?? ((ms: number, run: () => void) => {
    const timer = setInterval(run, ms)
    timer.unref()
    return () => clearInterval(timer)
  })
  const unschedule = every(LOOK_EVERY_MS, () => {
    void look().catch((error: unknown) => log(`[agent-cleanup] a look failed: ${reason(error)}`))
  })

  const port: AgentCleanupPort = {
    closed: (agentId) => {
      void closeStartedBy(agentId).catch((error: unknown) => log(`[agent-cleanup] could not close what ${agentId.slice(0, 8)} started: ${reason(error)}`))
    },
    typed: (id) => {
      const s = core.agents.resolve(id)
      // The person's own harness has nothing to keep; one not known here is the core's word (it sends only these).
      if (s && s.startedBy !== 'agent') return
      const agentId = s?.agentId ?? id
      if (joined.has(agentId)) return
      joined.set(agentId, now())
      for (const oldest of joined.keys()) {
        if (joined.size <= JOINED_MAX) break
        joined.delete(oldest)
      }
      save()
    },
    forgetTold: async (agentId) => {
      try {
        new Ledger(ledgerPath(core.dataDir), deps.forgetLockWaitMs ?? FORGET_LOCK_WAIT_MS).forgetTold(agentId)
        return true
      } catch (error) {
        // Said here, where the reason is known: the delete is refused in the person's words (core/agents/lifecycle.ts).
        log(`[agent-cleanup] could not erase what ${agentId.slice(0, 8)} was told: ${reason(error)}`)
        return false
      }
    },
    stop: () => {
      stopped = true
      unschedule()
    },
  }
  return { port, look, closeStartedBy }
}

export function startAgentCleanup(core: CoreApi, ports: CorePorts): void {
  ports.agentCleanup = createAgentCleanup(core, {}).port
  // What the deleted Swarm left in the data folder goes as the edge host starts, out of the core's way (until 2027-01-14).
  // It never rejects: each name's failure is its own, said in the log.
  void removeSwarmLeftovers({ dataDir: core.dataDir, log: (line) => console.log(`[agent-cleanup] ${line}`) })
}
