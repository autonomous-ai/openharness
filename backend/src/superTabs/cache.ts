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

/** The stamps of one Swarm. A stamp only grows; one that never moved is 0. */
export interface Stamp { main: number; machine: number }
/** `main`: any change of a Swarm's parts. `machine`: a change of a machine part's own reading only. */
export type StampScope = keyof Stamp

/** Where every process reads and bumps the stamps: Redis in production (redisStamps). */
export interface SwarmStamps {
  read(tabIds: readonly string[]): Promise<Map<string, Stamp>>
  bump(tabId: string, scopes: readonly StampScope[]): Promise<void>
  /** Called back when any process bumps a Swarm, so this one frees what it holds of it early. */
  subscribe(listener: (tabId: string, scopes: readonly StampScope[]) => void): () => void
}

interface Entry { stamp: Stamp; scope: StampScope | 'all'; at: number; bytes: number; value: unknown }

export interface CacheOptions {
  /** What the held values may take, counted as their JSON size. */
  maxBytes?: number
  /** A safety net: an entry is read again after this long whatever its stamp (a bump lost to a crash after commit). */
  maxAgeMs?: number
  /** A read that cannot learn the stamps in this time reads Mongo itself. */
  stampTimeoutMs?: number
  now?: () => number
}

export const CACHE_MAX_BYTES = 64 * 1024 * 1024
export const CACHE_MAX_AGE_MS = 60_000
export const STAMP_TIMEOUT_MS = 200

const key = (tabId: string, name: string) => `${tabId}\u0000${name}`

/** Freezes a loaded value all through and tells its size as JSON, in one pass. */
export function freeze(value: unknown): number {
  if (value === null || value === undefined) return 4
  switch (typeof value) {
    case 'string': return value.length + 2
    case 'number': case 'boolean': case 'bigint': return 8
    case 'object': {
      if (value instanceof Date) return 26
      let bytes = 2
      if (Array.isArray(value)) for (const item of value) bytes += freeze(item) + 1
      else for (const [name, item] of Object.entries(value)) bytes += name.length + 4 + freeze(item)
      Object.freeze(value)
      return bytes
    }
    default: return 8
  }
}

export class SwarmCache {
  private readonly entries = new Map<string, Entry>()
  private readonly loading = new Map<string, Promise<unknown>>()
  private bytes = 0
  private readonly maxBytes: number
  private readonly maxAgeMs: number
  private readonly stampTimeoutMs: number
  private readonly now: () => number

  constructor(private readonly stamps: SwarmStamps, options: CacheOptions = {}) {
    this.maxBytes = options.maxBytes ?? CACHE_MAX_BYTES
    this.maxAgeMs = options.maxAgeMs ?? CACHE_MAX_AGE_MS
    this.stampTimeoutMs = options.stampTimeoutMs ?? STAMP_TIMEOUT_MS
    this.now = options.now ?? Date.now
    stamps.subscribe((tabId, scopes) => this.drop(tabId, scopes))
  }

  get size() { return { entries: this.entries.size, bytes: this.bytes } }

  /** One read's view of these Swarms: their stamps, read once, before anything is loaded. */
  async at(tabIds: readonly string[]): Promise<CacheView> {
    let timer: NodeJS.Timeout | undefined
    const late = new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), this.stampTimeoutMs) })
    try {
      return new CacheView(this, await Promise.race([this.stamps.read(tabIds), late]))
    } catch {
      return new CacheView(this, null)
    } finally {
      clearTimeout(timer)
    }
  }

  /** Forgets what this process holds of a Swarm that these stamps' moves make stale; everything, by default. */
  drop(tabId: string, scopes: readonly StampScope[] = ['main']): void {
    const prefix = key(tabId, ''), main = scopes.includes('main')
    for (const [name, entry] of this.entries) {
      if (!name.startsWith(prefix) || !main && entry.scope === 'main') continue
      this.entries.delete(name)
      this.bytes -= entry.bytes
    }
  }

  /** @internal CacheView's lookup. */
  held(tabId: string, name: string, stamp: Stamp): unknown {
    const entry = this.entries.get(key(tabId, name))
    if (!entry) return undefined
    const fresh = entry.stamp.main === stamp.main && (entry.scope === 'main' || entry.stamp.machine === stamp.machine) && this.now() - entry.at < this.maxAgeMs
    if (!fresh) {
      this.entries.delete(key(tabId, name))
      this.bytes -= entry.bytes
      return undefined
    }
    // Most recently used last.
    this.entries.delete(key(tabId, name))
    this.entries.set(key(tabId, name), entry)
    return entry.value
  }

  /** @internal CacheView's load: one load for every reader that misses the same entry at the same stamp. */
  async load<T>(tabId: string, name: string, scope: StampScope | 'all', stamp: Stamp, load: () => Promise<T>): Promise<T> {
    const flight = `${key(tabId, name)}\u0000${stamp.main}\u0000${scope === 'main' ? '' : stamp.machine}`
    const running = this.loading.get(flight) as Promise<T> | undefined
    if (running) return running
    const at = this.now()
    const loaded = load().then(value => {
      const bytes = freeze(value)
      if (bytes <= this.maxBytes) {
        this.drop1(key(tabId, name))
        this.entries.set(key(tabId, name), { stamp, scope, at, bytes, value })
        this.bytes += bytes
        for (const [oldest, entry] of this.entries) {
          if (this.bytes <= this.maxBytes) break
          this.entries.delete(oldest)
          this.bytes -= entry.bytes
        }
      }
      return value
    }).finally(() => this.loading.delete(flight))
    this.loading.set(flight, loaded)
    return loaded
  }

  private drop1(name: string) {
    const entry = this.entries.get(name)
    if (!entry) return
    this.entries.delete(name)
    this.bytes -= entry.bytes
  }
}

