/**
 * A project's crew on this machine (task #3397, anh Dee's Swarm redesign, 11-05): named agents the Swarm keeps alive. The
 * backend marks one (`agent.crew`, backend superTabs/crew.ts); its roster row carries the mark. This host then keeps it as it
 * keeps the PM (host.ts keepAlive: a gone session is reopened in place), restarts one whose screen froze, and types one
 * continue into a reopened session that still holds its task. The retention names crew (retention.ts), so the idle cleanup
 * (services/agentCleanup.ts) never closes one, and the core lets this host reopen it (inCore/agents.ts keepLeadAlive).
 *
 * The numbers here stay in this one place until the project rules record lands (sibling task of #3397).
 */
import { object } from './wire.js'

/** A crew session the engine says is working whose whole screen did not change this long is frozen: it is restarted. */
export const CREW_FROZEN_MS = 30 * 60_000
/** How often a crew member's screen is looked at for a freeze. */
export const CREW_LOOK_MS = 60_000

/** Whether a host roster row marks its agent as crew this host keeps alive: crew (`agent.crew` with a role), not asleep (closed
 *  on purpose by crew sleep, task #3398) and not moved to another machine (`movedTo`, task #3398), which is gone here. */
export function isCrewRow(row: unknown): boolean {
  const agent = object(object(row).agent), role = object(agent.crew).role
  return typeof role === 'string' && role.length > 0 && !agent.asleep && !agent.movedTo
}
