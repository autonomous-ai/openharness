/**
 * Agents held until the service their launch asks is ready (docs/design/2026-10-08-launch-port.md, "Held").
 *
 * A launch that asks a service for its part (a grid's or a saved API's, from models) is never waited on before the
 * core is ready: the boot's restore holds the agent in a pane that says what it waits for (lib/restoreAgents.ts
 * `defer`), and the pass here launches it into that pane once the core is up. A service that cannot be asked then
 * keeps it held while sibling agents continue. Held is never failed and never retired: discovery sees
 * its pane alive, and every later pass tries again. A pass runs:
 *
 * - once the core is ready, for every held agent;
 * - each time a service connects (a restarted one too), for the agents held for it;
 * - when a person restarts a held agent, for that one.
 *
 * A separate flight for each agent, after the boot: two passes never dispatch the same agent twice. An agent
 * the person stopped or closed meanwhile is no longer held, and is left alone.
 */
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import type { RestoreSummary } from '../../lib/restoreAgents.js'

/** The service a row is held for, or null. */
export function heldFor(row: Pick<RegisteredSession, 'launch'> | undefined): string | null {
  return row?.launch?.state === 'held' ? row.launch.service : null
}

export interface HeldLaunchesDeps {
  registry: Pick<typeof registry, 'list' | 'byAgent'>
  /** The boot's restore, of exactly these agents, outside the registry's transaction (lib/restoreAgents.ts `only`). */
  restore: (only: ReadonlySet<string>, current: () => boolean) => Promise<RestoreSummary>
  log: (line: string) => void
}

export type HeldRestart =
  | { ok: true; session: RegisteredSession; resumed: boolean }
  | { ok: false; error: string; detail?: string }

export function createHeldLaunches({ registry, restore, log }: HeldLaunchesDeps) {
  let opened!: () => void
  const ready = new Promise<void>(done => { opened = done })
  let closed = false
  // Closing revokes preparations already waiting on hooks or a service, too.
  const current = () => !closed
  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const active = new Map<string, Promise<RestoreSummary>>()
  let nextAgent = 0
  const empty = (): RestoreSummary => ({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] })
  const retryContention = (summary: RestoreSummary): void => {
    if (closed || retryTimer || (!summary.retry && !summary.held.length)) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void restoreHeld(undefined, false).catch(error => {
        log(`[restore] core contention retry failed: ${String(error)}`)
        retryContention({ ...empty(), retry: true })
      })
    }, summary.retry ? 500 : 2_000)
    retryTimer.unref?.()
  }
  // One flight per agent, four across the core. A stalled native home or service
  // cannot serialize every sibling behind it. Additional callers join the same
  // observation; a later timer retries failures with fresh registry ownership.
  const restoreOne = (agentId: string): Promise<RestoreSummary> => {
    const existing = active.get(agentId)
    if (existing) return existing
    if (closed || !heldFor(registry.byAgent(agentId))) return Promise.resolve(empty())
    if (active.size >= 4) {
      const summary: RestoreSummary = { ...empty(), held: [agentId], retry: true }
      retryContention(summary)
      return Promise.resolve(summary)
    }
    const flight = Promise.resolve().then(() => closed ? empty() : restore(new Set([agentId]), current)).then(summary => {
      active.delete(agentId)
      retryContention(summary)
      return summary
    }, error => {
      active.delete(agentId)
      retryContention({ ...empty(), retry: true })
      throw error
    })
    active.set(agentId, flight)
    return flight
  }
  const restoreHeld = async (service?: string, joinRunning = true): Promise<RestoreSummary | null> => {
    await ready
    if (closed) return null
    const held = registry.list().filter(row => {
      const holder = heldFor(row)
      return holder !== null && (service === undefined || holder === service) && (joinRunning || !active.has(row.agentId))
    }).map(row => row.agentId)
    if (!held.length) return null
    const offset = nextAgent % held.length
    const ordered = [...held.slice(offset), ...held.slice(0, offset)]
    nextAgent = (offset + 4) % held.length
    const summary = empty()
    const outcomes = await Promise.allSettled(ordered.map(restoreOne))
    let failure: unknown, rejected = false
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') { failure = outcome.reason; rejected = true; summary.retry = true; continue }
      const result = outcome.value
      for (const key of ['restored', 'skipped', 'failed', 'held', 'unsurveyed'] as const) (summary[key] as unknown[]).push(...result[key])
      if (result.retry) summary.retry = true
    }
    retryContention(summary)
    if (rejected) throw failure
    log(`[restore] held · ${service ?? 'every service'} · launched ${summary.restored.length} of ${held.length}`
      + (summary.held.length ? ` · ${summary.held.length} still waiting` : ''))
    return summary
  }

  /** A person's restart of a held agent: launched as a pass would, or why not. Null for an agent that is not held,
   *  which a restart handles as it always has. */
  const restartHeld = (agentId: string): Promise<HeldRestart> | null => {
    if (!heldFor(registry.byAgent(agentId))) return null
    return ready.then(async () => {
      // Asked again in turn: a pass before this one may have launched it, or the person closed it.
      const before = registry.byAgent(agentId)
      if (!before || closed) return { ok: false, error: 'AGENT_NOT_FOUND' }
      if (!heldFor(before)) return { ok: true, session: before, resumed: !!before.sessionId }
      const summary = await restoreOne(agentId)
      retryContention(summary)
      const now = registry.byAgent(agentId)
      if (!now) return { ok: false, error: 'AGENT_NOT_FOUND' }
      if (summary.restored.includes(agentId)) {
        log(`[restart] ${sid(agentId)} launched from held`)
        return { ok: true, session: now, resumed: !!now.sessionId }
      }
      const launch = now.launch
      if (launch?.state === 'held') return { ok: false, error: 'SERVICE_UNAVAILABLE', detail: launch.detail }
      if (launch?.state === 'failed') return { ok: false, error: launch.error, ...(launch.detail ? { detail: launch.detail } : {}) }
      return { ok: false, error: 'RESTART_FAILED', detail: summary.failed.find((row) => row.agentId === agentId)?.reason ?? 'The harness could not be launched.' }
    })
  }

  return {
    /** The boot's restore, before any pass here: they wait for it, whether it restores, fails or has nothing to do. */
    boot: async <T>(run: (current: () => boolean) => Promise<T>): Promise<T> => {
      try { return await run(current) } finally { opened() }
    },
    restoreHeld,
    restartHeld,
    close: () => { closed = true; clearTimeout(retryTimer); opened() },
  }
}

/**
 * What a held agent's pane runs while it waits: the reason, and nothing to type into. It survives the interrupt a
 * person might send it, and the agent's launch takes the pane over (`respawn`) once the service is ready.
 */
export function heldPaneArgv(detail: string, token?: string): string[] {
  return ['/bin/sh', '-c', 'trap "" INT QUIT TSTP; printf "%s\\n" "$1"; while :; do sleep 3600; done', 'harness-held', detail, ...(token ? [token] : [])]
}
