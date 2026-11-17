import type { LiveParser, LiveTurn } from '../../engines/facets/live.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnState } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createSessionNormalizers } from '../transcripts/normalizers.js'
import { noOtherStreams } from '../../testing/otherStreams.js'
import { createTurnHooks, HOOKS_KEPT, STOP_HOOK_GRACE_MS, type TurnHookDeps } from './turnHooks.js'
import { engineHooks } from '../../engines/hooks.js'
import type { HookTurnContext } from '../../engines/facets/hooks.js'
import type { LiveEvent } from '../../engines/kit/events.js'

const END: LiveEvent[] = [{ type: 'turn_ended', payload: {} }]
const ABORT: LiveEvent[] = [{ type: 'turn_ended', payload: { aborted: true } }]

/** Another engine's parser, in its worker, with the turn calls the hooks make of its stream (core/engines/otherStreams.ts). */
const engineState = (turnOpen = true) => {
  const state = {
    turnOpen,
    openTurn: vi.fn(() => [{ type: 'turn_started', payload: { userMessage: '' } }]),
    closeTurn: vi.fn(() => { state.turnOpen = false; return END }),
    abortTurn: vi.fn(() => { state.turnOpen = false; return ABORT }),
  }
  return state
}

function setup(engine: string, over: Partial<TurnHookDeps> = {}) {
  const normalizers = createSessionNormalizers(noOtherStreams())
  const states = new Map<string, ReturnType<typeof engineState>>()
  const others = {
    get: (id: string) => states.get(id) as never,
    close: vi.fn(async (id: string, how: { abort?: boolean }) => {
      const state = states.get(id)
      return state ? how.abort ? state.abortTurn() : state.closeTurn() : []
    }),
    openTurn: vi.fn(async (id: string) => states.get(id)?.openTurn() ?? []),
    task: vi.fn(),
  }
  const deps: TurnHookDeps = {
    resolve: (id) => id === 's1' ? ({ agentId: 'a1', sessionId: 's1', engine } as RegisteredSession) : undefined,
    normalizers,
    others: others as unknown as TurnHookDeps['others'],
    emit: vi.fn(),
    drain: vi.fn(async () => {}),
    announceTurnAborted: vi.fn(),
    armAgyIdleWatch: vi.fn(),
    clearAgyIdleWatch: vi.fn(),
    mirror: { noteEngineStopped: vi.fn() },
    ...over,
  }
  return { deps, normalizers, others, states, hooks: createTurnHooks(deps) }
}

// Existing hook scenarios control transcript arrival without exposing mutable state through the port.
let generation = 0
function parserOf(state: TurnState & { openedAt?: number }): LiveParser {
  const identity = ++generation
  return {
    engine: 'claude',
    get turnOpen() { return state.turnOpen },
    snapshot: () => ({ identity: `${identity}:${state.opened ?? 0}`, turnOpen: state.turnOpen, continued: state.continued === true,
      ...(state.openedAt === undefined ? {} : { openedAt: state.openedAt }) }),
    closeTurn: () => { state.turnOpen = false; state.pendingTools.clear() },
    ingest: () => ({ events: [] }),
    windowStart: () => {},
  }
}
const setState = (run: ReturnType<typeof setup>, state: TurnState) => run.normalizers.liveParsers.set('s1', parserOf(state))

const put = (run: ReturnType<typeof setup>, state: unknown) => run.states.set('s1', state as ReturnType<typeof engineState>)

