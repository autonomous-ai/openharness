import { readInlineScreen } from '../testing/inlineScreen.js'
import { inlineSubmission } from '../testing/inlineSubmission.js'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandCodeNormalizer } from '../engines/commandcode/normalizer.js'
import type { AutonomousDeviceInput } from './deviceInput.js'
import { deviceErrorText } from './cardText.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { SessionInputDelivery } from '../lib/sessionInput.js'
import { TERMINAL_LEASE_REFUSED, type ProcessIdentity, type TerminalActionResult } from '../lib/terminalTypes.js'
import { CLAUDE_REWIND_LIST, CODEX_BROWSING_SCROLLBACK } from '../lib/__fixtures__/rewindPickers.js'
import { createInput, createMessageRequest, deviceInputDeps, heldScreen, messageWriter, sessionInputDeps, type InputDeps } from './input.js'
import { createShortTurnGuard } from './turns/shortTurnGuard.js'
import { createScreens } from './engines/screens.js'
import { screenFor } from '../engines/screens.js'
import { readerEngine } from '../engines/worker/protocol.js'
import { typesWhileBusy } from '../superTabs/inCore/deliveries.js'

const ok: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }
const fixture = (name: string) => readFileSync(new URL(`../lib/__fixtures__/${name}`, import.meta.url), 'utf8')
/** Claude Code asking to run a command, and Command Code the same: the Enter behind a paste approves. */
const CLAUDE_PERMISSION = fixture('permission-claude.txt')
const COMMANDCODE_PERMISSION = fixture('permission-commandcode.txt')
/** A Claude Code composer that is empty and idle: ready for a team write. */
const READY_PANE = '────────────\n❯\n────────────\n  ? for shortcuts'

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
  const normalizer = { openTurn: vi.fn((text: string) => [{ type: 'turn_started', text }]) }
  let pane: string | null = READY_PANE
  const base: InputDeps = {
    readScreen: readInlineScreen,
    submission: inlineSubmission,
    resolve: (id) => agents.get(id),
    byAgent: (agentId) => agents.get(agentId),
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
    },
    device: () => device,
    clients: { send: vi.fn(), sendCommander: vi.fn() },
    agentIdFor: (sessionId) => agents.get(sessionId)?.agentId ?? sessionId,
    commandcode: (sessionId) => sessionId === 'cc-s' ? normalizer as unknown as CommandCodeNormalizer : undefined,
    emit: vi.fn(),
    typesWhileBusy,
    ...over,
  }
  return { deps: base, calls, device, normalizer, setPane: (next: string | null) => { pane = next } }
}

/** A device pane lock that runs each write at once and remembers whose pane it was. */
const lock = (calls: string[]): Pick<AutonomousDeviceInput, 'legacyWrite'> => ({
  legacyWrite: <T,>(id: string, write: () => Promise<T>): Promise<T> => {
    calls.push(`lock ${id}`)
    return write()
  },
})

const delivery = (deliveryId: string) => ({ deliveryId }) as unknown as SessionInputDelivery

