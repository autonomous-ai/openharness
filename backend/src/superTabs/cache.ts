/**
 * What each backend process keeps of the Swarms it read, by stamp (Stability Roadmap 2.2; Design in
 * docs/design/2026-10-28-swarm-read-cache.md). Every commit that changes a Swarm's parts bumps its stamp in Redis after it
 * commits; a read takes the stamp before it loads, and serves what it holds at that stamp without asking Mongo. A
 * machine's own reading moves only the machine stamp, so a report every 15 s leaves the rest of the Swarm cached.
 *
 * What is held is the stored state, for every reader alike: each read applies its reader's permissions after the cache
 * (read/views.ts readerView), and what is held is frozen so no reader can change what the next one reads.
 */

import type { Prisma, PrismaClient } from '@prisma/client'
import { logger } from '../utils/logger.js'
import { cacheDigest, differingKeys, type PatchRule } from './cachePatch.js'
import { recordCache, type ReloadReason } from './cacheStats.js'
import type { PartKind } from './parts/types.js'
import type { SwarmDelta } from './parts/load.js'
import { OVERLAP_MS } from './read/cursor.js'

/** The stamps of one Swarm. A stamp only grows; one that never moved is 0. */
export interface Stamp { main: number; machine: number }
/** `main`: any change of a Swarm's parts. `machine`: a change of a machine part's own reading only. */
export type StampScope = keyof Stamp

/**
 * What one machine's reports skip the Swarm's load by (store.ts fastReading, task #3119): `host` moves with every change that
 * concerns that machine's host (parts/write.ts writeHosts), `all` with every change that concerns all of them. A server of
 * the release before moves `main` alone: `hosted` is the `main` the latest bump that knew host stamps left, and `uncovered`
 * the `main` of the latest bump that did not, as the next one that knew found it.
 */
export interface HostStamp { main: number; hosted: number; uncovered: number; host: number; all: number }
/** The host field that every host reads (writeHosts' `all`). */
export const ALL_HOSTS = '*'

/** Where every process reads and bumps the stamps: Redis in production (redisStamps). */
export interface SwarmStamps {
  read(tabIds: readonly string[]): Promise<Map<string, Stamp>>
  /** Moves [scopes], and the host stamps of [hosts] (machine ids, or ALL_HOSTS). */
  bump(tabId: string, scopes: readonly StampScope[], hosts?: readonly string[]): Promise<void>
  readHost(tabId: string, machineId: string): Promise<HostStamp>
  /** Called back when any process bumps a Swarm, so this one frees what it holds of it early. */
  subscribe(listener: (tabId: string, scopes: readonly StampScope[]) => void): () => void
}

interface Entry {
  tabId: string
  stamp: Stamp
  scope: StampScope | 'all'
  /** When the stamps it is current at were read, before its load or patch: the next patch reads changes from here, less
   *  OVERLAP_MS (the longest transaction plus clock drift between processes, as change cursors use it). */
  at: number
  /** When it was last loaded in full: past deltaMaxAgeMs it is loaded in full again, whatever patches it took. */
  fullAt: number
  bytes: number
  value: unknown
  /** Its Swarm moved: kept only to be patched by the next read. */
  stale: boolean
  patch?: PatchRule<unknown>
}

export interface CacheOptions {
  /** What the held values may take, counted as their JSON size. */
  maxBytes?: number
  /** A safety net: an entry is read again after this long whatever its stamp (a bump lost to a crash after commit). */
  maxAgeMs?: number
  /** A read that cannot learn the stamps in this time reads Mongo itself. */
  stampTimeoutMs?: number
  now?: () => number
  /** The parts of a Swarm changed since a time (parts/load.ts loadDelta). With it, a bump marks entries with a patch rule
   *  stale and the next read patches them; without it (SWARM_CACHE_DELTA=off) a bump drops them, as before. */
  delta?: (tabId: string, since: number, kinds: readonly PartKind[]) => Promise<SwarmDelta>
  /** An entry is loaded in full again at least this often: the net for anything a delta cannot see. */
  deltaMaxAgeMs?: number
  /** A delta larger than this is applied by loading in full, which then costs about as much. */
  deltaMaxParts?: number
  /** The share of patches checked against a full load in the background (SWARM_CACHE_VERIFY_RATE): the drift alarm. */
  verifyRate?: number
  random?: () => number
}

