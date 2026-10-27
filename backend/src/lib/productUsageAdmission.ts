/** Daily totals are shared rows. Admitting only a few of this process's report transactions at once keeps its
 * own uploads from piling onto them; their write conflicts are retried by the transaction. One at a time was
 * too few: a fleet's restart after each release filled the queue and refused reports with USAGE_BUSY.
 * Only measurement waits here: bounded RAM, two seconds of queueing, no product traffic. */
export function createUsageAdmission(maxQueued = 32, waitMs = 2000, concurrency = 4) {
  type Waiter = { ready: (release: () => void) => void; timer: ReturnType<typeof setTimeout> }
  const waiting = new Set<Waiter>()
  let running = 0
  const unavailable = () => Object.assign(new Error('Usage measurement busy'), { code: 'USAGE_BUSY' })
  function release(): void {
    const next = waiting.values().next().value
    if (!next) { running--; return }
    waiting.delete(next)
    clearTimeout(next.timer)
    next.ready(release)
  }
  function acquire(): Promise<() => void> {
    if (running < concurrency) { running++; return Promise.resolve(release) }
    if (waiting.size >= maxQueued) return Promise.reject(unavailable())
    return new Promise((ready, reject) => {
      const waiter: Waiter = { ready, timer: setTimeout(() => {
        waiting.delete(waiter)
        reject(unavailable())
      }, waitMs) }
      waiting.add(waiter)
    })
  }
  return async function write<T>(operation: () => Promise<T>): Promise<T> {
    const done = await acquire()
    try { return await operation() } finally { done() }
  }
}
