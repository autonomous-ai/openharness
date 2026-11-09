/**
 * The Swarm's part of an agent's start (core/api.ts `SwarmLaunch`): which roles and skill modes a start may ask for, and the
 * role's skill written into the project folder. The core is handed it while the Swarm is on, and refuses a start with a
 * Swarm role while it is off.
 */
import type { SwarmLaunch } from '../../core/api.js'
import { swarmEngineArgs } from '../../lib/swarmEngineArgs.js'
import { isSwarmRole, isSwarmSkillMode, prepareSwarmSkill } from '../../lib/swarmSkills.js'

export const SWARM_LAUNCH: SwarmLaunch = {
  role: isSwarmRole,
  mode: isSwarmSkillMode,
  prepare: prepareSwarmSkill,
  args: swarmEngineArgs,
}
