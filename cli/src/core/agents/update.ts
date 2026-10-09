/**
 * `agent_update`: a person renamed an agent, moved it onto another model and effort, or an app opened it.
 * The reply is the agent's frame as it stands after; a rename is told to every window and the device,
 * and an open to every window, so all of them sort by the same "last used".
 *
 * Moved verbatim out of the socket's request switch (docs/design/2026-10-03-harnessd.md).
 */
import type { BackendSocket } from '../../backendSocket.js'
import type { AgentFrame } from '../../lib/agentFrame.js'
import type { CloseAgentService } from '../../lib/closeAgentService.js'
import { preview, sid } from '../../lib/log.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import { RuntimeProfileControlError, type RuntimeProfileErrorCode } from '../../lib/runtimeControl.js'

/** An `agent_update {opened: true}` for an agent opened less than this long ago is answered but not
 *  stamped or broadcast: a person flicking between two tabs, or two apps opening the same agent at
 *  once, would otherwise push a frame to every client for each flick. Exported for the spec. */
export const AGENT_OPENED_THROTTLE_MS = 3_000

export interface AgentUpdateDeps {
  registry: Pick<typeof registry, 'resolve' | 'rename' | 'markOpened' | 'terminalAvailable'>
  /** Moves an agent onto a model and effort (lib/runtimeProfileController.ts), or null while nothing can. */
  onRuntimeProfileUpdate: ((sessionId: string, selectedModel: string) => Promise<void>) | null
  /** Names the agent's pane after it, or null while nothing does. */
  onAgentRename: ((session: RegisteredSession, name: string) => void) | null
  /** The close service, once it exists: an agent a person opens is no longer one to close unseen. */
  closeAgentService: () => Pick<CloseAgentService, 'cancel'> | null
  /** An agent's frame, as the socket builds it for every reply. */
  toProject: (s: RegisteredSession) => Promise<AgentFrame>
  /** Every window, through the web audience (`send`), and the device (`sendCommander`). */
  clients: Pick<BackendSocket, 'send' | 'sendCommander'>
}

export function createAgentUpdate({
  registry, onRuntimeProfileUpdate, onAgentRename, closeAgentService, toProject, clients,
}: AgentUpdateDeps) {
  /** Answers `agent_update` through `reply`, before the windows hear of it. */
  const agentUpdate = async (payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void): Promise<void> => {
    const projectId = payload.agentId as string | undefined
    if (!projectId) { reply({ error: 'MISSING_AGENT_ID' }); return }
    const hasName = Object.prototype.hasOwnProperty.call(payload, 'name')
    const hasProfile = Object.prototype.hasOwnProperty.call(payload, 'selectedModel')
    // An app OPENED this agent — see RegisteredSession.lastOpenedAt. Only a literal `true`: a
    // client that means "opened" says so, and anything else is not an update at all. A client
    // reaching this handler is already one that may change the agent — a shared harness's
    // observer never gets here (sharing/owner.ts answers everything but terminal frames with
    // VIEW_ONLY) — so an open is taken from the local window, a paired web/phone session and a
    // remote desktop relayed through its own daemon alike.
    const hasOpened = payload.opened === true
    // An older client, and a request carrying none of the three, still get MISSING_UPDATE — which
    // is also what a client learns from a daemon that predates `opened`.
    if (!hasName && !hasProfile && !hasOpened) { reply({ error: 'MISSING_UPDATE' }); return }
    const name = typeof payload.name === 'string' ? payload.name.trim() : ''
    if (hasName && !name) { reply({ error: 'MISSING_NAME' }); return }
    let s = registry.resolve(projectId)
    if (!s) { reply({ error: 'AGENT_NOT_FOUND' }); return }
    if (hasProfile) {
      if (typeof payload.selectedModel !== 'string' || !onRuntimeProfileUpdate) {
        reply({ error: 'INVALID_RUNTIME_PROFILE' })
        return
      }
      try {
        await onRuntimeProfileUpdate(projectId, payload.selectedModel)
      } catch (error) {
        const code: RuntimeProfileErrorCode | 'INTERNAL' = error instanceof RuntimeProfileControlError ? error.code : 'INTERNAL'
        reply({ error: code })
        return
      }
    }
    if (hasName) {
      s = registry.rename(projectId, name) ?? s
      onAgentRename?.(s, name)
    }
    // Throttled on the stamp the row already carries, so a repeat inside the window is answered
    // with the current frame but moves nothing and tells no one. A stamp from the future (the
    // clock was set back) never throttles: the next open corrects it.
    let opened = false
    if (hasOpened) {
      closeAgentService()?.cancel(s.agentId)
      const since = Date.now() - (s.lastOpenedAt ?? 0)
      if (!s.lastOpenedAt || since < 0 || since >= AGENT_OPENED_THROTTLE_MS) {
        s = registry.markOpened(s.agentId) ?? s
        opened = true
      }
    }
    const agent = await toProject(s)
    reply({ agent })
    // Every app sorts by the same stamp, so every app hears it: the web audience — the phone,
    // other desktops, and this computer's own windows — through `send`. Not the device: the dial
    // lists agents in creation order and has nothing to reorder. Not for an agent whose terminal
    // this daemon cannot see either, the rule `syncSession` (cli.ts) keeps: that row is not in
    // `agents_list`, and a push would put it back on every screen.
    if (opened && registry.terminalAvailable(s.agentId)) {
      clients.send({ type: 'agent_synced', payload: { agent } })
    }
    if (hasName) {
      const renamed = { type: 'agent_renamed', payload: { agentId: s.agentId, name, engine: s.engine } }
      clients.send(renamed)          // every OTHER web client on this machine (group-encrypted)
      clients.sendCommander(renamed) // and the device
      // The whole rename path was silent end to end, which is why "web1 renamed it, web2 never saw
      // it" had no evidence to work from: nothing said whether the request even arrived. One line
      // here splits the question in two — no line means it never reached the adapter, a line means
      // the fan-out is downstream.
      console.log(`[rename] ${sid(projectId)} → "${preview(name, 40)}" · broadcast to web + device`)
    }
  }

  return { agentUpdate }
}
