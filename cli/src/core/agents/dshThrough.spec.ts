import { realpathSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { dshUnavailable, type DshLaunchRequest } from '../../dsh/launchWire.js'
import { STORE_OFF, type StorePort } from '../api.js'
import { captureDshWorkspace, dshThrough } from './dshThrough.js'

const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'dsh-through-')))
afterAll(() => rmSync(workspace, { recursive: true, force: true }))
const runtime = join(workspace, '.harness', 'runtime', createHash('sha256').update('agent').digest('hex'))
const request: DshLaunchRequest = { dsh: 'test/draw', workspace, engine: 'claude', key: 'agent', account: {} }
const launch = { env: { HARNESS_DSH: request.dsh, HARNESS_WORKSPACE: workspace, HARNESS_CONTEXT_FILE: join(runtime, 'CONTEXT.md'), HARNESS_SKILLS_DIR: join(runtime, 'skills') }, args: ['--context', 'context'] }
const materialized = { ok: true as const, created: ['template/a'], kept: [], warnings: [] }

describe('package preparation through the Store', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })
  it('bounds a stalled workspace read and reports a missing path without blocking another launch', async () => {
    vi.useFakeTimers()
    const stalled = captureDshWorkspace('/slow', () => new Promise(() => {}))
    expect(await captureDshWorkspace(workspace)).toBe(workspace)
    await vi.advanceTimersByTimeAsync(5000)
    expect(await stalled).toBeNull()
    expect(await captureDshWorkspace('/gone', async () => { throw Error('gone') })).toBeNull()
  })
  const setup = (store: StorePort = STORE_OFF, name: string | undefined = 'Draw') => dshThrough({
    store: () => store, nameOf: () => name, account: () => ({ privateGrid: 'private' }),
  })
  it('checks descriptions in inline mode and holds old services without a description port', async () => {
    const facts = { ok: true as const, id: request.dsh, name: 'Draw', permissionMode: null, refusal: null }
    const through = setup({ ...STORE_OFF, dshDescribe: async () => facts })
    expect(await through.describe(request.dsh, request.engine)).toEqual(facts)
    expect(await setup({ ...STORE_OFF, dshDescribe: async () => ({}) as never }).describe(request.dsh, request.engine)).toEqual(dshUnavailable('Draw'))
    expect(await setup({ ...STORE_OFF, dshDescribe: undefined } as never).describe(request.dsh, request.engine)).toEqual(dshUnavailable('Draw'))
    expect(await through.relaunch(request.dsh, join(workspace, 'gone'), request.engine, request.key)).toMatchObject({ error: 'DSH_WORKSPACE_MISSING' })
  })
  it('passes create and fork context through and never fabricates a launch', async () => {
    const store = { dshDescribe: STORE_OFF.dshDescribe, dshMaterialize: vi.fn(async () => materialized), dshLaunch: vi.fn(async () => ({ ok: true as const, launch })) }
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
    const store = { dshDescribe: STORE_OFF.dshDescribe, dshMaterialize: vi.fn(async () => missing), dshLaunch: vi.fn().mockResolvedValueOnce(missing).mockResolvedValue(failed) }
    const through = setup(store)
    expect(await through.materialize(request)).toEqual(missing)
    expect(await through.relaunch(request.dsh, request.workspace, request.engine, request.key)).toEqual(missing)
    expect(warn).toHaveBeenCalledWith('[dsh] test/draw is not installed on this machine · cannot restore its harness context')
    expect(await through.relaunch(request.dsh, request.workspace, request.engine, request.key)).toEqual({ ...failed, detail: failed.thrown })
    expect(await through.launch(request)).toEqual(failed)
  })
})
