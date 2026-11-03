/**
 * The Swarm's side of the core's process: the one entry the core loads it through, dynamically and only while the Swarm
 * is on (core/main.ts, `HARNESS_SWARM` in harnessd/services.ts). Off, none of this is loaded and the core runs as it
 * does without the Swarm; src/architecture.spec.ts checks that the core reaches the Swarm's code by no other way.
 *
 * What it hands the core is typed by core/api.ts, the core's contract: the Super Tab members' waits and cards on the
 * devices (`SuperTabsCore`), a member's terminal for its Lead, the close and reopen of its agents (`SwarmAgents`), a
 * start's Swarm role (`SwarmLaunch`), an older session's role at its restart (`AdoptSwarmSkill`), its chat queued while
 * an agent works, the Leads that are never stopped, and its chat files streamed to the backend. And the Super Tab
 * service's own start, for when it runs in the core's process (services/superTabs.ts), so a core running every service
 * there with the Swarm off loads none of it either.
 */
export { createSuperTabAttention } from './inCore/attention.js'
export { createSuperTabCards } from './inCore/cards.js'
export { createSuperTabTerminal } from './inCore/terminal.js'
export { swarmRoleThrough } from './inCore/role.js'
export { quietOnDevices } from './inCore/devices.js'
export { createSwarmSkillAdoption } from './inCore/adoption.js'
export { createSwarmAgents } from './inCore/agents.js'
export { SWARM_LAUNCH } from './inCore/launch.js'
export { createConfidentialPurge, isTeamDaemon, purgeRecord, teamAppPolicyFor, teamPurgeReport, withPurgeRetries } from './inCore/teamApps.js'
export { typesWhileBusy } from './inCore/deliveries.js'
export { mayBeBuddy, retainedHarnesses, retainedLeads } from './retention.js'
// A Product Manager switched from its pane (Change agent) is the one stop of a Lead its close guard and stop guard let through.
export { leadCloseProtected, leadSwitchEnded, leadSwitching, mayBeLead } from './leadSwitch.js'
export { forwardAttachmentUpload } from '../lib/superTabAttachmentProxy.js'
export { startSuperTabs } from '../services/superTabs.js'
