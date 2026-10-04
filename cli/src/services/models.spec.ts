import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, type ModelsPort } from '../core/api.js'
import { createGridAccess, gridNamesLocal, reconcileGridAttach } from '../lib/gridAttach.js'
import { resetGridDeriveMemo, signedInGridEmail } from '../lib/gridDerive.js'
import { ensureHarnessGrid } from '../lib/gridEnsure.js'
import { gridAvailable } from '../lib/gridExec.js'
import { handOffToGrid } from '../lib/gridHandoff.js'
import { ensureGridInstalled } from '../lib/gridInstall.js'
import { clearGridMcpUrlCache } from '../lib/gridMcpUrl.js'
import { forgetGridModels, gridAnnotation, keystrokePrewarm, onGridModelsChanged, warmGridModels } from '../lib/gridModels.js'
import type { RegisteredSession } from '../lib/registry.js'
import { ensureManagedGrid } from '../lib/runtimeInstall.js'
import { fakeCore } from '../testing/fakeCore.js'
import { startModels } from './models.js'

const access = vi.hoisted(() => ({ ensure: vi.fn(async () => ({ status: 'converged', name: 'grid-1', detail: 'ok' })) }))
vi.mock('../lib/gridAttach.js', () => ({
  createGridAccess: vi.fn(() => access),
  gridNamesLocal: vi.fn(() => ['grid-1']),
  reconcileGridAttach: vi.fn(async () => ({ status: 'signed-in', name: 'grid-1', detail: 'ok' })),
}))
vi.mock('../lib/gridDerive.js', () => ({ resetGridDeriveMemo: vi.fn(), signedInGridEmail: vi.fn(() => 'me@example.com') }))
vi.mock('../lib/gridEnsure.js', () => ({ ensureHarnessGrid: vi.fn(async () => 'converged') }))
vi.mock('../lib/gridExec.js', () => ({ gridAvailable: vi.fn(() => true) }))
vi.mock('../lib/gridHandoff.js', () => ({ handOffToGrid: vi.fn(async () => ({ ok: true })) }))
vi.mock('../lib/gridInstall.js', () => ({ ensureGridInstalled: vi.fn(async () => ({ status: 'present', message: '' })) }))
vi.mock('../lib/gridMcpUrl.js', () => ({ clearGridMcpUrlCache: vi.fn() }))
vi.mock('../lib/gridModels.js', () => ({
  forgetGridModels: vi.fn(),
  gridAnnotation: vi.fn((grid: { state: string }) => ({ state: grid.state })),
  keystrokePrewarm: vi.fn(async () => 'started'),
  onGridModelsChanged: vi.fn(),
  warmGridModels: vi.fn(async () => {}),
}))
vi.mock('../lib/runtimeInstall.js', () => ({ ensureManagedGrid: vi.fn(async () => {}) }))

type AttemptDeps = Parameters<typeof reconcileGridAttach>[0]
const onGrid = (agentId: string, state: string) => ({ agentId, grid: { state } }) as unknown as RegisteredSession

function setup(advertised: RegisteredSession[] = []) {
  const list = [...advertised]
  const core = fakeCore({ agents: { advertised: vi.fn(() => list), sync: vi.fn() } })
  const ports = emptyPorts()
  startModels(core, ports)
  const options = vi.mocked(createGridAccess).mock.calls.at(-1)![0]
  const changed = vi.mocked(onGridModelsChanged).mock.calls.at(-1)![0]
  return { core, list, port: ports.models as ModelsPort, options, changed }
}

/** The reconcile deps the access attempt builds, for one attempt. */
async function attemptDeps(options: ReturnType<typeof setup>['options']): Promise<AttemptDeps> {
  await options.attempt({ ownGrid: true, signedInThisRun: false })
  const [deps, request] = vi.mocked(reconcileGridAttach).mock.calls.at(-1)!
  expect(request).toEqual({ ownGrid: true, signedInThisRun: false })
  return deps
}

