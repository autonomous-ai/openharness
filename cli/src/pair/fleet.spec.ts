/**
 * The fleet (pair/fleet.ts) on its own: a fake local sensor and a scripted opener per remote machine, a
 * fake clock. What is pinned here is what the brain relies on and cannot see from the outside — which
 * machine owns an event, when a remote is dialled again, what a machine that cannot be read still shows,
 * and that a superseded link's late answers never move the state.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PairFleet, relayPairLinkOpener, type FleetChange, type FleetMachineInfo, type PairLink, type PairLinkOpener } from './fleet.js'
import type { PairEvent, PairHarness, PairJournalEntry } from './protocol.js'

type Frame = Record<string, unknown>

const harness = (agentId: string, over: Partial<PairHarness> = {}): PairHarness => ({
  agentId, name: agentId, engine: 'claude', working: false, question: null, failing: null, lastDoneAt: null, recap: null, ...over,
})
const entry = (seq: number, agentId = 'api'): PairJournalEntry => ({ epoch: 'e', seq, at: seq, kind: 'done', agentId, name: agentId, engine: 'claude' })

/** A controllable remote link: every request is answered by `reply`, or held until released. */
function remoteLink() {
  const requests: Array<{ type: string; payload: Frame; timeoutMs: number }> = []
  let reply: (type: string, payload: Frame) => Promise<Frame> | Frame = () => ({ snapshot: { machineId: 'b', epoch: 'e', seq: 0, rev: 1, harnesses: [harness('api')] } })
  let closes = 0
  let on: Parameters<PairLinkOpener>[1] | null = null
  const link: PairLink = {
    request: async (type, payload, timeoutMs) => { requests.push({ type, payload, timeoutMs }); return reply(type, payload) },
    close: () => { closes++ },
  }
  return {
    link, requests,
    get closes() { return closes },
    get on() { return on! },
    setOn: (o: Parameters<PairLinkOpener>[1]) => { on = o },
    reply: (fn: typeof reply) => { reply = fn },
  }
}

function world(opts: { machines?: () => FleetMachineInfo[]; open?: PairLinkOpener; localHarnesses?: PairHarness[]; requestTimeoutMs?: number } = {}) {
  const changes: FleetChange[] = []
  const listeners = new Set<(e: PairEvent) => void>()
  const localJournal: Frame[] = []
  const r = remoteLink()
  let dials = 0
  const open: PairLinkOpener = opts.open ?? (async (_id, on) => { dials++; r.setOn(on); return r.link })
  const fleet = new PairFleet({
    local: {
      machineId: () => 'a', name: () => 'desk',
      snapshot: () => ({ machineId: 'a', epoch: 'e', seq: 0, rev: 0, harnesses: opts.localHarnesses ?? [harness('local-1')] }),
      subscribe: (l) => { listeners.add(l); return () => listeners.delete(l) },
      journal: (p) => { localJournal.push(p); return { epoch: 'e', seq: 1, entries: [entry(1, 'local-1')] } },
    },
    machines: opts.machines ?? (() => [{ machineId: 'b', name: 'laptop', linked: true }]),
    open,
    onChange: (c) => changes.push(c),
    now: Date.now,
    renewMs: 60_000,
    syncMs: 10_000,
    ...(opts.requestTimeoutMs ? { requestTimeoutMs: opts.requestTimeoutMs } : {}),
  })
  const push = (e: PairEvent) => { for (const l of listeners) l(e) }
  const statuses = (id = 'b') => changes.filter((c) => c.machineId === id && c.status).map((c) => c.status)
  return { fleet, changes, r, push, statuses, listeners, localJournal, get dials() { return dials } }
}

const settle = async (ms = 1): Promise<void> => { await vi.advanceTimersByTimeAsync(ms) }

beforeEach(() => { vi.useFakeTimers({ now: 1_000_000 }) })
afterEach(() => { vi.useRealTimers() })

