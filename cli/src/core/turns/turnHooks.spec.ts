import type { LiveParser, LiveTurn } from '../../engines/facets/live.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TurnState } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createSessionNormalizers } from '../transcripts/normalizers.js'
import { noOtherStreams } from '../../testing/otherStreams.js'
import { createTurnHooks, HOOK_SILENCE_MS, HOOKS_KEPT, STOP_HOOK_GRACE_MS, SUBAGENT_TIMEOUT_MS, SUBAGENTS_MAX, type TurnHookDeps } from './turnHooks.js'
import { engineHooks } from '../../engines/hooks.js'
import { live as codexLive } from '../../engines/codex/live.js'
import type { HookTurnContext } from '../../engines/facets/hooks.js'
import type { LiveEvent } from '../../engines/kit/events.js'
import { TurnActivity } from '../../lib/turnActivity.js'

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
    turnActivity: { withdraw: vi.fn() },
    tell: vi.fn(),
    awaitDialog: vi.fn(),
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
  // An end held for its Stop is Claude Code's: no Stop follows a Codex end, which goes on at once (R1.2).
  const stopRule = it.runIf(engine === 'claude')

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
    hooks.transcript('s1', START, { resumed: true })
    expect(vi.mocked(deps.emit).mock.calls).toEqual([['s1', END], ['s1', TEXT, { replay: true }], ['s1', START, { resumed: true }]])
    expect(vi.mocked(deps.emit).mock.calls[0][1]).toBe(END)
    expect(hooks.held('s1')).toBe(false)
    // A prompt hook alone proves nothing about the Stop.
    hooks.onPromptHook('s1', 1_000)
    hooks.transcript('s1', END, { turn: turnOf('t1') })
    expect(deps.emit).toHaveBeenLastCalledWith('s1', END)
  })

  stopRule('a normal turn: its end is read and held, the turn reads open, and its Stop delivers it once', async () => {
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

  stopRule('the turn reads open while text goes on before its held end, and closed as that end goes on', async () => {
    const run = await hookDriven()
    const open: boolean[] = []
    vi.mocked(run.deps.emit).mockImplementation(() => { open.push(run.hooks.held('s1')) })
    run.hooks.transcript('s1', [...TEXT, ...END], { turn: turnOf('t1') })
    run.hooks.onTurnStop({ sessionId: 's1' })
    await vi.advanceTimersByTimeAsync(0)
    expect(open).toEqual([true, false])
  })

  // The Stop hook beats the transcript's final text by about 200 ms (lib/commander.ts).
  stopRule('final text after Stop: the Stop waits for the end and delivers it the moment it is read, not at 1.5 s', async () => {
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

  stopRule('no end within 1.5 s: the Stop closes the turn itself, as before, unless the drain after it reads the end', async () => {
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

  stopRule('a next prompt read while an end is held: the held end, then the start, in one batch', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    run.hooks.transcript('s1', START, { turn: turnOf('t2') })
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', [...END, ...START])
    expect(run.hooks.held('s1')).toBe(false)
    // A start with nothing held goes on as it came.
    run.hooks.transcript('s1', START, { turn: turnOf('t3') })
    expect(run.deps.emit).toHaveBeenLastCalledWith('s1', START)
  })

  // An attach that read the transcript again (rewritten, or recovered) picks its open turn back up: before, its start
  // reached the funnel ahead of the end held, which then closed it.
  stopRule('a turn picked back up at attach while an end is held: the end, then the start, picked back up', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    run.hooks.transcript('s1', START, { resumed: true })
    expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', END], ['s1', START, { resumed: true }]])
    expect(run.hooks.held('s1')).toBe(false)
  })

  it('an aborted end, and an end the engine marked over, are never held', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', ABORT, { turn: turnOf('t1') })
    run.hooks.transcript('s1', END, { turn: turnOf('t2'), over: true })
    expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', ABORT], ['s1', END]])
    expect(run.hooks.held('s1')).toBe(false)
  })

  stopRule('a replay goes on untouched; one with a turn\'s start or end drops what was held', async () => {
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

  // A hook of the person's can block the next prompt: its prompt hook ran and no turn opened, so the end held is still
  // the one this Stop is about. Left held, the turn read as working for 2 minutes.
  stopRule('a Stop run before the latest prompt hook still delivers the end held for its turn, a failure too', async () => {
    for (const status of [undefined, 'error']) {
      const run = await hookDriven()
      run.hooks.transcript('s1', END, { turn: turnOf('t1', 500) })
      run.hooks.onPromptHook('s1', 2_000)
      run.hooks.onTurnStop({ sessionId: 's1', status, firedAt: 1_000 })
      await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
      expect(run.hooks.held('s1')).toBe(false)
    }
  })

  stopRule('a stale Stop is not held for a binding being checked; one with no prompt hook before it, or a newer one, is', () => {
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

  stopRule('a Stop that came before its turn\'s end lets that end go on as it is read, and no other', () => {
    let context!: HookTurnContext
    vi.spyOn(engineHooks.claude, 'onStop').mockImplementationOnce(value => { context = value })
    const run = setup(engine)
    run.hooks.onTurnStop({ sessionId: 's1' })
    context.awaitEnd('s1', 't1')
    context.awaitEnd('nobody', 't1')
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    // A read that names no turn, or another turn, is held for its own Stop.
    run.hooks.transcript('s1', END, {})
    run.hooks.transcript('s1', END, { turn: turnOf('t2') })
    expect(run.deps.emit).toHaveBeenCalledOnce()
    expect(run.hooks.held('s1')).toBe(true)
    expect(run.hooks.withheld('nobody')).toBe(false)
  })

  // Review Focus 5: Codex's turn had no opening time, so a Stop that arrived after the next turn's start was read
  // and before its prompt hook could close that next turn.
  stopRule('a Stop run before the turn opened delivers and closes nothing', async () => {
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

  stopRule('StopFailure closes whichever turn is open or held', async () => {
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

  stopRule('a Stop heard twice, or two at once, ends the turn once', async () => {
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

  stopRule('a cancel drops the held end unsent, a forgotten session\'s record is gone, and a Stop then waiting sends nothing', async () => {
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

  stopRule('the 513th session\'s record takes the oldest one\'s place, whose held end is delivered first', async () => {
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    for (let i = 1; i < HOOKS_KEPT; i++) run.hooks.onPromptHook(`other${i}`, 1)
    expect(run.deps.emit).not.toHaveBeenCalled()
    run.hooks.onPromptHook('last', 1)
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    expect(run.hooks.held('s1')).toBe(false)
    expect(run.hooks.withheld('s1')).toBe(false)
  })

  stopRule('withheld: its turns end by hook, none is open and none is held', async () => {
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

  // A Stop hook that failed to run would leave the turn open for ever (R6).
  stopRule('a missing Stop: the held end is delivered at the first beat 2 minutes after it was read, with one line', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = await hookDriven()
    vi.advanceTimersByTime(30_000)
    run.hooks.transcript('s1', END, { turn: turnOf('t1') })
    vi.advanceTimersByTime(HOOK_SILENCE_MS - 1); run.hooks.beat('s1')
    expect(run.deps.emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); run.hooks.beat('s1')
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    expect(run.hooks.held('s1')).toBe(false)
    run.hooks.beat('s1')
    expect(run.deps.emit).toHaveBeenCalledOnce()
    expect(log.mock.calls.map(call => String(call[0]))).toEqual(['[turn] s1 ended by its transcript · no Stop in 2 min'])
  })

  stopRule('a hook in between starts the 2 minutes again', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = await hookDriven()
    run.hooks.transcript('s1', END, { turn: turnOf('t1', 2_000) })
    vi.advanceTimersByTime(60_000)
    // A late Stop of an earlier turn: it delivers nothing, and the engine is still sending hooks.
    run.hooks.onTurnStop({ sessionId: 's1', firedAt: 1_000 })
    await vi.advanceTimersByTimeAsync(HOOK_SILENCE_MS - 1); run.hooks.beat('s1')
    expect(run.deps.emit).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1); run.hooks.beat('s1')
    expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
  })

  it('nothing held, or a session with no record: a beat does nothing', async () => {
    const run = await hookDriven()
    vi.advanceTimersByTime(HOOK_SILENCE_MS)
    run.hooks.beat('s1')
    run.hooks.beat('nobody')
    expect(run.deps.emit).not.toHaveBeenCalled()
  })

  // A wait on the person: a permission or a question (R4). Its dialog is drawn after the hook returns, so no pane is
  // read at it: the question watcher shows it at its next poll and says when it is over.
  describe('waits', () => {
    const SUBAGENT: LiveEvent[] = [{ type: 'tool_start', payload: { id: 'sub', tool: 'Read', input: {}, parentToolUseId: 'task' } },
      { type: 'subagent_finished', payload: { id: 'task', status: 'completed' } }]
    /** A session in its first turn (no Stop sent yet), with the work lease main.ts gives it: it reads the turn hooks. */
    const waiting = () => {
      let withheld = (_: string): boolean => false
      const lease = new TurnActivity({ runtime: id => id === 's1' ? { key: 'pane', turnOpen: true, withheld: withheld(id) } : undefined,
        probe: async () => 'unknown', drain: async () => {} })
      /** What every window was told, as the heartbeats tell it: the lease as it reads then (core/turns/heartbeats.ts). */
      const told: unknown[] = []
      const run = setup(engine, { turnActivity: lease, tell: vi.fn((id: string) => { told.push(lease.snapshot(id)?.state) }) })
      withheld = run.hooks.withheld
      lease.observe('s1', 'text_delta')
      return { ...run, lease, told }
    }

    it('a permission wait: Working is withdrawn and told at once, and the watcher is told a dialog is coming', () => {
      const run = waiting()
      expect(run.lease.snapshot('s1')!.state).toBe('working')
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      expect(run.told).toEqual(['unknown'])
      expect(run.deps.awaitDialog).toHaveBeenCalledExactlyOnceWith('s1')
      expect(run.hooks.withheld('s1')).toBe(true)
      // What is read while it waits claims no work.
      run.lease.observe('s1', 'tool_end')
      expect(run.lease.snapshot('s1')!.state).toBe('unknown')
    })

    // The transcript lags the engine: a record written before the hook ran can be read after it.
    it('the waited tool\'s own start, or its turn\'s, read later with an earlier time, does not end the wait', () => {
      const run = waiting()
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      run.hooks.transcript('s1', [...START, ...TOOL_START], { at: 4_900 })
      expect(run.hooks.withheld('s1')).toBe(true)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', [...START, ...TOOL_START])
    })

    it('progress written after the hook ends it', () => {
      const run = waiting()
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      run.hooks.transcript('s1', TEXT, { at: 5_001 })
      expect(run.hooks.withheld('s1')).toBe(false)
      run.lease.observe('s1', 'text_delta')
      expect(run.lease.snapshot('s1')!.state).toBe('working')
    })

    it('a read with no time ends nothing', () => {
      const run = waiting()
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      run.hooks.transcript('s1', [...TEXT, ...END], {})
      expect(run.hooks.withheld('s1')).toBe(true)
    })

    it('a subagent\'s progress never ends it', () => {
      const run = waiting()
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      run.hooks.transcript('s1', SUBAGENT, { at: 6_000 })
      expect(run.hooks.withheld('s1')).toBe(true)
    })

    // Review Focus 4: a dialog answered before any poll found it leaves the watcher's two clear polls to end the wait.
    it('the watcher ends it: a question closed, or two polls read the pane clear; a session with no record is left alone', () => {
      const run = waiting()
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      run.hooks.waitOver('s1')
      run.hooks.waitOver('nobody')
      expect(run.hooks.withheld('s1')).toBe(false)
      expect(run.hooks.withheld('nobody')).toBe(false)
    })

    it.each([['its end', END], ['an aborted end', ABORT], ['the next turn\'s start', START]])('%s, written after the hook, ends it', (_, events) => {
      const run = waiting()
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      run.hooks.transcript('s1', events, { at: 5_001 })
      expect(run.hooks.withheld('s1')).toBe(false)
    })

    stopRule('an end held for its Stop ends it as it is read', async () => {
      const run = await hookDriven()
      parse(run, 't1')
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      expect(run.hooks.withheld('s1')).toBe(true)
      run.hooks.transcript('s1', END, { at: 5_001, turn: turnOf('t1') })
      expect(run.hooks.held('s1')).toBe(true)
      expect(run.hooks.withheld('s1')).toBe(false)
    })

    it('a cancel ends it', () => {
      const run = waiting()
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      run.hooks.closed('s1')
      expect(run.hooks.withheld('s1')).toBe(false)
    })

    // These ends are the core's own, or an end read with no time: left open, the wait withheld the next turn's Working.
    it('a turn the core ends ends it: its held end delivered, its close after the grace, or Codex\'s interrupt', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const ways = engine === 'claude'
        ? [async (run: ReturnType<typeof setup>) => { end(run, parse(run, 't1')); run.hooks.onTurnStop({ sessionId: 's1' }) },
            async (run: ReturnType<typeof setup>) => { parse(run, 't1'); run.hooks.onTurnStop({ sessionId: 's1' }) }]
        : [async (run: ReturnType<typeof setup>) => { parse(run, 't1'); run.hooks.onTurnStop({ sessionId: 's1', status: 'interrupted' }) }]
      for (const way of ways) {
        const run = await hookDriven()
        run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
        await way(run)
        await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
        expect(run.deps.emit).toHaveBeenCalledOnce()
        parse(run, 't2')
        expect(run.hooks.withheld('s1')).toBe(false)
      }
    })

    it('a wait hook run before the latest prompt hook opens nothing', () => {
      const run = waiting()
      run.hooks.onPromptHook('s1', 3_000)
      run.hooks.onWait({ sessionId: 's1', firedAt: 2_000 })
      expect(run.lease.snapshot('s1')!.state).toBe('working')
      expect(run.deps.tell).not.toHaveBeenCalled()
      expect(run.deps.awaitDialog).not.toHaveBeenCalled()
      expect(run.hooks.withheld('s1')).toBe(false)
    })

    it('an agent the lease no longer knows waits all the same', () => {
      const run = waiting()
      run.hooks.onWait({ sessionId: 's2', firedAt: 5_000 })
      expect(run.deps.awaitDialog).toHaveBeenCalledExactlyOnceWith('s2')
      expect(run.hooks.withheld('s2')).toBe(true)
    })

    // Claude Code runs PreToolUse(AskUserQuestion), then PermissionRequest, for one dialog.
    it('one dialog posting its wait twice is one wait, said the same, open from the later hook', () => {
      const run = waiting()
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_000 })
      run.hooks.onWait({ sessionId: 's1', firedAt: 5_010 })
      expect(run.told).toEqual(['unknown', 'unknown'])
      run.hooks.transcript('s1', TEXT, { at: 5_005 })
      expect(run.hooks.withheld('s1')).toBe(true)
      run.hooks.transcript('s1', TEXT, { at: 5_011 })
      expect(run.hooks.withheld('s1')).toBe(false)
    })

    it('a wait whose hook time did not come opens when it arrives', () => {
      vi.setSystemTime(10_000)
      const run = waiting()
      run.hooks.onWait({ sessionId: 's1' })
      run.hooks.transcript('s1', TEXT, { at: 9_999 })
      expect(run.hooks.withheld('s1')).toBe(true)
      run.hooks.transcript('s1', TEXT, { at: 10_001 })
      expect(run.hooks.withheld('s1')).toBe(false)
    })

    // A subagent's permission while the lead's end is held: the engine is still sending hooks (R6).
    stopRule('a wait hook starts the 2 minutes of silence again', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = await hookDriven()
      run.hooks.transcript('s1', END, { turn: turnOf('t1') })
      vi.advanceTimersByTime(60_000)
      run.hooks.onWait({ sessionId: 's1' })
      vi.advanceTimersByTime(HOOK_SILENCE_MS - 1); run.hooks.beat('s1')
      expect(run.deps.emit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1); run.hooks.beat('s1')
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    })
  })

  // A lead stays working while its subagents run (R5). Claude Code only: Codex installs no subagent hooks.
  describe.runIf(engine === 'claude')('subagents', () => {
    const subagent = (run: ReturnType<typeof setup>, started: boolean) => run.hooks.onSubagent({ sessionId: 's1', started })
    const lines = (log: { mock: { calls: unknown[][] } }) => log.mock.calls.map(call => String(call[0]))
    /** A lead whose end is read and held, with one subagent started before it. */
    const leading = async () => {
      const run = await hookDriven()
      subagent(run, true)
      run.hooks.transcript('s1', END, { turn: turnOf('t1') })
      return run
    }

    it('a background subagent: the lead\'s Stop leaves its turn open while one runs, and its first Stop after the last one stops ends it', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = await leading()
      run.hooks.onTurnStop({ sessionId: 's1' }); await vi.runAllTimersAsync()
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(run.hooks.held('s1')).toBe(true)
      expect(lines(log)).toEqual(['[turn] s1 Stop left its turn open · subagents run'])
      subagent(run, false)
      run.hooks.onTurnStop({ sessionId: 's1' }); await vi.runAllTimersAsync()
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    })

    it('a Stop that beats the lead\'s end while one runs does not close its turn after the grace', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = await hookDriven()
      const turn = parse(run, 't1')
      subagent(run, true)
      run.hooks.onTurnStop({ sessionId: 's1' }); await vi.runAllTimersAsync()
      expect(turn.turnOpen).toBe(true)
      end(run, turn)
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(run.hooks.held('s1')).toBe(true)
    })

    // The lead's wrap-up lands about 200 ms after the Stop that follows its last subagent (lib/commander.ts).
    it('that last Stop waits 1.5 s and drains again before it delivers, the wrap-up read in it first', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = await leading()
      run.hooks.onTurnStop({ sessionId: 's1' }); await vi.advanceTimersByTimeAsync(0)
      await vi.advanceTimersByTimeAsync(60_000)
      subagent(run, false)
      vi.mocked(run.deps.drain).mockClear()
      run.hooks.onTurnStop({ sessionId: 's1' })
      await vi.advanceTimersByTimeAsync(200)
      run.hooks.transcript('s1', [...TEXT, ...END], { turn: turnOf('t1') })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS - 201)
      expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', TEXT]])
      expect(run.deps.drain).toHaveBeenCalledOnce()
      await vi.advanceTimersByTimeAsync(1)
      expect(run.deps.drain).toHaveBeenCalledTimes(2)
      expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', TEXT], ['s1', END]])
    })

    it('a stop with none running stays at zero; the 65th start is not counted, said once', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = await hookDriven()
      subagent(run, false)
      subagent(run, true)
      expect(run.hooks.atWork('s1')).toBe(true)
      subagent(run, false)
      expect(run.hooks.atWork('s1')).toBe(false)
      for (let i = 0; i <= SUBAGENTS_MAX; i++) subagent(run, true)
      expect(lines(log)).toEqual(['[turn] s1 subagent not counted · 64 running'])
      for (let i = 1; i < SUBAGENTS_MAX; i++) subagent(run, false)
      expect(run.hooks.atWork('s1')).toBe(true)
      subagent(run, false)
      expect(run.hooks.atWork('s1')).toBe(false)
    })

    // Each hook is a process of its own: a slow daemon can take a subagent's stop before its start. Counted, that start
    // kept the lead working for 10 minutes.
    it('a stop taken before its start, at zero: that start, run before it, is not counted; the next is', async () => {
      const run = await hookDriven()
      run.hooks.onSubagent({ sessionId: 's1', started: false, firedAt: 2_000 })
      run.hooks.onSubagent({ sessionId: 's1', started: true, firedAt: 1_000 })
      expect(run.hooks.atWork('s1')).toBe(false)
      run.hooks.onSubagent({ sessionId: 's1', started: true, firedAt: 1_500 })
      expect(run.hooks.atWork('s1')).toBe(true)
    })

    it('a prompt hook sets it to zero', async () => {
      const run = await leading()
      run.hooks.onPromptHook('s1', 1)
      expect(run.hooks.atWork('s1')).toBe(false)
      run.hooks.onTurnStop({ sessionId: 's1' }); await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    })

    // A lost SubagentStop keeps no agent working for more than 10 minutes.
    it('10 minutes with no hook and no progress: zero, one line, and the held end is delivered', async () => {
      const log = vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = await leading()
      run.hooks.onTurnStop({ sessionId: 's1' }); await vi.advanceTimersByTimeAsync(0)
      log.mockClear()
      vi.advanceTimersByTime(SUBAGENT_TIMEOUT_MS - 1); run.hooks.beat('s1')
      expect(run.deps.emit).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1); run.hooks.beat('s1')
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
      expect(run.hooks.atWork('s1')).toBe(false)
      run.hooks.beat('s1')
      expect(lines(log)).toEqual(['[turn] s1 subagent count reset · no hook or progress in 10 min'])
    })

    it('progress or a hook inside the 10 minutes starts them again', async () => {
      vi.spyOn(console, 'log').mockImplementation(() => {})
      const run = await leading()
      vi.advanceTimersByTime(SUBAGENT_TIMEOUT_MS - 1)
      run.hooks.transcript('s1', [{ type: 'tool_start', payload: { id: 'sub', tool: 'Read', input: {}, parentToolUseId: 'task' } }], {})
      vi.advanceTimersByTime(SUBAGENT_TIMEOUT_MS - 1); run.hooks.beat('s1')
      subagent(run, true)
      vi.advanceTimersByTime(SUBAGENT_TIMEOUT_MS - 1); run.hooks.beat('s1')
      expect(run.hooks.held('s1')).toBe(true)
      expect(run.hooks.atWork('s1')).toBe(true)
      vi.advanceTimersByTime(1); run.hooks.beat('s1')
      expect(run.hooks.held('s1')).toBe(false)
    })

    it('2 minutes of silence do not end a turn whose subagents run', async () => {
      const run = await leading()
      vi.advanceTimersByTime(HOOK_SILENCE_MS); run.hooks.beat('s1')
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(run.hooks.held('s1')).toBe(true)
    })

    it('a StopFailure ends the turn whatever runs', async () => {
      const run = await leading()
      run.hooks.onTurnStop({ sessionId: 's1', status: 'error' }); await vi.advanceTimersByTimeAsync(0)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
    })

    it('atWork while any runs', () => {
      const run = setup(engine)
      expect(run.hooks.atWork('s1')).toBe(false)
      subagent(run, true)
      expect(run.hooks.atWork('s1')).toBe(true)
      subagent(run, false)
      expect(run.hooks.atWork('s1')).toBe(false)
    })
  })

  // Codex runs its Stop, and waits for it, before it writes the turn's end (facts-codex §5). A Stop that closed the turn
  // itself ended one a blocking Stop hook of the person's continued, or one still compacting after its Stop.
  describe.runIf(engine === 'codex')('Stop', () => {
    it('makes its turns end by hook, and closes, drains and waits for nothing: the turn\'s own end, read later, goes on', async () => {
      const run = setup(engine)
      const turn = parse(run, 't1')
      run.hooks.onTurnStop({ sessionId: 's1', firedAt: 1_000 })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(turn.turnOpen).toBe(true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(run.deps.drain).not.toHaveBeenCalled()
      turn.turnOpen = false
      run.hooks.transcript('s1', END, { turn: { ...turn }, over: true })
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', END)
      expect(run.hooks.withheld('s1')).toBe(true)
    })

    // A held Stop is acted on after the binding is checked (core/transcripts/attach.ts holdStop): a Codex Stop has nothing
    // to act on.
    it('is never held for a binding being checked', () => {
      const row = { agentId: 'a1', sessionId: 's1', engine, identityHold: 'pending' } as RegisteredSession
      const holdStop = vi.fn(() => true), run = setup(engine, { resolve: () => row, holdStop })
      run.hooks.onTurnStop({ sessionId: 's1', firedAt: 500 })
      expect(holdStop).not.toHaveBeenCalled()
    })
  })

  // Codex's Interrupt comes on the Stop's route as `status: 'interrupted'` (R3). Codex runs it after it marks the turn
  // interrupted and before it writes turn_aborted, and waits for it up to 3 s (facts-codex §2).
  describe.runIf(engine === 'codex')('Interrupt', () => {
    const interrupt = (run: ReturnType<typeof setup>, firedAt?: number) =>
      run.hooks.onTurnStop({ sessionId: 's1', status: 'interrupted', ...(firedAt === undefined ? {} : { firedAt }) })

    it('an interrupt ends the open turn as aborted at once: no drain, no wait', async () => {
      const run = await hookDriven()
      vi.mocked(run.deps.drain).mockClear()
      const turn = parse(run, 't1')
      interrupt(run)
      expect(turn.turnOpen).toBe(false)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', ABORT)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(run.deps.emit).toHaveBeenCalledOnce()
      expect(run.deps.drain).not.toHaveBeenCalled()
    })

    it('with no turn open (the app cancelled it, or its abort was read first) says nothing', async () => {
      const run = await hookDriven()
      vi.mocked(run.deps.drain).mockClear()
      interrupt(run)
      parse(run, 't1')
      run.normalizers.closeTurns('s1')
      interrupt(run)
      const turn = parse(run, 't2')
      turn.turnOpen = false
      run.hooks.transcript('s1', ABORT, { turn: { ...turn }, over: true })
      interrupt(run)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', ABORT]])
      expect(run.deps.drain).not.toHaveBeenCalled()
    })

    // Codex writes turn_aborted only after the hook returns: the turn is closed by then, so its parser ends nothing.
    it('the transcript\'s turn_aborted, read after the interrupt closed the turn, sends nothing more', async () => {
      const run = await hookDriven()
      const parser = codexLive.create({ engine, codexHome: undefined })
      run.normalizers.liveParsers.set('s1', parser)
      const read = (payload: object): void => {
        const { events, at, over } = parser.ingest(JSON.stringify({ timestamp: '2026-11-17T01:02:03.000Z', type: 'event_msg', payload }))
        run.hooks.transcript('s1', events, { at, over, turn: parser.snapshot() })
      }
      read({ type: 'user_message', message: 'go' })
      interrupt(run)
      expect(run.deps.emit).toHaveBeenLastCalledWith('s1', ABORT)
      read({ type: 'turn_aborted', reason: 'interrupted' })
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(vi.mocked(run.deps.emit).mock.calls).toEqual([['s1', [{ type: 'turn_started', payload: { userMessage: 'go' } }]], ['s1', ABORT]])
    })

    // Review Focus 5: an interrupt that reaches the daemon after the next turn's start was read is about the turn before.
    it('run before the latest prompt hook, or before the open turn opened, closes nothing', async () => {
      const run = await hookDriven()
      run.hooks.onPromptHook('s1', 3_000)
      const turn = parse(run, 't1', 1_000)
      interrupt(run, 2_000)
      expect(turn.turnOpen).toBe(true)
      const next = parse(run, 't2', 5_000)
      interrupt(run, 4_000)
      await vi.advanceTimersByTimeAsync(STOP_HOOK_GRACE_MS * 2)
      expect(next.turnOpen).toBe(true)
      expect(run.deps.emit).not.toHaveBeenCalled()
      // Its own interrupt closes it.
      interrupt(run, 6_000)
      expect(next.turnOpen).toBe(false)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', ABORT)
    })

    it('an interrupt, the first hook the session sends, makes its turns end by hook', () => {
      const run = setup(engine)
      parse(run, 't1')
      interrupt(run, 1_000)
      expect(run.deps.emit).toHaveBeenCalledExactlyOnceWith('s1', ABORT)
      expect(run.hooks.withheld('s1')).toBe(true)
    })

    it('an engine with no turn hooks, or a session it does not know, is left alone', async () => {
      const pi = setup('pi')
      const closeTurn = vi.fn()
      pi.normalizers.liveParsers.set('s1', { engine: 'pi', turnOpen: true, snapshot: () => ({ ...turnOf('t1'), turnOpen: true }), closeTurn })
      interrupt(pi)
      const run = setup(engine)
      run.hooks.onTurnStop({ sessionId: 'nobody', status: 'interrupted' })
      await vi.runAllTimersAsync()
      expect(closeTurn).not.toHaveBeenCalled()
      expect(pi.deps.emit).not.toHaveBeenCalled()
      expect(pi.hooks.withheld('s1')).toBe(false)
      expect(run.deps.emit).not.toHaveBeenCalled()
      expect(run.hooks.withheld('nobody')).toBe(false)
    })
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
