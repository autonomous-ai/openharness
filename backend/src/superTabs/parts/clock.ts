/** Stamps `changedAt` on part writes: this process's wall clock, made strictly increasing (design section 3.3). Readers
 *  ask for changes after their cursor minus an overlap that covers drift between processes and the longest transaction. */
export function createClock(now: () => number = Date.now) {
  let last = 0
  return { next(): number { last = Math.max(now(), last + 1); return last } }
}

export const clock = createClock()