export const CACHE_MAX_BYTES = 64 * 1024 * 1024
export const CACHE_MAX_AGE_MS = 60_000
export const STAMP_TIMEOUT_MS = 200
export const DELTA_MAX_AGE_MS = 600_000
export const DELTA_MAX_PARTS = 500
/** An entry not refreshed for this long loads in full rather than stretch its Swarm's delta back to its last read: one
 *  forgotten entry made every delta of its Swarm read an hour of changes (final review, Important 2). Twice the age at which
 *  a read refreshes an entry, so one read every minute keeps it patched. */
export const DELTA_MAX_GAP_MS = 120_000
/** Another entry joins an entry's delta only when it was refreshed at most this long before it: entries read at the same
 *  stamps share one delta, and Desktop's background cadence (15 s) still joins. An entry nobody read since (a first load's
 *  dormant selections, one window's conversation) is refreshed by its own delta when it is read: joined, it moved every delta
 *  of its Swarm back to its time, so each machine reading read ~190 whole conversations again on the bench (#2783). */
export const DELTA_JOIN_MS = 15_000

/** One delta read: the stamps it was read at, the kinds it holds, from when, and when it started. */
interface Delta { stamp: string; kinds: ReadonlySet<PartKind>; since: number; at: number; read: Promise<SwarmDelta> }

const key = (tabId: string, name: string) => `${tabId}\u0000${name}`

/** Each frozen object's size, so a value held again (a patch keeps the parts that did not change) is never walked twice:
 *  the walk of every load was 4.4% of the event loop, 12.4 M calls in the 2026-11-02 profiles (spec Part 3). */
const sizes = new WeakMap<object, number>()

/** Freezes a loaded value all through and tells its size as JSON, in one pass; an object frozen here before is not walked. */
export function freeze(value: unknown): number {
  if (value === null || value === undefined) return 4
  switch (typeof value) {
    case 'string': return value.length + 2
    case 'number': case 'boolean': case 'bigint': return 8
    case 'object': {
      if (value instanceof Date) return 26
      const known = sizes.get(value)
      if (known !== undefined) return known
      let bytes = 2
      if (Array.isArray(value)) for (const item of value) bytes += freeze(item) + 1
      else for (const [name, item] of Object.entries(value)) bytes += name.length + 4 + freeze(item)
      Object.freeze(value)
      sizes.set(value, bytes)
      return bytes
    }
    default: return 8
  }
}

/** A value's size as `freeze` tells it: remembered for one already frozen, else frozen now. */
export const sizeOf = (value: unknown): number => freeze(value)

export class SwarmCache {
  private readonly entries = new Map<string, Entry>()
  /** Each Swarm's entry names, so a bump touches only that Swarm's entries, not every Swarm's. */
  private readonly bySwarm = new Map<string, Set<string>>()
  private readonly loading = new Map<string, Promise<unknown>>()
  /** Each Swarm's latest delta read: every entry of the Swarm patched at its stamps shares it, while and after it runs. An
   *  entry whose rule reads alone keeps its own, by Swarm and kinds (deltaFor). */
  private readonly deltas = new Map<string, Delta>()
  /** The names in `deltas` of each Swarm's alone entries' deltas, so a bump forgets them with the Swarm's. */
  private readonly deltaNames = new Map<string, Set<string>>()
  private bytes = 0
  private readonly maxBytes: number
  private readonly maxAgeMs: number
  private readonly stampTimeoutMs: number
  private readonly now: () => number
  private readonly delta: CacheOptions['delta']
  private readonly deltaMaxAgeMs: number
  private readonly deltaMaxParts: number
  private readonly verifyRate: number
  private readonly random: () => number
  private verifying = false