describe('the session input controller\'s dependencies', () => {
  afterEach(() => vi.restoreAllMocks())

  it.each(['a1', 'cx'])('types Swarm input into busy %s while retaining the Agent Messages hold', async id => {
    const t = deps(), wired = sessionInputDeps(t.deps, () => lock(t.calls))
    t.setPane(id === 'a1' ? 'Working (esc to interrupt)\n' + READY_PANE : '\n\u001b[1m›\u001b[0m \n\n  esc to interrupt')
    expect(await wired.beforeTeamWrite!(agents.get(id)!, 'team:service:superTabs:busy')).toBeNull()
    expect(await wired.injectTeam!(id, 'chat follow-up', 'team:service:superTabs:busy')).toBe(ok)
    expect(await wired.injectTeam!(id, 'peer message', 'team:peer')).toMatchObject({ dispatch: 'not_started', reason: 'team_waiting_idle' })
  })

  // HARNESS_SWARM=off: no maker's typed delivery is queued while the agent works; each waits for idle, as Agent Messages' do.
  it('waits for idle with every typed delivery when none is handed a busy queue', async () => {
    const t = deps({ typesWhileBusy: undefined }), wired = sessionInputDeps(t.deps, () => lock(t.calls))
    t.setPane('Working (esc to interrupt)\n' + READY_PANE)
    expect(await wired.injectTeam!('a1', 'chat follow-up', 'team:service:superTabs:busy')).toMatchObject({ dispatch: 'not_started', reason: 'team_waiting_idle' })
    expect(t.deps.terminal.submitTerminalAction).not.toHaveBeenCalled()
  })

  it.each([
    [null, 'team_waiting_unavailable'],
    [CLAUDE_PERMISSION, 'team_waiting_user'],
    ['Working (esc to interrupt)\n────────────\n❯ draft\n────────────', 'team_waiting_draft'],
    ['Working (esc to interrupt)\n────────────\n❯\n  human second line\n────────────', 'team_waiting_draft'],
  ])('keeps unsafe busy Swarm panes untouched (%s)', async (pane, reason) => {
    const t = deps(), wired = sessionInputDeps(t.deps, () => lock(t.calls))
    t.setPane(pane)
    expect(await wired.injectTeam!('a1', 'chat follow-up', 'team:service:superTabs:held')).toMatchObject({ dispatch: 'not_started', reason })
    expect(t.deps.terminal.submitTerminalAction).not.toHaveBeenCalled()
  })

  it('still checks authority and engine support for Swarm input', async () => {
    const t = deps(), wired = sessionInputDeps(t.deps, () => lock(t.calls))
    t.deps.deliveries.canWrite = () => false
    expect(await wired.injectTeam!('a1', 'chat', 'team:service:superTabs:control')).toMatchObject({ reason: 'team_waiting_control' })
    t.setPane('Working (esc to interrupt)')
    expect(await wired.injectTeam!('cc', 'chat', 'team:service:superTabs:unsupported')).toMatchObject({ reason: 'team_waiting_idle' })
  })

  it('requires a capture even when a screen reader returns its last reading', async () => {
    const t = deps({ readScreen: async () => screenFor('claude').inspect(READY_PANE) })
    t.setPane(null)
    const wired = sessionInputDeps(t.deps, () => lock(t.calls))
    expect(await wired.injectTeam!('a1', 'chat', 'team:service:superTabs:no-capture'))
      .toMatchObject({ dispatch: 'not_started', reason: 'team_waiting_unavailable' })
  })

  it('finds a session and checks its pane through what it was given', async () => {
    const { deps: given } = deps()
    const wired = sessionInputDeps(given, () => lock([]))
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
    const wired = sessionInputDeps(given, () => lock([]))
    expect(await wired.beforeTeamWrite!(agents.get('a1')!, 'team:service:superTabs:d1')).toBe('team_waiting_control')
    expect(given.terminal.captureTerminal).not.toHaveBeenCalled()
    expect(await wired.beforeTeamWrite!(agents.get('cx')!, 'team:service:superTabs:d2')).toBeNull()
    at += 30_000
    expect(await wired.beforeTeamWrite!(agents.get('a1')!, 'team:service:superTabs:d1')).toBeNull()
  })

  it('hands the controller the move gate when it was given one, and none otherwise', () => {
    const { deps: given } = deps()
    expect('moveGate' in sessionInputDeps(given, () => lock([]))).toBe(false)
    const moveGate = { held: () => false } as unknown as NonNullable<InputDeps['moveGate']>
    expect(sessionInputDeps({ ...given, moveGate }, () => lock([])).moveGate).toBe(moveGate)
  })

  it('tells the device of a delivery first, then its caller; its caller alone without a device', () => {
    const one = deps()
    sessionInputDeps(one.deps, () => lock([])).onDelivery!(delivery('d1'))
    expect(one.calls).toEqual(['device delivery d1', 'delivery settled d1'])
    const two = deps({ device: () => undefined })
    sessionInputDeps(two.deps, () => lock([])).onDelivery!(delivery('d2'))
    expect(two.calls).toEqual(['delivery settled d2'])
  })

  it('writes and keys through the device\'s pane lock', async () => {
    const { deps: given, calls } = deps()
    const wired = sessionInputDeps(given, () => lock(calls))
    expect(await wired.inject('a1', 'hello')).toBe(ok)
    expect(await wired.sendKey('a1', 'enter')).toBe(ok)
    expect(calls).toEqual(['lock a1', 'submit a1 hello', 'lock a1', 'key a1 enter'])
  })

  it('types a message only into a pane it has read in the pane\'s lock and found ready for one', async () => {
    const run = deps()
    const wired = sessionInputDeps(run.deps, () => lock(run.calls))
    run.setPane(CLAUDE_PERMISSION)
    expect(await wired.inject('a1', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'permission_open' })
    run.setPane(CLAUDE_REWIND_LIST)
    expect(await wired.inject('a1', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'rewind_picker_open' })
    run.setPane(CODEX_BROWSING_SCROLLBACK)
    expect(await wired.inject('cx', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'rewind_picker_open' })
    run.setPane(COMMANDCODE_PERMISSION)
    expect(await wired.inject('cc', 'hello')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'permission_open' })
    // Nothing written, each read inside the lock.
    expect(run.calls).toEqual(['lock a1', 'lock a1', 'lock cx', 'lock cc'])
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
    const wired = sessionInputDeps(run.deps, () => lock(run.calls))
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
    const wired = sessionInputDeps(run.deps, () => lock(run.calls))
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
    const wired = sessionInputDeps(run.deps, () => lock(run.calls))
    expect(await wired.beforeTeamWrite!(agents.get('a1')!)).toBe('team_waiting_unavailable')
    expect(await wired.inject('a1', 'hello')).toMatchObject({ dispatch: 'not_started', reason: 'screen_unreadable' })
    expect(await wired.injectTeam!('a1', 'hello', 'delivery')).toMatchObject({ dispatch: 'not_started', reason: 'team_waiting_unavailable' })
    const device = deviceInputDeps(run.deps, () => ({ acquireControl: vi.fn(), submit: vi.fn(), cancelDelivery: vi.fn() }))
    expect(await device.isAwaitingUser!(agents.get('a1')!)).toBe(true)
    expect(run.deps.terminal.submitTerminalAction).not.toHaveBeenCalled()
    expect(run.deps.terminal.keyTerminalAction).not.toHaveBeenCalled()
  })

  it('reports an error to the app and, in the device\'s words, to the dial', () => {
    const { deps: given } = deps()
    sessionInputDeps(given, () => lock([])).onError('s1', 'the pane is gone')
    expect(given.clients.send).toHaveBeenCalledWith({ type: 'error', agentId: 'a1', dbSessionId: 's1', payload: { message: 'the pane is gone' } })
    expect(given.clients.sendCommander).toHaveBeenCalledWith({
      type: 'commander_event', agentId: 'a1', dbSessionId: 's1',
      payload: { kind: 'error', text: deviceErrorText('the pane is gone', 'claude') },
    })
  })

  it('opens a Command Code turn on our own paste, and nobody else\'s', () => {
    const { deps: given, normalizer } = deps()
    const wired = sessionInputDeps(given, () => lock([]))
    for (const id of ['a1', 'nobody', 'cc-new', 'cc-none']) wired.onSubmitted!(id, 'hi')
    expect(given.emit).not.toHaveBeenCalled()
    wired.onSubmitted!('cc', 'hi')
    expect(normalizer.openTurn).toHaveBeenCalledWith('hi')
    expect(given.emit).toHaveBeenCalledWith('cc-s', [{ type: 'turn_started', text: 'hi' }])
  })
})

