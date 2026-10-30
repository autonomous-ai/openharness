/** Older Swarm sessions predate role metadata. Adopt only at restart/resume, from current membership,
 * before native launch authority is captured; changing the live row later would revoke that launch. */
import type { AdoptSwarmSkill } from '../../core/api.js'
import type { registry, RegisteredSession } from '../../lib/registry.js'
import type { SwarmSkillGrant } from '../../lib/swarmSkills.js'

/** How long a held adoption waits after its first unanswered role read, doubling up to the last. Each read is itself bounded
 *  (the service's 3-second Swarm read), so a held session costs one short read every half minute at most. */
const HOLD_FIRST_MS = 2000
const HOLD_MAX_MS = 30_000
const pause = (ms: number) => new Promise<void>(resolve => { setTimeout(resolve, ms).unref?.() })
/** A Swarm start's session: started by an agent (superTabs/start.ts `startedBy: 'agent'`, since the first Super Tab), and
 *  not by one of this machine's harnesses (`harness new` records its parent, core/agents/launches.ts). */
const swarmStarted = (session: RegisteredSession) => session.startedBy === 'agent' && !session.parentAgentId

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
  /** Whether this row's role must come from the Swarm before it launches. */
  const needed = (session: RegisteredSession): boolean => {
    if (session.swarmSkill || session.guest || !session.cwd || (session.engine !== 'claude' && session.engine !== 'codex')) return false
    if (noRole.has(session.agentId)) return false
    // The host's last confirmed roster is only a cheap candidate filter for the person's own sessions; the live backend
    // remains authoritative. One that cannot be read cannot clear a session as personal, so the backend is asked. A session
    // the Swarm started is always asked: the roster lapses after a week nobody confirms it and leaves out a member of only
    // archived chats, and its "not a member" opened an old Buddy without its role (security review 2 of #2255). Every
    // Buddy is one (superTabs/start.ts); a harness another agent opened names that agent, and the person's own is not one.
    if (swarmStarted(session)) return true
    try { return deps.candidate(session.agentId) } catch { return true }
  }
  const read = async (agentId: string): Promise<SwarmSkillGrant | null | undefined> => {
    try { return await deps.role(agentId) } catch { return undefined /* An unreadable roster is no answer. */ }
  }
  /** The row with its role, and the write that records it; a confirmed "in no Swarm" is remembered. */
  const adopted = (session: RegisteredSession, grant: SwarmSkillGrant | null) => {
    if (grant === null) {
      noRole.add(session.agentId)
      return { row: session, commit: () => {} }
    }
    // With its project's mode, so the relaunch writes that text and the host owes it no reload.
    const swarmSkill = { ...grant, key: session.agentId }
    return { row: { ...session, swarmSkill }, commit: () => { deps.save(session.agentId, swarmSkill) } }
  }
  const adopt = async (session: RegisteredSession, current: () => boolean): Promise<RegisteredSession | null> => {
    if (!current()) return null
    if (!needed(session)) return session
    const owns = deps.authority(session.agentId)
    const saved = structuredClone(session)
    // A Swarm session whose role cannot be read is held, never resumed without it: an old Buddy came back without its guard
    // (security reviews of #2248). It goes on as soon as a read answers, so failing closed never means staying down.
    let grant: SwarmSkillGrant | null | undefined
    for (let delay = HOLD_FIRST_MS; ; delay = Math.min(delay * 2, HOLD_MAX_MS)) {
      grant = await read(saved.agentId)
      if (!current()) return null
      if (grant !== undefined) break
      if (delay === HOLD_FIRST_MS) log(`[swarm] ${saved.agentId.slice(0, 8)} held · its Swarm role could not be read; it opens once a read answers`)
      await wait(delay)
      if (!current()) return null
    }
    if (grant === null) return adopted(session, grant).row
    if (!owns()) return null
    // A stopped row is not live yet: resumePendingAgent persists the returned copy when dispatch allocates its pane.
    const { row, commit } = adopted(saved, grant)
    commit()
    return row
  }
  // Boot restore, a model switch and a host move cannot wait inside one launch (security review 1 of #2255): one read, and
  // the caller holds the agent in its pane or refuses, never launching it without its role.
  const lookup: NonNullable<AdoptSwarmSkill['lookup']> = async (session, current) => {
    if (!current()) return null
    if (!needed(session)) return { row: session, commit: () => {} }
    const owns = deps.authority(session.agentId)
    const saved = structuredClone(session)
    const grant = await read(saved.agentId)
    if (!current()) return null
    if (grant === undefined) return 'unavailable'
    if (grant !== null && !owns()) return null
    return grant === null ? adopted(session, grant) : adopted(saved, grant)
  }
  return Object.assign(adopt, { lookup, needed })
}
