/** Cleanup keeps every open tab, including background tabs and local utility panes. */
import type { RegisteredSession } from './registry.js'
import { terminalRouteKey } from './terminalRuntime.js'

export class OpenTabError extends Error {
  constructor(readonly code: string, message: string) { super(message) }
}

export class OpenTabProtection {
  private readonly windows = new Map<string, Set<string>>()
  private shared = new Set<string>()
  private revision = -1
  constructor(private readonly deps: {
    machineId(): string
    sessions(): RegisteredSession[]
    readDesk(): Promise<{ status: number; body: Record<string, unknown> }>
  }) {}

  /** Each window owns its roster. Closing one window must not clear another one's tabs. */
  updateWindow(connection: string, ids: string[] | null): void {
    if (ids === null) this.windows.delete(connection)
    else this.windows.set(connection, new Set(ids))
  }

  async refresh(): Promise<void> {
    const unavailable = () => new OpenTabError('TABS_UNAVAILABLE', 'Could not check your open tabs. Nothing was closed.')
    const reply = await this.deps.readDesk()
    const data = reply.body.data as { revision?: unknown; tabs?: unknown } | undefined
    if (reply.status !== 200 || reply.body.success !== true || !data || !Array.isArray(data.tabs)
      || typeof data.revision !== 'number' || !Number.isSafeInteger(data.revision)) throw unavailable()
    const ids = new Set<string>()
    for (const tab of data.tabs) {
      if (!tab || !Array.isArray(tab.panes)) throw unavailable()
      for (const pane of tab.panes) {
        if (!pane || typeof pane.machineId !== 'string' || !pane.machineId
          || typeof pane.agentId !== 'string' || !pane.agentId) throw unavailable()
        if (pane.machineId === this.deps.machineId()) ids.add(pane.agentId)
      }
    }
    // Concurrent preview/close reads can finish out of order.
    if (data.revision < this.revision) throw unavailable()
    this.shared = ids
    this.revision = data.revision
  }

  isHidden(session: RegisteredSession): boolean {
    const ids = new Set([...this.shared, ...[...this.windows.values()].flatMap(ids => [...ids])])
    if (ids.has(session.agentId)) return false
    // Two registry aliases can describe one terminal. Keep the entire placement if either is open.
    const routes = new Set(this.deps.sessions().filter(s => ids.has(s.agentId)).flatMap(s => s.runtimes.map(terminalRouteKey)))
    return !session.runtimes.some(r => routes.has(terminalRouteKey(r)))
  }

  async assertHidden(session: RegisteredSession): Promise<void> {
    await this.refresh()
    if (!this.isHidden(session)) throw new OpenTabError('SESSION_IN_TAB', 'This harness is in an open tab. Kept open.')
  }
}
