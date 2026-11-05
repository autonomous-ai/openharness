/**
 * The parts a machine's full report last read, held in this process at their exact version (B3, #2597). Every reading
 * re-read the Swarm's machine parts and its running and Lead conversations whole (prod, 2026-11-04: 1.57 GB an hour, the
 * route with the most database time), though between two reports most of them had not changed. A read here first asks
 * MongoDB, in the report's own transaction, only for each selected part's columns that every write moves (`version`,
 * `changedAt`, `readAt`, `dormant`; parts/write.ts guardedWrite), then reads whole only the parts whose columns differ from
 * what this process holds. A held part is used only when they are all equal, so the report works on what a whole read
 * would have returned. Held parts are frozen (cache.ts freeze) and shared, never changed.
 */
import type { Prisma } from '@prisma/client'
import { sizeOf } from '../cache.js'
import { recordCache } from '../cacheStats.js'
import { ms } from './light.js'
import { groupsBy, type GroupIndex } from './indexed.js'
import { partId, type PartRow } from './write.js'

type Transaction = Prisma.TransactionClient
type Where = Record<string, unknown>

/** What every process may hold, all Swarms together, measured as the read cache measures (cache.ts sizeOf). */
export const HELD_MAX_BYTES = 32 * 1024 * 1024
/** More changed machine parts than this are read in one query of them all, not one by id each. */
const FEW = 4

interface Held { columns: string; value: unknown; bytes: number; read: number }
interface Tab { tabId: string; parts: Map<string, Held>; reads: number; bytes: number }

