/**
 * Who may message whom (docs/design/2026-10-10-agent-messages.md, "Who may message whom"): the account's
 * desk tabs, each with its owned panes, read from the backend (`GET /api/agent-messages`). A message goes only
 * between harnesses that share a tab, while the account has Agent Messages on (Settings ▸ Experimental, off by default).
 * Each tab's own flag, which the backend still answers for older windows, is not read: the tab's switch was a chat
 * icon beside its × that was easy to hit by mistake, and the owner made it one setting of the account (2026-10-12).
 *
 * Read on the account's `desk_changed` and `machines_changed` (service.ts), fresh before a send, and on its own every
 * SAFETY_NET_MS while this computer is signed in with Agent Messages on (`start`, `stop`: service.ts runs it only then),
 * for a push that was missed. An unreadable directory never clears what was read: a failed read keeps the last one,
 * and before any read nothing may be sent.
 *
 * The tabs shared across accounts are merged in (`extra`, sharedDirectory.ts): at every read, and whenever a roster
 * changes (`rebuild`), so another account's harness is in a tab here as soon as its roster is held.
 */

/** A harness in a tab. One of another account's carries that account and the name and engine its roster gives it:
 *  this account's machines cannot be asked about it (service.ts `teammate`). */
export interface Member { machineId: string; agentId: string; accountId?: string; name?: string; engine?: string }
/** `named`: the person named the tab; any other is labelled by the windows themselves (backend lib/agentMessages.ts).
 *  `sharedTabId`: the tab is shared across accounts, under that id. `leader`: the harness the account's tab setting
 *  names to lead it; null for none, or for one that may lead it no more: its pane left the tab, or a member's
 *  harness left the shared tab's roster (the backend derives that, and nothing clears it). Absent where no setting is listed: a backend from before tab leaders, and a tab another account
 *  shares with this one, whose leader is its roster's. */
export interface DirectoryTab { id: string; name: string; named: boolean; panes: Member[]; sharedTabId?: string; leader?: { machineId: string; agentId: string } | null }
export interface Directory { revision: number; machines: ReadonlyMap<string, string | null>; tabs: DirectoryTab[] }

/** The read with no push: a missed one. It was every 15 s, a backend read from every signed-in daemon that almost always
 *  found nothing new (WebSocket roadmap, Phase 2.4); every input of the answer is pushed (backend lib/agentMessages.ts
 *  reads the desk, the machines and the tabs' settings, each written with `desk_changed` or `machines_changed`). */
export const SAFETY_NET_MS = 5 * 60_000
/** How often the timer looks: a read that failed, or none yet, is tried again this soon, as the old poll did. */
export const RETRY_MS = 15_000
/** A read this recent is fresh enough for a send. */
export const FRESH_MS = 2_000

const str = (value: unknown, max: number): string | null => (typeof value === 'string' && value && value.length <= max ? value : null)

/** The backend's answer, checked; null when it is not one. */
export function parseDirectory(value: unknown): Directory | null {
  const v = value as Record<string, unknown> | null
  if (!v || typeof v !== 'object' || !Array.isArray(v.tabs)) return null
  const machines = new Map<string, string | null>()
  for (const m of Array.isArray(v.machines) ? v.machines as Record<string, unknown>[] : []) {
    const id = str(m?.machineId, 128)
    if (id) machines.set(id, str(m.name, 200))
  }
  const tabs: DirectoryTab[] = []
  for (const t of v.tabs as Record<string, unknown>[]) {
    const id = str(t?.id, 64), name = str(t?.name, 200)
    if (!id || name === null || !Array.isArray(t.panes)) continue
    const panes = (t.panes as Record<string, unknown>[]).flatMap((p) => {
      const machineId = str(p?.machineId, 128), agentId = str(p?.agentId, 160)
      return machineId && agentId ? [{ machineId, agentId }] : []
    })
    // A leader that is not one (a malformed answer) is taken as one not listed, as from a backend before tab leaders: a
    // shared tab's roster then keeps its own (sharedTabs.ts `ownLeader`), rather than lose it to a bad read.
    const lead = t.leader as Record<string, unknown> | null | undefined
    const machineId = str(lead?.machineId, 128), agentId = str(lead?.agentId, 160)
    const leader = lead === null ? null : machineId && agentId ? { machineId, agentId } : undefined
    // A backend from before `named` says nothing: then only the window's own default name is no name.
    tabs.push({ id, name, named: typeof t.named === 'boolean' ? t.named : name !== 'New Tab', panes, ...(leader !== undefined ? { leader } : {}) })
  }
  return { revision: typeof v.revision === 'number' ? v.revision : 0, machines, tabs }
}

