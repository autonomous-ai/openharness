import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceErrorText } from '../../lib/deviceErrors.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createEventFunnel, funnelFor, outsideConsumers, type FunnelDeps } from './funnel.js'

type Event = Parameters<ReturnType<typeof funnelFor>>[1][number]
const started = (userMessage = 'go'): Event => ({ type: 'turn_started', payload: { userMessage } }) as Event
const text = (value = 'working on it'): Event => ({ type: 'text_delta', payload: { content: value } })
const ended = (aborted = false): Event => ({ type: 'turn_ended', payload: { aborted } }) as Event

/**
 * Every collaborator writes to one log, so a test reads the order the funnel called them in, across all
 * of them — the order is the funnel's contract.
 */
function setup(engine = 'claude', over: Partial<FunnelDeps> = {}) {
  const calls: string[] = []
  const log = (entry: string) => () => { calls.push(entry) }
  const session = { agentId: 'a1', sessionId: 's1', engine, active: true } as RegisteredSession
  const deps: FunnelDeps = {
    bySession: (sessionId) => sessionId === 's1' ? session : sessionId === 'off' ? ({ ...session, active: false }) : undefined,
    tokenUsage: { changed: vi.fn(log('usage')) },
    agentIdFor: () => 'a1',
    turnActivity: { observe: vi.fn(), snapshot: vi.fn(() => undefined) },
    isSubagentSession: vi.fn(() => false),
    clients: { send: vi.fn((frame: { type: string }) => { calls.push(`send ${frame.type}`) }) },
    search: { touch: vi.fn(log('search')) },
    turnStartedAt: new Map(),
    input: { onTurnStarted: vi.fn(log('input started')), onTurnEnded: vi.fn(log('input ended')) },
    teams: { started: vi.fn(log('teams started')) },
    deviceInput: { onTurnStarted: vi.fn(log('deviceInput started')), onTurnEnded: vi.fn(log('deviceInput ended')) },
    device: () => ({ turnStarted: vi.fn(log('device started')), turnEnded: vi.fn(log('device ended')), stream: vi.fn(log('device stream')) }),
    startHeartbeat: vi.fn(log('heartbeat')),
    questionWatcher: { start: vi.fn(log('questions start')), noteTurnStart: vi.fn(log('questions pre-turn')), stop: vi.fn(log('questions stop')) },
    mirror: { ingest: vi.fn(log('mirror')) },
    ...over,
  }
  return { deps, calls, funnel: funnelFor(deps), session }
}

