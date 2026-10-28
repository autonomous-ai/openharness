/**
 * The Swarm's side of the services that act on it from outside it: the one entry they get it through, loaded only while
 * the Swarm is on (`HARNESS_SWARM`, harnessd/services.ts), in a service's own process (serviceProcess.ts) or in the
 * core's when they run there (core/main.ts). Off, none of this is loaded and each runs as it does without the Swarm;
 * src/architecture.spec.ts checks that they reach the Swarm's code by no other way.
 *
 * - The agent cleanup: the Super Tab members it keeps from both forms of cleanup (services/agentCleanup.ts `retained`).
 * - Share: the observers a Super Tab's roster lets watch a harness (services/sharing.ts `observers`).
 * - Change agent: a member's replacement, recorded for its host (services/handoff.ts `replacements`).
 * - Models: a Swarm's grid, the APIs and models shared with it, and the check that keeps them there
 *   (services/models.ts `SwarmModels`).
 */
export { retainedHarnesses } from './retention.js'
export { observerSource } from './observers.js'
export { recordReplacement } from './replacements.js'
export { syncSwarmGrid } from '../lib/swarmGrid.js'
export { SwarmApiShares } from '../lib/swarmApiShares.js'
export { liveModels, SwarmHeal } from '../lib/swarmHeal.js'
export { SwarmOffers } from '../lib/swarmOffers.js'
