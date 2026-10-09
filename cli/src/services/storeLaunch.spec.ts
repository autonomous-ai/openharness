import { afterEach, describe, expect, it, vi } from 'vitest'
import { installedDsh } from '../dsh/installed.js'
import { materializeWorkspace } from '../dsh/materialize.js'
import { forkRuntimeKey, prepareHarnessLaunch } from '../dsh/runtime.js'
import { storeLaunchPort } from './storeLaunch.js'

vi.mock('../dsh/installed.js', () => ({ installedDsh: vi.fn() }))
vi.mock('../dsh/materialize.js', () => ({ materializeWorkspace: vi.fn() }))
vi.mock('../dsh/runtime.js', () => ({ forkRuntimeKey: vi.fn(() => 'source-runtime'), prepareHarnessLaunch: vi.fn() }))
const request = { dsh: 'test/draw', workspace: '/workspace', engine: 'codex' as const, key: 'agent', account: { privateGrid: 'private' } }
const pkg = { id: request.dsh } as NonNullable<ReturnType<typeof installedDsh>>

describe('the Store owns package preparation', () => {
  afterEach(() => vi.clearAllMocks())
  it('refuses missing packages without writing anything', async () => {
    const port = storeLaunchPort(() => undefined)
    const refused = { ok: false, error: 'DSH_NOT_INSTALLED', detail: 'test/draw is not installed on this machine' }
    expect(await port.dshMaterialize(request)).toEqual(refused)
    expect(await port.dshLaunch(request)).toEqual(refused)
    expect(materializeWorkspace).not.toHaveBeenCalled()
    expect(prepareHarnessLaunch).not.toHaveBeenCalled()
  })
  it('materializes only at create, and carries account, engine and fork source into runtime preparation', async () => {
    vi.mocked(installedDsh).mockReturnValue(pkg)
    vi.mocked(materializeWorkspace).mockResolvedValue({ created: ['template/a'], kept: [], warnings: ['kept user content'], initLines: [] })
    const launch = { env: { HARNESS_PRIVATE_GRID: 'private' }, args: ['--context'] }
    vi.mocked(prepareHarnessLaunch).mockReturnValue(launch)
    const port = storeLaunchPort()
    expect(await port.dshMaterialize(request)).toEqual({ ok: true, created: ['template/a'], kept: [], warnings: ['kept user content'], initLines: [] })
    expect(materializeWorkspace).toHaveBeenCalledWith(pkg, request.workspace, request.account, request.engine)
    expect(await port.dshLaunch(request)).toEqual({ ok: true, launch })
    expect(prepareHarnessLaunch).toHaveBeenLastCalledWith(pkg, request.workspace, request.engine, request.key, request.account, null)
    expect(await port.dshLaunch({ ...request, forkOf: { agentId: 'source', dshRuntime: null } })).toEqual({ ok: true, launch })
    expect(forkRuntimeKey).toHaveBeenCalledWith({ cwd: request.workspace, agentId: 'source', dshRuntime: null })
    expect(prepareHarnessLaunch).toHaveBeenLastCalledWith(pkg, request.workspace, request.engine, request.key, request.account, 'source-runtime')
    expect(materializeWorkspace).toHaveBeenCalledOnce()
  })
  it('returns package errors without bringing down the service, with both historical error forms', async () => {
    const port = storeLaunchPort(() => pkg)
    for (const error of [new Error('disk full'), 'unreadable']) {
      vi.mocked(materializeWorkspace).mockRejectedValueOnce(error)
      vi.mocked(prepareHarnessLaunch).mockImplementationOnce(() => { throw error })
      const detail = error instanceof Error ? error.message : error
      expect(await port.dshMaterialize(request)).toEqual({ ok: false, error: 'DSH_MATERIALIZE_FAILED', detail })
      expect(await port.dshLaunch(request)).toEqual({ ok: false, error: 'DSH_RUNTIME_FAILED', detail, thrown: String(error) })
    }
  })
})
