import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import { engineNow, loadEngine } from '../../engines/inProcess.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createCursorTaskHooks, loadPendingCursorTasks, removePendingCursorTasks, type CursorTaskDeps } from './cursorTasks.js'

const made = vi.hoisted(() => ({ managers: [] as unknown[], queues: [] as unknown[] }))
vi.mock('../../engines/cursor/home.js', () => ({ cursorConfigDir: () => '/cursor/config', cursorDataDir: () => '/cursor/data' }))
vi.mock('../../engines/cursor/subagent.js', () => ({
  CursorSubagentManager: class {
    readonly args: unknown[]
    register = vi.fn()
    closeParent = vi.fn()
    forget = vi.fn()
    stop = vi.fn()
    constructor(...args: unknown[]) { this.args = args; made.managers.push(this) }
  },
}))
vi.mock('../../engines/cursor/taskHookQueue.js', () => ({
  CursorTaskHookQueue: class {
    enqueue = vi.fn()
    wait = vi.fn(async () => {})
    constructor(readonly options: Record<string, (...args: never[]) => unknown>) { made.queues.push(this) }
  },
}))
// Cursor's code is loaded by its session's attach before any of its Task hooks can come; a test may say it
// could not be.
vi.mock('../../engines/inProcess.js', async (real) => {
  const actual = await real<typeof import('../../engines/inProcess.js')>()
  return { ...actual, engineNow: vi.fn(actual.engineNow), loadEngine: vi.fn(actual.loadEngine) }
})
beforeAll(async () => { await loadEngine('cursor') })

type Manager = { args: unknown[]; register: ReturnType<typeof vi.fn>; closeParent: ReturnType<typeof vi.fn>; forget: ReturnType<typeof vi.fn>; stop: ReturnType<typeof vi.fn> }
type Queue = { options: Record<string, (...args: unknown[]) => unknown>; enqueue: ReturnType<typeof vi.fn>; wait: ReturnType<typeof vi.fn> }
const cursor = { agentId: 'a1', sessionId: 's1', engine: 'cursor' } as RegisteredSession

function setup(row: RegisteredSession | null = cursor) {
  const deps: CursorTaskDeps = {
    emitSessionEvents: vi.fn(),
    watcher: { pollSession: vi.fn(async () => {}) } as unknown as CursorTaskDeps['watcher'],
    registry: { bySession: vi.fn(() => row ?? undefined), resolve: vi.fn(() => row ?? undefined) } as unknown as CursorTaskDeps['registry'],
    cursorNormalizers: new Map(),
  }
  made.managers.length = 0
  made.queues.length = 0
  const tasks = createCursorTaskHooks(deps)
  /** The sub-agents and the queue, once a Task built them. */
  const built = () => ({ manager: made.managers[0] as Manager | undefined, queue: made.queues[0] as Queue | undefined })
  return { deps, tasks, built }
}

