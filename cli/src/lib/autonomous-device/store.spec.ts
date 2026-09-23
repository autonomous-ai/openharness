import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { AutonomousDeviceStore, type StoreAgent, type StorePackage } from './store.js'
import { DeviceOperationSchema } from './storeContract.js'
import { AutonomousDeviceService } from './service.js'
import { AgentCreationReceipts } from '../agentCreationReceipt.js'

const roots: string[] = []
afterEach(() => { for (const p of roots.splice(0)) rmSync(p, { recursive: true, force: true }) })
const request = (type: string, extra: Record<string, unknown> = {}) => ({ type, requestId: randomUUID(), ...extra })
function fixture(installed = true) {
  const directory = mkdtempSync(join(tmpdir(), 'device-store-')); roots.push(directory)
  const pkg: StorePackage = { packageId: 'autonomous/blender', name: 'Blender', description: 'Create editable 3D geometry', category: '3D', engine: 'claude',
    installed, catalog: true, verified: true, viewerPackageId: 'autonomous/model-viewer', installAllowed: true, version: 'one', broken: null }
  const agents: StoreAgent[] = []
  const deps = { directory, machineId: 'mac', packages: vi.fn(async () => [pkg]),
    install: vi.fn(async () => { pkg.installed = true; return { ok: true } }),
    doctor: vi.fn(async () => ({ ok: true, checked: true, lines: ['ok bpy', 'ok viewer'] })),
    workspace: vi.fn(async () => '/projects/airplane'),
    create: vi.fn(async () => {
      agents.push({ agentId: 'agent1', machineId: 'mac', packageId: pkg.packageId, workspace: '/projects/airplane', engine: 'claude', state: 'idle', runtime: 'ready' })
      return { state: 'created' as const, agentId: 'agent1' }
    }), agents: () => agents,
  }
  const store = new AutonomousDeviceStore(deps)
  const prepare = (key = 'airplane', extra: Record<string, unknown> = {}) => store.request('lamp', request('agent.prepare', {
    machineId: 'mac', packageId: pkg.packageId, idempotencyKey: key, workspace: { kind: 'new', name: 'airplane' }, ...extra,
  }))
  const settled = async (id: string) => {
    await vi.waitFor(() => expect(store.get('lamp', id).state).not.toMatch(/^(accepted|running)$/))
    return store.get('lamp', id)
  }
  const id = (r: Record<string, unknown>) => (r.operation as { operationId: string }).operationId
  return { deps, pkg, agents, store, prepare, settled, id, directory }
}
describe('device Store durable preparation', () => {
  it('discovers metadata without claiming readiness or executing doctors/setup', async () => {
    const f = fixture(false)
    const result = await f.store.request('lamp', request('store.list', { query: 'blender' }))
    expect(result.packages).toMatchObject([{ installed: false, catalog: true, readiness: { state: 'not_installed' }, capabilities: { source: 'package_metadata' } }])
    expect(f.deps.doctor).not.toHaveBeenCalled()
    expect(f.deps.install).not.toHaveBeenCalled()
    f.pkg.installed = true
    const inspected = await f.store.request('lamp', request('store.inspect', { packageId: f.pkg.packageId }))
    expect(inspected.package).toMatchObject({ readiness: { state: 'unknown', engineAuthentication: 'unknown' } })
  })
  it.each([true, false])('prepares Blender (installed=%s), separately from task delivery', async installed => {
    const f = fixture(installed)
    const result = await f.prepare()
    expect(result).toMatchObject({ status: 'accepted', operation: { state: 'accepted', taskDispatched: false } })
    const op = await f.settled(f.id(result))
    expect(DeviceOperationSchema.parse(op)).toMatchObject({ state: 'ready', agentId: 'agent1', workspace: '/projects/airplane', doctor: ['ok bpy', 'ok viewer'] })
    expect(f.deps.install).toHaveBeenCalledTimes(installed ? 0 : 1)
    expect(f.deps.create).toHaveBeenCalledWith('autonomous/blender', '/projects/airplane')
    const result2 = await f.store.request('lamp', request('store.inspect', { packageId: f.pkg.packageId }))
    expect(result2).toMatchObject({ package: { readiness: { state: 'passed' } }, candidates: [{ agentId: 'agent1', packageId: 'autonomous/blender' }] })
    f.pkg.version = 'two'
    expect((await f.store.request('lamp', request('store.inspect', { packageId: f.pkg.packageId }))).package).toMatchObject({ readiness: { state: 'unknown' } })
  })
  it('deduplicates concurrent retries and reconnects with different requestIds', async () => {
    const f = fixture(false)
    const results = await Promise.all([f.prepare(), f.prepare(), f.prepare()])
    expect(new Set(results.map(f.id)).size).toBe(1)
    await f.settled(f.id(results[0]))
    expect(f.deps.install).toHaveBeenCalledOnce(); expect(f.deps.create).toHaveBeenCalledOnce()
    expect(await f.prepare()).toMatchObject({ status: 'duplicate', operation: { state: 'ready' } })
    await expect(f.prepare('airplane', { workspace: { kind: 'new', name: 'other' } })).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })
  it('shares a package installation between distinct operations, but not their agents', async () => {
    const f = fixture(false)
    let done!: () => void
    f.deps.install.mockImplementationOnce(() => new Promise(resolve => { done = () => { f.pkg.installed = true; resolve({ ok: true }) } }))
    f.deps.workspace.mockImplementation(async () => `/projects/${randomUUID()}`)
    f.deps.create.mockImplementation(async () => ({ state: 'created', agentId: randomUUID() }))
    const a = await f.prepare('a'), b = await f.prepare('b')
    await vi.waitFor(() => expect(f.deps.install).toHaveBeenCalledOnce())
    expect(f.store.get('lamp', f.id(a)).state).toBe('running')
    done()
    await f.settled(f.id(a)); await f.settled(f.id(b))
    expect(f.deps.install).toHaveBeenCalledOnce(); expect(f.deps.create).toHaveBeenCalledTimes(2)
  })
  it('does not repeat work when caller times out during install', async () => {
    const f = fixture(false)
    let done!: () => void
    f.deps.install.mockImplementationOnce(() => new Promise(resolve => { done = () => { f.pkg.installed = true; resolve({ ok: true }) } }))
    const result = await f.prepare()
    await vi.waitFor(() => expect(f.deps.install).toHaveBeenCalledOnce())
    expect(await f.prepare()).toMatchObject({ status: 'duplicate', operation: { state: 'running' } })
    done(); expect((await f.settled(f.id(result))).state).toBe('ready')
    expect(f.deps.create).toHaveBeenCalledOnce()
  })
  it('returns doctor evidence and concrete action without creating an agent', async () => {
    const f = fixture()
    f.deps.doctor.mockResolvedValue({ ok: false, checked: true, lines: ['miss bpy: run setup in Harness Store'] })
    const op = await f.settled(f.id(await f.prepare()))
    expect(op).toMatchObject({ state: 'needs_user_action', error: { code: 'DEPENDENCY_NOT_READY' }, doctor: ['miss bpy: run setup in Harness Store'] })
    expect(f.deps.create).not.toHaveBeenCalled()
  })
  it('requires review of uninstalled community packages/dependencies', async () => {
    const f = fixture(false); f.pkg.installAllowed = false
    expect(await f.settled(f.id(await f.prepare()))).toMatchObject({ state: 'needs_user_action', error: { code: 'PACKAGE_REVIEW_REQUIRED' } })
    expect(f.deps.install).not.toHaveBeenCalled()
  })
  it('reports install errors without turning them into an agent launch', async () => {
    const f = fixture(false)
    f.deps.install.mockResolvedValue({ ok: false, error: 'SETUP_FAILED', detail: 'Permission denied installing bpy' } as never)
    expect(await f.settled(f.id(await f.prepare()))).toMatchObject({ state: 'needs_user_action', error: { code: 'SETUP_FAILED' } })
    expect(f.deps.create).not.toHaveBeenCalled()
  })
  it('preserves candidates and refuses to reuse or change a live agent workspace', async () => {
    const f = fixture()
    f.agents.push({ agentId: 'existing', machineId: 'mac', packageId: f.pkg.packageId, engine: 'claude', workspace: '/projects/airplane', state: 'running', runtime: 'ready' })
    expect(await f.settled(f.id(await f.prepare()))).toMatchObject({ error: { code: 'WORKSPACE_IN_USE' } })
    expect(f.deps.create).not.toHaveBeenCalled()
    expect(f.agents[0].agentId).toBe('existing')
  })
  it('serializes competing creation attempts for the same canonical workspace', async () => {
    const f = fixture()
    let complete!: () => void
    f.deps.create.mockImplementationOnce(() => new Promise(resolve => { complete = () => resolve({ state: 'created', agentId: 'one' }) }))
    const a = await f.prepare('a')
    await vi.waitFor(() => expect(f.deps.create).toHaveBeenCalledOnce())
    expect(await f.settled(f.id(await f.prepare('b')))).toMatchObject({ error: { code: 'WORKSPACE_IN_USE' } })
    complete(); await f.settled(f.id(a)); expect(f.deps.create).toHaveBeenCalledOnce()
  })
  it('recovers completed preparation after daemon restart using disk state', async () => {
    const f = fixture(); const id = f.id(await f.prepare()); await f.settled(id)
    const restarted = new AutonomousDeviceStore(f.deps)
    expect(restarted.get('lamp', id)).toMatchObject({ state: 'ready', agentId: 'agent1' })
    expect(await restarted.request('lamp', request('agent.prepare', { machineId: 'mac', packageId: f.pkg.packageId, idempotencyKey: 'airplane', workspace: { kind: 'new', name: 'airplane' } }))).toMatchObject({ status: 'duplicate' })
    expect(f.deps.create).toHaveBeenCalledOnce()
  })
  it('never replays install/create when a restart finds an uncertain reservation', async () => {
    const f = fixture(false)
    f.deps.install.mockImplementationOnce(() => new Promise(() => {}))
    const id = f.id(await f.prepare())
    await vi.waitFor(() => expect(f.deps.install).toHaveBeenCalledOnce())
    const restarted = new AutonomousDeviceStore(f.deps)
    expect(restarted.get('lamp', id)).toMatchObject({ state: 'needs_user_action', error: { code: 'RECOVERY_REQUIRED' } })
    expect(f.deps.install).toHaveBeenCalledOnce(); expect(f.deps.create).not.toHaveBeenCalled()
  })
  it('recovers the spawn/journal crash gap from the existing creation receipt', async () => {
    const f = fixture(); const id = f.id(await f.prepare()); await f.settled(id)
    const file = join(f.directory, `${id}.json`), row = JSON.parse(readFileSync(file, 'utf8'))
    row.operation.state = 'running'; row.operation.phase = 'create'; row.operation.agentId = null
    writeFileSync(file, JSON.stringify(row), { mode: 0o600 })
    expect(new AgentCreationReceipts(join(f.directory, 'creations')).status(id)).toMatchObject({ state: 'created' })
    expect(new AutonomousDeviceStore(f.deps).get('lamp', id)).toMatchObject({ state: 'ready', agentId: 'agent1' })
    expect(f.deps.create).toHaveBeenCalledOnce()
  })
  it('isolates operation visibility by paired identity', async () => {
    const f = fixture(), id = f.id(await f.prepare()); await f.settled(id)
    expect(() => f.store.get('other-device', id)).toThrow('No preparation')
  })
  it('halts after in-flight install on revoke, without dispatch or agent creation', async () => {
    const f = fixture(false)
    let done!: () => void
    f.deps.install.mockImplementationOnce(() => new Promise(resolve => { done = () => { f.pkg.installed = true; resolve({ ok: true }) } }))
    const id = f.id(await f.prepare()); await vi.waitFor(() => expect(f.deps.install).toHaveBeenCalledOnce())
    f.store.revoke('lamp'); done()
    expect(await f.settled(id)).toMatchObject({ error: { code: 'REVOKED' } })
    expect(f.deps.create).not.toHaveBeenCalled()
  })
  it('does not report a starting engine as ready; allows user to fix its launch', async () => {
    const f = fixture()
    const create = f.deps.create.getMockImplementation()!
    f.deps.create.mockImplementation(async () => { const result = await create(); f.agents[0].runtime = 'starting'; return result })
    const id = f.id(await f.prepare()); await vi.waitFor(() => expect(f.deps.create).toHaveBeenCalledOnce())
    await vi.waitFor(() => expect(f.store.get('lamp', id).phase).toBe('launch'))
    expect(f.store.get('lamp', id).state).toBe('running')
    f.agents[0].runtime = 'unavailable'; f.agents[0].error = 'Complete login in the agent terminal'
    expect(f.store.get('lamp', id)).toMatchObject({ state: 'needs_user_action', error: { code: 'ENGINE_ACTION_REQUIRED' } })
    f.agents[0].runtime = 'ready'
    expect(f.store.get('lamp', id).state).toBe('ready')
    expect(f.deps.create).toHaveBeenCalledOnce()
  })
  it('refuses corrupt journals instead of creating again', async () => {
    const f = fixture(), id = f.id(await f.prepare()); await f.settled(id)
    writeFileSync(join(f.directory, `${id}.json`), '{broken', { mode: 0o600 })
    expect(() => new AutonomousDeviceStore(f.deps).get('lamp', id)).toThrow('cannot be read safely')
  })
  it.each([{ prompt: 'draw plane' }, { url: 'https://evil.test' }, { engine: 'codex' }, { bypassPermission: true }, { workspace: { kind: 'existing', path: '../elsewhere' } }])('rejects extra powers/malformed workspace: %j', async extra => {
    const f = fixture()
    await expect(f.prepare('x', extra)).rejects.toMatchObject({ code: 'INVALID_REQUEST' })
    expect(f.deps.create).not.toHaveBeenCalled()
  })
  it('rejects a remote-machine target', async () => {
    const f = fixture()
    await expect(f.prepare('x', { machineId: 'other' })).rejects.toMatchObject({ code: 'MACHINE_MISMATCH' })
  })
  it('advertises Store only when wired; old clients and turn.send remain separate', async () => {
    const f = fixture()
    const submit = vi.fn()
    const options = { machineId: 'mac', agents: () => [{ agentId: 'agent1', name: 'Blender', engine: 'claude', state: 'idle' }], submit,
      cancelDelivery: () => true, stop: async () => true, answer: async () => true, recent: () => [] }
    const old = new AutonomousDeviceService(options), service = new AutonomousDeviceService({ ...options, store: f.store })
    expect(old.capabilities).not.toContain('agent.prepare'); expect(service.capabilities).toContain('agent.prepare')
    expect(await old.request('lamp', request('store.list'))).toMatchObject({ error: { code: 'UNSUPPORTED_CAPABILITY' } })
    const r = await service.request('lamp', request('agent.prepare', { machineId: 'mac', packageId: f.pkg.packageId, idempotencyKey: 'a', workspace: { kind: 'new' } }))
    await f.settled(f.id(r)); expect(submit).not.toHaveBeenCalled()
    const turn = request('turn.send', { machineId: 'mac', agentId: 'agent1', idempotencyKey: 'task-airplane', text: 'Draw an airplane' })
    await service.request('lamp', turn); await service.request('lamp', { ...turn, requestId: randomUUID() })
    expect(submit).toHaveBeenCalledOnce()
  })
})

