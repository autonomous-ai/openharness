/**
 * Agents held until the service their launch asks is ready (docs/design/2026-10-08-launch-port.md, "Held").
 *
 * A launch that asks a service for its part (a grid's or a saved API's, from models) is never waited on before the
 * core is ready: the boot's restore holds the agent in a pane that says what it waits for (lib/restoreAgents.ts
 * `defer`), and the pass here launches it into that pane once the core is up. A service that cannot be asked then
 * keeps it held, and the rest of that pass after it unasked. Held is never failed and never retired: discovery sees
 * its pane alive, and every later pass tries again. A pass runs:
 *
 * - once the core is ready, for every held agent;
 * - each time a service connects (a restarted one too), for the agents held for it;
 * - when a person restarts a held agent, for that one.
 *
 * One pass at a time, in order, each after the boot's: two passes over one agent would launch it twice. An agent
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
  restore: (only: ReadonlySet<string>) => Promise<RestoreSummary>
  log: (line: string) => void
}

export type HeldRestart =
  | { ok: true; session: RegisteredSession; resumed: boolean }
  | { ok: false; error: string; detail?: string }

export function createHeldLaunches({ registry, restore, log }: HeldLaunchesDeps) {
  // Closed until the boot's restore has run: an agent held since the last daemon is that pass's to look at first.
  let opened!: () => void
  let queue: Promise<unknown> = new Promise<void>((done) => { opened = done })
  /** One pass at a time, in the order asked: a pass that fails does not stop the next. */
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run)
    queue = next.catch(() => {})
    return next
  }

  let retryTimer: ReturnType<typeof setTimeout> | undefined
  const retryContention = (summary: RestoreSummary): void => {
    if (!summary.retry || retryTimer) return
    retryTimer = setTimeout(() => {
      retryTimer = undefined
      void restoreHeld().catch(error => log(`[restore] core contention retry failed: ${String(error)}`))
    }, 500)
    retryTimer.unref?.()
  }

  /** The agents held (for `service`, or for any), launched now. */
  const restoreHeld = (service?: string): Promise<RestoreSummary | null> => serial(async () => {
    const held = new Set(registry.list().filter((row) => {
      const holder = heldFor(row)
      return holder !== null && (service === undefined || holder === service)
    }).map((row) => row.agentId))
    if (!held.size) return null
    const summary = await restore(held)
    retryContention(summary)
    log(`[restore] held · ${service ?? 'every service'} · launched ${summary.restored.length} of ${held.size}`
      + (summary.held.length ? ` · ${summary.held.length} still waiting` : ''))
    return summary
  })

  /** A person's restart of a held agent: launched as a pass would, or why not. Null for an agent that is not held,
   *  which a restart handles as it always has. */
  const restartHeld = (agentId: string): Promise<HeldRestart> | null => {
    if (!heldFor(registry.byAgent(agentId))) return null
    return serial(async () => {
      // Asked again in turn: a pass before this one may have launched it, or the person closed it.
      const before = registry.byAgent(agentId)
      if (!before) return { ok: false, error: 'AGENT_NOT_FOUND' }
      if (!heldFor(before)) return { ok: true, session: before, resumed: !!before.sessionId }
      const summary = await restore(new Set([agentId]))
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
    boot: async <T>(run: () => Promise<T>): Promise<T> => {
      try { return await run() } finally { opened() }
    },
    restoreHeld,
    restartHeld,
  }
}

/**
 * What a held agent's pane runs while it waits: the reason, and nothing to type into. It survives the interrupt a
 * person might send it, and the agent's launch takes the pane over (`respawn`) once the service is ready.
 */
export function heldPaneArgv(detail: string, token?: string): string[] {
  return ['/bin/sh', '-c', 'trap "" INT QUIT TSTP; printf "%s\\n" "$1"; while :; do sleep 3600; done', 'harness-held', detail, ...(token ? [token] : [])]
}
