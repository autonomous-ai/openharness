import { readInlineScreen } from '../testing/inlineScreen.js'
import { inlineSubmission } from '../testing/inlineSubmission.js'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RegisteredSession } from '../lib/registry.js'
import type { SessionInputController, SessionInputDelivery } from '../lib/sessionInput.js'
import { TERMINAL_LEASE_REFUSED, type ProcessIdentity, type TerminalActionResult } from '../lib/terminalTypes.js'
import { CLAUDE_REWIND_LIST, CODEX_BROWSING_SCROLLBACK } from '../lib/__fixtures__/rewindPickers.js'
import { createInput, createMessageRequest, heldScreen, messageWriter, sessionInputDeps, type InputDeps } from './input.js'
import { createShortTurnGuard } from './turns/shortTurnGuard.js'
import { createScreens } from './engines/screens.js'
import { screenFor } from '../engines/screens.js'
import { readerEngine } from '../engines/worker/protocol.js'

const ok: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }
const fixture = (name: string) => readFileSync(new URL(`../lib/__fixtures__/${name}`, import.meta.url), 'utf8')
/** Claude Code asking to run a command, and Command Code the same: the Enter behind a paste approves. */
const CLAUDE_PERMISSION = fixture('permission-claude.txt')
const COMMANDCODE_PERMISSION = fixture('permission-commandcode.txt')
/** A Claude Code composer that is empty and idle: ready for a team write. */
const READY_PANE = '────────────\n❯\n────────────\n  ? for shortcuts'

function pending<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

const agents = new Map<string, RegisteredSession>([
  ['a1', { agentId: 'a1', sessionId: 's1', engine: 'claude' } as RegisteredSession],
  ['cx', { agentId: 'cx', sessionId: 'cx-s', engine: 'codex' } as RegisteredSession],
  ['s1', { agentId: 'a1', sessionId: 's1', engine: 'claude' } as RegisteredSession],
  ['cc', { agentId: 'cc', sessionId: 'cc-s', engine: 'commandcode' } as RegisteredSession],
  ['cc-new', { agentId: 'cc-new', sessionId: '', engine: 'commandcode' } as RegisteredSession],
  ['cc-none', { agentId: 'cc-none', sessionId: 'cc-none-s', engine: 'commandcode' } as RegisteredSession],
])

function deps(over: Partial<InputDeps> = {}) {
  const calls: string[] = []
  const device = {
    delivery: vi.fn((event: SessionInputDelivery) => { calls.push(`device delivery ${event.deliveryId}`) }),
    inputDispatched: vi.fn(),
    inputStatus: vi.fn(),
    agentGone: vi.fn(),
  }
  const normalizer = { openTurn: vi.fn(async (sessionId: string, text: string) => sessionId === 'cc-s' ? [{ type: 'turn_started', text }] as never[] : []) }
  let pane: string | null = READY_PANE
  const base: InputDeps = {
    readScreen: readInlineScreen,
    submission: inlineSubmission,
    resolve: (id) => agents.get(id),
    terminal: {
      captureTerminal: vi.fn(async () => pane),
      validateTerminal: vi.fn(async () => true),
      submitTerminalAction: vi.fn(async (id: string, text: string) => { calls.push(`submit ${id} ${text}`); return ok }),
      keyTerminalAction: vi.fn(async (id: string, key: string) => { calls.push(`key ${id} ${key}`); return ok }),
      pinTerminalControl: vi.fn(() => () => { calls.push('unpin') }),
    },
    deliveries: {
      settled: vi.fn((event: SessionInputDelivery) => { calls.push(`delivery settled ${event.deliveryId}`) }),
      canWrite: vi.fn(() => true),
      input: vi.fn(),
    },
    clients: { send: vi.fn() }, failure: vi.fn(),
    agentIdFor: (sessionId) => agents.get(sessionId)?.agentId ?? sessionId,
    openTurn: normalizer.openTurn,
    emit: vi.fn(),
    ...over,
  }
  return { deps: base, calls, device, normalizer, setPane: (next: string | null) => { pane = next } }
}

const delivery = (deliveryId: string) => ({ deliveryId }) as unknown as SessionInputDelivery

