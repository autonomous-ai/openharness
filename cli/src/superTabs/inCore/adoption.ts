/** Older Swarm sessions predate role metadata. Adopt only at restart/resume, from current membership,
 * before native launch authority is captured; changing the live row later would revoke that launch. */
import type { AdoptSwarmSkill } from '../../core/api.js'
import type { registry } from '../../lib/registry.js'
import type { SwarmSkillGrant } from '../../lib/swarmSkills.js'

/** How long a held adoption waits after its first unanswered role read, doubling up to the last. Each read is itself bounded
 *  (the service's 3-second Swarm read), so a held session costs one short read every half minute at most. */
const HOLD_FIRST_MS = 2000
const HOLD_MAX_MS = 30_000
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.() })

export function createSwarmSkillAdoption(deps: {
  role(harnessId: string): Promise<SwarmSkillGrant | null | undefined>
  candidate(harnessId: string): boolean
  authority(agentId: string): () => boolean
  save: typeof registry.setSwarmSkill
  /** Waits between the role reads of a held session, for a spec. */
  wait?: (ms: number) => Promise<void>
  log?: (message: string) => void
}): AdoptSwarmSkill {
  const noRole = new Set<string>()
  const wait = deps.wait ?? pause
  const log = deps.log ?? (message => console.log(message))
  return async (session, current) => {
    if (!current()) return null
    if (session.swarmSkill || session.guest || !session.cwd || (session.engine !== 'claude' && session.engine !== 'codex')) return session
    if (noRole.has(session.agentId)) return session
    // The host's last confirmed roster is only a cheap candidate filter; the live backend remains authoritative. One that
    // cannot be read cannot clear a session as personal, so the backend is asked.
    try { if (!deps.candidate(session.agentId)) return session } catch { /* asked below */ }
    const owns = deps.authority(session.agentId)
    const saved = structuredClone(session)
    // A Swarm session whose role cannot be read is held, never resumed without it: an old Buddy came back without its guard
    // (security reviews of #2248). It goes on as soon as a read answers, so failing closed never means staying down.
    let grant: SwarmSkillGrant | null | undefined
    for (let delay = HOLD_FIRST_MS; ; delay = Math.min(delay * 2, HOLD_MAX_MS)) {
      grant = undefined
      try { grant = await deps.role(saved.agentId) } catch { /* An unreadable roster is no answer. */ }
      if (!current()) return null
      if (grant !== undefined) break
      if (delay === HOLD_FIRST_MS) log(`[swarm] ${saved.agentId.slice(0, 8)} held · its Swarm role could not be read; it opens once a read answers`)
      await wait(delay)
      if (!current()) return null
    }
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
