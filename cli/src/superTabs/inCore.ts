/**
 * The Swarm's side of the core's process: the one entry the core loads it through, dynamically and only while the Swarm
 * is on (core/main.ts, `HARNESS_SWARM` in harnessd/services.ts). Off, none of this is loaded and the core runs as it
 * does without the Swarm; src/architecture.spec.ts checks that the core reaches the Swarm's code by no other way.
 *
 * What it hands the core is typed by core/api.ts, the core's contract: the Super Tab members' waits and cards on the
 * devices (`SuperTabsCore`), a member's terminal for its Lead, the close and reopen of its agents (`SwarmAgents`), a
 * start's Swarm role (`SwarmLaunch`), an attached agent's role at its restart (`AdoptSwarmSkill`), the Leads that are never
 * stopped, and its chat files, which the gateway sends to the backend. What a
 * service running in the core's process needs of the Swarm is not here: superTabs/inServices.ts.
 *
 * Its side of the core and nothing else: the Super Tab service runs in a process of its own, and a core that runs it
 * here loads it by an import of its own (core/main.ts). This file once re-exported the service's start, so every
 * core with the Swarm on loaded the whole service, 118 files it never ran (the audit of 2026-11-12,
 * docs/design/2026-11-12-core-audit.md); src/architecture.spec.ts now lists, file by file, what this door loads.
 */
export { createSuperTabAttention } from './inCore/attention.js'
export { createSuperTabCards } from './inCore/cards.js'
export { createSuperTabTerminal } from './inCore/terminal.js'
export { swarmRoleThrough } from './inCore/role.js'
export { quietOnDevices } from './inCore/devices.js'
export { createSwarmSkillAdoption } from './inCore/adoption.js'
export { createSwarmAgents } from './inCore/agents.js'
export { swarmLaunch } from './inCore/launch.js'
export { retainedHarnesses, retainedLeads } from './retention.js'
// A Product Manager switched from its pane (Change agent) is the one stop of a Lead its close guard and stop guard let through.
export { leadCloseProtected, leadSwitchEnded, leadSwitching, mayBeLead } from './leadSwitch.js'
export { forwardAttachmentUpload } from '../lib/superTabAttachmentProxy.js'