describe('the session input controller\'s dependencies', () => {
  afterEach(() => vi.restoreAllMocks())

  it('copies the current activity stamp at dispatch for the concrete operation session', () => {
    const activity = { epoch: 'core', revision: 7, state: 'idle', validForMs: 0 }
    const run = deps({ activity: () => activity } as unknown as Partial<InputDeps>)
    const input = sessionInputDeps(run.deps)
    input.onInput!({ agentId: 'a1', deliveryId: 'd', sessionId: 's1', phase: 'dispatching', when: 'composer', content: 'hello' })
    activity.revision = 8
    expect(run.deps.deliveries.input).toHaveBeenCalledWith(expect.objectContaining({ activity: { epoch: 'core', revision: 7 } }))
    input.onInput!({ agentId: 'a1', deliveryId: 'other', sessionId: 'replaced', phase: 'dispatching', when: 'composer' })
    expect(vi.mocked(run.deps.deliveries.input!).mock.lastCall![0]).not.toHaveProperty('activity')
  })

  it.each(['entry', 'validation', 'capture', 'screen', 'enter'])('refuses a writer whose caller leaves during %s', async boundary => {
    const run = deps()
    let current = boundary !== 'entry'
    const originalRead = run.deps.readScreen
    if (boundary === 'validation') vi.mocked(run.deps.terminal.validateTerminal).mockImplementationOnce(async () => { current = false; return true })
    if (boundary === 'capture') vi.mocked(run.deps.terminal.captureTerminal).mockImplementationOnce(async () => { current = false; return READY_PANE })
    let reads = 0
    run.deps.readScreen = async (...args) => {
      const screen = await originalRead(...args)
      if (++reads === (boundary === 'enter' ? 2 : 1) && ['screen', 'enter'].includes(boundary)) current = false
      return screen
    }
    vi.mocked(run.deps.terminal.submitTerminalAction).mockImplementationOnce(async (_id, _text, options) => {
      expect(await options!.beforeEnter!()).toBe('caller_gone')
      return { state: 'unknown', dispatch: 'possibly_executed', reason: 'caller_gone' }
    })
    const result = await messageWriter(run.deps)('a1', 'caller text', undefined, () => current)
    expect(result).toMatchObject({ reason: 'caller_gone', dispatch: boundary === 'enter' ? 'possibly_executed' : 'not_started' })
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(boundary === 'enter' ? 1 : 0)
    if (boundary === 'entry') expect(run.deps.terminal.validateTerminal).not.toHaveBeenCalled()
  })

  it('finds a session and checks its pane through what it was given', async () => {
    const { deps: given } = deps()
    const wired = sessionInputDeps(given)
    expect(wired.getSession('s1')?.agentId).toBe('a1')
    expect(wired.validateRuntime).toBe(given.terminal.validateTerminal)
    expect(wired.capture).toBe(given.terminal.captureTerminal)
    expect(await wired.beforeTeamWrite!(agents.get('a1')!)).toBeNull()
  })

  it('holds an automatic write to an agent the short-turn guard holds, without reading its pane, until the hold ends', async () => {
    let at = 0
    const shortTurns = createShortTurnGuard({ now: () => at, log: () => {} })
    for (let i = 0; i < 10; i++) { shortTurns.started('s1', 'a1'); at += 1_000; shortTurns.ended('s1') }
    const { deps: given } = deps({ shortTurns })
    const wired = sessionInputDeps(given)
    expect(await wired.beforeTeamWrite!(agents.get('a1')!, 'team:service:messages:d1')).toBe('team_waiting_control')
    expect(given.terminal.captureTerminal).not.toHaveBeenCalled()
    expect(await wired.beforeTeamWrite!(agents.get('cx')!, 'team:service:messages:d2')).toBeNull()
    at += 30_000
    expect(await wired.beforeTeamWrite!(agents.get('a1')!, 'team:service:messages:d1')).toBeNull()
  })

  it('asks whether an engine\'s reader is starting, and tells the app a message waits for it', async () => {
    const starting = Promise.resolve(true)
    const { deps: given } = deps({ engineStarting: (engine) => engine === 'claude' ? starting : null })
    const wired = sessionInputDeps(given)
    expect(wired.engineStarting!({ ...agents.get('a1')!, engine: 'claude' })).toBe(starting)
    expect(wired.engineStarting!({ ...agents.get('a1')!, engine: 'codex' })).toBeNull()
    expect(sessionInputDeps(deps().deps).engineStarting!(agents.get('a1')!)).toBeNull()
    const sync = vi.fn()
    sessionInputDeps(deps({ sync }).deps).onWaitChanged!('a1')
    expect(sync).toHaveBeenCalledWith('a1')
    sessionInputDeps(deps().deps).onWaitChanged!('a1')
    wired.onWaiting!('s1', 'engine_starting')
    expect(given.clients.send).toHaveBeenCalledWith({ type: 'message_waiting', agentId: 'a1', dbSessionId: 's1', payload: { reason: 'engine_starting' } })
  })

  it('hands the controller the move gate when it was given one, and none otherwise', () => {
    const { deps: given } = deps()
    expect('moveGate' in sessionInputDeps(given)).toBe(false)
    const moveGate = { held: () => false } as unknown as NonNullable<InputDeps['moveGate']>
    expect(sessionInputDeps({ ...given, moveGate }).moveGate).toBe(moveGate)
  })

  it('tells the shared delivery route once', () => {
    const one = deps()
    sessionInputDeps(one.deps).onDelivery!(delivery('d1'))
    expect(one.calls).toEqual(['delivery settled d1'])
  })

  it('provides the guarded message writer and key operation to the input owner', async () => {
    const { deps: given, calls } = deps()
    const wired = sessionInputDeps(given)
    expect(await wired.inject('a1', 'hello')).toBe(ok)
    expect(await wired.sendKey('a1', 'enter')).toBe(ok)
    expect(calls).toEqual(['submit a1 hello', 'key a1 enter'])
  })

  it('types a message only into a pane it has read in the pane\'s lock and found ready for one', async () => {
    const run = deps()
    const wired = sessionInputDeps(run.deps)
    run.setPane(CLAUDE_PERMISSION)
    expect(await wired.inject('a1', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'permission_open' })
    run.setPane(CLAUDE_REWIND_LIST)
    expect(await wired.inject('a1', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'rewind_picker_open' })
    run.setPane(CODEX_BROWSING_SCROLLBACK)
    expect(await wired.inject('cx', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'rewind_picker_open' })
    run.setPane(COMMANDCODE_PERMISSION)
    expect(await wired.inject('cc', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'permission_open' })
    // Nothing written, each read inside the lock.
    expect(run.calls).toEqual([])
    // Claude Code's and Codex's panes are typed into only when read and their composer is on screen; another
    // engine's pane that cannot be read is written as before; an agent that is not there, not at all.
    run.setPane(null)
    expect(await wired.inject('cx', 'hi')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'screen_unreadable' })
    expect(await wired.inject('cc', 'hi')).toBe(ok)
    run.setPane('✻ Welcome to Claude Code')
    expect(await wired.inject('a1', 'hi')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'prompt_hidden' })
    run.setPane(READY_PANE)
    expect(await wired.inject('a1', 'hi')).toBe(ok)
    expect(await wired.inject('nobody', 'hi')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'terminal agent is unavailable' })
    expect(run.calls.filter((call) => call.startsWith('submit'))).toEqual(['submit cc hi', 'submit a1 hi'])
  })

  it('reads the pane after its engine has answered, so a dialog opened during the wait is seen', async () => {
    const run = deps()
    const wired = sessionInputDeps(run.deps)
    const order: string[] = []
    // The check that waits for the engine (a probe timed out, a restart recording its engine), and a
    // permission prompt that opens while it waits.
    vi.mocked(run.deps.terminal.validateTerminal).mockImplementation(async () => { order.push('validate'); run.setPane(CLAUDE_PERMISSION); return true })
    vi.mocked(run.deps.terminal.captureTerminal).mockImplementation(async () => { order.push('capture'); return CLAUDE_PERMISSION })
    expect(await wired.inject('a1', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'permission_open' })
    expect(order).toEqual(['validate', 'capture'])
    // No engine there: refused as a lease is, which the controller asks again, and the pane is not read.
    vi.mocked(run.deps.terminal.validateTerminal).mockImplementation(async () => false)
    order.length = 0
    expect(await wired.inject('a1', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: TERMINAL_LEASE_REFUSED })
    expect(order).toEqual([])
    expect(run.calls.filter((call) => call.startsWith('submit'))).toEqual([])
  })

  // Codex on Windows takes a paste as keys, and an Enter too soon became a newline in it, stuck in the composer (lib/pasteOnScreen.ts).
  it.each([
    ['once the paste shows and has stopped changing', [{ draft: false, screen: 'empty' }, { draft: true, screen: 'pasted' }, { draft: true, screen: 'pasted' }], false],
    ['anyway at its limit, and says so', [{ draft: false, screen: 'empty' }], true],
  ])('on Windows, presses Codex\'s Enter %s', async (_name, panes, warned) => {
    const platform = process.platform
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    agents.set('c1', { ...agents.get('a1')!, agentId: 'c1', engine: 'codex' })
    let read = 0, entered = false
    const write = messageWriter({
      readScreen: vi.fn(async (_session: unknown, capture: string | null) => ({ messageHold: null, pane: { draft: capture === 'pasted' } })) as unknown as InputDeps['readScreen'],
      resolve: (id) => agents.get(id),
      terminal: {
        validateTerminal: vi.fn(async () => true),
        captureTerminal: vi.fn(async () => panes[Math.min(read++, panes.length - 1)]!.screen),
        submitTerminalAction: vi.fn(async (_id: string, _text: string, options?: { beforeEnter?: () => Promise<string | null> }) => {
          expect(await options!.beforeEnter!()).toBeNull()
          entered = true
          return ok
        }),
      } as unknown as InputDeps['terminal'],
    })
    vi.useFakeTimers()
    try {
      const written = write('c1', 'a long message')
      await vi.advanceTimersByTimeAsync(10_000)
      await written
    } finally {
      vi.useRealTimers()
      Object.defineProperty(process, 'platform', { value: platform, configurable: true })
      agents.delete('c1')
    }
    expect(entered).toBe(true)
    expect(warn.mock.calls.some(([line]) => String(line).includes('did not show in its composer'))).toBe(warned)
    warn.mockRestore()
  })

  it('reads the pane again right before the Enter, and gives the reason not to press it, a popup of the message\'s own aside', async () => {
    const screens = [READY_PANE, CLAUDE_PERMISSION, READY_PANE, null, READY_PANE, READY_PANE, `────────────\n❯ /mo\n────────────\n  /model   Set the AI model`]
    const answers: Array<string | null> = []
    const write = messageWriter({ readScreen: deps().deps.readScreen,
      resolve: (id) => agents.get(id),
      terminal: {
        validateTerminal: vi.fn(async () => true),
        captureTerminal: vi.fn(async () => screens.shift() ?? null),
        submitTerminalAction: vi.fn(async (_id: string, _text: string, options?: { beforeEnter?: () => Promise<string | null> }) => {
          answers.push(await options!.beforeEnter!())
          return ok
        }),
      } as unknown as InputDeps['terminal'],
    })
    vi.useFakeTimers()
    try {
      for (let i = 0; i < 3; i++) {
        const written = write('a1', 'hello')
        await vi.advanceTimersByTimeAsync(1_000)
        await written
      }
    } finally { vi.useRealTimers() }
    // A permission prompt opened between the paste and the Enter; the pane unread once, then the composer;
    // the message's own `/mo`.
    expect(answers).toEqual(['permission_open', null, null])
  })

  it('hands the pane as it read it to the question watcher right before typing a prompt, and not when it holds the prompt', async () => {
    const order: string[] = []
    const promptTyped = vi.fn((session: { agentId: string }, capture: string | null) => { order.push(`prompt ${session.agentId} ${capture === READY_PANE}`) })
    const screens = [READY_PANE, CLAUDE_PERMISSION]
    const write = messageWriter({ readScreen: deps().deps.readScreen,
      resolve: (id) => agents.get(id),
      terminal: {
        validateTerminal: vi.fn(async () => true),
        captureTerminal: vi.fn(async () => screens.shift() ?? READY_PANE),
        submitTerminalAction: vi.fn(async () => { order.push('submit'); return ok }),
      } as unknown as InputDeps['terminal'],
      promptTyped,
    })
    expect(await write('a1', 'hello')).toBe(ok)
    // Before the paste: the turn the prompt starts is seen to start only later.
    expect(order).toEqual(['prompt a1 true', 'submit'])
    // A permission prompt on the pane: nothing typed, nothing said.
    expect(await write('a1', 'hello')).toMatchObject({ dispatch: 'not_started', reason: 'permission_open' })
    expect(promptTyped).toHaveBeenCalledTimes(1)
  })

  it('holds the Enter back when the pane cannot be read for three seconds, or shows no composer that long', async () => {
    for (const screen of [null, '✻ Welcome to Claude Code']) {
      let reads = 0
      const answers: Array<string | null> = []
      const write = messageWriter({ readScreen: deps().deps.readScreen,
        resolve: (id) => agents.get(id),
        terminal: {
          validateTerminal: vi.fn(async () => true),
          captureTerminal: vi.fn(async () => (reads++ === 0 ? READY_PANE : screen)),
          submitTerminalAction: vi.fn(async (_id: string, _text: string, options?: { beforeEnter?: () => Promise<string | null> }) => {
            answers.push(await options!.beforeEnter!())
            return ok
          }),
        } as unknown as InputDeps['terminal'],
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.useFakeTimers()
      try {
        const written = write('a1', 'hello')
        await vi.advanceTimersByTimeAsync(5_000)
        await written
      } finally { vi.useRealTimers() }
      expect(answers).toEqual([screen === null ? 'screen_unreadable' : 'prompt_hidden'])
      expect(reads).toBe(13)
      // The screen the Enter was held on is in the log, to read back what the reader missed.
      expect(warn).toHaveBeenCalledWith(expect.stringContaining(`Enter held · ${answers[0]} · screen ${heldScreen(screen)}`))
      warn.mockRestore()
    }
  })

  it('logs the bottom of a held screen with its escapes visible, its secrets redacted and its rows cut', () => {
    expect(heldScreen(null)).toBe('unread')
    const rows = [...Array.from({ length: 20 }, (_, i) => `row ${i}`), '\u001b[2m───\u001b[0m', '>\u00a0token=abcdefgh1234', 'x'.repeat(500), '', '  ']
    const logged = JSON.parse(heldScreen(rows.join('\n'))) as string[]
    expect(logged).toHaveLength(15)
    expect(logged[0]).toBe('row 8')
    expect(logged.slice(-3)).toEqual(['\u001b[2m───\u001b[0m', '>\u00a0token=<redacted>', 'x'.repeat(400)])
  })

  it('presses the Enter of a message typed while its engine started once it binds its first conversation, and under no other change', async () => {
    // An engine draws its composer before its first hook binds the conversation: a message typed in that gap
    // finds its record rebuilt by the Enter. The screen is read under the record as it now stands only when it
    // is that launch, in the same pane and process; any other change is read as typed, and the fence holds it.
    const engineProcess = (pid: number): ProcessIdentity => ({ pid, executable: 'claude', startMarker: `start ${pid}` })
    const starting = { agentId: 'a9', sessionId: '', boundAt: null, engine: 'claude', active: true, launch: { state: 'ready' },
      registeredAt: 1, tmuxPane: '%9', primaryRuntimeKey: 'tmux:%9', runtimes: [], transcriptPath: null, processIdentity: null } as unknown as RegisteredSession
    const bound = { ...starting, launch: undefined, sessionId: 's9', boundAt: 2, transcriptPath: '/t/s9.jsonl', processIdentity: engineProcess(7) } as RegisteredSession
    const known = { ...starting, processIdentity: engineProcess(7) } as RegisteredSession
    const resumed = { ...bound, launch: { state: 'ready' }, resumeOnly: true } as RegisteredSession
    const cases: Array<[string, RegisteredSession, RegisteredSession | undefined, string | null]> = [
      ['its first bind', starting, bound, null],
      ['its first bind, the process it knew', known, bound, null],
      ['nothing changed', bound, bound, null],
      ['another process', known, { ...bound, processIdentity: engineProcess(8) }, 'screen_unreadable'],
      ['another pane', starting, { ...bound, tmuxPane: '%10' }, 'screen_unreadable'],
      ['another route', starting, { ...bound, primaryRuntimeKey: 'tmux:%10' }, 'screen_unreadable'],
      ['another registration', starting, { ...bound, registeredAt: 3 }, 'screen_unreadable'],
      ['another engine', starting, { ...bound, engine: 'codex' }, 'screen_unreadable'],
      ['another agent', starting, { ...bound, agentId: 'a10' }, 'screen_unreadable'],
      ['the agent gone', starting, undefined, 'screen_unreadable'],
      ['a rotation', bound, { ...bound, sessionId: 's10', boundAt: 3 }, 'screen_unreadable'],
      ['a resumed conversation rebound', resumed, { ...resumed, sessionId: 's10', boundAt: 3 }, 'screen_unreadable'],
    ]
    for (const [name, typed, after, answer] of cases) {
      let current: RegisteredSession | undefined = typed
      const answers: Array<string | null> = []
      const screens = createScreens({ handles: () => false, transport: { read: vi.fn() }, resolve: () => current,
        inline: (engine, capture) => readerEngine(engine) && capture !== null ? screenFor(engine).inspect(capture) : undefined })
      const write = messageWriter({ readScreen: screens.read,
        resolve: () => current,
        terminal: {
          validateTerminal: vi.fn(async () => true),
          captureTerminal: vi.fn(async () => READY_PANE),
          submitTerminalAction: vi.fn(async (_id: string, _text: string, options?: { beforeEnter?: () => Promise<string | null> }) => {
            current = after
            answers.push(await options!.beforeEnter!())
            return ok
          }),
        } as unknown as InputDeps['terminal'],
      })
      vi.useFakeTimers()
      try {
        const written = write('a9', 'sent while it was starting')
        await vi.advanceTimersByTimeAsync(5_000)
        await written
      } finally { vi.useRealTimers() }
      expect(answers, name).toEqual([answer])
    }
  })

  it('writes a team turn only into a ready pane whose delivery still holds control', async () => {
    const run = deps()
    const wired = sessionInputDeps(run.deps)
    expect(await wired.injectTeam!('nobody', 'hi', 'd1')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'team_waiting_unavailable' })
    run.setPane(null)
    expect(await wired.injectTeam!('a1', 'hi', 'd1')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'team_waiting_unavailable' })
    run.setPane(READY_PANE)
    vi.mocked(run.deps.deliveries.canWrite).mockReturnValueOnce(false)
    expect(await wired.injectTeam!('a1', 'hi', 'd1')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'team_waiting_control' })
    expect(await wired.injectTeam!('a1', 'hi', 'd1')).toBe(ok)
    expect(run.calls.filter((call) => call.startsWith('submit'))).toEqual(['submit a1 hi'])
  })

  it('holds team and device writes when an otherwise readable screen has no worker evidence', async () => {
    const run = deps({ readScreen: async () => null })
    const wired = sessionInputDeps(run.deps)
    expect(await wired.beforeTeamWrite!(agents.get('a1')!)).toBe('team_waiting_unavailable')
    expect(await wired.inject('a1', 'hello')).toMatchObject({ dispatch: 'not_started', reason: 'screen_unreadable' })
    expect(await wired.injectTeam!('a1', 'hello', 'delivery')).toMatchObject({ dispatch: 'not_started', reason: 'team_waiting_unavailable' })
    expect(run.deps.terminal.submitTerminalAction).not.toHaveBeenCalled()
    expect(run.deps.terminal.keyTerminalAction).not.toHaveBeenCalled()
  })

  it('publishes the raw input error and hands its failure facts to the component without constructing a card', () => {
    const failure = vi.fn(), { deps: given } = deps({ failure })
    const clients = { ...given.clients, sendCommander: vi.fn() }
    sessionInputDeps({ ...given, clients }).onError('s1', 'The agent did not accept the message. Please try again.')
    expect(given.clients.send).toHaveBeenCalledExactlyOnceWith({ type: 'error', agentId: 'a1', dbSessionId: 's1',
      payload: { message: 'The agent did not accept the message. Please try again.' } })
    expect(failure).toHaveBeenCalledExactlyOnceWith({ agentId: 'a1', sessionId: 's1', engine: 'claude',
      message: 'The agent did not accept the message. Please try again.' })
    expect(vi.mocked(given.clients.send).mock.invocationCallOrder[0]).toBeLessThan(failure.mock.invocationCallOrder[0])
    expect(clients.sendCommander).not.toHaveBeenCalled()
  })

  it('keeps the captured app address when its publication reenters a changed binding and the engine is absent', () => {
    let agentId = 'before'
    const { deps: given } = deps({ agentIdFor: () => agentId, resolve: () => undefined })
    vi.mocked(given.clients.send).mockImplementation(() => { agentId = 'after' })
    sessionInputDeps(given).onError('session', 'raw')
    expect(given.failure).toHaveBeenCalledExactlyOnceWith({ agentId: 'before', sessionId: 'session', message: 'raw' })
  })

  it('reports an error to the app and its raw facts to the lifecycle', () => {
    const { deps: given } = deps()
    sessionInputDeps(given).onError('s1', 'the pane is gone')
    expect(given.clients.send).toHaveBeenCalledWith({ type: 'error', agentId: 'a1', dbSessionId: 's1', payload: { message: 'the pane is gone' } })
    expect(given.failure).toHaveBeenCalledWith({ agentId: 'a1', sessionId: 's1', engine: 'claude', message: 'the pane is gone' })
  })

  it('opens a Command Code turn on our own paste, in its worker, and nobody else\'s', async () => {
    const { deps: given, normalizer } = deps()
    const wired = sessionInputDeps(given)
    for (const id of ['a1', 'nobody', 'cc-new', 'cc-none']) wired.onSubmitted!(id, 'hi')
    await Promise.resolve(); await Promise.resolve()
    expect(given.emit).not.toHaveBeenCalled()
    wired.onSubmitted!('cc', 'hi')
    await vi.waitFor(() => expect(given.emit).toHaveBeenCalledWith('cc-s', [{ type: 'turn_started', text: 'hi' }]))
    expect(normalizer.openTurn).toHaveBeenCalledWith('cc-s', 'hi')
  })
})

