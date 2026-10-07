import type { LocalWsServerOptions } from '../localWsServer.js'
import { ROUTE_COMMAND_TYPES } from './relayFrames.js'
export { OWNER_COMMAND_TYPES, ROUTE_COMMAND_TYPES } from './relayFrames.js'

/** ⌘K's task delivery from a remote owner's app, as the desktop does it, behind the paired-owner boundary.
 * The command bar's decisions, which never execute an action, are a service of their own
 * (services/commandBar.ts); the client still reviews and commits the selected action. */
export class OwnerCommands {
  onRouteTask?: LocalWsServerOptions['onRouteTask']
  onRouteSend?: LocalWsServerOptions['onRouteSend']
  private readonly pending = new Map<AbortController, string>()

  async request(connId: string, type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!ROUTE_COMMAND_TYPES.has(type)) return { error: 'UNSUPPORTED' }
    if (this.pending.size >= 8 || [...this.pending.values()].filter(id => id === connId).length >= 2) return { error: 'BUSY' }
    const abort = new AbortController()
    this.pending.set(abort, connId)
    try {
      const text = typeof payload.text === 'string' ? payload.text.trim() : ''
      if (!text || text.length > 16_000) return { error: 'INVALID_REQUEST' }
      if (type === 'route_task') {
        if (!this.onRouteTask) return { error: 'UNSUPPORTED' }
        return { ...await this.onRouteTask(text) }
      }
      const agentId = payload.agentId
      if (typeof agentId !== 'string' || !agentId.length || agentId.length > 160) return { error: 'INVALID_REQUEST' }
      if (!this.onRouteSend) return { error: 'UNSUPPORTED' }
      return await this.onRouteSend(agentId, text)
    } catch {
      return { error: 'COMMAND_UNAVAILABLE', detail: 'This machine could not complete the command. Try again.' }
    } finally { this.pending.delete(abort) }
  }

  closeConnection(connId: string): void {
    for (const [abort, id] of this.pending) if (id === connId) abort.abort()
  }
  closeAll(): void { for (const abort of this.pending.keys()) abort.abort() }
}
