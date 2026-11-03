import type { Stamp, StampScope, SwarmStamps } from './cache.js'

/**
 * Redis's stamps (cache.ts redisStamps) in this process, for tests: one store of stamps that every "pod" shares, as they
 * share Redis. `down` makes every call fail, as an unreachable Redis does; `slowMs` makes reads answer late.
 */
export class MemoryStamps implements SwarmStamps {
  down = false
  slowMs = 0
  readonly bumps: Array<{ tabId: string; scopes: StampScope[] }> = []
  private readonly stamps = new Map<string, Stamp>()
  private readonly listeners = new Set<(tabId: string, scopes: readonly StampScope[]) => void>()

  async read(tabIds: readonly string[]): Promise<Map<string, Stamp>> {
    if (this.down) throw new Error('Redis is unreachable')
    if (this.slowMs) await new Promise(resolve => setTimeout(resolve, this.slowMs))
    return new Map(tabIds.map(id => [id, { ...this.stamps.get(id) ?? { main: 0, machine: 0 } }]))
  }

  async bump(tabId: string, scopes: readonly StampScope[]): Promise<void> {
    if (this.down) throw new Error('Redis is unreachable')
    const stamp = { ...this.stamps.get(tabId) ?? { main: 0, machine: 0 } }
    for (const scope of scopes) stamp[scope]++
    this.stamps.set(tabId, stamp)
    this.bumps.push({ tabId, scopes: [...scopes] })
    for (const listener of this.listeners) listener(tabId, scopes)
  }

  subscribe(listener: (tabId: string, scopes: readonly StampScope[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
