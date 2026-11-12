/**
 * Hachi's side of the daemon (docs/design/2026-11-12-hachi.md, "How it learns about other harnesses" and "Turned off
 * while Hachi runs"). Between turns Hachi's CLI cannot listen, so this service follows the harnesses the Hachi harness
 * here started and wakes it, by a line in its mailbox (services/hachiWakes.ts, messages/service.ts `wake`), when one
 * needs the person, is done or stopped. By push, never by a look every few seconds: this machine's harnesses as a tool's
 * watch is told of them (core/toolWatches.ts), another machine's by its harness watch over the relay, a lease renewed
 * every four minutes (gateway/harnessWatch.ts). Names and states only, never a word a harness wrote.
 *
 * It is a client of its own daemon, as `harness` is: one line for Hachi itself (its turns, the person's or a wake's, are
 * counted apart), one for what it started here, one for each other machine it started something on. What to follow is
 * looked at again when the ledger changes (a start, a close, a hand-over), when the switch changes, and once a minute,
 * which also renews the watches and finds a line that dropped. While Hachi is off, or no Hachi runs here, it holds no
 * line and asks nothing.
 *
 * Turned off while Hachi runs, it drops what waits to wake it and closes the Hachi harness with its conversation kept, as
 * `harness close --now` does; what Hachi started is then the person's (services/hachiHandOver.ts).
 */
import { hostname } from 'node:os'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { openDaemon, type Daemon, type PushedEvent } from '../agentClient/daemon.js'
import { Ledger, ledgerPath, type Started } from '../agentClient/ledger.js'
import type { CoreApi, ServiceRequests } from '../core/api.js'
import { HACHI_ID } from '../dsh/builtinIds.js'
import { agentSettingsPath, readAgentSettings } from '../lib/agentSettings.js'
import type { RegisteredSession } from '../lib/registry.js'
import { watchSettingFile } from '../messages/settingWatch.js'
import { createHachiWakes, type HeardState, type WakeChild } from './hachiWakes.js'

/** How often what to follow is looked at again, and how soon a line that dropped is opened again. */
export const FOLLOW_EVERY_MS = 60_000
/** Another machine's watch is a five-minute lease, renewed at four (gateway/harnessWatch.ts). */
export const RENEW_MS = 4 * 60_000
/** As many harnesses as one watch names: what one agent may run at once (agentClient/commands.ts `SPAWN_LIMITS`). */
const WATCH_MAX = 8
/** Harnesses started longer ago than this are no longer followed, as `harness watch --mine` follows none. */
const FOLLOWED_WITHIN_MS = 7 * 24 * 60 * 60_000

export interface HachiDeps {
  now(): number
  log(line: string): void
  /** A line to this daemon, reaching [machineId]. */
  open(machineId: string): Promise<Daemon>
  later(ms: number, run: () => void): () => void
  every(ms: number, run: () => void): () => void
  watchFile(path: string, changed: () => void): () => void
  /** Before each look: a service in its own process asks the core for the live agents then (services/hachiProcess.ts). */
  refresh(): Promise<void>
}

/** A line and what it follows: the ids it named, and when another machine's lease is due again. */
interface Following { line: Daemon; ids: string; renewAt: number }

/** What a pushed event says a harness is doing, from the closed list; null for what changes nothing. */
function stateOf(event: PushedEvent): HeardState | null {
  const state = event.payload.state
  switch (event.type) {
    case 'harness_event': return typeof state === 'string' && ['working', 'idle', 'needs_person', 'stopped', 'gone', 'unknown'].includes(state) ? state as HeardState : null
    case 'agent_activity': return state === 'working' || state === 'idle' ? state : null
    case 'turn_ended': return 'idle'
    case 'commander_question': return 'needs_person'
    // Answered: back at work, until it says otherwise.
    case 'commander_question_close': return 'working'
    case 'agent_deleted': return 'gone'
    default: return null
  }
}

