/** Daily totals are shared rows. Serializing this process's report transactions avoids
 * making its own uploads fight over them. Other processes still use transaction retries.
 * Only measurement waits here: bounded RAM, two seconds of queueing, no product traffic. */
export function createUsageAdmission(maxQueued = 32, waitMs = 2000) {
  type Waiter = { ready: (release: () => void) => void; timer: ReturnType<typeof setTimeout> }
  const waiting = new Set<Waiter>()
  let busy = false
  const unavailable = () => Object.assign(new Error('Usage measurement busy'), { code: 'USAGE_BUSY' })
  function release(): void {
    const next = waiting.values().next().value
    if (!next) { busy = false; return }
    waiting.delete(next)
    clearTimeout(next.timer)
    next.ready(release)
  }
  function acquire(): Promise<() => void> {
    if (!busy) { busy = true; return Promise.resolve(release) }
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
