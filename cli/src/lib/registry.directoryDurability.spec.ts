/** Real renamed images remain unadmitted while their directory flush is outstanding. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RegisteredSession, registry as Registry } from './registry.js'
import { createAndRegisterPane } from './createAgentPane.js'

const io = vi.hoisted(() => ({
  file: '', renamed: false, publications: 0, syncs: 0, fail: 0,
  wait: undefined as undefined | (() => Promise<void>), preparing: undefined as undefined | (() => Promise<void>),
}))
vi.mock('node:fs', async original => {
  const actual = await original<typeof import('node:fs')>()
  return { ...actual,
    renameSync: (...args: Parameters<typeof actual.renameSync>) => {
      actual.renameSync(...args)
      if (String(args[1]) === io.file) { io.renamed = true; io.publications++ }
    },
    fsync: (fd: number, callback: (error: NodeJS.ErrnoException | null) => void) => {
      const selected = io.renamed && actual.fstatSync(fd).isDirectory()
      if (selected) { io.renamed = false; io.syncs++ }
      actual.fsync(fd, error => {
        if (!selected) { callback(error); return }
        const wait = io.wait; io.wait = undefined
        void (wait?.() ?? Promise.resolve()).then(() => {
          if (io.fail > 0) { io.fail--; callback(Object.assign(new Error('fixture directory sync failed'), { code: 'EIO' })) }
          else callback(error)
        }, error => callback(error))
      })
    },
  }
})
vi.mock('node:fs/promises', async original => {
  const actual = await original<typeof import('node:fs/promises')>()
  return { ...actual, open: async (...args: Parameters<typeof actual.open>) => {
    const handle = await actual.open(...args), sync = handle.sync.bind(handle)
    handle.sync = async () => {
      await sync()
      if (String(args[0]).includes('registry.json.') && String(args[0]).endsWith('.tmp')) await io.preparing?.()
    }
    return handle
  } }
})
vi.mock('./bootId.js', async original => ({ ...await original<object>(), currentBootId: () => 'fixture-boot', bootChanged: () => false }))

const A = 'directory-owner', B = 'directory-peer'
const oldProcess = { pid: 6101, executable: '/fixture/claude', startMarker: 'old' }
const newProcess = { pid: 6103, executable: '/fixture/claude', startMarker: 'new' }
const plan = { id: '12345678-1234-1234-1234-123456789012', identity: 'fixture-owner',
  requestedAt: 1790900000000, state: 'waiting' as const }
let root: string, registry: typeof Registry
let release: (() => void) | undefined
const accepted: Promise<unknown>[] = []
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done }); return { promise, resolve } }
const rows = (): RegisteredSession[] => JSON.parse(readFileSync(join(root, 'data', 'registry.json'), 'utf8'))
const written = (id = A) => rows().find(row => row.agentId === id)
function track<T>(pending: Promise<T>): Promise<T> { accepted.push(pending); void pending.catch(() => {}); return pending }
function hold(name = 'registry.json') {
  io.file = join(root, 'data', name); io.renamed = false; io.publications = 0; io.syncs = 0
  const entered = deferred(), waiting = deferred()
  release = waiting.resolve
  io.wait = async () => { entered.resolve(); await waiting.promise }
  return {
    release: waiting.resolve,
    async entered(pending: Promise<unknown>) {
      // The synchronous baseline completes first, producing an immediate behavioral RED.
      const at = await Promise.race([entered.promise.then(() => 'directory'), pending.then(() => 'settled', () => 'settled')])
      expect(at, 'the request must wait for its asynchronous directory flush').toBe('directory')
    },
  }
}

beforeEach(async () => {
  vi.resetModules()
  io.file = ''; io.renamed = false; io.publications = 0; io.syncs = 0; io.fail = 0; io.wait = undefined; io.preparing = undefined
  accepted.length = 0; release = undefined
  root = mkdtempSync(join(tmpdir(), 'registry-directory-durability-'))
  for (const name of ['home', 'data', 'runtime', 'codex']) mkdirSync(join(root, name), { mode: 0o700 })
  for (const [key, value] of Object.entries({ HOME: join(root, 'home'), USERPROFILE: join(root, 'home'),
    ADAPTER_DATA_DIR: join(root, 'data'), ADAPTER_RUNTIME_DIR: join(root, 'runtime'), CODEX_HOME: join(root, 'codex'),
    CLAUDE_CONFIG_DIR: join(root, 'home', '.claude'), CLAUDE_PROJECTS_DIR: join(root, 'home', '.claude', 'projects'),
  })) vi.stubEnv(key, value)
  writeFileSync(join(root, 'data', 'engine-homes.json'), '{}', { mode: 0o600 })
  registry = (await import('./registry.js')).registry
  await registry.load()
  for (const [index, agentId] of [A, B].entries()) {
    expect(await registry.openProcessAgent({ agentId, engine: 'claude', tmuxPane: `%${index + 1}`,
      processIdentity: index ? { ...oldProcess, pid: 6102 } : oldProcess, cwd: root })).not.toBeNull()
  }
  await registry.flush()
})
afterEach(async () => {
  io.wait = undefined; io.preparing = undefined; io.fail = 0; release?.(); vi.useRealTimers()
  let settled = false
  try {
    await Promise.allSettled(accepted)
    // finish() rejects only after its owned writer/cleanup has settled.
    await registry.flush({ exiting: true }).catch(() => {})
    settled = true
  } finally {
    vi.restoreAllMocks(); vi.unstubAllEnvs()
    if (settled) rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === 'win32')('keeps the old live owner and the single writer while a renamed image awaits durability', async () => {
  const old = registry.byAgent(A)!, held = hold()
  const first = track(registry.setClosePlan(A, plan))
  await held.entered(first)
  expect(written()?.closePlan).toEqual(plan)
  expect(registry.byAgent(A)).toBe(old)
  expect(old.closePlan).toBeUndefined()
  expect(existsSync(join(root, 'data', 'registry.json.lock'))).toBe(true)
  const heartbeat = vi.fn()
  await new Promise<void>(done => setImmediate(() => { heartbeat(); done() }))
  expect(heartbeat).toHaveBeenCalledOnce()
  const second = track(registry.setClosePlan(B, plan))
  expect(io.publications).toBe(1)
  held.release()
  await Promise.all([first, second])
  expect(written(B)?.closePlan).toEqual(plan)
  expect(io.publications).toBe(2)
})

it.skipIf(process.platform === 'win32')('reports an expired renamed launch as non-retryable uncertainty and never admits its late success', async () => {
  const held = hold(), old = registry.byAgent(A)!, entered = vi.fn()
  registry.onEnter = entered
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = track(registry.confirmLaunch(A, { processIdentity: newProcess })).catch(error => error)
  await held.entered(first)
  await vi.advanceTimersByTimeAsync(5_000)
  expect(await first).toMatchObject({ retryable: false })
  expect((await first).constructor.name).toBe('AtomicWriteUnconfirmed')
  expect(io.publications).toBe(1)
  expect(entered).not.toHaveBeenCalled()
  expect(registry.byAgent(A)).toBe(old)
  expect(old.processIdentity).toEqual(oldProcess)
  held.release(); vi.useRealTimers()
  // A later explicit write repairs the unadmitted image; it cannot revive this launch.
  await registry.setClosePlan(B, plan)
  expect(registry.byAgent(A)?.processIdentity).toEqual(oldProcess)
  expect(written()?.processIdentity).toEqual(oldProcess)
  expect(written(B)?.closePlan).toEqual(plan)
})

it.skipIf(process.platform === 'win32').each(['cancel', 'owner', 'route', 'revision'] as const)(
  'rechecks %s after directory durability and never retries the revoked launch', async change => {
    let current = true
    const held = hold(), live = registry.byAgent(A)!, original = structuredClone(live)
    const first = track(registry.confirmLaunch(A, { processIdentity: newProcess }, { current: () => current })).catch(error => error)
    await held.entered(first)
    if (change === 'cancel') current = false
    if (change === 'owner') live.processIdentity = { ...oldProcess, startMarker: 'replacement' }
    if (change === 'route') live.runtimes = [{ backend: 'tmux', paneId: '%9' }]
    if (change === 'revision') live.evidenceRevision = (live.evidenceRevision ?? 0) + 1
    held.release()
    expect(await first).toMatchObject({ retryable: false })
    expect((await first).constructor.name).toBe('AtomicWriteUnconfirmed')
    current = true
    expect(io.publications).toBe(1)
    expect(registry.byAgent(A)?.processIdentity).not.toEqual(newProcess)
    Object.assign(live, original)
  },
)

it.skipIf(process.platform === 'win32')('rebases newer observations, nested edits and deletions after the directory wait', async () => {
  const live = registry.byAgent(A)!
  live.launchArgs = ['before']; live.bypassPermission = true
  await registry.flush()
  const held = hold(), first = track(registry.setClosePlan(A, plan))
  await held.entered(first)
  live.title = 'new observation'; live.cwd = join(root, 'new-project'); live.launchArgs.push('after')
  delete live.bypassPermission
  held.release(); await first; await registry.flush()
  expect(registry.byAgent(A)).toBe(live)
  expect(written()).toMatchObject({ title: 'new observation', cwd: live.cwd, launchArgs: ['before', 'after'], closePlan: plan })
  expect(written()).not.toHaveProperty('bypassPermission')
})

it.skipIf(process.platform === 'win32')('propagates uncertain pending Create without killing its pane or spawning a retry', async () => {
  const held = hold(), create = vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const,
    runtime: { backend: 'tmux' as const, paneId: '%7' } })), kill = vi.fn()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = track(createAndRegisterPane({ registry, tmuxBackend: { create, kill }, engine: 'claude',
    agentId: 'new-pending', cwd: root, sessionLabel: 'fixture', argv: ['fixture-engine'] })).catch(error => error)
  await held.entered(first)
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await first).constructor.name).toBe('AtomicWriteUnconfirmed')
  expect(await first).toMatchObject({ retryable: false })
  expect(create).toHaveBeenCalledOnce(); expect(kill).not.toHaveBeenCalled()
  held.release(); vi.useRealTimers()
  await registry.flush()
  expect(registry.byAgent('new-pending')).toBeUndefined()
  expect(create).toHaveBeenCalledOnce(); expect(kill).not.toHaveBeenCalled()
})

it.skipIf(process.platform === 'win32')('propagates uncertain pending Resume instead of returning a proven refusal', async () => {
  const saved = { ...structuredClone(registry.byAgent(A)!), agentId: 'resume-pending' }
  const held = hold()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = track(registry.resumePendingAgent(saved, [{ backend: 'tmux', paneId: '%8' }])).catch(error => error)
  await held.entered(first)
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await first).constructor.name).toBe('AtomicWriteUnconfirmed')
  expect(await first).toMatchObject({ retryable: false })
  held.release(); vi.useRealTimers(); await registry.flush()
  expect(registry.byAgent(saved.agentId)).toBeUndefined()
})

it.skipIf(process.platform === 'win32')('rechecks native transcript evidence after its binding image was renamed', async () => {
  const id = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa', home = join(root, 'codex')
  mkdirSync(join(home, 'sessions'))
  const transcript = join(home, 'sessions', `rollout-${id}.jsonl`)
  const header = (session: string) => JSON.stringify({ type: 'session_meta', payload: { id: session, cwd: root, source: 'cli' } }) + '\n'
  writeFileSync(transcript, header(id))
  const pending = await registry.openPendingAgent({ engine: 'codex', runtimes: [{ backend: 'tmux', paneId: '%7' }], cwd: root })
  const before = registry.byAgent(pending!.agentId)!
  const held = hold(), first = track(registry.register({ engine: 'codex', sessionId: id, transcriptPath: transcript,
    tmuxPane: '%7', cwd: root, processIdentity: { pid: 6107, executable: '/fixture/codex', startMarker: 'native' } })).catch(error => error)
  await held.entered(first)
  writeFileSync(transcript, header('bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb'))
  held.release()
  expect((await first).constructor.name).toBe('AtomicWriteUnconfirmed')
  expect(await first).toMatchObject({ retryable: false })
  expect(registry.byAgent(pending!.agentId)).toBe(before)
  expect(before.sessionId).toBe('')
})

it.skipIf(process.platform === 'win32')('rejects a replacement data directory without assigning durability to its new inode', async () => {
  const held = hold(), first = track(registry.setClosePlan(A, plan)).catch(error => error)
  await held.entered(first)
  const directory = join(root, 'data'), previous = join(root, 'previous-data')
  renameSync(directory, previous); mkdirSync(directory, { mode: 0o700 })
  held.release()
  try {
    expect((await first).constructor.name).toBe('AtomicWriteUnconfirmed')
    expect(await first).toMatchObject({ retryable: false })
    expect(registry.byAgent(A)?.closePlan).toBeUndefined()
  } finally {
    rmSync(directory, { recursive: true }); renameSync(previous, directory)
  }
})

it.skipIf(process.platform === 'win32')('keeps an expired name publication uncertain and does not publish a success in memory', async () => {
  const held = hold('agent-names.json'), original = registry.displayName(registry.byAgent(A)!)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = track(registry.rename(A, 'New name')).catch(error => error)
  await held.entered(first)
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await first).constructor.name).toBe('AtomicWriteUnconfirmed')
  expect(await first).toMatchObject({ retryable: false })
  held.release(); vi.useRealTimers(); await registry.flush()
  expect(registry.displayName(registry.byAgent(A)!)).toBe(original)
})

it.skipIf(process.platform === 'win32')('keeps exiting flush pending until the expired directory request actually settles', async () => {
  const held = hold()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const first = track(registry.setClosePlan(A, plan)).catch(error => error)
  await held.entered(first)
  let exited = false
  const finish = track(registry.flush({ exiting: true }).finally(() => { exited = true })).catch(error => error)
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await first).constructor.name).toBe('AtomicWriteUnconfirmed')
  expect(exited).toBe(false)
  expect(existsSync(join(root, 'data', 'registry.json.lock'))).toBe(true)
  held.release(); vi.useRealTimers(); await finish
  expect(exited).toBe(true)
  expect(existsSync(join(root, 'data', 'registry.json.lock'))).toBe(false)
})

it.skipIf(process.platform === 'win32')('never retries an I/O failure into a replacement directory containing the same renamed image', async () => {
  const held = hold(), first = track(registry.confirmLaunch(A, { processIdentity: newProcess })).catch(error => error)
  await held.entered(first)
  const directory = join(root, 'data'), previous = join(root, 'previous-data')
  const candidate = readFileSync(join(directory, 'registry.json'), 'utf8')
  renameSync(directory, previous); mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, 'registry.json'), candidate, { mode: 0o600 })
  io.fail = 1
  held.release()
  try {
    expect((await first).constructor.name).toBe('AtomicWriteUnconfirmed')
    expect(await first).toMatchObject({ retryable: false })
    expect(registry.byAgent(A)?.processIdentity).toEqual(oldProcess)
    expect(io.publications).toBe(1)
  } finally {
    rmSync(directory, { recursive: true }); renameSync(previous, directory)
  }
})

it.skipIf(process.platform === 'win32')('the actual bind caller never submits a first task after its removal expires during directory durability', async () => {
  const { createBinding } = await import('../core/agents/bind.js')
  const runtimes = [{ backend: 'tmux' as const, paneId: '%3' }], task = 'Fixture task'
  const opened = (await registry.openPendingAgent({ engine: 'openclaw', cwd: root, runtimes, firstTask: task }))!
  await registry.confirmLaunch(opened.agentId, { processIdentity: newProcess })
  await registry.register({ engine: 'openclaw', sessionId: 'agent:main:plain', runtimes, cwd: root, processIdentity: newProcess })
  const screen = readFileSync(new URL('../engines/openclaw/__fixtures__/screen-plain.txt', import.meta.url), 'utf8')
  const submit = vi.fn(), called = deferred(), take = registry.takeFirstTask.bind(registry)
  let removal!: Promise<string | null>
  vi.spyOn(registry, 'takeFirstTask').mockImplementation(id => {
    removal = track(take(id)); called.resolve(); return removal
  })
  const binding = createBinding({ registry, mirror: { inheritSummary: vi.fn() }, forgetSession: vi.fn(),
    clients: { send: vi.fn() }, attachSession: vi.fn(async () => true), captureReader: () => () => true,
    announceSession: vi.fn(), stoppedAgents: { save: vi.fn(), finishResume: vi.fn(), get: vi.fn(() => null) },
    syncRecapPool: vi.fn(), input: { forget: vi.fn(), awaitingConfirmation: () => false }, submitAgent: submit,
    homes: { copilot: root, grok: root, agy: root },
    capturePane: async () => screen, openclawPaneRead: () => true, openclawPaneDue: () => true,
    openclawStateDir: async () => null, followsLive: () => false,
  })
  const observed = { engine: 'openclaw' as const, processIdentity: newProcess, runtimes, cwd: root, primaryRuntimeKey: 'tmux:%3', args: '', resumeSessionId: null }
  const held = hold()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  await binding.bindObservedAgent(observed)
  await called.promise; await held.entered(removal)
  expect(submit).not.toHaveBeenCalled()
  expect(registry.byAgent(opened.agentId)?.firstTask).toBe(task)
  await vi.advanceTimersByTimeAsync(5_000)
  await expect(removal).rejects.toMatchObject({ retryable: false })
  expect(submit).not.toHaveBeenCalled()
  held.release(); vi.useRealTimers()
  await registry.flush()
  expect(submit).not.toHaveBeenCalled()
  expect(registry.byAgent(opened.agentId)?.firstTask).toBe(task)
  await binding.bindObservedAgent(observed)
  await removal
  await new Promise<void>(done => setImmediate(done))
  expect(submit).toHaveBeenCalledExactlyOnceWith(opened.agentId, task)
  await binding.bindObservedAgent(observed)
  expect(submit).toHaveBeenCalledOnce()
})

it.skipIf(process.platform === 'win32')('resets the completed names stage before a following registry preparation expires', async () => {
  const names = hold('agent-names.json'), failedName = track(registry.rename(A, 'Kept name')).catch(error => error)
  await names.entered(failedName); io.fail = 1; names.release()
  expect((await failedName).constructor.name).toBe('AtomicWriteUnconfirmed')
  const preparing = deferred(), held = deferred()
  release = held.resolve
  io.preparing = async () => { io.preparing = undefined; preparing.resolve(); await held.promise }
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = track(registry.setClosePlan(B, plan)).catch(error => error)
  expect(await Promise.race([preparing.promise.then(() => 'preparing'), pending.then(() => 'settled')])).toBe('preparing')
  await vi.advanceTimersByTimeAsync(5_000)
  expect((await pending).constructor.name).toBe('RegistryPersistenceUnavailable')
  held.resolve(); vi.useRealTimers()
  await registry.flush()
  expect(written(B)?.closePlan).toBeUndefined()
})

it.skipIf(process.platform === 'win32').each(['removed', 'replaced'] as const)(
  'never retries a directory I/O failure after the original registry lock is %s', async change => {
  const held = hold(), pending = track(registry.confirmLaunch(A, { processIdentity: newProcess })).catch(error => error)
  await held.entered(pending)
  const lock = join(root, 'data', 'registry.json.lock'), previous = join(root, 'previous-lock')
  if (change === 'removed') rmSync(lock, { recursive: true })
  else {
    renameSync(lock, previous); mkdirSync(lock, { mode: 0o700 })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 2147483647, token: 'replacement-lock', startMarker: '', generationMarker: '' }), { mode: 0o600 })
  }
  io.fail = 1; held.release()
  try {
    expect((await pending).constructor.name).toBe('AtomicWriteUnconfirmed')
    expect(await pending).toMatchObject({ retryable: false })
    expect(registry.byAgent(A)?.processIdentity).toEqual(oldProcess)
    expect(io.publications).toBe(1)
    if (change === 'replaced') expect(JSON.parse(readFileSync(join(lock, 'owner.json'), 'utf8')).token).toBe('replacement-lock')
  } finally {
    if (change === 'replaced') { rmSync(lock, { recursive: true, force: true }); rmSync(previous, { recursive: true, force: true }) }
  }
})

it.skipIf(process.platform === 'win32')('latches a revoked name owner even when directory durability also fails', async () => {
  let current = true
  const held = hold('agent-names.json'), pending = track(registry.rename(A, 'Unconfirmed name', { current: () => current })).catch(error => error)
  await held.entered(pending)
  current = false; io.fail = 1; held.release()
  expect((await pending).constructor.name).toBe('AtomicWriteUnconfirmed')
  expect(await pending).toMatchObject({ retryable: false })
  expect(registry.displayName(registry.byAgent(A)!)).not.toBe('Unconfirmed name')
})

it.skipIf(process.platform === 'win32').each(['deadline', 'token'] as const)(
  'the actual external cancel keeps its pane when %s revokes a renamed cancellation', async cause => {
  const { createExternalResumes } = await import('../core/agents/externalResume.js')
  const row = (await registry.openPendingAgent({ engine: 'claude', cwd: root,
    runtimes: [{ backend: 'tmux', paneId: '%3' }], externalResume: {
      token: '12345678-1234-1234-1234-123456789012', request: { engine: 'claude', sessionId: 'external-fixture' },
      takeOver: null, phase: 'waiting',
    } }))!
  const kill = vi.fn(async () => ({ state: 'succeeded' as const, dispatch: 'executed' as const })), forget = vi.fn(async () => {}), launch = vi.fn()
  const controller = createExternalResumes({ registry, backend: null, backendFor: () => ({ killHeld: kill }),
    stopped: () => [], cancelled: () => false, generation: () => 1, waiting: async () => true,
    preflight: async () => null, announce: vi.fn(), forget, launch,
    inspect: async () => { throw new Error('Cancellation must not inspect or launch an engine') },
  })
  const held = hold()
  if (cause === 'deadline') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  const pending = track(controller.cancel(row)).catch(error => error)
  await held.entered(pending)
  expect(written(row.agentId)?.externalResume?.phase).toBe('cancelled')
  expect(kill).not.toHaveBeenCalled()
  if (cause === 'deadline') await vi.advanceTimersByTimeAsync(5_000)
  else registry.byAgent(row.agentId)!.externalResume!.token = 'aaaaaaaa-1234-1234-1234-123456789012'
  held.release(); vi.useRealTimers()
  try {
    expect((await pending).constructor.name).toBe('AtomicWriteUnconfirmed')
    expect(await pending).toMatchObject({ retryable: false })
    await registry.flush()
    expect(kill).not.toHaveBeenCalled()
    expect(forget).not.toHaveBeenCalled()
    expect(launch).not.toHaveBeenCalled()
    expect(registry.byAgent(row.agentId)).toBeDefined()
  } finally { controller.stop() }
})