/** This machine's name as Harness shows it (`machine-name`), and the others' as this machine last listed them. */
function machineNames(dataDir: string): (machineId: string, self: string) => string {
  let own = ''
  try { own = readFileSync(join(dataDir, 'machine-name'), 'utf8').trim() } catch { /* the host's name below */ }
  const names = new Map<string, string>()
  try {
    const kept = JSON.parse(readFileSync(join(dataDir, 'machines.json'), 'utf8')) as { machines?: Array<{ machineId?: unknown; name?: unknown }> }
    for (const m of kept.machines ?? []) if (typeof m.machineId === 'string' && typeof m.name === 'string') names.set(m.machineId, m.name)
  } catch { /* named by its id's start */ }
  return (machineId, self) => (machineId === self ? own || hostname().replace(/\.local$/, '') : names.get(machineId) ?? machineId.slice(0, 8))
}

/** In the core's process (`HARNESSD_SERVICES=none`): the same service, which the apps ask nothing, on the core itself.
 *  It lives as long as the core's process. */
export function startHachiInCore(core: CoreApi): ServiceRequests {
  startHachi(core)
  return {}
}

export function startHachi(core: CoreApi, given: Partial<HachiDeps> = {}): { stop(): void } {
  const deps: HachiDeps = {
    now: Date.now,
    log: (line) => console.log(line),
    open: (machineId) => openDaemon({ port: core.daemon.port, dataDir: core.dataDir, machineId: core.daemon.machineId() }, machineId),
    later: (ms, run) => { const timer = setTimeout(run, ms); timer.unref(); return () => clearTimeout(timer) },
    every: (ms, run) => { const timer = setInterval(run, ms); timer.unref(); return () => clearInterval(timer) },
    watchFile: watchSettingFile,
    refresh: async () => {},
    ...given,
  }
  const ledger = new Ledger(ledgerPath(core.dataDir))
  /** Each line by what it follows: `self` (Hachi), `here`, or another machine's id. */
  const following = new Map<string, Following>()
  /** The harness each followed id is, as the wakes name it. */
  const children = new Map<string, WakeChild & { machineId: string; agentId: string }>()
  let hachi: RegisteredSession | null = null
  let on = false
  let stopped = false

  const wakes = createHachiWakes({
    now: deps.now, later: deps.later, log: deps.log,
    count: (metric) => core.count?.(metric),
    closedByHachi: (child) => {
      const c = children.get(child.key)
      return !!c && !!hachi && ledger.closedBy({ machineId: core.daemon.machineId(), agentId: hachi.agentId }, c) !== null
    },
    send: async (items) => {
      const self = following.get('self')
      if (!self || !hachi) return false
      const reply = await self.line.request('agent_messages', { action: 'wake', agentId: hachi.agentId, items })
      if (reply.error) deps.log(`[hachi] the wake was not taken: ${String(reply.error)}`)
      return !reply.error
    },
  })

  const unfollow = (key: string): void => {
    following.get(key)?.line.close()
    following.delete(key)
  }
  const teardown = (): void => { for (const key of [...following.keys()]) unfollow(key) }

  /** What Hachi's own line hears: its turns' ends, counted as the person's or a wake's. */
  const heardHachi = (_agentId: string, event: PushedEvent): void => {
    if (event.type === 'turn_ended') core.count?.(event.payload.subagent === true ? 'hachi_turns_wake' : 'hachi_turns_person')
  }
  const heardChild = (machineId: string) => (agentId: string, event: PushedEvent): void => {
    const child = children.get(`${machineId}/${agentId}`)
    const state = stateOf(event)
    if (child && state) wakes.heard(child, state)
  }

  /** Follows [ids] over the line [key], to [machineId]: asked again when they changed, a lease when it is due, and a
   *  watch here at every look, which also finds a line that dropped. */
  const follow = async (key: string, machineId: string, ids: string[], heard: (agentId: string, event: PushedEvent) => void): Promise<void> => {
    if (!ids.length) { unfollow(key); return }
    const named = ids.join(',')
    let current = following.get(key)
    const away = machineId !== core.daemon.machineId()
    if (away && current && current.ids === named && deps.now() < current.renewAt) return
    try {
      if (!current) {
        current = { line: await deps.open(machineId), ids: '', renewAt: 0 }
        following.set(key, current)
      }
      if (away) {
        const answer = await current.line.harnessWatch!(ids, heard)
        if (answer.error) throw new Error(String(answer.error))
        for (const each of Array.isArray(answer.agents) ? answer.agents as Array<{ agentId?: unknown; state?: unknown }> : []) {
          if (typeof each.agentId === 'string') heard(each.agentId, { type: 'harness_event', payload: { agentId: each.agentId, state: each.state } })
        }
      } else if (!await current.line.watch!(ids, heard)) throw new Error('this daemon does not push to tools')
      current.ids = named
      current.renewAt = deps.now() + RENEW_MS
    } catch (error) {
      deps.log(`[hachi] could not follow ${ids.length} harness${ids.length === 1 ? '' : 'es'} on ${names(machineId, core.daemon.machineId())}: ${error instanceof Error ? error.message : String(error)}`)
      unfollow(key)
    }
  }
  let names = machineNames(core.dataDir)

  /** Turned off while Hachi runs: nothing more wakes it, and it is closed, its conversation kept. */
  const off = async (): Promise<void> => {
    wakes.drop()
    teardown()
    const running = core.agents.live().find((s) => s.dsh === HACHI_ID && s.active)
    hachi = null
    if (!running) return
    let line: Daemon | null = null
    try {
      line = await deps.open(core.daemon.machineId())
      const reply = await line.request('agent_close', { agentId: running.agentId, sessionId: running.sessionId ?? '',
        createdAt: new Date(running.registeredAt).toISOString(), mode: 'now' })
      if (reply.error) throw new Error(String(reply.error))
      deps.log('[hachi] Hachi is off: closed Hachi, its conversation kept.')
    } catch (error) {
      deps.log(`[hachi] Hachi is off, but Hachi could not be closed: ${error instanceof Error ? error.message : String(error)}`)
    } finally { line?.close() }
  }

  const look = async (): Promise<void> => {
    await deps.refresh()
    const was = on
    on = readAgentSettings(core.dataDir).hachi
    if (!on) { if (was) await off(); else teardown(); return }
    hachi = core.agents.live().find((s) => s.dsh === HACHI_ID && s.active) ?? null
    if (!hachi) { teardown(); return }
    names = machineNames(core.dataDir)
    const self = core.daemon.machineId()
    const rows = ledger.childrenOf({ machineId: self, agentId: hachi.agentId }).filter((r) => deps.now() - r.at <= FOLLOWED_WITHIN_MS)
    const live = new Set(core.agents.live().map((s) => s.agentId))
    const byMachine = new Map<string, Started[]>()
    for (const r of rows) {
      if (r.child.machineId === self && !live.has(r.child.agentId)) continue
      byMachine.set(r.child.machineId, [...(byMachine.get(r.child.machineId) ?? []), r])
    }
    children.clear()
    for (const [machineId, started] of byMachine) {
      for (const r of started.slice(-WATCH_MAX)) {
        children.set(`${machineId}/${r.child.agentId}`, { key: `${machineId}/${r.child.agentId}`, name: r.child.name || r.child.agentId.slice(0, 8),
          machine: names(machineId, self), machineId, agentId: r.child.agentId })
      }
    }
    await follow('self', self, [hachi.agentId], heardHachi)
    for (const key of [...following.keys()]) if (key !== 'self' && key !== 'here' && !byMachine.has(key)) unfollow(key)
    if (!byMachine.has(self)) unfollow('here')
    for (const [machineId, started] of byMachine) {
      const ids = started.slice(-WATCH_MAX).map((r) => r.child.agentId)
      await follow(machineId === self ? 'here' : machineId, machineId, ids, heardChild(machineId))
    }
  }

  /** One look at a time; one asked for meanwhile runs once after it. */
  let looking: Promise<void> | null = null
  let again = false
  const request = (): void => {
    if (stopped) return
    if (looking) { again = true; return }
    looking = (async () => {
      do {
        again = false
        try { await look() } catch (error) { deps.log(`[hachi] a look failed: ${error instanceof Error ? error.message : String(error)}`) }
      } while (again && !stopped)
    })().finally(() => { looking = null })
  }

  const unwatch = [
    deps.watchFile(agentSettingsPath(core.dataDir), request),
    deps.watchFile(ledgerPath(core.dataDir), request),
    deps.every(FOLLOW_EVERY_MS, request),
  ]
  request()
  return {
    stop: () => {
      stopped = true
      for (const end of unwatch) end()
      wakes.stop()
      teardown()
    },
  }
}