describe('Cursor\'s Task hooks', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('build nothing until Cursor\'s first Task: nothing to wait for, close, forget or stop', async () => {
    const { tasks, built } = setup()
    await expect(tasks.cursorTaskHooks.wait('s1')).resolves.toBeUndefined()
    tasks.cursorSubagents.closeParent('s1', true)
    tasks.cursorSubagents.forget('s1')
    tasks.cursorSubagents.stop()
    expect(built()).toEqual({ manager: undefined, queue: undefined })
  })

  it('follow sub-agents in Cursor\'s own folders, emitting through the funnel, once built', async () => {
    const { deps, tasks, built } = setup()
    tasks.onCursorTaskStart('s1', 't1', {})
    const { manager, queue } = built()
    expect(manager!.args).toEqual(['/cursor/config', deps.emitSessionEvents, '/cursor/data'])
    tasks.cursorSubagents.closeParent('s1', true)
    expect(manager!.closeParent).toHaveBeenCalledWith('s1', true)
    tasks.cursorSubagents.forget('s1')
    expect(manager!.forget).toHaveBeenCalledWith('s1')
    tasks.cursorSubagents.stop()
    expect(manager!.stop).toHaveBeenCalled()
    await tasks.cursorTaskHooks.wait('s1')
    expect(queue!.wait).toHaveBeenCalledWith('s1')
    // One of each, however many Tasks come.
    tasks.onCursorTaskStart('s1', 't2', {})
    expect(made.managers).toHaveLength(1)
    expect(made.queues).toHaveLength(1)
  })

  it('queue each Task behind a drain of its transcript, for live Cursor sessions only', async () => {
    const { deps, tasks, built } = setup()
    tasks.onCursorTaskStart('s1', 't1', {})
    const { manager, queue } = built()
    await queue!.options.drainTranscript('s1')
    expect(deps.watcher.pollSession).toHaveBeenCalledWith('s1')
    expect(queue!.options.emit).toBe(deps.emitSessionEvents)
    const hook = { toolUseId: 't1', input: {} }
    queue!.options.register('s1', hook, 'normalizer')
    expect(manager!.register).toHaveBeenCalledWith('s1', hook, 'normalizer')
    expect(queue!.options.isActive('s1')).toBe(true)
    vi.mocked(deps.registry.bySession).mockReturnValueOnce({ ...cursor, engine: 'claude' } as RegisteredSession).mockReturnValueOnce(undefined)
    expect(queue!.options.isActive('s1')).toBe(false)
    expect(queue!.options.isActive('s1')).toBe(false)
  })

  it('say which session\'s queue failed, and why', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { tasks, built } = setup()
    tasks.onCursorTaskStart('s1', 't1', {})
    const { queue } = built()
    queue!.options.onError('s1', new Error('drain failed'))
    expect(error).toHaveBeenCalledWith('[cursor] Task hook queue failed (s1):', 'drain failed')
    queue!.options.onError('s1', 'gone')
    expect(error).toHaveBeenLastCalledWith('[cursor] Task hook queue failed (s1):', 'gone')
  })

  it('start a Task on the session\'s live normalizer, making one when it has none yet', () => {
    const { deps, tasks, built } = setup()
    tasks.onCursorTaskStart('s1', 't1', { prompt: 'look' })
    const made = deps.cursorNormalizers.get('s1')
    expect(made).toBeInstanceOf(CursorNormalizer)
    const { queue } = built()
    expect(queue!.enqueue).toHaveBeenCalledWith('s1', { toolUseId: 't1', input: { prompt: 'look' } }, made)
    tasks.onCursorTaskStart('s1', 't2', null)
    expect(queue!.enqueue).toHaveBeenLastCalledWith('s1', { toolUseId: 't2', input: null }, made)
    expect(deps.cursorNormalizers.size).toBe(1)
  })

  it('ignore a Task for a session that is gone or is not Cursor\'s, and build nothing for it', () => {
    const gone = setup(null)
    gone.tasks.onCursorTaskStart('s1', 't1', {})
    expect(gone.built()).toEqual({ manager: undefined, queue: undefined })
    const other = setup({ ...cursor, engine: 'codex' } as RegisteredSession)
    other.tasks.onCursorTaskStart('s1', 't1', {})
    expect(other.built()).toEqual({ manager: undefined, queue: undefined })
    expect(other.deps.cursorNormalizers.size).toBe(0)
  })

  it('follow no Task when Cursor\'s code could not be loaded', () => {
    const { deps, tasks, built } = setup()
    vi.mocked(engineNow).mockReturnValueOnce(null)
    tasks.onCursorTaskStart('s1', 't1', {})
    expect(built()).toEqual({ manager: undefined, queue: undefined })
    expect(deps.cursorNormalizers.size).toBe(0)
  })
})

describe('Cursor\'s queued Tasks', () => {
  const dirs: string[] = []
  const dataDir = () => { const dir = mkdtempSync(join(tmpdir(), 'cursor-pending-')); dirs.push(dir); return dir }
  const now = Date.now()
  const task = (sessionId: string, toolUseId: string) => ({ sessionId, toolUseId, input: { prompt: toolUseId }, createdAt: now })
  afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); vi.clearAllMocks() })

  it('load none of Cursor\'s code where its hook never queued one: the start, a Stop and a forget find nothing', async () => {
    const dir = dataDir()
    expect(await loadPendingCursorTasks(dir)).toEqual([])
    await removePendingCursorTasks(dir, 's1')
    expect(loadEngine).not.toHaveBeenCalled()
    expect(existsSync(join(dir, 'cursor-pending-tasks.json'))).toBe(false)
  })

  it('are taken at the start by Cursor\'s own code, and a session\'s dropped on its Stop or its forget', async () => {
    const dir = dataDir()
    const file = join(dir, 'cursor-pending-tasks.json')
    writeFileSync(file, JSON.stringify([task('s1', 't1'), task('s2', 't2')]))
    expect(await loadPendingCursorTasks(dir)).toEqual([task('s1', 't1'), task('s2', 't2')])
    expect(loadEngine).toHaveBeenCalledWith('cursor')
    await removePendingCursorTasks(dir, 's1')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([task('s2', 't2')])
    await removePendingCursorTasks(dir, 's2')
    expect(existsSync(file)).toBe(false)
  })

  it('are read once the hook that holds the queue\'s lock lets go, as Cursor\'s code always waited', async () => {
    const dir = dataDir()
    const file = join(dir, 'cursor-pending-tasks.json')
    mkdirSync(`${file}.lock`)
    setTimeout(() => {
      writeFileSync(file, JSON.stringify([task('s1', 't1')]))
      rmSync(`${file}.lock`, { recursive: true, force: true })
    }, 60)
    expect(await loadPendingCursorTasks(dir)).toEqual([task('s1', 't1')])
  })

  it('are none, and stay queued, when Cursor\'s code could not be loaded', async () => {
    const dir = dataDir()
    const file = join(dir, 'cursor-pending-tasks.json')
    writeFileSync(file, JSON.stringify([task('s1', 't1')]))
    vi.mocked(loadEngine).mockResolvedValueOnce(null).mockResolvedValueOnce(null)
    expect(await loadPendingCursorTasks(dir)).toEqual([])
    await removePendingCursorTasks(dir, 's1')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual([task('s1', 't1')])
  })
})
