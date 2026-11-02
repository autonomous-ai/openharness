/**
 * The Swarm skill a registry row keeps (`swarmSkill`), as data: its shape and how a saved one is read back. Apart from
 * the skill itself (lib/swarmSkills.ts), so the registry, which every process loads, reads its rows without loading the
 * Swarm's code: with the Swarm off (`HARNESS_SWARM`, harnessd/services.ts) a row keeps the field and nothing acts on it.
 */
/** What a Swarm session is (project instructions, phase 4): its project's coordinator, an agent whose role the project's
 *  instructions name, or a Buddy, a person's own agent in a project, which brainstorms with them (backend
 *  superTabs/buddies.ts). The role's name is the host row's (phase 2), never this record's. */
export type SwarmRole = 'coordinator' | 'agent' | 'buddy'
/** The role values `agent_create` carries, and those every row from before role kinds was saved with. An older CLI takes
 *  only these, so this release still sends them (decision 1); the next may send the kinds, which this one takes too. */
export type WireRole = 'lead' | 'dev' | 'review' | 'buddy'
/** A Swarm project's skill set, which its owner chooses (2026-10-23): Default is the team process alone, Harness orchestration
 * adds Harness practices. A session saved without one launched before modes, on the orchestration text. */
export type SwarmSkillMode = 'default' | 'orchestration'
/** `github`: git and gh in this session use the Harness GitHub App's token for its task (lib/swarmGitHub.ts), set when a
 *  start does another person's project work (superTabs/start.ts) and kept for every relaunch. `fallback`: an agent
 *  started as a Reviewer, which keeps its swarm-review file and text for a Swarm with no project instructions. */
export interface SwarmSkill { role: SwarmRole; key: string; mode?: SwarmSkillMode; github?: true; fallback?: 'review' }
/** A row as any release saved it: one from before role kinds names its role in the wire's values. parseSwarmSkill reads
 *  both; this release writes the kinds. */
export type SavedSwarmSkill = SwarmSkill | (Omit<SwarmSkill, 'role' | 'fallback'> & { role: WireRole })
/** What a session's current Swarm membership grants it, before it has a key. */
export type SwarmSkillGrant = Omit<SwarmSkill, 'key' | 'github'>
export const isSwarmRole = (value: unknown): value is SwarmRole => value === 'coordinator' || value === 'agent' || value === 'buddy'
export const isSwarmSkillMode = (value: unknown): value is SwarmSkillMode => value === 'default' || value === 'orchestration'

/** A role from the wire or a saved row, in either value set; null for anything else. */
export function roleFromWire(value: unknown): { role: SwarmRole; fallback?: 'review' } | null {
  switch (value) {
    case 'lead': case 'coordinator': return { role: 'coordinator' }
    case 'dev': case 'agent': return { role: 'agent' }
    case 'review': return { role: 'agent', fallback: 'review' }
    case 'buddy': return { role: 'buddy' }
    default: return null
  }
}
/** The value an older machine knows for this session. */
export const wireRole = (skill: Pick<SwarmSkill, 'role' | 'fallback'>): WireRole =>
  skill.role === 'coordinator' ? 'lead' : skill.role === 'buddy' ? 'buddy' : skill.fallback === 'review' ? 'review' : 'dev'
/** The built-in role file the session keeps, by the name it has always had. */
export const fallbackSkillName = (skill: Pick<SwarmSkill, 'role' | 'fallback'>) => `swarm-${wireRole(skill)}` as const

export function parseSwarmSkill(value: unknown): SwarmSkill | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { role, key, mode, github, fallback } = value as Record<string, unknown>
  const read = roleFromWire(role)
  if (!read || typeof key !== 'string' || key.length === 0) return undefined
  // A fallback is an agent's alone: an older row's `review` says it, a newer row's field keeps it.
  const kept = read.fallback ?? (read.role === 'agent' && fallback === 'review' ? 'review' : undefined)
  return { role: read.role, key, ...(isSwarmSkillMode(mode) ? { mode } : {}), ...(github === true ? { github } : {}), ...(kept ? { fallback: kept } : {}) }
}
