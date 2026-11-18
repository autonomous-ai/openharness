/**
 * Forgetting a session: release a mutable session binding (the agent stays, its session goes), or
 * remove a process-owned agent everywhere — archived as stopped, and every per-session store the core
 * keeps let go of, so a daemon that runs for days does not grow with every session it ever saw.
 *
 * Moved verbatim out of `runForeground` (the core boundary, step 10: docs/design/2026-10-03-harnessd.md).
 */
import type { CursorTranscriptDiscovery } from '../../engines/cursor/discovery.js'
import type { TurnRecaps } from '../turns/recaps.js'
import type { ShortTurnGuard } from '../turns/shortTurnGuard.js'
import { sid } from '../../lib/log.js'
import { sameProcessIdentity } from '../../lib/terminalRuntime.js'
import { matchesLaunchReceipt, withHermesHome, type RegisteredSession, type RegistryAuthority, type registry } from '../../lib/registry.js'
import { IdentityReadUnavailable } from '../../engines/kit/identityScan.js'
import type { RuntimeProfileManager } from '../../lib/runtimeProfile.js'
import type { SessionInputController } from '../../lib/sessionInput.js'
import type { StoppedAgentStore } from '../../lib/stoppedAgents.js'
import type { Watcher } from '../../watcher/watcher.js'
import type { SessionNormalizers } from '../transcripts/normalizers.js'
import type { RelaunchMarks } from '../transcripts/relaunch.js'
import type { ConversationOwners } from './conversationOwners.js'

type Frame = { type: string; payload: Record<string, unknown> }

export interface ForgetDeps {
  onRemoved?: (agentId: string) => void
  /** One owner per conversation, stopped harnesses included (conversationOwners.ts). */
  owners?: Pick<ConversationOwners, 'settleSaved'>
  registry: Pick<typeof registry, 'resolve' | 'bySession' | 'confirmEngineExit' | 'confirmSessionUnbound'>
  stoppedAgents: Pick<StoppedAgentStore, 'save'>
  syncRecapPool: () => void
  normalizers: Pick<SessionNormalizers, 'forget'>
  forgetAttach: (sessionId: string) => void
  turnStartedAt: Map<string, number>
  /** The short-turn guard's count and hold for each session (turns/shortTurnGuard.ts): gone with the session. */
  shortTurns?: Pick<ShortTurnGuard, 'forget'>
  /** Each agent's kept prompt (turns/funnel.ts), by agent: gone with the agent. */
  prompts: Map<string, string>
  /** Attach's two per-session marks (core/transcripts/attach.ts). */
  neverFoldedHistory: Set<string>
  replayedFirstTurn: Set<string>
  relaunchMarks?: Pick<RelaunchMarks, 'forget'>
  clearAgyIdleWatch: (sessionId: string) => void
  cursorDiscovery: Pick<CursorTranscriptDiscovery, 'remove'>
  runtimeProfiles: Pick<RuntimeProfileManager, 'forget'>
  watcher: Pick<Watcher, 'removeSession'>
  stopHeartbeat: (sessionId: string) => void
  input: Pick<SessionInputController, 'forget'>
  /** The agent no longer runs here: its DSH viewer and its browser let go (core/main.ts `agentEnded`). */
  ended: (agentId: string) => void
  mirror: Pick<TurnRecaps, 'forget'>
  /** The app (`send`) and the dial (`sendCommander`). */
  clients: { send(frame: Frame): void; sendCommander(frame: Frame): void }
}

export interface ForgetOptions {
  force?: boolean
  keepAgent?: boolean
  agentId?: string
  captured?: RegisteredSession
  authority?: RegistryAuthority
}

