import { afterEach, describe, expect, it, vi } from 'vitest'
import type { CommandCodeNormalizer } from '../engines/commandcode/normalizer.js'
import type { AutonomousDeviceInput } from '../lib/autonomous-device/input.js'
import { deviceErrorText } from '../lib/deviceErrors.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { SessionInputDelivery } from '../lib/sessionInput.js'
import type { TerminalActionResult } from '../lib/terminalTypes.js'
import { createInput, deviceInputDeps, sessionInputDeps, type InputDeps } from './input.js'

const ok: TerminalActionResult = { state: 'succeeded', dispatch: 'executed' }
/** A Claude Code composer that is empty and idle: ready for a team write. */
const READY_PANE = '────────────\n❯\n────────────\n  ? for shortcuts'

const agents = new Map<string, RegisteredSession>([
  ['a1', { agentId: 'a1', sessionId: 's1', engine: 'claude' } as RegisteredSession],
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
    resolve: (id) => agents.get(id),
    byAgent: (agentId) => agents.get(agentId),
    terminal: {
      captureTerminal: vi.fn(async () => pane),
      validateTerminal: vi.fn(async () => true),
      submitTerminalAction: vi.fn(async (id: string, text: string) => { calls.push(`submit ${id} ${text}`); return ok }),
      keyTerminalAction: vi.fn(async (id: string, key: string) => { calls.push(`key ${id} ${key}`); return ok }),
      pinTerminalControl: vi.fn(() => () => { calls.push('unpin') }),
    },
    teams: {
      prepare: vi.fn(() => () => {}),
      delivery: vi.fn((event: SessionInputDelivery) => { calls.push(`teams delivery ${event.deliveryId}`) }),
      canWrite: vi.fn(() => true),
    },
    device: () => device,
    clients: { send: vi.fn(), sendCommander: vi.fn() },
    agentIdFor: (sessionId) => agents.get(sessionId)?.agentId ?? sessionId,
    commandcode: (sessionId) => sessionId === 'cc-s' ? normalizer as unknown as CommandCodeNormalizer : undefined,
    emit: vi.fn(),
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

  it('scopes a prompt, finds a session and checks its pane through what it was given', async () => {
    const { deps: given } = deps()
    const wired = sessionInputDeps(given, () => lock([]))
    wired.beforeSubmit!('a1', 'hello', 'tab', 'd1')
    expect(given.teams.prepare).toHaveBeenCalledWith('a1', 'hello', 'tab', 'd1')
    expect(wired.getSession('s1')?.agentId).toBe('a1')
    expect(wired.validateRuntime).toBe(given.terminal.validateTerminal)
    expect(wired.capture).toBe(given.terminal.captureTerminal)
    expect(await wired.beforeTeamWrite!(agents.get('a1')!)).toBeNull()
  })

  it('tells the device of a delivery first, then the teams; the teams alone without a device', () => {
    const one = deps()
    sessionInputDeps(one.deps, () => lock([])).onDelivery!(delivery('d1'))
    expect(one.calls).toEqual(['device delivery d1', 'teams delivery d1'])
    const two = deps({ device: () => undefined })
    sessionInputDeps(two.deps, () => lock([])).onDelivery!(delivery('d2'))
    expect(two.calls).toEqual(['teams delivery d2'])
  })

  it('writes and keys through the device\'s pane lock', async () => {
    const { deps: given, calls } = deps()
    const wired = sessionInputDeps(given, () => lock(calls))
    expect(await wired.inject('a1', 'hello')).toBe(ok)
    expect(await wired.sendKey('a1', 'enter')).toBe(ok)
    expect(calls).toEqual(['lock a1', 'submit a1 hello', 'lock a1', 'key a1 enter'])
  })

  it('writes a team turn only into a ready pane whose delivery still holds control', async () => {
    const run = deps()
    const wired = sessionInputDeps(run.deps, () => lock(run.calls))
    expect(await wired.injectTeam!('nobody', 'hi', 'd1')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'team_waiting_unavailable' })
    run.setPane(null)
    expect(await wired.injectTeam!('a1', 'hi', 'd1')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'team_waiting_unavailable' })
    run.setPane(READY_PANE)
    vi.mocked(run.deps.teams.canWrite).mockReturnValueOnce(false)
    expect(await wired.injectTeam!('a1', 'hi', 'd1')).toEqual({ state: 'failed', dispatch: 'not_started', reason: 'team_waiting_control' })
    expect(await wired.injectTeam!('a1', 'hi', 'd1')).toBe(ok)
    expect(run.calls.filter((call) => call.startsWith('submit'))).toEqual(['submit a1 hi'])
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
  it('reaches the terminal directly', async () => {
    const { deps: given } = deps()
    const wired = deviceInputDeps(given, () => ({ acquireControl: vi.fn(), submit: vi.fn(), cancelDelivery: vi.fn() }))
    expect(wired.getSession('a1')?.sessionId).toBe('s1')
    expect(wired.validateRuntime).toBe(given.terminal.validateTerminal)
    expect(wired.inject).toBe(given.terminal.submitTerminalAction)
    expect(wired.sendKey).toBe(given.terminal.keyTerminalAction)
    expect(wired.capture).toBe(given.terminal.captureTerminal)
  })

  it('waits for the person when the pane cannot be read or asks a question', async () => {
    const run = deps()
    const wired = deviceInputDeps(run.deps, () => ({ acquireControl: vi.fn(), submit: vi.fn(), cancelDelivery: vi.fn() }))
    run.setPane(null)
    expect(await wired.isAwaitingUser!(agents.get('a1')!)).toBe(true)
    run.setPane(READY_PANE)
    expect(await wired.isAwaitingUser!(agents.get('a1')!)).toBe(false)
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
    inputs.submitAgent('s1', 'hello', 'd1', 'tab')
    inputs.submitAgent('cc', '/loop fix it')
    inputs.submitAgent('nobody', 'hi')
    expect(submit.mock.calls).toEqual([
      ['a1', 'hello', 'd1', 'tab'],
      ['cc', 'fix it', undefined, undefined],
      ['nobody', 'hi', undefined, undefined],
    ])
    expect(log.mock.calls.flat().filter((line) => String(line).includes('slash-command adapted'))).toHaveLength(1)
  })
})
