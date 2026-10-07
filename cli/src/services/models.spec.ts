import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { emptyPorts, MODELS_FALLBACKS, type ModelsPort } from '../core/api.js'
import { createServiceHost } from '../core/serviceHost.js'
import { installedDsh } from '../dsh/installed.js'
import { appEngineOps, scanAppModels } from '../lib/appModels.js'
import { createGridAccess, gridNamesLocal, reconcileGridAttach, type GridAttachResult } from '../lib/gridAttach.js'
import { deriveHarnessGridName, resetGridDeriveMemo, signedInGridEmail } from '../lib/gridDerive.js'
import { ensureHarnessGrid } from '../lib/gridEnsure.js'
import { gridAvailable, managedGridPath } from '../lib/gridExec.js'
import { GridFleetRpc } from '../lib/gridFleetRpc.js'
import { handOffToGrid } from '../lib/gridHandoff.js'
import { gridCapableEngines } from '../lib/gridLaunch.js'
import { ensureGridInstalled } from '../lib/gridInstall.js'
import { clearGridMcpUrlCache } from '../lib/gridMcpUrl.js'
import {
  forgetGridModels, gridAnnotation, gridInventory, keystrokePrewarm, listAllGridModels, listGridModels, observeMachineList, onGridModelsChanged,
  presentGridSections, retargetPrewarm, warmGridModels, type GridSection,
} from '../lib/gridModels.js'
import { resolveGridTarget } from '../lib/gridTarget.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { RuntimeModelOption } from '../lib/runtimeProfile.js'
import { ensureManagedGrid, startGridPinRecheck } from '../lib/runtimeInstall.js'
import { apiConnectionsRequest } from '../lib/apiConnections.js'
import { apiModelsRequest, rememberSavedApis } from '../lib/apiModels.js'
import { linkCodexProfile, listCodexProfiles } from '../lib/codexProfiles.js'
import { fakeCore } from '../testing/fakeCore.js'
import { compactRuntimePickerModels, launchTarget, MODELS_REQUESTS, startModels } from './models.js'

const access = vi.hoisted(() => ({ ensure: vi.fn(async (_request?: { ownGrid?: boolean }): Promise<GridAttachResult> => ({ status: 'converged', name: 'grid-1', detail: 'ok' })) }))
vi.mock('../lib/gridAttach.js', () => ({
  createGridAccess: vi.fn(() => access),
  gridNamesLocal: vi.fn(() => ['grid-1']),
  reconcileGridAttach: vi.fn(async () => ({ status: 'signed-in', name: 'grid-1', detail: 'ok' })),
}))
vi.mock('../lib/gridDerive.js', () => ({ deriveHarnessGridName: vi.fn(async () => null), resetGridDeriveMemo: vi.fn(), signedInGridEmail: vi.fn(() => 'me@example.com') }))
vi.mock('../lib/gridEnsure.js', () => ({ ensureHarnessGrid: vi.fn(async () => 'converged') }))
vi.mock('../lib/gridExec.js', () => ({ gridAvailable: vi.fn(() => true), gridCliPresence: vi.fn(() => 'managed'), managedGridPath: vi.fn(() => null) }))
/** The Model Manager's grid commands: what each job was run as, and what it answers. */
const fleet = vi.hoisted(() => ({ run: vi.fn(async (..._args: unknown[]): Promise<Record<string, unknown>> => ({ ok: true, code: 0, stdout: '[]', stderr: '', error: null })), cancel: vi.fn((..._args: unknown[]) => true) }))
vi.mock('../lib/gridFleetRpc.js', async (real) => ({
  ...await real<object>(),
  GridFleetRpc: vi.fn(class { run = fleet.run; cancel = fleet.cancel }),
}))
vi.mock('../lib/gridTarget.js', () => ({ resolveGridTarget: vi.fn(async () => null) }))
vi.mock('../lib/gridHandoff.js', () => ({ handOffToGrid: vi.fn(async () => ({ ok: true })) }))
vi.mock('../lib/gridInstall.js', () => ({ ensureGridInstalled: vi.fn(async () => ({ status: 'present', message: '' })) }))
vi.mock('../lib/gridMcpUrl.js', () => ({ clearGridMcpUrlCache: vi.fn() }))
vi.mock('../lib/gridModels.js', () => ({
  forgetGridModels: vi.fn(),
  gridAnnotation: vi.fn((grid: { state: string }) => ({ state: grid.state })),
  gridInventory: vi.fn(),
  keystrokePrewarm: vi.fn(async () => 'started'),
  listAllGridModels: vi.fn(async () => []),
  listGridModels: vi.fn(async () => []),
  observeMachineList: vi.fn(),
  onGridModelsChanged: vi.fn(),
  retargetPrewarm: vi.fn(async () => 'fired'),
  presentGridSections: vi.fn((sections: unknown[]) => sections),
  warmGridModels: vi.fn(async () => {}),
}))
vi.mock('../lib/runtimeInstall.js', () => ({ ensureManagedGrid: vi.fn(async () => {}), startGridPinRecheck: vi.fn(() => () => {}) }))
/** The saved APIs and the Codex profiles: their files and folders are the lib's, never this machine's here. */
const apis = vi.hoisted(() => ({ stores: [] as string[] }))
vi.mock('../lib/apiConnections.js', () => ({
  ApiConnections: class { constructor(dataDir: string) { apis.stores.push(dataDir) } },
  apiConnectionsRequest: vi.fn((_store: unknown, payload: Record<string, unknown>) => ({ connections: [], presets: [], action: payload.action })),
}))
vi.mock('../lib/apiModels.js', () => ({
  apiModelsRequest: vi.fn(async (_store: unknown, payload: Record<string, unknown>) => ({ id: payload.id, models: ['m1'] })),
  rememberSavedApis: vi.fn(),
}))
vi.mock('../lib/codexProfiles.js', () => ({
  listCodexProfiles: vi.fn((observed: string[]) => observed.map((path) => ({ path, label: 'Codex' }))),
  linkCodexProfile: vi.fn((path: string) => (path ? { path, label: 'Linked' } : { error: 'INVALID_PATH' })),
}))
vi.mock('../lib/appModels.js', () => ({ appEngineOps: vi.fn(() => ({ engines: 'app' })), scanAppModels: vi.fn(async () => []) }))
vi.mock('../dsh/installed.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../dsh/installed.js')>(),
  installedDsh: vi.fn(() => ({ realDir: '/dsh/model-manager' })),
}))
/** The Model Manager's local models: what the service built it with, and its list and act. */
const local = vi.hoisted(() => ({
  options: {} as Record<string, any>,
  list: vi.fn(async (_grid: string | null, _force?: boolean): Promise<Record<string, unknown>> => ({ models: [], busy: false, observedAt: 'now' })),
  act: vi.fn(async (_grid: string | null, _modelId: unknown, _action: string): Promise<Record<string, unknown>> => ({})),
}))
vi.mock('../lib/localModels.js', () => ({
  LocalModels: class {
    constructor(options: Record<string, unknown>) { local.options = options }
    list = local.list
    act = local.act
  },
}))