describe('the fleet: this machine', () => {
  it('starts once, follows the local sensor (a removal deletes), and stops listening on stop', async () => {
    const w = world({ machines: () => [] })
    expect(w.fleet.isRunning).toBe(false)
    w.fleet.start()
    w.fleet.start()
    expect(w.listeners.size).toBe(1)
    expect(w.fleet.isRunning).toBe(true)
    expect(w.fleet.harnesses().map((h) => [h.machineId, h.local, h.harness.agentId])).toEqual([['a', true, 'local-1']])

    w.push({ machineId: 'a', rev: 1, agentId: 'local-2', harness: harness('local-2') })
    w.push({ machineId: 'a', rev: 2, agentId: 'local-1', harness: null, removed: true })
    expect(w.fleet.harnesses().map((h) => h.harness.agentId)).toEqual(['local-2'])
    expect(w.changes.map((c) => [c.machineId, c.machine, c.local, c.event?.agentId])).toEqual([['a', 'desk', true, 'local-2'], ['a', 'desk', true, 'local-1']])
    expect(w.fleet.find('a', 'local-2')?.machine).toBe('desk')
    expect(w.fleet.find('a', 'nope')).toBeNull()
    expect(w.fleet.find('b', 'local-2')).toBeNull()

    w.fleet.stop()
    expect(w.fleet.isRunning).toBe(false)
    expect(w.listeners.size).toBe(0)
    w.fleet.stop() // a second stop is harmless
  })

  it('sync before start dials nobody; the machine list never includes this machine or a blank id', async () => {
    const machines = vi.fn(() => [
      { machineId: 'a', name: 'me again', linked: true },
      { machineId: '', name: 'blank', linked: true },
      { machineId: 'b', name: 'laptop', linked: true },
    ])
    const w = world({ machines })
    w.fleet.sync()
    expect(machines).not.toHaveBeenCalled()
    expect(w.dials).toBe(0)
    w.fleet.start()
    await settle()
    expect(w.dials).toBe(1)
    expect(w.fleet.machines().map((m) => [m.machineId, m.status, m.local])).toEqual([['a', 'ok', true], ['b', 'ok', false]])
    w.fleet.stop()
  })
})

