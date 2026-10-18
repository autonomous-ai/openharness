import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { NO, object, oneOf, optional, text } from './shape.js'
import type { SharedNotice } from './sharedTabs.js'

/**
 * What happened in a shared tab that the person has not dismissed, kept on disk: in memory they vanished when the
 * computer slept or the process restarted, before any window showed them (1b follow-up). Bounded: the oldest go first.
 */
export const NOTICES_KEPT = 100
type Kept = SharedNotice & { read?: true }
const notice = object<Kept>({ id: text(), sharedTabId: text(), kind: oneOf('refused', 'removed', 'relay_taken', 'full', 'unsent'),
  at: text(), error: optional(text()), machineId: optional(text()), agentId: optional(text()), ownerEmail: optional(text()),
  read: optional(oneOf(true as const)) })

export class NoticeStore {
  private list: Kept[]
  constructor(private readonly path: string | null, private readonly now = () => Date.now()) {
    this.list = path ? this.load(path) : []
  }

  /** None when there is no file yet; one that is not a list is moved aside. Any other read error is thrown, so a whole file
   *  is never written over by an empty list (review of A7, 1b). Each notice is read on its own: one this daemon cannot
   *  read (a kind a newer daemon added) is left out, and the others are kept (review of A2). */
  private load(path: string): Kept[] {
    let raw: string
    try { raw = readFileSync(path, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
      throw error
    }
    let json: unknown = null
    try { json = JSON.parse(raw) } catch { /* unreadable below */ }
    if (Array.isArray(json)) return json.flatMap((n) => { const kept = notice(n); return kept === NO ? [] : [kept] })
    try { renameSync(path, `${path}.unreadable-${this.now()}`) } catch { /* nothing more to do */ }
    return []
  }

  private save(): void {
    if (!this.path) return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    const temp = `${this.path}.${randomUUID()}.tmp`
    writeFileSync(temp, JSON.stringify(this.list), { flag: 'wx', mode: 0o600 })
    renameSync(temp, this.path)
  }

  /** The notice kept, or null when it is skipped as a repeat. */
  add(n: Omit<SharedNotice, 'id' | 'at'>): SharedNotice | null {
    // A backend that keeps listing a membership its relay keeps refusing would add "removed" on every refresh.
    const newest = this.unread().filter((x) => x.sharedTabId === n.sharedTabId).at(-1)
    if (n.kind === 'removed' && newest?.kind === 'removed') return null
    const kept: Kept = { id: randomUUID(), ...n, at: new Date(this.now()).toISOString() }
    this.list = [...this.list, kept].slice(-NOTICES_KEPT)
    this.save()
    return this.strip(kept)
  }

  unread(): SharedNotice[] { return this.list.filter((n) => !n.read).map((n) => this.strip(n)) }

  dismiss(id: string): boolean {
    const n = this.list.find((x) => x.id === id && !x.read)
    if (!n) return false
    n.read = true
    this.save()
    return true
  }

  private strip({ read: _read, ...n }: Kept): SharedNotice { return n }
}
