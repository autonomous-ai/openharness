import { ALL_HOSTS, type HostStamp, type Stamp, type StampScope, type SwarmStamps } from './cache.js'

/**
 * Redis's stamps (cache.ts redisStamps) in this process, for tests: one store of stamps that every "pod" shares, as they
 * share Redis. `down` makes every call fail, as an unreachable Redis does; `slowMs` makes reads answer late.
 */
export class MemoryStamps implements SwarmStamps {
  down = false
  slowMs = 0
  readonly bumps: Array<{ tabId: string; scopes: StampScope[] }> = []
  /** Each Swarm's fields, as Redis's hash holds them (cache.ts BUMP): `main`, `machine`, `hosted`, `uncovered`, `host:<id>`. */
  private readonly stamps = new Map<string, Map<string, number>>()
  private readonly listeners = new Set<(tabId: string, scopes: readonly StampScope[]) => void>()

  async read(tabIds: readonly string[]): Promise<Map<string, Stamp>> {
    await this.answer()
    return new Map(tabIds.map(id => [id, { main: this.field(id, 'main'), machine: this.field(id, 'machine') }]))
  }

  async readHost(tabId: string, machineId: string): Promise<HostStamp> {
    await this.answer()
    return { main: this.field(tabId, 'main'), hosted: this.field(tabId, 'hosted'), uncovered: this.field(tabId, 'uncovered'),
      host: this.field(tabId, `host:${machineId}`), all: this.field(tabId, `host:${ALL_HOSTS}`) }
  }

  /** As the BUMP script: an older release's bump found since is recorded as uncovered, then `hosted` follows `main`. */
  async bump(tabId: string, scopes: readonly StampScope[], hosts: readonly string[] = []): Promise<void> {
    if (this.down) throw new Error('Redis is unreachable')
    const fields = this.fields(tabId)
    if (this.field(tabId, 'main') !== this.field(tabId, 'hosted')) fields.set('uncovered', this.field(tabId, 'main'))
    for (const field of [...scopes, ...hosts.map(id => `host:${id}`)]) fields.set(field, this.field(tabId, field) + 1)
    fields.set('hosted', this.field(tabId, 'main'))
    this.told(tabId, scopes)
  }

  /** A bump by a server of the release before host stamps (task #3119): its scopes alone, as its own script moved them. */
  async bumpAsOlderRelease(tabId: string, scopes: readonly StampScope[]): Promise<void> {
    if (this.down) throw new Error('Redis is unreachable')
    for (const scope of scopes) this.fields(tabId).set(scope, this.field(tabId, scope) + 1)
    this.told(tabId, scopes)
  }

  private async answer(): Promise<void> {
    if (this.down) throw new Error('Redis is unreachable')
    if (this.slowMs) await new Promise(resolve => setTimeout(resolve, this.slowMs))
  }

  private fields(tabId: string): Map<string, number> {
    const fields = this.stamps.get(tabId) ?? new Map<string, number>()
    this.stamps.set(tabId, fields)
    return fields
  }

  private field(tabId: string, name: string): number {
    return this.stamps.get(tabId)?.get(name) ?? 0
  }

  private told(tabId: string, scopes: readonly StampScope[]): void {
    this.bumps.push({ tabId, scopes: [...scopes] })
    for (const listener of this.listeners) listener(tabId, scopes)
  }

  subscribe(listener: (tabId: string, scopes: readonly StampScope[]) => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
}