describe('createInput', () => {
  afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers() })

  it.each([undefined, 'tracked'])('releases completed input content and caller authority (%s)', async deliveryId => {
    vi.useFakeTimers()
    const run = deps(), inputs = createInput(run.deps)
    const current = () => true
    inputs.submitInput('a1', { content: 'content retained only while pending', when: deliveryId ? 'turn' : 'composer', deliveryId, current })
    await vi.advanceTimersByTimeAsync(0)
    const states = Reflect.get(inputs.input, 'states') as Map<string, { operation?: unknown; awaitingContent: string | null }>
    expect(states.get('a1')!.operation).toBeDefined()
    inputs.input.onTurnStarted('a1', 'content retained only while pending')
    expect(states.get('a1')!.awaitingContent).toBeNull()
    expect(states.get('a1')!.operation).toBeUndefined()
    inputs.input.forget('a1')
  })

  it('shares one eight-item queue between ordinary messages and correlated composer input', async () => {
    vi.useFakeTimers()
    const run = deps()
    const inputs = createInput(run.deps)
    const release = inputs.acquireTerminalControl('a1')!
    const receipts = Array.from({ length: 5 }, () => vi.fn())
    for (let index = 0; index < 4; index++) {
      inputs.messageRequest({ agentId: 'a1', content: `ordinary ${index}` }, receipts[index])
      inputs.submitInput('a1', { content: `correlated ${index}`, deliveryId: `delivery-${index}`, when: 'composer' })
    }
    inputs.messageRequest({ agentId: 'a1', content: 'ninth input' }, receipts[4])
    expect(receipts[4]).toHaveBeenCalledWith('queue_full')
    expect(run.deps.terminal.submitTerminalAction).not.toHaveBeenCalled()
    inputs.input.forget('a1')
    release()
  })

  it('keeps original caller authority through validation and through the actual Enter guard', async () => {
    vi.useFakeTimers()
    let current = true
    const validation = pending<boolean>()
    const run = deps()
    vi.mocked(run.deps.terminal.validateTerminal).mockImplementationOnce(() => validation.promise)
    const inputs = createInput(run.deps)
    inputs.submitInput('a1', { content: 'revoked before paste', when: 'composer', deliveryId: 'first', current: () => current })
    current = false
    validation.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.terminal.submitTerminalAction).not.toHaveBeenCalled()
    expect(run.deps.deliveries.settled).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'first', state: 'rejected', reason: 'caller_gone' }))
    expect(run.deps.clients.send).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'error' }))
    current = true
    let allowed!: () => boolean
    let beforeEnter!: () => Promise<string | null>
    vi.mocked(run.deps.terminal.submitTerminalAction).mockImplementationOnce(async (_id, _text, options) => {
      allowed = options!.allowed!
      beforeEnter = options!.beforeEnter!
      current = false
      expect(allowed()).toBe(false)
      expect(await beforeEnter()).toBe('caller_gone')
      return { state: 'unknown', dispatch: 'possibly_executed', reason: 'caller_gone' }
    })
    inputs.submitInput('a1', { content: 'revoked after paste', when: 'composer', deliveryId: 'second', current: () => current })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.deliveries.settled).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'second', state: 'unknown' }))
    expect(run.deps.terminal.keyTerminalAction).not.toHaveBeenCalled()
    inputs.input.forget('a1')
  })

  it('requires fresh composer evidence after a turn event, even when its text is identical', async () => {
    vi.useFakeTimers()
    const run = deps()
    let draft: 'pending' | 'clear' = 'pending'
    run.deps.submission = { ...inlineSubmission, read: vi.fn(async () => ({ draft: draft === 'pending', composer: true, nativeDraft: draft })) }
    const inputs = createInput(run.deps)
    inputs.submitInput('a1', { content: 'same words', when: 'composer', deliveryId: 'first' })
    await vi.advanceTimersByTimeAsync(0)
    inputs.submitInput('a1', { content: 'next words', when: 'composer', deliveryId: 'second' })
    inputs.input.onTurnStarted('a1', 'same words')
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1)
    expect(run.deps.deliveries.settled).not.toHaveBeenCalledWith(expect.objectContaining({ state: 'started' }))
    draft = 'clear'
    inputs.input.onTurnStarted('a1', 'same words')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(run.deps.terminal.submitTerminalAction).mock.calls.map(call => call[1])).toEqual(['same words', 'next words'])
    inputs.input.forget('a1')
  })

  it('writes an ordinary window message with no component attached', async () => {
    vi.useFakeTimers()
    const run = deps(), inputs = createInput(run.deps)
    inputs.messageRequest({ agentId: 'a1', content: 'from the window' })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledWith('a1', 'from the window', expect.any(Object))
    inputs.input.forget('a1')
  })

  it('resumes an ordinary message already validating before the next native device input', async () => {
    vi.useFakeTimers()
    const run = deps(), validation = pending<boolean>(), native = pending<TerminalActionResult>()
    vi.mocked(run.deps.terminal.validateTerminal).mockImplementationOnce(() => validation.promise)
    vi.mocked(run.deps.terminal.submitTerminalAction).mockImplementationOnce(() => native.promise)
    const inputs = createInput(run.deps)
    inputs.messageRequest({ agentId: 'a1', content: 'from the window' })
    inputs.submitInput('a1', { content: 'device A', deliveryId: 'device-A', when: 'composer' })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledWith('a1', 'device A', expect.any(Object))
    validation.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    inputs.submitInput('a1', { content: 'device B', deliveryId: 'device-B', when: 'composer' })
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1)
    native.resolve(ok)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(run.deps.terminal.submitTerminalAction).mock.calls.map((call) => call[1]))
      .toEqual(['device A', 'from the window'])
    inputs.input.onTurnStarted('a1', 'from the window')
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.mocked(run.deps.terminal.submitTerminalAction).mock.calls.map((call) => call[1]))
      .toEqual(['device A', 'from the window', 'device B'])
    inputs.input.forget('a1')
  })

  it('holds an old native write through forget without releasing new control or writing an old waiting message', async () => {
    vi.useFakeTimers()
    let session = agents.get('a1')!
    const run = deps({ resolve: () => session })
    const validation = pending<boolean>(), native = pending<TerminalActionResult>()
    vi.mocked(run.deps.terminal.validateTerminal).mockImplementationOnce(() => validation.promise)
    vi.mocked(run.deps.terminal.submitTerminalAction).mockImplementationOnce(() => native.promise)
    const inputs = createInput(run.deps)
    inputs.messageRequest({ agentId: 'a1', content: 'old waiting message' })
    inputs.submitInput('a1', { content: 'old native write', deliveryId: 'old-device', when: 'composer' })
    await vi.advanceTimersByTimeAsync(0)
    validation.resolve(true)
    await vi.advanceTimersByTimeAsync(0)
    // The composition root forgets shared input before the device's active dispatch.
    inputs.input.forget('a1')
    session = { ...session, sessionId: 'new-session' }
    const release = inputs.acquireTerminalControl('a1')!
    expect(release).toBeTypeOf('function')
    inputs.submitInput('a1', { content: 'new native write', deliveryId: 'new-device', when: 'composer' })
    await vi.advanceTimersByTimeAsync(100)
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1)
    native.resolve(ok)
    await vi.advanceTimersByTimeAsync(0)
    expect(inputs.input.controlHeld('a1')).toBe(true)
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1)
    release()
    await vi.advanceTimersByTimeAsync(100)
    expect(vi.mocked(run.deps.terminal.submitTerminalAction).mock.calls.map((call) => call[1]))
      .toEqual(['old native write', 'new native write'])
    inputs.input.forget('a1')
  })

  it.each(['composer', 'personal'])('wakes recreated input after the old %s write actually settles', async kind => {
    vi.useFakeTimers()
    let session = agents.get('a1')!
    const run = deps({ resolve: () => session }), writing = pending<TerminalActionResult>()
    vi.mocked(run.deps.terminal.submitTerminalAction).mockImplementationOnce(() => writing.promise)
    const inputs = createInput(run.deps)
    if (kind === 'composer') inputs.submitInput('a1', { content: 'old write', deliveryId: 'old', when: 'composer' })
    else inputs.messageRequest({ agentId: 'a1', content: 'old write' })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1)
    inputs.input.forget('a1')
    session = { ...session, sessionId: 'replacement-session' }
    inputs.submitInput('a1', { content: 'replacement write', deliveryId: 'replacement', when: 'composer' })
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1)
    writing.resolve(ok)
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(run.deps.terminal.submitTerminalAction).mock.calls.map(call => call[1]))
      .toEqual(['old write', 'replacement write'])
    inputs.input.forget('a1')
  })

  it('retains a possibly pasted composer after caller revocation and a rejected write until fresh evidence clears it', async () => {
    vi.useFakeTimers()
    let current = true, draft: 'pending' | 'clear' = 'pending'
    const run = deps(), writing = pending<TerminalActionResult>()
    run.deps.submission = { ...inlineSubmission, read: vi.fn(async () => ({ draft: draft === 'pending', composer: true, nativeDraft: draft })) }
    vi.mocked(run.deps.terminal.submitTerminalAction).mockImplementationOnce(async () => {
      await writing.promise
      throw new Error('reader failed after paste')
    })
    const inputs = createInput(run.deps)
    inputs.submitInput('a1', { content: 'uncertain write', deliveryId: 'uncertain', when: 'composer', current: () => current })
    await vi.advanceTimersByTimeAsync(0)
    inputs.submitInput('a1', { content: 'next write', deliveryId: 'next', when: 'composer' })
    current = false
    writing.resolve(ok)
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.deliveries.settled).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'uncertain', state: 'unknown' }))
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1)
    inputs.input.onTurnStarted('a1', 'uncertain write')
    await vi.advanceTimersByTimeAsync(0)
    expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1)
    expect(run.deps.terminal.keyTerminalAction).not.toHaveBeenCalled()
    draft = 'clear'
    inputs.input.onTurnStarted('a1', 'uncertain write')
    await vi.advanceTimersByTimeAsync(0)
    expect(vi.mocked(run.deps.terminal.submitTerminalAction).mock.calls.map(call => call[1]))
      .toEqual(['uncertain write', 'next write'])
    inputs.input.forget('a1')
  })

  it('lets an answer take control while correlated input waits on a question', async () => {
    vi.useFakeTimers()
    const run = deps(), inputs = createInput(run.deps)
    run.setPane(CLAUDE_PERMISSION)
    inputs.submitInput('a1', { content: 'waiting', deliveryId: 'waiting', when: 'composer' })
    await vi.advanceTimersByTimeAsync(0)
    const release = inputs.acquireTerminalControl('a1', { forAnswer: true })
    expect(release).toBeTypeOf('function')
    expect(run.deps.terminal.submitTerminalAction).not.toHaveBeenCalled()
    inputs.input.forget('a1')
    release!()
  })

  it('takes control of a pane only when both the queue and the terminal grant it, and gives both back', () => {
    const run = deps()
    const inputs = createInput(run.deps)
    const released: string[] = []
    const acquire = vi.spyOn(inputs.input, 'acquireControl')
    acquire.mockReturnValueOnce(null)
    expect(inputs.acquireTerminalControl('s1')).toBeNull()
    expect(acquire).toHaveBeenLastCalledWith('a1', undefined)
    acquire.mockReturnValueOnce(() => { released.push('input') })
    vi.mocked(run.deps.terminal.pinTerminalControl).mockReturnValueOnce(null)
    expect(inputs.acquireTerminalControl('a1', { forAnswer: true })).toBeNull()
    expect(released).toEqual(['input'])
    acquire.mockReturnValueOnce(() => { released.push('input') })
    vi.mocked(run.deps.terminal.pinTerminalControl).mockReturnValueOnce(() => { released.push('terminal') })
    const release = inputs.acquireTerminalControl('unknown-agent')!
    expect(acquire).toHaveBeenLastCalledWith('unknown-agent', undefined)
    release()
    expect(released).toEqual(['input', 'terminal', 'input'])
  })

  it('submits a message under the agent\'s id, adapting a slash command its engine lacks', () => {
    const inputs = createInput(deps().deps)
    const submit = vi.spyOn(inputs.input, 'submitInput').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    inputs.submitAgent('s1', 'hello', 'd1')
    inputs.submitAgent('cc', '/loop fix it')
    inputs.submitAgent('nobody', 'hi')
    expect(submit.mock.calls).toEqual([
      ['a1', { content: 'hello', deliveryId: 'd1', receipt: undefined, when: 'turn' }],
      ['cc', { content: 'fix it', deliveryId: undefined, receipt: undefined, when: 'composer' }],
      ['nobody', { content: 'hi', deliveryId: undefined, receipt: undefined, when: 'composer' }],
    ])
    expect(log.mock.calls.flat().filter((line) => String(line).includes('slash-command adapted'))).toHaveLength(1)
  })

  it('logs a held delivery once, not once for every retry of the same delivery id', () => {
    const inputs = createInput(deps().deps)
    vi.spyOn(inputs.input, 'submitInput').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    // The backend retries a held delivery every second under the same id.
    inputs.submitAgent('s1', 'hello', 'd1')
    inputs.submitAgent('s1', 'hello', 'd1')
    inputs.submitAgent('s1', 'hello', 'd2')
    // A person's own message has no delivery id and is logged every time, as before.
    inputs.submitAgent('s1', 'typed')

    expect(log.mock.calls.flat().filter((line) => String(line).includes(' recv · '))).toHaveLength(3)
    // The remembered ids are bounded: an id that has scrolled out is logged again rather than kept for the life
    // of the daemon (256 ids, the backend's own retry window).
    const before = log.mock.calls.flat().filter((line) => String(line).includes(' recv · ')).length
    for (let i = 0; i < 256; i++) inputs.submitAgent('s1', 'held', `bulk-${i}`)
    inputs.submitAgent('s1', 'hello', 'd1')
    const after = log.mock.calls.flat().filter((line) => String(line).includes(' recv · ')).length
    expect(after - before).toBe(257)
  })
})

