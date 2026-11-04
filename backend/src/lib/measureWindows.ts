/**
 * When the CPU and query accounting runs: one window of `forMs` every `everyMs`, the first at once. The accounting hooks
 * every callback and every query, and run all the time they cost ~12% of prod's CPU on their own (cpu profile, 2026-10-31:
 * async_hooks ~5%, queryStats ~4.6%, selfProfile ~3.5%). Load is steady, so one measured minute in ten tells the same.
 */
export const MEASURE_EVERY_MS = 10 * 60_000
export const MEASURE_FOR_MS = 60_000

export function measureWindows({ everyMs, forMs, open, close }: { everyMs: number; forMs: number; open: () => void; close: () => void }): () => void {
  let closing: NodeJS.Timeout | undefined, isOpen = false
  const start = () => {
    isOpen = true
    open()
    closing = setTimeout(() => { isOpen = false; close() }, forMs)
    closing.unref()
  }
  start()
  const cycle = setInterval(() => { if (!isOpen) start() }, everyMs)
  cycle.unref()
  return () => {
    clearInterval(cycle)
    clearTimeout(closing)
    if (isOpen) { isOpen = false; close() }
  }
}
