import { afterEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../dsh/installed.js'
import { materializeWorkspace } from '../dsh/materialize.js'
import { forkRuntimeKey, prepareHarnessLaunch } from '../dsh/runtime.js'
import type { PrepareDsh } from '../dsh/preparation.js'
import { prepareInstructionWrites } from '../scm/scmProjects.js'
import { storeLaunchPort } from './storeLaunch.js'

vi.mock('../scm/scmProjects.js', () => ({ prepareInstructionWrites: vi.fn(async () => {}) }))
vi.mock('../dsh/installed.js', () => ({ installedDsh: vi.fn(), dshRootDir: () => '/unused' }))
vi.mock('../dsh/materialize.js', () => ({ materializeWorkspace: vi.fn() }))
vi.mock('../dsh/runtime.js', () => ({ forkRuntimeKey: vi.fn(() => 'source-runtime'), prepareHarnessLaunch: vi.fn() }))
const run: PrepareDsh = async (_workspace, _input, action) => action()
const request = { dsh: 'test/draw', workspace: '/workspace', engine: 'codex' as const, key: 'agent', account: { privateGrid: 'private' } }
const pkg = { id: request.dsh } as NonNullable<ReturnType<typeof installedDsh>>

describe('the Store owns package preparation', () => {
  afterEach(() => vi.clearAllMocks())
  it('refuses missing packages without writing anything', async () => {
    const port = storeLaunchPort(() => undefined, run)
    const refused = { ok: false, error: 'DSH_NOT_INSTALLED', detail: 'test/draw is not installed on this machine' }
    expect(await port.dshMaterialize(request)).toEqual(refused)
    expect(await port.dshLaunch(request)).toEqual(refused)
    expect(prepareInstructionWrites).not.toHaveBeenCalled()
    expect(materializeWorkspace).not.toHaveBeenCalled()
    expect(prepareHarnessLaunch).not.toHaveBeenCalled()
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
