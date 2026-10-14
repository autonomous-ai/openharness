import type { LiveParser } from '../../engines/facets/live.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removePendingCursorTasks } from '../engines/cursorTasks.js'
import type { TurnState } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createSessionNormalizers } from '../transcripts/normalizers.js'
import { createTurnHooks, STOP_HOOK_GRACE_MS, STOP_COMPLETION_WAIT_MS, type TurnHookDeps } from './turnHooks.js'
import { engineHooks } from '../../engines/hooks.js'
import type { HookTurnContext } from '../../engines/facets/hooks.js'

// Cursor's queued Tasks are cleared through the core's own door to them (core/engines/cursorTasks.ts).
vi.mock('../engines/cursorTasks.js', () => ({ removePendingCursorTasks: vi.fn(async () => {}) }))

const END = [{ type: 'turn_ended', payload: {} }]
const ABORT = [{ type: 'turn_ended', payload: { aborted: true } }]

/** A normalizer or reader with the turn calls the hooks make. */
const engineState = (turnOpen = true) => {
  const state = {
    turnOpen,
    pendingTaskIds: () => new Set(['original-task']),
    openTurn: vi.fn(() => [{ type: 'turn_started', payload: { userMessage: '' } }]),
    closeTurn: vi.fn(() => { state.turnOpen = false; return END }),
    abortTurn: vi.fn(() => { state.turnOpen = false; return ABORT }),
  }
  return state
}

function setup(engine: string, over: Partial<TurnHookDeps> = {}) {
  const normalizers = createSessionNormalizers()
  const deps: TurnHookDeps = {
    resolve: (id) => id === 's1' ? ({ agentId: 'a1', sessionId: 's1', engine } as RegisteredSession) : undefined,
    normalizers,
    emit: vi.fn(),
    drain: vi.fn(async () => {}),
    onCursorTaskStart: vi.fn(),
    cursorTaskHooks: { wait: vi.fn(async () => {}) },
    cursorSubagents: { closeParent: vi.fn() },
    announceTurnAborted: vi.fn(),
    armAgyIdleWatch: vi.fn(),
    clearAgyIdleWatch: vi.fn(),
    mirror: { noteEngineStopped: vi.fn() },
    dataDir: '/data',
    ...over,
  }
  return { deps, normalizers, hooks: createTurnHooks(deps) }
}

// Existing hook scenarios control transcript arrival without exposing mutable state through the port.
let generation = 0
function parserOf(state: TurnState): LiveParser {
  const identity = ++generation
  return {
    engine: 'claude',
    get turnOpen() { return state.turnOpen },
    snapshot: () => ({ identity: `${identity}:${state.opened ?? 0}`, turnOpen: state.turnOpen, continued: state.continued === true }),
    closeTurn: () => { state.turnOpen = false; state.pendingTools.clear() },
    ingest: () => ({ events: [] }),
    windowStart: () => {},
  }
}
const setState = (run: ReturnType<typeof setup>, state: TurnState) => run.normalizers.liveParsers.set('s1', parserOf(state))

const put = (map: Map<string, unknown>, state: unknown) => map.set('s1', state)

