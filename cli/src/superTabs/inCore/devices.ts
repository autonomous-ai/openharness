/**
 * A Swarm agent on the devices: it tells its news through the Swarm's chat cards, so its finished turns are silent on the
 * dial and the phone (#2540). The core carries the fact with each session it tells the recaps (core/api.ts RecapSession);
 * whether an agent is a Swarm agent is said here, through the Swarm's door, and only while the Swarm is on.
 */
import type { RegisteredSession } from '../../lib/registry.js'

/** Whether an agent's finished turns are silent on the devices: one launched with its Swarm skill, whatever its role. */
export const quietOnDevices = (session: RegisteredSession): boolean => !!session.swarmSkill