const same = (a: Member, b: Member): boolean => a.machineId === b.machineId && a.agentId === b.agentId

export interface DirectoryDeps {
  read(): Promise<unknown>
  /** The directory changed: deliveries and notes may need another look. */
  changed?(): void
  /** Whether Agent Messages are on, as this computer keeps the account's experiment; on when not said. */
  on?(): boolean
  /** The desk's tabs with the shared tabs merged in (sharedDirectory.ts `sharedTabsFor`), given the account's machines as
   *  read with them; the desk alone when not said. */
  extra?(desk: DirectoryTab[], machines: ReadonlyMap<string, string | null>): DirectoryTab[]
  now?(): number
}

export class MessageDirectory {
  /** The backend's answer, as read; `value` is it with the shared tabs merged in. */
  private read: Directory | null = null
  private value: Directory | null = null
  private readAt = -Infinity
  private reading: Promise<Directory | null> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  /** The timer's looks since the last good read, by the timer or a push; and whether the last read failed. */
  private quietLooks = 0
  private failed = false
  private wasOn = true
  constructor(private readonly deps: DirectoryDeps) {}
  private now(): number { return this.deps.now?.() ?? Date.now() }

  current(): Directory | null { return this.value }

  /** Whether this computer has Agent Messages on: off, no tab carries a message. */
  on(): boolean { return this.deps.on?.() ?? true }

  /** The directory, read again unless the last read is fresh; a failed read keeps the last one. */
  refresh(force = false): Promise<Directory | null> {
    if (!force && this.value && this.now() - this.readAt < FRESH_MS) return Promise.resolve(this.value)
    return this.reading ??= this.deps.read().then((raw) => {
      const next = parseDirectory(raw)
      this.failed = !next
      if (next) {
        this.read = next
        this.readAt = this.now()
        this.quietLooks = 0
        this.settle(next)
      }
      return this.value
    }, () => { this.failed = true; return this.value }).finally(() => { this.reading = null })
  }

  /** The shared tabs changed (a roster taken, a tab left): merged again into the last read, with no read of its own. */
  rebuild(): void {
    if (this.read) this.settle(this.read)
  }

  private settle(read: Directory): void {
    const next = { ...read, tabs: this.deps.extra?.(read.tabs, read.machines) ?? read.tabs }
    // The setting counts as part of what was read: turned on or off, deliveries and notes get another look. So do the
    // shared tabs merged in: a member's harness added to a tab is a change like a pane added on the desk.
    const before = JSON.stringify(this.value ? [this.value.revision, this.value.tabs, this.wasOn] : null)
    this.value = next
    this.wasOn = this.on()
    if (JSON.stringify([next.revision, next.tabs, this.wasOn]) !== before) this.deps.changed?.()
  }

  start(): void {
    if (this.timer) return
    void this.refresh(true)
    this.timer = setInterval(() => this.look(), RETRY_MS)
    this.timer.unref?.()
  }

  /** Counted in looks, not by the clock: a good read holds the next one off for SAFETY_NET_MS. */
  private look(): void {
    if (this.read && !this.failed && ++this.quietLooks * RETRY_MS < SAFETY_NET_MS) return
    void this.refresh(true)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The tabs a harness is in, while Agent Messages are on; none while they are off. With `account`, only the tabs that
   *  list it under that account (a shared tab's roster): a frame the relay stamped as Bob's speaks for a harness only
   *  where a roster names it Bob's, never where a desk pane, which carries no account, does. */
  tabsOf(member: Member, account?: string): DirectoryTab[] {
    if (!this.on()) return []
    return (this.value?.tabs ?? []).filter((tab) => tab.panes.some((p) => same(p, member) && (account === undefined || p.accountId === account)))
  }

  /** The first tab two harnesses share while Agent Messages are on, or null; with `account`, one that lists `a` under it. */
  shared(a: Member, b: Member, account?: string): DirectoryTab | null {
    return this.tabsOf(a, account).find((tab) => tab.panes.some((p) => same(p, b))) ?? null
  }

  /** Everyone a harness may message: the other members of its tabs, once each, while Agent Messages are on. */
  peers(member: Member): Member[] {
    const out: Member[] = []
    for (const tab of this.tabsOf(member)) {
      for (const pane of tab.panes) if (!same(pane, member) && !out.some((p) => same(p, pane))) out.push(pane)
    }
    return out
  }

  machineName(machineId: string): string | null {
    return this.value?.machines.get(machineId) ?? null
  }
}
