/**
 * A finished turn's tier on the phone, on the real daemon signed in on the fake backend with a phone paired on the fake
 * relay (services/recaps.ts). Fixed rules decide it, never a model: a harness agent's finished turn alerts
 * (lib/notifyTier.ts, docs/superpowers/specs/2026-11-02-device-notify-no-jev-design.md, #2580). Harness's hosted Jev route is
 * not asked, so nothing the person's agents said leaves the computer for it.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { LocalClient } from './harness/client.js'
import { until } from './harness/daemon.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone } from './harness/relayPhone.js'

describe('a finished turn\'s tier, decided by Harness\'s rules', () => {
  let world: PhoneMachine | undefined
  let phone: RelayPhone | undefined
  afterEach(async () => {
    phone?.close()
    await world?.close()
    world = undefined; phone = undefined
  })

  it('alerts the phone for a harness agent\'s finished turn by rule, and asks no hosted model', async () => {
    const w = await startPhoneMachine()
    world = w
    const { backend, machine } = w
    onTestFailed(() => { console.log(`---- daemon log\n${machine.daemon.log().split('\n').slice(-120).join('\n')}`) })
    const asked: Array<Record<string, any>> = []
    // Answered as the route would, were it asked: it must not be.
    backend.jev = (body) => { asked.push(body); return { tier: { choice: 'silent', probabilities: { alert: 0.05, list: 0.05, silent: 0.9 } } } }
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

    expect(asked).toEqual([])
    expect(machine.daemon.log()).toMatch(/\[recap\] notify · .* · alert · rule:turn · turn · /)
  })
})