describe('the event funnel', () => {
  afterEach(() => vi.restoreAllMocks())

  it('carries on past a teams or device service that throws: every consumer after it still gets the event', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const boom = (what: string) => vi.fn(() => { throw new Error(`${what} unplugged`) })
    const { funnel, calls } = setup('claude', {
      teams: { started: boom('teams') },
      device: () => ({ turnStarted: boom('device'), turnEnded: boom('device'), stream: boom('device') }),
    })
    funnel('s1', [started(), text(), ended()])
    expect(calls).toEqual([
      'send turn_started', 'search',
      'input started', 'deviceInput started', 'heartbeat', 'questions start', 'questions pre-turn',
      'send text_delta',
      'send turn_ended', 'search',
      'deviceInput ended', 'input ended', 'questions stop',
      'mirror',
    ])
    // Once a minute per consumer: the devices failed three times and said so once.
    expect(error.mock.calls.map(([line]) => line)).toEqual(['[funnel] teams failed · teams unplugged', '[funnel] devices failed · device unplugged'])
  })


  it('fans a live turn out in its exact order: the app first, the recaps after the batch, the device stream last', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, calls } = setup()
    funnel('s1', [started(), text(), ended()])
    expect(calls).toEqual([
      'send turn_started', 'search',
      'input started', 'teams started', 'deviceInput started', 'device started', 'heartbeat', 'questions start', 'questions pre-turn',
      'send text_delta',
      'send turn_ended', 'search',
      'device ended', 'deviceInput ended', 'input ended', 'questions stop',
      'mirror', 'device stream',
    ])
  })

  it('marks a turn picked up at attach as such, and still streams it to the device', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, calls, deps } = setup()
    funnel('s1', [started()], { resumed: true })
    // Not a turn starting now: the teams do not count it, and a dialog already up belongs to it.
    expect(calls).toEqual([
      'send turn_started', 'search',
      'input started', 'deviceInput started', 'device started', 'heartbeat', 'questions start',
      'mirror', 'device stream',
    ])
    const frame = vi.mocked(deps.clients.send).mock.calls[0][0] as Record<string, any>
    expect(frame.replay).toBe(true)
    expect(frame.payload.replay).toBe(true)
    expect(vi.mocked(deps.mirror.ingest).mock.calls[0][2]).toEqual({ replay: true })
  })

  it('re-reads a transcript as history: no team count, and nothing streamed to the device', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, calls, deps } = setup()
    funnel('s1', [started(), ended()], { replay: true })
    expect(calls).not.toContain('teams started')
    expect(calls).not.toContain('device stream')
    expect(calls).toContain('questions pre-turn')
    const end = vi.mocked(deps.clients.send).mock.calls[1][0] as Record<string, any>
    expect(end.replay).toBe(true)
  })

  it('tells every screen a sub-agent\'s turn end is one, and times a live turn', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, deps } = setup('claude', { isSubagentSession: vi.fn(() => true) })
    funnel('s1', [started('a long one')])
    funnel('s1', [ended(true)])
    const end = vi.mocked(deps.clients.send).mock.calls[1][0] as Record<string, any>
    expect(end.subagent).toBe(true)
    expect(end.replay).toBeUndefined()
    expect(deps.turnStartedAt.has('s1')).toBe(false)
    expect(log.mock.calls.map(([line]) => String(line))).toEqual([
      expect.stringMatching(/started · engine=claude · bytes=10$/),
      expect.stringMatching(/ended · aborted \(interrupted\) · \d+ms$/),
    ])
  })

  it('leaves the device\'s input alone across a native turn boundary, and Command Code\'s question watcher running', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const native = setup('codex')
    native.funnel('s1', [ended(), started()])
    expect(native.calls.slice(0, 4)).toEqual(['send turn_ended', 'search', 'input ended', 'questions stop'])
    const commandcode = setup('commandcode')
    commandcode.funnel('s1', [ended()])
    expect(commandcode.calls).not.toContain('questions stop')
    expect(commandcode.calls).toContain('device ended')
  })

  it('carries the turn\'s activity, says when a turn ends without a start, and counts OpenCode\'s usage', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const run = setup('opencode')
    vi.mocked(run.deps.turnActivity.snapshot).mockReturnValue({ state: 'working' } as never)
    run.funnel('s1', [text(), ended()])
    expect(run.calls[0]).toBe('usage')
    expect((vi.mocked(run.deps.clients.send).mock.calls[0][0] as Record<string, any>).payload.activity).toEqual({ state: 'working' })
    expect(run.deps.turnActivity.observe).toHaveBeenCalledWith('s1', 'text_delta', false)
    expect(String(log.mock.calls[0][0])).toMatch(/ended$/)
  })

  it('finishes a batch whose session was forgotten while it was being delivered', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    let lookups = 0
    const run = setup('codex', {
      // Active when the batch arrives; gone from the next lookup on, as when a collaborator forgets it.
      bySession: () => lookups++ === 0 ? ({ agentId: 'a1', sessionId: 's1', engine: 'codex', active: true } as RegisteredSession) : undefined,
    })
    expect(() => run.funnel('s1', [ended(), started()])).not.toThrow()
    // Without its engine, a native turn boundary is not recognised, so the device hears the turn end.
    expect(run.calls).toContain('device ended')
    expect(String(log.mock.calls[1][0])).toContain('engine=claude')
  })

  it('ignores an empty batch and a session that is not active', () => {
    const { funnel, calls } = setup()
    funnel('s1', [])
    funnel('off', [started()])
    funnel('nobody', [started()])
    expect(calls).toEqual([])
  })

  it('works without search or a device service', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, calls } = setup('claude', { search: null, device: () => undefined })
    funnel('s1', [started(), ended()])
    expect(calls).toEqual([
      'send turn_started', 'input started', 'teams started', 'deviceInput started', 'heartbeat', 'questions start', 'questions pre-turn',
      'send turn_ended', 'deviceInput ended', 'input ended', 'questions stop',
      'mirror',
    ])
  })
})

