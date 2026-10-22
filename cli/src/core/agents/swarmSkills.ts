/** Older Swarm sessions predate role metadata. Adopt only at restart/resume, from current membership,
 * before native launch authority is captured; changing the live row later would revoke that launch. */
import type { RegisteredSession, registry } from '../../lib/registry.js'
import type { SwarmRole } from '../../lib/swarmSkills.js'

export type AdoptSwarmSkill = (session: RegisteredSession, current: () => boolean) => Promise<RegisteredSession | null>

export function createSwarmSkillAdoption(deps: {
  role(harnessId: string): Promise<SwarmRole | null>
  authority(agentId: string): () => boolean
  save: typeof registry.setSwarmSkill
}): AdoptSwarmSkill {
  return async (session, current) => {
    if (!current()) return null
    if (session.swarmSkill || session.guest || !session.cwd || (session.engine !== 'claude' && session.engine !== 'codex')) return session
    const owns = deps.authority(session.agentId)
    const saved = structuredClone(session)
    let role: SwarmRole | null = null
    try { role = await deps.role(saved.agentId) } catch { /* An unreadable roster grants no skill. */ }
    if (!current() || !owns()) return null
    if (!role) return saved
    const swarmSkill = { role, key: saved.agentId }
    // A stopped row is not live yet: resumePendingAgent persists the returned copy when dispatch allocates its pane.
    deps.save(saved.agentId, swarmSkill)
    return { ...saved, swarmSkill }
  }
}