describe('turn hooks', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  describe('a legacy Claude Stop retained before admission', () => {
    function retained(over: Partial<TurnHookDeps> = {}, status?: string) {
      const session = { agentId: 'a1', sessionId: 's1', engine: 'claude', transcriptPath: '/fixture/original.jsonl', evidenceRevision: 1 } as RegisteredSession
      const run = setup('claude', { resolve: id => id === 's1' ? session : undefined, ...over })
      const state = { turnOpen: true, opened: 1, pendingTools: new Map() } as unknown as TurnState
      setState(run, state); run.normalizers.noteTurnStart('s1')
      let cancelled = false, alive = true
      const stop = run.hooks.captureStop(session, { sessionId: 's1', firedAt: 1_000, status }, () => !cancelled)
      const execution = { current: () => alive, verify: vi.fn(), confirm: vi.fn(async () => {}) }
      return { ...run, session, state, stop, execution, cancel: () => { cancelled = true }, shutdown: () => { alive = false } }
    }

    it('waits for admission, then completes the original turn once with refreshed proof after each drain', async () => {
      const run = retained()
      await vi.advanceTimersByTimeAsync(500)
      const result = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await result).toBe('completed')
      expect(run.execution.confirm).toHaveBeenCalledTimes(2)
      expect(run.state.turnOpen).toBe(false)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
      expect(run.deps.mirror.noteEngineStopped).toHaveBeenCalledExactlyOnceWith('s1')
      expect(await run.stop(run.execution)).toBe('completed')
      expect(run.deps.drain).toHaveBeenCalledTimes(2)
    })

    it.each(['identityHold', 'interpretationHold'] as const)('retries the original Stop when its initial %s clears before any effect starts', async field => {
      const run = retained()
      run.session[field] = 'original evidence temporarily unavailable'
      expect(await run.stop(run.execution)).toBe('held')
      expect(run.deps.drain).not.toHaveBeenCalled()
      expect(run.deps.emit).not.toHaveBeenCalled()
      delete run.session[field]
      const result = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await result).toBe('completed')
      expect(run.state.turnOpen).toBe(false)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
      expect(run.deps.mirror.noteEngineStopped).toHaveBeenCalledExactlyOnceWith('s1')
      expect(await run.stop(run.execution)).toBe('completed')
      expect(run.deps.drain).toHaveBeenCalledTimes(2)
    })

    it('retries an unavailable initial proof before starting the original Stop effect', async () => {
      const run = retained()
      run.execution.verify.mockImplementationOnce(() => { throw Error('fixture journal proof temporarily unavailable') })
      expect(await run.stop(run.execution)).toBe('held')
      expect(run.deps.drain).not.toHaveBeenCalled()
      const result = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await result).toBe('completed')
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
      expect(run.deps.mirror.noteEngineStopped).toHaveBeenCalledExactlyOnceWith('s1')
      expect(await run.stop(run.execution)).toBe('completed')
      expect(run.deps.drain).toHaveBeenCalledTimes(2)
    })

    it.each([undefined, 'error'])('keeps a no-original-turn notification from closing a later reconstructed question (%s)', async status => {
      const run = setup('claude')
      const stop = run.hooks.captureStop(run.deps.resolve('s1')!, { sessionId: 's1', status }, () => true)
      const question = { turnOpen: true, opened: 2, pendingTools: new Map() } as unknown as TurnState
      setState(run, question); run.normalizers.noteTurnStart('s1')
      expect(await stop()).toBe('completed')
      expect(question.turnOpen).toBe(true)
      expect(run.deps.drain).not.toHaveBeenCalled()
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(run.deps.mirror.noteEngineStopped).not.toHaveBeenCalled()
    })

    it('keeps an already closed arrival inert even if its existing parser later opens a turn', async () => {
      const run = setup('claude'), state = { turnOpen: false, pendingTools: new Map() } as unknown as TurnState
      setState(run, state)
      const stop = run.hooks.captureStop(run.deps.resolve('s1')!, { sessionId: 's1' }, () => true)
      state.turnOpen = true
      expect(await stop()).toBe('completed')
      expect(state.turnOpen).toBe(true)
      expect(run.deps.mirror.noteEngineStopped).not.toHaveBeenCalled()
    })

    it.each(['identityHold', 'interpretationHold'] as const)('does not infer idle from a missing parser while %s is recorded', async field => {
      const session = { agentId: 'a1', sessionId: 's1', engine: 'claude', [field]: 'original source unavailable' } as unknown as RegisteredSession
      const run = setup('claude', { resolve: () => session })
      let cancelled = false
      const stop = run.hooks.captureStop(session, { sessionId: 's1' }, () => !cancelled)
      delete session[field]
      setState(run, { turnOpen: true, pendingTools: new Map() } as unknown as TurnState)
      expect(await stop()).toBe('held')
      expect(run.deps.mirror.noteEngineStopped).not.toHaveBeenCalled()
      expect(run.deps.emit).not.toHaveBeenCalled()
      cancelled = true
      expect(await stop()).toBe('superseded')
    })

    it.each(['Cancel', 'new turn', 'new prompt', 'new owner', 'missing owner', 'parser', 'path', 'revision', 'identity', 'interpretation'] as const)(
      'keeps %s from inheriting a retained Stop or its recap effect', async changed => {
        let missing = false
        const run = retained({ resolve: id => missing ? undefined : session })
        const session = run.session
        if (changed === 'Cancel') run.cancel()
        if (changed === 'new turn') run.normalizers.noteTurnStart('s1')
        if (changed === 'new prompt') run.hooks.onPromptHook('s1', 2_000)
        if (changed === 'new owner') session.agentId = 'a2'
        if (changed === 'missing owner') missing = true
        if (changed === 'parser') setState(run, { ...run.state })
        if (changed === 'path') session.transcriptPath = '/fixture/replacement.jsonl'
        if (changed === 'revision') session.evidenceRevision!++
        if (changed === 'identity') session.identityHold = 'unavailable'
        if (changed === 'interpretation') session.interpretationHold = 'unavailable'
        const result = run.stop(run.execution)
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
        expect(await result).toBe(['parser', 'path', 'revision', 'identity', 'interpretation'].includes(changed) ? 'held' : 'superseded')
        expect(run.state.turnOpen).toBe(true)
        expect(run.deps.drain).not.toHaveBeenCalled()
        expect(run.deps.mirror.noteEngineStopped).not.toHaveBeenCalled()
      })

    it.each(['Cancel', 'successor', 'shutdown', 'deadline', 'rejection'] as const)('fences a delayed drain after %s, StopFailure included', async changed => {
      let release!: () => void, reject!: (error: Error) => void
      const run = retained({ drain: () => new Promise<void>((done, fail) => { release = done; reject = fail }) }, 'error')
      const result = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(0)
      if (changed === 'Cancel') run.cancel()
      if (changed === 'successor') run.state.opened = 2
      if (changed === 'shutdown') run.shutdown()
      if (changed === 'rejection') reject(Error('fixture drain unavailable'))
      await vi.advanceTimersByTimeAsync(changed === 'deadline' ? STOP_COMPLETION_WAIT_MS : 25)
      expect(await result).toBe(changed === 'Cancel' || changed === 'successor' ? 'superseded' : 'held')
      release(); await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(run.state.turnOpen).toBe(true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(run.deps.mirror.noteEngineStopped).not.toHaveBeenCalled()
    })

    it('retries a settled confirmation failure before any original Stop effect was dispatched', async () => {
      const run = retained()
      run.execution.confirm.mockRejectedValueOnce(Error('fixture ownership temporarily unavailable'))
      expect(await run.stop(run.execution)).toBe('held')
      expect(run.deps.mirror.noteEngineStopped).not.toHaveBeenCalled()
      const result = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await result).toBe('completed')
      expect(run.state.turnOpen).toBe(false)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
      expect(run.deps.mirror.noteEngineStopped).toHaveBeenCalledExactlyOnceWith('s1')
      expect(await run.stop(run.execution)).toBe('completed')
      expect(run.execution.confirm).toHaveBeenCalledTimes(3)
    })

    it('keeps a failed confirmation held after an original Stop effect was dispatched', async () => {
      const run = retained()
      run.execution.confirm.mockResolvedValueOnce(undefined).mockRejectedValue(Error('fixture ownership unavailable'))
      const result = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await result).toBe('held')
      expect(run.stop.retryable?.()).toBe(false)
      expect(await run.stop(run.execution)).toBe('held')
      expect(run.execution.confirm).toHaveBeenCalledTimes(2)
      expect(run.deps.mirror.noteEngineStopped).toHaveBeenCalledExactlyOnceWith('s1')
      expect(run.deps.emit).not.toHaveBeenCalled()
    })

    it.each(['deadline', 'temporary hold'] as const)('waits for actual preparation after %s and never revives its late callbacks', async cause => {
      const run = retained()
      let release!: () => void
      vi.mocked(run.deps.drain).mockImplementationOnce(() => new Promise<void>(done => { release = done }))
      const result = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(0)
      if (cause === 'temporary hold') run.session.interpretationHold = 'fixture reader temporarily held'
      await vi.advanceTimersByTimeAsync(cause === 'deadline' ? STOP_COMPLETION_WAIT_MS : 25)
      expect(await result).toBe('held')
      expect(run.stop.retryable?.()).toBe(false)
      expect(await run.stop(run.execution)).toBe('held')
      expect(run.deps.drain).toHaveBeenCalledOnce()
      delete run.session.interpretationHold
      release(); await vi.advanceTimersByTimeAsync(0)
      expect(run.stop.retryable?.()).toBe(true)
      expect(run.deps.mirror.noteEngineStopped).not.toHaveBeenCalled()
      const retry = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await retry).toBe('completed')
      expect(run.deps.mirror.noteEngineStopped).toHaveBeenCalledExactlyOnceWith('s1')
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    })

    it('rejects late close callbacks from a revoked preparation while its retry owns the turn', async () => {
      const run = retained()
      let context!: HookTurnContext, release!: () => void
      vi.spyOn(engineHooks.claude, 'onStop').mockImplementationOnce(value => {
        context = value
        expect(context.closeTurn('other-session', run.normalizers.liveParsers.get('s1')!.snapshot().identity)).toBe(false)
        return new Promise<void>(done => { release = done })
      })
      const first = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(0)
      const identity = run.normalizers.liveParsers.get('s1')!.snapshot().identity
      run.session.interpretationHold = 'fixture preparation held'
      await vi.advanceTimersByTimeAsync(25)
      expect(await first).toBe('held')
      delete run.session.interpretationHold
      release(); await vi.advanceTimersByTimeAsync(0)
      const retry = run.stop(run.execution)
      expect(context.closeTurn('s1', identity)).toBe(false)
      expect(run.state.turnOpen).toBe(true)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await retry).toBe('completed')
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    })

    it('never retries an original Stop effect whose callback throws after entry', async () => {
      const run = retained()
      vi.mocked(run.deps.mirror.noteEngineStopped).mockImplementation(() => { throw Error('fixture effect outcome unknown') })
      expect(await run.stop(run.execution)).toBe('held')
      expect(run.stop.retryable?.()).toBe(false)
      expect(await run.stop(run.execution)).toBe('held')
      expect(run.deps.mirror.noteEngineStopped).toHaveBeenCalledOnce()
      expect(run.deps.emit).not.toHaveBeenCalled()
      run.cancel()
      expect(await run.stop(run.execution)).toBe('superseded')
    })

    it('supports an already confirmed local Stop without an asynchronous confirmation callback', async () => {
      const run = retained()
      const result = run.stop({ current: run.execution.current, verify: run.execution.verify })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await result).toBe('completed')
      expect(run.state.turnOpen).toBe(false)
    })

    it('treats Cancel during a rejected drain or proof as superseding the original notification', async () => {
      const drained = retained()
      vi.mocked(drained.deps.drain).mockImplementation(async () => { drained.cancel(); throw Error('fixture read failed after Cancel') })
      expect(await drained.stop(drained.execution)).toBe('superseded')
      expect(drained.deps.emit).not.toHaveBeenCalled()
      const proved = retained()
      proved.execution.verify.mockImplementation(() => { proved.cancel(); throw Error('fixture proof failed after Cancel') })
      expect(await proved.stop(proved.execution)).toBe('superseded')
      expect(proved.deps.drain).not.toHaveBeenCalled()
    })

    it('does not publish the old completion when Cancel revokes it during the atomic close', async () => {
      const run = retained(), parser = run.normalizers.liveParsers.get('s1')!
      const close = parser.closeTurn.bind(parser)
      vi.spyOn(parser, 'closeTurn').mockImplementation((...args) => { close(...args); run.cancel() })
      const result = run.stop(run.execution)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await result).toBe('superseded')
      expect(run.state.turnOpen).toBe(false)
      expect(run.deps.emit).not.toHaveBeenCalled()
    })

    it('contains failed final proof and a Cancel issued by that proof', async () => {
      const failed = retained()
      failed.execution.verify.mockImplementation(() => { throw Error('fixture proof changed') })
      expect(await failed.stop(failed.execution)).toBe('held')
      const cancelled = retained()
      cancelled.execution.verify.mockImplementation(cancelled.cancel)
      expect(await cancelled.stop(cancelled.execution)).toBe('superseded')
      expect(cancelled.deps.drain).not.toHaveBeenCalled()
    })
  })

  describe('a Stop captured by its native registration', () => {
    function captured(engine: 'cursor' | 'commandcode' = 'cursor', over: Partial<TurnHookDeps> = {}) {
      const run = setup(engine, { holdStop: vi.fn(() => true), afterStop: vi.fn(), ...over })
      const state = engineState()
      const map = engine === 'cursor' ? run.normalizers.cursorNormalizers : run.normalizers.commandcodeNormalizers
      put(map, state)
      run.normalizers.noteTurnStart('s1')
      let cancelled = false
      const stop = run.hooks.captureStop(run.deps.resolve('s1')!, { sessionId: 's1' }, () => !cancelled)
      return { ...run, state, map, stop, cancel: () => { cancelled = true } }
    }

    it('waits for tasks and the original parser, and retries a completed result without closing twice', async () => {
      let release!: () => void
      const wait = new Promise<void>(resolve => { release = resolve })
      const run = captured('cursor', { drain: vi.fn(() => wait) })
      const completed = vi.fn()
      const first = run.stop().then(completed)
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.cursorTaskHooks.wait).toHaveBeenCalledOnce()
      expect(run.state.closeTurn).not.toHaveBeenCalled()
      expect(completed).not.toHaveBeenCalled()
      release()
      await first
      expect(completed).toHaveBeenCalledWith('completed')
      expect(await run.stop()).toBe('completed')
      expect(run.state.closeTurn).toHaveBeenCalledOnce()
      const fence = vi.mocked(run.deps.cursorSubagents.closeParent).mock.calls[0][2]!
      expect(fence()).toBe(true)
      run.normalizers.noteTurnStart('s1')
      expect(fence()).toBe(true)
      expect(removePendingCursorTasks).toHaveBeenLastCalledWith('/data', 's1', fence, new Set(['original-task']))
      vi.mocked(removePendingCursorTasks).mockClear()
      await vi.advanceTimersByTimeAsync(2_500)
      expect(removePendingCursorTasks).not.toHaveBeenCalled()
    })

    it.each(['task', 'drain'] as const)('does not close a successor which starts during the %s wait', async waiting => {
      let release!: () => void
      const wait = new Promise<void>(resolve => { release = resolve })
      const run = captured('cursor', waiting === 'task' ? { cursorTaskHooks: { wait: () => wait } } : { drain: () => wait })
      const result = run.stop()
      await vi.advanceTimersByTimeAsync(0)
      run.normalizers.noteTurnStart('s1')
      release()
      expect(await result).toBe('superseded')
      expect(run.state.closeTurn).not.toHaveBeenCalled()
      expect(run.deps.emit).not.toHaveBeenCalled()
    })

    it('holds unknown or rebuilt interpretation, and allows explicit Cancel to resolve the held effect', async () => {
      const absent = setup('cursor')
      expect(await absent.hooks.captureStop(absent.deps.resolve('s1')!, { sessionId: 's1' }, () => true)()).toBe('held')
      const run = captured()
      put(run.map, engineState())
      expect(await run.stop()).toBe('held')
      expect(run.deps.holdStop).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1' }), true)
      expect(run.state.closeTurn).not.toHaveBeenCalled()
      run.cancel()
      expect(await run.stop()).toBe('superseded')
      const changed = captured()
      changed.normalizers.forget('s1')
      expect(await changed.stop()).toBe('held')
    })

    it('holds a failed drain without retrying it as a new Stop', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const run = captured('cursor', { drain: vi.fn(async () => { throw new Error('read unavailable') }) })
      expect(await run.stop()).toBe('held')
      expect(await run.stop()).toBe('held')
      expect(run.deps.drain).toHaveBeenCalledOnce()
      expect(run.state.closeTurn).not.toHaveBeenCalled()
    })

    it.each(['Cancel', 'successor'] as const)('does not install a hold when the drain fails after %s', async superseded => {
      let reject!: (error: Error) => void
      const run = captured('cursor', { drain: () => new Promise((_resolve, fail) => { reject = fail }) })
      const result = run.stop()
      await vi.advanceTimersByTimeAsync(0)
      if (superseded === 'Cancel') run.cancel()
      else run.normalizers.noteTurnStart('s1')
      reject(new Error('late drain failure'))
      expect(await result).toBe('superseded')
      expect(run.deps.holdStop).not.toHaveBeenCalled()
      expect(run.state.closeTurn).not.toHaveBeenCalled()
    })

    it('lets Cancel release a stalled drain and ignores its later completion', async () => {
      let release!: () => void
      const run = captured('cursor', { drain: () => new Promise(resolve => { release = resolve }) })
      const result = run.stop()
      await vi.advanceTimersByTimeAsync(0)
      run.cancel()
      await vi.advanceTimersByTimeAsync(25)
      expect(await result).toBe('superseded')
      release()
      await vi.advanceTimersByTimeAsync(0)
      expect(run.state.closeTurn).not.toHaveBeenCalled()
      expect(run.deps.holdStop).not.toHaveBeenCalled()
    })

    it.each(['deadline', 'shutdown'] as const)('revokes a stalled Stop on %s and never acts when the reader returns', async reason => {
      let release!: () => void, active = true
      const run = captured('cursor', { drain: vi.fn(() => new Promise<void>(resolve => { release = resolve })) })
      const result = run.stop({ current: () => active, verify: vi.fn() })
      await vi.advanceTimersByTimeAsync(0)
      if (reason === 'shutdown') active = false
      await vi.advanceTimersByTimeAsync(STOP_COMPLETION_WAIT_MS)
      expect(await result).toBe('held')
      expect(run.deps.holdStop).toHaveBeenCalledTimes(reason === 'deadline' ? 1 : 0)
      release()
      expect(await run.stop()).toBe('held')
      expect(run.deps.drain).toHaveBeenCalledOnce()
      expect(run.state.closeTurn).not.toHaveBeenCalled()
    })

    it.each(['drain', 'verification'] as const)('checks elapsed time at %s completion even before an overdue timer runs', async phase => {
      let elapsed = 0, release!: () => void
      vi.spyOn(performance, 'now').mockImplementation(() => elapsed)
      const run = captured('cursor', phase === 'drain' ? {
        drain: () => new Promise<void>(resolve => { release = resolve }),
      } : {})
      const result = run.stop({ current: () => true, verify: () => { elapsed = STOP_COMPLETION_WAIT_MS } })
      if (phase === 'drain') {
        await vi.advanceTimersByTimeAsync(0)
        elapsed = STOP_COMPLETION_WAIT_MS
        release()
      }
      expect(await result).toBe('held')
      expect(run.state.closeTurn).not.toHaveBeenCalled()
      expect(run.deps.cursorSubagents.closeParent).not.toHaveBeenCalled()
      expect(run.deps.holdStop).toHaveBeenCalledOnce()
    })

    it('finishes original task-file cleanup before confirming Stop and keeps its exact-ID closure through reattachment', async () => {
      let release!: () => void, active = true
      vi.mocked(removePendingCursorTasks).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
      const run = captured(), confirmed = vi.fn()
      const result = run.stop({ current: () => active, verify: vi.fn() }).then(confirmed)
      await vi.advanceTimersByTimeAsync(0)
      expect(run.state.closeTurn).toHaveBeenCalledOnce()
      expect(confirmed).not.toHaveBeenCalled()
      release(); await result
      expect(confirmed).toHaveBeenCalledWith('completed')
      const fence = vi.mocked(run.deps.cursorSubagents.closeParent).mock.calls[0][2]!
      expect(removePendingCursorTasks).toHaveBeenLastCalledWith('/data', 's1', fence, new Set(['original-task']))
      put(run.map, engineState()); run.normalizers.noteTurnStart('s1')
      expect(fence()).toBe(true)
      active = false
      expect(fence()).toBe(false)
    })

    it.each(['gone', 'rebound', 'source', 'identity', 'interpretation'] as const)('does not borrow a %s binding after capture', async changed => {
      const session = { agentId: 'a1', sessionId: 's1', engine: 'cursor' } as RegisteredSession
      const resolve = vi.fn((): RegisteredSession | undefined => session)
      const run = captured('cursor', { resolve })
      if (changed === 'gone') resolve.mockReturnValue(undefined)
      if (changed === 'rebound') session.agentId = 'replacement'
      if (changed === 'source') session.transcriptPath = '/fixture/replacement.jsonl'
      if (changed === 'identity') session.identityHold = 'native source unavailable'
      if (changed === 'interpretation') session.interpretationHold = 'reader unavailable'
      expect(await run.stop()).toBe(['gone', 'rebound'].includes(changed) ? 'superseded' : 'held')
      expect(run.state.closeTurn).not.toHaveBeenCalled()
    })

    it('contains a task wait that rejects after shutdown has already released its Stop', async () => {
      let reject!: (error: Error) => void, active = true
      const run = captured('cursor', { cursorTaskHooks: { wait: () => new Promise<void>((_, fail) => { reject = fail }) } })
      const result = run.stop({ current: () => active, verify: vi.fn() })
      active = false
      await vi.advanceTimersByTimeAsync(25)
      expect(await result).toBe('held')
      reject(new Error('late Task failure'))
      await vi.advanceTimersByTimeAsync(0)
      expect(run.state.closeTurn).not.toHaveBeenCalled()
      expect(run.deps.holdStop).not.toHaveBeenCalled()
    })

    it('lets Cancel overtake a just-settled failed interpretation without installing an obsolete hold', async () => {
      const session = { agentId: 'a1', sessionId: 's1', engine: 'cursor' } as RegisteredSession
      let release!: () => void
      const work = new Promise<void>(resolve => { release = resolve })
      const run = captured('cursor', { resolve: () => session, drain: () => work })
      const result = run.stop()
      await vi.advanceTimersByTimeAsync(0)
      session.interpretationHold = 'source changed while reading'
      void work.then(run.cancel)
      release()
      expect(await result).toBe('superseded')
      expect(run.deps.holdStop).not.toHaveBeenCalled()
    })

    it.each([false, true])('announces a captured Cursor error only when it has no closing output (%s)', async empty => {
      const run = captured()
      if (empty) run.state.closeTurn.mockReturnValueOnce([])
      const stop = run.hooks.captureStop(run.deps.resolve('s1')!, { sessionId: 's1', status: 'error' }, () => true)
      expect(await stop()).toBe('completed')
      expect(run.deps.announceTurnAborted).toHaveBeenCalledTimes(empty ? 1 : 0)
      expect(run.deps.cursorSubagents.closeParent).toHaveBeenCalledWith('s1', true, expect.any(Function), new Set(['original-task']))
    })

    it.each(['held', 'superseded'] as const)('keeps incomplete task cleanup %s without repeating a closed turn', async outcome => {
      let release!: () => void
      vi.mocked(removePendingCursorTasks).mockImplementationOnce(() => new Promise<void>(resolve => { release = resolve }))
      const run = captured(), result = run.stop()
      await vi.advanceTimersByTimeAsync(0)
      if (outcome === 'superseded') run.cancel()
      else await vi.advanceTimersByTimeAsync(STOP_COMPLETION_WAIT_MS)
      release()
      expect(await result).toBe(outcome)
      expect(await run.stop()).toBe(outcome)
      expect(run.state.closeTurn).toHaveBeenCalledOnce()
    })

    it('rechecks cancellation during final ownership verification before closing Cursor', async () => {
      const run = captured()
      expect(await run.stop({ current: () => true, verify: run.cancel })).toBe('superseded')
      expect(run.state.closeTurn).not.toHaveBeenCalled()
    })

    it.each(['grace', 'second drain', 'final verification'] as const)('rechecks Command Code authority during %s', async phase => {
      for (const outcome of ['held', 'superseded'] as const) {
        const session = { agentId: 'a1', sessionId: 's1', engine: 'commandcode' } as RegisteredSession
        let release!: () => void, reads = 0, verifications = 0
        const run = captured('commandcode', { resolve: () => session, drain: () => ++reads === 2 && phase === 'second drain'
          ? new Promise<void>(resolve => { release = resolve }) : Promise.resolve() })
        const revoke = () => { if (outcome === 'superseded') run.cancel(); else session.identityHold = 'original source unavailable' }
        const result = run.stop({ current: () => true, verify: () => { if (++verifications === 2 && phase === 'final verification') revoke() } })
        await vi.advanceTimersByTimeAsync(0)
        if (phase === 'grace') revoke()
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
        if (phase === 'second drain') { revoke(); release() }
        expect(await result).toBe(outcome)
        expect(run.state.closeTurn).not.toHaveBeenCalled()
      }
    })

    it('keeps a native Command Code completion discovered by the final drain', async () => {
      let reads = 0
      const run = captured('commandcode', { drain: async () => { if (++reads === 2) run.state.turnOpen = false } })
      const result = run.stop()
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await result).toBe('completed')
      expect(run.state.closeTurn).not.toHaveBeenCalled()
    })

    it('finishes Command Code only after its grace and second drain', async () => {
      const run = captured('commandcode')
      const result = run.stop()
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS - 1)
      expect(run.state.closeTurn).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(1)
      expect(await result).toBe('completed')
      expect(run.deps.drain).toHaveBeenCalledTimes(2)
      expect(run.state.closeTurn).toHaveBeenCalledOnce()
      expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
    })

    it('does not reopen a naturally ended Command Code turn or close a successor during grace', async () => {
      const natural = captured('commandcode')
      natural.state.turnOpen = false
      expect(await natural.stop()).toBe('completed')
      expect(natural.state.closeTurn).not.toHaveBeenCalled()
      const replaced = captured('commandcode')
      const result = replaced.stop()
      await vi.advanceTimersByTimeAsync(1)
      replaced.normalizers.noteTurnStart('s1')
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(await result).toBe('superseded')
      expect(replaced.state.closeTurn).not.toHaveBeenCalled()
    })
  })

  it('opens Command Code\'s turn on its first tool call, and nothing else\'s', () => {
    const cc = setup('commandcode')
    const normalizer = engineState(false)
    cc.hooks.onTurnStart({ sessionId: 's1' })
    put(cc.normalizers.commandcodeNormalizers, normalizer)
    cc.hooks.onTurnStart({ sessionId: 's1' })
    cc.hooks.onTurnStart({ sessionId: 'nobody' })
    setup('claude').hooks.onTurnStart({ sessionId: 's1' })
    expect(cc.deps.emit).toHaveBeenCalledTimes(1)
    expect(cc.deps.emit).toHaveBeenCalledWith('s1', normalizer.openTurn.mock.results[0].value)
  })

  it('registers a Cursor sub-agent when its Task tool starts', () => {
    const { deps, hooks } = setup('cursor')
    hooks.onToolStart({ sessionId: 's1', toolUseId: 't1', toolName: 'Task', input: { prompt: 'x' } })
    hooks.onToolStart({ sessionId: 's1', toolUseId: 't2', toolName: 'Read', input: {} })
    expect(deps.onCursorTaskStart).toHaveBeenCalledTimes(1)
    expect(deps.onCursorTaskStart).toHaveBeenCalledWith('s1', 't1', { prompt: 'x' })
  })

  it('does nothing for a Stop from a session it does not know, or an engine with no Stop rule', async () => {
    const unknown = setup('claude')
    unknown.hooks.onTurnStop({ sessionId: 'nobody' })
    const pi = setup('pi')
    pi.hooks.onTurnStop({ sessionId: 's1' })
    const codex = setup('codex')
    codex.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
    await vi.runAllTimersAsync()
    expect(unknown.deps.drain).not.toHaveBeenCalled()
    expect(pi.deps.drain).not.toHaveBeenCalled()
    expect(codex.deps.drain).not.toHaveBeenCalled()
    expect(codex.deps.emit).not.toHaveBeenCalled()
  })

  it('contains a synchronous engine failure and still handles another engine', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(engineHooks.claude, 'onStop').mockImplementationOnce(() => { throw new Error('engine failed') })
    expect(() => setup('claude').hooks.onTurnStop({ sessionId: 's1' })).not.toThrow()
    const other = setup('commandcode')
    const state = engineState()
    put(other.normalizers.commandcodeNormalizers, state)
    other.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(other.deps.emit).toHaveBeenCalledWith('s1', END)
    expect(error).toHaveBeenCalledWith('[hooks] claude stop hook failed:', 'engine failed')
  })

  it('refuses an engine closure for a replaced turn, changed engine or forgotten session', () => {
    let context!: HookTurnContext
    vi.spyOn(engineHooks.claude, 'onStop').mockImplementationOnce((value) => { context = value })
    const row = { sessionId: 's1', engine: 'claude' } as RegisteredSession
    const run = setup('claude', { resolve: (id) => id === 's1' ? row : undefined })
    const state = { turnOpen: true, opened: 1, pendingTools: new Set() } as TurnState
    setState(run, state)
    run.hooks.onTurnStop({ sessionId: 's1' })
    const first = context.turnState('s1')!
    state.opened = 2
    expect(context.closeTurn('s1', first.identity)).toBe(false)
    expect(state.turnOpen).toBe(true)
    row.engine = 'codex'
    expect(context.turnState('s1')).toBeUndefined()
    expect(context.closeTurn('s1', first.identity)).toBe(false)
    row.engine = 'claude'
    expect(context.closeTurn('s1', context.turnState('s1')!.identity)).toBe(true)
    expect(state.turnOpen).toBe(false)
    run.normalizers.forget('s1')
    expect(context.turnState('s1')).toBeUndefined()
    expect(context.closeTurn('s1', first.identity)).toBe(false)
    // A parser whose registry binding disappeared cannot authorize a closure either.
    run.normalizers.liveParsers.set('unbound', parserOf(state))
    expect(context.turnState('unbound')).toBeUndefined()
    expect(context.closeTurn('unbound', first.identity)).toBe(false)
  })

  describe('Claude Code', () => {
    it('lets the transcript close the turn when it can, and closes a wedged one after the grace', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup('claude')
      const state = { turnOpen: true, pendingTools: new Map([['t', {}]]) } as unknown as TurnState
      setState(run, state)
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.mirror.noteEngineStopped).toHaveBeenCalledWith('s1')
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(state.turnOpen).toBe(false)
      expect(state.pendingTools.size).toBe(0)
      expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
      expect(String(log.mock.calls[0][0])).toContain('force-closed by StopFailure hook')
      // Closed by the transcript before the grace ran out, or never open: nothing more to do.
      state.turnOpen = true
      vi.mocked(run.deps.drain).mockImplementation(async () => { if (vi.mocked(run.deps.drain).mock.calls.length > 3) state.turnOpen = false })
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(run.deps.emit).toHaveBeenCalledTimes(1)
    })

    // A /goal loop: a pass a blocking Stop hook continued is the transcript's to close. The Stop of the pass
    // before it reached the daemon 520 ms after the next pass had started (end to end, under load), and
    // force-closed that pass after the grace while it ran.
    it('leaves a pass a blocking Stop hook continued to the transcript, unless the Stop is a failure', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup('claude')
      const state = { turnOpen: true, pendingTools: new Map(), continued: true } as unknown as TurnState
      setState(run, state)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(run.deps.mirror.noteEngineStopped).toHaveBeenCalledWith('s1')
      // The same, when the drain after the grace reads the pass's start.
      state.continued = false
      vi.mocked(run.deps.drain).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { state.continued = true })
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(state.turnOpen).toBe(true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      // A StopFailure is the API failing in the pass itself: closed, as any wedged turn is.
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(state.turnOpen).toBe(false)
      expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
      expect(String(log.mock.calls[0][0])).toContain('force-closed by StopFailure hook')
    })

    // Found by the soak run (e2e/endurance.e2e.ts): a turn's Stop reached the daemon 6 s late under load, after
    // the next prompt's turn had opened, and force-closed that turn with a question open in it.
    it('leaves a turn that opened after the Stop arrived, the next prompt\'s, to its own end, unless the Stop is a failure', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup('claude')
      // The Stop's own turn closed already; the drain reads the next prompt's turn opening.
      const state = { turnOpen: false, opened: 1, pendingTools: new Map() } as unknown as TurnState
      setState(run, state)
      vi.mocked(run.deps.drain).mockImplementationOnce(async () => { state.turnOpen = true; state.opened = 2 })
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(state.turnOpen).toBe(true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      // Open as the Stop arrived, closed by the transcript in the drain, and the next one opened: left too.
      vi.mocked(run.deps.drain).mockImplementationOnce(async () => { state.opened = 3 })
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(state.turnOpen).toBe(true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      // The engine's state started over meanwhile (the session attached again): not the turn the Stop found.
      setState(run, { turnOpen: true, opened: 3, pendingTools: new Map() } as unknown as TurnState)
      vi.mocked(run.deps.drain).mockImplementationOnce(async () => { setState(run, { ...state }) })
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(run.deps.emit).not.toHaveBeenCalled()
      // A StopFailure closes whatever is open.
      setState(run, state)
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(state.turnOpen).toBe(false)
      expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
      expect(String(log.mock.calls[0][0])).toContain('force-closed by StopFailure hook')
    })

    it('closes nothing with a Stop its engine ran before the session\'s latest prompt hook, a failure included', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup('claude')
      const state = { turnOpen: true, opened: 2, pendingTools: new Map() } as unknown as TurnState
      setState(run, state)
      run.hooks.onPromptHook('s1', 2_000)
      // An older prompt hook, arriving late, does not move it back.
      run.hooks.onPromptHook('s1', 1_500)
      for (const status of [undefined, 'error']) {
        run.hooks.onTurnStop({ sessionId: 's1', status, firedAt: 1_000 })
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      }
      expect(state.turnOpen).toBe(true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      // Run after it: about the open turn, which it closes once the grace is over, as before.
      run.hooks.onTurnStop({ sessionId: 's1', firedAt: 3_000 })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(state.turnOpen).toBe(false)
      expect(String(log.mock.calls[0][0])).toContain('force-closed by Stop hook')
      // Remembered for a bounded number of sessions: the oldest goes first.
      for (let i = 0; i < 600; i++) run.hooks.onPromptHook(`s${i + 2}`, 5_000)
      state.turnOpen = true
      run.hooks.onTurnStop({ sessionId: 's1', firedAt: 1_000 })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(state.turnOpen).toBe(false)
    })

    it('says Stop for a clean stop', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup('claude')
      setState(run, { turnOpen: true, pendingTools: new Map() } as unknown as TurnState)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(String(log.mock.calls[0][0])).toContain('force-closed by Stop hook')
    })
  })

  describe('engines whose Stop hook is their turn boundary', () => {
    for (const engine of ['commandcode', 'copilot', 'agy'] as const) {
      const map = (run: ReturnType<typeof setup>) => engine === 'commandcode' ? run.normalizers.commandcodeNormalizers
        : engine === 'copilot' ? run.normalizers.copilotNormalizers : run.normalizers.agyNormalizers

      it(`${engine}: drains, waits the grace, then closes what is still open`, async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const run = setup(engine)
        const normalizer = engineState()
        put(map(run), normalizer)
        run.hooks.onTurnStop({ sessionId: 's1' })
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS - 1)
        expect(run.deps.emit).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(1)
        expect(run.deps.drain).toHaveBeenCalledTimes(2)
        expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
        expect(log).toHaveBeenCalledTimes(1)
      })

      it(`${engine}: leaves a turn the transcript closed, before the grace or after it`, async () => {
        const run = setup(engine)
        run.hooks.onTurnStop({ sessionId: 's1' }) // no normalizer at all
        const normalizer = engineState(false)
        put(map(run), normalizer)
        run.hooks.onTurnStop({ sessionId: 's1' })
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
        normalizer.turnOpen = true
        vi.mocked(run.deps.drain).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { normalizer.turnOpen = false })
        run.hooks.onTurnStop({ sessionId: 's1' })
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
        expect(run.deps.emit).not.toHaveBeenCalled()
      })

      it(`${engine}: reports a Stop hook that fails`, async () => {
        const error = vi.spyOn(console, 'error').mockImplementation(() => {})
        const run = setup(engine)
        put(map(run), engineState())
        vi.mocked(run.deps.drain).mockRejectedValueOnce(new Error('tail gone')).mockRejectedValueOnce('worse')
        run.hooks.onTurnStop({ sessionId: 's1' })
        run.hooks.onTurnStop({ sessionId: 's1' })
        await vi.advanceTimersByTimeAsync(0)
        expect(error.mock.calls.map((call) => call[1])).toEqual(['tail gone', 'worse'])
      })
    }

    for (const engine of ['copilot', 'agy'] as const) {
      it(`${engine}: says why a turn ended early, and aborts it`, async () => {
        const run = setup(engine)
        const normalizer = engineState()
        put(engine === 'copilot' ? run.normalizers.copilotNormalizers : run.normalizers.agyNormalizers, normalizer)
        run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
        expect(run.deps.announceTurnAborted).toHaveBeenCalledWith('s1', engine, expect.stringContaining('ended the turn early'))
        expect(run.deps.emit).toHaveBeenCalledWith('s1', ABORT)
      })
    }

    it('agy: a Stop that waits for sub-agents arms the backstop and closes nothing; any other clears it', async () => {
      const run = setup('agy')
      put(run.normalizers.agyNormalizers, engineState())
      run.hooks.onTurnStop({ sessionId: 's1', status: 'waiting' })
      expect(run.deps.armAgyIdleWatch).toHaveBeenCalledWith('s1')
      expect(run.deps.drain).not.toHaveBeenCalled()
      vi.spyOn(console, 'log').mockImplementation(() => {})
      run.hooks.onTurnStop({ sessionId: 's1' })
      expect(run.deps.clearAgyIdleWatch).toHaveBeenCalledWith('s1')
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
    })
  })

  describe('Devin', () => {
    it('closes an open turn after the grace, from its reader', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup('devin')
      const reader = engineState()
      put(run.normalizers.devinReaders, reader)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(reader.closeTurn).toHaveBeenCalled()
      expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
      expect(String(log.mock.calls[0][0])).toContain('force-closed by Stop hook')
    })

    it('leaves a turn that is closed, or closes during the grace, and survives no reader', async () => {
      const run = setup('devin')
      run.hooks.onTurnStop({ sessionId: 's1' })
      const reader = engineState(false)
      put(run.normalizers.devinReaders, reader)
      run.hooks.onTurnStop({ sessionId: 's1' })
      reader.turnOpen = true
      run.hooks.onTurnStop({ sessionId: 's1' })
      reader.turnOpen = false
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(run.deps.emit).not.toHaveBeenCalled()
    })

    it('reports a Stop hook that fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = setup('devin')
      const broken = { get turnOpen(): boolean { throw new Error('store gone') } }
      put(run.normalizers.devinReaders, broken)
      run.hooks.onTurnStop({ sessionId: 's1' })
      const worse = { get turnOpen(): boolean { throw 'worse' } }
      put(run.normalizers.devinReaders, worse)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(0)
      expect(error.mock.calls).toEqual([['[hooks] devin stop hook failed:', 'store gone'], ['[hooks] devin stop hook failed:', 'worse']])
    })
  })

  describe('Grok', () => {
    it('announces and aborts a turn that ended in error, and leaves a clean stop to the transcript', async () => {
      const run = setup('grok')
      const normalizer = engineState()
      put(run.normalizers.grokNormalizers, normalizer)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.emit).not.toHaveBeenCalled()
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.announceTurnAborted).toHaveBeenCalledWith('s1', 'grok', 'Grok ended the turn with an error')
      expect(run.deps.emit).toHaveBeenCalledWith('s1', ABORT)
      run.normalizers.grokNormalizers.delete('s1')
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.emit).toHaveBeenLastCalledWith('s1', [])
    })

    it('reports a StopFailure hook that fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = setup('grok')
      vi.mocked(run.deps.drain).mockRejectedValueOnce(new Error('tail gone')).mockRejectedValueOnce('worse')
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(error.mock.calls).toEqual([['[hooks] grok StopFailure hook failed:', 'tail gone'], ['[hooks] grok StopFailure hook failed:', 'worse']])
    })
  })

  describe('Cursor', () => {
    it('closes the turn once its sub-agent hooks and transcript are in, then clears its pending tasks', async () => {
      const run = setup('cursor')
      const normalizer = engineState()
      put(run.normalizers.cursorNormalizers, normalizer)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.cursorTaskHooks.wait).toHaveBeenCalledWith('s1')
      expect(run.deps.cursorSubagents.closeParent).toHaveBeenCalledWith('s1', false)
      expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
      expect(run.deps.announceTurnAborted).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(2_500)
      expect(removePendingCursorTasks).toHaveBeenCalledWith('/data', 's1')
    })

    it('announces a turn that failed before writing anything, and leaves a session with no normalizer', async () => {
      const run = setup('cursor')
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.emit).not.toHaveBeenCalled()
      const silent = { ...engineState(false), closeTurn: vi.fn(() => []) }
      put(run.normalizers.cursorNormalizers, silent)
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.cursorSubagents.closeParent).toHaveBeenCalledWith('s1', true)
      expect(run.deps.announceTurnAborted).toHaveBeenCalledWith('s1', 'cursor', expect.stringContaining('before producing any output'))
    })

    it('reports a stop hook that fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = setup('cursor')
      vi.mocked(run.deps.cursorTaskHooks.wait).mockRejectedValueOnce(new Error('queue gone')).mockRejectedValueOnce('worse')
      run.hooks.onTurnStop({ sessionId: 's1' })
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(0)
      expect(error.mock.calls).toEqual([['[cursor] stop hook failed:', 'queue gone'], ['[cursor] stop hook failed:', 'worse']])
    })
  })

  it('Claude Code: reports a stop hook that fails', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const run = setup('claude')
    vi.mocked(run.deps.drain).mockRejectedValueOnce(new Error('tail gone')).mockRejectedValueOnce('worse')
    run.hooks.onTurnStop({ sessionId: 's1' })
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(error.mock.calls).toEqual([['[hooks] claude stop hook failed:', 'tail gone'], ['[hooks] claude stop hook failed:', 'worse']])
  })
})

