/**
 * The desk document and the operations that change it — pure, so the merge rule can be tested
 * without a database.
 *
 * ONE RULE: every op is idempotent and an op on a tab that is gone is dropped, never an error. That
 * is the whole of how two windows racing merge — close a tab here while a pane is being added to it
 * there, and the add lands on nothing. A window that was offline for a day replays its queue against
 * a desk that moved, and every op still means what it meant.
 */
import { z } from 'zod'

export const DESK_MAX_TABS = 24      // the window's own ceiling (localWsServer.ts, appSwarmsFrom)
export const DESK_MAX_PANES = 9      // the window's grid (`maxPanes`)
export const DESK_NAME_MAX = 80

const id = z.string().min(1).max(64).regex(/^[A-Za-z0-9_-]+$/)
const machineId = z.string().regex(/^[a-zA-Z0-9_-]{1,128}$/)
const agentId = z.string().min(1).max(160)
const name = z.string().trim().min(1).max(DESK_NAME_MAX)

export const deskPaneSchema = z.object({ machineId, agentId }).strict()
export const deskTabSchema = z.object({
  id,
  name,
  nameIsCustom: z.boolean().optional(),
  panes: z.array(deskPaneSchema).max(DESK_MAX_PANES),
}).strict()

export type DeskPane = z.infer<typeof deskPaneSchema>
export type DeskTab = z.infer<typeof deskTabSchema>
export interface DeskDoc { revision: number; tabs: DeskTab[] }

export const deskOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('tab.create'), id, name, nameIsCustom: z.boolean().optional(), index: z.number().int().min(0).optional() }).strict(),
  z.object({ op: z.literal('tab.close'), id }).strict(),
  z.object({ op: z.literal('tab.rename'), id, name, nameIsCustom: z.boolean().optional() }).strict(),
  z.object({ op: z.literal('tab.move'), id, index: z.number().int().min(0) }).strict(),
  z.object({ op: z.literal('pane.add'), tabId: id, machineId, agentId, index: z.number().int().min(0).optional() }).strict(),
  z.object({ op: z.literal('pane.remove'), tabId: id, machineId, agentId }).strict(),
  z.object({ op: z.literal('pane.move'), tabId: id, machineId, agentId, index: z.number().int().min(0) }).strict(),
  // First sync from a computer that already had tabs of its own: every tab whose id the desk does
  // not know is appended, as it was. The person closes the extras; nothing of theirs is dropped.
  z.object({ op: z.literal('seed'), tabs: z.array(deskTabSchema).max(DESK_MAX_TABS) }).strict(),
])
export type DeskOp = z.infer<typeof deskOpSchema>

export const deskOpsBodySchema = z.object({
  ops: z.array(deskOpSchema).min(1).max(200),
}).strict()

/** `tabs` as stored (Json), validated shape by shape; anything malformed is dropped rather than served. */
export function parseTabs(raw: unknown): DeskTab[] {
  if (!Array.isArray(raw)) return []
  const out: DeskTab[] = []
  const seen = new Set<string>()
  for (const item of raw) {
    const parsed = deskTabSchema.safeParse(item)
    if (!parsed.success || seen.has(parsed.data.id)) continue
    seen.add(parsed.data.id)
    out.push(parsed.data)
    if (out.length >= DESK_MAX_TABS) break
  }
  return out
}

const clampIndex = (index: number | undefined, length: number): number =>
  index === undefined ? length : Math.max(0, Math.min(index, length))

const samePane = (a: DeskPane, b: { machineId: string; agentId: string }): boolean =>
  a.machineId === b.machineId && a.agentId === b.agentId

/**
 * Apply one op to a copy of `tabs`. Returns the new list and whether anything changed — an op that
 * finds its tab gone, or its pane already there, changes nothing and says so.
 */
export function applyDeskOp(tabs: DeskTab[], op: DeskOp): { tabs: DeskTab[]; changed: boolean } {
  const next = tabs.map((t) => ({ ...t, panes: [...t.panes] }))
  const at = (tabId: string) => next.findIndex((t) => t.id === tabId)
  switch (op.op) {
    case 'tab.create': {
      if (at(op.id) >= 0) return { tabs: next, changed: false }        // already there: the same click twice
      if (next.length >= DESK_MAX_TABS) return { tabs: next, changed: false }
      const tab: DeskTab = { id: op.id, name: op.name, panes: [], ...(op.nameIsCustom ? { nameIsCustom: true } : {}) }
      next.splice(clampIndex(op.index, next.length), 0, tab)
      return { tabs: next, changed: true }
    }
    case 'tab.close': {
      const i = at(op.id)
      if (i < 0) return { tabs: next, changed: false }
      next.splice(i, 1)
      return { tabs: next, changed: true }
    }
    case 'tab.rename': {
      const i = at(op.id)
      if (i < 0) return { tabs: next, changed: false }
      const custom = op.nameIsCustom ?? next[i].nameIsCustom
      if (next[i].name === op.name && !!next[i].nameIsCustom === !!custom) return { tabs: next, changed: false }
      next[i] = { ...next[i], name: op.name, ...(custom ? { nameIsCustom: true } : {}) }
      if (!custom) delete next[i].nameIsCustom
      return { tabs: next, changed: true }
    }
    case 'tab.move': {
      const i = at(op.id)
      if (i < 0) return { tabs: next, changed: false }
      const [tab] = next.splice(i, 1)
      const dest = clampIndex(op.index, next.length)
      next.splice(dest, 0, tab)
      return { tabs: next, changed: dest !== i }
    }
    case 'pane.add': {
      const i = at(op.tabId)
      if (i < 0) return { tabs: next, changed: false }
      const panes = next[i].panes
      if (panes.some((p) => samePane(p, op))) return { tabs: next, changed: false }
      if (panes.length >= DESK_MAX_PANES) return { tabs: next, changed: false }
      panes.splice(clampIndex(op.index, panes.length), 0, { machineId: op.machineId, agentId: op.agentId })
      return { tabs: next, changed: true }
    }
    case 'pane.remove': {
      const i = at(op.tabId)
      if (i < 0) return { tabs: next, changed: false }
      const panes = next[i].panes
      const j = panes.findIndex((p) => samePane(p, op))
      if (j < 0) return { tabs: next, changed: false }
      panes.splice(j, 1)
      return { tabs: next, changed: true }
    }
    case 'pane.move': {
      const i = at(op.tabId)
      if (i < 0) return { tabs: next, changed: false }
      const panes = next[i].panes
      const j = panes.findIndex((p) => samePane(p, op))
      if (j < 0) return { tabs: next, changed: false }
      const [pane] = panes.splice(j, 1)
      const dest = clampIndex(op.index, panes.length)
      panes.splice(dest, 0, pane)
      return { tabs: next, changed: dest !== j }
    }
    case 'seed': {
      let changed = false
      for (const tab of op.tabs) {
        if (at(tab.id) >= 0 || next.length >= DESK_MAX_TABS) continue
        next.push({ ...tab, panes: [...tab.panes] })
        changed = true
      }
      return { tabs: next, changed }
    }
  }
}

export function applyDeskOps(tabs: DeskTab[], ops: DeskOp[]): { tabs: DeskTab[]; changed: boolean } {
  let current = tabs
  let changed = false
  for (const op of ops) {
    const result = applyDeskOp(current, op)
    current = result.tabs
    changed ||= result.changed
  }
  return { tabs: current, changed }
}
