import { afterEach, describe, expect, it, vi } from 'vitest'
import { CursorNormalizer } from '../../engines/cursor/normalizer.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createCursorTaskHooks, type CursorTaskDeps } from './cursorTasks.js'

vi.mock('../../engines/cursor/home.js', () => ({ cursorConfigDir: () => '/cursor/config', cursorDataDir: () => '/cursor/data' }))
vi.mock('../../engines/cursor/subagent.js', () => ({
  CursorSubagentManager: class {
    readonly args: unknown[]
    register = vi.fn()
    constructor(...args: unknown[]) { this.args = args }
  },
}))
vi.mock('../../engines/cursor/taskHookQueue.js', () => ({
  CursorTaskHookQueue: class {
    enqueue = vi.fn()
    constructor(readonly options: Record<string, (...args: never[]) => unknown>) {}
  },
}))

type Manager = { args: unknown[]; register: ReturnType<typeof vi.fn> }
type Queue = { options: Record<string, (...args: unknown[]) => unknown>; enqueue: ReturnType<typeof vi.fn> }
const cursor = { agentId: 'a1', sessionId: 's1', engine: 'cursor' } as RegisteredSession

function setup(row: RegisteredSession | null = cursor) {
  const deps: CursorTaskDeps = {
    emitSessionEvents: vi.fn(),
    watcher: { pollSession: vi.fn(async () => {}) } as unknown as CursorTaskDeps['watcher'],
    registry: { bySession: vi.fn(() => row ?? undefined), resolve: vi.fn(() => row ?? undefined) } as unknown as CursorTaskDeps['registry'],
    cursorNormalizers: new Map(),
  }
  const tasks = createCursorTaskHooks(deps)
  return { deps, tasks, manager: tasks.cursorSubagents as unknown as Manager, queue: tasks.cursorTaskHooks as unknown as Queue }
}

describe('Cursor\'s Task hooks', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

  it('follow sub-agents in Cursor\'s own folders, emitting through the funnel', () => {
    const { deps, manager } = setup()
    expect(manager.args).toEqual(['/cursor/config', deps.emitSessionEvents, '/cursor/data'])
  })

  it('queue each Task behind a drain of its transcript, for live Cursor sessions only', async () => {
    const { deps, manager, queue } = setup()
    await queue.options.drainTranscript('s1')
    expect(deps.watcher.pollSession).toHaveBeenCalledWith('s1')
    expect(queue.options.emit).toBe(deps.emitSessionEvents)
    const hook = { toolUseId: 't1', input: {} }
    queue.options.register('s1', hook, 'normalizer')
    expect(manager.register).toHaveBeenCalledWith('s1', hook, 'normalizer')
    expect(queue.options.isActive('s1')).toBe(true)
    expect(setup({ ...cursor, engine: 'claude' } as RegisteredSession).queue.options.isActive('s1')).toBe(false)
    expect(setup(null).queue.options.isActive('s1')).toBe(false)
  })

  it('say which session\'s queue failed, and why', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const { queue } = setup()
    queue.options.onError('s1', new Error('drain failed'))
    expect(error).toHaveBeenCalledWith('[cursor] Task hook queue failed (s1):', 'drain failed')
    queue.options.onError('s1', 'gone')
    expect(error).toHaveBeenLastCalledWith('[cursor] Task hook queue failed (s1):', 'gone')
  })

  it('start a Task on the session\'s live normalizer, making one when it has none yet', () => {
    const { deps, tasks, queue } = setup()
    tasks.onCursorTaskStart('s1', 't1', { prompt: 'look' })
    const made = deps.cursorNormalizers.get('s1')
    expect(made).toBeInstanceOf(CursorNormalizer)
    expect(queue.enqueue).toHaveBeenCalledWith('s1', { toolUseId: 't1', input: { prompt: 'look' } }, made)
    tasks.onCursorTaskStart('s1', 't2', null)
    expect(queue.enqueue).toHaveBeenLastCalledWith('s1', { toolUseId: 't2', input: null }, made)
    expect(deps.cursorNormalizers.size).toBe(1)
  })

  it('ignore a Task for a session that is gone or is not Cursor\'s', () => {
    const gone = setup(null)
    gone.tasks.onCursorTaskStart('s1', 't1', {})
    const other = setup({ ...cursor, engine: 'codex' } as RegisteredSession)
    other.tasks.onCursorTaskStart('s1', 't1', {})
    expect(gone.queue.enqueue).not.toHaveBeenCalled()
    expect(other.queue.enqueue).not.toHaveBeenCalled()
    expect(other.deps.cursorNormalizers.size).toBe(0)
  })
})