it.each([
  ['cursor', 'tasks'], ['cursor', 'drain1'], ['commandcode', 'drain1'], ['commandcode', 'grace'], ['commandcode', 'drain2'],
  ['copilot', 'drain1'], ['copilot', 'grace'], ['copilot', 'drain2'], ['agy', 'drain1'], ['agy', 'grace'], ['agy', 'drain2'],
  ['devin', 'grace'], ['grok', 'drain1'], ['claude', 'drain1'], ['claude', 'grace'], ['claude', 'drain2'],
])('retains %s Stop intent when evidence changes during %s', async (engine, phase) => {
  vi.useFakeTimers()
  const row = { agentId: 'a1', sessionId: 's1', engine, evidenceRevision: 0 } as RegisteredSession
  const holdStop = vi.fn(() => true), run = setup(engine, { resolve: () => row, holdStop })
  const state = engineState()
  const maps = { cursor: run.normalizers.cursorNormalizers, commandcode: run.normalizers.commandcodeNormalizers,
    copilot: run.normalizers.copilotNormalizers, agy: run.normalizers.agyNormalizers,
    devin: run.normalizers.devinReaders, grok: run.normalizers.grokNormalizers }
  if (engine === 'claude') setState(run, { turnOpen: true, pendingTools: new Set(), toolIdToName: new Map(), thinkingCounter: 0 })
  else (maps[engine as keyof typeof maps] as Map<string, unknown>).set('s1', state)
  let release!: () => void
  const pending = () => new Promise<void>(resolve => { release = resolve })
  if (phase === 'tasks') vi.mocked(run.deps.cursorTaskHooks.wait).mockImplementationOnce(pending)
  else if (phase === 'drain1') vi.mocked(run.deps.drain).mockImplementationOnce(pending)
  else if (phase === 'drain2') vi.mocked(run.deps.drain).mockResolvedValueOnce(undefined).mockImplementationOnce(pending)
  run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
  await vi.advanceTimersByTimeAsync(phase === 'drain2' ? STOP_HOOK_GRACE_MS : 0)
  row.evidenceRevision = 2 // A full hold and recovery can finish before the old callback resumes.
  if (phase === 'grace') await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
  else { release(); await vi.advanceTimersByTimeAsync(0) }
  expect(holdStop).toHaveBeenCalledWith(row, true)
  expect(state.closeTurn).not.toHaveBeenCalled()
  expect(state.abortTurn).not.toHaveBeenCalled()
  expect(run.deps.emit).not.toHaveBeenCalled()
  expect(run.deps.announceTurnAborted).not.toHaveBeenCalled()
  expect(run.deps.cursorSubagents.closeParent).not.toHaveBeenCalled()
  vi.useRealTimers()
})