describe('the device input\'s dependencies', () => {
  it('reaches the terminal directly, its messages through the one writer', async () => {
    const { deps: given } = deps()
    const wired = deviceInputDeps(given, () => ({ acquireControl: vi.fn(), submit: vi.fn(), cancelDelivery: vi.fn() }))
    expect(wired.getSession('a1')?.sessionId).toBe('s1')
    expect(wired.validateRuntime).toBe(given.terminal.validateTerminal)
    expect(wired.sendKey).toBe(given.terminal.keyTerminalAction)
    expect(wired.capture).toBe(given.terminal.captureTerminal)
    // Its writes are read first, as every message's is.
    expect(await wired.inject('a1', 'hello')).toBe(ok)
    expect(given.terminal.captureTerminal).toHaveBeenCalledWith('a1')
  })

  it('waits for the person when the pane cannot be read or asks a question', async () => {
    const run = deps()
    const wired = deviceInputDeps(run.deps, () => ({ acquireControl: vi.fn(), submit: vi.fn(), cancelDelivery: vi.fn() }))
    run.setPane(null)
    expect(await wired.isAwaitingUser!(agents.get('a1')!)).toBe(true)
    run.setPane(READY_PANE)
    expect(await wired.isAwaitingUser!(agents.get('a1')!)).toBe(false)
  })

  it('waits for the person while anything a message is not typed into is open', async () => {
    const run = deps()
    const wired = deviceInputDeps(run.deps, () => ({ acquireControl: vi.fn(), submit: vi.fn(), cancelDelivery: vi.fn() }))
    run.setPane(CLAUDE_PERMISSION)
    expect(await wired.isAwaitingUser!(agents.get('a1')!)).toBe(true)
    run.setPane(CLAUDE_REWIND_LIST)
    expect(await wired.isAwaitingUser!(agents.get('a1')!)).toBe(true)
    run.setPane(CODEX_BROWSING_SCROLLBACK)
    expect(await wired.isAwaitingUser!(agents.get('cx')!)).toBe(true)
  })

  it('hands queued input to the controller, answering control included', () => {
    const { deps: given } = deps()
    const controller = { acquireControl: vi.fn(() => null), submit: vi.fn(), cancelDelivery: vi.fn(() => true) }
    const wired = deviceInputDeps(given, () => controller)
    wired.acquireControl('a1')
    wired.legacySubmit('a1', 'hi', 'd1')
    expect(wired.legacyCancel('d1')).toBe(true)
    expect(controller.acquireControl).toHaveBeenCalledWith('a1', { forAnswer: true })
    expect(controller.submit).toHaveBeenCalledWith('a1', 'hi', 'd1')
    expect(controller.cancelDelivery).toHaveBeenCalledWith('d1')
  })

  it('tells the device service what happened, when there is one', () => {
    const run = deps()
    const wired = deviceInputDeps(run.deps, () => ({ acquireControl: vi.fn(), submit: vi.fn(), cancelDelivery: vi.fn() }))
    const status = { agentId: 'a1' } as unknown as Parameters<NonNullable<typeof wired.onInputStatus>>[0]
    wired.onDelivery(delivery('d1'))
    wired.onDispatch!('a1', 'd1', 'hi')
    wired.onDispatch!('nobody', 'd2', 'hi')
    wired.onInputStatus(status)
    wired.onForget!('a1')
    expect(run.device.delivery).toHaveBeenCalledTimes(1)
    expect(run.device.inputDispatched.mock.calls).toEqual([['a1', 'd1', 'hi', 's1'], ['nobody', 'd2', 'hi', undefined]])
    expect(run.device.inputStatus).toHaveBeenCalledWith(status)
    expect(run.device.agentGone).toHaveBeenCalledWith('a1')
    const none = deviceInputDeps(deps({ device: () => undefined }).deps, () => ({ acquireControl: vi.fn(), submit: vi.fn(), cancelDelivery: vi.fn() }))
    expect(() => {
      none.onDelivery(delivery('d3'))
      none.onDispatch!('a1', 'd3', 'hi')
      none.onInputStatus(status)
      none.onForget!('a1')
    }).not.toThrow()
  })
})

