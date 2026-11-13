/**
 * The Swarm's closes and reopens of its own agents, in its own process. The core decided them for it in the Swarm's door
 * until 2026-11-13 (superTabs/inCore/agents.ts), and refused to stop its Product Managers: the Swarm is an experiment, and an
 * experiment never touches the core (anh Dee, 2026-11-13). Each is checked here, against what this process knows (its
 * retention, superTabs/retention.ts, and the core's creation receipts), and carried out by the requests any client of the
 * core sends, as this computer's owner's tool (agentClient/daemon.ts): `agent_close`, which the core refuses for an agent
 * whose conversation changed, and `agent_resume`. A Product Manager closes as any agent does; the host reopens it
 * (superTabs/host.ts keepAlive).
 */
import { openDaemon, type Daemon, type Where } from '../agentClient/daemon.js'
import type { CoreApi } from '../core/api.js'
import type { AgentCloseResult } from '../lib/closeAgentService.js'
import { retainedHarnesses, retainedLeads } from './retention.js'

type Reopened = { ok: true } | { ok: false; error: string; detail?: string }

export interface OwnAgents {
  /** Close only the native identity the Swarm started, in that start, while its lease holds. One no longer live is closed. */
  closeSwarm?(request: { agentId: string; creationId?: string; sessionId?: string; createdAt?: string; expiresAt?: number }): Promise<AgentCloseResult>
  /** Reopen a Lead whose session is gone, on its own conversation, as a resume does: nothing is typed into it. Only an agent
   *  stopped here that this machine's retention keeps as the Lead of an active project; a live one is answered ok. */
  keepLeadAlive?(agentId: string): Promise<Reopened>
  /** Close, now and keeping its conversation, a member whose session the backend ends: only one this machine's retention
   *  keeps, or one whose exact creation receipt [creationId] (the Swarm's start) names. One no longer live is closed. */
  closeMember?(agentId: string, creationId?: string): Promise<AgentCloseResult>
}
/** The core's API as the Swarm's service holds it: its own closes and reopens beside what the core offers every service. */
export type SwarmCore = CoreApi & { agents: CoreApi['agents'] & OwnAgents }

/** How long a close or a resume may take: an engine saves and exits, or starts again. */
const ASK_MS = 60_000

export function withOwnAgents(core: CoreApi, open: (where: Where) => Promise<Daemon> = openDaemon): SwarmCore {
  const ask = async (type: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const daemon = await open({ dataDir: core.dataDir, port: core.daemon.port, machineId: core.daemon.machineId() })
    try { return await daemon.request(type, payload, ASK_MS) } finally { daemon.close() }
  }
  const failed = (answer: Record<string, unknown>, fallback: string) => ({ error: typeof answer.error === 'string' ? answer.error : fallback,
    ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) })
  const unreachable = (error: unknown) => ({ error: 'CORE_UNREACHABLE', detail: error instanceof Error ? error.message : String(error) })
  // Not live, as the core says now: stopped, or gone. What this process holds of the live agents can lag behind it, so an
  // agent it does not see that the core does not say ended is tried again, never taken as closed or as refused for good.
  const absent = async (agentId: string): Promise<AgentCloseResult> =>
    await core.agents.stopped?.(agentId) === true || await core.agents.gone?.(agentId) === true
      ? { closed: true } : { error: 'UNCONFIRMED', detail: 'The core did not say it ended.' }
  const closeNow = async (agentId: string, sessionId: string, createdAt: string): Promise<AgentCloseResult> => {
    try {
      const answer = await ask('agent_close', { agentId, sessionId, createdAt, mode: 'now' })
      return answer.closed === true ? { closed: true } : failed(answer, 'CLOSE_FAILED')
    } catch (error) { return unreachable(error) }
  }
  const own: Required<OwnAgents> = {
    closeSwarm: async request => {
      const session = core.agents.byAgent(request.agentId)
      if (!session) return absent(request.agentId)
      // A reopen (resume-only) of the same conversation is still the Swarm's session: the identity below proves it.
      if (session.startedBy !== 'agent' || !request.creationId || typeof request.sessionId !== 'string' || !request.createdAt) return { error: 'NOT_SWARM_STARTED' }
      if (session.sessionId !== request.sessionId || session.registeredAt !== Date.parse(request.createdAt)) return { error: 'AGENT_CHANGED' }
      if (!Number.isFinite(request.expiresAt) || request.expiresAt! <= Date.now()) return { error: 'STOP_LEASE_EXPIRED' }
      const creation = await core.agents.creationStatus?.(request.creationId)
      if (creation?.state !== 'created' || creation.agentId !== request.agentId) return { error: 'NOT_SWARM_STARTED' }
      if (request.expiresAt! <= Date.now()) return { error: 'STOP_LEASE_EXPIRED' }
      // The core closes it only while it is still this conversation, started then (`agent_close`'s identity).
      return closeNow(request.agentId, request.sessionId, request.createdAt)
    },
    keepLeadAlive: async agentId => {
      if (core.agents.byAgent(agentId)) return { ok: true }
      if (!retainedLeads(core.dataDir).has(agentId) || await core.agents.stopped?.(agentId) !== true) {
        return { ok: false, error: 'NOT_A_LEAD', detail: 'Only a stopped Product Manager of a Swarm project is reopened.' }
      }
      try {
        const answer = await ask('agent_resume', { agentId })
        return answer.error === undefined ? { ok: true } : { ok: false, ...failed(answer, 'RESUME_FAILED') }
      } catch (error) { return { ok: false, ...unreachable(error) } }
    },
    closeMember: async (agentId, creationId) => {
      const session = core.agents.byAgent(agentId)
      if (!session) return absent(agentId)
      let member = false
      try { member = retainedHarnesses(core.dataDir).has(agentId) } catch { /* An unreadable retention names no member. */ }
      // An agent removed before its host wrote a roster naming it: the Swarm's own start receipt proves it (the review of #1635).
      if (!member && creationId) {
        const creation = await core.agents.creationStatus?.(creationId)
        member = creation?.state === 'created' && creation.agentId === agentId
      }
      if (!member) return { error: 'NOT_A_MEMBER' }
      // The core refuses a session that changed during the receipt read.
      return closeNow(agentId, session.sessionId, new Date(session.registeredAt).toISOString())
    },
  }
  return { ...core, agents: { ...core.agents, ...own } }
}
