/**
 * Picks of the crew dispatch whose work.assign was refused for a reason their round will not change (store.ts dispatchCrew,
 * task #3400): neither a pass nor the sweep's check sends one again until it expires (review 1 of #3230). Per process, in
 * memory, never stored. Its lifecycle (review 2 of #3230): an entry goes at its expiry, on the next prune (every pass), whether
 * or not its task is looked at again; at most `limit` are held, the oldest forgotten first.
 */
export class RefusalMemory {
  private readonly until = new Map<string, number>()
  constructor(private readonly limit: number) {}

  get size(): number { return this.until.size }

  /** Remembers [key] until [expiresAt]; at the limit, forgets the oldest entry first. */
  remember(key: string, expiresAt: number): void {
    this.until.delete(key)
    while (this.until.size >= this.limit) this.until.delete(this.until.keys().next().value!)
    this.until.set(key, expiresAt)
  }

  /** Whether [key] is remembered at [now]. */
  refused(key: string, now: number): boolean {
    const until = this.until.get(key)
    return until !== undefined && until > now
  }

  /** Forgets every entry expired at [now]. */
  prune(now: number): void {
    for (const [key, until] of this.until) if (until <= now) this.until.delete(key)
  }
}