describe('createEventFunnel', () => {
  afterEach(() => vi.restoreAllMocks())

  it('holds events until it is armed, delivers them in order, and is the same function after', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const funnel = createEventFunnel({ clients: { send: vi.fn(), sendCommander: vi.fn() }, agentIdFor: () => 'a1' })
    const emit = funnel.emit
    emit('s1', [started('first')])
    emit('s1', [])
    emit('s1', [text('second')], { replay: true })
    const { deps, calls } = setup()
    funnel.arm(deps)
    expect(calls.filter((call) => call.startsWith('send'))).toEqual(['send turn_started', 'send text_delta'])
    expect(vi.mocked(deps.mirror.ingest).mock.calls.map((call) => call[2])).toEqual([{ replay: false }, { replay: true }])
    emit('s1', [ended()])
    expect(calls.filter((call) => call.startsWith('send'))).toEqual(['send turn_started', 'send text_delta', 'send turn_ended'])
  })

  it('tells the app and, in the device\'s words, the dial when an engine aborts a turn', () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const clients = { send: vi.fn(), sendCommander: vi.fn() }
    const funnel = createEventFunnel({ clients, agentIdFor: () => 'a1' })
    funnel.announceTurnAborted('s1', 'devin', 'the model refused')
    funnel.announceTurnAborted('s1', 'commandcode', 'rate limited: retry in 60s', 'rate limited')
    expect(clients.send.mock.calls).toEqual([
      [{ type: 'error', agentId: 'a1', dbSessionId: 's1', payload: { message: 'the model refused' } }],
      [{ type: 'error', agentId: 'a1', dbSessionId: 's1', payload: { message: 'rate limited: retry in 60s' } }],
    ])
    expect(clients.sendCommander.mock.calls.map(([frame]) => frame.payload.text)).toEqual([
      deviceErrorText('the model refused', 'devin'),
      deviceErrorText('rate limited', 'commandcode'),
    ])
    expect(String(log.mock.calls[0][0])).toContain('aborted by devin error')
  })
})

describe('a consumer outside the core', () => {
  it('is logged at most once a minute, with how many failures went unsaid, and never stops the caller', () => {
    const lines: string[] = []
    let at = 0
    const outside = outsideConsumers((line) => lines.push(line), () => at)
    const ran: string[] = []
    outside('devices', () => { throw new Error('serial port gone') })
    at += 10_000
    outside('devices', () => { throw 'still gone' })
    outside('teams', () => { ran.push('teams') })
    at += 60_000
    outside('devices', () => { throw 'back and gone again' })
    at += 60_001
    outside('devices', () => { throw new Error('once more') })
    expect(ran).toEqual(['teams'])
    expect(lines).toEqual([
      '[funnel] devices failed · serial port gone',
      '[funnel] devices failed · back and gone again · 1 more since',
      '[funnel] devices failed · once more',
    ])
  })

  it('reports to the error log by default', () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    outsideConsumers()('teams', () => { throw new Error('x') })
    expect(error).toHaveBeenCalledWith('[funnel] teams failed · x')
    error.mockRestore()
  })
})