type AttemptDeps = Parameters<typeof reconcileGridAttach>[0]
type Over = Parameters<typeof fakeCore>[0]
const onGrid = (agentId: string, state: string) => ({ agentId, grid: { state } }) as unknown as RegisteredSession

function setup(advertised: RegisteredSession[] = [], over: Over = {}) {
  const list = [...advertised]
  const core = fakeCore({ ...over, agents: { advertised: vi.fn(() => list), sync: vi.fn(), ...over.agents } })
  const ports = emptyPorts()
  const requests = startModels(core, ports)
  const options = vi.mocked(createGridAccess).mock.calls.at(-1)![0]
  const changed = vi.mocked(onGridModelsChanged).mock.calls.at(-1)![0]
  /** Ask one request as a local window would. */
  const ask = async (type: string, payload: Record<string, unknown> = {}) => await requests[type]!(payload, { local: true, owner: true })
  return { core, list, port: ports.models as ModelsPort, options, changed, requests, ask }
}

/** The reconcile deps the access attempt builds, for one attempt. */
async function attemptDeps(options: ReturnType<typeof setup>['options']): Promise<AttemptDeps> {
  await options.attempt({ ownGrid: true, signedInThisRun: false })
  const [deps, request] = vi.mocked(reconcileGridAttach).mock.calls.at(-1)!
  expect(request).toEqual({ ownGrid: true, signedInThisRun: false })
  return deps
}

const section = (name: string, own: boolean, models: Array<{ id: string; node?: string }>) =>
  ({ name, type: 'permissioned-public', own, models, state: 'awake', seenAt: null, lastKnownAge: null }) as unknown as GridSection