describe('createInput', () => {
  afterEach(() => vi.restoreAllMocks())

  it('wires the two controllers to each other: a queued write takes the device lock, a device answer takes queue control', async () => {
    const run = deps()
    const inputs = createInput(run.deps)
    const lockWrite = vi.spyOn(inputs.deviceInput, 'legacyWrite')
    const acquire = vi.spyOn(inputs.input, 'acquireControl')
    // What each controller was given (its constructor's dependencies) reaches the other one.
    const given = (controller: object) => (controller as unknown as { deps: Record<string, (...args: unknown[]) => unknown> }).deps
    expect(await given(inputs.input).inject('a1', 'hello')).toBe(ok)
    expect(lockWrite).toHaveBeenCalledWith('a1', expect.any(Function))
    const release = given(inputs.deviceInput).acquireControl('a1') as (() => void) | null
    expect(acquire).toHaveBeenCalledWith('a1', { forAnswer: true })
    expect(release).toBeTypeOf('function')
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
    const submit = vi.spyOn(inputs.input, 'submit').mockImplementation(() => {})
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    inputs.submitAgent('s1', 'hello', 'd1')
    inputs.submitAgent('cc', '/loop fix it')
    inputs.submitAgent('nobody', 'hi')
    expect(submit.mock.calls).toEqual([
      ['a1', 'hello', 'd1'],
      ['cc', 'fix it', undefined],
      ['nobody', 'hi', undefined],
    ])
    expect(log.mock.calls.flat().filter((line) => String(line).includes('slash-command adapted'))).toHaveLength(1)
  })
})

