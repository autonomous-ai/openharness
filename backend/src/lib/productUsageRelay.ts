import { randomUUID } from 'node:crypto'
import type { UsageIncrement } from './productUsageWrite.js'

interface Batch { id: string; increments: UsageIncrement[]; attempts: number }

/** Relay connects add to the same few daily totals, so one write per connect made the processes wait on one
 * another's rows (about 350 ms a write when they collided). Here a process counts in memory, keyed by day and
 * name only, and writes the sums once a minute.
 *
 * A batch has an id, and [write] must apply the batch and record that id together, doing nothing for an id it has
 * seen. A batch that fails is held and sent again under the same id, so one whose answer was lost counts once.
 * What a crash loses is what was counted since the last flush: under a minute. A clean stop flushes first.
 * Bounded: past [maxKeys] waiting totals it flushes at once; past twice that, while the database is down, it drops
 * new totals; a batch that failed [retries] times is dropped. Nothing here knows who connected. */
export function createRelayTotals({ write, retries = 5, maxKeys = 1024, intervalMs = 60_000, newId = randomUUID, warn = console.warn,
  firstDelayMs = Math.floor(intervalMs * (0.5 + Math.random() / 2)) }: {
  write: (id: string, increments: UsageIncrement[]) => Promise<void>
  retries?: number; maxKeys?: number; intervalMs?: number; newId?: () => string; warn?: (message: string) => void
  /** The first flush comes earlier by a different amount in each process, so they do not all write together. */
  firstDelayMs?: number
}) {
  let pending = new Map<string, UsageIncrement>()
  let failed: Batch | null = null
  let flushing: Promise<void> | null = null
  let warnedAt = 0
  const complain = (message: string) => {
    if (Date.now() - warnedAt < 60_000) return
    warnedAt = Date.now()
    warn(message)
  }

  async function run(): Promise<void> {
    if (failed) {
      const batch = failed
      try { await write(batch.id, batch.increments); failed = null } catch {
        if (++batch.attempts >= retries) { failed = null; complain('[product-usage] Some relay counts were dropped after repeated write failures.') }
        return
      }
    }
    if (!pending.size) return
    const batch: Batch = { id: newId(), increments: [...pending.values()], attempts: 1 }
    pending = new Map()
    try { await write(batch.id, batch.increments) } catch {
      failed = batch
      complain('[product-usage] Some relay counts are unavailable.')
    }
  }
  function flush(): Promise<void> {
    return flushing ??= run().finally(() => { flushing = null })
  }

  function add(dayUtc: Date, metric: string): void {
    const key = `${dayUtc.getTime()}|${metric}`
    const seen = pending.get(key)
    if (seen) { seen.value++; return }
    if (pending.size >= maxKeys * 2) return complain('[product-usage] Some relay counts were dropped: too many waiting.')
    pending.set(key, { dayUtc, metric, value: 1 })
    if (pending.size >= maxKeys) void flush()
  }

  /** Flushes every [intervalMs]. The returned stop ends the timer and flushes what is left. */
  function start(): () => Promise<void> {
    let timer: NodeJS.Timeout, stopped = false
    const tick = (delay: number) => {
      timer = setTimeout(() => { void flush().finally(() => { if (!stopped) tick(intervalMs) }) }, delay)
      timer.unref()
    }
    tick(firstDelayMs)
    return async () => {
      stopped = true
      clearTimeout(timer)
      // The second pass sends what arrived behind a held batch that the first one retried.
      await flush()
      await flush()
    }
  }

  const reset = () => { pending = new Map(); failed = null }
  return { add, flush, start, reset }
}
