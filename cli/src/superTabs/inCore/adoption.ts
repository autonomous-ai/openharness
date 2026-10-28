/** Older Swarm sessions predate role metadata. Adopt only at restart/resume, from current membership,
 * before native launch authority is captured; changing the live row later would revoke that launch. */
import type { AdoptSwarmSkill } from '../../core/api.js'
import type { registry } from '../../lib/registry.js'
import type { SwarmSkillGrant } from '../../lib/swarmSkills.js'

export function createSwarmSkillAdoption(deps: {
  role(harnessId: string): Promise<SwarmSkillGrant | null | undefined>
  candidate(harnessId: string): boolean
  authority(agentId: string): () => boolean
  save: typeof registry.setSwarmSkill
}): AdoptSwarmSkill {
  const noRole = new Set<string>()
  return async (session, current) => {
    if (!current()) return null
    if (session.swarmSkill || session.guest || !session.cwd || (session.engine !== 'claude' && session.engine !== 'codex')) return session
    if (noRole.has(session.agentId)) return session
    // The host's last confirmed roster is only a cheap candidate filter; the live backend remains authoritative.
    try { if (!deps.candidate(session.agentId)) return session } catch { return session }
    const owns = deps.authority(session.agentId)
    const saved = structuredClone(session)
    let grant: SwarmSkillGrant | null | undefined
    try { grant = await deps.role(saved.agentId) } catch { /* An unreadable roster grants no skill. */ }
    if (!current()) return null
    if (grant === undefined) return session
    if (grant === null) {
      noRole.add(saved.agentId)
      return session
    }
    if (!owns()) return null
    // With its project's mode, so the relaunch writes that text and the host owes it no reload.
    const swarmSkill = { ...grant, key: saved.agentId }
    // A stopped row is not live yet: resumePendingAgent persists the returned copy when dispatch allocates its pane.
    deps.save(saved.agentId, swarmSkill)
    return { ...saved, swarmSkill }
  }
}