describe('the fleet: another machine', () => {
  it('a snapshot is a baseline; pushes after it move the state by rev, owned by the link they came over', async () => {
    const w = world()
    w.fleet.start()
    await settle()
    expect(w.statuses()).toEqual(['ok'])
    const base = w.changes.filter((c) => c.machineId === 'b' && c.event)
    expect(base.map((c) => [c.event!.agentId, c.event!.baseline])).toEqual([['api', true]])

    // Rubbish, a stale rev, and a rev equal to the snapshot's never move anything.
    const before = w.changes.length
    w.r.on.event(null as unknown as PairEvent)
    w.r.on.event({ machineId: 'b', rev: 2, agentId: 7 as unknown as string, harness: null })
    w.r.on.event({ machineId: 'b', rev: '3' as unknown as number, agentId: 'api', harness: null })
    w.r.on.event({ machineId: 'b', rev: 1, agentId: 'api', harness: null })
    expect(w.changes.length).toBe(before)

    // An event that claims another machine is still this link's machine's.
    w.r.on.event({ machineId: 'evil', rev: 2, agentId: 'web', harness: harness('web', { working: true }) })
    const last = w.changes.at(-1)!
    expect(last.machineId).toBe('b')
    expect(last.event!.machineId).toBe('b')
    expect(w.fleet.find('b', 'web')?.harness.working).toBe(true)
    expect(w.fleet.find('evil', 'web')).toBeNull()

    // A removal deletes.
    w.r.on.event({ machineId: 'b', rev: 3, agentId: 'api', harness: null, removed: true })
    expect(w.fleet.find('b', 'api')).toBeNull()
    expect(w.fleet.harnesses().filter((h) => !h.local).map((h) => h.harness.agentId)).toEqual(['web'])
    w.fleet.stop()
  })

  it('a renewal replaces the state wholesale: what is gone is removed as a baseline, and a missing rev is 0', async () => {
    const w = world()
    w.fleet.start()
    await settle()
    w.r.reply(() => ({ snapshot: { machineId: 'b', epoch: 'e', seq: 0, harnesses: [harness('web')] } }))
    await settle(60_000)
    const removed = w.changes.filter((c) => c.event?.removed)
    expect(removed.map((c) => [c.event!.agentId, c.event!.baseline, c.event!.rev])).toEqual([['api', true, 0]])
    expect(w.fleet.harnesses().filter((h) => !h.local).map((h) => h.harness.agentId)).toEqual(['web'])
    // With rev reset to 0, a push at rev 1 is news again.
    w.r.on.event({ machineId: 'b', rev: 1, agentId: 'web', harness: harness('web', { working: true }) })
    expect(w.fleet.find('b', 'web')?.harness.working).toBe(true)
    w.fleet.stop()
  })

  it('a watch answer that is an error, has no snapshot, or no harness list is a failure; the next dial waits and backs off', async () => {
    for (const bad of [{ error: 'BUSY' }, {}, { snapshot: { rev: 1 } }]) {
      const w = world()
      w.r.reply(() => bad)
      w.fleet.start()
      await settle()
      expect(w.statuses()).toEqual(['unreachable'])
      expect(w.r.closes).toBe(1)
      expect(w.fleet.machines()[1].status).toBe('unreachable')
      w.fleet.stop()
    }

    // Backoff: 30 s after the first failure, 60 s after the second.
    const w = world()
    w.r.reply(() => ({ error: 'BUSY' }))
    w.fleet.start()
    await settle()
    expect(w.dials).toBe(1)
    await settle(20_000) // two syncs inside the 30 s wait
    expect(w.dials).toBe(1)
    await settle(10_000) // the sync at 30 s is due
    expect(w.dials).toBe(2)
    await settle(50_000) // a second failure waits 60 s
    expect(w.dials).toBe(2)
    await settle(10_000)
    expect(w.dials).toBe(3)
    w.r.reply(() => ({ snapshot: { machineId: 'b', epoch: 'e', seq: 0, rev: 1, harnesses: [] } }))
    await settle(120_000)
    expect(w.fleet.machines()[1].status).toBe('ok')
    w.fleet.stop()
  })

  it('a watch that throws is a failure, but a throw from a superseded dial changes nothing', async () => {
    const w = world()
    w.r.reply(() => { throw new Error('boom') })
    w.fleet.start()
    await settle()
    expect(w.statuses()).toEqual(['unreachable'])

    // A renewal that throws after the machine was dropped from the list is ignored.
    let release: (v: Frame) => void = () => {}
    let listed = true
    const late = world({ machines: () => listed ? [{ machineId: 'b', name: 'laptop', linked: true }] : [] })
    late.r.reply(() => new Promise<Frame>((resolve) => { release = resolve }))
    late.fleet.start()
    await settle()
    listed = false
    late.fleet.sync()
    expect(late.statuses()).toEqual(['off'])
    release({ snapshot: { machineId: 'b', epoch: 'e', seq: 0, rev: 9, harnesses: [harness('api')] } })
    await settle()
    expect(late.fleet.harnesses().filter((h) => !h.local)).toEqual([])
    expect(late.fleet.machines().map((m) => m.machineId)).toEqual(['a'])
    late.fleet.stop()

    let reject: (e: Error) => void = () => {}
    let listed2 = true
    const lateFail = world({ machines: () => listed2 ? [{ machineId: 'b', name: 'laptop', linked: true }] : [] })
    lateFail.r.reply(() => new Promise<Frame>((_r, rej) => { reject = rej }))
    lateFail.fleet.start()
    await settle()
    listed2 = false
    lateFail.fleet.sync()
    reject(new Error('late'))
    await settle()
    expect(lateFail.statuses()).toEqual(['off'])
    lateFail.fleet.stop()
  })

  it('PAIR_OFF clears what the machine showed; UNSUPPORTED names it old and it is never dialled again', async () => {
    const w = world()
    w.fleet.start()
    await settle()
    expect(w.fleet.find('b', 'api')).not.toBeNull()
    w.r.reply(() => ({ error: 'PAIR_OFF' }))
    await settle(60_000)
    expect(w.fleet.find('b', 'api')).toBeNull()
    expect(w.changes.some((c) => c.event?.agentId === 'api' && c.event.removed)).toBe(true)
    expect(w.statuses().at(-1)).toBe('off')
    w.fleet.stop()

    const old = world()
    old.r.reply(() => ({ error: 'UNSUPPORTED' }))
    old.fleet.start()
    await settle()
    expect(old.statuses()).toEqual(['old'])
    await settle(600_000)
    expect(old.dials).toBe(1)
    await expect(old.fleet.request('b', 'pair_answer', {})).rejects.toThrow('MACHINE_OLD')
    old.fleet.stop()
  })

  it('a dial that fails: NO_PEER_LINK is unlinked, anything else (even a non-Error) is unreachable', async () => {
    const unlinked = world({ open: async () => { throw new Error('NO_PEER_LINK') } })
    unlinked.fleet.start()
    await settle()
    expect(unlinked.statuses()).toEqual(['unlinked'])
    unlinked.fleet.stop()

    const odd = world({ open: async () => { throw 'socket hang up' } })
    odd.fleet.start()
    await settle()
    expect(odd.statuses()).toEqual(['unreachable'])
    odd.fleet.stop()
  })

  it('a dial that lands after stop, or after the machine left the list, is closed and changes nothing', async () => {
    const r = remoteLink()
    let land: (l: PairLink) => void = () => {}
    const w = world({ open: () => new Promise<PairLink>((resolve) => { land = resolve }) })
    w.fleet.start()
    await settle()
    w.fleet.stop()
    land(r.link)
    await settle()
    expect(r.closes).toBe(1)
    expect(r.requests).toEqual([])

    // A failed dial that answers after the machine was dropped is ignored too.
    let listed = true
    let fail: (e: Error) => void = () => {}
    const gone = world({ machines: () => listed ? [{ machineId: 'b', name: 'laptop', linked: true }] : [], open: () => new Promise<PairLink>((_r, rej) => { fail = rej }) })
    gone.fleet.start()
    await settle()
    listed = false
    gone.fleet.sync()
    fail(new Error('NO_PEER_LINK'))
    await settle()
    expect(gone.statuses()).toEqual(['off'])
    gone.fleet.stop()
  })

  it('a dial in progress is not started twice; a machine renamed in the list keeps its last good name when blank', async () => {
    let land: (l: PairLink) => void = () => {}
    let dials = 0
    let name = 'laptop'
    const r = remoteLink()
    const w = world({ machines: () => [{ machineId: 'b', name, linked: true }], open: (_id, on) => { dials++; r.setOn(on); return new Promise<PairLink>((resolve) => { land = resolve }) } })
    w.fleet.start()
    await settle()
    w.fleet.sync()
    w.fleet.sync()
    expect(dials).toBe(1)
    name = ''
    w.fleet.sync()
    expect(w.fleet.machines()[1].name).toBe('laptop')
    name = 'work laptop'
    w.fleet.sync()
    expect(w.fleet.machines()[1].name).toBe('work laptop')
    land(r.link)
    await settle()
    expect(w.fleet.machines()[1].status).toBe('ok')
    w.fleet.stop()
  })

  it('a link that closes is unreachable and keeps what it last showed; the retry replaces it', async () => {
    const w = world()
    w.fleet.start()
    await settle()
    w.r.on.closed('relay dropped')
    expect(w.fleet.machines()[1].status).toBe('unreachable')
    // Unreachable for a moment keeps the harness (marked by its status).
    expect(w.fleet.find('b', 'api')).not.toBeNull()
    await expect(w.fleet.request('b', 'pair_answer', {})).rejects.toThrow('MACHINE_UNREACHABLE')
    await settle(40_000)
    expect(w.dials).toBe(2)
    expect(w.fleet.machines()[1].status).toBe('ok')
    w.fleet.stop()
  })

  it('a superseded link is deaf: its late pushes and its late close move nothing', async () => {
    const first = remoteLink()
    const second = remoteLink()
    const links = [first, second]
    let dials = 0
    const w = world({ open: async (_id, on) => { const r = links[dials++]; r.setOn(on); return r.link } })
    w.fleet.start()
    await settle()
    const stale = first.on
    stale.closed('relay dropped')
    await settle(40_000)
    expect(dials).toBe(2)
    expect(w.fleet.machines()[1].status).toBe('ok')
    const before = w.changes.length
    stale.event({ machineId: 'b', rev: 99, agentId: 'ghost', harness: harness('ghost') })
    stale.closed('late close')
    expect(w.changes.length).toBe(before)
    expect(w.fleet.find('b', 'ghost')).toBeNull()
    expect(w.fleet.machines()[1].status).toBe('ok')
    expect(second.closes).toBe(0)
    w.fleet.stop()
    expect(second.closes).toBe(1)
  })

  it('without a clock or timers configured it uses the defaults: a 30 s sync, a 2 min renewal', async () => {
    const r = remoteLink()
    const fleet = new PairFleet({
      local: { machineId: () => 'a', name: () => 'desk', snapshot: () => ({ machineId: 'a', epoch: 'e', seq: 0, rev: 0, harnesses: [] }), subscribe: () => () => {}, journal: () => ({ epoch: 'e', seq: 0, entries: [] }) },
      machines: () => [{ machineId: 'b', name: 'laptop', linked: true }],
      open: async () => r.link, onChange: () => {},
    })
    fleet.start()
    await settle()
    expect(r.requests.map((q) => q.type)).toEqual(['pair_watch'])
    await settle(119_000)
    expect(r.requests).toHaveLength(1)
    await settle(1_000)
    expect(r.requests).toHaveLength(2)
    fleet.stop()
  })

  it('a machine the list stops naming is disconnected and reported off; one that is not linked shows nothing', async () => {
    let list: FleetMachineInfo[] = [{ machineId: 'b', name: 'laptop', linked: true }]
    const w = world({ machines: () => list })
    w.fleet.start()
    await settle()
    list = []
    await settle(10_000)
    expect(w.r.closes).toBe(1)
    expect(w.changes.at(-1)).toEqual({ machineId: 'b', machine: 'laptop', local: false, event: null, status: 'off' })
    expect(w.fleet.machines()).toHaveLength(1)
    await expect(w.fleet.request('b', 'x', {})).rejects.toThrow('UNKNOWN_MACHINE')

    // Linked, read, then unlinked: whatever it showed is cleared.
    list = [{ machineId: 'b', name: 'laptop', linked: true }]
    await settle(10_000)
    expect(w.fleet.find('b', 'api')).not.toBeNull()
    list = [{ machineId: 'b', name: 'laptop', linked: false }]
    await settle(10_000)
    expect(w.fleet.find('b', 'api')).toBeNull()
    expect(w.fleet.machines()[1].status).toBe('unlinked')
    w.fleet.stop()
  })

  it('request goes over the watch link with the configured timeout (or the default)', async () => {
    const w = world({ requestTimeoutMs: 1_234 })
    w.fleet.start()
    await settle()
    w.r.reply((type, payload) => ({ type, echo: payload }))
    expect(await w.fleet.request('b', 'pair_answer', { choice: 'y' })).toEqual({ type: 'pair_answer', echo: { choice: 'y' } })
    expect(w.r.requests.at(-1)!.timeoutMs).toBe(1_234)
    await w.fleet.request('b', 'pair_read', {}, 50)
    expect(w.r.requests.at(-1)!.timeoutMs).toBe(50)
    w.fleet.stop()

    const d = world()
    d.fleet.start()
    await settle()
    await d.fleet.request('b', 'pair_read', {})
    expect(d.r.requests.at(-1)!.timeoutMs).toBe(8_000)
    d.fleet.stop()
  })
})