describe('message', () => {
  afterEach(() => vi.restoreAllMocks())

  // The native-turn record that read it went with #3901: an input context a window still sends is taken and goes nowhere.
  it('writes a message that names an input context as any other, and passes the context on to nothing', async () => {
    const promptTyped = vi.fn(), run = deps({ promptTyped }), inputs = createInput(run.deps)
    inputs.messageRequest({ agentId: 'a1', content: 'Scoped composed input', inputContext: 'conversation-input-context' })
    await vi.waitFor(() => expect(promptTyped).toHaveBeenCalledOnce())
    expect(promptTyped.mock.calls[0]).toEqual([agents.get('a1'), READY_PANE, expect.any(Object)])
    inputs.input.forget('a1')
    const plain = vi.fn(), request = createMessageRequest(plain)
    request({ agentId: 'a1', content: 'Unscoped', inputContext: { user: 'untrusted' } })
    expect(plain.mock.calls).toEqual([['a1', 'Unscoped', undefined]])
    // An observer is optional.
    expect(await messageWriter(deps().deps)('a1', 'Without observer')).toEqual(ok)
  })

  it('writes what a person typed into the agent the frame names, and reads no tab an older window still names', () => {
    const typed = vi.fn()
    const inputs = createInput({ ...deps().deps, typed })
    const submit = vi.spyOn(inputs.input, 'submitInput').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    inputs.messageRequest({ content: 'hello', agentId: 's1', tabId: 'swarm-a' })
    expect(submit.mock.calls).toEqual([['a1', { content: 'hello', deliveryId: undefined, receipt: undefined, when: 'composer' }]])
    // The person sent it: a harness another agent started is theirs from then on (services/agentCleanup.ts).
    expect(typed).toHaveBeenCalledWith('s1')
  })

  it('names the agent by agent id or session id, and drops a frame with no text or no agent', () => {
    const submit = vi.fn()
    const message = createMessageRequest(submit)
    message({ content: 'hi', agentId: 'a1', sessionId: 's1' })
    message({ content: 'hi', sessionId: 's1' })
    message({ content: 'in a tab', agentId: 'a1', tabId: 'swarm-a' })
    message({ content: '', agentId: 'a1' })
    message({ content: 'nobody to type into' })
    expect(submit.mock.calls).toEqual([['a1', 'hi', undefined], ['s1', 'hi', undefined], ['a1', 'in a tab', undefined]])
  })

  it('hands what became of it to its measurement: a dropped frame is invalid, a kept one carries the receipt down', () => {
    const submit = vi.fn(), receipt = vi.fn()
    const message = createMessageRequest(submit)
    message({ content: '', agentId: 'a1' }, receipt)
    message({ content: 'nobody to type into' }, receipt)
    expect(receipt.mock.calls).toEqual([['invalid'], ['invalid']])
    message({ content: 'hi', agentId: 'a1' }, receipt)
    message({ content: 'scoped', agentId: 'a1', inputContext: 'conversation-input-context' }, receipt)
    expect(submit.mock.calls).toEqual([['a1', 'hi', receipt], ['a1', 'scoped', receipt]])
    expect(receipt).toHaveBeenCalledTimes(2)

    const inputs = createInput(deps().deps)
    const into = vi.spyOn(inputs.input, 'submitInput').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    inputs.messageRequest({ content: 'hello', agentId: 's1' }, receipt)
    inputs.messageRequest({ content: 'hello', agentId: 's1', inputContext: 'conversation-input-context' }, receipt)
    expect(into.mock.calls).toEqual([['a1', { content: 'hello', deliveryId: undefined, receipt, when: 'composer' }], ['a1', { content: 'hello', deliveryId: undefined, receipt, when: 'composer' }]])
  })
})