it.each(['cursor', 'commandcode', 'copilot', 'agy', 'devin', 'grok'])('holds %s completion eagerly before any optional drain', engine => {
  const row = { agentId: 'a1', sessionId: 's1', engine, interpretationHold: 'pending' } as RegisteredSession
  const holdStop = vi.fn(() => true), run = setup(engine, { resolve: () => row, holdStop })
  run.hooks.onTurnStop({ sessionId: 's1' })
  expect(holdStop).toHaveBeenCalledOnce()
  expect(run.deps.drain).not.toHaveBeenCalled()
  expect(run.deps.emit).not.toHaveBeenCalled()
})

it.each([[false, 500], [true, undefined], [true, 500], [true, 2_000]] as const)(
  'suppresses a held Claude Stop only with positive newer prompt evidence (prompt=%s, Stop=%s)', (prompt, firedAt) => {
    const row = { agentId: 'a1', sessionId: 's1', engine: 'claude', interpretationHold: 'pending' } as RegisteredSession
    const holdStop = vi.fn(() => true), run = setup('claude', { resolve: () => row, holdStop })
    if (prompt) run.hooks.onPromptHook('s1', 1_000)
    run.hooks.onTurnStop({ sessionId: 's1', firedAt })
    expect(holdStop).toHaveBeenCalledTimes(prompt && firedAt === 500 ? 0 : 1)
    expect(run.deps.drain).not.toHaveBeenCalled()
    expect(run.deps.emit).not.toHaveBeenCalled()
  },
)