  constructor(private readonly stamps: SwarmStamps, options: CacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? CACHE_MAX_BYTES
    this.maxAgeMs = options.maxAgeMs ?? CACHE_MAX_AGE_MS
    this.stampTimeoutMs = options.stampTimeoutMs ?? STAMP_TIMEOUT_MS
    this.now = options.now ?? Date.now
    this.delta = options.delta
    this.deltaMaxAgeMs = options.deltaMaxAgeMs ?? DELTA_MAX_AGE_MS
    this.deltaMaxParts = options.deltaMaxParts ?? DELTA_MAX_PARTS
    this.verifyRate = options.verifyRate ?? 0
    this.random = options.random ?? Math.random
    stamps.subscribe((tabId, scopes) => this.drop(tabId, scopes))
  }

  get size() { return { entries: this.entries.size, bytes: this.bytes } }

  /** Whether a bump patches what is held (a delta reader is configured) rather than dropping it. */
  get patching(): boolean { return !!this.delta }

  /** One read's view of these Swarms: their stamps, read once, before anything is loaded. */
  async at(tabIds: readonly string[]): Promise<CacheView> {
    const at = this.now()
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.stampTimeoutMs) })
    try {
      return new CacheView(this, await Promise.race([this.stamps.read(tabIds), late]), at)
    } catch {
      return new CacheView(this, null, at)
    } finally {
      clearTimeout(timer)
    }
  }

  /** What these stamps' moves make stale of a Swarm, everything by default: an entry with a patch rule is kept to be patched,
   *  any other is forgotten. The Swarm's latest delta predates the change, so no entry refreshes from it; a bump owed by this
   *  process leaves the stamps as they were, where an entry older than that delta would otherwise reuse it. */
  drop(tabId: string, scopes: readonly StampScope[] = ['main']): void {
    this.dropDeltas(tabId)
    const main = scopes.includes('main')
    for (const name of [...this.bySwarm.get(tabId) ?? []]) {
      const entry = this.entries.get(name)!
      if (!main && entry.scope === 'main') continue
      if (entry.patch && this.delta) entry.stale = true
      else this.drop1(name)
    }
  }

  /** @internal CacheView's get: held, patched, or loaded and held. */
  async get<T>(tabId: string, name: string, scope: StampScope | 'all', stamp: Stamp, at: number, load: () => Promise<T>,
    patch?: PatchRule<T>): Promise<T> {
    const k = key(tabId, name), entry = this.entries.get(k)
    if (!entry) return this.load(tabId, name, scope, stamp, at, load, patch, 'cold')
    const current = entry.stamp.main === stamp.main && (entry.scope === 'main' || entry.stamp.machine === stamp.machine)
    if (current && !entry.stale && this.now() - entry.at < this.maxAgeMs) {
      // Most recently used last.
      this.entries.delete(k)
      this.entries.set(k, entry)
      recordCache(name, 'hit')
      return entry.value as T
    }
    if (!entry.patch || !this.delta) {
      this.drop1(k)
      return this.load(tabId, name, scope, stamp, at, load, patch, 'off')
    }
    if (this.now() - entry.fullAt >= this.deltaMaxAgeMs) return this.load(tabId, name, scope, stamp, at, load, patch, 'age')
    return this.patched(tabId, name, scope, stamp, entry, load, entry.patch as PatchRule<T>)
  }

  /** One load for every reader that misses the same entry at the same stamp. */
  private async load<T>(tabId: string, name: string, scope: StampScope | 'all', stamp: Stamp, at: number, load: () => Promise<T>,
    patch: PatchRule<T> | undefined, reason: ReloadReason): Promise<T> {
    const flight = this.flight(tabId, name, scope, stamp)
    const running = this.loading.get(flight) as Promise<T> | undefined
    if (running) return running
    const loaded = load().then(value => {
      const bytes = this.keep(tabId, name, { tabId, stamp, scope, at, fullAt: at, bytes: 0, value, stale: false, patch: patch as PatchRule<unknown> | undefined })
      recordCache(name, 'full', { bytes, reason })
      return value
    }).finally(() => this.loading.delete(flight))
    this.loading.set(flight, loaded)
    return loaded
  }

  /** The held entry with its Swarm's changes since it was read applied, or loaded in full when they cannot be. */
  private async patched<T>(tabId: string, name: string, scope: StampScope | 'all', stamp: Stamp, entry: Entry, load: () => Promise<T>,
    patch: PatchRule<T>): Promise<T> {
    const flight = this.flight(tabId, name, scope, stamp)
    const running = this.loading.get(flight) as Promise<T> | undefined
    if (running) return running
    const reload = (reason: ReloadReason) => { this.loading.delete(flight); return this.load(tabId, name, scope, stamp, this.now(), load, patch, reason) }
    const patching = (async (): Promise<T> => {
      if (this.now() - entry.at > DELTA_MAX_GAP_MS) return reload('age')
      let read: Delta
      try { read = this.deltaFor(tabId, stamp, patch.kinds, entry) } catch { return reload('error') }
      let delta: SwarmDelta
      try { delta = await read.read } catch { return reload('error') }
      // A delta started for other entries may lack this one's kinds, or begin after this entry's changes did.
      if (!patch.kinds.every(kind => read.kinds.has(kind)) || entry.at - OVERLAP_MS < read.since) return reload('since')
      if (delta.parts.length > this.deltaMaxParts) return reload('parts')
      const next = patch.apply(entry.value as T, delta)
      if (next === 'reload') return reload('epoch')
      this.keep(tabId, name, { tabId, stamp, scope, at: read.at, fullAt: entry.fullAt, bytes: 0, value: next, stale: false, patch: patch as PatchRule<unknown> })
      recordCache(name, 'patch', { parts: delta.parts.length, bytes: sizeOf(delta.parts) })
      this.verify(tabId, name, scope, stamp, load, next, patch)
      return next
    })()
    this.loading.set(flight, patching)
    return patching.finally(() => { if (this.loading.get(flight) === patching) this.loading.delete(flight) })
  }

  /** Whether an entry must be refreshed before it serves a read at these stamps. */
  private due(entry: Entry, stamp: Stamp, now: number): boolean {
    const current = entry.stamp.main === stamp.main && (entry.scope === 'main' || entry.stamp.machine === stamp.machine)
    return entry.stale || !current || now - entry.at >= this.maxAgeMs
  }

  /**
   * This Swarm's changes at these stamps, read once for every entry patched from them (the spec's one delta per Swarm and
   * stamp: one read per kind was up to five reads of the same window per bump, final review Important 3): over the kinds
   * of every entry of the Swarm due for a refresh, from the earliest of their reads, less OVERLAP_MS. An entry refreshed
   * too long ago (DELTA_MAX_GAP_MS) is left out: it loads in full when read. So is one refreshed more than DELTA_JOIN_MS
   * before this entry: it reads its own delta when it is read.
   *
   * The stamps can stand still while the Swarm changes (a bump lost, or owed by this process), so a delta is shared only with
   * an entry read before it started: an older one could miss a change the entry's refresh exists to find, or bring back a
   * part the entry was loaded without.
   */
  private deltaFor(tabId: string, stamp: Stamp, kinds: readonly PartKind[], entry: Entry): Delta {
    const stamped = `${stamp.main}\u0000${stamp.machine}`
    // An entry whose rule reads alone shares a delta only with entries of its own kinds, kept under their own name.
    const alone = !!entry.patch?.alone
    const name = alone ? `${tabId}\u0000${[...kinds].sort().join(',')}` : tabId
    const latest = this.deltas.get(name)
    if (latest && latest.stamp === stamped && kinds.every(kind => latest.kinds.has(kind)) && latest.at > entry.at && entry.at - OVERLAP_MS >= latest.since) return latest
    const now = this.now(), union = new Set(kinds)
    let earliest = entry.at
    for (const held of this.bySwarm.get(tabId) ?? []) {
      const other = this.entries.get(held)!
      if (other === entry || !other.patch || !!other.patch.alone !== alone || (alone && other.patch.kinds.join() !== entry.patch!.kinds.join())
        || now - other.at > DELTA_MAX_GAP_MS || now - other.fullAt >= this.deltaMaxAgeMs || !this.due(other, stamp, now)
        || other.at < entry.at - DELTA_JOIN_MS) continue
      for (const kind of other.patch.kinds) union.add(kind)
      earliest = Math.min(earliest, other.at)
    }
    const since = earliest - OVERLAP_MS
    const started: Delta = { stamp: stamped, kinds: union, since, at: now, read: this.delta!(tabId, since, [...union]) }
    this.deltas.set(name, started)
    this.deltaNames.set(tabId, (this.deltaNames.get(tabId) ?? new Set<string>()).add(name))
    // A failed read is not kept for the next entry to reuse.
    started.read.catch(() => { if (this.deltas.get(name) === started) this.deltas.delete(name) })
    return started
  }

  /** Forgets every delta read of this Swarm, its alone entries' too. */
  private dropDeltas(tabId: string): void {
    this.deltas.delete(tabId)
    for (const name of this.deltaNames.get(tabId) ?? []) this.deltas.delete(name)
    this.deltaNames.delete(tabId)
  }

  /**
   * Now and then, in the background, a patched value is compared with a full load at the same stamps: one at a time per
   * process, off the request path. A stamp that moved meanwhile makes the check say nothing. A difference drops the entry,
   * and is logged with the part keys that differ, never their data.
   */
  private verify<T>(tabId: string, name: string, scope: StampScope | 'all', stamp: Stamp, load: () => Promise<T>, patched: T,
    patch: PatchRule<T>): void {
    if (this.verifying || !(this.random() < this.verifyRate)) return
    this.verifying = true
    const unmoved = (now: Stamp | undefined) => !!now && now.main === stamp.main && (scope === 'main' || now.machine === stamp.machine)
    void (async () => {
      const before = (await this.stamps.read([tabId])).get(tabId)
      const fresh = await load()
      const after = (await this.stamps.read([tabId])).get(tabId)
      if (!unmoved(before) || !unmoved(after)) return
      recordCache(name, 'verify')
      const [mine, theirs] = patch.comparable ? patch.comparable(patched, fresh) : [patched, fresh]
      if (cacheDigest(mine) === cacheDigest(theirs)) return
      const k = key(tabId, name)
      if (this.entries.get(k)?.value === patched) this.drop1(k)
      recordCache(name, 'mismatch')
      logger.warn('swarm cache verify mismatch', { entry: name.split(':', 1)[0], tabId, kinds: [...patch.kinds], keys: differingKeys(mine, theirs) })
    })().catch(() => { /* A check that cannot run says nothing; the 10-minute full load stays the net. */ })
      .finally(() => { this.verifying = false })
  }

  private flight(tabId: string, name: string, scope: StampScope | 'all', stamp: Stamp): string {
    return `${key(tabId, name)}\u0000${stamp.main}\u0000${scope === 'main' ? '' : stamp.machine}`
  }

  /** Holds `entry` (frozen) in place of what was held under its name, within the byte budget: stale entries go first, then
   *  the least recently used. Returns its size. */
  private keep(tabId: string, name: string, entry: Entry): number {
    const bytes = freeze(entry.value)
    if (bytes > this.maxBytes) { this.drop1(key(tabId, name)); return bytes }
    const k = key(tabId, name)
    this.drop1(k)
    this.entries.set(k, { ...entry, bytes })
    this.bytes += bytes
    const names = this.bySwarm.get(tabId) ?? new Set<string>()
    this.bySwarm.set(tabId, names.add(k))
    for (const [held, each] of this.entries) {
      if (this.bytes <= this.maxBytes) break
      if (each.stale) this.drop1(held)
    }
    for (const oldest of this.entries.keys()) {
      if (this.bytes <= this.maxBytes) break
      this.drop1(oldest)
    }
    return bytes
  }

  private drop1(name: string) {
    const entry = this.entries.get(name)
    if (!entry) return
    this.entries.delete(name)
    this.bytes -= entry.bytes
    const names = this.bySwarm.get(entry.tabId)!
    names.delete(name)
    if (!names.size) {
      this.bySwarm.delete(entry.tabId)
      this.dropDeltas(entry.tabId)
    }
  }
}

