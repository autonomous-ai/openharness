/**
 * Which of its agents the Swarm may close or reopen, decided in the core's process from the core's own live registry,
 * stopped records and creation receipts, never from the Super Tab service's possibly old snapshot: the Swarm's original
 * start alone (`closeSwarm`), a stopped Lead its host keeps (`keepLeadAlive`), a member its host retains or whose start
 * receipt names it (`closeMember`). The core offers these only while the Swarm is on (core/api.ts `swarmAgents`).
 */
import type { SwarmAgentDeps, SwarmAgents } from '../../core/api.js'
import { PURGE_RECORD_UNREADABLE } from './teamPurge.js'

export function createSwarmAgents({ byAgent, stoppedIds, closeAgent, resumeAgent, creationStatus, members, purgeEnded }: SwarmAgentDeps & {
  /** The Leads and members this machine's Super Tab host keeps (superTabs/retention.ts). */
  members: { leads(): Set<string>; harnesses(): Set<string> }
  /** On a Team daemon, deletes the session data of a confidential member the Swarm ended (inCore/teamApps.ts); absent elsewhere. */
  purgeEnded?: (agentId: string) => Promise<Record<string, unknown>>
}): SwarmAgents {
  /** A member the Swarm ended for good, closed or already gone: its data goes where the Team daemon says so. Until it has,
   *  the close fails, so its host tries again with backoff (superTabs/host.ts endSession) and its Team account stays held
   *  (security re-check 1 and 2 of #2089). The close's own answer when there is nothing to delete or it went. */
  const ended = async <T>(agentId: string, closed: T): Promise<T | { error: 'PURGE_FAILED'; detail: string }> => {
    if (!purgeEnded) return closed
    const said = await purgeEnded(agentId).catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }))
    if (typeof said.error !== 'string') return closed
    const detail = typeof (said as Record<string, unknown>).detail === 'string' ? (said as Record<string, unknown>).detail as string : said.error
    // An unreadable record was said once, where it was kept; its host logs each refused retry (review of #2142).
    if (said.error !== PURGE_RECORD_UNREADABLE) console.warn(`[super-tabs] could not delete the session data of ${agentId}: ${detail}`)
    return { error: 'PURGE_FAILED', detail }
  }
  return {
    closeSwarm: async request => {
      const session = byAgent(request.agentId)
      // This is the authoritative live registry, not a service's possibly old snapshot or a failed read.
      if (!session) return ended(request.agentId, { closed: true as const })
      // A reopen (resume-only) of the same conversation is still the Swarm's session: the identity below proves it.
      if (session.startedBy !== 'agent' || !request.creationId || typeof request.sessionId !== 'string' || !request.createdAt) return { error: 'NOT_SWARM_STARTED' }
      if (session.sessionId !== request.sessionId || session.registeredAt !== Date.parse(request.createdAt)) return { error: 'AGENT_CHANGED' }
      if (!Number.isFinite(request.expiresAt) || request.expiresAt! <= Date.now()) return { error: 'STOP_LEASE_EXPIRED' }
      const creation = await creationStatus?.(request.creationId)
      if (creation?.state !== 'created' || creation.agentId !== request.agentId) return { error: 'NOT_SWARM_STARTED' }
      if (request.expiresAt! <= Date.now()) return { error: 'STOP_LEASE_EXPIRED' }
      const latest = byAgent(request.agentId)
      if (!latest || latest.startedBy !== 'agent' || latest.sessionId !== request.sessionId
        || latest.registeredAt !== Date.parse(request.createdAt)) return { error: 'AGENT_CHANGED' }
      if (!closeAgent) return { error: 'UNSUPPORTED' }
      const closed = await closeAgent({ agentId: request.agentId, sessionId: request.sessionId, createdAt: request.createdAt, mode: 'now', onlyIfOriginalLaunch: true, expiresAt: request.expiresAt })
      return 'closed' in closed && closed.closed ? ended(request.agentId, closed) : closed
    },
    keepLeadAlive: async agentId => {
      if (!resumeAgent) return { ok: false, error: 'UNSUPPORTED' }
      if (byAgent(agentId)) return { ok: true }
      if (!members.leads().has(agentId) || !stoppedIds().includes(agentId)) {
        return { ok: false, error: 'NOT_A_LEAD', detail: 'Only a stopped Product Manager of a Swarm project is reopened.' }
      }
      const reply = await resumeAgent(agentId)
      return reply.ok ? { ok: true } : { ok: false, error: reply.error, ...(reply.detail ? { detail: reply.detail } : {}) }
    },
    closeMember: async (agentId, creationId) => {
      if (!closeAgent) return { error: 'UNSUPPORTED' }
      const session = byAgent(agentId)
      if (!session) return ended(agentId, { closed: true as const })
      let member = false
      try { member = members.harnesses().has(agentId) } catch { /* An unreadable retention names no member. */ }
      // An agent removed before its host wrote a roster naming it: the Swarm's own start receipt proves it (the review of #1635).
      if (!member && creationId) {
        const creation = await creationStatus?.(creationId)
        member = creation?.state === 'created' && creation.agentId === agentId
      }
      if (!member) return { error: 'NOT_A_MEMBER' }
      // The close itself refuses a session that changed during the receipt read.
      const closed = await closeAgent({ agentId, sessionId: session.sessionId, createdAt: new Date(session.registeredAt).toISOString(), mode: 'now' })
      return 'closed' in closed && closed.closed ? ended(agentId, closed) : closed
    },
  }
}