describe('turn hooks', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  it('opens Command Code\'s turn on its first tool call, in its worker, and nothing else\'s', async () => {
    const cc = setup('commandcode')
    const normalizer = engineState(false)
    cc.hooks.onTurnStart({ sessionId: 's1' })
    put(cc, normalizer)
    cc.hooks.onTurnStart({ sessionId: 's1' })
    cc.hooks.onTurnStart({ sessionId: 'nobody' })
    setup('claude').hooks.onTurnStart({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(cc.deps.emit).toHaveBeenCalledTimes(1)
    expect(cc.deps.emit).toHaveBeenCalledWith('s1', normalizer.openTurn.mock.results[0].value)
    // One that opened nothing says nothing.
    normalizer.openTurn.mockReturnValueOnce([])
    cc.hooks.onTurnStart({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(cc.deps.emit).toHaveBeenCalledTimes(1)
  })

  it('hands a Cursor Task tool start to its stream, which follows the sub-agent', () => {
    const { others, hooks } = setup('cursor')
    hooks.onToolStart({ sessionId: 's1', toolUseId: 't1', toolName: 'Task', input: { prompt: 'x' } })
    hooks.onToolStart({ sessionId: 's1', toolUseId: 't2', toolName: 'Read', input: {} })
    setup('claude').hooks.onToolStart({ sessionId: 's1', toolUseId: 't3', toolName: 'Task', input: {} })
    expect(others.task).toHaveBeenCalledTimes(1)
    expect(others.task).toHaveBeenCalledWith('s1', 't1', { prompt: 'x' })
  })

  it('does nothing for a Stop from a session it does not know, or an engine with no Stop rule', async () => {
    const unknown = setup('claude')
    unknown.hooks.onTurnStop({ sessionId: 'nobody' })
    const pi = setup('pi')
    pi.hooks.onTurnStop({ sessionId: 's1' })
    await vi.runAllTimersAsync()
    expect(unknown.deps.drain).not.toHaveBeenCalled()
    expect(pi.deps.drain).not.toHaveBeenCalled()
  })

  it('contains a synchronous engine failure and still handles another engine', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(engineHooks.claude, 'onStop').mockImplementationOnce(() => { throw new Error('engine failed') })
    expect(() => setup('claude').hooks.onTurnStop({ sessionId: 's1' })).not.toThrow()
    const other = setup('commandcode')
    const state = engineState()
    put(other, state)
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

    // The same-words end to end run under load (2026-11-10): a turn's Stop reached the daemon after the queued
    // next turn had been read opening but before that turn's prompt hook, so nothing said it was old, and it
    // force-closed the next turn 2.5 s in, losing its reply and the question open in it.
    it('closes nothing with a Stop its engine ran before the open turn opened, a failure included', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = setup('claude')
      run.hooks.onPromptHook('s1', 500)
      const state = { turnOpen: true, opened: 2, openedAt: 2_000, pendingTools: new Map() } as unknown as TurnState & { openedAt: number }
      setState(run, state)
      for (const status of [undefined, 'error']) {
        run.hooks.onTurnStop({ sessionId: 's1', status, firedAt: 1_000 })
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      }
      expect(state.turnOpen).toBe(true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(log.mock.calls.map(call => String(call[0]))).toEqual([
        '[turn] s1 Stop ran before the open turn opened: left open',
        '[turn] s1 StopFailure ran before the open turn opened: left open'])
      log.mockClear()
      // Nor one read opening in the drain after the Stop ran, or once its grace is over.
      state.turnOpen = false
      vi.mocked(run.deps.drain).mockImplementationOnce(async () => { state.turnOpen = true; state.openedAt = 4_000 })
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error', firedAt: 3_000 })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      state.openedAt = 2_000
      vi.mocked(run.deps.drain).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => { state.opened = 3; state.openedAt = 4_000 })
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error', firedAt: 3_000 })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(state.turnOpen).toBe(true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(log.mock.calls.map(call => String(call[0]))).toEqual(Array(2).fill('[turn] s1 StopFailure ran before the open turn opened: left open'))
      // Run after the turn opened: about it, and closed once the grace is over, as before.
      log.mockClear()
      run.hooks.onTurnStop({ sessionId: 's1', firedAt: 5_000 })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(state.turnOpen).toBe(false)
      expect(String(log.mock.calls[0][0])).toContain('force-closed by Stop hook')
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

      it(`${engine}: drains, waits the grace, then closes what is still open`, async () => {
        const log = vi.spyOn(console, 'log').mockImplementation(() => {})
        const run = setup(engine)
        const normalizer = engineState()
        put(run, normalizer)
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
        put(run, normalizer)
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
        put(run, engineState())
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
        put(run, normalizer)
        run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
        expect(run.deps.announceTurnAborted).toHaveBeenCalledWith('s1', engine, expect.stringContaining('ended the turn early'))
        expect(run.deps.emit).toHaveBeenCalledWith('s1', ABORT)
      })
    }

    it('agy: a Stop that waits for sub-agents arms the backstop and closes nothing; any other clears it', async () => {
      const run = setup('agy')
      put(run, engineState())
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
      put(run, reader)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
      expect(reader.closeTurn).toHaveBeenCalled()
      expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
      expect(String(log.mock.calls[0][0])).toContain('closed by its devin Stop hook (after grace)')
    })

    it('leaves a turn that is closed, or closes during the grace, and survives no reader', async () => {
      const run = setup('devin')
      run.hooks.onTurnStop({ sessionId: 's1' })
      const reader = engineState(false)
      put(run, reader)
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
      put(run, broken)
      run.hooks.onTurnStop({ sessionId: 's1' })
      const worse = { get turnOpen(): boolean { throw 'worse' } }
      put(run, worse)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(0)
      expect(error.mock.calls).toEqual([['[hooks] devin stop hook failed:', 'store gone'], ['[hooks] devin stop hook failed:', 'worse']])
    })
  })

  describe('Grok', () => {
    it('announces and aborts a turn that ended in error, and leaves a clean stop to the transcript', async () => {
      const run = setup('grok')
      const normalizer = engineState()
      put(run, normalizer)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.emit).not.toHaveBeenCalled()
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.announceTurnAborted).toHaveBeenCalledWith('s1', 'grok', 'Grok ended the turn with an error')
      expect(run.deps.emit).toHaveBeenCalledWith('s1', ABORT)
      // With no stream there is nothing of it to close.
      run.states.delete('s1')
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.emit).toHaveBeenCalledTimes(1)
    })

    it('reports a StopFailure hook that fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = setup('grok')
      vi.mocked(run.deps.drain).mockRejectedValueOnce(new Error('tail gone')).mockRejectedValueOnce('worse')
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(error.mock.calls).toEqual([['[hooks] grok stop hook failed:', 'tail gone'], ['[hooks] grok stop hook failed:', 'worse']])
    })
  })

  describe('Cursor', () => {
    it('closes the turn once its transcript is in, in its worker, which ends its sub-agents and its queued Tasks', async () => {
      const run = setup('cursor')
      const normalizer = engineState()
      put(run, normalizer)
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.drain).toHaveBeenCalledWith('s1')
      expect(run.others.close).toHaveBeenCalledWith('s1', { abort: false, error: false, stop: true })
      expect(run.deps.emit).toHaveBeenCalledWith('s1', END)
      expect(run.deps.announceTurnAborted).not.toHaveBeenCalled()
    })

    it('announces a turn that failed before writing anything, and leaves a session with no normalizer', async () => {
      const run = setup('cursor')
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.emit).not.toHaveBeenCalled()
      const silent = { ...engineState(false), closeTurn: vi.fn(() => []) }
      put(run, silent)
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.others.close).toHaveBeenCalledWith('s1', { abort: false, error: true, stop: true })
      expect(run.deps.announceTurnAborted).toHaveBeenCalledWith('s1', 'cursor', expect.stringContaining('before producing any output'))
    })

    it('reports a stop hook that fails', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      const run = setup('cursor')
      vi.mocked(run.deps.drain).mockRejectedValueOnce(new Error('queue gone')).mockRejectedValueOnce('worse')
      run.hooks.onTurnStop({ sessionId: 's1' })
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(0)
      expect(error.mock.calls).toEqual([['[hooks] cursor stop hook failed:', 'queue gone'], ['[hooks] cursor stop hook failed:', 'worse']])
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

const START: LiveEvent[] = [{ type: 'turn_started', payload: { userMessage: 'next' } }]
const TEXT: LiveEvent[] = [{ type: 'text_delta', payload: { content: 'done' } }]
const TOOL_START: LiveEvent[] = [{ type: 'tool_start', payload: { id: 'tool', tool: 'Read', input: {} } }]
/** A turn as the parser shows it once it has read its end. */
const turnOf = (identity: string, openedAt?: number): LiveTurn =>
  ({ identity, turnOpen: false, continued: false, ...(openedAt === undefined ? {} : { openedAt }) })

describe.each(['claude', 'codex'] as const)('%s: turns end by hook', (engine) => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

  /** A session whose engine has sent one Stop in this daemon run, with nothing emitted since. */
  const hookDriven = async () => {
    const run = setup(engine)
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    vi.mocked(run.deps.emit).mockClear()
    return run
  }
  /** The parser's turn, open, as its worker's handle shows it. */
  const parse = (run: ReturnType<typeof setup>, identity: string, openedAt?: number, continued = false) => {
    const turn = { ...turnOf(identity, openedAt), turnOpen: true, continued }
    run.normalizers.liveParsers.set('s1', { engine, get turnOpen() { return turn.turnOpen }, snapshot: () => ({ ...turn }),
      closeTurn: () => { turn.turnOpen = false } })
    return turn
  }
  /** The parser reads the turn's end. */
  const end = (run: ReturnType<typeof setup>, turn: ReturnType<typeof parse>) => {
    turn.turnOpen = false
    run.hooks.transcript('s1', END, { turn: { ...turn } })
  }

  it('an engine that has sent no Stop (one older than the event, or its first turn): every read goes on as it came, the same array', () => {
    const { deps, hooks } = setup(engine)
    hooks.transcript('s1', END, { turn: turnOf('t1') })
    hooks.transcript('s1', TEXT, { replay: true })
    expect(vi.mocked(deps.emit).mock.calls).toEqual([['s1', END], ['s1', TEXT, { replay: true }]])
    expect(vi.mocked(deps.emit).mock.calls[0][1]).toBe(END)
    expect(hooks.held('s1')).toBe(false)
    // A prompt hook alone proves nothing about the Stop.
    hooks.onPromptHook('s1', 1_000)
    hooks.transcript('s1', END, { turn: turnOf('t1') })
    expect(deps.emit).toHaveBeenLastCalledWith('s1', END)
  })

  it('a normal turn: its end is read and held, the turn reads open, and its Stop delivers it once', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', [...TEXT, ...END], { turn: turnOf('t1') })
    expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', TEXT]])
    expect(run.hooks.held('s1')).toBe(true)
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.emit).toHaveBeenLastCalledWith('s1', END)
    expect(run.hooks.held('s1')).toBe(false)
    // Text or a tool read after it goes on, and its turn stays closed.
    run.hooks.transcript('s1', TOOL_START, {})
    expect(run.deps.emit).toHaveBeenLastCalledWith('s1', TOOL_START)
    expect(run.deps.emit).toHaveBeenCalledTimes(3)
  })

  it('the turn reads open while text goes on before its held end, and closed as that end goes on', async () => {
    const run = await hookDriven()
    const open: boolean[] = []
    vi.mocked(run.deps.emit).mockImplementation(() => { open.push(run.hooks.held('s1')) })
    run.hooks.transcript('s1', [...TEXT, ...END], { turn: turnOf('t1') })
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(open).toEqual([true, false])
  })

  // The Stop hook beats the transcript's final text by about 200 ms (lib/commander.ts).
  it('final text after Stop: the Stop waits for the end and delivers it the moment it is read, not at 1.5 s', async () => {
    const run = await hookDriven()
    const turn = parse(run, 't1')
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(200)
    end(run, turn)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(run.deps.emit).toHaveBeenCalledTimes(1)
  })

  it('no end within 1.5 s: the Stop closes the turn itself, as before, unless the drain after it reads the end', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = await hookDriven()
    const turn = parse(run, 't1')
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS - 1)
    expect(run.deps.emit).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(turn.turnOpen).toBe(false)
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    expect(log.mock.calls.map(call => String(call[0]))).toEqual(['[turn] s1 force-closed by Stop hook (after grace)'])
    const next = parse(run, 't2')
    vi.mocked(run.deps.drain).mockImplementationOnce(async () => {}).mockImplementationOnce(async () => end(run, next))
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(run.deps.emit).toHaveBeenCalledTimes(2)
    expect(run.hooks.held('s1')).toBe(false)
    expect(log).toHaveBeenCalledTimes(1)
  })

  it('a next prompt read while an end is held: the held end, then the start, in one batch', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    run.hooks.transcript('s1', START, { turn: turnOf('t2') })
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', [...END, ...START])
    expect(run.hooks.held('s1')).toBe(false)
    // A start with nothing held goes on as it came.
    run.hooks.transcript('s1', START, { turn: turnOf('t3') })
    expect(run.deps.emit).toHaveBeenLastCalledWith('s1', START)
  })

  it('an aborted end, and an end the engine marked over, are never held', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', ABORT, { turn: turnOf('t1') })
    run.hooks.transcript('s1', END, { turn: turnOf('t2'), over: true })
    expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', ABORT], ['s1', END]])
    expect(run.hooks.held('s1')).toBe(false)
  })

  it('a replay goes on untouched; one with a turn\'s start or end drops what was held', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    run.hooks.transcript('s1', TEXT, { replay: true })
    expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', TEXT, { replay: true }]])
    expect(vi.mocked(run.deps.emit).mock.calls[0][1]).toBe(TEXT)
    expect(run.hooks.held('s1')).toBe(true)
    // The transcript was read again: what it says of its turns is the latest word.
    const again = [...START, ...END]
    run.hooks.transcript('s1', again, { replay: true })
    expect(run.deps.emit).toHaveBeenLastCalledWith('s1', again, { replay: true })
    expect(run.hooks.held('s1')).toBe(false)
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
    expect(run.deps.emit).toHaveBeenCalledTimes(2)
  })

  it('a stale Stop, run before the latest prompt hook, delivers and closes nothing', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    run.hooks.onPromptHook('s1', 2_000)
    for (const status of [undefined, 'error']) run.hooks.onTurnStop({ sessionId: 's1', status, firedAt: 1_000 })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
    expect(run.deps.emit).not.toHaveBeenCalled()
    expect(run.hooks.held('s1')).toBe(true)
  })

  it('a stale Stop is not held for a binding being checked; one with no prompt hook before it, or a newer one, is', () => {
    const row = { agentId: 'a1', sessionId: 's1', engine, identityHold: 'pending' } as RegisteredSession
    const holdStop = vi.fn(() => true), run = setup(engine, { resolve: () => row, holdStop })
    run.hooks.onTurnStop({ sessionId: 's1', firedAt: 500 })
    expect(holdStop).toHaveBeenCalledOnce()
    run.hooks.onPromptHook('s1', 2_000)
    run.hooks.onTurnStop({ sessionId: 's1', firedAt: 1_000 })
    expect(holdStop).toHaveBeenCalledOnce()
    run.hooks.onTurnStop({ sessionId: 's1', firedAt: 3_000 })
    expect(holdStop).toHaveBeenCalledTimes(2)
  })

  it('a Stop waiting for the end is told at once when one is held, and has none to wait for with no record', async () => {
    let context!: HookTurnContext
    vi.spyOn(engineHooks[engine], 'onStop').mockImplementationOnce(value => { context = value })
    const run = setup(engine)
    run.hooks.onTurnStop({ sessionId: 's1' })
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    await expect(context.heldEndWithin('s1', STOP_HOOK_GRACE_MS)).resolves.toBe(true)
    await expect(context.heldEndWithin('nobody', STOP_HOOK_GRACE_MS)).resolves.toBe(false)
  })

  // Review Focus 5: Codex's turn had no opening time, so a Stop that arrived after the next turn's start was read
  // and before its prompt hook could close that next turn.
  it('a Stop run before the turn opened delivers and closes nothing', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1', 2_000) })
    run.hooks.onTurnStop({ sessionId: 's1', status: 'error', firedAt: 1_000 })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
    expect(run.deps.emit).not.toHaveBeenCalled()
    expect(run.hooks.held('s1')).toBe(true)
    // The next turn is read opening, which sends the held end, and then the last turn's Stop comes.
    const next = parse(run, 't2', 4_000)
    run.hooks.transcript('s1', START, { turn: { ...next } })
    run.hooks.onTurnStop({ sessionId: 's1', firedAt: 3_000 })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', [...END, ...START])
    expect(next.turnOpen).toBe(true)
  })

  // A /goal loop: the Stop of the pass before reached the daemon 520 ms after the next pass began (end to end, under
  // load). The pass opened after that Stop ran, so it is left open; its own Stop closes it.
  it.runIf(engine === 'claude')('a continued /goal pass is closed by its own Stop', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = await hookDriven()
    const pass = parse(run, 't1', 2_000, true)
    run.hooks.onTurnStop({ sessionId: 's1', firedAt: 1_000 })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
    expect(pass.turnOpen).toBe(true)
    run.hooks.onTurnStop({ sessionId: 's1', firedAt: 3_000 })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(pass.turnOpen).toBe(false)
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    // Its end read before its Stop: held, and delivered by it.
    const next = parse(run, 't2', undefined, true)
    end(run, next)
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.emit).toHaveBeenCalledTimes(2)
  })

  it('StopFailure closes whichever turn is open or held', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    // Open as it arrives, and the next one opened in the drain: that one is closed.
    parse(run, 't2')
    let next!: ReturnType<typeof parse>
    vi.mocked(run.deps.drain).mockImplementationOnce(async () => { next = parse(run, 't3') })
    run.hooks.onTurnStop({ sessionId: 's1', status: 'error' })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS)
    expect(next.turnOpen).toBe(false)
    expect(run.deps.emit).toHaveBeenCalledTimes(2)
  })

  it('a Stop heard twice, or two at once, ends the turn once', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    run.hooks.onTurnStop({ sessionId: 's1' })
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    // Two waiting for the end when it is read.
    const turn = parse(run, 't2')
    run.hooks.onTurnStop({ sessionId: 's1' })
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(200)
    end(run, turn)
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
    expect(run.deps.emit).toHaveBeenCalledTimes(2)
    expect(run.hooks.held('s1')).toBe(false)
  })

  it('a cancel drops the held end unsent, a forgotten session\'s record is gone, and a Stop then waiting sends nothing', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    run.hooks.closed('s1')
    run.hooks.closed('never-seen')
    expect(run.hooks.held('s1')).toBe(false)
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
    expect(run.deps.emit).not.toHaveBeenCalled()
    // A Stop waits for the end, and the session is forgotten meanwhile.
    parse(run, 't2')
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(200)
    run.hooks.forget('s1')
    run.normalizers.forget('s1')
    await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
    expect(run.deps.emit).not.toHaveBeenCalled()
    // Its record is gone: a read goes on as it came.
    expect(run.hooks.withheld('s1')).toBe(false)
    run.hooks.transcript('s1', END, { turn: turnOf('t3') })
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
  })

  it('the 513th session\'s record takes the oldest one\'s place, whose held end is delivered first', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    for (let i = 1; i < HOOKS_KEPT; i++) run.hooks.onPromptHook(`other${i}`, 1)
    expect(run.deps.emit).not.toHaveBeenCalled()
    run.hooks.onPromptHook('last', 1)
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    expect(run.hooks.held('s1')).toBe(false)
    expect(run.hooks.withheld('s1')).toBe(false)
  })

  it('withheld: its turns end by hook, none is open and none is held', async () => {
    expect(setup(engine).hooks.withheld('s1')).toBe(false)
    const run = await hookDriven()
    expect(run.hooks.withheld('s1')).toBe(true)
    const turn = parse(run, 't1')
    expect(run.hooks.withheld('s1')).toBe(false)
    end(run, turn)
    expect(run.hooks.withheld('s1')).toBe(false)
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.hooks.withheld('s1')).toBe(true)
  })
})

