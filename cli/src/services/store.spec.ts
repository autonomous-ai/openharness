import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { agentSettingsPath } from '../lib/agentSettings.js'
import { setAgentSettingsForTest } from '../testing/agentSettings.js'
import type { DshInstallProgress } from '../dsh/install.js'
import { fakeCore } from '../testing/fakeCore.js'
import { storeLaunchPort } from './storeLaunch.js'
import { emptyPorts, STORE_OFF } from '../core/api.js'
import { storeLaunchContext } from './storeContext.js'
import { watchSettingFile } from '../messages/settingWatch.js'
import { STORE_REQUESTS, createStorePreparation, startStore, startStoreInCore, type StoreDeps } from './store.js'
import { HACHI_ID } from '../dsh/builtinIds.js'

vi.mock('./storeLaunch.js', () => ({ storeLaunchPort: vi.fn() }))
vi.mock('./storeContext.js', () => ({ storeLaunchContext: vi.fn(async () => ({ privateGrid: 'selected' })) }))
vi.mock('../messages/settingWatch.js', () => ({ watchSettingFile: vi.fn(() => vi.fn()) }))

const ASKER = { local: true, owner: true }

function setup(over: Partial<StoreDeps> = {}, dataDir = '/data') {
  const deps: StoreDeps = {
    prepare: vi.fn(() => true),
    setupAgain: vi.fn(async () => ({ done: 0, needsSetup: 0, busy: 0 })),
    refresh: vi.fn(async () => [{ id: 'acme/thing' }] as never),
    rows: vi.fn((_installed, catalog) => (catalog ?? []).map((entry: { id: string }) => ({ id: entry.id, installed: false }))),
    remove: vi.fn(() => ({ ok: true as const })),
    mutate: vi.fn(async ({ id }: { id?: string }) => ({ ok: true as const, id: id ?? 'acme/from-url' })),
    watch: vi.fn(() => () => {}),
    ...over,
  }
  const core = fakeCore({ dataDir })
  return { core, deps, requests: startStore(core, deps) }
}