/** One read's stamps. Without them (Redis unreachable or late) every get reads Mongo, and nothing is kept. */
export class CacheView {
  /** `at`: when the stamps were read, before anything was loaded (SwarmCache.at). */
  constructor(private readonly cache: SwarmCache | null, private readonly stamps: Map<string, Stamp> | null, readonly at = Date.now()) {}

  get available(): boolean { return this.stamps !== null }

  /** Whether entries are patched from deltas (cache.ts SwarmCache.patching): only then is a value built from the held base
   *  cheaper than its own load, since a base dropped on every bump would load in full each time. */
  get patching(): boolean { return this.stamps !== null && !!this.cache?.patching }

  /** This Swarm's main stamp as the view read it, or none without stamps or a cache. */
  mainStamp(tabId: string): number | undefined {
    return this.cache ? this.stamps?.get(tabId)?.main : undefined
  }

  /** The value `load` gives for this Swarm at the view's stamp: held, patched by `patch` from what was held, or loaded and
   *  held. `scope` says which stamps it depends on: 'main' for what a machine's reading never changes, 'all' for anything
   *  holding machine parts. */
  async get<T>(tabId: string, name: string, scope: StampScope | 'all', load: () => Promise<T>, patch?: PatchRule<T>): Promise<T> {
    const stamp = this.stamps?.get(tabId)
    if (!stamp || !this.cache) return load()
    return this.cache.get(tabId, name, scope, stamp, this.at, load, patch)
  }
}

