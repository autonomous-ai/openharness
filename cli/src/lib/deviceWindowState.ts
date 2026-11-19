import type { AppSwarms } from '../cable/cableSession.js'
import { notificationReadToken, type UnreadNotification } from './notificationRead.js'

export function appPanesFrom(payload: Record<string, unknown> | undefined): { ids: string[]; foreground: boolean } {
  const raw = payload?.agentIds
  return { ids: Array.isArray(raw) ? raw.filter((id): id is string => typeof id === 'string' && id !== '') : [],
    // Older windows only announced while in front; absence keeps their original meaning.
    foreground: payload?.foreground !== false }
}

export function appUnreadFrom(payload: Record<string, unknown> | undefined): UnreadNotification[] {
  const raw = payload?.items
  return Array.isArray(raw) ? raw.flatMap(row => {
    const item = row as Record<string, unknown> | null
    const agentId = item?.agentId, machineId = item?.machineId
    const text = typeof item?.text === 'string' ? item.text : ''
    const readToken = notificationReadToken(item?.readToken)
    return typeof agentId === 'string' && agentId && typeof machineId === 'string'
      ? [{ agentId, machineId, question: item?.question === true, text, ...(readToken ? { readToken } : {}) }] : []
  }) : []
}

/**
 * The window's swarm list, checked field by field. Anything that is not an id, a name and a list of
 * agent ids is dropped rather than trusted — the same stance app_panes takes with its ids — and a
 * payload with no usable swarm at all is treated as not sent.
 */
export function appSwarmsFrom(payload: unknown): AppSwarms | null {
  if (!payload || typeof payload !== 'object') return null
  const p = payload as Record<string, unknown>
  const rows = Array.isArray(p.swarms) ? p.swarms : []
  const swarms: AppSwarms['swarms'] = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'string' || !r.id || typeof r.name !== 'string') continue
    const agentIds = Array.isArray(r.agentIds)
      ? r.agentIds.filter((id): id is string => typeof id === 'string' && id !== '')
      : []
    // A window that predates this field says nothing about its tiles, and the honest reading of that
    // silence is the old one: as many tiles as agents. That keeps an older app behaving exactly as it
    // does today rather than having its tabs vanish from the dial for the opposite reason.
    const panes = typeof r.panes === 'number' && Number.isFinite(r.panes) && r.panes >= 0
      ? Math.min(Math.floor(r.panes), 999)
      : agentIds.length
    swarms.push({ id: r.id, name: r.name.slice(0, 80), agentIds, panes })
    if (swarms.length === 24) break   // the window's own ceiling
  }
  if (swarms.length === 0) return null
  const active = typeof p.active === 'string' && swarms.some((s) => s.id === p.active) ? p.active : swarms[0].id
  // Absent from a window that predates the field, and absent is the honest answer: the far side falls
  // back to deriving a shape from the count, which is what it did before any window sent one.
  const tiles: AppSwarms['tiles'] = []
  for (const row of Array.isArray(p.tiles) ? p.tiles : []) {
    if (!row || typeof row !== 'object') continue
    const t = row as Record<string, unknown>
    const n = (v: unknown): number | null =>
      typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(1000, Math.round(v))) : null
    const x1 = n(t.x1), y1 = n(t.y1), x2 = n(t.x2), y2 = n(t.y2)
    // A tile with no area is not a tile. Dropping it here rather than on the device keeps the far
    // side's rule simple: every row it receives is drawable.
    if (x1 === null || y1 === null || x2 === null || y2 === null || x2 <= x1 || y2 <= y1) continue
    tiles.push({ x1, y1, x2, y2, agentId: typeof t.agentId === 'string' ? t.agentId : '' })
    if (tiles.length === 24) break   // the window's own ceiling, same as the rows above
  }
  return { active, swarms, tiles }
}