it('rejects delayed engine emissions after its binding changes, even if the hold port rejects stale work', () => {
  let context!: HookTurnContext
  const spy = vi.spyOn(engineHooks.claude, 'onStop').mockImplementationOnce(value => { context = value })
  try {
    const row = { agentId: 'a1', sessionId: 's1', engine: 'claude', evidenceRevision: 0 } as RegisteredSession
    const holdStop = vi.fn(() => false), run = setup('claude', { resolve: () => row, holdStop })
    run.hooks.onTurnStop({ sessionId: 's1' })
    row.evidenceRevision = 2
    context.emit('s1', [{ type: 'turn_ended', payload: {} }])
    expect(holdStop).toHaveBeenCalledWith(row, true)
    expect(run.deps.emit).not.toHaveBeenCalled()
  } finally { spy.mockRestore() }
})

it.each([
  ['cursor', 'error'], ['commandcode', undefined], ['devin', undefined], ['grok', 'error'],
  ['copilot', 'error'], ['copilot', undefined], ['agy', 'error'], ['agy', undefined],
])('retains successful native %s completion (status=%s) without waiting for a reader', async (engine, status) => {
  vi.useFakeTimers()
  try {
    const afterStop = vi.fn(), run = setup(engine!, { afterStop }), state = engineState()
    const maps = { cursor: run.normalizers.cursorNormalizers, commandcode: run.normalizers.commandcodeNormalizers,
      devin: run.normalizers.devinReaders, grok: run.normalizers.grokNormalizers,
      copilot: run.normalizers.copilotNormalizers, agy: run.normalizers.agyNormalizers }
    ;(maps[engine as keyof typeof maps] as Map<string, unknown>).set('s1', state)
    run.hooks.onTurnStop({ sessionId: 's1', status })
    await vi.runAllTimersAsync()
    expect(afterStop).toHaveBeenCalledOnce()
    expect(afterStop).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', engine }))
    expect(state.turnOpen).toBe(false)
  } finally { vi.useRealTimers() }
})
