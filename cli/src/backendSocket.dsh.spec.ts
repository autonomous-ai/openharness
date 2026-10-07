// dsh_list, dsh_install and dsh_remove through the socket a local client (the desktop app) talks to,
// answered by the store service (services/store.ts) the way the daemon runs it: the replies the client
// gets, the status it is pushed, and what it gets while the store is off.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BackendSocket } from './backendSocket.js'
import { relaySocket } from './testing/relaySocket.js'
import { bindLaunchRequests } from './testing/socketCore.js'
import { env } from './config/env.js'
import { emptyPorts } from './core/api.js'
import { createServiceHost } from './core/serviceHost.js'
import { refreshDshRegistry } from './dsh/catalog.js'
import { dshInstallDir, invalidateInstalledDsh, upsertInstalledRecord } from './dsh/installed.js'
import { resetBundledDshRegistry } from './dsh/registry.js'
import { dshListRows } from './dsh/wire.js'
import { STORE_REQUESTS, startStore, type StoreDeps } from './services/store.js'
import { fakeCore } from './testing/fakeCore.js'

describe('the DSH requests on the local socket', () => {
  let socket: BackendSocket
  let frames: Array<{ type: string; payload: Record<string, unknown> }>
  let root: string
  let savedDshDir: string
  // The store's install and remove, swapped per test; listing reads the real catalog and installs.
  let mutate: StoreDeps['mutate']
  let remove: StoreDeps['remove']
  const serveStore = (faults: ReadonlySet<string> = new Set()): void => {
    const host = createServiceHost(emptyPorts(), { log: () => {}, faults })
    const deps: StoreDeps = { prepare: () => true, refresh: refreshDshRegistry, rows: dshListRows, mutate: (input, progress) => mutate(input, progress), remove: (id) => remove(id) }
    const core = fakeCore({ clients: { dshInstallStatus: (status) => socket.send({ type: 'dsh_install_status', payload: status }) } })
    host.serve('store', (api) => startStore(api, deps), core, STORE_REQUESTS)
    socket.serviceRouter = (type, payload, asker, reply) => host.route(type, payload, asker, reply)
  }
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'dsh-socket-'))
    savedDshDir = env.DSH_DIR
    env.DSH_DIR = join(root, 'dsh')
    invalidateInstalledDsh()
    socket = relaySocket('token')
    bindLaunchRequests(socket)
    frames = []
    socket.registerLocalClient('local:store', { sendFrame: (frame) => { frames.push(frame as (typeof frames)[number]); return true }, sendBinary: () => true })
    mutate = vi.fn(async () => ({ ok: true as const, id: 'acme/thing' }))
    remove = vi.fn(() => ({ ok: true as const }))
    serveStore()
  })
  afterEach(async () => {
    await socket.unregisterLocalClient('local:store')
    await socket.stop()
    vi.unstubAllGlobals()
    resetBundledDshRegistry()
    env.DSH_DIR = savedDshDir
    invalidateInstalledDsh()
    rmSync(root, { recursive: true, force: true })
  })

  const ask = (type: string, payload: Record<string, unknown>): void => socket.handleLocalFrame('local:store', { type, payload })
  const replies = (type: string): Array<Record<string, unknown>> => frames.filter((frame) => frame.type === `${type}_result`).map((frame) => frame.payload)

  it('agent_create accepts a legacy harness on another engine and refuses a terminal', async () => {
    const dir = dshInstallDir('acme/thing')
    mkdirSync(dir, { recursive: true })
    const manifest = { spec: 1, id: 'acme/thing', name: 'Thing', engine: 'claude' }
    writeFileSync(join(dir, 'harness.json'), JSON.stringify(manifest))
    upsertInstalledRecord({ id: 'acme/thing', dir, source: dir, ref: null, commit: null, linked: true, installedAt: 1 })
    const create = vi.fn<NonNullable<BackendSocket['onCreateAgent']>>(async () => ({ ok: false, error: 'TEST_STOP' }))
    socket.onCreateAgent = create
    ask('agent_create', { requestId: 'legacy', dsh: 'acme/thing', engine: 'terminal', cwd: root })
    await vi.waitFor(() => expect(replies('agent_create')).toHaveLength(1))
    expect(replies('agent_create')[0]).toMatchObject({ error: 'INVALID_DSH' })
    expect(create).not.toHaveBeenCalled()
    ask('agent_create', { requestId: 'compatible', dsh: 'acme/thing', engine: 'codex', cwd: root })
    await vi.waitFor(() => expect(replies('agent_create')).toHaveLength(2))
    expect(create).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ engine: 'codex', dsh: 'acme/thing', cwd: root }))
    expect(replies('agent_create')[1]).toMatchObject({ error: 'TEST_STOP' })
  })

  it('dsh_list: what is installed here, then what the registry offers', async () => {
    vi.stubGlobal('__DSH_REGISTRY__', JSON.stringify([
      { id: 'acme/thing', name: 'Thing', repo: 'https://example.com/thing.git', engine: 'claude', verified: true },
      { id: 'acme/other', name: 'Other', repo: 'https://example.com/other.git', engine: 'codex', tier: 1 },
    ]))
    resetBundledDshRegistry()
    mkdirSync(dshInstallDir('acme/thing'), { recursive: true })
    writeFileSync(join(dshInstallDir('acme/thing'), 'harness.json'), JSON.stringify({ spec: 1, id: 'acme/thing', name: 'Thing here', engine: 'claude' }))
    upsertInstalledRecord({ id: 'acme/thing', dir: dshInstallDir('acme/thing'), source: 'https://example.com/thing.git', ref: null, commit: null, linked: false, installedAt: 1 })
    ask('dsh_list', { requestId: 'list-1' })
    await vi.waitFor(() => expect(replies('dsh_list')).toHaveLength(1))
    const [reply] = replies('dsh_list')
    expect(reply.requestId).toBe('list-1')
    expect((reply.dsh as Array<Record<string, unknown>>).map((row) => [row.id, row.name, row.installed, row.verified, row.tier]))
      .toEqual([['acme/thing', 'Thing here', true, true, 0], ['acme/other', 'Other', false, false, 1]])
  })

  it('dsh_remove: uninstalls through the store, and refuses a malformed id before it hears of it', async () => {
    const removed: string[] = []
    remove = (id) => { removed.push(id); return id === 'autonomous/marp' ? { ok: true } : { ok: false, error: 'NOT_INSTALLED', detail: `${id} is not installed` } }
    ask('dsh_remove', { requestId: 'rm-1', id: 'autonomous/marp' })
    ask('dsh_remove', { requestId: 'rm-2', id: 'autonomous/none' })
    ask('dsh_remove', { requestId: 'rm-3', id: '../../etc' })
    await vi.waitFor(() => expect(replies('dsh_remove')).toHaveLength(3))
    expect(replies('dsh_remove')).toEqual([
      expect.objectContaining({ requestId: 'rm-1', ok: true, id: 'autonomous/marp' }),
      expect.objectContaining({ requestId: 'rm-2', error: 'NOT_INSTALLED' }),
      expect.objectContaining({ requestId: 'rm-3', error: 'INVALID_DSH' }),
    ])
    expect(removed).toEqual(['autonomous/marp', 'autonomous/none'])
  })

  it('dsh_remove, dsh_install and dsh_update say the store is unavailable while it is off, never UNSUPPORTED', async () => {
    serveStore(new Set(['store']))
    ask('dsh_remove', { requestId: 'rm-1', id: 'acme/thing' })
    ask('dsh_install', { requestId: 'in-1', id: 'acme/thing' })
    ask('dsh_update', { requestId: 'up-1', id: 'acme/thing' })
    await vi.waitFor(() => expect(replies('dsh_update')).toHaveLength(1))
    const off = { error: 'SERVICE_UNAVAILABLE', service: 'store', retryable: false }
    expect(replies('dsh_remove')).toEqual([{ requestId: 'rm-1', ...off }])
    expect(replies('dsh_install')).toEqual([{ requestId: 'in-1', ...off }])
    expect(replies('dsh_update')).toEqual([{ requestId: 'up-1', ...off }])
    expect(mutate).not.toHaveBeenCalled()
  })

  it('dsh_update validates identity, streams progress, and returns update failures', async () => {
    const update = vi.fn<StoreDeps['mutate']>(async ({ id }, progress) => {
      progress({ id: null, phase: 'clone' })
      progress({ id: id ?? null, phase: 'done' })
      return { ok: true, id: id ?? '' }
    })
    mutate = update
    ask('dsh_update', { requestId: 'invalid', id: '../../etc' })
    ask('dsh_update', { requestId: 'update', id: 'acme/thing', url: 'ignored', ref: 'ignored' })
    await vi.waitFor(() => expect(replies('dsh_update')).toHaveLength(2))
    expect(update).toHaveBeenCalledExactlyOnceWith({ id: 'acme/thing', update: true }, expect.any(Function))
    expect(replies('dsh_update')).toEqual([
      expect.objectContaining({ requestId: 'invalid', error: 'INVALID_DSH' }),
      expect.objectContaining({ requestId: 'update', ok: true, id: 'acme/thing' }),
    ])
    expect(frames.filter(frame => frame.type === 'dsh_install_status').map(frame => frame.payload))
      .toEqual([{ id: 'acme/thing', phase: 'clone' }, { id: 'acme/thing', phase: 'done' }])
    update.mockResolvedValueOnce({ ok: false, error: 'LINKED_INSTALL', detail: 'Update the checkout' })
    ask('dsh_update', { requestId: 'linked', id: 'acme/thing' })
    await vi.waitFor(() => expect(replies('dsh_update')).toHaveLength(3))
    expect(replies('dsh_update')[2]).toMatchObject({ error: 'LINKED_INSTALL', detail: 'Update the checkout' })
    for (const error of [new Error('disk full'), 'closed']) {
      update.mockRejectedValueOnce(error)
      ask('dsh_update', { requestId: 'throws', id: 'acme/thing' })
      await vi.waitFor(() => expect(replies('dsh_update').at(-1)).toMatchObject({ error: 'INTERNAL', detail: String(error instanceof Error ? error.message : error) }))
    }
  })

  it('dsh_install: refuses a request with no usable id or url, before the daemon hears of it', async () => {
    const asked: unknown[] = []
    mutate = async (input) => { asked.push(input); return { ok: true, id: 'acme/thing' } }
    ask('dsh_install', { requestId: 'in-1', id: '../../etc', url: 'https://example.com/\n' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(1))
    expect(replies('dsh_install')[0]).toMatchObject({ requestId: 'in-1', error: 'INVALID_DSH', detail: 'dsh_install needs an id or a url' })
    expect(asked).toEqual([])
  })

  it('dsh_install: pushes each phase under the id asked for, then replies with what was installed', async () => {
    const asked: unknown[] = []
    mutate = async (input, progress) => {
      asked.push(input)
      progress({ id: null, phase: 'clone', detail: 'cloning' })
      progress({ id: 'acme/thing', phase: 'doctor' })
      return { ok: true, id: 'acme/thing' }
    }
    ask('dsh_install', { requestId: 'in-2', id: 'acme/thing', ref: 'store-e2e' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(1))
    expect(asked).toEqual([{ id: 'acme/thing', url: undefined, ref: 'store-e2e' }])
    expect(frames.filter((frame) => frame.type === 'dsh_install_status').map((frame) => frame.payload)).toEqual([
      { id: 'acme/thing', phase: 'clone', detail: 'cloning' },
      { id: 'acme/thing', phase: 'doctor' },
    ])
    expect(replies('dsh_install')[0]).toMatchObject({ requestId: 'in-2', ok: true, id: 'acme/thing' })
  })

  it('dsh_install: a failed install is its error and detail; one that throws is INTERNAL with what was thrown', async () => {
    mutate = async () => ({ ok: false, error: 'SETUP_FAILED', detail: 'setup exited 1' })
    ask('dsh_install', { requestId: 'in-3', url: 'https://example.com/thing.git' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(1))
    mutate = async () => { throw new Error('disk full') }
    ask('dsh_install', { requestId: 'in-4', url: 'https://example.com/thing.git' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(2))
    mutate = () => Promise.reject('not an Error')
    ask('dsh_install', { requestId: 'in-5', url: 'https://example.com/thing.git' })
    await vi.waitFor(() => expect(replies('dsh_install')).toHaveLength(3))
    expect(replies('dsh_install')).toEqual([
      expect.objectContaining({ requestId: 'in-3', error: 'SETUP_FAILED', detail: 'setup exited 1' }),
      expect.objectContaining({ requestId: 'in-4', error: 'INTERNAL', detail: 'disk full' }),
      expect.objectContaining({ requestId: 'in-5', error: 'INTERNAL', detail: 'not an Error' }),
    ])
  })
})
