/**
 * A sliding-window rate limit with more than one window (6 a minute AND 60 an hour), per key. Used where a
 * daemon spends something on someone's say-so: a relayed key (another machine answers), a remote answer
 * (this machine answers for another), a talk (a model turn), the pair's own lines.
 */
export interface RateWindow { windowMs: number; max: number }

export class RateLimit {
  private readonly taken = new Map<string, number[]>()

  constructor(private readonly windows: readonly RateWindow[], private readonly now: () => number = Date.now) {}

  /** Take one for `key` if every window has room; false (and nothing taken) when one is full. */
  take(key = ''): boolean {
    const now = this.now()
    const longest = Math.max(...this.windows.map((w) => w.windowMs))
    const times = (this.taken.get(key) ?? []).filter((t) => now - t < longest)
    for (const w of this.windows) if (times.filter((t) => now - t < w.windowMs).length >= w.max) { this.taken.set(key, times); return false }
    times.push(now)
    this.taken.set(key, times)
    if (this.taken.size > 1_000) this.taken.delete(this.taken.keys().next().value as string)
    return true
  }

  /** How long until `key` may take one again, in ms (0 when it may now). */
  retryAfter(key = ''): number {
    const now = this.now()
    let wait = 0
    const times = this.taken.get(key) ?? []
    for (const w of this.windows) {
      const inside = times.filter((t) => now - t < w.windowMs)
      if (inside.length >= w.max) wait = Math.max(wait, inside[inside.length - w.max]! + w.windowMs - now)
    }
    return wait
  }
}
