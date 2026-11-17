import { afterEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../dsh/installed.js'
import { materializeWorkspace } from '../dsh/materialize.js'
import { forkRuntimeKey, prepareHarnessLaunch } from '../dsh/runtime.js'
import type { PrepareDsh } from '../dsh/preparation.js'
import { prepareInstructionWrites } from '../scm/instructionWrites.js'
import { storeLaunchPort } from './storeLaunch.js'
import { createStorePreparation } from './store.js'
import { fakeCore } from '../testing/fakeCore.js'
import { MODEL_MANAGER_ID } from '../dsh/builtinIds.js'

vi.mock('../scm/instructionWrites.js', () => ({ prepareInstructionWrites: vi.fn(async () => {}) }))
vi.mock('../dsh/installed.js', () => ({ installedDsh: vi.fn(), dshRootDir: () => '/unused' }))
vi.mock('../dsh/materialize.js', () => ({ materializeWorkspace: vi.fn() }))
vi.mock('../dsh/runtime.js', () => ({ forkRuntimeKey: vi.fn(() => 'source-runtime'), prepareHarnessLaunch: vi.fn() }))
const run: PrepareDsh = async (_workspace, _input, action) => action()
const request = { dsh: 'test/draw', workspace: '/workspace', engine: 'codex' as const, key: 'agent', account: { privateGrid: 'private' } }
const pkg = { id: request.dsh } as NonNullable<ReturnType<typeof installedDsh>>

describe('the Store owns package preparation', () => {
  afterEach(() => vi.clearAllMocks())
  it('recovers incomplete startup on the next actual package request without restarting', async () => {
    let installed: typeof pkg | undefined
    const prepare = vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockImplementation(() => {
      installed = { ...pkg, id: MODEL_MANAGER_ID, manifest: { spec: 1, id: MODEL_MANAGER_ID, name: 'Models', engine: 'codex' } }
      return true
    })
    const ready = createStorePreparation(fakeCore(), prepare)
    expect(ready()).toBe(false)
    const port = storeLaunchPort(() => installed, run, ready)
    expect(await port.dshDescribe({ ...request, dsh: MODEL_MANAGER_ID })).toMatchObject({ error: 'DSH_UNAVAILABLE', unavailable: 'store' })
    expect(await port.dshDescribe({ ...request, dsh: MODEL_MANAGER_ID })).toMatchObject({ ok: true, id: MODEL_MANAGER_ID })
    expect(await port.dshDescribe({ ...request, dsh: MODEL_MANAGER_ID })).toMatchObject({ ok: true })
    expect(prepare).toHaveBeenCalledTimes(3)
  })
  it('refuses missing packages without writing anything', async () => {
    const port = storeLaunchPort(() => undefined, run)
    const refused = { ok: false, error: 'DSH_NOT_INSTALLED', detail: 'test/draw is not installed on this machine' }
    expect(await port.dshMaterialize(request)).toEqual(refused)
    expect(await port.dshLaunch(request)).toEqual(refused)
    expect(await port.dshDescribe(request)).toEqual({ ...refused, error: 'INVALID_DSH' })
    expect(prepareInstructionWrites).not.toHaveBeenCalled()
    expect(materializeWorkspace).not.toHaveBeenCalled()
    expect(prepareHarnessLaunch).not.toHaveBeenCalled()
  })
  it('projects canonical identity and compatibility without exposing a manifest', async () => {
    const installed = { ...pkg, id: 'test/current', manifest: { id: 'test/current', name: 'Draw', spec: 1, engine: 'codex',
      formerly: [request.dsh], agent: { env: { DSH_PERMISSION_MODE: ' auto ', SECRET: 'not a core fact' } } } } as NonNullable<ReturnType<typeof installedDsh>>
    const lookup = vi.fn(() => installed)
    const port = storeLaunchPort(lookup, run)
    expect(await port.dshDescribe(request)).toEqual({ ok: true, id: 'test/current', name: 'Draw', permissionMode: 'auto', refusal: null })
    expect(lookup).toHaveBeenCalledExactlyOnceWith(request.dsh)
    installed.manifest.kind = 'viewer'
    expect(await port.dshDescribe(request)).toMatchObject({ refusal: 'test/draw is a viewer package, not an agent' })
    delete installed.manifest.kind
    expect(await port.dshDescribe({ ...request, engine: 'terminal' })).toMatchObject({ refusal: expect.stringContaining('not compatible') })
  })
  it('materializes only at create, and carries account, engine and fork source into runtime preparation', async () => {
    vi.mocked(installedDsh).mockReturnValue(pkg)
    vi.mocked(materializeWorkspace).mockResolvedValue({ created: ['template/a'], kept: [], warnings: ['kept user content'], initLines: ['x'.repeat(2 * 1024 * 1024)] })
    const launch = { env: { HARNESS_PRIVATE_GRID: 'private' }, args: ['--context'] }
    vi.mocked(prepareHarnessLaunch).mockReturnValue(launch)
    const port = storeLaunchPort(undefined, run)
    expect(await port.dshMaterialize(request)).toEqual({ ok: true, created: ['template/a'], kept: [], warnings: ['kept user content'] })
    expect(materializeWorkspace).toHaveBeenCalledWith(pkg, request.workspace, request.account, request.engine)
    expect(await port.dshLaunch(request)).toEqual({ ok: true, launch })
    expect(prepareHarnessLaunch).toHaveBeenLastCalledWith(pkg, request.workspace, request.engine, request.key, request.account, null)
    expect(await port.dshLaunch({ ...request, forkOf: { agentId: 'source', dshRuntime: null } })).toEqual({ ok: true, launch })
    expect(forkRuntimeKey).toHaveBeenCalledWith({ cwd: request.workspace, agentId: 'source', dshRuntime: null })
    expect(prepareHarnessLaunch).toHaveBeenLastCalledWith(pkg, request.workspace, request.engine, request.key, request.account, 'source-runtime')
    expect(materializeWorkspace).toHaveBeenCalledOnce()
    expect(prepareInstructionWrites).toHaveBeenCalledTimes(3)
    expect(prepareInstructionWrites).toHaveBeenCalledWith(request.workspace)
    expect(vi.mocked(prepareInstructionWrites).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(materializeWorkspace).mock.invocationCallOrder[0])
  })
  it('returns package errors without bringing down the service, with both historical error forms', async () => {
    const port = storeLaunchPort(() => pkg, run)
    for (const error of [new Error('disk full'), 'unreadable']) {
      vi.mocked(materializeWorkspace).mockRejectedValueOnce(error)
      vi.mocked(prepareHarnessLaunch).mockImplementationOnce(() => { throw error })
      const detail = error instanceof Error ? error.message : error
      expect(await port.dshMaterialize(request)).toEqual({ ok: false, error: 'DSH_MATERIALIZE_FAILED', detail })
      expect(await port.dshLaunch(request)).toEqual({ ok: false, error: 'DSH_RUNTIME_FAILED', detail, thrown: String(error) })
    }
  })
  it('holds an uncertain workspace without converting it into a package error', async () => {
    const prepare: PrepareDsh = async () => { throw new Error('Previous workspace preparation is unconfirmed') }
    const port = storeLaunchPort(() => pkg, prepare)
    for (const answer of [await port.dshMaterialize(request), await port.dshLaunch(request)]) {
      expect(answer).toEqual({ ok: false, error: 'DSH_UNAVAILABLE', unavailable: 'store', holdScope: 'workspace', detail: 'Previous workspace preparation is unconfirmed' })
    }
    expect(prepareInstructionWrites).not.toHaveBeenCalled()
    expect(materializeWorkspace).not.toHaveBeenCalled()
    expect(prepareHarnessLaunch).not.toHaveBeenCalled()
  })

})
