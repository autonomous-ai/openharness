/**
 * What a machine's Swarms want of its host, read as the host form (design 2026-10-26-swarm-state-parts section 4.10): for
 * each Swarm its roster rows, its pool of this machine and the assignments running here. It replaces the three rosters the
 * host, the machine pass and the GitHub tokens each read on their own, every one loading up to 100 whole Swarms every 1–5 s.
 * In between, only the Swarms with a change that matters to this machine come back; a full read at start and at least every
 * minute also catches a share or billing change, which lives outside the parts.
 */
import type { CoreApi } from '../core/api.js'
import type { HostChanges, HostTab } from './readContract.js'
import { backend, object, readable } from './wire.js'

type Json = Record<string, unknown>
export interface HostRead { roster: Json[]; pools: Json[]; assignments: Json[] }

/** The bound on a roster that lags a revoked share (design section 8, Q2). */
export const HOST_FULL_MS = 60_000

export class HostFeed {
  private readonly now: () => number
  private readonly backend: typeof backend
  /** Each Swarm's rows as last returned, in the order the server first listed them. */
  private tabs = new Map<string, HostTab>()
  private cursor: string | null = null
  private fullAt = -Infinity
  private readAt = -Infinity
  private running: Promise<HostRead> | null = null

  constructor(private readonly core: CoreApi, readonly machineId: string, options: { now?: () => number; backend?: typeof backend } = {}) {
    this.now = options.now ?? Date.now
    this.backend = options.backend ?? backend
  }

  /** One read at a time: callers that ask while it runs get its answer. */
  refresh(): Promise<HostRead> {
    return this.running ??= this.read().finally(() => { this.running = null })
  }

  /** The last read while it is at most `maxAgeMs` old, else a new one: for readers off the host's own one-second tick. */
  current(maxAgeMs: number): Promise<HostRead> {
    if (!this.running && this.now() - this.readAt < maxAgeMs) return Promise.resolve(this.snapshot())
    return this.refresh()
  }

  private async read(): Promise<HostRead> {
    const askFull = this.cursor === null || this.now() - this.fullAt >= HOST_FULL_MS
    const startedAt = this.now()
    const form = `/api/super-tabs/hosts/${this.machineId}/changes`
    // The rows it holds, by their etag: a Swarm whose rows still match comes back with none, so an active Swarm no longer
    // costs its whole rows every second (the Lead's ruling on #1726). A host that holds nothing asks as before.
    const held = Object.fromEntries([...this.tabs].flatMap(([tabId, tab]) => typeof tab.etag === 'string' ? [[tabId, tab.etag]] : []))
    const answer = readable<HostChanges>(Object.keys(held).length
      ? await this.backend(this.core, 'POST', form, askFull ? { full: true, held } : { cursor: this.cursor, held })
      : await this.backend(this.core, 'GET', `${form}?${askFull ? 'full=1' : `cursor=${this.cursor}`}`))
    // The answer says what it is: the server answers a bad or too old cursor in full, with no removed Swarms (review round 1).
    const full = answer.full === true
    const tabs = full ? new Map<string, HostTab>() : new Map(this.tabs)
    for (const tabId of answer.removedTabIds ?? []) tabs.delete(tabId)
    for (const tab of answer.tabs) {
      if (!('unchanged' in tab)) { tabs.set(tab.tabId, tab); continue }
      // Unchanged keeps the rows held. One it does not hold (it never named it) is dropped, and comes back whole next time.
      const kept = this.tabs.get(tab.tabId)
      if (kept) tabs.set(tab.tabId, { ...kept, etag: tab.etag, lastChangedAt: tab.lastChangedAt })
      else tabs.delete(tab.tabId)
    }
    this.tabs = tabs
    this.cursor = answer.cursor
    if (full) this.fullAt = startedAt
    this.readAt = this.now()
    return this.snapshot()
  }

  /** Every Swarm's rows in one list each; a Swarm whose lists are not lists gives none, and never stops the others'. */
  private snapshot(): HostRead {
    const tabs = [...this.tabs.values()]
    const rows = (value: unknown) => Array.isArray(value) ? value.map(object) : []
    const isRecord = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
    return { roster: tabs.flatMap(tab => rows(tab.roster)), pools: tabs.flatMap(tab => isRecord(tab.pool) ? [tab.pool] : []),
      assignments: tabs.flatMap(tab => rows(tab.assignments)) }
  }
}