describe('the fleet: journals', () => {
  it('asks every machine in parallel; names the ones that cannot answer instead of waiting', async () => {
    const r = { b: remoteLink(), c: remoteLink(), d: remoteLink(), e: remoteLink() }
    r.b.reply((type) => type === 'pair_journal' ? { entries: [entry(4)] } : { snapshot: { machineId: 'b', epoch: 'e', seq: 0, rev: 1, harnesses: [] } })
    r.c.reply((type) => type === 'pair_journal' ? { error: 'PAIR_OFF_NOW' } : { snapshot: { machineId: 'c', epoch: 'e', seq: 0, rev: 1, harnesses: [] } })
    r.d.reply((type) => type === 'pair_journal' ? { entries: 'nope' } : { snapshot: { machineId: 'd', epoch: 'e', seq: 0, rev: 1, harnesses: [] } })
    r.e.reply((type) => type === 'pair_journal' ? new Promise<Frame>(() => {}) : { snapshot: { machineId: 'e', epoch: 'e', seq: 0, rev: 1, harnesses: [] } })
    const w = world({
      machines: () => [
        { machineId: 'b', name: 'B', linked: true },
        { machineId: 'c', name: 'C', linked: true },
        { machineId: 'd', name: 'D', linked: true },
        { machineId: 'e', name: 'E', linked: true },
        { machineId: 'f', name: 'F', linked: false },
        { machineId: 'g', name: 'G', linked: true, online: false },
      ],
      open: async (id) => {
        if (id === 'b' || id === 'c' || id === 'd' || id === 'e') return r[id].link
        throw new Error('unused')
      },
    })
    w.fleet.start()
    await settle()
    const pending = w.fleet.journals(100, 3_000)
    await settle(3_000)
    const journals = await pending
    expect(w.localJournal).toEqual([{ at: 100 }])
    expect(journals.map((j) => [j.machineId, j.local, j.entries.length, j.error])).toEqual([
      ['a', true, 1, undefined],
      ['b', false, 1, undefined],
      ['c', false, 0, 'PAIR_OFF_NOW'],
      ['d', false, 0, undefined],
      ['e', false, 0, 'unreachable'],
      ['g', false, 0, 'asleep'],
    ])
    expect(r.b.requests.find((q) => q.type === 'pair_journal')).toEqual({ type: 'pair_journal', payload: { at: 100 }, timeoutMs: 3_000 })
    w.fleet.stop()
  })

  it('a machine being dialled gets the same few seconds; one still dialling after them is unreachable', async () => {
    const r = remoteLink()
    r.reply((type) => type === 'pair_journal' ? { entries: [entry(9)] } : { snapshot: { machineId: 'b', epoch: 'e', seq: 0, rev: 1, harnesses: [] } })
    let land: (l: PairLink) => void = () => {}
    const w = world({ open: () => new Promise<PairLink>((resolve) => { land = resolve }) })
    w.fleet.start()
    await settle()
    const pending = w.fleet.journals(0, 3_000)
    await settle(1_000)
    land(r.link)
    await settle(1)
    const journals = await pending
    expect(journals[1]).toEqual({ machineId: 'b', machine: 'laptop', local: false, entries: [entry(9)] })
    w.fleet.stop()

    const slow = world({ open: () => new Promise<PairLink>(() => {}) })
    slow.fleet.start()
    await settle()
    const late = slow.fleet.journals(0, 2_000)
    await settle(2_000)
    expect((await late)[1]).toEqual({ machineId: 'b', machine: 'laptop', local: false, entries: [], error: 'unreachable' })
    slow.fleet.stop()
  })

  it('a machine that is old or off is left out; one whose journal request throws is unreachable', async () => {
    const old = world()
    old.r.reply(() => ({ error: 'UNSUPPORTED' }))
    old.fleet.start()
    await settle()
    expect((await old.fleet.journals(0, 1_000)).map((j) => j.machineId)).toEqual(['a'])
    old.fleet.stop()

    const throws = world()
    throws.fleet.start()
    await settle()
    throws.r.reply(() => { throw new Error('closed') })
    expect((await throws.fleet.journals(0, 1_000))[1].error).toBe('unreachable')
    throws.fleet.stop()
  })
})

