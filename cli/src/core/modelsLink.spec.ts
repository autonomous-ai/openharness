import { describe, expect, it, vi } from 'vitest'
import type { GridGlance } from '../lib/gridAnnotation.js'
import type { RegisteredSession } from '../lib/registry.js'
import { fakeCore } from '../testing/fakeCore.js'
import { createModelsLink, glancesIn } from './modelsLink.js'
import { ServiceUnavailableError } from './serviceHost.js'
import type { ServiceFrame } from './serviceLinks.js'

const RELAY = 'https://fixture.invalid/g/net-own/relay/v1'
const LAUNCH = { networkId: 'net-own', networkName: 'mine', baseUrl: RELAY, apiKey: 'fixture-key', model: 'Small-Q4' }
const awake: GridGlance = { id: 'net-own', view: { state: 'awake', models: [{ id: 'Small-Q4' }, { id: 'Big', unavailable: { machine: 'Studio' } }] }, listed: true, asleep: false }
const asleep: GridGlance = { ...awake, view: { ...awake.view!, state: 'asleep' }, asleep: true }
const onGrid = (agentId: string, model: string | null = 'Small-Q4') => ({ agentId, grid: { baseUrl: RELAY, model } }) as unknown as RegisteredSession

function setup(answers: Record<string, Record<string, unknown>> = {}, agents: RegisteredSession[] = []) {
  const core = fakeCore({ agents: { advertised: vi.fn(() => agents) } })
  const call = vi.fn(async (type: string, _payload: Record<string, unknown>) => answers[type] ?? { error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true })
  const notify = vi.fn((_frame: ServiceFrame) => true)
  const link = createModelsLink(core, call, notify)
  return { core, call, notify, link, port: link.port }
}

