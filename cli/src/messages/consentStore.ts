/**
 * The harnesses this account asked to have in a shared tab, on this machine: its consent to be watched. The owner signs
 * the roster and may list a member's harness the member never asked to share, or list one again after the member took it
 * out; the member's daemon grants every account in the tab a read-only view of each harness the roster lists under its
 * account (sharing/rosterGrants.ts), so a roster alone must not be enough (review of C1, 2026-10-16). An entry is made
 * when this machine asks to add a harness (sharedTabs.ts `addHarness`, a forwarded add included), and goes when it asks
 * to take it out, leaves the tab, or a roster that listed it lists it no more (`reconcile`): listing it again later asks
 * the member again.
 *
 * The same word gates messages (final review of 1b): in a tab another account owns, a harness of this machine is in the
 * tab here, takes other accounts' messages and is named to them only while it holds an entry (sharedDirectory.ts,
 * tabDelivery.ts `checkHandedOver`, service.ts `who`).
 *
 * Written by the messages process alone; Share reads it (`read`), and never writes it.
 */
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Roster } from './roster.js'
import { bool, list, NO, object, text } from './shape.js'

// `listed`: whether a roster has listed it since it was asked for: only then does a roster without it mean it was taken out.
type Entry = { sharedTabId: string; machineId: string; agentId: string; listed: boolean }
const entries = list(object<Entry>({ sharedTabId: text(), machineId: text(), agentId: text(), listed: bool }))
type Op = (entries: Entry[]) => Entry[]

/** How an entry is named in the set Share reads. */
export const consentKey = (sharedTabId: string, machineId: string, agentId: string): string => `${sharedTabId}\n${machineId}\n${agentId}`

/** The file as saved: none yet is an empty list; one that reads but holds no list is null; any other read error throws. */
function load(path: string): Entry[] | null {
  let raw: string
  try { raw = readFileSync(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
  let json: unknown = null
  try { json = JSON.parse(raw) } catch { /* not a list, below */ }
  const parsed = entries(json)
  return parsed === NO ? null : parsed
}

export class ConsentStore {
  private entries: Entry[] = []
  /** Set while the file could not be read at all (EACCES, EIO): nothing is written over it, and what changed meanwhile
   *  is kept to apply once it reads, so a removal is never lost to a passing error and an empty set never replaces it. */
  private waiting: Op[] | null = null

  /** `onChange` is told after every save: Share derives its observers again (core/messagesLink.ts `observers`). */
  constructor(private readonly path: string, private readonly now = () => Date.now(), private readonly onChange?: () => void) {
    this.reload()
  }

  /** The keys of the file at `path` (`consentKey`), for Share, which only reads: none when there is no file; null when
   *  it cannot be read or holds no list, which revokes nothing. */
  static read(path: string): Set<string> | null {
    let entries: Entry[] | null
    try { entries = load(path) } catch { return null }
    return entries && new Set(entries.map((e) => consentKey(e.sharedTabId, e.machineId, e.agentId)))
  }

  /** Reads the file: a broken one is moved aside, as the request store does, and the set starts empty. */
  private reload(): boolean {
    let loaded: Entry[] | null
    try { loaded = load(this.path) } catch { this.waiting ??= []; return false }
    if (loaded === null) {
      try { renameSync(this.path, `${this.path}.unreadable-${this.now()}`) } catch { /* nothing more to do */ }
      loaded = []
    }
    const waiting = this.waiting ?? []
    this.waiting = null
    this.entries = waiting.reduce((list, op) => op(list), loaded)
    if (waiting.length) this.save()
    return true
  }

  private apply(op: Op): void {
    if (this.waiting && !this.reload()) {
      this.waiting.push(op)
      this.entries = op(this.entries)
      return
    }
    const before = JSON.stringify(this.entries)
    this.entries = op(this.entries)
    if (JSON.stringify(this.entries) !== before) this.save()
  }

  private save(): void {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
      const temp = `${this.path}.${randomUUID()}.tmp`
      writeFileSync(temp, JSON.stringify(this.entries), { flag: 'wx', mode: 0o600 })
      renameSync(temp, this.path)
    } catch { return /* kept in memory; the next change writes it */ }
    this.onChange?.()
  }

  /** This machine asked for the harness in the tab; `listed` when the roster already lists it. */
  grant(sharedTabId: string, machineId: string, agentId: string, listed: boolean): void {
    this.apply((list) => [...list.filter((e) => !same(e, sharedTabId, machineId, agentId)), { sharedTabId, machineId, agentId, listed }])
  }

  /** This account asked to take it out. */
  revoke(sharedTabId: string, machineId: string, agentId: string): void {
    this.apply((list) => list.filter((e) => !same(e, sharedTabId, machineId, agentId)))
  }

  /** This computer is out of the tab. */
  forgetTab(sharedTabId: string): void {
    this.apply((list) => list.filter((e) => e.sharedTabId !== sharedTabId))
  }

  /** Follows the rosters held now (`current`): an entry a roster lists is marked listed, and one that was listed and is
   *  listed no more goes, as the owner took it out. A tab with no roster held (being pinned again) changes nothing. */
  reconcile(current: (sharedTabId: string) => Roster | null): void {
    this.apply((list) => list.flatMap((e) => {
      const roster = current(e.sharedTabId)
      if (!roster) return [e]
      const listed = roster.harnesses.some((h) => h.machineId === e.machineId && h.agentId === e.agentId)
      return listed ? [{ ...e, listed: true }] : e.listed ? [] : [e]
    }))
  }

  keys(): Set<string> { return new Set(this.entries.map((e) => consentKey(e.sharedTabId, e.machineId, e.agentId))) }
}

const same = (e: Entry, sharedTabId: string, machineId: string, agentId: string): boolean =>
  e.sharedTabId === sharedTabId && e.machineId === machineId && e.agentId === agentId