/** The columns a write moves, as one string: a part whose string is unchanged has its data unchanged. */
function columnsOf(row: Record<string, unknown>): string {
  const date = (value: unknown) => value === null || value === undefined ? '' : value instanceof Date ? value.getTime() : ms(value)
  return `${Number(row.version)}|${date(row.changedAt)}|${date(row.readAt)}|${row.dormant ? 1 : 0}`
}
const byKey = (rows: PartRow[]) => rows.sort((a, b) => a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
const COLUMNS = { _id: 0, key: 1, version: 1, changedAt: 1, readAt: 1, dormant: 1 }
/** A group's columns: it has no readAt, and every other one is in the held index (parts/indexed.ts `held`), so a listing of the
 *  awake ones through it reads no document. */
const GROUP_COLUMNS = { _id: 0, key: 1, version: 1, changedAt: 1, dormant: 1 }

export class HeldParts {
  private readonly tabs = new Map<string, Tab>()
  private bytes = 0
  constructor(private readonly maxBytes = HELD_MAX_BYTES) {}

  /** One report's read of a Swarm: its reads, then `done` to let go of what it no longer selects. */
  read(tabId: string): HeldRead {
    const tab = this.tabs.get(tabId) ?? { tabId, parts: new Map(), reads: 0, bytes: 0 }
    // Most recently read last: the cap lets the least recently read Swarm go first.
    this.tabs.delete(tabId)
    this.tabs.set(tabId, tab)
    return new HeldRead(this, tab, ++tab.reads)
  }

  /** @internal */ take(tab: Tab, id: string, columns: string, read: number): unknown {
    const held = tab.parts.get(id)
    if (!held || held.columns !== columns) return undefined
    held.read = read
    return held.value
  }

  /** @internal */ holds(tab: Tab, kind: 'machine' | 'group'): boolean {
    for (const id of tab.parts.keys()) if (id.startsWith(`${kind}:`)) return true
    return false
  }

  /** @internal */ keep(tab: Tab, id: string, columns: string, value: unknown, read: number): number {
    const bytes = sizeOf(value)
    // A Swarm the cap let go during this read keeps nothing.
    if (this.tabs.get(tab.tabId) !== tab) return bytes
    this.drop(tab, id)
    tab.parts.set(id, { columns, value, bytes, read })
    tab.bytes += bytes
    this.bytes += bytes
    return bytes
  }

  /** @internal */ done(tab: Tab, read: number): void {
    if (this.tabs.get(tab.tabId) !== tab) return
    // Parts no read since this one's start selected: a concurrent later read's are kept.
    for (const [id, held] of tab.parts) if (held.read < read) this.drop(tab, id)
    for (const [tabId, oldest] of this.tabs) {
      if (this.bytes <= this.maxBytes) break
      this.tabs.delete(tabId)
      this.bytes -= oldest.bytes
    }
  }

  private drop(tab: Tab, id: string): void {
    const held = tab.parts.get(id)
    if (!held) return
    tab.parts.delete(id)
    tab.bytes -= held.bytes
    this.bytes -= held.bytes
  }
}

/** The process's held parts: machine reports'. */
export const HELD = new HeldParts()
/** Commands' (parts/load.ts loadActive), apart from the reports': each read lets go of what it did not select, and a report
 *  selects only running work and Lead conversations, where a command selects every awake conversation. */
export const COMMAND_HELD = new HeldParts()

export class HeldRead {
  constructor(private readonly owner: HeldParts, private readonly tab: Tab, private readonly at: number) {}

  /** The Swarm's live machine parts, as `findMany({ where: { tabId, deleted: false } })` returns them, in key order. */
  async machines(tx: Transaction): Promise<PartRow[]> {
    const { tabId } = this.tab
    const all = () => tx.swarmMachine.findMany({ where: { tabId, deleted: false } }) as unknown as Promise<PartRow[]>
    // Holding none of them, the whole read alone, as before.
    if (!this.owner.holds(this.tab, 'machine')) return byKey(this.kept('machine', await all(), 'cold'))
    const listed = await tx.swarmMachine.aggregateRaw({ pipeline: [{ $match: { tabId, deleted: false } }, { $project: COLUMNS }] }) as unknown as
      Array<Record<string, unknown>>
    const rows = new Map<string, PartRow>()
    const changed: string[] = []
    for (const row of listed) {
      const value = this.owner.take(this.tab, `machine:${row.key as string}`, columnsOf(row), this.at)
      if (value) rows.set(row.key as string, value as PartRow)
      else changed.push(row.key as string)
    }
    if (!changed.length) recordCache('held-machines', 'hit')
    else {
      const read = changed.length > FEW ? (await all()).filter(row => !rows.has(row.key))
        : (await Promise.all(changed.map(key => tx.swarmMachine.findUnique({ where: { id: partId(tabId, key) } })))).filter(row => !!row && !row.deleted) as unknown as PartRow[]
      for (const row of this.kept('machine', read, 'parts')) rows.set(row.key, row)
    }
    return byKey([...rows.values()])
  }

  /** The live groups these reads find, each once, in the order the reads list them (parts/load.ts liveGroups). */
  async groups(tx: Transaction, reads: ReadonlyArray<readonly [GroupIndex, Where]>): Promise<Array<Record<string, unknown>>> {
    const { tabId } = this.tab
    const read = (columns: boolean) => Promise.all(reads.map(([index, match]) => groupsBy(tx, index, [
      { $match: { tabId, deleted: false, ...match } as Prisma.InputJsonValue }, ...columns ? [{ $project: GROUP_COLUMNS }] : []])))
    const once = (rows: Array<Record<string, unknown>>) => [...new Map(rows.map(row => [row.key as string, row])).values()]
    // Holding none of them, the whole reads alone, as before.
    if (!this.owner.holds(this.tab, 'group')) return this.kept('group', once((await read(false)).flat()), 'cold')
    const listed = once((await read(true)).flat())
    const rows = new Map<string, Record<string, unknown>>()
    const changed: string[] = []
    for (const row of listed) {
      const value = this.owner.take(this.tab, `group:${row.key as string}`, columnsOf(row), this.at)
      if (value) rows.set(row.key as string, value as Record<string, unknown>)
      else changed.push(row.key as string)
    }
    if (!changed.length) recordCache('held-groups', 'hit')
    else for (const row of this.kept('group', await groupsBy(tx, 'key', [{ $match: { tabId, deleted: false, key: { $in: changed } } }]), 'parts')) rows.set(row.key as string, row)
    return listed.flatMap(row => rows.has(row.key as string) ? [rows.get(row.key as string)!] : [])
  }

  /** Holds the parts just read whole, and counts them (`swarm cache`, entries `held-machines` and `held-groups`). */
  private kept<T extends { key: string } | Record<string, unknown>>(kind: 'machine' | 'group', rows: T[], reason: 'cold' | 'parts'): T[] {
    let bytes = 0
    for (const row of rows) bytes += this.owner.keep(this.tab, `${kind}:${(row as { key: string }).key}`, columnsOf(row as Record<string, unknown>), row, this.at)
    recordCache(kind === 'machine' ? 'held-machines' : 'held-groups', 'full', { bytes, parts: rows.length, reason })
    return rows
  }

  /** Lets go of what this read no longer selected, and of the least recently read Swarms past the cap. */
  done(): void {
    this.owner.done(this.tab, this.at)
  }
}