/** A stamp kept this long after its Swarm's last change; a Swarm read after that reads 0, then starts again from the time. */
export const STAMP_TTL_MS = 30 * 86_400_000
const stampKey = (tabId: string) => `swarm:stamp:${tabId}`
/**
 * Moves each named stamp to Redis's clock in microseconds, or one past its value if that is higher, so a stamp only grows
 * and no bump hands out a stamp already handed out: a process serves what it holds at an unchanged stamp (SwarmCache), and a
 * delivery poll skips its revocation check while the main stamp holds (store.ts deliveries). No two bumps run in one
 * microsecond (Redis runs one script at a time, each longer than that), so every stamp is its bump's time and none runs
 * ahead of the clock. When Redis loses the key (a restart, the expiry), the next bump starts above every stamp handed out.
 * When it comes back with an older value (a snapshot, a lagging replica), reads see that older stamp again until the next
 * bump of each scope moves it above them all; held entries live at most CACHE_MAX_AGE_MS meanwhile. In milliseconds, a
 * burst of bumps ran ahead of the clock and a loss within that millisecond handed a stamp out again (review of #2456). A first bump starts the stamps it does not name one
 * below the clock, every host's stamp too, so a machine report's record from before a lost key never holds again (review
 * of #3119). Stamps are compared only for equality: the jump from older millisecond stamps is one more change.
 */