describe('models in its own process, as the core reaches it', () => {
  describe('what a frame and a keystroke read: the glances models last told', () => {
    it('answers no note before models has said anything, and the note its last glance gives after', async () => {
      const { link, port } = setup()
      expect(port.annotation({ baseUrl: RELAY, model: 'Small-Q4' })).toBeNull()
      expect(await link.answer('glances', { glances: [awake] })).toEqual({ kept: true })
      expect(port.annotation({ baseUrl: RELAY, model: 'Small-Q4' })).toEqual({ state: 'awake' })
      expect(port.annotation({ baseUrl: RELAY, model: 'big' })).toEqual({ state: 'awake', note: { reason: 'offline', model: 'Big', machine: 'Studio' } })
      expect(port.annotation({ baseUrl: RELAY, model: 'Gone' })).toEqual({ state: 'awake', note: { reason: 'not_served', model: 'Gone' } })
      expect(port.annotation({ baseUrl: 'https://fixture.invalid/g/other/relay/v1', model: 'Small-Q4' })).toBeNull()
    })

    it('a keystroke crosses to models only for an agent whose grid is asleep', async () => {
      const { link, notify, port } = setup()
      port.prewarm({ baseUrl: RELAY, model: 'Small-Q4' })
      await link.answer('glances', { glances: [awake] })
      port.prewarm({ baseUrl: RELAY, model: 'Small-Q4' })
      expect(notify).not.toHaveBeenCalled()
      await link.answer('glances', { glances: [asleep] })
      port.prewarm({ baseUrl: RELAY, model: 'Small-Q4' })
      expect(notify).toHaveBeenCalledExactlyOnceWith({ type: 'service_event', payload: { kind: 'prewarm', grid: { baseUrl: RELAY, model: 'Small-Q4' } } })
    })

    it('sends again the frames of agents whose note moved — each on a grid the first time, then only on a change', async () => {
      const agents = [onGrid('a1'), onGrid('a2', 'Big'), { agentId: 'plain' } as RegisteredSession]
      const { core, link } = setup({}, agents)
      await link.answer('glances', { glances: [awake] })
      expect(vi.mocked(core.agents.sync).mock.calls.map(([s]) => s.agentId)).toEqual(['a1', 'a2'])
      await link.answer('glances', { glances: [awake] })
      expect(core.agents.sync).toHaveBeenCalledTimes(2)
      await link.answer('glances', { glances: [asleep] })
      expect(core.agents.sync).toHaveBeenCalledTimes(4)
      // An agent that left a grid is forgotten, so its return is announced again.
      agents.splice(0, 1)
      await link.answer('glances', { glances: [asleep] })
      agents.push(onGrid('a1'))
      await link.answer('glances', { glances: [asleep] })
      expect(vi.mocked(core.agents.sync).mock.calls.at(-1)![0].agentId).toBe('a1')
    })

    it('keeps nothing from what is not a list of glances, and reads each as far as a note does', async () => {
      const { link, port } = setup()
      expect(await link.answer('glances', { glances: 'nope' })).toEqual({ kept: false })
      expect(glancesIn([7, { id: '' }, { id: 'n1', view: { state: 'awake', models: 'nope' } }, { id: 'n2', view: { state: 'awake', models: [7, { id: 'm', unavailable: 'x' }, { id: 'n', unavailable: { machine: 'Mini' } }] }, listed: true, asleep: true }]))
        .toEqual([
          { id: 'n1', view: null, listed: false, asleep: false },
          { id: 'n2', view: { state: 'awake', models: [{ id: 'm' }, { id: 'n', unavailable: { machine: 'Mini' } }] }, listed: true, asleep: true },
        ])
      expect(port.annotation({ baseUrl: RELAY, model: 'x' })).toBeNull()
    })
  })

  describe('what the core asks models when it needs it', () => {
    it('grid set-up: what models answered, or unavailable', async () => {
      const ready = { status: 'converged', name: 'mine', detail: 'ok' }
      const { call, port } = setup({ ensure: ready })
      expect(await port.ensure({ ownGrid: true })).toEqual(ready)
      expect(call).toHaveBeenCalledWith('ensure', { ownGrid: true })
      await expect(setup().port.ensure()).rejects.toBeInstanceOf(ServiceUnavailableError)
      await expect(setup({ ensure: { requestId: 'x' } }).port.ensure()).rejects.toBeInstanceOf(ServiceUnavailableError)
      await expect(setup({ ensure: { error: 'SERVICE_FAILED', service: 'models' } }).port.ensure()).rejects.toBeInstanceOf(ServiceUnavailableError)
    })

    it('a new agent\'s target, checked as any launch is; none when models found none or said something else', async () => {
      const { call, port } = setup({ launchTarget: { target: LAUNCH } })
      expect(await port.launchTarget({ model: 'Small-Q4', grid: 'mine' })).toEqual(LAUNCH)
      expect(call).toHaveBeenCalledWith('launchTarget', { model: 'Small-Q4', grid: 'mine' })
      expect(await setup({ launchTarget: { target: null } }).port.launchTarget({ model: 'm', grid: 'g' })).toBeNull()
      expect(await setup({ launchTarget: { target: { ...LAUNCH, apiKey: '' } } }).port.launchTarget({ model: 'm', grid: 'g' })).toBeNull()
      // Down: the create that asked answers GRID_UNAVAILABLE (core/agents/launches.ts).
      await expect(setup().port.launchTarget({ model: 'm', grid: 'g' })).rejects.toBeInstanceOf(ServiceUnavailableError)
    })

    it('a move\'s target, or why there is none, in models\' words or the core\'s', async () => {
      expect(await setup({ moveTarget: { target: LAUNCH } }).port.moveTarget({ gridName: null, model: 'Small-Q4' })).toEqual({ target: LAUNCH })
      expect(await setup({ moveTarget: { detail: 'no grid on this computer' } }).port.moveTarget({ gridName: 'team', model: 'm' })).toEqual({ detail: 'no grid on this computer' })
      expect(await setup({ moveTarget: {} }).port.moveTarget({ gridName: 'team', model: 'm' })).toEqual({ detail: 'Could not read this machine\'s grid endpoint.' })
      await expect(setup().port.moveTarget({ gridName: null, model: 'm' })).rejects.toBeInstanceOf(ServiceUnavailableError)
    })

    it('the private grid\'s name, or none while models cannot say', async () => {
      expect(await setup({ privateGridName: { name: 'derived-1a2b' } }).port.privateGridName()).toBe('derived-1a2b')
      expect(await setup({ privateGridName: { name: null } }).port.privateGridName()).toBeNull()
      expect(await setup().port.privateGridName()).toBeNull()
    })

    it('the lists the windows are pushed, in both forms, or unavailable', async () => {
      const plain = { gridName: 'mine', models: [] }
      const rowState = { gridName: 'mine', models: [], grids: [] }
      expect(await setup({ lists: { plain, rowState } }).port.lists()).toEqual({ plain, rowState })
      await expect(setup({ lists: { plain } }).port.lists()).rejects.toBeInstanceOf(ServiceUnavailableError)
      await expect(setup().port.lists()).rejects.toBeInstanceOf(ServiceUnavailableError)
    })
  })

  describe('what the core only tells models', () => {
    it('a move onto a grid model, the machine list and the end of the sign-in, as events held for nobody', async () => {
      const { link, notify, port } = setup()
      port.moved(LAUNCH)
      port.machines({ data: { machines: [] } }, 'computer-here')
      port.signedOut()
      expect(notify.mock.calls.map(([frame]) => frame)).toEqual([
        { type: 'service_event', payload: { kind: 'moved', launch: LAUNCH } },
        { type: 'service_event', payload: { kind: 'machines', body: { data: { machines: [] } }, computerId: 'computer-here' } },
        { type: 'service_event', payload: { kind: 'signedOut' } },
      ])
      // A process that connects later asks for the machine list instead.
      expect(await link.answer('machines', {})).toEqual({ body: { data: { machines: [] } }, computerId: 'computer-here' })
      expect(await setup().link.answer('machines', {})).toEqual({})
    })
  })

  describe('what models asks the core', () => {
    it('the account\'s grid as the backend said it, this machine\'s name, a minted name and the token, each when asked', async () => {
      const core = fakeCore({ account: {
        privateGridName: vi.fn(async () => 'mine'), machineName: vi.fn(() => 'Studio'),
        mintGridName: vi.fn(async () => 'minted-1a2b'), accessToken: vi.fn(async () => 'fixture-token'),
      } })
      const link = createModelsLink(core, vi.fn(), vi.fn())
      expect(await link.answer('account', {})).toEqual({ gridName: 'mine', machineName: 'Studio' })
      expect(await link.answer('mintGridName', {})).toEqual({ name: 'minted-1a2b' })
      expect(await link.answer('accessToken', {})).toEqual({ token: 'fixture-token' })
      // Signed out, the token is refused: the link answers QUERY_FAILED for it (core/serviceLinks.ts).
      vi.mocked(core.account.accessToken).mockRejectedValueOnce(new Error('signed out'))
      await expect(link.answer('accessToken', {})).rejects.toThrow('signed out')
    })

    it('an agent\'s Model/Effort choices, or every live agent\'s', async () => {
      const models = [{ id: 'runtime-v1:a1:codex:o3@high', displayName: 'o3 / High' }]
      const core = fakeCore({ agents: { runtimeModels: vi.fn(async () => models) } })
      const link = createModelsLink(core, vi.fn(), vi.fn())
      expect(await link.answer('runtimeModels', { agentId: 'a1' })).toEqual({ models })
      expect(await link.answer('runtimeModels', { agentId: '' })).toEqual({ models })
      expect(vi.mocked(core.agents.runtimeModels).mock.calls).toEqual([['a1'], [undefined]])
    })

    it('the two pushes to the windows, and nothing for a question it does not know', async () => {
      const { core, link } = setup()
      expect(await link.answer('gridNamed', { name: 'mine' })).toEqual({})
      expect(await link.answer('gridNamed', { name: '' })).toEqual({})
      expect(core.clients.gridNamed).toHaveBeenCalledExactlyOnceWith('mine')
      expect(await link.answer('gridModelsChanged', {})).toEqual({})
      expect(core.clients.gridModelsChanged).toHaveBeenCalledOnce()
      expect(await link.answer('anything', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    })
  })
})
