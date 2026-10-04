/**
 * agy only: close a turn whose final `Stop` never came.
 *
 * agy reports `fullyIdle: false` when it pauses for sub-agents, and normally sends one more Stop with
 * `fullyIdle: true` once they report — measured, and that is the path a healthy turn takes. But one
 * measured run completed its sub-agents, wrote its summary, and sent nothing further; the turn stayed
 * open with no recap. The pane is the only other place the answer exists (`? for shortcuts` idle vs
 * `esc to cancel` busy), so a waiting Stop arms a bounded poll of it.
 *
 * Bounded on purpose: it stops after AGY_IDLE_WATCH_MAX checks (~10 min) rather than polling a pane
 * forever, and any real Stop clears it first.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 9: docs/design/2026-10-03-harnessd.md).
 */
import type { AgyNormalizer } from '../../engines/agy/normalizer.js'
import { agyPaneIdle } from '../../engines/agy/runtimeProfile.js'
import { sid } from '../../lib/log.js'
import type { LiveEvent } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'

export interface AgyBackstopDeps {
  agyNormalizers: Map<string, AgyNormalizer>
  bySession: (sessionId: string) => RegisteredSession | undefined
  captureTerminal: (target: string, historyLines?: number) => Promise<string | null>
  /** Read what the transcript has that the tail has not delivered yet (Watcher.pollSession). */
  drain: (sessionId: string) => Promise<void>
  emit: (sessionId: string, events: LiveEvent[]) => void
}

export function createAgyBackstop({ agyNormalizers, bySession, captureTerminal, drain, emit }: AgyBackstopDeps) {
  const AGY_IDLE_WATCH_MS = 15_000
  const AGY_IDLE_WATCH_MAX = 40
  const agyIdleWatch = new Map<string, { timer: NodeJS.Timeout; checks: number }>()

  const clearAgyIdleWatch = (sessionId: string): void => {
    const watch = agyIdleWatch.get(sessionId)
    if (!watch) return
    clearTimeout(watch.timer)
    agyIdleWatch.delete(sessionId)
  }

  const armAgyIdleWatch = (sessionId: string): void => {
    const checks = agyIdleWatch.get(sessionId)?.checks ?? 0
    clearAgyIdleWatch(sessionId)
    if (checks >= AGY_IDLE_WATCH_MAX) return
    const timer = setTimeout(() => {
      void (async () => {
        agyIdleWatch.delete(sessionId)
        const normalizer = agyNormalizers.get(sessionId)
        if (!normalizer?.turnOpen) return
        const entry = bySession(sessionId)
        if (!entry) return
        const capture = await captureTerminal(entry.agentId, 60)
        if (!capture || !agyPaneIdle(capture)) { armAgyIdleWatch(sessionId); return }
        await drain(sessionId)
        if (!normalizer.turnOpen) return
        console.log(`[turn] ${sid(sessionId)} closed by the agy idle backstop · no final Stop arrived`)
        emit(sessionId, normalizer.closeTurn())
      })().catch((err) => {
        console.error('[agy] idle backstop failed:', err instanceof Error ? err.message : err)
      })
    }, AGY_IDLE_WATCH_MS)
    timer.unref?.()
    agyIdleWatch.set(sessionId, { timer, checks: checks + 1 })
  }
  return { clearAgyIdleWatch, armAgyIdleWatch }
}