it.each([
  ['cursor', 'drain1'], ['commandcode', 'drain1'], ['commandcode', 'grace'], ['commandcode', 'drain2'],
  ['copilot', 'drain1'], ['copilot', 'grace'], ['copilot', 'drain2'], ['agy', 'drain1'], ['agy', 'grace'], ['agy', 'drain2'],
  ['devin', 'grace'], ['grok', 'drain1'], ['claude', 'drain1'], ['claude', 'grace'], ['claude', 'drain2'],
])('retains %s Stop intent when evidence changes during %s', async (engine, phase) => {
  vi.useFakeTimers()
  const row = { agentId: 'a1', sessionId: 's1', engine, evidenceRevision: 0 } as RegisteredSession
  const holdStop = vi.fn(() => true), run = setup(engine, { resolve: () => row, holdStop })
  const state = engineState()
  if (engine === 'claude') setState(run, { turnOpen: true, pendingTools: new Set(), toolIdToName: new Map(), thinkingCounter: 0 })
  else put(run, state)
  let release!: () => void
  const pending = () => new Promise<void>(resolve => { release = resolve })
  if (phase === 'drain1') vi.mocked(run.deps.drain).mockImplementationOnce(pending)
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
  expect(run.others.close).not.toHaveBeenCalled()
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

it('rejects delayed engine emissions after its binding changes, even if the hold port rejects stale work', () => {
  let context!: HookTurnContext
  const spy = vi.spyOn(engineHooks.claude, 'onStop').mockImplementationOnce(value => { context = value })
  try {
    const row = { agentId: 'a1', sessionId: 's1', engine: 'claude', evidenceRevision: 0 } as RegisteredSession
    const holdStop = vi.fn(() => false), run = setup('claude', { resolve: () => row, holdStop })
    run.hooks.onTurnStop({ sessionId: 's1' })
    run.hooks.transcript('s1', END, { turn: { identity: 't1', turnOpen: false, continued: false } })
    row.evidenceRevision = 2
    context.emit('s1', [{ type: 'turn_ended', payload: {} }])
    expect(context.deliverHeldEnd('s1')).toBe(false)
    expect(holdStop).toHaveBeenCalledWith(row, true)
    expect(run.deps.emit).not.toHaveBeenCalled()
    expect(run.hooks.held('s1')).toBe(true)
  } finally { spy.mockRestore() }
})

it.each([
  ['cursor', 'error'], ['commandcode', undefined], ['devin', undefined], ['grok', 'error'],
  ['copilot', 'error'], ['copilot', undefined], ['agy', 'error'], ['agy', undefined],
])('retains successful native %s completion (status=%s) without waiting for a reader', async (engine, status) => {
  vi.useFakeTimers()
  try {
    const afterStop = vi.fn(), run = setup(engine!, { afterStop }), state = engineState()
    put(run, state)
    run.hooks.onTurnStop({ sessionId: 's1', status })
    await vi.runAllTimersAsync()
    expect(afterStop).toHaveBeenCalledOnce()
    expect(afterStop).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 's1', engine }))
    expect(state.turnOpen).toBe(false)
  } finally { vi.useRealTimers() }
})
