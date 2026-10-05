import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createServiceLinks, HELD_MAX, type ServiceFrame } from './serviceLinks.js'

const TOKEN = 'a'.repeat(48)
const ASKER = { local: false, owner: true }

function sink(accepting = true) {
  const sent: ServiceFrame[] = []
  return { sent, sendFrame: vi.fn((frame: ServiceFrame) => { sent.push(frame); return accepting }) }
}

describe('service links', () => {
  let ids = 0
  let lines: string[]
  const make = (over: Partial<Parameters<typeof createServiceLinks>[0]> = {}) => createServiceLinks({
    token: TOKEN,
    owned: { search: ['session_search', 'session_tail'] },
    answer: (service, query) => ({ service, query, agents: [] }),
    timeoutMs: 5_000,
    log: (line) => lines.push(line),
    newId: () => `route-${++ids}`,
    ...over,
  })

  beforeEach(() => { vi.useFakeTimers(); ids = 0; lines = [] })
  afterEach(() => vi.useRealTimers())

  it('lets in only a service it runs out of process, with the master\'s token', () => {
    const links = make()
    expect(links.accept('search', 'wrong-token-of-the-same-length-xxxxxxxxxxxxxxxx', sink(), vi.fn())).toBeNull()
    expect(links.accept('search', 'short', sink(), vi.fn())).toBeNull()
    expect(links.accept('devices', TOKEN, sink(), vi.fn())).toBeNull()
    expect(links.accept('toString', TOKEN, sink(), vi.fn())).toBeNull()
    expect(links.connected('search')).toBe(false)
    expect(links.accept('search', TOKEN, sink(), vi.fn())).not.toBeNull()
    expect(links.connected('search')).toBe(true)
    expect(lines.filter((line) => line.includes('refused'))).toHaveLength(4)
    // No token at all (a core no master started): no service may connect.
    expect(make({ token: undefined }).accept('search', TOKEN, sink(), vi.fn())).toBeNull()
  })

  it('routes a request to its service and relays the answer under the asker\'s own request', async () => {
    const links = make()
    const search = sink()
    const link = links.accept('search', TOKEN, search, vi.fn())!
    const reply = vi.fn()
    // Who asked goes beside the payload, so a payload naming its own asker stands for nothing.
    expect(links.route('session_search', { query: 'zebra', requestId: 'client-1', asker: { local: true } }, ASKER, reply)).toBe(true)
    expect(search.sent).toEqual([{ type: 'session_search', payload: { query: 'zebra', requestId: 'route-1', asker: { local: true } }, asker: ASKER }])
    // Answers that are not this request's are ignored: another type, an unknown id, no id.
    link.receive({ type: 'session_tail_result', payload: { requestId: 'route-1', rows: [] } })
    link.receive({ type: 'session_search_result', payload: { requestId: 'route-9', hits: [] } })
    link.receive({ type: 'session_search_result' })
    expect(reply).not.toHaveBeenCalled()
    link.receive({ type: 'session_search_result', payload: { requestId: 'route-1', hits: ['one'] } })
    expect(reply).toHaveBeenCalledWith({ hits: ['one'] })
    // Answered once.
    link.receive({ type: 'session_search_result', payload: { requestId: 'route-1', hits: ['again'] } })
    expect(reply).toHaveBeenCalledOnce()
    // What no service owns is the core's own.
    expect(links.route('agents_list', {}, ASKER, reply)).toBe(false)
  })

  it('answers SERVICE_UNAVAILABLE at once while the service is down, and when it cannot be sent to', () => {
    const links = make()
    const reply = vi.fn()
    expect(links.route('session_tail', {}, ASKER, reply)).toBe(true)
    expect(reply).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
    links.accept('search', TOKEN, sink(false), vi.fn())
    const again = vi.fn()
    links.route('session_tail', {}, ASKER, again)
    expect(again).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
  })

  it('answers SERVICE_UNAVAILABLE when the service does not answer in time', () => {
    const links = make()
    links.accept('search', TOKEN, sink(), vi.fn())
    const reply = vi.fn()
    links.route('session_search', {}, ASKER, reply)
    vi.advanceTimersByTime(4_999)
    expect(reply).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(reply).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
  })

  it('answers what was waiting on a service that goes, and lets a newer connection replace an older one', () => {
    const links = make({ owned: { search: ['session_search'], devices: ['harness_devices_list'] } })
    links.accept('devices', TOKEN, sink(), vi.fn())
    const elsewhere = vi.fn()
    links.route('harness_devices_list', {}, ASKER, elsewhere)
    const closeOld = vi.fn()
    const old = links.accept('search', TOKEN, sink(), closeOld)!
    const waiting = vi.fn()
    links.route('session_search', {}, ASKER, waiting)
    const newer = links.accept('search', TOKEN, sink(), vi.fn())!
    expect(closeOld).toHaveBeenCalledWith(4409, 'replaced by a newer connection')
    // The old connection's end does not take the newer one with it.
    old.closed()
    expect(links.connected('search')).toBe(true)
    expect(waiting).not.toHaveBeenCalled()
    const pending = vi.fn()
    links.route('session_search', {}, ASKER, pending)
    newer.closed()
    expect(links.connected('search')).toBe(false)
    expect(pending).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
    // What waits on another service is that service's business.
    expect(elsewhere).not.toHaveBeenCalled()
    expect(lines).toContain('[services] search disconnected')
  })

  it('answers a service\'s questions, and says when one could not be answered', async () => {
    const links = make({
      answer: (_service, query) => {
        if (query === 'boom') throw new Error('no')
        return Promise.resolve({ agents: [{ agentId: 'a' }] })
      },
    })
    const search = sink()
    const link = links.accept('search', TOKEN, search, vi.fn())!
    link.receive({ type: 'service_query', payload: { requestId: 'q1', query: 'agents' } })
    link.receive({ type: 'service_query', payload: { requestId: 'q2', query: 'boom' } })
    link.receive({ type: 'service_query', payload: { requestId: 'q3', query: 7 } })
    await vi.waitFor(() => expect(search.sent).toHaveLength(3))
    expect(search.sent).toEqual(expect.arrayContaining([
      { type: 'service_query_result', payload: { agents: [{ agentId: 'a' }], requestId: 'q1' } },
      { type: 'service_query_result', payload: { error: 'QUERY_FAILED', requestId: 'q2' } },
      { type: 'service_query_result', payload: { agents: [{ agentId: 'a' }], requestId: 'q3' } },
    ]))
  })

  it('tells a connected service what it needs to know, and says when none is listening', () => {
    const links = make()
    expect(links.notify('search', { type: 'service_event', payload: { kind: 'touch' } })).toBe(false)
    const search = sink()
    links.accept('search', TOKEN, search, vi.fn())
    expect(links.notify('search', { type: 'service_event', payload: { kind: 'touch' } })).toBe(true)
    expect(search.sent).toEqual([{ type: 'service_event', payload: { kind: 'touch' } }])
  })

  it('holds what a service must hear while it is down, and says it, in order, when it connects', () => {
    const links = make()
    const forget = (sessionId: string) => ({ type: 'service_event', payload: { kind: 'deleteHistory', sessionId } })
    expect(links.notify('search', forget('one'), { untilDelivered: true })).toBe(false)
    expect(links.notify('search', forget('two'), { untilDelivered: true })).toBe(false)
    // Not every notification is owed: a turn boundary missed is caught up by the service itself.
    expect(links.notify('search', { type: 'service_event', payload: { kind: 'touch' } })).toBe(false)
    // Nor to a service this core does not run out of process.
    expect(links.notify('devices', forget('three'), { untilDelivered: true })).toBe(false)
    // Connected but not hearing it: owed all the same.
    const deaf = links.accept('search', TOKEN, sink(false), vi.fn())!
    expect(links.notify('search', forget('three'), { untilDelivered: true })).toBe(false)
    deaf.closed()
    const search = sink()
    links.accept('search', TOKEN, search, vi.fn())
    expect(search.sent).toEqual([forget('three')])
    // Said once: a later connection is not told again.
    const again = sink()
    links.accept('search', TOKEN, again, vi.fn())
    expect(again.sent).toEqual([])
  })

  it('holds a bounded number for a service that stays down, dropping the oldest', () => {
    const links = make()
    for (let n = 0; n < HELD_MAX + 5; n++) links.notify('search', { type: 'service_event', payload: { n } }, { untilDelivered: true })
    const search = sink()
    links.accept('search', TOKEN, search, vi.fn())
    expect(search.sent).toHaveLength(HELD_MAX)
    expect(search.sent[0]).toEqual({ type: 'service_event', payload: { n: 5 } })
  })

  it('works with its own clock, ids and log by default', () => {
    vi.useRealTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const links = createServiceLinks({ token: TOKEN, owned: { search: ['session_search'] }, answer: () => ({}) })
    const search = sink()
    links.accept('search', TOKEN, search, vi.fn())
    const reply = vi.fn()
    links.route('session_search', {}, ASKER, reply)
    expect(String(search.sent[0].payload?.requestId)).toMatch(/^[0-9a-f-]{36}$/)
    expect(warn).toHaveBeenCalledWith('[services] search connected')
    // Answered, so its timer is cleared rather than left to fire.
    const link = links.accept('search', TOKEN, search, vi.fn())!
    link.closed()
    expect(reply).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
    warn.mockRestore()
  })
})
