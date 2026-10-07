import { describe, expect, it, vi } from 'vitest'
import { createRecapsLink, RECAPS_BUFFER_LIMIT } from './recapsLink.js'

const watchers = { device: true, active: false }
const s1 = { sessionId: 's1', agentId: 'a1' }

function setup() {
  let buffered = 0
  let clock = 1_000_000
  const deps = {
    notify: vi.fn(() => true),
    buffered: vi.fn(() => buffered),
    call: vi.fn(async (_type: string, _payload: Record<string, unknown>): Promise<Record<string, unknown>> => ({ cards: [] })),
    clients: { turnCard: vi.fn(), turnSummary: vi.fn() },
    lastTurn: vi.fn(async (sessionId: string) => (sessionId === 's1' ? { assistantText: 'done', userMessage: 'go' } : null)),
    log: vi.fn(),
    now: () => clock,
  }
  const link = createRecapsLink(deps)
  return { deps, link, back: (bytes: number) => { buffered = bytes }, later: (ms: number) => { clock += ms } }
}

describe('the recaps in their own process, as the core sees them', () => {
  it('tells each lifecycle event as a notification it never waits on, holding a purge and a rebound until heard', () => {
    const { deps, link } = setup()
    link.port.lifecycle({ kind: 'events', session: s1, events: [], replay: false }, watchers)
    link.port.lifecycle({ kind: 'purged', sessionId: 's1' }, watchers)
    link.port.lifecycle({ kind: 'rebound', from: 's1', to: 's2' }, watchers)
    expect(deps.notify.mock.calls).toEqual([
      [{ type: 'service_event', payload: { kind: 'lifecycle', event: { kind: 'events', session: s1, events: [], replay: false }, watchers } }, {}],
      [{ type: 'service_event', payload: { kind: 'lifecycle', event: { kind: 'purged', sessionId: 's1' }, watchers } }, { untilDelivered: true }],
      [{ type: 'service_event', payload: { kind: 'lifecycle', event: { kind: 'rebound', from: 's1', to: 's2' }, watchers } }, { untilDelivered: true }],
    ])
  })

  it('drops what would pile up on a process that reads nothing, says so once a minute, and never a purge', () => {
    const { deps, link, back, later } = setup()
    back(RECAPS_BUFFER_LIMIT + 1)
    for (let i = 0; i < 3; i++) link.port.lifecycle({ kind: 'beat', session: s1, working: true }, watchers)
    link.port.lifecycle({ kind: 'purged', sessionId: 's1' }, watchers)
    expect(deps.notify).toHaveBeenCalledTimes(1)
    expect(deps.log.mock.calls).toEqual([["[recaps] the recaps' process is not reading: 1 turn event(s) dropped; those turns have no recap"]])
    later(60_000)
    link.port.lifecycle({ kind: 'stopped', sessionId: 's1' }, watchers)
    expect(deps.log.mock.calls.at(-1)).toEqual(["[recaps] the recaps' process is not reading: 3 turn event(s) dropped; those turns have no recap"])
    back(0)
    link.port.lifecycle({ kind: 'stopped', sessionId: 's1' }, watchers)
    expect(deps.notify).toHaveBeenCalledTimes(2)
  })

  it('answers what the core reads from what the process last said of each session, and forgets a purge at once', () => {
    const { link } = setup()
    expect(link.port.recaps('s1')).toBeNull()
    link.notice({ kind: 'recaps', sessionId: 's1', recaps: { latest: 'r\n\nb', history: ['r\n\nb', 7], fullTexts: ['all of it'], asks: ['why?'], busy: true } })
    expect(link.port.recaps('s1')).toEqual({ latest: 'r\n\nb', history: ['r\n\nb'], fullTexts: ['all of it'], asks: ['why?'], busy: true })
    // Whatever is missing reads as nothing held.
    link.notice({ kind: 'recaps', sessionId: 's2', recaps: { history: 'no' } })
    expect(link.port.recaps('s2')).toEqual({ latest: null, history: [], fullTexts: [], asks: [], busy: false })
    link.notice({ kind: 'recaps', sessionId: 's2', recaps: null })
    expect(link.port.recaps('s2')).toBeNull()
    link.port.lifecycle({ kind: 'purged', sessionId: 's1' }, watchers)
    expect(link.port.recaps('s1')).toBeNull()
    // Not a session's recaps: ignored.
    link.notice({ kind: 'recaps', sessionId: 3, recaps: {} })
    expect(link.port.recaps('3')).toBeNull()
  })

  it('sends the process\'s cards and recaps on through the core API, which checks their types', () => {
    const { deps, link } = setup()
    const card = { type: 'commander_event', agentId: 'a1', dbSessionId: 's1', payload: { kind: 'done' } }
    link.notice({ kind: 'card', frame: card })
    link.notice({ kind: 'summary', frame: { type: 'turn_summary', payload: {} } })
    link.notice({ kind: 'card' })
    link.notice({ kind: 'summary', frame: 'x' })
    link.notice({ kind: 'other', frame: card })
    expect(deps.clients.turnCard.mock.calls).toEqual([[card]])
    expect(deps.clients.turnSummary.mock.calls).toEqual([[{ type: 'turn_summary', payload: {} }]])
  })

  it('reads a turn\'s final answer for the process, and answers nothing else', async () => {
    const { link } = setup()
    expect(await link.answer('lastTurn', { sessionId: 's1' })).toEqual({ turn: { assistantText: 'done', userMessage: 'go' } })
    expect(await link.answer('lastTurn', { sessionId: 's9' })).toEqual({ turn: null })
    expect(await link.answer('lastTurn', {})).toEqual({ error: 'UNKNOWN_QUERY' })
    expect(await link.answer('agents', {})).toEqual({ error: 'UNKNOWN_QUERY' })
  })

  it('asks the process for the cards of every turn still at work, and takes none it cannot read', async () => {
    const { deps, link } = setup()
    const card = { type: 'commander_event', agentId: 'a1', dbSessionId: 's1', payload: { kind: 'processing', text: 'Processing' } }
    deps.call.mockResolvedValueOnce({ cards: [card, null, 'x'] })
    expect(await link.port.liveCards()).toEqual([card])
    expect(deps.call).toHaveBeenCalledWith('liveCards', {})
    // Down, or answering something else: no card.
    deps.call.mockResolvedValueOnce({ error: 'SERVICE_UNAVAILABLE', service: 'recaps', retryable: true })
    expect(await link.port.liveCards()).toEqual([])
  })

  it('keeps no card busy once the process is gone', () => {
    const { link } = setup()
    link.notice({ kind: 'recaps', sessionId: 's1', recaps: { history: ['r'], busy: true } })
    link.notice({ kind: 'recaps', sessionId: 's2', recaps: { history: ['q'], busy: false } })
    link.disconnected()
    expect(link.port.recaps('s1')).toMatchObject({ history: ['r'], busy: false })
    expect(link.port.recaps('s2')).toMatchObject({ history: ['q'], busy: false })
  })

  it('says it to the daemon\'s log unless told otherwise', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const link = createRecapsLink({ notify: vi.fn(() => true), buffered: () => RECAPS_BUFFER_LIMIT + 1, call: vi.fn(), clients: { turnCard: vi.fn(), turnSummary: vi.fn() }, lastTurn: vi.fn() })
    link.port.lifecycle({ kind: 'stopped', sessionId: 's1' }, watchers)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
  })
})