export function createForgetSession({
  registry, stoppedAgents, syncRecapPool, normalizers, forgetAttach, turnStartedAt, prompts, neverFoldedHistory, replayedFirstTurn, relaunchMarks,
  clearAgyIdleWatch, cursorDiscovery, runtimeProfiles, watcher, stopHeartbeat, input,
  ended, mirror, clients, onRemoved, owners, shortTurns,
}: ForgetDeps) {
  /** Release a mutable session binding, or remove the process-owned agent everywhere. */
  const forgetSession = async (
    id: string,
    opts: ForgetOptions = {},
  ): Promise<void> => {
    // A retired session may already belong to another agent. An explicit old agent id
    // is the selection, never a reason to resolve that reused session again.
    const selected = registry.resolve(opts.agentId ?? id)
    const doomed = selected ? structuredClone(selected) : undefined
    const authority = doomed ? { ...opts.authority, current: () => opts.authority?.current?.() !== false
      && matchesLaunchReceipt(registry.resolve(doomed.agentId), doomed) } : opts.authority
    const verify = () => {
      if (authority?.current?.() === false) throw new IdentityReadUnavailable('the selected session changed before removal')
    }
    const sessionId = opts.keepAgent ? (doomed?.agentId === id ? doomed.sessionId : id) : doomed?.sessionId || id
    // Clients key on the AGENT id. Normally it is read off the entry, but an
    // agent already removed from the registry cannot be looked up — and
    // announcing its sessionId instead is silently useless: the app takes
    // payload.agentId verbatim, matches nothing, and leaves the dead row on
    // screen. Callers who know the id pass it.
    const announceId = doomed?.agentId ?? opts.agentId ?? sessionId

    if (!opts.keepAgent && doomed) {
      verify()
      const captured = opts.captured
      if (captured && (captured.agentId !== doomed.agentId || captured.engine !== doomed.engine
        || captured.registeredAt !== doomed.registeredAt || doomed.sessionId && captured.sessionId !== doomed.sessionId
        || captured.processIdentity && (!sameProcessIdentity(captured.processIdentity, doomed.processIdentity)
          || captured.processIdentity.executable !== doomed.processIdentity?.executable))) {
        throw new Error('The harness changed before its captured conversation could be retained.')
      }
      // Stop may prove a parent path while the live row still names an overwritten child.
      // Preserve that capture through this last archive, including intervening hook saves.
      await stoppedAgents.save(captured ? withHermesHome({ ...doomed, sessionId: captured.sessionId, transcriptPath: captured.transcriptPath,
        boundAt: captured.boundAt, source: captured.source }, captured) : doomed, authority?.current)
    }
    if (doomed && (!opts.keepAgent || doomed.sessionId === sessionId)) {
      verify()
      const publication = opts.keepAgent
        ? await registry.confirmSessionUnbound(doomed.agentId, sessionId, authority)
        : await registry.confirmEngineExit(doomed.agentId, 'remove', authority)
      const latest = registry.resolve(doomed.agentId)
      if (publication.state !== 'confirmed' || (opts.keepAgent ? !publication.entry || !matchesLaunchReceipt(latest, publication.entry) : !!latest)) {
        throw new IdentityReadUnavailable('the selected session removal is not durably confirmed')
      }
    }
    console.log(opts.keepAgent
      ? `[agent] ${sid(announceId)} released session ${sid(sessionId)}`
      : `[agent] ${sid(announceId)} forgotten`)
    // No longer running, its last record may still hold a conversation another harness took meanwhile: the
    // save keeps a known one through an unbound row (StoppedAgentStore.save). One owner each from here on.
    if (!opts.keepAgent && doomed) {
      try { await owners?.settleSaved(doomed.agentId) }
      catch (error) { console.warn(`[agent] ${sid(doomed.agentId)} could not settle who owns its conversation: ${error instanceof Error ? error.message : error}`) }
    }
    syncRecapPool()
    // Publication can finish after another agent acquired the old session. Its reader/state
    // belongs to that replacement now; only this retired agent's stores may be released.
    const owner = sessionId ? registry.bySession(sessionId) : undefined
    if (!owner || owner.agentId === announceId) {
      normalizers.forget(sessionId)
      forgetAttach(sessionId)
      turnStartedAt.delete(sessionId)
      shortTurns?.forget(sessionId)
      neverFoldedHistory.delete(sessionId)
      replayedFirstTurn.delete(sessionId)
      relaunchMarks?.forget(sessionId)
      clearAgyIdleWatch(sessionId)
      cursorDiscovery.remove(sessionId)
      runtimeProfiles.forget(sessionId)
      void watcher.removeSession(sessionId)
      stopHeartbeat(sessionId)
      mirror.forget(sessionId)
    }
    input.forget(announceId)
    if (!opts.keepAgent) { ended(announceId); onRemoved?.(announceId); prompts.delete(announceId) }
    if (opts.keepAgent) return
    clients.send({ type: 'agent_deleted', payload: { agentId: announceId, retained: !!doomed } }) // web tab
    clients.sendCommander({ type: 'agent_deleted', payload: { agentId: announceId } })
  }
  return forgetSession
}
