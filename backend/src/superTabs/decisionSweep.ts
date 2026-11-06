import { logger } from '../utils/logger.js'

/** Decision deadlines must not wait behind hourly maintenance. The singleton worker owns this timer and its cleanup. */
export function startDecisionSweep(apply: (now: number) => Promise<unknown>, everyMs = 60_000): () => void {
  let running = false, stopped = false
  const run = async () => {
    if (running || stopped) return
    running = true
    try {
      await apply(Date.now())
    } catch {
      // Errors may contain option text or database details. Say what remains waiting without logging their content.
      logger.error('[swarm-decisions] default pass failed; unanswered decisions remain waiting and retry next minute')
    } finally {
      running = false
    }
  }
  void run()
  const timer = setInterval(() => { void run() }, everyMs)
  timer.unref()
  return () => { stopped = true; clearInterval(timer) }
}