const BUMP = `local t = redis.call('time')
local now = tonumber(t[1]) * 1000000 + tonumber(t[2])
if redis.call('exists', KEYS[1]) == 0 then
  local first = string.format('%.0f', now - 1)
  redis.call('hset', KEYS[1], 'main', first, 'machine', first, 'hosted', first, 'host:*', first)
end
local main = redis.call('hget', KEYS[1], 'main')
if main ~= redis.call('hget', KEYS[1], 'hosted') then redis.call('hset', KEYS[1], 'uncovered', main) end
for i = 2, #ARGV do
  local next = tonumber(redis.call('hget', KEYS[1], ARGV[i]) or 0) + 1
  redis.call('hset', KEYS[1], ARGV[i], string.format('%.0f', math.max(next, now)))
end
redis.call('hset', KEYS[1], 'hosted', redis.call('hget', KEYS[1], 'main'))
redis.call('pexpire', KEYS[1], ARGV[1])
return 1`
/** A host's field in its Swarm's stamp hash. */
const hostField = (machineId: string) => `host:${machineId}`

/** What redisStamps needs of an ioredis connection that is not in subscribe mode (lib/bus.ts `pub`). */
export interface StampRedis {
  eval(script: string, keys: number, ...args: Array<string | number>): Promise<unknown>
  hmget(key: string, ...fields: string[]): Promise<Array<string | null>>
  pipeline(): { hmget(key: string, ...fields: string[]): unknown; exec(): Promise<Array<[Error | null, unknown]> | null> }
}
/** The bus's broadcast of bumps (lib/bus.ts publishSwarmStamp, subscribeSwarmStamps). */
export interface StampBus {
  publish(tabId: string, scopes: readonly StampScope[]): Promise<unknown>
  subscribe(listener: (tabId: string, scopes: readonly StampScope[]) => void): () => void
}

