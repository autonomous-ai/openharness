/** Daily totals are shared rows. Every report a transaction of its own made each process's reports conflict with
 * one another on them: on 2026-10-28, 1,000 of the CLI's 1,269 rejected reports were write conflicts, and 64 reports
 * at once (a fleet after a release) refused 28. Here a process writes its reports one batch at a time: whatever
 * arrives while a batch commits goes together in the next, so its own reports never conflict, and the processes'
 * batches, a few at once, rarely do. Only measurement waits here: bounded RAM, two seconds of queueing, no product
 * traffic. A full queue or a long wait answers USAGE_BUSY, which the routes send back with a Retry-After. */
export function createUsageBatch<T, R>(commit: (items: T[]) => Promise<R[]>,
  { maxQueued = 2048, maxBatch = 256, waitMs = 2000 }: { maxQueued?: number; maxBatch?: number; waitMs?: number } = {}) {
  type Entry = { item: T; at: number; resolve: (result: R) => void; reject: (error: unknown) => void }
  const queue: Entry[] = []
  let running = false
  const busy = () => Object.assign(new Error('Usage measurement busy'), { code: 'USAGE_BUSY' })
  async function drain(): Promise<void> {
    running = true
    try {
      while (queue.length) {
        const batch: Entry[] = []
        for (const entry of queue.splice(0, maxBatch)) {
          if (Date.now() - entry.at > waitMs) entry.reject(busy())
          else batch.push(entry)
        }
        if (!batch.length) continue
        try {
          const results = await commit(batch.map(entry => entry.item))
          batch.forEach((entry, i) => entry.resolve(results[i]))
        } catch (error) {
          for (const entry of batch) entry.reject(error)
        }
      }
    } finally { running = false }
  }
  return (item: T): Promise<R> => {
    if (queue.length >= maxQueued) return Promise.reject(busy())
    return new Promise<R>((resolve, reject) => {
      queue.push({ item, at: Date.now(), resolve, reject })
      if (!running) void drain()
    })
  }
}