describe('device preparation failure boundaries', () => {
  it.each(['failed', 'unconfirmed', 'throw'] as const)('retains a %s create outcome without repeating it', async state => {
    const f = fixture()
    f.deps.create.mockImplementationOnce(async () => {
      if (state === 'throw') throw new Error('response lost after spawn')
      return state === 'failed' ? { state: 'failed', error: 'TMUX_UNAVAILABLE' } as never : { state: 'unconfirmed' } as never
    })
    const id = f.id(await f.prepare())
    expect((await f.settled(id)).state).toBe('needs_user_action')
    await f.prepare(); expect(f.deps.create).toHaveBeenCalledOnce()
  })
  it('bounds accepted background work rather than exhausting processes', async () => {
    const f = fixture(false); f.deps.install.mockImplementation(() => new Promise(() => {}))
    for (let i = 0; i < 4; i++) await f.prepare(String(i))
    await expect(f.prepare('fifth')).rejects.toMatchObject({ code: 'BACKPRESSURE' })
  })
  it('does not claim doctor readiness when no checks exist', async () => {
    const f = fixture(); f.deps.doctor.mockResolvedValue({ ok: true, checked: false, lines: [] })
    await f.settled(f.id(await f.prepare()))
    expect((await f.store.request('lamp', request('store.inspect', { packageId: f.pkg.packageId }))).package).toMatchObject({ readiness: { state: 'unknown' } })
  })
  it('does not prepare an unknown package', async () => {
    const f = fixture(); f.deps.packages.mockResolvedValue([])
    expect(await f.settled(f.id(await f.prepare()))).toMatchObject({ state: 'failed', error: { code: 'PACKAGE_NOT_FOUND' } })
    expect(f.deps.install).not.toHaveBeenCalled(); expect(f.deps.create).not.toHaveBeenCalled()
  })
})

it('withdraws a ready result if the same agent is restarting', async () => {
  const f = fixture(); const id = f.id(await f.prepare()); await f.settled(id)
  f.agents[0].runtime = 'starting'
  expect(f.store.get('lamp', id)).toMatchObject({ state: 'running', phase: 'launch' })
  f.agents[0].runtime = 'ready'
  expect(f.store.get('lamp', id).state).toBe('ready')
  expect(f.deps.create).toHaveBeenCalledOnce()
})