/** A promise and the hands that settle it. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail })
  return { promise, resolve, reject }
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

    it('tells the core the windows\' lists may have changed, whatever the agents', () => {
      const { core, changed } = setup()
      changed()
      expect(core.clients.gridModelsChanged).toHaveBeenCalledOnce()
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

  describe('the managed grid\'s pin', () => {
    it('follows a managed grid\'s pin as it starts and every recheck after, and leaves a machine with none alone', async () => {
      setup()
      expect(ensureManagedGrid).not.toHaveBeenCalled()
      const recheck = vi.mocked(startGridPinRecheck).mock.calls.at(-1)![0]!.ensure!
      vi.mocked(managedGridPath).mockReturnValue('/runtime/grid-0.3.49/bin/grid')
      try {
        await recheck()
        expect(ensureManagedGrid).toHaveBeenCalledOnce()
        vi.mocked(ensureManagedGrid).mock.calls[0]![0]!('pinned 0.3.49')
        expect(console.log).toHaveBeenCalledWith('[grid-runtime] pinned 0.3.49')
        setup()
        expect(ensureManagedGrid).toHaveBeenCalledTimes(2)
      } finally {
        vi.mocked(managedGridPath).mockReturnValue(null)
      }
    })
  })

  describe('its port', () => {
    it('has grid ready through the one access', async () => {
      const { port } = setup()
      expect(await port.ensure({ ownGrid: true })).toMatchObject({ status: 'converged' })
      expect(access.ensure).toHaveBeenCalledWith({ ownGrid: true })
    })

    it('reads an agent\'s note off the pictures, and starts a sleeping grid while someone types, ignoring a prewarm that fails', async () => {
      const { port } = setup()
      const grid = { baseUrl: 'https://fixture.invalid/g/n1/relay/v1', model: 'big' }
      expect(port.annotation({ state: 'asleep' } as never)).toEqual({ state: 'asleep' })
      port.prewarm(grid)
      expect(keystrokePrewarm).toHaveBeenCalledWith(grid)
      vi.mocked(keystrokePrewarm).mockRejectedValueOnce(new Error('asleep'))
      port.prewarm(grid)
      await Promise.resolve()
    })

    it('starts the grid an agent was just moved onto, ignoring a prewarm that fails, and forgets the web tools on sign-out', async () => {
      const { port } = setup()
      const launch = { networkId: 'n1', networkName: 'mine', baseUrl: 'https://fixture.invalid/g/n1/relay/v1', apiKey: 'k', model: 'big' }
      port.moved(launch)
      expect(retargetPrewarm).toHaveBeenCalledWith(launch)
      vi.mocked(retargetPrewarm).mockRejectedValueOnce(new Error('offline'))
      port.moved(launch)
      await Promise.resolve()
      port.signedOut()
      expect(clearGridMcpUrlCache).toHaveBeenCalledTimes(1)
    })

    it('hears which of the account\'s computers seem offline from the machine list the core read', () => {
      const { port } = setup()
      port.machines({ data: { machines: [] } }, 'computer-here')
      expect(observeMachineList).toHaveBeenCalledWith({ data: { machines: [] } }, 'computer-here')
    })

    it('names the account\'s grid as the backend did, else as this machine works it out', async () => {
      const told = setup([], { account: { privateGridName: vi.fn(async () => 'mine') } })
      expect(await told.port.privateGridName()).toBe('mine')
      expect(deriveHarnessGridName).not.toHaveBeenCalled()
      vi.mocked(deriveHarnessGridName).mockResolvedValueOnce('derived-1a2b3c4d')
      expect(await setup().port.privateGridName()).toBe('derived-1a2b3c4d')
    })

    it('builds the lists the windows are pushed from the pictures as they stand, in both forms', async () => {
      const sections = [section('mine', true, [{ id: 'Small-Q4', node: 'mac' }])]
      vi.mocked(listAllGridModels).mockResolvedValueOnce(sections)
      const { port } = setup([], { account: { privateGridName: vi.fn(async () => 'mine') } })
      const lists = await port.lists()
      expect(listAllGridModels).toHaveBeenCalledWith('mine', { refresh: false })
      expect(lists.plain).toMatchObject({ gridName: 'mine', models: [{ id: 'Small-Q4', node: 'mac' }] })
      expect(lists.rowState).toMatchObject({ gridName: 'mine', grids: sections })
      expect(presentGridSections).toHaveBeenCalledWith(sections, { rowState: false })
      expect(presentGridSections).toHaveBeenCalledWith(sections, { rowState: true })
    })

    describe('where an agent on a grid model sends its inference', () => {
      const target = { networkId: 'g', networkName: 'my-grid', baseUrl: 'https://fixture.invalid/relay/v1', apiKey: 'fixture-key', model: 'Qwen-35B' }

      it('a new agent: the exact model, refreshed, on the grid it was picked from', async () => {
        vi.mocked(listGridModels).mockResolvedValueOnce([{ id: 'Qwen-35B', node: 'Mac Studio' }])
        vi.mocked(resolveGridTarget).mockResolvedValueOnce(target)
        const { port } = setup()
        expect(await port.launchTarget({ model: 'Qwen-35B', grid: 'my-grid' })).toEqual(target)
        expect(forgetGridModels).toHaveBeenCalledOnce()
        expect(listGridModels).toHaveBeenCalledWith('my-grid')
        expect(resolveGridTarget).toHaveBeenCalledWith('my-grid', 'Qwen-35B')
      })

      it('a new agent: a stopped model resolves nothing, and a failure is the caller\'s to refuse', async () => {
        vi.mocked(listGridModels).mockResolvedValueOnce([{ id: 'Another-model', node: 'Mac Studio' }])
        expect(await launchTarget({ model: 'Qwen-35B', grid: 'my-grid' })).toBeNull()
        expect(resolveGridTarget).not.toHaveBeenCalled()
        vi.mocked(listGridModels).mockResolvedValueOnce([{ id: 'Qwen-35B', node: '' }])
        expect(await launchTarget({ model: 'Qwen-35B', grid: 'my-grid' })).toBeNull()
        vi.mocked(listGridModels).mockRejectedValueOnce(new Error('offline'))
        await expect(launchTarget({ model: 'Qwen-35B', grid: 'my-grid' })).rejects.toThrow('offline')
      })

      it("a move signs grid in first — with the account's own grid only when the model is on it", async () => {
        vi.mocked(resolveGridTarget).mockResolvedValue(target)
        try {
          const { port } = setup([], { account: { privateGridName: vi.fn(async () => 'mine') } })
          expect(await port.moveTarget({ gridName: 'team-grid-0000aaaa', model: 'Shared-Model' })).toEqual({ target })
          expect(resolveGridTarget).toHaveBeenLastCalledWith('team-grid-0000aaaa', 'Shared-Model')
          expect(await port.moveTarget({ gridName: null, model: 'Own-Model' })).toEqual({ target })
          expect(resolveGridTarget).toHaveBeenLastCalledWith('mine', 'Own-Model')
          expect(await port.moveTarget({ gridName: 'mine', model: 'Own-Model' })).toEqual({ target })
          expect(access.ensure.mock.calls).toEqual([[{ ownGrid: false }], [{ ownGrid: true }], [{ ownGrid: true }]])
        } finally {
          vi.mocked(resolveGridTarget).mockReset()
        }
      })

      it('a move grid cannot be set up for says why and reads no grid; one whose endpoint cannot be read says so', async () => {
        const { port } = setup()
        access.ensure.mockResolvedValueOnce({ status: 'handoff-failed', name: null, detail: 'no grid on this computer' })
        expect(await port.moveTarget({ gridName: 'team', model: 'Shared-Model' })).toEqual({ detail: 'no grid on this computer' })
        expect(resolveGridTarget).not.toHaveBeenCalled()
        expect(await port.moveTarget({ gridName: 'team', model: 'Shared-Model' })).toEqual({ detail: 'Could not read this machine\'s grid endpoint.' })
      })
    })
  })

  describe("the Model Manager's grid commands", () => {
    const COMMAND = { args: ['--remote', 'ls', '--json'], timeoutMs: 5_000 }
    const asker = { local: true, owner: true, connection: 'local:grid', requestId: 'cmd-1' }

    it('runs against grid as it stands, as a job of the connection and request that asked — never setting grid up', async () => {
      const { requests } = setup()
      expect(await requests.grid_fleet_run!(COMMAND, asker)).toEqual({ ok: true, code: 0, stdout: '[]', stderr: '', error: null })
      expect(fleet.run).toHaveBeenCalledWith('local:grid', 'cmd-1', { args: COMMAND.args, timeoutMs: 5_000 })
      expect(access.ensure).not.toHaveBeenCalled()
      expect(GridFleetRpc).toHaveBeenCalledTimes(1)
    })

    it('refuses a command it cannot read, or one with no connection or request to belong to', async () => {
      const { requests } = setup()
      expect(await requests.grid_fleet_run!({ args: [] }, asker)).toEqual({ error: 'INVALID_GRID_COMMAND' })
      expect(await requests.grid_fleet_run!(COMMAND, { local: true, owner: true, requestId: 'cmd-1' })).toEqual({ error: 'INVALID_GRID_COMMAND' })
      expect(await requests.grid_fleet_run!(COMMAND, { local: true, owner: true, connection: 'local:grid' })).toEqual({ error: 'INVALID_GRID_COMMAND' })
      expect(fleet.run).not.toHaveBeenCalled()
    })

    it('a run that fails unexpectedly is answered in one sentence', async () => {
      fleet.run.mockRejectedValueOnce(new Error('spawn EMFILE'))
      const { requests } = setup()
      expect(await requests.grid_fleet_run!(COMMAND, asker)).toEqual({ ok: false, code: 1, error: 'Grid command failed unexpectedly.' })
    })

    it('a cancel stops only the asking connection\'s own command', async () => {
      const { requests } = setup()
      expect(await requests.grid_fleet_cancel!({ commandId: 'cmd-1' }, asker)).toEqual({ cancelled: true })
      expect(fleet.cancel).toHaveBeenCalledWith('local:grid', 'cmd-1')
      fleet.cancel.mockReturnValueOnce(false)
      expect(await requests.grid_fleet_cancel!({ commandId: 'cmd-2' }, asker)).toEqual({ cancelled: false })
      expect(await requests.grid_fleet_cancel!({ commandId: 7 }, asker)).toEqual({ cancelled: false })
      expect(await requests.grid_fleet_cancel!({ commandId: 'cmd-1' }, { local: true, owner: true })).toEqual({ cancelled: false })
      expect(fleet.cancel).toHaveBeenCalledTimes(2)
    })
  })

  describe('the requests it answers for the apps', () => {
    it('answers exactly the requests it declares, and while it is off the host answers them unavailable', async () => {
      expect(Object.keys(setup().requests).sort()).toEqual([...MODELS_REQUESTS].sort())
      // Not the grid commands' handshake, which the Grid harness reads as "update Harness" when it does
      // not answer: the socket's own, so a models service that is down does not make it say that.
      expect(MODELS_REQUESTS).not.toContain('grid_fleet_capabilities')

      const on = createServiceHost(emptyPorts(), { log: () => {} })
      on.start('models', startModels, fakeCore(), MODELS_FALLBACKS, MODELS_REQUESTS)
      expect(on.isOff('models')).toBe(false)
      const off = createServiceHost(emptyPorts(), { log: () => {}, faults: new Set(['models']) })
      off.start('models', startModels, fakeCore(), MODELS_FALLBACKS, MODELS_REQUESTS)
      for (const type of MODELS_REQUESTS) {
        const reply = vi.fn()
        expect(off.route(type, { requestId: 'r' }, { local: true, owner: true }, reply)).toBe(true)
        expect(reply).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: false })
      }
    })

    describe('grid_models_list', () => {
      it("answers every grid in sections, the account's own first, in the shape the push has", async () => {
        const sections = [section('mine', true, [{ id: 'Small-Q4', node: 'mac' }]), section('team', false, [{ id: 'Big', node: 'studio' }])]
        vi.mocked(listAllGridModels).mockResolvedValueOnce(sections)
        const { core, ask } = setup([], { account: { privateGridName: vi.fn(async () => 'mine') } })

        expect(await ask('grid_models_list')).toEqual({
          gridName: 'mine',
          models: [{ id: 'Small-Q4', node: 'mac' }],
          grids: sections,
          localModelEngines: gridCapableEngines(),
          supportsModelLaunch: true,
          gridCli: 'managed',
        })
        expect(core.account.privateGridName).toHaveBeenCalled()
        expect(listAllGridModels).toHaveBeenCalledExactlyOnceWith('mine')
        // A window that did not ask for row state reads the offline label in the node text.
        expect(presentGridSections).toHaveBeenCalledWith(sections, { rowState: false })
      })

      it('labels rows for a window that draws row state, and names no models when no grid is its own', async () => {
        const sections = [section('team', false, [{ id: 'Big' }])]
        vi.mocked(listAllGridModels).mockResolvedValueOnce(sections)
        const { ask } = setup()
        expect(await ask('grid_models_list', { rowState: true })).toMatchObject({ gridName: null, models: [], grids: sections })
        expect(presentGridSections).toHaveBeenCalledWith(sections, { rowState: true })
      })

      it('shares the one listing out with every ask for the same grid that lands meanwhile, and starts afresh after it', async () => {
        const first = deferred<GridSection[]>()
        vi.mocked(listAllGridModels).mockReturnValueOnce(first.promise)
        const { ask } = setup([], { account: { privateGridName: vi.fn(async () => 'mine') } })
        const a = ask('grid_models_list')
        const b = ask('grid_models_list', { rowState: true })
        await vi.waitFor(() => expect(listAllGridModels).toHaveBeenCalledTimes(1))
        first.resolve([section('mine', true, [{ id: 'm' }])])
        expect(await a).toMatchObject({ models: [{ id: 'm' }] })
        expect(await b).toMatchObject({ models: [{ id: 'm' }] })
        expect(listAllGridModels).toHaveBeenCalledTimes(1)
        await ask('grid_models_list')
        expect(listAllGridModels).toHaveBeenCalledTimes(2)
      })

      it('never shares a listing of another grid, and an older listing landing late leaves the newer one out', async () => {
        const names = ['a', 'b', 'b']
        const ofA = deferred<GridSection[]>()
        const ofB = deferred<GridSection[]>()
        vi.mocked(listAllGridModels).mockReturnValueOnce(ofA.promise).mockReturnValueOnce(ofB.promise)
        const { ask } = setup([], { account: { privateGridName: vi.fn(async () => names.shift()!) } })
        const a = ask('grid_models_list')
        await vi.waitFor(() => expect(listAllGridModels).toHaveBeenCalledTimes(1))
        const b = ask('grid_models_list')
        await vi.waitFor(() => expect(listAllGridModels).toHaveBeenCalledTimes(2))
        expect(listAllGridModels).toHaveBeenLastCalledWith('b')
        ofA.resolve([section('a', true, [{ id: 'from-a' }])])
        expect(await a).toMatchObject({ gridName: 'a', models: [{ id: 'from-a' }] })
        // b's listing is still the one out: a third ask for b joins it rather than starting another, once it
        // has the grid's name.
        const again = ask('grid_models_list')
        await new Promise((resolve) => setImmediate(resolve))
        ofB.resolve([section('b', true, [{ id: 'from-b' }])])
        expect(await b).toMatchObject({ gridName: 'b', models: [{ id: 'from-b' }] })
        expect(await again).toMatchObject({ gridName: 'b', models: [{ id: 'from-b' }] })
        expect(listAllGridModels).toHaveBeenCalledTimes(2)
      })

      it('a person\'s wake goes to the grids at once, never joins a listing already out, and wakes at most eight', async () => {
        const out = deferred<GridSection[]>()
        vi.mocked(listAllGridModels).mockReturnValueOnce(out.promise)
        const { ask } = setup([], { account: { privateGridName: vi.fn(async () => 'mine') } })
        const listing = ask('grid_models_list')
        await vi.waitFor(() => expect(listAllGridModels).toHaveBeenCalledTimes(1))

        await ask('grid_models_list', { wake: [' mine ', '', '  ', 7, 'team'] })
        expect(listAllGridModels).toHaveBeenLastCalledWith('mine', { wake: ['mine', 'team'] })
        const many = Array.from({ length: 10 }, (_, i) => `grid-${i}`)
        await ask('grid_models_list', { wake: many })
        expect(listAllGridModels).toHaveBeenLastCalledWith('mine', { wake: many.slice(0, 8) })
        expect(listAllGridModels).toHaveBeenCalledTimes(3)
        out.resolve([])
        await listing
      })

      it('a listing that fails is answered GRID_MODELS_FAILED, and so is a grid name that cannot be read', async () => {
        vi.mocked(listAllGridModels).mockRejectedValueOnce(new Error('grid ls exited 1'))
        const failing = setup([], { account: { privateGridName: vi.fn(async () => 'mine') } })
        expect(await failing.ask('grid_models_list')).toEqual({ error: 'GRID_MODELS_FAILED' })
        // The failed listing is not kept for the next ask.
        expect(await failing.ask('grid_models_list')).toMatchObject({ gridName: 'mine' })
        const nameless = setup([], { account: { privateGridName: vi.fn(async () => { throw new Error('no grid') }) } })
        expect(await nameless.ask('grid_models_list')).toEqual({ error: 'GRID_MODELS_FAILED' })
      })
    })

    describe('models_list', () => {
      const catalog: RuntimeModelOption[] = [
        { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'GPT-5.6 Sol / High' },
        { id: 'runtime-v1:s1:codex:gpt-5.6-sol@auto', displayName: 'GPT-5.6 Sol / Auto' },
        { id: 'runtime-v1:s1:codex:o3@medium', displayName: 'o3 / Medium' },
        { id: 'runtime-v1:s1:codex:o3@auto', displayName: 'o3 / Auto' },
      ]

      it('answers the Model/Effort choices of every live agent, or of the one it names', async () => {
        const runtimeModels = vi.fn(async (_agentId?: string) => catalog)
        const { ask } = setup([], { agents: { runtimeModels } })
        expect(await ask('models_list')).toEqual({ models: catalog })
        expect(await ask('models_list', { agentId: '' })).toEqual({ models: catalog })
        expect(await ask('models_list', { agentId: 's1' })).toEqual({ models: catalog })
        expect(runtimeModels.mock.calls).toEqual([[undefined], [undefined], ['s1']])
      })

      it('answers the device only ids, at most what its picker draws, filtered to the picker it shows', async () => {
        const runtimeModels = vi.fn(async () => catalog)
        const { ask } = setup([], { agents: { runtimeModels } })
        expect(await ask('models_list', { agentId: 's1', compact: true, pickerMode: 'model', selectedModel: 'runtime-v1:s1:codex:gpt-5.6-sol@high' }))
          .toEqual({ models: [{ id: 'runtime-v1:s1:codex:gpt-5.6-sol@high' }, { id: 'runtime-v1:s1:codex:o3@auto' }] })
        expect(await ask('models_list', { compact: true })).toEqual({ models: catalog.map(({ id }) => ({ id })) })
      })

      it('a catalog that cannot be read is logged and answered INTERNAL, as the socket did', async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const failure = new Error('catalog unreadable')
        const { ask } = setup([], { agents: { runtimeModels: vi.fn(async () => { throw failure }) } })
        expect(await ask('models_list', { agentId: 's1' })).toEqual({ error: 'INTERNAL' })
        expect(error).toHaveBeenCalledWith('[backend] dispatch models_list failed:', failure)
      })
    })

    describe("the Model Manager's local models", () => {
      const READY: GridAttachResult = { status: 'signed-in', name: 'kelvin-1a2b3c4d', detail: '', ownGrid: 'created' }
      const named = { account: { privateGridName: vi.fn(async () => 'kelvin-1a2b3c4d') } }

      it('the list read a picker polls sets nothing up, and says when it is needed', async () => {
        vi.mocked(signedInGridEmail).mockReturnValue(null)
        try {
          const { core, ask } = setup([], named)
          expect(await ask('grid_fleet_models_list')).toEqual({ models: [], busy: false, observedAt: 'now', gridSetupNeeded: true })
          expect(access.ensure).not.toHaveBeenCalled()
          expect(local.list).toHaveBeenCalledWith('kelvin-1a2b3c4d', false)
          expect(core.clients.gridModelsChanged).not.toHaveBeenCalled()
          // Asked to, it reads afresh; still nothing set up.
          await ask('grid_fleet_models_list', { refresh: true })
          expect(local.list).toHaveBeenLastCalledWith('kelvin-1a2b3c4d', true)
          expect(access.ensure).not.toHaveBeenCalled()
        } finally {
          vi.mocked(signedInGridEmail).mockReturnValue('me@example.com')
        }
      })

      it("Set up — a list read carrying `setup` — signs grid in with the account's own grid, answers, and tells the windows", async () => {
        access.ensure.mockResolvedValueOnce(READY)
        const { core, ask } = setup([], named)
        const answer = await ask('grid_fleet_models_list', { setup: true })
        expect(access.ensure).toHaveBeenCalledExactlyOnceWith({ ownGrid: true })
        expect(answer).not.toHaveProperty('gridSetupNeeded')
        expect(answer).not.toHaveProperty('gridSetupError')
        // Read fresh: the catalog was unreachable a moment ago.
        expect(local.list).toHaveBeenCalledWith('kelvin-1a2b3c4d', true)
        expect(core.clients.gridModelsChanged).toHaveBeenCalledOnce()
      })

      it("a Get signs grid in; a Use also makes sure of the account's grid; a Stop does neither", async () => {
        access.ensure.mockResolvedValue(READY)
        const { ask } = setup([], named)
        await ask('grid_fleet_model_download', { modelId: 'org/Model-GGUF' })
        await ask('grid_fleet_model_start', { modelId: 'org/Model-GGUF' })
        await ask('grid_fleet_model_stop', { modelId: 'org/Model-GGUF' })
        expect(access.ensure.mock.calls).toEqual([[{ ownGrid: false }], [{ ownGrid: true }]])
        expect(local.act.mock.calls).toEqual([
          ['kelvin-1a2b3c4d', 'org/Model-GGUF', 'download'],
          ['kelvin-1a2b3c4d', 'org/Model-GGUF', 'start'],
          ['kelvin-1a2b3c4d', 'org/Model-GGUF', 'stop'],
        ])
        access.ensure.mockReset()
      })

      it('answers what the act answers, as it is', async () => {
        local.act.mockResolvedValueOnce({ operation: { action: 'start', modelId: 'org/Model-GGUF' } })
        local.act.mockResolvedValueOnce({ error: 'fixture refusal' })
        const { ask } = setup([], named)
        expect(await ask('grid_fleet_model_stop', { modelId: 'org/Model-GGUF' })).toEqual({ operation: { action: 'start', modelId: 'org/Model-GGUF' } })
        expect(await ask('grid_fleet_model_stop', { modelId: 'org/Model-GGUF' })).toEqual({ error: 'fixture refusal' })
      })

      it('a set-up grid refused is said, and the act waiting on it does not run', async () => {
        access.ensure.mockResolvedValue({ status: 'handoff-failed', name: 'kelvin-1a2b3c4d', detail: 'grid is too old for --harness' })
        vi.mocked(signedInGridEmail).mockReturnValue(null)
        try {
          const { core, ask } = setup([], named)
          expect(await ask('grid_fleet_model_start', { modelId: 'org/Model-GGUF' })).toEqual({ error: 'grid is too old for --harness' })
          expect(local.act).not.toHaveBeenCalled()
          expect(await ask('grid_fleet_models_list', { setup: true }))
            .toMatchObject({ gridSetupNeeded: true, gridSetupError: 'grid is too old for --harness' })
          expect(core.clients.gridModelsChanged).not.toHaveBeenCalled()
        } finally {
          access.ensure.mockReset()
          vi.mocked(signedInGridEmail).mockReturnValue('me@example.com')
        }
      })

      it('an account grid that could not be made fails a Use, not a Get', async () => {
        access.ensure.mockResolvedValue({ status: 'signed-in', name: 'kelvin-1a2b3c4d', detail: 'free plan: one grid per account', ownGrid: 'failed' })
        const { ask } = setup([], named)
        expect(await ask('grid_fleet_model_start', { modelId: 'org/Model-GGUF' })).toEqual({ error: 'free plan: one grid per account' })
        await ask('grid_fleet_model_download', { modelId: 'org/Model-GGUF' })
        expect(local.act.mock.calls.map((call) => call[2])).toEqual(['download'])
        access.ensure.mockReset()
      })

      it('says why in its own words when grid gives none, and takes a grid already there or adopted as ready', async () => {
        const { ask } = setup([], named)
        access.ensure.mockResolvedValueOnce({ status: 'no-cli', name: null, detail: '' })
        expect(await ask('grid_fleet_model_download', { modelId: 'm' })).toEqual({ error: 'Grid could not be set up on this computer. Try again.' })
        access.ensure.mockResolvedValueOnce({ status: 'signed-in', name: 'kelvin-1a2b3c4d', detail: '', ownGrid: 'failed' })
        expect(await ask('grid_fleet_model_start', { modelId: 'm' })).toEqual({ error: 'Your grid could not be created. Try again.' })
        for (const ownGrid of ['existed', 'adopted'] as const) {
          access.ensure.mockResolvedValueOnce({ status: 'converged', name: 'kelvin-1a2b3c4d', detail: '', ownGrid })
          expect(await ask('grid_fleet_model_start', { modelId: 'm' })).toEqual({})
        }
        // A sign-in alone, with nothing said about the account's grid, is ready for a Use too.
        access.ensure.mockResolvedValueOnce({ status: 'signed-in', name: 'kelvin-1a2b3c4d', detail: '' })
        expect(await ask('grid_fleet_model_start', { modelId: 'm' })).toEqual({})
        expect(local.act).toHaveBeenCalledTimes(3)
      })

      it('a failure is answered with one sentence, never with what failed', async () => {
        local.list.mockRejectedValueOnce(new Error('private-token'))
        local.act.mockRejectedValueOnce(new Error('private-token'))
        const { ask } = setup([], named)
        const list = await ask('grid_fleet_models_list')
        const stop = await ask('grid_fleet_model_stop', { modelId: 'm' })
        expect(list).toEqual({ error: 'Models are unavailable. Try again.' })
        expect(stop).toEqual({ error: 'Models are unavailable. Try again.' })
        expect(JSON.stringify([list, stop])).not.toContain('private-token')
      })

      it('is built on this machine: its folder, its name, the inventory read without a credential, and the apps that hold models', async () => {
        const { core, ask } = setup([], { dataDir: '/data/here', account: { machineName: vi.fn(() => 'Studio') } })
        expect(local.options.stateDir).toBe(join('/data/here', 'local-models'))
        expect(local.options.machineName()).toBe('Studio')
        expect(core.account.machineName).toHaveBeenCalled()
        expect(local.options.inventory).toBe(gridInventory)
        expect(appEngineOps).toHaveBeenCalledWith(process.env)
        expect(local.options.appEngines).toEqual({ engines: 'app' })
        await local.options.appModels()
        expect(installedDsh).toHaveBeenCalledWith('autonomous/autonomous-grid')
        expect(scanAppModels).toHaveBeenLastCalledWith({ node: process.execPath, packageDir: '/dsh/model-manager', env: process.env })
        vi.mocked(installedDsh).mockReturnValueOnce(undefined)
        await local.options.appModels()
        expect(scanAppModels).toHaveBeenLastCalledWith({ node: process.execPath, packageDir: null, env: process.env })
        // A start or stop finished: every list reads again, and the windows are told.
        local.options.onChanged()
        expect(forgetGridModels).toHaveBeenCalledOnce()
        expect(core.clients.gridModelsChanged).toHaveBeenCalledOnce()
        expect(await ask('grid_fleet_models_list')).toMatchObject({ models: [] })
      })
    })

    describe('what an agent can be launched on besides a model: the saved APIs and the Codex profiles', () => {
      it('api_connections: only the owner manages the saved APIs, kept in the data folder', async () => {
        const { requests } = setup([], { dataDir: '/data/here' })
        expect(apis.stores.at(-1)).toBe('/data/here')
        // A device or an observer may not, whatever it asked.
        expect(await requests.api_connections!({ action: 'list' }, { local: false, owner: false })).toEqual({ error: 'OWNER_REQUIRED' })
        expect(apiConnectionsRequest).not.toHaveBeenCalled()
      })

      it('api_connections: lists, saves (and recognises agents already on the saved endpoints), removes, and reads an API\'s models', async () => {
        const { ask } = setup()
        expect(await ask('api_connections', { action: 'list' })).toEqual({ connections: [], presets: [], action: 'list' })
        expect(rememberSavedApis).not.toHaveBeenCalled()
        expect(await ask('api_connections', { action: 'save', connection: { name: 'x' } })).toEqual({ connections: [], presets: [], action: 'save' })
        expect(rememberSavedApis).toHaveBeenCalledOnce()
        expect(await ask('api_connections', { action: 'remove', id: 'a' })).toEqual({ connections: [], presets: [], action: 'remove' })
        expect(await ask('api_connections', { action: 'models', id: 'a' })).toEqual({ id: 'a', models: ['m1'] })
        expect(apiModelsRequest).toHaveBeenCalledOnce()
        expect(rememberSavedApis).toHaveBeenCalledOnce()
      })

      it('codex_profiles_list: the folders this machine offers, with the ones the asker has seen; a failed scan is said', async () => {
        const { ask } = setup()
        expect(await ask('codex_profiles_list', { observedPaths: ['/home/me/.codex-work', 7] })).toEqual({ profiles: [{ path: '/home/me/.codex-work', label: 'Codex' }] })
        expect(listCodexProfiles).toHaveBeenLastCalledWith(['/home/me/.codex-work'])
        expect(await ask('codex_profiles_list')).toEqual({ profiles: [] })
        vi.mocked(listCodexProfiles).mockImplementationOnce(() => { throw new Error('unreadable') })
        expect(await ask('codex_profiles_list')).toEqual({ error: 'CODEX_PROFILES_FAILED' })
      })

      it('codex_profile_link: links the folder and answers the profile, or why not; a failure to save answers INTERNAL, as the socket did', async () => {
        const { ask } = setup()
        expect(await ask('codex_profile_link', { path: '/home/me/.codex-work' })).toEqual({ profile: { path: '/home/me/.codex-work', label: 'Linked' } })
        expect(await ask('codex_profile_link', { path: 42 })).toEqual({ error: 'INVALID_PATH' })
        expect(linkCodexProfile).toHaveBeenLastCalledWith('')
        const log = vi.spyOn(console, 'error').mockImplementation(() => {})
        vi.mocked(linkCodexProfile).mockImplementationOnce(() => { throw new Error('disk full') })
        expect(await ask('codex_profile_link', { path: '/home/me/.codex-work' })).toEqual({ error: 'INTERNAL' })
        expect(log).toHaveBeenCalledWith('[backend] dispatch codex_profile_link failed:', expect.any(Error))
        log.mockRestore()
      })
    })
  })
})

describe('the device picker\'s compact catalog', () => {
  const models = [
    { id: 'runtime-v1:s1:codex:gpt-5.6-sol@auto', displayName: 'Sol / Auto' },
    { id: 'runtime-v1:s1:codex:gpt-5.6-sol@medium', displayName: 'Sol / Medium' },
    { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high', displayName: 'Sol / High' },
    { id: 'runtime-v1:s1:codex:o3@high', displayName: 'o3 / High' },
    { id: 'runtime-v1:s2:claude:sonnet@high', displayName: 'Sonnet / High' },
  ]

  it('returns only explicit efforts for the selected session model', () => {
    expect(compactRuntimePickerModels(
      models,
      's1',
      'effort',
      'runtime-v1:s1:codex:gpt-5.6-sol@medium',
    )).toEqual([
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@medium' },
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high' },
    ])
    // Each effort once, though the catalog repeats it.
    expect(compactRuntimePickerModels([...models, models[2]!], 's1', 'effort', 'runtime-v1:s1:codex:gpt-5.6-sol@high'))
      .toEqual([{ id: 'runtime-v1:s1:codex:gpt-5.6-sol@medium' }, { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high' }])
    // No effort to show for a model the agent is not known to run.
    expect(compactRuntimePickerModels(models, 's1', 'effort', 'runtime-v1:s2:claude:sonnet@high')).toEqual([])
    expect(compactRuntimePickerModels(models, 's1', 'effort', null)).toEqual([])
  })

  it('lists each of the agent\'s models once, at the effort it runs, else Auto, else the first', () => {
    expect(compactRuntimePickerModels(models, 's1', 'model', 'runtime-v1:s1:codex:o3@high')).toEqual([
      // The running model first; the others at the running effort when they have it.
      { id: 'runtime-v1:s1:codex:o3@high' },
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@high' },
    ])
    expect(compactRuntimePickerModels(models, 's1', 'model', null)).toEqual([
      { id: 'runtime-v1:s1:codex:gpt-5.6-sol@auto' },
      { id: 'runtime-v1:s1:codex:o3@high' },
    ])
    // Without the agent named there is nothing to filter by: every id, as the web gets them.
    expect(compactRuntimePickerModels(models, undefined, 'model', null)).toEqual(models.map(({ id }) => ({ id })))
  })

  it('caps the device model list and keeps the running model in it', () => {
    // Devin publishes 72 models; a 49-row wheel already tripped the device's task watchdog once.
    const many = Array.from({ length: 40 }, (_, i) => ({
      id: `runtime-v1:s1:devin:model-${i}@auto`,
      displayName: `Model ${i}`,
    }))
    const capped = compactRuntimePickerModels(many, 's1', 'model', 'runtime-v1:s1:devin:model-39@auto')

    expect(capped).toHaveLength(24)
    // The model the agent is running would have fallen off the end of the catalog order.
    expect(capped[0]).toEqual({ id: 'runtime-v1:s1:devin:model-39@auto' })
    // The web asks without a picker mode and still gets the whole catalog.
    expect(compactRuntimePickerModels(many, 's1', undefined, null)).toHaveLength(40)
  })
})