describe('the store service', () => {
  it('retries partial startup on actual use, stops after success and treats disabled Hachi as absent', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'store-ready-'))
    const prepare = vi.fn().mockReturnValueOnce(false).mockImplementationOnce(() => { throw Error('busy') }).mockReturnValue(true)
    const ready = createStorePreparation({ dataDir }, prepare)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(ready.ready()).toBe(false)
    expect(ready()).toBe(false)
    expect(ready.ready()).toBe(false)
    expect(ready(HACHI_ID)).toBe(true)
    // Disabled Hachi needs no package; that exemption does not make other bundled packages ready.
    expect(ready.ready()).toBe(false)
    expect(warn).toHaveBeenCalledWith('[store] BUNDLED_PREPARATION_FAILED · Error')
    expect(ready('autonomous/autonomous-grid')).toBe(true)
    expect(ready.ready()).toBe(true)
    expect(ready()).toBe(true)
    expect(prepare).toHaveBeenCalledTimes(3)
    setAgentSettingsForTest(dataDir, { hachi: true })
    expect(ready(HACHI_ID)).toBe(true)
    expect(prepare).toHaveBeenLastCalledWith({ hachi: true })
    warn.mockRestore()
  })
  it('prepares the release-owned harnesses before answering requests', () => {
    const { deps } = setup()
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith({ hachi: false })
  })
  it('sets up again what the move left, after it puts the built-ins in place', () => {
    const order: string[] = []
    setup({
      prepare: vi.fn(() => { order.push('prepare'); return true }),
      setupAgain: vi.fn(async () => { order.push('setupAgain'); return { done: 1, needsSetup: 0, busy: 0 } }),
    })
    expect(order).toEqual(['prepare', 'setupAgain'])
  })
  it('its requests do not wait for it', async () => {
    const { requests, deps } = setup({ setupAgain: vi.fn(() => new Promise<never>(() => {})) })
    expect(deps.setupAgain).toHaveBeenCalledOnce()
    expect(await requests.dsh_list({}, ASKER)).toEqual({ dsh: [{ id: 'acme/thing', installed: false }] })
  })
  // By its code: what was thrown names the index's path, in the person's home.
  it('says when setting them up again stops, by its code, and answers on', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const denied = Object.assign(new Error("EACCES: permission denied, open '/home/someone/.local/share/harness/dsh/installed.json'"), { code: 'EACCES' })
      const { requests } = setup({ setupAgain: vi.fn(async () => { throw denied }) })
      // The rejection is handled within the turn it happens in; setImmediate runs after it.
      await new Promise((done) => setImmediate(done))
      expect(warn).toHaveBeenCalledExactlyOnceWith('[dsh] setting harnesses up again stopped · EACCES')
      expect(await requests.dsh_list({}, ASKER)).toEqual({ dsh: [{ id: 'acme/thing', installed: false }] })
    } finally { warn.mockRestore() }
  })

  it('says a stop with no code by the kind of error', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      setup({ setupAgain: vi.fn(async () => { throw new SyntaxError("Unexpected token in JSON at /home/someone/.local/share/harness/dsh") }) })
      await new Promise((done) => setImmediate(done))
      expect(warn).toHaveBeenCalledExactlyOnceWith('[dsh] setting harnesses up again stopped · SyntaxError')
    } finally { warn.mockRestore() }
  })

  it('says a stop that is no error at all as unknown', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      setup({ setupAgain: vi.fn(() => Promise.reject(null)) })
      await new Promise((done) => setImmediate(done))
      expect(warn).toHaveBeenCalledExactlyOnceWith('[dsh] setting harnesses up again stopped · unknown')
    } finally { warn.mockRestore() }
  })
  it('puts Hachi in place when its switch turns on while it runs, and generates nothing of it while off', () => {
    const dataDir = mkdtempSync(join(tmpdir(), 'store-hachi-'))
    let changed = (): void => {}
    const watch = vi.fn((_path: string, listener: () => void) => { changed = listener; return () => {} })
    const { deps } = setup({ watch }, dataDir)
    expect(watch).toHaveBeenCalledWith(agentSettingsPath(dataDir), expect.any(Function))
    changed()
    expect(deps.prepare).toHaveBeenCalledExactlyOnceWith({ hachi: false })
    setAgentSettingsForTest(dataDir, { hachi: true })
    changed()
    expect(deps.prepare).toHaveBeenLastCalledWith({ hachi: true })
    // Another setting written while it stays on prepares nothing more.
    changed()
    expect(deps.prepare).toHaveBeenCalledTimes(2)
    // Turned off, nothing is removed or prepared; on again, it is looked at again.
    setAgentSettingsForTest(dataDir, { hachi: false })
    changed()
    expect(deps.prepare).toHaveBeenCalledTimes(2)
    setAgentSettingsForTest(dataDir, { hachi: true })
    changed()
    expect(deps.prepare).toHaveBeenCalledTimes(3)
    // Started with it on, it prepares Hachi with the rest.
    expect(setup({}, dataDir).deps.prepare).toHaveBeenCalledExactlyOnceWith({ hachi: true })
  })
  it('installs the same launch port in the explicit inline mode', () => {
    const ports = emptyPorts()
    expect(Object.keys(startStoreInCore(fakeCore(), ports)).sort()).toEqual([...STORE_REQUESTS].sort())
    expect(ports.store).toMatchObject({ dshMaterialize: expect.any(Function), dshLaunch: expect.any(Function) })
  })
  it('uses the same context transport inline and revokes it on machine change or stop', async () => {
    let machineId = 'first'
    const core = fakeCore({ daemon: { machineId: () => machineId } }), ports = emptyPorts()
    vi.mocked(storeLaunchPort).mockImplementationOnce((_lookup, _prepare, _prepared, context) => ({ ...STORE_OFF,
      dshLaunch: async () => ({ ok: false, error: 'unused', detail: '' }),
      dshContext: async () => ({ ok: true, account: await context!(false) }) }))
    startStoreInCore(core, ports, undefined, Object.assign(() => true, { ready: () => true, invalidate: () => {} }))
    expect(await ports.store!.dshContext({ dsh: 'test/draw', engine: 'claude' })).toEqual({ ok: true, account: { privateGrid: 'selected' } })
    const call = vi.mocked(storeLaunchContext).mock.calls.at(-1)!
    expect(call[0]).toEqual({ dataDir: core.dataDir, port: core.daemon.port, machineId: 'first' })
    expect(await call[5]!()).toBe(await core.account.privateGridName())
    expect(call[2]()).toBe(true)
    machineId = 'second'; expect(call[2]()).toBe(false)
    await ports.store!.dshContext({ dsh: 'test/draw', engine: 'claude' })
    const next = vi.mocked(storeLaunchContext).mock.calls.at(-1)!
    expect(next[2]()).toBe(true); ports.store!.stop()
    expect(next[2]()).toBe(false); expect(next[3].aborted).toBe(true)
  })
  it('closes the inline setting watch when Store stops', () => {
    const close = vi.fn(), ports = emptyPorts()
    vi.mocked(watchSettingFile).mockReturnValueOnce(close)
    startStoreInCore(fakeCore(), ports, undefined, Object.assign(() => true, { ready: () => true, invalidate: () => {} }))
    ports.store!.stop(); ports.store!.stop()
    expect(close).toHaveBeenCalledOnce()
  })
  it('wakes waiting workspaces on every confirmed inline outcome, including a released failure', async () => {
    const request = { dsh: 'test/package', workspace: '/unused', engine: 'claude' as const, key: 'agent', account: {} }
    const confirmed = { ok: false as const, error: 'DSH_MATERIALIZE_FAILED', detail: 'init failed' }
    const uncertain = { ...confirmed, unavailable: 'store' as const }
    const launch = { stop: vi.fn(), dshContext: vi.fn(async () => confirmed), dshDescribe: vi.fn(async () => confirmed), dshMaterialize: vi.fn(async () => confirmed), dshLaunch: vi.fn(async () => confirmed) }
    vi.mocked(storeLaunchPort).mockReturnValue(launch)
    const prepared = vi.fn()
    const ports = emptyPorts()
    for (const notify of [undefined, prepared]) {
      startStoreInCore(fakeCore(), ports, notify, Object.assign(() => true, { ready: () => true, invalidate: () => {} }))
      expect(await ports.store!.dshDescribe(request)).toEqual(confirmed)
      await ports.store!.dshMaterialize(request)
      await ports.store!.dshLaunch(request)
    }
    expect(prepared).toHaveBeenCalledTimes(3)
    launch.dshDescribe.mockResolvedValueOnce(uncertain)
    launch.dshMaterialize.mockResolvedValueOnce(uncertain)
    launch.dshLaunch.mockResolvedValueOnce(uncertain)
    await ports.store!.dshDescribe(request)
    await ports.store!.dshMaterialize(request)
    await ports.store!.dshLaunch(request)
    expect(prepared).toHaveBeenCalledTimes(4)
    launch.dshMaterialize.mockResolvedValueOnce({ ok: true, created: [], kept: [], warnings: [] } as never)
    launch.dshLaunch.mockResolvedValueOnce({ ok: true, launch: { env: {}, args: [] } } as never)
    await ports.store!.dshMaterialize(request)
    await ports.store!.dshLaunch(request)
    expect(prepared).toHaveBeenCalledTimes(6)
    startStoreInCore(fakeCore(), ports, prepared, Object.assign(() => false, { ready: () => false, invalidate: () => {} }))
    await ports.store!.dshDescribe(request)
    await ports.store!.dshMaterialize(request)
    await ports.store!.dshLaunch(request)
    expect(prepared).toHaveBeenCalledTimes(6)
  })
  it('answers exactly the requests it declares', () => {
    expect(Object.keys(setup().requests).sort()).toEqual([...STORE_REQUESTS].sort())
    // Started as the daemon starts it, with the real catalog and installs behind it.
    expect(Object.keys(startStore(fakeCore())).sort()).toEqual([...STORE_REQUESTS].sort())
  })

  it('dsh_list: the rows for the catalog it refreshed, or what went wrong reading it', async () => {
    const { requests, deps } = setup()
    expect(await requests.dsh_list({}, ASKER)).toEqual({ dsh: [{ id: 'acme/thing', installed: false }] })
    expect(deps.rows).toHaveBeenCalledWith(undefined, [{ id: 'acme/thing' }])
    vi.mocked(deps.refresh).mockRejectedValueOnce(new Error('registry unreadable'))
    expect(await requests.dsh_list({}, ASKER)).toEqual({ error: 'INTERNAL', detail: 'registry unreadable' })
    vi.mocked(deps.refresh).mockRejectedValueOnce('offline')
    expect(await requests.dsh_list({}, ASKER)).toEqual({ error: 'INTERNAL', detail: 'offline' })
  })

  it('dsh_remove: uninstalls a well-formed id and says what happened; refuses any other before removing anything', async () => {
    const { requests, deps } = setup()
    expect(await requests.dsh_remove({ id: 'acme/thing' }, ASKER)).toEqual({ ok: true, id: 'acme/thing' })
    vi.mocked(deps.remove).mockReturnValueOnce({ ok: false, error: 'NOT_INSTALLED', detail: 'acme/none is not installed' })
    expect(await requests.dsh_remove({ id: 'acme/none' }, ASKER)).toEqual({ error: 'NOT_INSTALLED', detail: 'acme/none is not installed' })
    expect(await requests.dsh_remove({ id: '../../etc' }, ASKER)).toEqual({ error: 'INVALID_DSH', detail: 'dsh_remove needs an id' })
    expect(await requests.dsh_remove({}, ASKER)).toEqual({ error: 'INVALID_DSH', detail: 'dsh_remove needs an id' })
    expect(deps.remove).toHaveBeenCalledTimes(2)
  })

  it('dsh_update: updates a well-formed id, pushing its progress under that id, and says how it ended', async () => {
    const progressed: DshInstallProgress[] = [{ id: null, phase: 'clone' } as DshInstallProgress, { id: 'acme/thing', phase: 'done' } as DshInstallProgress]
    const { requests, deps, core } = setup({
      mutate: vi.fn(async (_input, progress) => { for (const p of progressed) progress(p); return { ok: true as const, id: 'acme/thing' } }),
    })
    expect(await requests.dsh_update({ id: 'acme/thing', url: 'ignored' }, ASKER)).toEqual({ ok: true, id: 'acme/thing' })
    expect(deps.mutate).toHaveBeenCalledWith({ id: 'acme/thing', update: true }, expect.any(Function))
    expect(vi.mocked(core.clients.dshInstallStatus).mock.calls).toEqual([[{ id: 'acme/thing', phase: 'clone' }], [{ id: 'acme/thing', phase: 'done' }]])
    vi.mocked(deps.mutate).mockResolvedValueOnce({ ok: false, error: 'LINKED_INSTALL', detail: 'Update the checkout' })
    expect(await requests.dsh_update({ id: 'acme/thing' }, ASKER)).toEqual({ error: 'LINKED_INSTALL', detail: 'Update the checkout' })
    vi.mocked(deps.mutate).mockRejectedValueOnce(new Error('disk full'))
    expect(await requests.dsh_update({ id: 'acme/thing' }, ASKER)).toEqual({ error: 'INTERNAL', detail: 'disk full' })
    expect(await requests.dsh_update({ id: '../../etc' }, ASKER)).toEqual({ error: 'INVALID_DSH', detail: 'dsh_update needs an id' })
    expect(deps.mutate).toHaveBeenCalledTimes(3)
  })

  it('dsh_install: installs what a usable id or url names, pushing each phase under the id asked for', async () => {
    const { requests, deps, core } = setup({
      mutate: vi.fn(async (_input, progress) => { progress({ id: null, phase: 'clone', detail: 'cloning' } as DshInstallProgress); return { ok: true as const, id: 'acme/thing' } }),
    })
    expect(await requests.dsh_install({ id: 'acme/thing', ref: 'v2' }, ASKER)).toEqual({ ok: true, id: 'acme/thing' })
    expect(deps.mutate).toHaveBeenCalledWith({ id: 'acme/thing', url: undefined, ref: 'v2' }, expect.any(Function))
    expect(core.clients.dshInstallStatus).toHaveBeenCalledWith({ id: 'acme/thing', phase: 'clone', detail: 'cloning' })
    vi.mocked(deps.mutate).mockResolvedValueOnce({ ok: false, error: 'SETUP_FAILED', detail: 'setup exited 1' })
    expect(await requests.dsh_install({ url: 'https://example.com/thing.git' }, ASKER)).toEqual({ error: 'SETUP_FAILED', detail: 'setup exited 1' })
    vi.mocked(deps.mutate).mockRejectedValueOnce('not an Error')
    expect(await requests.dsh_install({ url: 'https://example.com/thing.git' }, ASKER)).toEqual({ error: 'INTERNAL', detail: 'not an Error' })
    expect(await requests.dsh_install({ id: '../../etc', url: 'https://example.com/\n' }, ASKER)).toEqual({ error: 'INVALID_DSH', detail: 'dsh_install needs an id or a url' })
    expect(deps.mutate).toHaveBeenCalledTimes(3)
  })
})
