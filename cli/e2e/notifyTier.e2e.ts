/**
 * A finished turn's tier, decided by Harness's hosted Jev, on the real daemon signed in on the fake backend
 * with a phone paired on the fake relay (services/recaps.ts). The fake route validates the request as the
 * real one does (backend routes/jevRoute.ts: `state` is a record of at most four strings), so a state the
 * real route would refuse fails here too: on 2026-10-21 every decision in production was refused with a 400
 * and fell back to the duration rule, while a fixture that took anything said all was well.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { until } from './harness/daemon.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone } from './harness/relayPhone.js'

describe('a finished turn\'s tier, decided by Harness\'s Jev', () => {
  let world: PhoneMachine | undefined
  let phone: RelayPhone | undefined
  afterEach(async () => {
    phone?.close()
    await world?.close()
    world = undefined; phone = undefined
  })

  it('asks the hosted route in the shape it takes, and the phone hears the tier Jev chose', async () => {
    const w = await startPhoneMachine()
    world = w
    const { backend, machine } = w
    onTestFailed(() => { console.log(`---- daemon log\n${machine.daemon.log().split('\n').slice(-120).join('\n')}`) })
    const asked: Array<Record<string, any>> = []
    backend.jev = (body) => { asked.push(body); return { tier: { choice: 'alert', probabilities: { alert: 0.9, list: 0.05, silent: 0.05 } } } }
    const desk = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const cwd = join(machine.daemon.projectsDir, 'tiered')
    mkdirSync(cwd, { recursive: true })
    const created = await desk.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error, JSON.stringify(created)).toBeUndefined()
    const agentId: string = created.agent.id
    await until('the agent to bind its conversation', async () =>
      ((await desk.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true })).agents.find((a) => a.id === agentId)?.sessionId) || null, 45_000, 500)
    desk.close()

    phone = new RelayPhone({ backend, machineId: machine.machineId, identity: w.phone.identity, machinePub: machine.identity.pub, token: w.phone.token })
    await until('the machine to be on the relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
    await phone.open(30_000)
    const summary = phone.next((frame) => frame.type === 'turn_summary' && frame.agentId === agentId, 60_000, 'turn_summary')
    expect(phone.send('message', { agentId, content: 'ship it' })).toBe(true)
    expect((await summary).payload?.tier).toBe('alert')

    expect(asked).toHaveLength(1)
    const state = asked[0].state as Record<string, unknown>
    expect(Object.keys(state).sort()).toEqual(['agent', 'recap', 'recent', 'turn'])
    expect(Object.values(state).every((value) => typeof value === 'string')).toBe(true)
    expect(machine.daemon.log()).toMatch(/\[recap\] notify · .* · alert · jev · p=alert=0\.90/)
  })
})
