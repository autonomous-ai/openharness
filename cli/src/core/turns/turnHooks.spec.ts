import type { LiveParser } from '../../engines/facets/live.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { removeCursorPendingTasks } from '../../engines/cursor/pendingTasks.js'
import type { TurnState } from '../../lib/normalize.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createSessionNormalizers } from '../transcripts/normalizers.js'
import { createTurnHooks, STOP_HOOK_GRACE_MS, type TurnHookDeps } from './turnHooks.js'
import { engineHooks } from '../../engines/hooks.js'
import type { HookTurnContext } from '../../engines/facets/hooks.js'

vi.mock('../../engines/cursor/pendingTasks.js', () => ({ removeCursorPendingTasks: vi.fn(async () => {}) }))

const END = [{ type: 'turn_ended', payload: {} }]
const ABORT = [{ type: 'turn_ended', payload: { aborted: true } }]

/** A normalizer or reader with the turn calls the hooks make. */
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
      expect(removeCursorPendingTasks).toHaveBeenCalledWith('/data', 's1')
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
