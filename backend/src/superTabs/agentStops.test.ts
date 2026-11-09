import { describe, expect, it } from 'vitest'
import { v3Stopping, withdrawV3Stops } from './agentStops.js'
import type { Command } from './commands.js'
import { agent } from './model.js'
import { owner, stepsFixture } from './steps.test-support.js'

// Swarm v4 (anh Dee 2026-11-09): only its person stops an agent.
describe('the stops the v3 rules asked for', () => {
  it('are withdrawn once, but one a host is closing', () => {
    const f = stepsFixture()
    for (const id of [f.dev, f.lead]) Object.assign(agent(f.state, id), { workDecision: 'stop', releaseId: `r-${id}` })
    agent(f.state, f.dev).idleStop = { previous: null }
    expect(v3Stopping(f.state).map(a => a.id).sort()).toEqual([f.dev, f.lead].sort())
    const withdrawn = withdrawV3Stops(f.state, new Set([f.lead]))
    expect(withdrawn).toEqual([{ agentId: f.dev, releaseId: `r-${f.dev}`, machineOwnerId: agent(f.state, f.dev).machineOwnerId }])
    expect(agent(f.state, f.dev)).not.toHaveProperty('workDecision')
    expect(agent(f.state, f.dev)).not.toHaveProperty('releaseId')
    expect(agent(f.state, f.lead).workDecision).toBe('stop')
    // Once: a stop asked for after it stands.
    Object.assign(agent(f.state, f.dev), { workDecision: 'stop', releaseId: 'later' })
    expect(withdrawV3Stops(f.state)).toEqual([])
    expect(agent(f.state, f.dev).workDecision).toBe('stop')
  })

  it('no agent stops another; its person does', () => {
    const f = stepsFixture()
    // An agent with no work: a stop waits for none.
    const idle = f.add('idle', f.task)
    const release = { type: 'agent.release', agentId: idle, decision: 'stop' } as Command
    expect(() => f.run(release, f.as(f.lead))).toThrow(/Only its person stops an agent/)
    expect(agent(f.state, idle).workDecision).toBeUndefined()
    f.run(release, owner)
    expect(agent(f.state, idle).workDecision).toBe('stop')
  })
})