describe('every route a message takes to a pane', () => {
  afterEach(() => vi.restoreAllMocks())

  /** Each way a message reaches an agent's pane, and what it is told when the pane holds it back. */
  const asking = 'Claude Code is asking for permission. Answer it first, in the app or in its terminal, then send the message again.'
  const refused = (deliveryId: string, reason: string) => expect.objectContaining({ deliveryId, state: 'rejected', reason })
  const routes: Array<[string, string, (inputs: ReturnType<typeof createInput>) => void, (run: ReturnType<typeof deps>) => void]> = [
    ['the app', 'a1', (inputs) => inputs.messageRequest({ agentId: 'a1', content: 'from the app' }),
      (run) => expect(run.deps.clients.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', agentId: 'a1', payload: { message: asking } }))],
    ['the phone, through the relay\'s message frame', 'a1', (inputs) => inputs.messageRequest({ sessionId: 's1', content: 'from the phone', tabId: 'tab-1' }),
      (run) => expect(run.deps.clients.send).toHaveBeenCalledWith(expect.objectContaining({ type: 'error', agentId: 'a1', payload: { message: asking } }))],
    ['the orchestrator', 'a1', (inputs) => inputs.submitAgent('a1', 'from the orchestrator', 'orchestrator-1'),
      (run) => expect(run.deps.deliveries.settled).toHaveBeenCalledWith(refused('orchestrator-1', 'permission_open'))],
    ['Agent Messages', 'a1', (inputs) => inputs.submitAgent('a1', 'from a teammate', 'team:1'),
      (run) => expect(run.deps.deliveries.settled).toHaveBeenCalledWith(refused('team:1', 'team_waiting_user'))],
    ['the Device, to Claude Code', 'a1', (inputs) => inputs.submitInput('a1', { content: 'from the device', deliveryId: 'device-1', when: 'composer' }),
      (run) => expect(run.deps.deliveries.input).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'device-1', phase: 'waiting_for_user' }))],
    ['the Device, to an engine it queues for', 'cc', (inputs) => inputs.submitInput('cc', { content: 'from the device', deliveryId: 'device-2', when: 'composer' }),
      (run) => expect(run.deps.deliveries.settled).toHaveBeenCalledWith(refused('device-2', 'permission_open'))],
  ]

  it.each(routes)('%s: types nothing into a permission prompt, and says why', async (_route, agent, send, told) => {
    const run = deps()
    run.setPane(agent === 'cc' ? COMMANDCODE_PERMISSION : CLAUDE_PERMISSION)
    const inputs = createInput(run.deps)
    send(inputs)
    await vi.waitFor(() => told(run))
    expect(run.deps.terminal.submitTerminalAction).not.toHaveBeenCalled()
    inputs.input.forget(agent)
  })

  it.each(routes)('%s: reaches the pane when it is ready', async (_route, agent, send) => {
    const run = deps()
    const inputs = createInput(run.deps)
    send(inputs)
    await vi.waitFor(() => expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1))
    inputs.input.forget(agent)
  })

  it('has one writer: nothing in the daemon submits text to a pane but it', () => {
    // A route added later that called the terminal directly would type into a permission prompt.
    const root = new URL('../', import.meta.url).pathname
    const sources = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory()
      ? sources(join(dir, entry.name))
      : entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts') ? [join(dir, entry.name)] : [])
    const using = sources(root).filter((file) => readFileSync(file, 'utf8').includes('submitTerminalAction')).map((file) => file.slice(root.length))
    expect(using.sort()).toEqual(['core/input.ts', 'core/terminals/control.ts'])
    expect(readFileSync(join(root, 'core/input.ts'), 'utf8').match(/submitTerminalAction\(/g)).toHaveLength(1)
    expect(messageWriter).toBeTypeOf('function')
  })
})