describe('message', () => {
  afterEach(() => vi.restoreAllMocks())

  it('carries a bounded opaque context with the actual composed message, without treating it as identity', async () => {
    const promptTyped = vi.fn(), run = deps({ promptTyped }), inputs = createInput(run.deps)
    const context = 'conversation-input-context'
    inputs.messageRequest({ agentId: 'a1', content: 'Scoped composed input', inputContext: context })
    await vi.waitFor(() => expect(promptTyped).toHaveBeenCalledWith(agents.get('a1'), READY_PANE, expect.any(Object), context))
    inputs.input.forget('a1')
    const plain = vi.fn(), request = createMessageRequest(plain)
    request({ agentId: 'a1', content: 'Unscoped', inputContext: { user: 'untrusted' } })
    expect(plain).toHaveBeenCalledWith('a1', 'Unscoped')
    // An observer is optional; a scoped message still uses the original writer.
    expect(await messageWriter(deps().deps)('a1', 'Without observer', undefined, context)).toEqual(ok)
  })

  it('writes what a person typed into the agent the frame names, and reads no tab an older window still names', () => {
    const typed = vi.fn()
    const inputs = createInput({ ...deps().deps, typed })
    const submit = vi.spyOn(inputs.input, 'submit').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    inputs.messageRequest({ content: 'hello', agentId: 's1', tabId: 'swarm-a' })
    expect(submit.mock.calls).toEqual([['a1', 'hello', undefined]])
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
    expect(submit.mock.calls).toEqual([['a1', 'hi'], ['s1', 'hi'], ['a1', 'in a tab']])
  })

  it('hands what became of it to its measurement: a dropped frame is invalid, a kept one carries the receipt down', () => {
    const submit = vi.fn(), receipt = vi.fn()
    const message = createMessageRequest(submit)
    message({ content: '', agentId: 'a1' }, receipt)
    message({ content: 'nobody to type into' }, receipt)
    expect(receipt.mock.calls).toEqual([['invalid'], ['invalid']])
    message({ content: 'hi', agentId: 'a1' }, receipt)
    message({ content: 'scoped', agentId: 'a1', inputContext: 'conversation-input-context' }, receipt)
    expect(submit.mock.calls).toEqual([['a1', 'hi', undefined, receipt], ['a1', 'scoped', 'conversation-input-context', receipt]])
    expect(receipt).toHaveBeenCalledTimes(2)

    const inputs = createInput(deps().deps)
    const into = vi.spyOn(inputs.input, 'submit').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    inputs.messageRequest({ content: 'hello', agentId: 's1' }, receipt)
    inputs.messageRequest({ content: 'hello', agentId: 's1', inputContext: 'conversation-input-context' }, receipt)
    expect(into.mock.calls).toEqual([['a1', 'hello', undefined, undefined, receipt], ['a1', 'hello', undefined, 'conversation-input-context', receipt]])
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
    ['the Device, to Claude Code', 'a1', (inputs) => inputs.deviceInput.submit('a1', 'from the device', 'device-1'),
      (run) => expect(run.device.inputStatus).toHaveBeenCalledWith(expect.objectContaining({ deliveryId: 'device-1', phase: 'waiting_for_user' }))],
    ['the Device, to an engine it queues for', 'cc', (inputs) => inputs.deviceInput.submit('cc', 'from the device', 'device-2'),
      (run) => expect(run.device.delivery).toHaveBeenCalledWith(refused('device-2', 'permission_open'))],
  ]

  it.each(routes)('%s: types nothing into a permission prompt, and says why', async (_route, agent, send, told) => {
    const run = deps()
    run.setPane(agent === 'cc' ? COMMANDCODE_PERMISSION : CLAUDE_PERMISSION)
    const inputs = createInput(run.deps)
    send(inputs)
    await vi.waitFor(() => told(run))
    expect(run.deps.terminal.submitTerminalAction).not.toHaveBeenCalled()
    inputs.deviceInput.forget(agent)
    inputs.input.forget(agent)
  })

  it.each(routes)('%s: reaches the pane when it is ready', async (_route, agent, send) => {
    const run = deps()
    const inputs = createInput(run.deps)
    send(inputs)
    await vi.waitFor(() => expect(run.deps.terminal.submitTerminalAction).toHaveBeenCalledTimes(1))
    inputs.deviceInput.forget(agent)
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
