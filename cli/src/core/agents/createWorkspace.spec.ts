import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildEngineLaunchArgv } from '../../lib/engineLaunch.js'
import { createAndRegisterPane } from '../../lib/createAgentPane.js'
import { RegistryCleanupUnavailable, RegistryPersistenceUnavailable } from '../../lib/registryPersistence.js'
import { AtomicWriteUnconfirmed } from '../../lib/secureState.js'
import { TmuxBackend } from '../../lib/tmuxBackend.js'
import type { RegisteredSession } from '../../lib/registry.js'
import type { TerminalCreateRequest, TerminalCreateResult } from '../../lib/terminalTypes.js'
import type { NativeLaunch } from '../../engines/nativeLaunch.js'
import { createAgentCreator, type CreateAgentDeps } from './create.js'

// Exercise the real backend's gate/command selection without creating a real terminal or child.
const execution = vi.hoisted(() => ({ commands: [] as string[], afterSend: undefined as (() => void) | undefined }))
const paths = vi.hoisted(() => ({ read: [] as string[] }))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual, realpathSync: (path: string) => { paths.read.push(path); return actual.realpathSync(path) } }
})
vi.mock('node:child_process', async original => ({
  ...await original<object>(),
  execFile: (_file: string, args: string[], _options: unknown, done: (error: null, stdout: string, stderr: string) => void) => {
    const sent = (command: string) => { execution.commands.push(command); execution.afterSend?.(); queueMicrotask(() => done(null, '%1\n', '')) }
    if (!args.includes('source-file')) sent(args.join(' '))
    return { stdin: { on: () => {}, end: sent }, kill: vi.fn() }
  },
}))
vi.mock('../../lib/tmux.js', async original => ({ ...await original<object>(), setPaneMouseOn: async () => {} }))
vi.mock('../../lib/engineLaunch.js', async original => ({
  ...await original<object>(), buildEngineCommandArgv: vi.fn(() => ['fixture-engine']),
  buildEngineLaunchArgv: vi.fn(() => ['fixture-launch']), engineLaunchEnv: () => undefined,
  refusePermissionFlagIfUnsupported: async () => null,
}))

const roots: string[] = []
function setup() {
  const root = mkdtempSync(join(tmpdir(), 'create-workspace-')); roots.push(root)
  const cwd = join(root, 'workspace'); mkdirSync(cwd)
  const rows: RegisteredSession[] = []
  const pending = { agentId: 'created', sessionId: '', engine: 'claude', cwd } as RegisteredSession
  const registry = { rows: vi.fn(() => rows.values()), openPendingAgent: vi.fn(async () => pending) }
  let release!: () => void, entered!: () => void
  const gate = new Promise<void>(resolve => { release = resolve }), waiting = new Promise<void>(resolve => { entered = resolve })
  const backend = new TmuxBackend(undefined, () => 'fixture-owner', () => {}, async () => {
    entered(); await gate
    return { paneOptions: true, sessionEnv: true, respawnEnv: true, controlNotifyGuard: true } as never
  })
  const kill = vi.spyOn(backend, 'kill').mockResolvedValue({ state: 'succeeded', dispatch: 'executed' })
  const native = { current: () => true, environment: { HOME: root }, proofs: [], prepareHooks: async () => true } as unknown as NativeLaunch
  const deps: CreateAgentDeps = {
    createBackend: backend, registry: registry as unknown as CreateAgentDeps['registry'], native: async () => ({ ok: true, launch: native }),
    externalResume: vi.fn(), watchNewPane: vi.fn(async () => {}), announceSession: vi.fn(), attach: vi.fn(),
    prepareInstructions: vi.fn(async () => {}), hookPort: 1, hooksDisabled: true,
    gridLaunchMachine: vi.fn(), buildGridLaunch: vi.fn(), terminalHintMachineName: () => 'fixture', blocksFolder: () => false,
    dshLaunch: { describe: vi.fn(), context: vi.fn(), materialize: vi.fn(), launch: vi.fn() }, syncProfileHome: vi.fn(async () => []),
  }
  const input = { engine: 'claude', cwd, bypassPermission: false, permissionMode: null, grid: null, codexHome: null,
    dsh: null, prompt: null, name: null, agent: null, requireUnusedWorkspace: true } as unknown as Parameters<ReturnType<typeof createAgentCreator>>[0]
  const occupied = (path = cwd) => rows.push({ agentId: 'occupied', sessionId: '', active: false, cwd: path } as RegisteredSession)
  return { root, cwd, rows, registry, backend, kill, native, deps, input, occupied, waiting, release,
    creator: () => createAgentCreator(deps) }
}