const stampOf = (fields: Array<string | null>): Stamp => ({ main: Number(fields[0] ?? 0), machine: Number(fields[1] ?? 0) })

export function redisStamps(redis: StampRedis, bus: StampBus): SwarmStamps {
  return {
    async read(tabIds) {
      if (tabIds.length === 1) return new Map([[tabIds[0]!, stampOf(await redis.hmget(stampKey(tabIds[0]!), 'main', 'machine'))]])
      const pipeline = redis.pipeline()
      for (const id of tabIds) pipeline.hmget(stampKey(id), 'main', 'machine')
      const replies = await pipeline.exec() ?? []
      return new Map(tabIds.map((id, i) => {
        const [error, fields] = replies[i] ?? [new Error('No reply')]
        if (error) throw error
        return [id, stampOf(fields as Array<string | null>)]
      }))
    },
    async bump(tabId, scopes, hosts = []) {
      await redis.eval(BUMP, 1, stampKey(tabId), STAMP_TTL_MS, ...scopes, ...hosts.map(hostField))
      await bus.publish(tabId, scopes)
    },
    async readHost(tabId, machineId) {
      const [main, hosted, uncovered, host, all] = (await redis.hmget(stampKey(tabId), 'main', 'hosted', 'uncovered', hostField(machineId),
        hostField(ALL_HOSTS))).map(field => Number(field ?? 0))
      return { main: main!, hosted: hosted!, uncovered: uncovered!, host: host!, all: all! }
    },
    subscribe: listener => bus.subscribe(listener),
  }
}

// ── The process's stamps ─────────────────────────────────────────────────────────────────────────────────────────────

let stamps: SwarmStamps | null = null
let readCache: SwarmCache | null = null

/**
 * The stamps every Swarm write of this process bumps, and the read cache over them unless `reads` is false (the kill
 * switch, SWARM_READ_CACHE=off: reads go to Mongo, writes still bump, so other processes' caches stay right). Without
 * stamps (null) nothing is bumped or cached.
 */
export function configureSwarmStamps(next: SwarmStamps | null, options: CacheOptions & { reads?: boolean } = {}): void {
  stamps = next
  readCache = next && options.reads !== false ? new SwarmCache(next, options) : null
}
export const swarmReadCache = (): SwarmCache | null => readCache

