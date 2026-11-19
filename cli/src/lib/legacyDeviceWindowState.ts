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

export function createLegacyDeviceWindowState(hooks: LegacyDeviceWindowHooks) {
  const panes = new Map<string, { ids: string[]; foreground: boolean }>()
  const tabs = new Map<string, AppSwarms>()
  let hadPanes = false
  // Old clients never removed the last unread snapshot when their socket closed.
  let unread: UnreadNotification[] = []
  return {
    receive(connection: string, type: string, payload: Record<string, unknown> | undefined): boolean {
      if (type === 'app_panes') {
        hadPanes = true
        const state = appPanesFrom(payload)
        panes.delete(connection); panes.set(connection, state)
        hooks.onAppPanes?.(state.ids, state.foreground)
      } else if (type === 'app_swarms') {
        const state = appSwarmsFrom(payload)
        if (!state) return false
        tabs.delete(connection); tabs.set(connection, state)
        try { hooks.onAppSwarms?.(state) }
        finally { hooks.onAppTabAgents?.(connection, state.swarms.flatMap(row => row.agentIds)) }
      } else if (type === 'app_unread') {
        unread = appUnreadFrom(payload)
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
      const latestPane = [...panes.keys()].at(-1) === connection
      panes.delete(connection)
      const hadTabs = tabs.has(connection), latestTabs = [...tabs.keys()].at(-1) === connection
      tabs.delete(connection)
      // Membership ends even if optional device presentation fails while the window closes.
      try {
        if (latestPane) {
          const state = [...panes.values()].at(-1)
          hooks.onAppPanes?.(state?.ids ?? [], state?.foreground ?? false)
        }
      } finally {
        try { if (latestTabs) hooks.onAppSwarms?.([...tabs.values()].at(-1) ?? null) }
        finally { if (hadTabs) hooks.onAppTabAgents?.(connection, null) }
      }
    },
    snapshot(): LegacyDeviceWindowSnapshot {
      const desk = [...panes.values()].at(-1)
      return { desk: desk?.ids ?? [], foreground: desk?.foreground ?? !hadPanes,
        swarms: [...tabs.values()].at(-1) ?? null, unread }
    },
  }
}