afterEach(() => {
  execution.commands.length = 0; execution.afterSend = undefined
  paths.read.length = 0
  vi.restoreAllMocks(); vi.clearAllMocks()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('optional unused workspace admission', () => {
  it.each(['registered alias', 'caller alias'] as const)('canonicalizes %s before preparation', async variant => {
    const t = setup(), alias = join(t.root, 'alias'); symlinkSync(t.cwd, alias)
    t.occupied(variant === 'registered alias' ? alias : t.cwd)
    if (variant === 'caller alias') t.input.cwd = alias
    t.release()
    expect(await t.creator()(t.input)).toMatchObject({ ok: false, error: 'WORKSPACE_IN_USE' })
    expect(t.deps.prepareInstructions).not.toHaveBeenCalled(); expect(execution.commands).toEqual([])
  })

  it.each(['occupied', 'replaced', 'removed'] as const)('refuses %s workspace at the real backend final dispatch gate', async variant => {
    const t = setup(), create = t.creator()(t.input)
    await t.waiting
    if (variant === 'occupied') t.occupied()
    else { renameSync(t.cwd, t.cwd + '-old'); if (variant === 'replaced') mkdirSync(t.cwd) }
    t.release()
    expect(await create).toMatchObject({ ok: false, error: variant === 'occupied' ? 'WORKSPACE_IN_USE' : 'CWD_CHANGED' })
    expect(execution.commands).toEqual([]); expect(buildEngineLaunchArgv).not.toHaveBeenCalled()
    expect(t.registry.openPendingAgent).not.toHaveBeenCalled(); expect(t.kill).not.toHaveBeenCalled()
  })

  it('preserves ordinary creates and exact empty launch capability fields', async () => {
    const t = setup(); delete (t.input as { requireUnusedWorkspace?: true }).requireUnusedWorkspace
    const create = t.creator()(t.input); await t.waiting; t.occupied(); t.release()
    expect(await create).toMatchObject({ ok: true })
    expect(t.registry.rows).not.toHaveBeenCalled()
    expect(execution.commands).toHaveLength(1)
    expect(t.registry.openPendingAgent).toHaveBeenCalledWith(expect.objectContaining({
      cwd: t.cwd, engine: 'claude', bypassPermission: false, permissionMode: null, grid: null, codexHome: null,
      dsh: null, defaultName: null, agent: null,
    }))
    expect(buildEngineLaunchArgv).toHaveBeenCalledWith('claude', expect.not.objectContaining({ firstPrompt: expect.anything() }))
  })

  it('does not relabel an already dispatched create when occupancy arrives afterward', async () => {
    const t = setup(); execution.afterSend = () => t.occupied(); t.release()
    expect(await t.creator()(t.input)).toMatchObject({ ok: true })
    expect(execution.commands).toHaveLength(1); expect(t.registry.openPendingAgent).toHaveBeenCalledOnce()
  })

  it('captures the precondition and workspace before the backend wait', async () => {
    const t = setup(), create = t.creator()(t.input)
    await t.waiting
    delete (t.input as { requireUnusedWorkspace?: true }).requireUnusedWorkspace
    t.input.cwd = t.root; t.occupied(); t.release()
    expect(await create).toMatchObject({ ok: false, error: 'WORKSPACE_IN_USE' })
    expect(execution.commands).toEqual([])
  })

  it('checks occupancy again after Store context and before materialization', async () => {
    const t = setup(); t.input.dsh = 'fixture/package'; t.release()
    t.deps.dshLaunch.describe = vi.fn<CreateAgentDeps['dshLaunch']['describe']>(async () => ({ ok: true, id: 'fixture/package', name: 'Fixture', permissionMode: null, refusal: null }))
    t.deps.dshLaunch.context = vi.fn<CreateAgentDeps['dshLaunch']['context']>(async () => { t.occupied(); return { ok: true, account: {} } })
    expect(await t.creator()(t.input)).toMatchObject({ ok: false, error: 'WORKSPACE_IN_USE' })
    expect(t.deps.dshLaunch.materialize).not.toHaveBeenCalled(); expect(execution.commands.some(command => command.includes('new-session'))).toBe(false)
    expect(buildEngineLaunchArgv).not.toHaveBeenCalled()
  })

  it('keeps two unregistered preparations independent instead of claiming a reservation', async () => {
    const t = setup(), creator = t.creator()
    const first = creator(t.input), second = creator(t.input)
    await t.waiting; t.release()
    expect(await first).toMatchObject({ ok: true }); expect(await second).toMatchObject({ ok: true })
    expect(execution.commands).toHaveLength(2)
  })

  it('keeps an uncertain backend result unconfirmed even if its workspace guard refused', async () => {
    const t = setup()
    t.deps.createBackend = { ...t.backend, create: vi.fn(async (request: TerminalCreateRequest) => {
      t.occupied()
      try { request.onDispatch?.() } catch { /* Only the backend knows whether dispatch was prevented. */ }
      return { state: 'unknown', dispatch: 'possibly_executed', reason: 'fixture uncertain' }
    }) } as unknown as CreateAgentDeps['createBackend']
    expect(await t.creator()(t.input)).toEqual({ ok: false, error: 'SPAWN_FAILED', detail: 'fixture uncertain' })
    expect(t.registry.openPendingAgent).not.toHaveBeenCalled()
  })

  it.each([1, 100, 1600, 4097])('visits all %i rows with scan-local duplicate canonicalization only', async count => {
    const t = setup(), other = join(t.root, 'other'); mkdirSync(other)
    t.rows.push({ cwd: null } as unknown as RegisteredSession)
    for (let index = 0; index < count; index++) t.rows.push({ cwd: other } as RegisteredSession)
    let visited = 0
    t.registry.rows.mockImplementation(function* () { for (const row of t.rows) { visited++; yield row } return undefined })
    t.release()
    expect(await t.creator()(t.input)).toMatchObject({ ok: true })
    expect(visited).toBe(2 * (count + 1))
    expect(paths.read.filter(path => path === other)).toHaveLength(2)
    expect(paths.read.filter(path => path === t.cwd)).toHaveLength(3)
  })

  it('checks every overflow row without retaining an unbounded path set', async () => {
    const t = setup()
    for (let index = 0; index < 1025; index++) t.rows.push({ cwd: join(t.root, `absent-${index}`) } as RegisteredSession)
    t.rows.push({ cwd: join(t.root, 'absent-1024') } as RegisteredSession)
    t.release()
    expect(await t.creator()(t.input)).toMatchObject({ ok: true })
    expect(paths.read.filter(path => path === join(t.root, 'absent-0'))).toHaveLength(2)
    expect(paths.read.filter(path => path === join(t.root, 'absent-1024'))).toHaveLength(4)
  })

  it.each(['not_started', 'rejected', 'possibly_executed'] as const)('preserves exact %s launch evidence through the registration boundary', async dispatch => {
    const backend = { create: vi.fn(async () => ({ state: dispatch === 'possibly_executed' ? 'unknown' : 'failed', dispatch,
      reason: 'workspace unavailable' }) as TerminalCreateResult), kill: vi.fn() }
    const registry = { openPendingAgent: vi.fn() }
    const result = await createAndRegisterPane({ tmuxBackend: backend, registry, engine: 'claude', sessionLabel: 'fixture', argv: [] })
    expect(result).toMatchObject({ ok: false, error: 'SPAWN_FAILED' })
    if (dispatch === 'not_started') expect(result).toHaveProperty('notStarted', true)
    else expect(result).not.toHaveProperty('notStarted')
    expect(backend.create).toHaveBeenCalledOnce(); expect(backend.kill).not.toHaveBeenCalled(); expect(registry.openPendingAgent).not.toHaveBeenCalled()
  })

  it('never grants not-started evidence after a prior native attempt and registration cleanup', async () => {
    const backend = { create: vi.fn<(_request: TerminalCreateRequest) => Promise<TerminalCreateResult>>()
      .mockResolvedValueOnce({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%1' } })
      .mockResolvedValueOnce({ state: 'failed', dispatch: 'not_started', reason: 'workspace unavailable' }),
    kill: vi.fn(async () => ({ state: 'unknown', dispatch: 'possibly_executed', reason: 'cleanup unknown' } as const)) }
    const registry = { openPendingAgent: vi.fn(async () => null) }
    const result = await createAndRegisterPane({ tmuxBackend: backend, registry, engine: 'claude', sessionLabel: 'fixture', argv: [] })
    expect(result).toMatchObject({ ok: false, error: 'SPAWN_FAILED' }); expect(result).not.toHaveProperty('notStarted')
    expect(backend.create).toHaveBeenCalledTimes(2); expect(registry.openPendingAgent).toHaveBeenCalledOnce()
    expect(backend.kill).toHaveBeenCalledExactlyOnceWith({ backend: 'tmux', paneId: '%1' })
  })

  it('keeps pending publication uncertainty with its pane and owns pre-publication cleanup', async () => {
    for (const failure of [new AtomicWriteUnconfirmed('fixture'), new RegistryCleanupUnavailable('fixture'),
      new RegistryPersistenceUnavailable('fixture'), new Error('unexpected fixture')]) {
      const backend = { create: vi.fn(async () => ({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%1' } } as const)),
        kill: vi.fn(async () => undefined as never) }
      const registry = { openPendingAgent: vi.fn(async () => { throw failure }) }
      const create = createAndRegisterPane({ tmuxBackend: backend, registry, engine: 'claude', sessionLabel: 'fixture', argv: [] })
      if (failure.constructor === RegistryPersistenceUnavailable) {
        expect(await create).toMatchObject({ ok: false, error: 'PERSISTENCE_UNCONFIRMED' })
      } else await expect(create).rejects.toBe(failure)
      expect(backend.create).toHaveBeenCalledOnce()
      if (failure instanceof AtomicWriteUnconfirmed || failure instanceof RegistryCleanupUnavailable) expect(backend.kill).not.toHaveBeenCalled()
      else expect(backend.kill).toHaveBeenCalledExactlyOnceWith({ backend: 'tmux', paneId: '%1' })
    }
  })

  it('preserves the already selected native, account and resume metadata on successful registration', async () => {
    const backend = { create: vi.fn(async () => ({ state: 'succeeded', dispatch: 'executed', runtime: { backend: 'tmux', paneId: '%1' } } as const)), kill: vi.fn() }
    const registry = { openPendingAgent: vi.fn(async () => ({ agentId: 'created' }) as RegisteredSession) }
    const metadata = { nativeToken: 'fixture-token', launchModel: { model: 'fixture-model' },
      externalResume: { engine: 'claude', sessionId: 'fixture-session' }, guest: 'fixture-guest' }
    await createAndRegisterPane({ tmuxBackend: backend, registry, engine: 'claude', sessionLabel: 'fixture', argv: [],
      paneLaunch: { cwd: '/fixture', env: { FIXTURE: 'value' } }, ...metadata } as never)
    expect(backend.create).toHaveBeenCalledWith(expect.objectContaining({ env: { FIXTURE: 'value' } }))
    expect(registry.openPendingAgent).toHaveBeenCalledWith(expect.objectContaining(metadata))
    expect(backend.kill).not.toHaveBeenCalled()
  })

  it('never invents not-started evidence for a backend failure without a reason', async () => {
    const backend = { create: vi.fn(async () => ({ state: 'unknown', dispatch: 'possibly_executed' }) as TerminalCreateResult), kill: vi.fn() }
    const result = await createAndRegisterPane({ tmuxBackend: backend, registry: { openPendingAgent: vi.fn() }, engine: 'claude', sessionLabel: 'fixture', argv: [] })
    expect(result).toEqual({ ok: false, error: 'SPAWN_FAILED', detail: undefined }); expect(backend.create).toHaveBeenCalledOnce()
  })
})