describe('the models service', () => {
  beforeEach(() => { vi.spyOn(console, 'log').mockImplementation(() => {}) })
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  describe('grid access, on first use', () => {
    it('knows grid holds a sign-in from the file grid keeps, and logs as grid-attach', () => {
      const { options } = setup()
      expect(options.signedIn()).toBe(true)
      vi.mocked(signedInGridEmail).mockReturnValueOnce(null)
      expect(options.signedIn()).toBe(false)
      options.log('attached')
      expect(console.log).toHaveBeenCalledWith('[grid-attach] attached')
    })

    it('installs the pinned managed runtime first, and grid\'s own installer only when there is none', async () => {
      const deps = await attemptDeps(setup().options)
      await deps.installCli()
      const [runtimeLog] = vi.mocked(ensureManagedGrid).mock.calls[0]
      runtimeLog!('pinned 1.2.3')
      expect(console.log).toHaveBeenCalledWith('[grid-runtime] pinned 1.2.3')
      expect(ensureGridInstalled).not.toHaveBeenCalled()
      vi.mocked(gridAvailable).mockReturnValueOnce(false)
      await deps.installCli()
      expect(ensureGridInstalled).toHaveBeenCalledTimes(1)
      expect(console.log).not.toHaveBeenCalledWith(expect.stringContaining('[grid-attach]'))
      vi.mocked(gridAvailable).mockReturnValueOnce(false)
      vi.mocked(ensureGridInstalled).mockResolvedValueOnce({ status: 'failed', message: 'no network' } as never)
      await deps.installCli()
      expect(console.log).toHaveBeenCalledWith('[grid-attach] no network')
    })

    it('asks the core for the grid name and the token, and grid for the rest', async () => {
      const { core, options } = setup()
      const deps = await attemptDeps(options)
      expect(deps.gridAvailable()).toBe(true)
      expect(await deps.mintName()).toBeNull()
      expect(core.account.mintGridName).toHaveBeenCalled()
      expect(await deps.accessToken()).toBe('token')
      expect(deps.signedInEmail()).toBe('me@example.com')
      expect(deps.gridNames()).toEqual(['grid-1'])
      expect(gridNamesLocal).toHaveBeenCalled()
      await deps.handoff('t1')
      expect(handOffToGrid).toHaveBeenCalledWith('t1', { json: true })
      await deps.ensure('grid-1')
      expect(ensureHarnessGrid).toHaveBeenCalledWith('grid-1')
      deps.log('handed off')
      expect(console.log).toHaveBeenCalledWith('[grid-attach] handed off')
    })

    it('once the account\'s grid has a name, answers the picker with it and drops what a stale sign-in filled', async () => {
      const { core, options } = setup()
      const deps = await attemptDeps(options)
      deps.onName('grid-7')
      expect(core.clients.gridNamed).toHaveBeenCalledWith('grid-7')
      expect(forgetGridModels).toHaveBeenCalled()
      expect(resetGridDeriveMemo).toHaveBeenCalled()
      expect(clearGridMcpUrlCache).toHaveBeenCalled()
    })
  })

  describe('the model pictures on agents\' frames', () => {
    it('pushes again the frames of agents on a grid whose annotation moved, only those and only when it moved', () => {
      const plain = { agentId: 'plain' } as RegisteredSession
      const { core, list, changed } = setup([onGrid('a1', 'awake'), onGrid('a2', 'asleep'), plain])
      changed()
      expect(core.agents.sync).toHaveBeenCalledTimes(2)
      changed()
      expect(core.agents.sync).toHaveBeenCalledTimes(2)
      list[0] = onGrid('a1', 'asleep')
      changed()
      expect(core.agents.sync).toHaveBeenCalledTimes(3)
      expect(core.agents.sync).toHaveBeenLastCalledWith(list[0])
      expect(gridAnnotation).not.toHaveBeenCalledWith(undefined)
    })

    it('forgets an agent that left a grid, so its next appearance is announced', () => {
      const { core, list, changed } = setup([onGrid('a1', 'awake')])
      changed()
      list.length = 0
      changed()
      list.push(onGrid('a1', 'awake'))
      changed()
      expect(core.agents.sync).toHaveBeenCalledTimes(2)
    })

    it('brings back the saved pictures at start, and a failure to is not fatal', async () => {
      vi.mocked(warmGridModels).mockRejectedValueOnce(new Error('unreadable'))
      setup()
      expect(warmGridModels).toHaveBeenCalled()
      await Promise.resolve()
    })
  })

  describe('its port', () => {
    it('has grid ready through the one access, and says offline whether grid is set up', async () => {
      const { port } = setup()
      expect(await port.ensure({ ownGrid: true })).toMatchObject({ status: 'converged' })
      expect(access.ensure).toHaveBeenCalledWith({ ownGrid: true })
      expect(port.setUp()).toBe(true)
      vi.mocked(signedInGridEmail).mockReturnValueOnce(null)
      expect(port.setUp()).toBe(false)
      vi.mocked(gridAvailable).mockReturnValueOnce(false)
      expect(port.setUp()).toBe(false)
    })

    it('starts a sleeping grid while someone types, ignoring a prewarm that fails, and forgets the web tools on sign-out', async () => {
      const { port } = setup()
      const grid = { networkId: 'n1', model: 'big' } as never
      port.prewarm(grid)
      expect(keystrokePrewarm).toHaveBeenCalledWith(grid)
      vi.mocked(keystrokePrewarm).mockRejectedValueOnce(new Error('asleep'))
      port.prewarm(grid)
      await Promise.resolve()
      port.signedOut()
      expect(clearGridMcpUrlCache).toHaveBeenCalledTimes(1)
    })
  })
})
