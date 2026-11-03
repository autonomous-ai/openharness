import { describe, expect, it } from 'vitest'
import type { RegisteredSession } from '../../lib/registry.js'
import { quietOnDevices } from './devices.js'

describe('a Swarm agent on the devices', () => {
  // #2540: a Swarm agent tells its news through the Swarm's chat cards, so its finished turns are silent on the dial and
  // the phone. The core carries only the fact (core/turns/recaps.ts); this is where it is said.
  it.each(['lead', 'buddy', 'agent'] as const)('is quiet on devices whatever its role (%s)', (role) => {
    expect(quietOnDevices({ agentId: 'a1', swarmSkill: { role, key: 'k' } } as RegisteredSession)).toBe(true)
  })

  it('leaves any other agent to its own tier', () => {
    expect(quietOnDevices({ agentId: 'a1' } as RegisteredSession)).toBe(false)
  })
})