/** One machine's host stamps of a Swarm now, or null without stamps, when they fail, or past STAMP_TIMEOUT_MS: its
 *  reading-only report then runs in full (machineReports.ts). */
export async function readHostStamp(tabId: string, machineId: string): Promise<HostStamp | null> {
  if (!stamps) return null
  let timer: NodeJS.Timeout | undefined
  const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), STAMP_TIMEOUT_MS) })
  try {
    return await Promise.race([stamps.readHost(tabId, machineId), late])
  } catch {
    return null
  } finally {
    clearTimeout(timer)
  }
}

/** Whether this process committed a change of the Swarm whose bump Redis has not taken yet: its stamps say nothing new. */
export const stampOwed = (tabId: string): boolean => owed.has(tabId) || settling.has(tabId)

/** The Swarms a transaction changed, by stamp scope and host: bumped once it commits (`swarmTransaction`). */
type Changes = Map<string, { scopes: Set<StampScope>; hosts: Set<string> }>
const changesOf = new WeakMap<object, Changes>()

/** A part write in this transaction changed this Swarm, and concerned these hosts (parts/write.ts writeHosts). A change of
 *  the Swarm that names none concerns every host: a rollback, a Swarm's parts inserted. */
export function noteChange(tx: object, tabId: string, scope: StampScope, hosts: readonly string[] = scope === 'main' ? [ALL_HOSTS] : []): void {
  const changes = changesOf.get(tx)
  if (changes) owe(changes, tabId, [scope], hosts)
}

function owe(changes: Changes, tabId: string, scopes: Iterable<StampScope>, hosts: Iterable<string>): void {
  const change = changes.get(tabId) ?? { scopes: new Set<StampScope>(), hosts: new Set<string>() }
  for (const scope of scopes) change.scopes.add(scope)
  for (const host of hosts) change.hosts.add(host)
  changes.set(tabId, change)
}

/**
 * One database transaction that writes Swarm parts: once it commits, every Swarm it changed is bumped, before the caller
 * answers, so any read after the answer, on any process, sees the change. A bump Redis cannot take is owed: this process
 * forgets the Swarm and tries again every second until Redis takes it (other processes hold the Swarm until then, at most
 * CACHE_MAX_AGE_MS). A transaction that fails bumps nothing.
 */
export async function swarmTransaction<T>(db: Pick<PrismaClient, '$transaction'>, body: (tx: Prisma.TransactionClient) => Promise<T>,
  options?: { maxWait?: number; timeout?: number }): Promise<T> {
  const changes: Changes = new Map()
  const result = await db.$transaction(tx => { changesOf.set(tx, changes); return body(tx) }, options)
  await announce(changes)
  return result
}

const owed: Changes = new Map()
/** Owed bumps being paid now, out of `owed` until Redis takes them or they are owed again. */
const settling = new Set<string>()
let paying: NodeJS.Timeout | null = null
export const OWED_RETRY_MS = 1_000

async function announce(changes: Changes): Promise<void> {
  if (!stamps || !changes.size) return
  const current = stamps
  await Promise.all([...changes].map(async ([tabId, { scopes, hosts }]) => {
    try { await current.bump(tabId, [...scopes], [...hosts]) } catch (error) {
      readCache?.drop(tabId)
      if (!owed.size) logger.error('[swarm-cache] stamp bump failed after commit; retrying every second', error, { tabId })
      owe(owed, tabId, scopes, hosts)
      paying ??= setTimeout(payOwed, OWED_RETRY_MS)
      paying.unref?.()
    }
  }))
}

async function payOwed(): Promise<void> {
  paying = null
  const due = [...owed]
  owed.clear()
  for (const [tabId] of due) settling.add(tabId)
  try {
    await announce(new Map(due))
  } finally {
    for (const [tabId] of due) settling.delete(tabId)
  }
  if (!owed.size && due.length) logger.info('[swarm-cache] owed stamp bumps paid', { swarms: due.length })
}