/** One read's stamps. Without them (Redis unreachable or late) every get reads Mongo, and nothing is kept. */
export class CacheView {
  constructor(private readonly cache: SwarmCache | null, private readonly stamps: Map<string, Stamp> | null) {}

  get available(): boolean { return this.stamps !== null }

  /** This Swarm's main stamp as the view read it, or none without stamps or a cache. */
  mainStamp(tabId: string): number | undefined {
    return this.cache ? this.stamps?.get(tabId)?.main : undefined
  }

  /** The value `load` gives for this Swarm at the view's stamp: held, or loaded and held. `scope` says which stamps it
   *  depends on: 'main' for what a machine's reading never changes, 'all' for anything holding machine parts. */
  async get<T>(tabId: string, name: string, scope: StampScope | 'all', load: () => Promise<T>): Promise<T> {
    const stamp = this.stamps?.get(tabId)
    if (!stamp || !this.cache) return load()
    const held = this.cache.held(tabId, name, stamp)
    if (held !== undefined) return held as T
    return this.cache.load(tabId, name, scope, stamp, load)
  }
}

/** A stamp kept this long after its Swarm's last change; a Swarm read after that reads 0, then starts again from the time. */
export const STAMP_TTL_MS = 30 * 86_400_000
const stampKey = (tabId: string) => `swarm:stamp:${tabId}`
/**
 * A Swarm's first bump starts both stamps from Redis's clock in ms, then moves the named ones by one. Redis losing the key
 * (a restart, the expiry) therefore never hands out a stamp a process may still hold: it starts again above it, as long as
 * a Swarm has fewer commits than milliseconds between its first and its loss.
 */
const BUMP = `if redis.call('exists', KEYS[1]) == 0 then
  local t = redis.call('time')
  local base = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)
  redis.call('hset', KEYS[1], 'main', base - 1, 'machine', base - 1)
end
for i = 2, #ARGV do redis.call('hincrby', KEYS[1], ARGV[i], 1) end
redis.call('pexpire', KEYS[1], ARGV[1])
return 1`

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
    async bump(tabId, scopes) {
      await redis.eval(BUMP, 1, stampKey(tabId), STAMP_TTL_MS, ...scopes)
      await bus.publish(tabId, scopes)
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

/** The Swarms a transaction changed, by stamp scope: bumped once it commits (`swarmTransaction`). */
type Changes = Map<string, Set<StampScope>>
const changesOf = new WeakMap<object, Changes>()

/** A part write in this transaction changed this Swarm (parts/write.ts). */
export function noteChange(tx: object, tabId: string, scope: StampScope): void {
  const changes = changesOf.get(tx)
  if (!changes) return
  const scopes = changes.get(tabId) ?? new Set<StampScope>()
  scopes.add(scope)
  changes.set(tabId, scopes)
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
let paying: NodeJS.Timeout | null = null
export const OWED_RETRY_MS = 1_000

async function announce(changes: Changes): Promise<void> {
  if (!stamps || !changes.size) return
  const current = stamps
  await Promise.all([...changes].map(async ([tabId, scopes]) => {
    try { await current.bump(tabId, [...scopes]) } catch (error) {
      readCache?.drop(tabId)
      if (!owed.size) logger.error('[swarm-cache] stamp bump failed after commit; retrying every second', error, { tabId })
      const due = owed.get(tabId) ?? new Set<StampScope>()
      for (const scope of scopes) due.add(scope)
      owed.set(tabId, due)
      paying ??= setTimeout(payOwed, OWED_RETRY_MS)
      paying.unref?.()
    }
  }))
}

async function payOwed(): Promise<void> {
  paying = null
  const due = [...owed]
  owed.clear()
  await announce(new Map(due))
  if (!owed.size && due.length) logger.info('[swarm-cache] owed stamp bumps paid', { swarms: due.length })
}
