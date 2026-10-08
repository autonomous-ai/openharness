/**
 * Harness agents waiting for the Store (docs/design/2026-10-08-launch-port.md, (L3)). A restore that could not ask
 * the Store to prepare a harness agent's runtime never launches it without the harness: the row keeps its launch
 * failed with the reason (`DSH_UNAVAILABLE`, shown on its tile), and no pane. Discovery keeps such a row rather than
 * retiring it (core/agents/discovery.ts). Once the Store says it is ready, every agent still waiting is restored, in
 * one pass of the restore the boot ran (lib/restoreAgents.ts); a person's restart of one restores it the same way.
 * An agent the person stopped or closed meanwhile is no longer a waiting row, and is left alone.
 *
 * Every pass goes through one queue, after the boot's: two passes over the same agent would open two panes.
 */
import { sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import type { RestoreSummary } from '../../lib/restoreAgents.js'

export const AWAITING_STORE = 'DSH_UNAVAILABLE'

/** How long the boot waits for the Store before it restores: the bundled harnesses are put in place first. */
export const STORE_BOOT_WAIT_MS = 5_000
/** How long, when harness agents are to be restored: each one's restore asks the Store, and one restored without it
 *  waits for it instead of coming back now. */
export const STORE_RESTORE_WAIT_MS = 30_000

/** Whether a row is a harness agent a restore left waiting for the Store. */
export function awaitsStore(row: Pick<RegisteredSession, 'launch'> | undefined): boolean {
  return row?.launch?.state === 'failed' && row.launch.error === AWAITING_STORE
}

export interface StoreWaitsDeps {
  registry: Pick<typeof registry, 'list' | 'byAgent'>
  /** The restore the boot ran, of exactly these agents. */
  restore: (only: ReadonlySet<string>) => Promise<RestoreSummary>
  log: (line: string) => void
}

export type WaitingRestart =
  | { ok: true; session: RegisteredSession; resumed: boolean }
  | { ok: false; error: string; detail?: string }

export function createStoreWaits({ registry, restore, log }: StoreWaitsDeps) {
  // Nothing is restored before the boot's own pass has run: a row waiting since the last daemon is the boot's to
  // restore first, with everything that pass sets up before it.
  let opened!: () => void
  let queue: Promise<unknown> = new Promise<void>((done) => { opened = done })
  /** One pass at a time, in the order asked: a pass that fails does not stop the next. */
  const serial = <T>(run: () => Promise<T>): Promise<T> => {
    const next = queue.then(run)
    queue = next.catch(() => {})
    return next
  }

  /** The agents still waiting, restored now: once the Store says it is ready. */
  const restoreWaiting = (): Promise<RestoreSummary | null> => serial(async () => {
    const waiting = new Set(registry.list().filter(awaitsStore).map((row) => row.agentId))
    if (!waiting.size) return null
    const summary = await restore(waiting)
    log(`[restore] the Store is ready · restored ${summary.restored.length} of ${waiting.size} harness agents waiting for it`)
    return summary
  })

  /** A person's restart of an agent waiting for the Store: restored as the boot would, or why not. Null for an
   *  agent that is not waiting, which a restart handles as it always has. */
  const restartWaiting = (agentId: string): Promise<WaitingRestart> | null => {
    if (!awaitsStore(registry.byAgent(agentId))) return null
    return serial(async () => {
      // Asked again inside the queue: a pass before this one may have restored it already.
      if (!awaitsStore(registry.byAgent(agentId))) {
        const now = registry.byAgent(agentId)
        return now ? { ok: true, session: now, resumed: !!now.sessionId } : { ok: false, error: 'AGENT_NOT_FOUND' }
      }
      const summary = await restore(new Set([agentId]))
      const now = registry.byAgent(agentId)
      if (now && summary.restored.includes(agentId)) {
        log(`[restart] ${sid(agentId)} restored · the Store prepared its harness`)
        return { ok: true, session: now, resumed: !!now.sessionId }
      }
      const launch = now?.launch
      return launch?.state === 'failed'
        ? { ok: false, error: launch.error, ...(launch.detail ? { detail: launch.detail } : {}) }
        : { ok: false, error: 'RESTART_FAILED', detail: summary.failed.find((row) => row.agentId === agentId)?.reason ?? 'The harness could not be restored.' }
    })
  }

  return {
    /** The boot's restore, before any later pass: they wait for it, whether it restores, fails or has nothing to do. */
    boot: async <T>(run: () => Promise<T>): Promise<T> => {
      try { return await run() } finally { opened() }
    },
    restoreWaiting,
    restartWaiting,
    awaits: (agentId: string): boolean => awaitsStore(registry.byAgent(agentId)),
  }
}
