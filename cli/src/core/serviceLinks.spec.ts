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

  it('hands on what a service tells the core without asking, its bytes and its comings and goings (the gateway)', () => {
    const notice = vi.fn(), binary = vi.fn(), connected = vi.fn(), disconnected = vi.fn()
    const links = make({ owned: { gateway: [] }, notice, binary, connected, disconnected })
    // Nothing to send bytes to, and nothing waiting, while it is away.
    expect(links.notifyBinary('gateway', Uint8Array.of(1))).toBe(false)
    expect(links.buffered('gateway')).toBe(0)
    const gateway = { ...sink(), sendBinary: vi.fn(() => true), buffered: vi.fn(() => 42) }
    const link = links.accept('gateway', TOKEN, gateway, vi.fn())!
    expect(connected).toHaveBeenCalledWith('gateway')
    link.receive({ type: 'service_notice', payload: { kind: 'status', connected: true } })
    expect(notice).toHaveBeenCalledWith('gateway', { kind: 'status', connected: true })
    link.receiveBinary(Uint8Array.of(7))
    expect(binary).toHaveBeenCalledWith('gateway', Uint8Array.of(7))
    expect(links.notifyBinary('gateway', Uint8Array.of(2))).toBe(true)
    expect(gateway.sendBinary).toHaveBeenCalledWith(Uint8Array.of(2))
    expect(links.buffered('gateway')).toBe(42)
    link.closed()
    expect(disconnected).toHaveBeenCalledWith('gateway')
    // A service whose sink carries no bytes, and that says nothing of what waits on it.
    const plain = links.accept('gateway', TOKEN, sink(), vi.fn())!
    expect(links.notifyBinary('gateway', Uint8Array.of(3))).toBe(false)
    expect(links.buffered('gateway')).toBe(0)
    // Without the hooks, the same frames are taken and nothing is said.
    const bare = make({ owned: { gateway: [] } })
    const quiet = bare.accept('gateway', TOKEN, sink(), vi.fn())!
    quiet.receive({ type: 'service_notice', payload: {} })
    quiet.receiveBinary(Uint8Array.of(1))
    quiet.closed()
    plain.closed()
  })

  it('asks for an experiment that is off, and sends the request that woke it once it connects, in order', () => {
    const want = vi.fn()
    const links = make({ owned: { orchestrator: ['orchestrator'] }, onDemand: new Set(['orchestrator']), want })
    const replies: Array<Record<string, unknown>> = []
    links.route('orchestrator', { action: 'list' }, ASKER, (result) => replies.push(result))
    links.route('orchestrator', { action: 'catalog' }, ASKER, (result) => replies.push(result))
    expect(want.mock.calls).toEqual([['orchestrator'], ['orchestrator']])
    expect(replies).toEqual([])
    const orchestrator = sink()
    const link = links.accept('orchestrator', TOKEN, orchestrator, vi.fn())!
    expect(orchestrator.sent).toEqual([
      { type: 'orchestrator', payload: { action: 'list', requestId: 'route-1' }, asker: ASKER },
      { type: 'orchestrator', payload: { action: 'catalog', requestId: 'route-2' }, asker: ASKER },
    ])
    link.receive({ type: 'orchestrator_result', payload: { requestId: 'route-2', projects: [] } })
    link.receive({ type: 'orchestrator_result', payload: { requestId: 'route-1', projects: [] } })
    expect(replies).toEqual([{ projects: [] }, { projects: [] }])
    // Connected again later, nothing is sent twice.
    const again = links.accept('orchestrator', TOKEN, sink(), vi.fn())!
    expect(want).toHaveBeenCalledTimes(2)
    // On, then down: answered at once, as any service is, and not asked for again.
    again.closed()
    const down = vi.fn()
    links.route('orchestrator', { action: 'list' }, ASKER, down)
    expect(down).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'orchestrator', retryable: true })
    expect(want).toHaveBeenCalledTimes(2)
  })

  it('carries the connection through an experiment\'s start, and never sends what a connection that closed meanwhile asked', () => {
    const links = make({ owned: { orchestrator: ['orchestrator'] }, onDemand: new Set(['orchestrator']), want: vi.fn() })
    const gone = vi.fn(), stays = vi.fn(), core = vi.fn()
    links.route('orchestrator', { action: 'list' }, { ...ASKER, connection: 'gone' }, gone)
    links.route('orchestrator', { action: 'catalog' }, { ...ASKER, connection: 'stays' }, stays)
    links.route('orchestrator', { action: 'status' }, ASKER, core)
    links.closeConnection('gone')
    // Answered where nobody is left to read it, and never sent.
    expect(gone).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'orchestrator', retryable: true })
    const orchestrator = sink()
    links.accept('orchestrator', TOKEN, orchestrator, vi.fn())
    expect(orchestrator.sent).toEqual([
      { type: 'orchestrator', payload: { action: 'catalog', requestId: 'route-2' }, asker: { ...ASKER, connection: 'stays' } },
      { type: 'orchestrator', payload: { action: 'status', requestId: 'route-3' }, asker: ASKER },
    ])
    expect(stays).not.toHaveBeenCalled()
    expect(core).not.toHaveBeenCalled()
    // Sent, it is the process's to abort when its connection closes.
    links.closeConnection('stays')
    expect(orchestrator.sent.at(-1)).toEqual({ type: 'service_connection_closed', payload: { connection: 'stays' } })
    expect(stays).not.toHaveBeenCalled()
  })

  it('acknowledges an accepted service before held events and the requests that woke it', () => {
    // Found by QA on a quiet machine: the first Share request saw no agent when it arrived before connected.
    const links = make({ owned: { sharing: ['harness_share_link'] }, onDemand: new Set(['sharing']) })
    links.notify('sharing', { type: 'service_event', payload: { kind: 'linkDown' } }, { untilDelivered: true })
    const reply = vi.fn()
    links.route('harness_share_link', { agentId: 'a1' }, ASKER, reply)
    const sharing = sink()
    const accepted = vi.fn(() => { sharing.sendFrame({ type: 'connected', payload: {} }) })
    expect(links.accept('sharing', 'wrong', sharing, vi.fn(), accepted)).toBeNull()
    expect(accepted).not.toHaveBeenCalled()
    const link = links.accept('sharing', TOKEN, sharing, vi.fn(), accepted)!
    expect(sharing.sent.map((frame) => frame.type)).toEqual(['connected', 'service_event', 'harness_share_link'])
    expect(accepted).toHaveBeenCalledOnce()
    link.receive({ type: 'harness_share_link_result', payload: { requestId: 'route-1', link: 'ready' } })
    expect(reply).toHaveBeenCalledWith({ link: 'ready' })
  })

  it('answers SERVICE_UNAVAILABLE for one on demand that does not come in time, then at once until it comes, or will not take the request', () => {
    const want = vi.fn()
    const links = make({ owned: { orchestrator: ['orchestrator'], devices: ['harness_devices_list'], search: ['session_search'] }, onDemand: new Set(['orchestrator', 'devices']), want })
    const late = vi.fn()
    links.route('orchestrator', { action: 'list' }, ASKER, late)
    vi.advanceTimersByTime(5_000)
    expect(late).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'orchestrator', retryable: true })
    // Its master could not start it: the next request does not wait the whole wait again, nor ask again.
    const again = vi.fn()
    links.route('orchestrator', { action: 'list' }, ASKER, again)
    expect(again).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'orchestrator', retryable: true })
    expect(want).toHaveBeenCalledTimes(1)
    // Once it comes, it is served as any other.
    const served = sink()
    links.accept('orchestrator', TOKEN, served, vi.fn())
    links.route('orchestrator', { action: 'list' }, ASKER, vi.fn())
    expect(served.sent).toHaveLength(1)
    const refused = vi.fn()
    links.route('harness_devices_list', {}, ASKER, refused)
    links.accept('devices', TOKEN, sink(false), vi.fn())
    expect(refused).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'devices', retryable: true })
    // A service that is not an experiment is never waited for.
    const search = vi.fn()
    links.route('session_search', {}, ASKER, search)
    expect(search).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
  })

  it('waits as long as a call says it may (a pairing), and answers SERVICE_UNAVAILABLE after', async () => {
    const links = make({ owned: { gateway: [] } })
    links.accept('gateway', TOKEN, sink(), vi.fn())
    const answer = links.call('gateway', 'gateway_pair', { code: 'X' }, 60_000)
    vi.advanceTimersByTime(30_000)
    let settled = false
    void answer.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
    vi.advanceTimersByTime(30_000)
    await expect(answer).resolves.toMatchObject({ error: 'SERVICE_UNAVAILABLE', service: 'gateway' })
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

  it('routes with the connection that asked, and tells every service connected when a connection closes', () => {
    const links = make({ owned: { search: ['session_search'], store: ['dsh_list'], viewers: [] } })
    const search = sink(), store = sink()
    links.accept('search', TOKEN, search, vi.fn())
    links.accept('store', TOKEN, store, vi.fn())
    links.route('session_search', { query: 'q' }, { ...ASKER, connection: 'conn-1' }, vi.fn())
    expect(search.sent).toEqual([{ type: 'session_search', payload: { query: 'q', requestId: 'route-1' }, asker: { local: false, owner: true, connection: 'conn-1' } }])
    links.closeConnection('conn-1')
    const closed = { type: 'service_connection_closed', payload: { connection: 'conn-1' } }
    expect(search.sent.at(-1)).toEqual(closed)
    expect(store.sent).toEqual([closed])
    // A service down when it closed is not told later: what it was answering went with it.
    const viewers = sink()
    links.accept('viewers', TOKEN, viewers, vi.fn())
    expect(viewers.sent).toEqual([])
  })

  it('asks a service what the core itself needs, as the core, and settles every way a routed request does', async () => {
    const links = make({ owned: { monitor: ['machine_resources'] } })
    // Down: unavailable at once, never a rejection.
    await expect(links.call('monitor', 'resources', {})).resolves.toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'monitor', retryable: true })
    const monitor = sink()
    const link = links.accept('monitor', TOKEN, monitor, vi.fn())!
    const answered = links.call('monitor', 'storage', { agents: [], invalidate: true })
    expect(monitor.sent).toEqual([{ type: 'storage', payload: { agents: [], invalidate: true, requestId: 'route-1' }, asker: { local: true, owner: true } }])
    link.receive({ type: 'storage_result', payload: { requestId: 'route-1', entries: [['a1', { workspaceBytes: 1 }]] } })
    await expect(answered).resolves.toEqual({ entries: [['a1', { workspaceBytes: 1 }]] })
    // The types it asks are not the apps' to route.
    expect(links.route('storage', {}, ASKER, vi.fn())).toBe(false)
    // Too slow, or gone before it answers: unavailable.
    const slow = links.call('monitor', 'resources', {})
    vi.advanceTimersByTime(5_000)
    await expect(slow).resolves.toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'monitor', retryable: true })
    const cut = links.call('monitor', 'resources', {})
    link.closed()
    await expect(cut).resolves.toEqual({ error: 'SERVICE_UNAVAILABLE', service: 'monitor', retryable: true })
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

  it('waits longer for the answers that take longer, by service and type, and the usual half minute for the rest', async () => {
    const links = make({
      owned: { search: ['session_search', 'session_tail'], models: ['grid_fleet_run'] },
      waits: { models: { grid_fleet_run: 60_000, ensure: 30_000 }, search: { session_tail: 10_000 } },
    })
    links.accept('models', TOKEN, sink(), vi.fn())
    links.accept('search', TOKEN, sink(), vi.fn())
    const run = vi.fn()
    const ensure = vi.fn()
    const search = vi.fn()
    const tail = vi.fn()
    links.route('grid_fleet_run', {}, ASKER, run)
    void links.call('models', 'ensure', {}).then(ensure)
    links.route('session_search', {}, ASKER, search)
    links.route('session_tail', {}, ASKER, tail)
    vi.advanceTimersByTime(5_000)
    expect(search).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'search', retryable: true })
    expect(tail).not.toHaveBeenCalled()
    vi.advanceTimersByTime(5_000)
    expect(tail).toHaveBeenCalled()
    vi.advanceTimersByTime(20_000)
    await Promise.resolve()
    expect(ensure).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true })
    expect(run).not.toHaveBeenCalled()
    vi.advanceTimersByTime(30_000)
    expect(run).toHaveBeenCalledWith({ error: 'SERVICE_UNAVAILABLE', service: 'models', retryable: true })
    // A type the waits only inherit from Object's prototype waits as any other does.
    links.route('session_search', {}, ASKER, vi.fn())
    expect(links.call('models', 'toString', {})).toBeInstanceOf(Promise)
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
