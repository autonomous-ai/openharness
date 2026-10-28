/**
 * The Swarm skill a registry row keeps (`swarmSkill`), as data: its shape and how a saved one is read back. Apart from
 * the skill itself (lib/swarmSkills.ts), so the registry, which every process loads, reads its rows without loading the
 * Swarm's code: with the Swarm off (`HARNESS_SWARM`, harnessd/services.ts) a row keeps the field and nothing acts on it.
 */
/** `buddy`: a person's own agent in a project, which brainstorms with them (backend superTabs/buddies.ts). */
export type SwarmRole = 'lead' | 'dev' | 'review' | 'buddy'
/** A Swarm project's skill set, which its owner chooses (2026-10-23): Default is the team process alone, Harness orchestration
 * adds Harness practices. A session saved without one launched before modes, on the orchestration text. */
export type SwarmSkillMode = 'default' | 'orchestration'
/** `github`: git and gh in this session use the Harness GitHub App's token for its task (lib/swarmGitHub.ts), set when a
 *  start does another person's project work (superTabs/start.ts) and kept for every relaunch. */
export interface SwarmSkill { role: SwarmRole; key: string; mode?: SwarmSkillMode; github?: true }
/** What a session's current Swarm membership grants it, before it has a key. */
export type SwarmSkillGrant = Omit<SwarmSkill, 'key' | 'github'>
export const isSwarmRole = (value: unknown): value is SwarmRole => value === 'lead' || value === 'dev' || value === 'review' || value === 'buddy'
export const isSwarmSkillMode = (value: unknown): value is SwarmSkillMode => value === 'default' || value === 'orchestration'

export function parseSwarmSkill(value: unknown): SwarmSkill | undefined {
  if (!value || typeof value !== 'object') return undefined
  const { role, key, mode, github } = value as Partial<SwarmSkill>
  return isSwarmRole(role) && typeof key === 'string' && key.length > 0
    ? { role, key, ...(isSwarmSkillMode(mode) ? { mode } : {}), ...(github === true ? { github } : {}) } : undefined
}
