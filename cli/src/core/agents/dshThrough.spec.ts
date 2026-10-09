import { afterEach, describe, expect, it, vi } from 'vitest'
import { dshUnavailable, type DshLaunchRequest } from '../../dsh/launchWire.js'
import { STORE_OFF, type StorePort } from '../api.js'
import { dshThrough } from './dshThrough.js'

const request: DshLaunchRequest = { dsh: 'test/draw', workspace: '/workspace', engine: 'claude', key: 'agent', account: {} }
const launch = { env: { HARNESS_DSH: request.dsh }, args: ['--context', 'context'] }
const materialized = { ok: true as const, created: ['template/a'], kept: [], warnings: [] }

describe('package preparation through the Store', () => {
  afterEach(() => vi.restoreAllMocks())
  const setup = (store: StorePort = STORE_OFF, name: string | undefined = 'Draw') => dshThrough({
    store: () => store, nameOf: () => name, account: () => ({ privateGrid: 'private' }),
  })
  it('passes create and fork context through and never fabricates a launch', async () => {
    const store = { dshMaterialize: vi.fn(async () => materialized), dshLaunch: vi.fn(async () => ({ ok: true as const, launch })) }
    const through = setup(store)
    expect(await through.materialize(request)).toEqual(materialized)
    const fork = { ...request, forkOf: { agentId: 'source', dshRuntime: null } }
    expect(await through.launch(fork)).toEqual({ ok: true, launch })
    expect(store.dshMaterialize).toHaveBeenCalledWith(request)
    expect(store.dshLaunch).toHaveBeenCalledWith(fork)
    expect(await through.relaunch(request.dsh, request.workspace, request.engine, request.key)).toEqual({ ok: true, launch })
    expect(store.dshLaunch).toHaveBeenLastCalledWith({ ...request, account: { privateGrid: 'private' } })
  })
  it('holds missing or malformed service replies, including an unprepared installed index', async () => {
    for (const store of [STORE_OFF, { dshMaterialize: async () => null, dshLaunch: async () => ({}) } as unknown as StorePort]) {
      expect(await setup(store).materialize(request)).toEqual(dshUnavailable('Draw'))
      expect(await setup(store, undefined).launch(request)).toEqual(dshUnavailable('Draw'))
      const unnamed = dshThrough({ store: () => store, nameOf: () => undefined, account: () => ({}) })
      expect(await unnamed.relaunch(request.dsh, request.workspace, request.engine, request.key)).toEqual(dshUnavailable(request.dsh))
    }
  })
  it('preserves real refusals and the former relaunch error text', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const missing = { ok: false as const, error: 'DSH_NOT_INSTALLED', detail: 'missing' }
    const failed = { ok: false as const, error: 'DSH_RUNTIME_FAILED', detail: 'disk full', thrown: 'Error: disk full' }
    const store = { dshMaterialize: vi.fn(async () => missing), dshLaunch: vi.fn().mockResolvedValueOnce(missing).mockResolvedValue(failed) }
    const through = setup(store)
    expect(await through.materialize(request)).toEqual(missing)
    expect(await through.relaunch(request.dsh, request.workspace, request.engine, request.key)).toEqual(missing)
    expect(warn).toHaveBeenCalledWith('[dsh] test/draw is not installed on this machine · cannot restore its harness context')
    expect(await through.relaunch(request.dsh, request.workspace, request.engine, request.key)).toEqual({ ...failed, detail: failed.thrown })
    expect(await through.launch(request)).toEqual(failed)
  })
})
