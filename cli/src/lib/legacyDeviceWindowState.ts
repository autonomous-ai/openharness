/**
 * Desktop compatibility until thirty days after a release with ordering-safe desk replay.
 * The release receipt supplies that deadline; a source-edit date cannot expire a supported client.
 * Loaded only on an old physical client's first desk frame, never in the eager core graph.
 */
import type { AppSwarms } from '../cable/cableSession.js'
import { notificationReadToken, type UnreadNotification } from './notificationRead.js'
import { appPanesFrom, appSwarmsFrom, appUnreadFrom } from './deviceWindowState.js'

export interface LegacyDeviceWindowSnapshot {
  desk: string[]
  foreground: boolean
  swarms: AppSwarms | null
  unread: UnreadNotification[]
}

export interface LegacyDeviceWindowHooks {
  onAppPanes?: (ids: string[], foreground: boolean) => void
  onAppSwarms?: (swarms: AppSwarms | null) => void
  onAppUnread?: (items: UnreadNotification[]) => void
  onAppTabAgents?: (connection: string, ids: string[] | null) => void
  onAgentSeen?: (agentId: string, readToken?: string) => void
}

// Match the first-load FIFO's admitted envelope without sharing its tuning constants.
const MAX_REPORTERS = 128
const MAX_RETAINED_BYTES = 8 * 1024 * 1024

export function createLegacyDeviceWindowState(hooks: LegacyDeviceWindowHooks) {
  const panes = new Map<string, { ids: string[]; foreground: boolean; bytes: number }>()
  const tabs = new Map<string, { state: AppSwarms; bytes: number }>()
  let retainedBytes = 0, reporters = 0, unreadBytes = 0
  let hadPanes = false
  // Old clients never removed the last unread snapshot when their socket closed.
  let unread: UnreadNotification[] = []
  const reserve = (connection: string, kind: 'panes' | 'tabs' | 'unread', bytes: number): void => {
    const previous = kind === 'unread' ? unreadBytes : (kind === 'panes' ? panes : tabs).get(connection)?.bytes ?? 0
    const adding = kind !== 'unread' && !panes.has(connection) && !tabs.has(connection)
    if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > MAX_RETAINED_BYTES - retainedBytes + previous
      || adding && reporters === MAX_REPORTERS) {
      throw Object.assign(new Error('Legacy desk state capacity exceeded'), { code: 'LEGACY_DESK_STATE_LIMIT' })
    }
    retainedBytes += bytes - previous
    if (adding) reporters++
    if (kind === 'unread') unreadBytes = bytes
  }
  return {
    receive(connection: string, type: string, payload: Record<string, unknown> | undefined, bytes: number): boolean {
      if (type === 'app_panes') {
        const state = appPanesFrom(payload)
        reserve(connection, 'panes', bytes)
        hadPanes = true
        panes.delete(connection); panes.set(connection, { ...state, bytes })
        hooks.onAppPanes?.(state.ids, state.foreground)
      } else if (type === 'app_swarms') {
        const state = appSwarmsFrom(payload)
        if (!state) return false
        reserve(connection, 'tabs', bytes)
        tabs.delete(connection); tabs.set(connection, { state, bytes })
        try { hooks.onAppSwarms?.(state) }
        finally { hooks.onAppTabAgents?.(connection, state.swarms.flatMap(row => row.agentIds)) }
      } else if (type === 'app_unread') {
        const next = appUnreadFrom(payload)
        reserve(connection, 'unread', bytes)
        unread = next
        hooks.onAppUnread?.(unread)
      } else if (type === 'agent_seen') {
        const agentId = payload?.agentId, rawToken = payload?.readToken
        const readToken = notificationReadToken(rawToken)
        if (rawToken !== undefined && !readToken) return false
        if (typeof agentId !== 'string' || !agentId) return false
        hooks.onAgentSeen?.(agentId, readToken)
      } else return false
      return true
    },
    closed(connection: string): void {
      const pane = panes.get(connection), tab = tabs.get(connection)
      // Physical close can arrive twice. Release before callbacks, once for each retained reporter.
      if (pane || tab) reporters--
      retainedBytes -= (pane?.bytes ?? 0) + (tab?.bytes ?? 0)
      const latestPane = [...panes.keys()].at(-1) === connection
      panes.delete(connection)
      const hadTabs = tab !== undefined, latestTabs = [...tabs.keys()].at(-1) === connection
      tabs.delete(connection)
      // Membership ends even if optional device presentation fails while the window closes.
      try {
        if (latestPane) {
          const state = [...panes.values()].at(-1)
          hooks.onAppPanes?.(state?.ids ?? [], state?.foreground ?? false)
        }
      } finally {
        try { if (latestTabs) hooks.onAppSwarms?.([...tabs.values()].at(-1)?.state ?? null) }
        finally { if (hadTabs) hooks.onAppTabAgents?.(connection, null) }
      }
    },
    snapshot(): LegacyDeviceWindowSnapshot {
      const desk = [...panes.values()].at(-1)
      return { desk: desk?.ids ?? [], foreground: desk?.foreground ?? !hadPanes,
        swarms: [...tabs.values()].at(-1)?.state ?? null, unread }
    },
  }
}
