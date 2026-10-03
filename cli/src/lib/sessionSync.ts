import { isTerminalEngine } from '../engines/types.js'
import type { AgentFrame } from './agentFrame.js'
import type { RegisteredSession } from './registry.js'

export interface SessionSyncDeps {
  terminalAvailable(agentId: string): boolean
  project(session: RegisteredSession): Promise<AgentFrame>
  send(frame: { type: string; payload: Record<string, unknown> }): void
  sendCommander(frame: { type: string; payload: Record<string, unknown> }): void
  onUnavailable?(agentId: string): void
  onFailed?(agentId: string, detail: string): void
  warn(error: unknown): void
}

/** Publish registry updates to the app and the dial without treating a liveness hint as an ending. */
export function createSessionSync(deps: SessionSyncDeps) {
  return async (session: RegisteredSession, opts: { device?: boolean } = {}): Promise<void> => {
    // Plain terminals never appear on the dial. When an engine exits into a shell, the caller
    // removes the old dial row explicitly while keeping the shell available to the app.
    const device = opts.device !== false && !isTerminalEngine(session.engine)
    if (!deps.terminalAvailable(session.agentId)) {
      deps.onUnavailable?.(session.agentId)
      // load() clears terminal verification at every daemon start. Metadata can sync before
      // discovery restores it, so an app deletion here would permanently remove a live pane
      // from the shared desk. Only confirmed removal/retirement may send that deletion.
      // The dial still lists only usable agents; discovery will upsert this one when verified.
      if (device) deps.sendCommander({ type: 'agent_deleted', payload: { agentId: session.agentId } })
      return
    }
    if (session.launch?.state === 'failed') deps.onFailed?.(session.agentId, session.launch.detail ?? session.launch.error)
    try {
      const agent = await deps.project(session)
      const frame = { type: 'agent_synced', payload: { agent } }
      deps.send(frame)
      if (device) deps.sendCommander(frame)
    } catch (error) {
      deps.warn(error)
    }
  }
}
