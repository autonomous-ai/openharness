/**
 * What a machine's Swarms want of its host, read as the host form (design 2026-10-26-swarm-state-parts section 4.10): for
 * each Swarm its roster rows, its pool of this machine and the assignments running here. It replaces the three rosters the
 * host, the machine pass and the GitHub tokens each read on their own, every one loading up to 100 whole Swarms every 1–5 s.
 * In between, only the Swarms with a change that matters to this machine come back; a full read at start and at least every
 * minute also catches a share or billing change, which lives outside the parts.
 */
import type { BackendNotice, CoreApi } from '../core/api.js'
import type { HostChanges, HostChangesRequest, HostTabRows } from './readContract.js'
import { backend, object, readable } from './wire.js'

type Json = Record<string, unknown>
export interface HostRead { roster: Json[]; pools: Json[]; assignments: Json[] }

/** The bound on a roster that lags a revoked share (design section 8, Q2), and on one that missed a push. */
export const HOST_FULL_MS = 60_000
/** WS roadmap Phase 2a: a server that pushes (backend lib/swarmHostPushes.ts) says so every 4 minutes. Without that word for
 *  this long (an older server, a rollback, Redis down) the host reads each second again. */
export const HOST_PUSH_LEASE_MS = 5 * 60_000
/** Told many times in a second, by a busy Swarm, the host still reads at most once a second, as it did before pushes. */
export const HOST_PUSH_GAP_MS = 1_000

/** The server's word over the daemon socket: a Swarm to read, or, naming none, that it pushes. */
type HostNotice = Extract<BackendNotice, { type: 'swarm_host_changed' }>

export class HostFeed {
  private readonly now: () => number
  private readonly backend: typeof backend
  /** Each Swarm's rows as last returned, in the order the server first listed them. */
  private tabs = new Map<string, HostTabRows>()
  private cursor: string | null = null
  private fullAt = -Infinity
  private readAt = -Infinity
  private running: Promise<HostRead> | null = null
  /** Until when the server is known to push (HOST_PUSH_LEASE_MS); a new feed, as after a reconnect, starts without it. */
  private pushUntil = -Infinity
  /** Told of a change since the last read began. */
  private told = false

  constructor(private readonly core: CoreApi, readonly machineId: string, options: { now?: () => number; backend?: typeof backend } = {}) {
    this.now = options.now ?? Date.now
    this.backend = options.backend ?? backend
  }

  /** One read at a time: callers that ask while it runs get its answer. */
  refresh(): Promise<HostRead> {
    return this.running ??= this.read().finally(() => { this.running = null })
  }

  /** A read sent after this call. One already out may have been sent before what the caller must see, such as a takeover
   *  before a resume's answer (cli limitResume.ts, #1757 re-check), so it is waited out, never joined. */
  async fresh(): Promise<HostRead> {
    await this.running?.catch(() => {})
    return this.refresh()
  }

  /** Whether the server pushes: its last word that it does is under HOST_PUSH_LEASE_MS old. */
  get pushing(): boolean { return this.now() < this.pushUntil }

  /** The server said a Swarm of this machine changed, or (naming none) that it pushes: the next due read reads. */
  heard(notice: HostNotice): void {
    if (typeof notice.tabId !== 'string') this.pushUntil = this.now() + HOST_PUSH_LEASE_MS
    this.told = true
  }

  /** The host's one-second tick: a read each second, unless the server pushes; then one when told, at most once a second,
   *  and the full read a minute after the last, the safety net for a push lost on the way. */
  due(): Promise<HostRead> {
    if (!this.pushing || this.running || this.cursor === null) return this.refresh()
    const now = this.now()
    if ((this.told && now - this.readAt >= HOST_PUSH_GAP_MS) || now - this.fullAt >= HOST_FULL_MS) return this.refresh()
    return Promise.resolve(this.snapshot())
  }

  /** The last read while it is at most `maxAgeMs` old, else a new one: for readers off the host's own one-second tick. While
   *  the server pushes, the last read stands until told or until the minute's full read is due. */
  current(maxAgeMs: number): Promise<HostRead> {
    const now = this.now()
    const fresh = this.pushing ? this.cursor !== null && !this.told && now - this.fullAt < HOST_FULL_MS : now - this.readAt < maxAgeMs
    if (!this.running && fresh) return Promise.resolve(this.snapshot())
    return this.refresh()
  }

  private async read(): Promise<HostRead> {
    // Taken as the read starts: a push heard while it is out may name a change it missed, so the next one reads again.
    const told = this.told
    this.told = false
    try { return await this.ask() } catch (error) { this.told ||= told; throw error }
  }

  private async ask(): Promise<HostRead> {
    const askFull = this.cursor === null || this.now() - this.fullAt >= HOST_FULL_MS
    const startedAt = this.now()
    const form = `/api/super-tabs/hosts/${this.machineId}/changes`
    // The rows it holds, by their etag: a Swarm whose rows still match comes back with none, so an active Swarm no longer
    // costs its whole rows every second (the Lead's ruling on #1726). A host that holds nothing asks as before.
    const held = Object.fromEntries([...this.tabs].flatMap(([tabId, tab]) => typeof tab.etag === 'string' ? [[tabId, tab.etag]] : []))
    const answer = readable<HostChanges>(Object.keys(held).length
      ? await this.backend(this.core, 'POST', form, (askFull ? { full: true, held } : { cursor: this.cursor!, held }) satisfies HostChangesRequest)
      : await this.backend(this.core, 'GET', `${form}?${askFull ? 'full=1' : `cursor=${this.cursor}`}`))
    // The answer says what it is: the server answers a bad or too old cursor in full, with no removed Swarms (review round 1).
    const full = answer.full === true
    const tabs = full ? new Map<string, HostTabRows>() : new Map(this.tabs)
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