describe('the relay opener: the edges', () => {
  function relay() {
    const sent: Frame[] = []
    let sink: { sendFrame: (f: Frame) => boolean; sendBinary: (f: Uint8Array) => boolean } | null = null
    let onClosed: ((code: number, reason: string) => void) | null = null
    let detaches = 0
    let sendFails: unknown = null
    const events: PairEvent[] = []
    const closed: string[] = []
    let n = 0
    const open = relayPairLinkOpener({
      acquire: async (_m, s, c) => {
        sink = s; onClosed = c
        return { send: async (f) => { sent.push(f); if (sendFails !== null) throw sendFails }, detach: () => { detaches++ } }
      },
      newId: () => `id-${++n}`,
    })
    return {
      open: () => open('b', { event: (e) => events.push(e), closed: (reason) => closed.push(reason) }),
      sent, events, closed,
      get sink() { return sink! }, get onClosed() { return onClosed! }, get detaches() { return detaches },
      failSends: (err: unknown) => { sendFails = err },
    }
  }

  it('ignores frames it does not own: no type, a non-object payload, a result nobody waits for', async () => {
    const r = relay()
    const link = await r.open()
    expect(r.sink.sendFrame({ payload: { requestId: 'id-1' } })).toBe(true)
    expect(r.sink.sendFrame({ type: 'pair_event', payload: 'not an object' })).toBe(true)
    expect(r.events).toEqual([{}])
    expect(r.sink.sendFrame({ type: 'pair_watch_result', payload: { requestId: 'id-99' } })).toBe(true)
    expect(r.sink.sendFrame({ type: 'pair_watch_result', payload: { requestId: 7 } })).toBe(true)
    expect(r.sink.sendBinary(new Uint8Array([1]))).toBe(true)
    // A result frame that is not pair_*_result does not settle a request with the same id.
    const pending = link.request('pair_watch', {}, 1_000)
    r.sink.sendFrame({ type: 'pair_watch', payload: { requestId: 'id-1' } })
    r.sink.sendFrame({ type: 'other_result', payload: { requestId: 'id-1' } })
    r.sink.sendFrame({ type: 'pair_watch_result', payload: { requestId: 'id-1', ok: true } })
    expect(await pending).toEqual({ requestId: 'id-1', ok: true })
    link.close()
  })

  it('the far side closing fails what is pending once, and says why (or "closed")', async () => {
    const r = relay()
    const link = await r.open()
    const a = link.request('pair_watch', {}, 10_000)
    const b = link.request('pair_journal', {}, 10_000)
    r.onClosed(1006, '')
    await expect(a).rejects.toThrow('closed')
    await expect(b).rejects.toThrow('closed')
    expect(r.closed).toEqual(['closed'])
    r.onClosed(1000, 'again')
    expect(r.closed).toEqual(['closed'])
    // Closed: nothing more is taken or sent.
    expect(r.sink.sendFrame({ type: 'pair_event', payload: {} })).toBe(false)
    expect(r.sink.sendBinary(new Uint8Array())).toBe(false)
    expect(r.events).toEqual([])
    await expect(link.request('pair_watch', {}, 1_000)).rejects.toThrow('closed')
    const sentBefore = r.sent.length
    link.close()
    expect(r.sent.length).toBe(sentBefore)
    expect(r.detaches).toBe(0)

    const named = relay()
    await named.open()
    named.onClosed(4000, 'peer gone')
    expect(named.closed).toEqual(['peer gone'])
  })

  it('a send that fails rejects its request at once (a non-Error becomes one); close is once and fails the rest', async () => {
    const r = relay()
    const link = await r.open()
    r.failSends(new Error('socket down'))
    await expect(link.request('pair_watch', {}, 10_000)).rejects.toThrow('socket down')
    r.failSends('string failure')
    await expect(link.request('pair_watch', {}, 10_000)).rejects.toThrow('string failure')
    r.failSends(null)
    const waiting = link.request('pair_journal', {}, 10_000)
    // The watch-off on close is best effort: a send that fails there is swallowed.
    r.failSends(new Error('gone'))
    link.close()
    await expect(waiting).rejects.toThrow('closed')
    link.close()
    expect(r.detaches).toBe(1)
    expect(r.sent.filter((f) => (f.payload as Frame).off === true)).toHaveLength(1)
    await settle()
  })
})
