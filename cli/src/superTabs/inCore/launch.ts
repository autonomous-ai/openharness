/**
 * The Swarm's part of an agent's start (core/api.ts `SwarmLaunch`): which roles a start may ask for, the team's basics it
 * starts with, and the Harness GitHub App's git and gh for another person's project work. The core is handed it while the
 * Swarm is on, and refuses a start with a Swarm role while it is off.
 */
import { env } from '../../config/env.js'
import type { SwarmLaunch } from '../../core/api.js'
import { swarmEngineArgs } from '../../lib/swarmEngineArgs.js'
import { swarmGitHubLaunch } from '../../lib/swarmGitHub.js'
import { isSwarmRole, noteSwarmBasics, swarmBasics } from '../../lib/swarmSkills.js'

export const SWARM_LAUNCH: SwarmLaunch = {
  role: isSwarmRole,
  // Every launch and relaunch carries this release's basics; the first notes when, so the Swarm's host tells only the
  // agents launched before then that they changed (lib/swarmSkills.ts noteSwarmBasics).
  basics: (lead) => {
    noteSwarmBasics(env.ADAPTER_DATA_DIR, Date.now())
    return swarmBasics(lead).text
  },
  github: (key) => swarmGitHubLaunch(key),
  args: swarmEngineArgs,
}
