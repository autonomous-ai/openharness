/**
 * The Swarm skill a registry row keeps (`swarmSkill`), as data: its shape and how a saved one is read back. Apart from
 * the skill itself (lib/swarmSkills.ts), so the registry, which every process loads, reads its rows without loading the
 * Swarm's code: with the Swarm off (`HARNESS_SWARM`, harnessd/services.ts) a row keeps the field and nothing acts on it.
 */
/** What a Swarm session is (project instructions, phase 4): its project's coordinator, or an agent whose role the project's
 *  instructions name. The role's name is the host row's (phase 2), never this record's. */
export type SwarmRole = 'coordinator' | 'agent'
/** The role values `agent_create` carries, and those every row from before role kinds was saved with. An older CLI takes
 *  only these, so this release still sends them (decision 1); the next may send the kinds, which this one takes too. */
type WireRole = 'lead' | 'dev' | 'review'
/** `github`: git and gh in this session use the Harness GitHub App's token for its task (lib/swarmGitHub.ts), set on a
 *  session started for another person's project before the App's removal and kept for every relaunch, so it never loses
 *  push mid-work; no new session gets it (delete on or after 2026-12-10). `fallback`: an agent
 *  started as a Reviewer, which keeps that kind. A skill mode an older release saved (`mode`) is read as nothing: the modes are
 *  gone (PM, 2026-11-11), and every Swarm agent starts with the same basics. */
export interface SwarmSkill { role: SwarmRole; key: string; github?: true; fallback?: 'review' }
/** What a session's current Swarm membership grants it, before it has a key. */
export type SwarmSkillGrant = Omit<SwarmSkill, 'key' | 'github'>
export const isSwarmRole = (value: unknown): value is SwarmRole => value === 'coordinator' || value === 'agent'

/** A role from the wire or a saved row, in either value set; null for anything else. */
export function roleFromWire(value: unknown): { role: SwarmRole; fallback?: 'review' } | null {
  switch (value) {
    case 'lead': case 'coordinator': return { role: 'coordinator' }
    case 'dev': case 'agent': return { role: 'agent' }
    case 'review': return { role: 'agent', fallback: 'review' }
    default: return null
  }
}
/** The value an older machine knows for this session. */
export const wireRole = (skill: Pick<SwarmSkill, 'role' | 'fallback'>): WireRole =>
  skill.role === 'coordinator' ? 'lead' : skill.fallback === 'review' ? 'review' : 'dev'

export function parseSwarmSkill(value: unknown): SwarmSkill | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { role, key, github, fallback } = value as Record<string, unknown>
  const read = roleFromWire(role)
  if (!read || typeof key !== 'string' || key.length === 0) return undefined
  // A fallback is an agent's alone: an older row's `review` says it, a newer row's field keeps it.
  const kept = read.fallback ?? (read.role === 'agent' && fallback === 'review' ? 'review' : undefined)
  return { role: read.role, key, ...(github === true ? { github } : {}), ...(kept ? { fallback: kept } : {}) }
}
