import { usageTargetKey, type AgentUsageTarget } from '../../lib/agentUsageWire.js'
/**
 * Telling the app and the dial about an agent: its frame (sync), its name (rename), both at once
 * (announce), and a fresh frame when its token usage moves, for a live agent or a stopped one.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 3: docs/design/2026-10-03-harnessd.md);
 * the registry, the stopped-agent archive and the socket are passed in.
 */
import { isTerminalEngine } from '../../engines/types.js'
import type { AgentFrame } from '../../lib/agentFrame.js'
import { projectDisplayName, type RegisteredSession } from '../../lib/registry.js'
import { createSessionSync } from '../../lib/sessionSync.js'

type Frame = { type: string; payload: Record<string, unknown> }

/** Where announcements go: the app (`send`) and the dial (`sendCommander`). */
export interface AnnounceSink {
  send(frame: Frame): void
  sendCommander(frame: Frame): void
  publishStoppedAgent(s: RegisteredSession): Promise<void>
}

/** The agent whose token usage changed, as the usage cache names it. */
export type TokenUsageTarget = AgentUsageTarget

export interface AgentEventDeps {
  /** The socket, read as each frame goes out; undefined until it exists. */
  sink: () => AnnounceSink | undefined
  terminalAvailable: (agentId: string) => boolean
  resolve: (target: string) => RegisteredSession | undefined
  /** A stopped agent's archived record (stoppedAgents.get), which may throw while it is being removed. */
  stopped: (agentId: string) => RegisteredSession | null
  project: (s: RegisteredSession) => Promise<AgentFrame>
}

export function createAgentEvents({ sink, terminalAvailable, resolve, stopped, project }: AgentEventDeps) {
  const syncSession = createSessionSync({
    terminalAvailable: (agentId) => terminalAvailable(agentId),
    project: (s) => project(s),
    send: (frame) => sink()?.send(frame),
    sendCommander: (frame) => sink()?.sendCommander(frame),
    warn: (err) => console.error('[cli] announceSession failed:', err instanceof Error ? err.message : err),
  })
  const announceRename = (s: RegisteredSession, opts: { device?: boolean } = {}): void => {
    if (isTerminalEngine(s.engine)) opts = { ...opts, device: false }
    const name = projectDisplayName(s)
    sink()?.send({ type: 'agent_renamed', payload: { agentId: s.agentId, name, engine: s.engine } })
    if (opts.device !== false) sink()?.sendCommander({ type: 'agent_renamed', payload: { agentId: s.agentId, name, engine: s.engine } })
  }
  const onTokenUsageChanged = (target: TokenUsageTarget): void => {
    const current = resolve(target.agentId)
    if (current && usageTargetKey(current) === usageTargetKey(target)) {
      if (terminalAvailable(current.agentId)) syncSession(current, { device: false })
      return
    }
    try {
      const saved = stopped(target.agentId)
      if (saved && usageTargetKey(saved) === usageTargetKey(target)) {
        void sink()?.publishStoppedAgent(saved).catch(() => {})
      }
    } catch { /* A concurrently removed archive has nothing to update. */ }
  }
  // New process observations, session bindings, runtime-profile changes, reconnects and periodic
  // reconciliation refresh web and device from the same authoritative snapshot. Device agent_synced is
  // idempotent and can upsert a sessionless tile, so re-announcing at bind is both safe and necessary.
  const announceSession = (s: RegisteredSession, opts: { device?: boolean } = {}): void => {
    syncSession(s, opts)
    announceRename(s, opts)
  }
  return { syncSession, announceRename, announceSession, onTokenUsageChanged }
}

export type AgentEvents = ReturnType<typeof createAgentEvents>
