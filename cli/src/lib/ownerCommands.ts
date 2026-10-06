import { CommandBarError, commandBarService, type CommandBarService } from './commandBar.js'
import type { LocalWsServerOptions } from '../localWsServer.js'
import { OWNER_COMMAND_TYPES } from './relayFrames.js'
export { OWNER_COMMAND_TYPES } from './relayFrames.js'

/** The same decisions and task delivery as the desktop, behind the paired-owner boundary.
 * A decision never executes an action. The client still reviews and commits the selected action. */
export class OwnerCommands {
  onRouteTask?: LocalWsServerOptions['onRouteTask']
  onRouteSend?: LocalWsServerOptions['onRouteSend']
  private readonly pending = new Map<AbortController, string>()
  constructor(private readonly commands: Pick<CommandBarService, 'decide'> = commandBarService) {}

  async request(connId: string, type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!OWNER_COMMAND_TYPES.has(type)) return { error: 'UNSUPPORTED' }
    if (this.pending.size >= 8 || [...this.pending.values()].filter(id => id === connId).length >= 2) return { error: 'BUSY' }
    const abort = new AbortController()
    this.pending.set(abort, connId)
    try {
      if (type === 'command_bar') return await this.commands.decide(payload.request, abort.signal)
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
    } catch (error) {
      return error instanceof CommandBarError
        ? { error: error.code, detail: error.message }
        : { error: 'COMMAND_UNAVAILABLE', detail: 'This machine could not complete the command. Try again.' }
    } finally { this.pending.delete(abort) }
  }

  closeConnection(connId: string): void {
    for (const [abort, id] of this.pending) if (id === connId) abort.abort()
  }
  closeAll(): void { for (const abort of this.pending.keys()) abort.abort() }
}
