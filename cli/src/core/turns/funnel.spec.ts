import { afterEach, describe, expect, it, vi } from 'vitest'
import { deviceErrorText } from '../cardText.js'
import type { RegisteredSession } from '../../lib/registry.js'
import { createEventFunnel, funnelFor, type FunnelDeps } from './funnel.js'
import { createShortTurnGuard } from './shortTurnGuard.js'
import { createServiceLinks, type ServiceFrame } from '../serviceLinks.js'
import { createDeliveries } from '../deliveries.js'

type Event = Parameters<ReturnType<typeof funnelFor>>[1][number]
const started = (userMessage = 'go'): Event => ({ type: 'turn_started', payload: { userMessage } }) as Event
const text = (value = 'working on it', commentary = false): Event => ({ type: 'text_delta', payload: { content: value, ...(commentary ? { commentary: true as const } : {}) } })
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
    startHeartbeat: vi.fn(log('heartbeat')),
    questionWatcher: { start: vi.fn(log('questions start')), noteTurnStart: vi.fn(log('questions pre-turn')), stop: vi.fn(log('questions stop')) },
    mirror: { ingest: vi.fn(log('mirror')) },
    ...over,
  }
  return { deps, calls, funnel: funnelFor(deps), session }
}

describe('the event funnel', () => {
  afterEach(() => vi.restoreAllMocks())

  it('enqueues dispatch and started notices before a read response requested at the earlier app send point', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const wire: ServiceFrame[] = [], token = 't'.repeat(48)
    const links = createServiceLinks({ token, owned: { wifi: [] },
      answer: async () => ({ value: { agentId: 'a1', sessionId: 's1' } }) })
    const link = links.accept('wifi', token, { sendFrame: frame => { wire.push(frame); return true } }, vi.fn())!
    const deliveries = createDeliveries({ deliverers: new Set(['wifi']), submit: vi.fn(), cancel: () => false,
      tell: (service, event) => { links.notify(service, { type: 'service_event', payload: { kind: 'delivery', event } }) },
      tellInput: (service, event) => { links.notify(service, { type: 'service_event', payload: { kind: 'input', event } }) } })
    deliveries.ready()
    deliveries.answer('wifi', 'input', { version: 1, agentId: 'a1', text: 'go', deliveryId: 'd', when: 'composer' },
      { current: () => true, ownsRequest: () => false })
    deliveries.input({ agentId: 'a1', deliveryId: 'd', phase: 'dispatching', when: 'composer', sessionId: 's1', activity: { epoch: 'core', revision: 1 } })
    const f = setup('opencode', {
      clients: { send: () => link.receive({ type: 'service_query', payload: { query: 'resolve', id: 'a1', requestId: 'barrier' } }) },
      input: { onTurnStarted: () => deliveries.settled({ sessionId: 'a1', deliveryId: 'd', state: 'started' }), onTurnEnded: vi.fn() },
    })
    f.funnel('s1', [started()])
    expect(wire.map(frame => frame.payload?.kind)).toEqual(['input', 'delivery'])
    await vi.waitFor(() => expect(wire).toHaveLength(3))
    expect(wire[2]).toMatchObject({ type: 'service_query_result', payload: { requestId: 'barrier' } })
    link.closed()
  })

  it('carries original batch provenance at each existing app send point without delaying its side effects', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const f = setup()
    f.funnel('s1', [ended(), started('next')])
    const calls = vi.mocked(f.deps.clients.send).mock.calls as unknown as Array<[unknown, unknown]>
    expect(calls.map(call => call[1])).toEqual([
      { id: expect.any(Number), index: 0, count: 2 }, { id: expect.any(Number), index: 1, count: 2 },
    ])
    expect((calls[0][1] as { id: number }).id).toBe((calls[1][1] as { id: number }).id)
    expect(f.calls.indexOf('input ended')).toBeLessThan(f.calls.indexOf('send turn_started'))
    f.funnel('s1', [text()])
    expect((calls[2][1] as { id: number }).id).not.toBe((calls[0][1] as { id: number }).id)
  })

  it('tells of an agent working on each live turn start and progress, never on its end or a re-read', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const working = vi.fn()
    const { funnel } = setup('claude', { working })
    funnel('s1', [started(), text()])
    expect(working.mock.calls).toEqual([['a1'], ['a1']])
    working.mockClear()
    funnel('s1', [ended()])
    funnel('s1', [started(), text(), ended()], { replay: true })
    funnel('s1', [started(), text(), ended()], { resumed: true })
    expect(working).not.toHaveBeenCalled()
  })

  it('tells the short-turn guard of each live turn start and end, never of a re-read', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    let at = 0
    const shortTurns = createShortTurnGuard({ now: () => at, log: () => {} })
    const { funnel } = setup('claude', { shortTurns })
    for (let i = 0; i < 10; i++) { funnel('s1', [started(), ended()], { replay: true }); funnel('s1', [started(), ended()], { resumed: true }); at += 1_000 }
    expect(shortTurns.holding('s1')).toBe(0)
    for (let i = 0; i < 10; i++) { funnel('s1', [started()]); at += 1_000; funnel('s1', [ended()]) }
    expect(shortTurns.holding('s1')).toBe(30_000)
  })

  // A title an engine gives while its agent's last turn was a line typed for it alone never names it (core/agents/quietTitles.ts): that
  // stretch ends as the agent's next turn starts, told before the input can say a quiet delivery started the turn.
  it('tells the quiet titles of each live turn start, before the input hears it, never of a re-read', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const turnStarted = vi.fn()
    const { funnel, deps } = setup('claude', { quietTitles: { turnStarted } })
    funnel('s1', [started(), text(), ended()])
    expect(turnStarted.mock.calls).toEqual([['a1']])
    expect(turnStarted.mock.invocationCallOrder[0])
      .toBeLessThan((deps.input.onTurnStarted as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0])
    funnel('s1', [started(), ended()], { replay: true })
    funnel('s1', [started(), ended()], { resumed: true })
    expect(turnStarted).toHaveBeenCalledTimes(1)
  })

  it('sends the clients a shell result without its outputTail, and still feeds the commander mirror with it', () => {
    const sent: Array<{ payload: object }> = []
    const { funnel, deps } = setup('claude', { clients: { send: vi.fn((f: { payload: object }) => { sent.push(f) }) } as never })
    const end = { type: 'tool_end', payload: { id: 't1', tool: 'Bash', output: 'x', outputTail: 'tail', isError: false, summary: '' } } as Event
    funnel('s1', [end])
    expect(sent[0].payload).not.toHaveProperty('outputTail')
    expect((deps.mirror.ingest as ReturnType<typeof vi.fn>).mock.calls[0][0][0].payload.outputTail).toBe('tail')
  })

  it('fans a live turn out in its exact order: the app first, the recaps after the batch', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, calls } = setup()
    funnel('s1', [started(), text(), ended()])
    expect(calls).toEqual([
      'send turn_started', 'search',
      'input started', 'heartbeat', 'questions start', 'questions pre-turn',
      'send text_delta',
      'send turn_ended', 'search',
      'input ended', 'questions stop',
      'mirror',
    ])
  })

  it('marks a turn picked up at attach as replay', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, calls, deps } = setup()
    funnel('s1', [started()], { resumed: true })
    // Not a turn starting now: a dialog already up belongs to it.
    expect(calls).toEqual([
      'send turn_started', 'search',
      'input started', 'heartbeat', 'questions start',
      'mirror',
    ])
    const frame = vi.mocked(deps.clients.send).mock.calls[0][0] as Record<string, any>
    expect(frame.replay).toBe(true)
    expect(frame.payload.replay).toBe(true)
    expect(vi.mocked(deps.mirror.ingest).mock.calls[0][2]).toEqual({ replay: true })
  })

  it('re-reads a transcript as history with explicit replay metadata', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, calls, deps } = setup()
    funnel('s1', [started(), ended()], { replay: true })
    expect(calls).toContain('questions pre-turn')
    const end = vi.mocked(deps.clients.send).mock.calls[1][0] as Record<string, any>
    expect(end.replay).toBe(true)
  })

  it('keeps the prompt of the turn that started for the agent, replaces it at the next, and does not drop it when the turn ends', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const prompts = new Map<string, string>()
    const { funnel } = setup('claude', { prompts })
    funnel('s1', [started('Fix the login')])
    expect(prompts.get('a1')).toBe('Fix the login')
    // After the turn the agent is idle, and its summary falls back to the last prompt when it has no recap.
    funnel('s1', [ended()])
    expect(prompts.get('a1')).toBe('Fix the login')
    funnel('s1', [started('Now the logout')])
    expect(prompts.get('a1')).toBe('Now the logout')
    expect([...prompts.keys()]).toEqual(['a1'])
  })

  it('keeps only the first non-empty line of the prompt, capped, and forgets a blank one: the map stays small', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const prompts = new Map<string, string>()
    const { funnel } = setup('claude', { prompts })
    funnel('s1', [started(`\n\nFix the login\n${'pasted log line\n'.repeat(10_000)}`)])
    expect(prompts.get('a1')).toBe('Fix the login')
    funnel('s1', [started('x'.repeat(5_000))])
    expect(prompts.get('a1')).toHaveLength(400)
    funnel('s1', [started('  \n ')])
    expect(prompts.has('a1')).toBe(false)
  })

  it('runs with no prompt map as it did: a funnel not asked to keep prompts keeps none', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, calls } = setup()
    funnel('s1', [started('Fix the login')])
    expect(calls).toContain('input started')
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

  it('tells every screen the end of a turn a quiet delivery started is no one\'s news (Hachi\'s wake), and a re-read end is not marked', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const quietTurnOpen = vi.fn((_sessionId: string) => true)
    const { funnel, deps } = setup('claude', { quietTurnOpen })
    funnel('s1', [started('[harness] api @studio: done.')])
    funnel('s1', [ended(false)])
    funnel('s1', [ended(false)], { replay: true })
    const ends = vi.mocked(deps.clients.send).mock.calls.slice(1).map(([frame]) => frame as Record<string, any>)
    expect(ends.map((end) => end.subagent)).toEqual([true, undefined])
    expect(quietTurnOpen).toHaveBeenCalledWith('s1')
  })

  it('leaves turn-batch interpretation to the component and Command Code\'s question watcher running', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const native = setup('codex')
    native.funnel('s1', [ended(), started()])
    expect(native.calls.slice(0, 4)).toEqual(['send turn_ended', 'search', 'input ended', 'questions stop'])
    const commandcode = setup('commandcode')
    commandcode.funnel('s1', [ended()])
    expect(commandcode.calls).not.toContain('questions stop')
    expect(commandcode.calls).toContain('send turn_ended')
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
    // The full batch still reaches the component; the funnel does not interpret its native boundary.
    expect(run.calls).toContain('send turn_started')
    expect(String(log.mock.calls[1][0])).toContain('engine=claude')
  })

  it('ignores an empty batch and a session that is not active', () => {
    const { funnel, calls } = setup()
    funnel('s1', [])
    funnel('off', [started()])
    funnel('nobody', [started()])
    expect(calls).toEqual([])
  })

  it('works without search', () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { funnel, calls } = setup('claude', { search: null })
    funnel('s1', [started(), ended()])
    expect(calls).toEqual([
      'send turn_started', 'input started', 'heartbeat', 'questions start', 'questions pre-turn',
      'send turn_ended', 'input ended', 'questions stop',
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
