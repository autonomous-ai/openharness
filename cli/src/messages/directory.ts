/**
 * Who may message whom (docs/design/2026-10-10-agent-messages.md, "Who may message whom"): the account's
 * desk tabs, each with its owned panes and whether Agent Messages is on in it, read from the backend
 * (`GET /api/agent-messages`). A message goes only between harnesses that share a tab whose flag is on.
 *
 * Read when the service starts, every 15 seconds while it runs, again on the account's `desk_changed` (which a
 * flag change publishes too), and fresh before a send. An unreadable directory never clears what was read: a
 * failed read keeps the last one, and before any read nothing may be sent.
 */

export interface Member { machineId: string; agentId: string }
export interface DirectoryTab { id: string; name: string; enabled: boolean; panes: Member[] }
export interface Directory { revision: number; machines: ReadonlyMap<string, string | null>; tabs: DirectoryTab[] }

export const POLL_MS = 15_000
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
    tabs.push({ id, name, enabled: t.enabled === true, panes })
  }
  return { revision: typeof v.revision === 'number' ? v.revision : 0, machines, tabs }
}

const same = (a: Member, b: Member): boolean => a.machineId === b.machineId && a.agentId === b.agentId

export interface DirectoryDeps {
  read(): Promise<unknown>
  /** The directory changed: deliveries and notes may need another look. */
  changed?(): void
  now?(): number
}

export class MessageDirectory {
  private value: Directory | null = null
  private readAt = -Infinity
  private reading: Promise<Directory | null> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  constructor(private readonly deps: DirectoryDeps) {}
  private now(): number { return this.deps.now?.() ?? Date.now() }

  current(): Directory | null { return this.value }

  /** The directory, read again unless the last read is fresh; a failed read keeps the last one. */
  refresh(force = false): Promise<Directory | null> {
    if (!force && this.value && this.now() - this.readAt < FRESH_MS) return Promise.resolve(this.value)
    return this.reading ??= this.deps.read().then((raw) => {
      const next = parseDirectory(raw)
      if (next) {
        const before = JSON.stringify(this.value ? [this.value.revision, this.value.tabs] : null)
        this.value = next
        this.readAt = this.now()
        if (JSON.stringify([next.revision, next.tabs]) !== before) this.deps.changed?.()
      }
      return this.value
    }, () => this.value).finally(() => { this.reading = null })
  }

  start(): void {
    if (this.timer) return
    void this.refresh(true)
    this.timer = setInterval(() => { void this.refresh(true) }, POLL_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** The tabs with Agent Messages on that a harness is in. */
  tabsOf(member: Member): DirectoryTab[] {
    return (this.value?.tabs ?? []).filter((tab) => tab.enabled && tab.panes.some((p) => same(p, member)))
  }

  /** The first tab with Agent Messages on that two harnesses share, or null. */
  shared(a: Member, b: Member): DirectoryTab | null {
    return this.tabsOf(a).find((tab) => tab.panes.some((p) => same(p, b))) ?? null
  }

  /** Everyone a harness may message: the other members of its tabs with Agent Messages on, once each. */
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
