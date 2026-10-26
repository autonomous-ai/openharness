/**
 * What a machine's Swarms want of its host, read as the host form (design 2026-10-26-swarm-state-parts section 4.10): for
 * each Swarm its roster rows, its pool of this machine and the assignments running here. It replaces the three rosters the
 * host, the machine pass and the GitHub tokens each read on their own, every one loading up to 100 whole Swarms every 1–5 s.
 * In between, only the Swarms with a change that matters to this machine come back; a full read at start and at least every
 * minute also catches a share or billing change, which lives outside the parts.
 */
import type { CoreApi } from '../core/api.js'
import type { HostChanges, HostTab } from './readContract.js'
import { backend, readable } from './wire.js'

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
    const full = this.cursor === null || this.now() - this.fullAt >= HOST_FULL_MS
    const startedAt = this.now()
    const path = `/api/super-tabs/hosts/${this.machineId}/changes?${full ? 'full=1' : `cursor=${this.cursor}`}`
    const answer = readable<HostChanges>(await this.backend(this.core, 'GET', path))
    const tabs = full ? new Map<string, HostTab>() : new Map(this.tabs)
    for (const tabId of answer.removedTabIds ?? []) tabs.delete(tabId)
    for (const tab of answer.tabs) tabs.set(tab.tabId, tab)
    this.tabs = tabs
    this.cursor = answer.cursor
    if (full) this.fullAt = startedAt
    this.readAt = this.now()
    return this.snapshot()
  }

  private snapshot(): HostRead {
    const tabs = [...this.tabs.values()]
    return { roster: tabs.flatMap(tab => tab.roster), pools: tabs.flatMap(tab => tab.pool ? [tab.pool] : []),
      assignments: tabs.flatMap(tab => tab.assignments) }
  }
}
