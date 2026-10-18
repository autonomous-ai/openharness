import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TabFrame, TabLink, TabRelay } from '../core/api.js'
import { TabSessions } from '../gateway/tabKey.js'
import { b64d, b64e, fingerprint, newIdentity, sign, verify, type Identity } from '../lib/e2ee/core.js'
import { keyChangeBytes, parseRoster, ROSTER_LIMITS, type Roster, type RosterHarness, type SignedRoster } from './roster.js'
import { MessageError } from './model.js'
import { RequestStore, type QueuedRequest } from './requestStore.js'
import { ConsentStore } from './consentStore.js'
import { rosterGrants } from '../sharing/rosterGrants.js'
import { RosterStore } from './rosterStore.js'
import { NoticeStore } from './noticeStore.js'
import { HELLO_RETRY_MS, PULL_RETRY_MS, RELAY_TAKEOVER_MS, RELAY_TAKEOVER_WINDOW_MS, RETRY_MS, SharedTabs, type SharedNotice, type SharedTabsDeps } from './sharedTabs.js'
import { FakeBackend, ok, resign, shareIdOf, type Pane } from './sharedTabsFixtures.js'

/*
 * Several machines of several accounts, each with its real keys (TabSessions), its real roster store in a folder of its
 * own and its SharedTabs, joined by an in-memory relay and one fake backend that answers the real routes' shapes.
 */

interface Machine {
  id: string; userId: string; email: string; identity: Identity; pub: string
  deps: SharedTabsDeps; key: TabSessions; store: RosterStore; consent: ConsentStore; shared: SharedTabs; relay: TabRelay & { open: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }
  opened: Set<string>; online: boolean
  panes: Map<string, Pane[] | null>; keys: Map<string, string | null>
  /** Every request it sent another machine of its account (`askMachine`), and what answers them in place of that
   *  machine; unset, the machine in the net answers, as its daemon would over the paired relay. */
  asked: Array<[string, Record<string, unknown>]>; answer?: (machineId: string, payload: Record<string, unknown>) => Promise<Record<string, unknown> | null>
  /** This account's machines as its directory lists them; unset, every machine of the account in the net. */
  mine?: string[] | null
}
interface Sent { from: string; to: string; tab: string; payload: Record<string, unknown> }

class Net {
  machines = new Map<string, Machine>()
  queue: Array<() => Promise<void>> = []
  sent: Sent[] = []
  relayFor(m: Pick<Machine, 'id' | 'userId' | 'opened'> & { shared?: SharedTabs }): Machine['relay'] {
    return {
      open: vi.fn(async (tab: string) => { m.opened.add(tab) }),
      send: vi.fn(async (tab: string, to: string, payload: Record<string, unknown>) => {
        if (!m.opened.has(tab)) return false
        this.sent.push({ from: m.id, to, tab, payload })
        const target = this.machines.get(to)
        const copy = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>
        if (target?.online && target.opened.has(tab)) this.queue.push(() => target.shared.onFrame({ sharedTabId: tab, from: { machineId: m.id, userId: m.userId }, payload: copy }))
        else this.queue.push(() => this.machines.get(m.id)!.shared.onFrame({ sharedTabId: tab, undeliverable: to }))
        return true
      }),
      close: vi.fn((tab: string) => { m.opened.delete(tab) }),
    }
  }
  /** Runs every frame in flight, and what they set off, until nothing moves. */
  async settle(): Promise<void> {
    for (let i = 0; i < 30; i++) {
      await new Promise((done) => setImmediate(done))
      while (this.queue.length) await this.queue.shift()!()
    }
  }
  kinds(from: string, to: string): unknown[] {
    return this.sent.filter((s) => s.from === from && s.to === to).map((s) => s.payload.kind ?? 'sealed')
  }
}

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'shared-tabs-')) })
afterEach(() => { vi.useRealTimers(); rmSync(root, { recursive: true, force: true }) })

/** What another machine of the account answers over the paired relay (service.ts, its `agent_messages` handler). */
async function remote(target: Machine, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const id = String(payload.sharedTabId)
  if (payload.action === 'share_add') return target.shared.addHarness(id, payload.harness as Pane, payload.forwarded === true)
  if (payload.action === 'share_remove') return target.shared.removeHarness(id, String(payload.machineId), String(payload.agentId), payload.forwarded === true)
  if (payload.action === 'tab_pin') return target.shared.pinOf(id)
  if (payload.action === 'tab_pin_changed') { await target.shared.pinChanged(id); return { ok: true } }
  if (payload.action === 'tab_keychange') return target.shared.keyChange(id, payload.nextPub, payload.machineId)
  throw new MessageError('UNKNOWN_ACTION', 'Unknown Agent Messages request.')
}

function world(ids: { alice?: string; bob?: string } = {}) {
  const backend = new FakeBackend(), net = new Net()
  let clock = Date.UTC(2026, 9, 15, 12)
  const make = (id: string, userId: string, email: string, identity = newIdentity()): Machine => {
    backend.emails.set(userId, email)
    const m = { id, userId, email, identity, pub: b64e(identity.pub), opened: new Set<string>(), online: true,
      panes: new Map<string, Pane[] | null>(), keys: new Map<string, string | null>(), asked: [] } as unknown as Machine
    m.key = new TabSessions(() => m.identity, () => id)
    m.store = new RosterStore(join(root, `${id}.json`), () => clock)
    m.consent = new ConsentStore(join(root, `${id}-consent.json`), () => clock)
    m.relay = net.relayFor(m)
    m.keys.set(id, m.pub)
    m.deps = {
      key: m.key, relay: m.relay, store: m.store, backend: backend.as(userId),
      self: async () => ({ machineId: id, accountId: userId, email }),
      ownPanes: async (tabId) => m.panes.has(tabId) ? m.panes.get(tabId)! : [],
      // The tab setting's leader as the account's directory lists it: one of its panes, or a harness the roster of the
      // account's live share of the tab lists (a member's); none once it is neither (the backend derives it). Not known
      // before the directory is read.
      ownLeader: async (tabId) => {
        const panes = m.panes.has(tabId) ? m.panes.get(tabId)! : []
        const leader = backend.leaders.get(`${userId}:${tabId}`) ?? null
        const live = [...backend.shares.values()].find((s) => s.ownerUserId === userId && s.tabId === tabId && !s.stopped)
        const listed = parseRoster(String((live?.roster as SignedRoster | null)?.body))?.harnesses ?? []
        const is = (h: { machineId: string; agentId: string }) => !!leader && h.machineId === leader.machineId && h.agentId === leader.agentId
        return panes === null ? undefined : leader && (panes.some(is) || listed.some(is)) ? leader : null
      },
      machineKey: async (machineId) => m.keys.get(machineId) ?? null,
      askMachine: async (machineId, payload) => {
        m.asked.push([machineId, payload])
        if (m.answer) return m.answer(machineId, payload)
        const target = net.machines.get(machineId)
        if (!target?.online || target.userId !== userId) return null
        // As service.ts answers and its `askMachine` gives it back: a refusal is that machine's word, not a failure.
        try { return await remote(target, payload) } catch (error) { return { error: { code: (error as MessageError).code, message: (error as Error).message } } }
      },
      ownMachines: async () => m.mine !== undefined ? m.mine : [...net.machines.values()].filter((x) => x.userId === userId).map((x) => x.id),
      requests: new RequestStore(join(root, `${id}-requests.json`)), consent: m.consent, now: () => clock,
    }
    m.shared = new SharedTabs(m.deps)
    net.machines.set(id, m)
    return m
  }
  const alice = make(ids.alice ?? 'm2-alice', 'u-alice', 'alice@x.io')
  const bob = make(ids.bob ?? 'm3-bob', 'u-bob', 'bob@y.io')
  alice.panes.set('tab-1', [{ machineId: alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }])
  return { backend, net, alice, bob, make, tick: (ms: number) => { clock += ms } }
}
type World = ReturnType<typeof world>

const harnessOf = (m: Machine, agentId: string) => ({ machineId: m.id, agentId, name: agentId, engine: 'claude' })
const roster = (m: Machine, id: string): Roster => m.store.current(id)!.roster
const agents = (r: Roster) => r.harnesses.map((h) => `${h.machineId}/${h.agentId}`)

async function share(w: World): Promise<string> {
  const { sharedTabId } = await w.alice.shared.share('tab-1', 'app')
  await w.net.settle()
  return sharedTabId
}
/** Alice shares tab-1 and Bob accepts her invitation; Alice's refresh lists him. */
async function joined(w: World): Promise<string> {
  const id = await share(w)
  await w.alice.shared.invite(id, ['bob@y.io'], 7)
  const [invite] = await w.bob.shared.invites()
  await w.bob.shared.accept(invite.id)
  await w.alice.shared.refresh()
  await w.net.settle()
  return id
}
async function added(w: World, agentId = 'api'): Promise<string> {
  const id = await joined(w)
  await w.bob.shared.addHarness(id, harnessOf(w.bob, agentId))
  await w.net.settle()
  return id
}

/** Alice's own harness in tab-1, which may lead it: the backend takes only a harness of the tab on the account's machines. */
const LEAD_OF = (w: World) => ({ machineId: w.alice.id, agentId: 'lead' })
/** The owner chooses a leader (its tab setting, from any of its computers), and the computer that shares the tab signs it
 *  as it does on the `desk_changed` the choice causes: a roster change any test can make. */
async function lead(w: World, id: string, leader: { machineId: string; agentId: string } | null, sharer = w.alice): Promise<void> {
  await w.alice.shared.setLeader(id, leader)
  await sharer.shared.refresh()
}

/** What a window reads and then dismisses, as the first notices were read once. */
const readAll = (shared: SharedTabs): SharedNotice[] => {
  const seen = shared.notices()
  for (const n of seen) shared.dismissNotice(n.id)
  return seen
}

describe('the owner', () => {
  it('shares with the backend\'s id: version 1 with its panes, then version 2 signed with the id it got back', async () => {
    const w = world()
    const id = await share(w)
    expect(id).toBe(shareIdOf('u-alice', 'tab-1'))
    expect(w.backend.puts.map((p) => p.version)).toEqual([1, 2])
    const first = parseRoster(w.backend.puts[0].roster.body)!, second = parseRoster(w.backend.puts[1].roster.body)!
    // Nothing derived here: the first knows no id, the second carries the one the backend gave.
    expect(first.sharedTabId).not.toBe(id)
    expect(agents(first)).toEqual(['m2-alice/lead'])
    expect(second).toMatchObject({ sharedTabId: id, version: 2, name: 'app', leader: null,
      owner: { accountId: 'u-alice', email: 'alice@x.io', machineId: 'm2-alice', machinePublicKey: w.alice.pub } })
    // Its own key pinned, its own roster held, its relay open.
    expect(roster(w.alice, id).version).toBe(2)
    expect(w.alice.shared.rosters().map((r) => r.sharedTabId)).toEqual([id])
    expect(w.alice.relay.open).toHaveBeenCalledWith(id)
  })

  it('shares a tab already shared from here once, and refuses one shared from another of its computers', async () => {
    const w = world()
    const id = await share(w)
    expect(await w.alice.shared.share('tab-1', 'again')).toEqual({ sharedTabId: id })
    expect(w.backend.puts).toHaveLength(2)
    const other = w.make('m9-alice', 'u-alice', 'alice@x.io')
    await expect(other.shared.share('tab-1', 'app')).rejects.toMatchObject({ code: 'SHARED_ELSEWHERE' })
  })

  it('says what went wrong when the backend refuses or cannot be read', async () => {
    const w = world()
    w.backend.down = true
    await expect(w.alice.shared.share('tab-1', 'app')).rejects.toMatchObject({ code: 'SHARES_UNAVAILABLE' })
    w.backend.down = false
    // The desk cannot be read: shared with no harness yet, which the next refresh adds.
    w.alice.panes.set('tab-2', null)
    const empty = await w.alice.shared.share('tab-2', 'later')
    expect(roster(w.alice, empty.sharedTabId).harnesses).toEqual([])
    // A refusal the backend explains is told as it said it.
    const busy = new SharedTabs({ ...w.alice.deps, backend: async (method, path, body) => method === 'PUT'
      ? { status: 409, body: { success: false, error: { code: 'STALE_ROSTER', message: 'A newer roster is already shared.' } } } : w.alice.deps.backend(method, path, body) })
    await expect(busy.share('tab-3', 'app')).rejects.toMatchObject({ code: 'STALE_ROSTER', message: 'A newer roster is already shared.' })
    // Refused with the version held, it signs once more past it; refused again, it says so and tries no third time.
    const versions: number[] = []
    const racing = new SharedTabs({ ...w.alice.deps, backend: async (method, path, body) => {
      if (method !== 'PUT') return w.alice.deps.backend(method, path, body)
      versions.push((body as { version: number }).version)
      return { status: 409, body: { success: false, error: { code: 'STALE_ROSTER', message: 'A newer roster is already shared.', version: 6 } } }
    } })
    await expect(racing.share('tab-4', 'app')).rejects.toMatchObject({ code: 'STALE_ROSTER' })
    expect(versions).toEqual([1, 7])
  })

  it('says shared tabs need a newer backend when their routes do not exist there (404 with no code), never that it is unreachable', async () => {
    // Version skew (plan Task D3, case 3): a backend from before shared tabs answers each of their routes as Fastify does
    // any route it does not have.
    const w = world()
    const id = await joined(w)
    const puts = w.backend.puts.length
    let old = true
    const before = (m: Machine): SharedTabsDeps['backend'] => async (method, path, body) => (old
      ? { status: 404, body: { message: `Route ${method}:${path} not found`, error: 'Not Found', statusCode: 404 } } : m.deps.backend(method, path, body))
    const alice = new SharedTabs({ ...w.alice.deps, backend: before(w.alice) })
    const bob = new SharedTabs({ ...w.bob.deps, backend: before(w.bob) })
    const unsupported = { code: 'SHARED_TABS_UNSUPPORTED', message: 'Shared tabs need a newer Harness service; nothing was shared.' }
    await expect(alice.share('tab-2', 'app')).rejects.toMatchObject(unsupported)
    await expect(alice.invite(id, ['carol@z.io'], 7)).rejects.toMatchObject(unsupported)
    await expect(alice.revoke('inv-1')).rejects.toMatchObject(unsupported)
    await expect(alice.stop(id)).rejects.toMatchObject(unsupported)
    await expect(alice.move(id)).rejects.toMatchObject(unsupported)
    await expect(bob.invites()).rejects.toMatchObject(unsupported)
    await expect(bob.accept('inv-1')).rejects.toMatchObject(unsupported)
    await expect(bob.untrusted()).rejects.toMatchObject(unsupported)
    await expect(bob.retrustOffer(id)).rejects.toMatchObject(unsupported)
    await expect(bob.leave(id)).rejects.toMatchObject(unsupported)
    expect(w.backend.puts).toHaveLength(puts)
    // A refresh reads nothing, and still opens the relay of every tab held: nothing to say, as the desk changes.
    w.alice.relay.open.mockClear()
    await expect(alice.refresh()).resolves.toBeUndefined()
    expect(w.alice.relay.open).toHaveBeenCalledWith(id)
    // A 404 the route explains is its own answer: an invitation gone is told as it said it.
    old = false
    await expect(alice.revoke('inv-404')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    // A backend that cannot be asked at all is no older one: the refresh fails as it did.
    const broken = new SharedTabs({ ...w.alice.deps, backend: async () => { throw new Error('no core to ask') } })
    await expect(broken.refresh()).rejects.toThrow('no core to ask')
  })

  it('shares a stopped tab again, from this computer or another of the owner\'s, and an old member accepts it afresh', async () => {
    const w = world()
    const id = await added(w)
    await lead(w, id, LEAD_OF(w))
    await w.net.settle()
    const old = roster(w.bob, id).version
    expect(w.backend.shares.get(id)!.version).toBe(old)
    await w.alice.shared.stop(id)
    expect(await w.alice.shared.share('tab-1', 'app')).toEqual({ sharedTabId: id })
    // Its version carries on past the stopped share's: version 1 is refused with the version held, and signed past it. The
    // leader is the tab setting's, which Stop Sharing leaves.
    expect(roster(w.alice, id)).toMatchObject({ version: old + 2, members: [], leader: LEAD_OF(w) })
    expect(w.backend.puts.slice(-2).map((p) => p.version)).toEqual([old + 1, old + 2])
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    // Bob never heard the stop and still holds the old roster, at a lower version than the new one's.
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    await w.bob.shared.accept((await w.bob.shared.invites())[0].id)
    expect(roster(w.bob, id).version).toBe(old + 3)
    // Stopped again, and shared from Alice's laptop: the laptop is the tab's computer now, and the version still grows.
    await w.alice.shared.stop(id)
    const laptop = w.make('m9-alice', 'u-alice', 'alice@x.io')
    laptop.panes.set('tab-1', [{ machineId: 'm9-alice', agentId: 'web', name: 'web', engine: 'claude' }])
    expect(await laptop.shared.share('tab-1', 'app')).toEqual({ sharedTabId: id })
    expect(roster(laptop, id).owner.machineId).toBe('m9-alice')
    expect(roster(laptop, id).version).toBe(old + 5)
    expect(w.backend.shares.get(id)).toMatchObject({ ownerMachineId: 'm9-alice', version: old + 5 })
  })

  it('never takes a tab it holds as another computer\'s for its own, whatever the backend lists', async () => {
    const w = world()
    const id = await added(w)
    const pinned = roster(w.bob, id)
    const puts = w.backend.puts.length
    // The backend says Bob's computer owns Alice's tab.
    const lying: SharedTabsDeps['backend'] = async (method, path, body) => {
      const reply = await w.bob.deps.backend(method, path, body)
      if (method === 'GET' && path === '/api/agent-messages/shares') {
        const data = reply.body.data as { shares: Record<string, unknown>[] }
        data.shares = data.shares.map((s) => ({ ...s, owner: true, ownerMachineId: w.bob.id, tabId: 'tab-1', members: [], invites: [] }))
      }
      return reply
    }
    w.bob.shared = new SharedTabs({ ...w.bob.deps, backend: lying })
    await w.bob.shared.refresh()
    await w.net.settle()
    expect(roster(w.bob, id)).toEqual(pinned)
    expect(w.backend.puts.length).toBe(puts)
    // Alice's tab's id is not one derived from Bob's account: recorded, and nothing signed (review of A7).
    expect(w.bob.store.alerts()).toEqual([{ id: expect.any(String), sharedTabId: id, at: expect.any(String), error: 'share_id_mismatch' }])
    // Nor by answering a share with the id of that tab, which is not the id of Bob's own tab: Bob's pin stays its owner's.
    const answering = new SharedTabs({ ...w.bob.deps, backend: async (method, path, body) => method === 'PUT'
      ? { status: 200, body: { success: true, data: { sharedTabId: id, version: 1 } } } : w.bob.deps.backend(method, path, body) })
    await expect(answering.share('tab-9', 'mine')).rejects.toMatchObject({ code: 'SHARE_ID_MISMATCH' })
    expect(roster(w.bob, id)).toEqual(pinned)
    // Nor a tab Bob holds as another's under the very id his own tab gets (its owner signed a roster for that id).
    const mine = shareIdOf('u-bob', 'tab-9'), carol = newIdentity()
    w.bob.store.pin(mine, b64e(carol.pub))
    w.bob.store.offer(resign(carol, { ...pinned, sharedTabId: mine, owner: { ...pinned.owner, machinePublicKey: b64e(carol.pub) } }))
    await expect(new SharedTabs(w.bob.deps).share('tab-9', 'mine')).rejects.toMatchObject({ code: 'NOT_OWNER' })
    expect(roster(w.bob, mine).owner.machinePublicKey).toBe(b64e(carol.pub))
    // Alice's next roster is still Bob's to take.
    await lead(w, id, LEAD_OF(w))
    await w.net.settle()
    expect(roster(w.bob, id).version).toBe(pinned.version + 1)
  })

  it('bumps the version by one for every change, signs it, PUTs it, keeps it, and sends it sealed to every other machine', async () => {
    const w = world()
    const id = await added(w)
    const before = roster(w.alice, id).version
    const puts = w.backend.puts.length
    await lead(w, id, LEAD_OF(w))
    await w.net.settle()
    expect(w.backend.puts.length).toBe(puts + 1)
    expect(w.backend.puts.at(-1)!.version).toBe(before + 1)
    expect(roster(w.alice, id)).toMatchObject({ version: before + 1, leader: LEAD_OF(w) })
    // Bob's machine is in the roster: it got the new one over the relay, sealed, not from the backend.
    const calls = w.backend.calls.length
    expect(roster(w.bob, id).version).toBe(before + 1)
    expect(w.backend.calls.length).toBe(calls)
    expect(w.net.sent.filter((s) => s.from === w.alice.id && s.to === w.bob.id).at(-1)!.payload).toHaveProperty('__e2e')
    // The same leader again is no change; none clears it.
    await lead(w, id, LEAD_OF(w))
    expect(w.backend.puts.length).toBe(puts + 1)
    await lead(w, id, null)
    expect(roster(w.alice, id).leader).toBeNull()
  })

  it('refreshes: adds accepted members, drops removed ones with their harnesses, re-reads its panes, republishes only on a change', async () => {
    const w = world()
    const id = await share(w)
    await w.alice.shared.invite(id, ['bob@y.io'], 30)
    expect(roster(w.alice, id).invites).toEqual([{ email: 'bob@y.io', expiresAt: '2026-11-01T00:00:00.000Z' }])
    const [invite] = await w.bob.shared.invites()
    await w.bob.shared.accept(invite.id)
    await w.alice.shared.refresh()
    expect(roster(w.alice, id)).toMatchObject({ members: [{ accountId: 'u-bob', email: 'bob@y.io', name: 'bob', acceptedAt: '2026-10-15T00:00:00.000Z' }], invites: [] })
    // Nothing changed: nothing is put.
    const puts = w.backend.puts.length
    await w.alice.shared.refresh()
    expect(w.backend.puts.length).toBe(puts)
    // A pane added on the desk is in the next roster, with its machine's key; one whose key cannot be read is left out.
    const alice2 = newIdentity()
    w.alice.keys.set('m5-alice', b64e(alice2.pub))
    w.alice.panes.set('tab-1', [...w.alice.panes.get('tab-1')!, { machineId: 'm5-alice', agentId: 'web', name: 'web', engine: 'claude' },
      { machineId: 'm6-away', agentId: 'x', name: 'x', engine: 'claude' }])
    await w.alice.shared.refresh()
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead', 'm5-alice/web'])
    // The machine is away now: the key the roster has is kept.
    w.alice.keys.set('m5-alice', null)
    await w.alice.shared.refresh()
    expect(w.backend.puts.length).toBe(puts + 1)
    // The desk unreadable: the owner's panes stay as they were.
    w.alice.panes.set('tab-1', null)
    await w.alice.shared.refresh()
    expect(w.backend.puts.length).toBe(puts + 1)
    w.alice.panes.set('tab-1', [{ machineId: w.alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }])
    await w.net.settle()
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toContain(`${w.bob.id}/api`)
    // Bob removed on the backend (from another of Alice's devices): the next refresh drops him and his harness.
    w.backend.members.get(id)!.delete('u-bob')
    await w.alice.shared.refresh()
    expect(roster(w.alice, id).members).toEqual([])
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
  })

  it('keeps the backend\'s version as a floor, and rebuilds a roster its store lost', async () => {
    const w = world()
    const id = await share(w)
    // The store lost the tab (a new data folder): the next refresh pins its own key again and starts past the backend.
    w.alice.store.forget(id)
    await w.alice.shared.refresh()
    expect(roster(w.alice, id).version).toBe(2)
    expect(w.backend.puts).toHaveLength(2)
    // Only the version 1 the backend holds, with no id in it: rebuilt with no name to keep.
    // A key pinned that is no longer this computer's (a new identity) gives way to its own.
    w.alice.store.forget(id)
    w.alice.store.pin(id, b64e(newIdentity().pub))
    await w.alice.shared.refresh()
    expect(roster(w.alice, id).owner.machinePublicKey).toBe(w.alice.pub)
    const v = world()
    await v.alice.shared.share('tab-1', 'app').catch(() => {})
    const sid = shareIdOf('u-alice', 'tab-1')
    v.backend.shares.get(sid)!.roster = v.backend.puts[0].roster
    v.backend.shares.get(sid)!.version = 1
    v.alice.store.forget(sid)
    await v.alice.shared.refresh()
    // Past the version it last put itself, which it remembers.
    expect(roster(v.alice, sid)).toMatchObject({ version: 3, name: 'app' })
    v.backend.shares.get(sid)!.roster = { nonsense: true }
    v.alice.store.forget(sid)
    await v.alice.shared.refresh()
    expect(roster(v.alice, sid)).toMatchObject({ version: 4, name: '' })
  })

  it('applies a member\'s add and remove, and refuses a harness in another account\'s name', async () => {
    const w = world()
    const id = await added(w)
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead', `${w.bob.id}/api`])
    expect(roster(w.alice, id).harnesses[1]).toEqual({ accountId: 'u-bob', machineId: w.bob.id, machinePublicKey: w.bob.pub, agentId: 'api', name: 'api', engine: 'claude' })
    // The member's copy shows it, and its request is settled.
    expect(agents(roster(w.bob, id))).toEqual(agents(roster(w.alice, id)))
    expect(w.bob.shared.pending()).toEqual([])
    await w.bob.shared.removeHarness(id, w.bob.id, 'api')
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    expect(agents(roster(w.bob, id))).toEqual(['m2-alice/lead'])
    // Sealed by hand, as a member's daemon could: a harness claimed for Alice's account, from Bob, is refused.
    const link: TabLink = { sharedTabId: id, machineId: w.alice.id, peerPub: w.alice.pub }
    const forged = await w.bob.key.seal(link, { kind: 'roster_request', id: 'x', op: 'add',
      harness: { accountId: 'u-alice', machineId: w.bob.id, machinePublicKey: w.bob.pub, agentId: 'evil', name: 'evil', engine: 'claude' } })
    await w.bob.relay.send(id, w.alice.id, (forged as { frame: Record<string, unknown> }).frame)
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    expect(w.bob.shared.notices()).toEqual([])
  })

  it('refuses requests it cannot apply, and tells the member why', async () => {
    const w = world()
    const id = await added(w)
    const link: TabLink = { sharedTabId: id, machineId: w.alice.id, peerPub: w.alice.pub }
    const send = async (frame: Record<string, unknown>) => {
      const sealed = await w.bob.key.seal(link, frame) as { frame: Record<string, unknown> }
      await w.bob.relay.send(id, w.alice.id, sealed.frame)
      await w.net.settle()
    }
    const opened = vi.spyOn(w.bob.key, 'open')
    const other = newIdentity()
    const h = (over: Record<string, unknown>) => ({ accountId: 'u-bob', machineId: w.bob.id, machinePublicKey: w.bob.pub, agentId: 'z', name: 'z', engine: 'claude', ...over })
    // Bob's own machine under a key its session did not prove.
    await send({ kind: 'roster_request', id: 'add:a', op: 'add', harness: h({ machinePublicKey: b64e(other.pub) }) })
    // Another machine of his, under any key: a harness is added only from its own machine.
    await send({ kind: 'roster_request', id: 'add:b', op: 'add', harness: h({ machineId: 'm7-bob', machinePublicKey: b64e(other.pub) }) })
    await send({ kind: 'roster_request', id: 'add:c', op: 'add', harness: h({ machineId: 'm7-bob', machinePublicKey: w.bob.pub, agentId: 'c' }) })
    // Alice's account, Alice's machine, Alice's harness: never his to add or remove.
    await send({ kind: 'roster_request', id: 'add:d', op: 'add', harness: h({ accountId: 'u-alice' }) })
    await send({ kind: 'roster_request', id: 'add:e', op: 'add', harness: h({ machineId: w.alice.id, machinePublicKey: w.alice.pub, agentId: 'e' }) })
    await send({ kind: 'roster_request', id: 'remove:f', op: 'remove', harness: { machineId: w.alice.id, agentId: 'lead' } })
    // One that is not there is already removed; a harness that is not one is refused; nonsense is not answered.
    await send({ kind: 'roster_request', id: 'remove:g', op: 'remove', harness: { machineId: w.bob.id, agentId: 'ghost' } })
    await send({ kind: 'roster_request', id: 'add:h', op: 'add', harness: { machineId: 7 } })
    await send({ kind: 'roster_request', id: 'remove:i', op: 'remove', harness: null })
    await send({ kind: 'roster_request', id: 'j', op: 'rename', harness: h({}) })
    await send({ kind: 'roster_request', op: 'add', harness: h({}) })
    const answers = (await Promise.all(opened.mock.results.map((r) => r.value as Promise<{ frame?: Record<string, unknown> }>)))
      .map((r) => r.frame!).map((f) => f.kind === 'roster_refused' ? `${f.id} ${f.error}` : `${f.kind}`)
    expect(answers).toEqual(['add:a KEY_MISMATCH', 'add:b FORBIDDEN', 'add:c FORBIDDEN', 'add:d FORBIDDEN', 'add:e FORBIDDEN', 'remove:f FORBIDDEN',
      'roster', 'add:h INVALID_HARNESS', 'remove:i INVALID_HARNESS'])
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead', `${w.bob.id}/api`])
    // None of these was a request Bob's daemon queued: nothing to tell the person.
    expect(w.bob.shared.notices()).toEqual([])
  })

  it('answers an add beyond the harness limit with TAB_FULL, which the member\'s next shares read shows', async () => {
    const w = world()
    w.alice.panes.set('tab-1', Array.from({ length: ROSTER_LIMITS.harnesses - 1 }, (_, i) => ({ machineId: w.alice.id, agentId: `a${i}`, name: `a${i}`, engine: 'codex' })))
    const id = await added(w, 'api')
    expect(roster(w.alice, id).harnesses).toHaveLength(ROSTER_LIMITS.harnesses)
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'more'))
    await w.net.settle()
    expect(roster(w.alice, id).harnesses).toHaveLength(ROSTER_LIMITS.harnesses)
    expect(w.bob.shared.pending()).toEqual([])
    expect(readAll(w.bob.shared)).toEqual([{ id: expect.any(String), sharedTabId: id, kind: 'refused', error: 'TAB_FULL', machineId: w.bob.id, agentId: 'more', at: expect.any(String) }])
    // Dismissed: the next read is empty.
    expect(w.bob.shared.notices()).toEqual([])
    // An owner's desk with more panes than a roster holds is cut to the limit, never refused.
    w.alice.panes.set('tab-1', Array.from({ length: ROSTER_LIMITS.harnesses + 3 }, (_, i) => ({ machineId: w.alice.id, agentId: `b${i}`, name: `b${i}`, engine: 'codex' })))
    await w.alice.shared.refresh()
    expect(roster(w.alice, id).harnesses).toHaveLength(ROSTER_LIMITS.harnesses)
  })

  it('refuses a member\'s changes beyond 30 in ten minutes (RATE_LIMITED), and takes them again after; repeats never count', async () => {
    const w = world()
    // One change so far: the add that put Bob's harness in.
    const id = await added(w)
    const link: TabLink = { sharedTabId: id, machineId: w.alice.id, peerPub: w.alice.pub }
    const answered = vi.spyOn(w.bob.key, 'open')
    const send = async (op: 'add' | 'remove', agentId: string): Promise<string> => {
      const harness = { accountId: 'u-bob', machineId: w.bob.id, machinePublicKey: w.bob.pub, agentId, name: agentId, engine: 'claude' }
      const sealed = await w.bob.key.seal(link, { kind: 'roster_request', id: `${op}:${w.bob.id}/${agentId}`, op, harness })
      await w.bob.relay.send(id, w.alice.id, (sealed as { frame: Record<string, unknown> }).frame)
      await w.net.settle()
      const last = (await answered.mock.results.at(-1)!.value as { frame: Record<string, unknown> }).frame
      return last.kind === 'roster_refused' ? `${last.id} ${last.error}` : String(last.kind)
    }
    // A member sends what waits again on every retry, refresh and new session: repeats and removes already done are
    // answered with the roster, however many.
    for (let n = 0; n < 40; n++) expect(await send(n % 2 ? 'add' : 'remove', n % 2 ? 'api' : `ghost${n}`)).toBe('roster')
    for (let n = 1; n < 30; n++) expect(await send('add', `a${n}`)).toBe('roster')
    expect(roster(w.alice, id).harnesses).toHaveLength(31)
    expect(await send('remove', 'api')).toBe(`remove:${w.bob.id}/api RATE_LIMITED`)
    // Still answered while limited: a repeat of an add already applied.
    expect(await send('add', 'a1')).toBe('roster')
    // Each change counts from when it came: ten minutes on, the member changes the roster again.
    w.tick(10 * 60_000)
    expect(await send('remove', 'api')).toBe('roster')
    expect(roster(w.alice, id).harnesses).toHaveLength(30)
  })

  it('tells its windows when a notice or a waiting request changes, and when a refresh reads other invitations or untrusted tabs', async () => {
    const w = world()
    const id = await added(w)
    const announce = vi.fn()
    w.alice.deps.announce = announce
    w.bob.deps.announce = announce
    // A notice, and nothing else, once.
    w.alice.relay.send.mockResolvedValueOnce(false)
    await lead(w, id, LEAD_OF(w))
    expect(w.alice.shared.notices()).toHaveLength(1)
    expect(announce).toHaveBeenCalledTimes(1)
    // A request that waits for the owner: written down, and told.
    announce.mockClear()
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'web'))
    expect(announce).toHaveBeenCalledTimes(1)
    w.alice.online = true
    announce.mockClear()
    // A new invitation is read once; the same one read again tells nothing.
    const carol = w.make('m4-carol', 'u-carol', 'carol@z.io')
    carol.deps.announce = announce
    await w.alice.shared.invite(id, ['carol@z.io'], 7)
    await carol.shared.refresh()
    expect(announce).toHaveBeenCalledTimes(1)
    await carol.shared.refresh()
    expect(announce).toHaveBeenCalledTimes(1)
    // The invitations cannot be read now: what a refresh cannot see it does not tell.
    const [invite] = await carol.shared.invites()
    await w.alice.shared.revoke(invite.id)
    const real = carol.deps.backend
    carol.deps.backend = async (method, path, body) => path === '/api/agent-messages/invites' ? { status: 502, body: {} } : real(method, path, body)
    await carol.shared.refresh()
    expect(announce).toHaveBeenCalledTimes(1)
    carol.deps.backend = real
    await carol.shared.refresh()
    expect(announce).toHaveBeenCalledTimes(2)
  })

  it('keeps a notice until it is dismissed, and announces both', async () => {
    const w = world()
    const announce = vi.fn()
    w.alice.deps.announce = announce
    const id = await added(w)
    w.alice.relay.send.mockResolvedValueOnce(false)
    await lead(w, id, LEAD_OF(w))
    // The notice, and the request queue's own save, tell the windows.
    expect(announce).toHaveBeenCalledTimes(2)
    const [n] = w.alice.shared.notices()
    expect(n).toMatchObject({ id: expect.any(String), kind: 'unsent' })
    expect(w.alice.shared.notices()).toEqual([n])
    expect(w.alice.shared.dismissNotice('gone')).toBe(false)
    expect(announce).toHaveBeenCalledTimes(2)
    expect(w.alice.shared.dismissNotice(n.id)).toBe(true)
    expect(w.alice.shared.notices()).toEqual([])
    expect(announce).toHaveBeenCalledTimes(3)
  })

  it('does not announce a repeated removed notice it skips', async () => {
    const w = world()
    const id = await added(w)
    const announce = vi.fn(), notices = new NoticeStore(null)
    notices.add({ sharedTabId: id, kind: 'removed' })
    const bob = new SharedTabs({ ...w.bob.deps, notices, announce })
    await bob.onFrame({ sharedTabId: id, closed: { code: 4403, reason: 'not in the tab' } })
    expect(notices.unread()).toHaveLength(1)
    // Leaving the tab tells the windows once by itself; a notice that was added would make it twice.
    expect(announce).toHaveBeenCalledTimes(1)
    const fresh = vi.fn(), again = world(), other = await added(again)
    const carol = new SharedTabs({ ...again.bob.deps, announce: fresh })
    await carol.onFrame({ sharedTabId: other, closed: { code: 4403, reason: 'not in the tab' } })
    expect(fresh).toHaveBeenCalledTimes(2)
  })

  it('tells the owner when a sealed frame could not be sent (unsent), once per machine until read', async () => {
    const w = world()
    const id = await added(w)
    w.alice.relay.send.mockResolvedValueOnce(false).mockResolvedValueOnce(false)
    await lead(w, id, LEAD_OF(w))
    await lead(w, id, null)
    expect(readAll(w.alice.shared)).toEqual([{ id: expect.any(String), sharedTabId: id, kind: 'unsent', machineId: w.bob.id, at: expect.any(String) }])
    await lead(w, id, LEAD_OF(w))
    await w.net.settle()
    expect(w.alice.shared.notices()).toEqual([])
    expect(roster(w.bob, id).leader).toEqual(LEAD_OF(w))
  })

  it('never signs for an own share the backend lists under an id it did not derive: alerts once, and refuses to move it', async () => {
    const w = world()
    const real = w.alice.deps.backend, own = shareIdOf('u-alice', 'tab-1'), foreign = 'f'.repeat(24)
    // The backend answered the share with an id of its own, and lists the share under it from then on.
    w.alice.deps.backend = async (method, path, body) => {
      const reply = await real(method, path, body)
      if (method === 'PUT') return ok({ ...reply.body.data as object, sharedTabId: foreign })
      if (method === 'GET' && path === '/api/agent-messages/shares') {
        const data = reply.body.data as { shares: Array<Record<string, unknown>> }
        data.shares = data.shares.map((s) => s.sharedTabId === own ? { ...s, sharedTabId: foreign } : s)
      }
      return reply
    }
    await expect(w.alice.shared.share('tab-1', 'app')).rejects.toMatchObject({ code: 'SHARE_ID_MISMATCH' })
    const puts = w.backend.puts.length
    await w.alice.shared.refresh()
    await w.alice.shared.refresh()
    expect(w.backend.puts).toHaveLength(puts)
    expect(w.alice.shared.rosters()).toEqual([])
    expect(w.alice.store.pinned(foreign)).toBeNull()
    expect(w.alice.store.alerts()).toEqual([{ id: expect.any(String), sharedTabId: foreign, at: expect.any(String), error: 'share_id_mismatch' }])
    await expect(w.alice.shared.move(foreign)).rejects.toMatchObject({ code: 'SHARE_ID_MISMATCH' })
    // Shared again, the tab the backend lists under its own id is not taken for this one's.
    await expect(w.alice.shared.share('tab-1', 'app')).rejects.toMatchObject({ code: 'SHARE_ID_MISMATCH' })
    expect(w.backend.puts).toHaveLength(puts)
  })

  it('tells the owner when its desk has more panes than a roster holds (TAB_FULL), once until read', async () => {
    const w = world()
    const panes = (n: number) => Array.from({ length: n }, (_, i) => ({ machineId: w.alice.id, agentId: `p${i}`, name: `p${i}`, engine: 'codex' }))
    w.alice.panes.set('tab-1', panes(ROSTER_LIMITS.harnesses + 2))
    const id = await share(w)
    expect(roster(w.alice, id).harnesses).toHaveLength(ROSTER_LIMITS.harnesses)
    // Cut again before the person read the first: still one notice.
    w.alice.panes.set('tab-1', panes(ROSTER_LIMITS.harnesses + 3).reverse())
    await w.alice.shared.refresh()
    expect(roster(w.alice, id).harnesses[0].agentId).toBe(`p${ROSTER_LIMITS.harnesses + 2}`)
    expect(readAll(w.alice.shared)).toEqual([{ id: expect.any(String), sharedTabId: id, kind: 'full', error: 'TAB_FULL', at: expect.any(String) }])
    // A refresh that changes nothing tells nothing; a change that cuts again tells again; one within the limit, nothing.
    await w.alice.shared.refresh()
    expect(w.alice.shared.notices()).toEqual([])
    w.alice.panes.set('tab-1', panes(ROSTER_LIMITS.harnesses + 4))
    await w.alice.shared.refresh()
    expect(readAll(w.alice.shared)).toEqual([{ id: expect.any(String), sharedTabId: id, kind: 'full', error: 'TAB_FULL', at: expect.any(String) }])
    w.alice.panes.set('tab-1', panes(3))
    await w.alice.shared.refresh()
    expect(roster(w.alice, id).harnesses).toHaveLength(3)
    expect(w.alice.shared.notices()).toEqual([])
  })

  it('names the share itself, from its account and the desk tab, and refuses another id the backend answers (SHARE_ID_MISMATCH)', async () => {
    const w = world()
    const real = w.alice.deps.backend
    w.alice.deps.backend = async (method, path, body) => {
      const reply = await real(method, path, body)
      return method === 'PUT' ? ok({ ...reply.body.data as object, sharedTabId: 'f'.repeat(24) }) : reply
    }
    await expect(w.alice.shared.share('tab-1', 'app')).rejects.toMatchObject({ code: 'SHARE_ID_MISMATCH' })
    expect(w.alice.shared.rosters()).toEqual([])
    expect(w.backend.puts).toHaveLength(1)
    w.alice.deps.backend = real
    expect(await w.alice.shared.share('tab-1', 'app')).toEqual({ sharedTabId: shareIdOf('u-alice', 'tab-1') })
  })

  it('refuses to sign a roster too large for its members to take (TAB_FULL), and puts nothing', async () => {
    const w = world()
    // Six bytes each in JSON (a lone surrogate), within every length the roster checks.
    const wide = (n: number) => '\ud800'.repeat(n), machine = wide(160)
    w.alice.keys.set(machine, w.alice.pub)
    w.alice.panes.set('tab-1', Array.from({ length: ROSTER_LIMITS.harnesses }, (_, i) => ({ machineId: machine, agentId: `${i}${wide(150)}`, name: wide(200), engine: wide(64) })))
    await expect(w.alice.shared.share('tab-1', 'app')).rejects.toMatchObject({ code: 'TAB_FULL' })
    expect(w.backend.puts).toEqual([])
  })

  it('invites each address once, up to the free seats, and says which were refused; a revoked invitation leaves the roster', async () => {
    const w = world()
    const id = await share(w)
    const emails = ['Carol@Z.io', 'carol@z.io', 'alice@x.io', ...Array.from({ length: 8 }, (_, i) => `p${i}@q.io`)]
    const answer = await w.alice.shared.invite(id, emails, 90)
    expect(answer.invited).toEqual(['carol@z.io', 'p0@q.io', 'p1@q.io', 'p2@q.io', 'p3@q.io', 'p4@q.io', 'p5@q.io'])
    expect(answer.refused).toEqual([{ email: 'alice@x.io', error: 'SELF_INVITE' }, { email: 'p6@q.io', error: 'TAB_FULL' }, { email: 'p7@q.io', error: 'TAB_FULL' }])
    expect(roster(w.alice, id).invites.map((i) => i.email)).toEqual(answer.invited)
    const carol = [...w.backend.invites.values()].find((i) => i.email === 'carol@z.io')!
    await w.alice.shared.revoke(carol.id)
    expect(roster(w.alice, id).invites.map((i) => i.email)).not.toContain('carol@z.io')
    await expect(w.alice.shared.revoke('inv-none')).rejects.toMatchObject({ code: 'NOT_FOUND' })
    await expect(w.alice.shared.invite(id, ['x@y.io'], 3 as never)).rejects.toMatchObject({ code: 'USAGE' })
    await expect(w.alice.shared.invite(id, 'x@y.io' as never, 7)).rejects.toMatchObject({ code: 'USAGE' })
  })

  it('removes a member and its harnesses, and drops the session with its machine', async () => {
    const w = world()
    const id = await added(w)
    const drop = vi.spyOn(w.alice.key, 'drop')
    await w.alice.shared.removeMember(id, 'u-bob')
    expect(roster(w.alice, id)).toMatchObject({ members: [] })
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    expect(drop).toHaveBeenCalledWith(expect.objectContaining({ sharedTabId: id, machineId: w.bob.id }))
    await expect(w.alice.shared.removeMember(id, 'u-nobody')).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('removes a member\'s harness itself, but not one of its own desk\'s panes', async () => {
    const w = world()
    const id = await added(w)
    await w.alice.shared.removeHarness(id, w.bob.id, 'api')
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    await expect(w.alice.shared.removeHarness(id, w.alice.id, 'lead')).rejects.toMatchObject({ code: 'OWNER_PANE' })
    await expect(w.alice.shared.removeHarness(id, w.bob.id, 'api')).rejects.toMatchObject({ code: 'NOT_IN_TAB' })
  })

  it('stops sharing: the backend share goes, and so do its roster, relay and sessions here', async () => {
    const w = world()
    const id = await added(w)
    await w.alice.shared.stop(id)
    expect(w.backend.shares.get(id)!.stopped).toBe(true)
    expect(w.alice.shared.rosters()).toEqual([])
    expect(w.alice.store.pinned(id)).toBeNull()
    expect(w.alice.relay.close).toHaveBeenCalledWith(id)
    // No longer the owner of anything: its operations are refused.
    await expect(w.alice.shared.setLeader(id, null)).rejects.toMatchObject({ code: 'NOT_OWNER' })
  })

  it('stops sharing from any computer of the owner\'s account, whether it holds the tab or not', async () => {
    const w = world()
    const laptop = w.make('m4-alice', 'u-alice', 'alice@x.io')
    laptop.keys.set(w.alice.id, w.alice.pub)
    const id = await added(w)
    await laptop.shared.refresh()
    expect(roster(laptop, id).owner.machineId).toBe(w.alice.id)
    await laptop.shared.stop(id)
    expect(w.backend.shares.get(id)!.stopped).toBe(true)
    expect(laptop.shared.rosters()).toEqual([])
    expect(laptop.relay.close).toHaveBeenCalledWith(id)
    // Shared again, and stopped from a computer of the account that never held it.
    await w.alice.shared.share('tab-1', 'app')
    const mini = w.make('m5-alice', 'u-alice', 'alice@x.io')
    await mini.shared.stop(id)
    expect(w.backend.shares.get(id)!.stopped).toBe(true)
    // Nothing listed as the account's own is refused, and a listing it cannot read is said to be so.
    await expect(mini.shared.stop(id)).rejects.toMatchObject({ code: 'NOT_OWNER' })
    w.backend.down = true
    await expect(mini.shared.stop(id)).rejects.toMatchObject({ code: 'SHARES_UNAVAILABLE' })
  })

  it('lets only the computer that shares a tab change it', async () => {
    const w = world()
    const id = await joined(w)
    for (const call of [
      () => w.bob.shared.setLeader(id, null), () => w.bob.shared.invite(id, ['x@y.io'], 7), () => w.bob.shared.removeMember(id, 'u-bob'),
      () => w.bob.shared.stop(id), () => w.alice.shared.setLeader('f'.repeat(24), null),
    ]) await expect(call()).rejects.toMatchObject({ code: 'NOT_OWNER' })
    // Its own tab, but the backend never said which desk tab it is (unreadable since a restart).
    const again = new SharedTabs({ key: w.alice.key, relay: w.alice.relay, store: w.alice.store, backend: async () => ({ status: 502, body: {} }),
      self: async () => ({ machineId: w.alice.id, accountId: 'u-alice', email: 'alice@x.io' }), ownPanes: async () => [], machineKey: async () => null, askMachine: async () => null, ownMachines: async () => null })
    await expect(again.setLeader(id, null)).rejects.toMatchObject({ code: 'SHARES_UNAVAILABLE' })
    await expect(again.invite(id, ['x@y.io'], 7)).rejects.toMatchObject({ code: 'SHARES_UNAVAILABLE' })
    await expect(w.alice.shared.addHarness(id, harnessOf(w.alice, 'lead'))).rejects.toMatchObject({ code: 'OWNER_PANE' })
    await expect(w.alice.shared.leave(id)).rejects.toMatchObject({ code: 'IS_OWNER' })
  })
})

describe('the leader, from the owner\'s tab setting', () => {
  const LEAD = (w: World) => ({ machineId: w.alice.id, agentId: 'lead' })

  it('is chosen from any computer of the owner\'s account: written to the tab setting, and signed by the sharing computer when it next reads the shares', async () => {
    const w = world()
    const id = await added(w)
    const laptop = w.make('m4-alice', 'u-alice', 'alice@x.io')
    laptop.keys.set(w.alice.id, w.alice.pub)
    // The studio, which shares the tab, is asleep: the laptop changes the leader all the same.
    const puts = w.backend.puts.length
    await laptop.shared.setLeader(id, LEAD(w))
    expect(w.backend.calls.at(-1)).toBe('PATCH /api/agent-messages/tabs/tab-1')
    expect(w.backend.leaders.get('u-alice:tab-1')).toEqual(LEAD(w))
    // Nothing is signed by the laptop, nor by anyone yet: the members see no leader the roster does not name.
    expect(w.backend.puts).toHaveLength(puts)
    expect(roster(w.bob, id).leader).toBeNull()
    // The studio wakes and reads the shares (as on `desk_changed`): it signs the setting's leader, and Bob takes it.
    await w.alice.shared.refresh()
    await w.net.settle()
    expect(w.backend.puts).toHaveLength(puts + 1)
    expect(roster(w.alice, id).leader).toEqual(LEAD(w))
    expect(roster(w.bob, id).leader).toEqual(LEAD(w))
    // Read again with the same setting: nothing new is signed.
    await w.alice.shared.refresh()
    expect(w.backend.puts).toHaveLength(puts + 1)
    // Remove Leader, from the studio itself this time: again only the setting, until the next read.
    await w.alice.shared.setLeader(id, null)
    expect(roster(w.alice, id).leader).toEqual(LEAD(w))
    await w.alice.shared.refresh()
    await w.net.settle()
    expect(roster(w.bob, id).leader).toBeNull()
  })

  it('is refused for a tab the account does not share, a malformed harness, or as the backend refuses it', async () => {
    const w = world()
    const id = await added(w)
    const calls = w.backend.calls.length
    await expect(w.alice.shared.setLeader(id, { machineId: '', agentId: 'lead' })).rejects.toMatchObject({ code: 'INVALID_LEADER' })
    expect(w.backend.calls).toHaveLength(calls)
    // A member's account, or a tab no one shares: not its to lead.
    await expect(w.bob.shared.setLeader(id, null)).rejects.toMatchObject({ code: 'NOT_OWNER' })
    await expect(w.alice.shared.setLeader('f'.repeat(24), null)).rejects.toMatchObject({ code: 'NOT_OWNER' })
    // The backend's refusal (a harness not in the tab) is told as it said it.
    const refusing = new SharedTabs({ ...w.alice.deps, backend: async (method, path, body) => method === 'PATCH'
      ? { status: 400, body: { success: false, error: { code: 'INVALID_LEADER', message: 'Choose a harness in this tab.' } } } : w.alice.deps.backend(method, path, body) })
    await expect(refusing.setLeader(id, { machineId: w.bob.id, agentId: 'api' })).rejects.toMatchObject({ code: 'INVALID_LEADER', message: 'Choose a harness in this tab.' })
    // A listing it cannot read, and a share listed under an id not derived from the account and the tab.
    w.backend.down = true
    await expect(w.alice.shared.setLeader(id, null)).rejects.toMatchObject({ code: 'SHARES_UNAVAILABLE' })
    w.backend.down = false
    w.backend.shares.set('f'.repeat(24), { ...w.backend.shares.get(id)!, tabId: 'tab-2' })
    await expect(w.alice.shared.setLeader('f'.repeat(24), null)).rejects.toMatchObject({ code: 'SHARE_ID_MISMATCH' })
    expect(w.backend.leaders.size).toBe(0)
  })

  it('is carried into the first roster of a tab shared with a leader already chosen, and stays with the tab after Stop Sharing', async () => {
    const w = world()
    w.backend.leaders.set('u-alice:tab-1', LEAD(w))
    const id = await share(w)
    expect(roster(w.alice, id)).toMatchObject({ version: 2, leader: LEAD(w) })
    expect(parseRoster(w.backend.puts[0].roster.body)!.leader).toEqual(LEAD(w))
    await w.alice.shared.stop(id)
    expect(w.backend.leaders.get('u-alice:tab-1')).toEqual(LEAD(w))
    // Shared again: the setting still names it.
    await w.alice.shared.share('tab-1', 'app')
    expect(roster(w.alice, id).leader).toEqual(LEAD(w))
  })

  it('follows the setting: a leader whose pane left the tab goes; an unread directory, or none to ask, keeps the roster\'s; one the roster does not list is dropped', async () => {
    const w = world()
    w.alice.panes.set('tab-1', [{ machineId: w.alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }, { machineId: w.alice.id, agentId: 'web', name: 'web', engine: 'claude' }])
    w.backend.leaders.set('u-alice:tab-1', LEAD(w))
    const id = await added(w)
    expect(roster(w.bob, id).leader).toEqual(LEAD(w))
    // The directory not read yet (a new process): the owner's harnesses and the leader stay as they were, nothing signed.
    const puts = w.backend.puts.length
    w.alice.panes.set('tab-1', null)
    await w.alice.shared.refresh()
    expect(w.backend.puts).toHaveLength(puts)
    expect(roster(w.alice, id).leader).toEqual(LEAD(w))
    // Nor by a computer that has no directory to ask.
    const blind = new SharedTabs({ ...w.alice.deps, ownLeader: undefined })
    w.alice.panes.set('tab-1', [{ machineId: w.alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }])
    await blind.refresh()
    expect(roster(w.alice, id).leader).toEqual(LEAD(w))
    // A setting naming a harness the roster does not list (one the desk has and the roster cut, say): no leader is signed.
    const ghost = new SharedTabs({ ...w.alice.deps, ownLeader: async () => ({ machineId: w.alice.id, agentId: 'ghost' }) })
    await ghost.refresh()
    expect(roster(w.alice, id).leader).toBeNull()
    await w.alice.shared.refresh()
    expect(roster(w.alice, id).leader).toEqual(LEAD(w))
    // The leader's pane closed: the listing names no leader (the backend derives it, nobody clears it), and the next
    // roster names none, for the members too (Review Focus 1).
    w.alice.panes.set('tab-1', [{ machineId: w.alice.id, agentId: 'web', name: 'web', engine: 'claude' }])
    await w.alice.shared.refresh()
    await w.net.settle()
    expect(w.backend.leaders.get('u-alice:tab-1')).toEqual(LEAD(w))
    expect(roster(w.alice, id)).toMatchObject({ leader: null })
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/web', 'm3-bob/api'])
    expect(roster(w.bob, id).leader).toBeNull()
  })

  it('may be a member\'s harness the roster lists: signed for every member, and gone once that harness leaves the roster', async () => {
    const w = world()
    const id = await added(w)
    const api = { machineId: w.bob.id, agentId: 'api' }
    await lead(w, id, api)
    await w.net.settle()
    expect(roster(w.alice, id).leader).toEqual(api)
    expect(roster(w.bob, id).leader).toEqual(api)
    // Bob takes it out: the owner's next roster lists it no more, and names no leader (the setting is left as it was).
    await w.bob.shared.removeHarness(id, w.bob.id, 'api')
    await w.net.settle()
    expect(roster(w.bob, id)).toMatchObject({ leader: null })
    expect(w.backend.leaders.get('u-alice:tab-1')).toEqual(api)
    await w.alice.shared.refresh()
    expect(roster(w.alice, id).leader).toBeNull()
  })

  it('a member\'s harness added or taken out keeps the leader the roster names', async () => {
    const w = world()
    w.backend.leaders.set('u-alice:tab-1', LEAD(w))
    const id = await added(w)
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'web'))
    await w.net.settle()
    expect(roster(w.alice, id)).toMatchObject({ leader: LEAD(w) })
    await w.alice.shared.removeHarness(id, w.bob.id, 'web')
    await w.net.settle()
    expect(roster(w.bob, id)).toMatchObject({ leader: LEAD(w) })
    expect(agents(roster(w.bob, id))).toEqual(['m2-alice/lead', 'm3-bob/api'])
  })
})

describe('the owner moves a tab to another of its computers', () => {
  /** Alice shares tab-1 from her studio (m2) with Bob, who added a harness; her laptop (m4) holds the roster too. Each of
   *  her computers knows the other's key, as their account's machines report them to each other. */
  async function moving(w: World): Promise<{ id: string; laptop: Machine }> {
    const laptop = w.make('m4-alice', 'u-alice', 'alice@x.io')
    w.alice.keys.set(laptop.id, laptop.pub)
    laptop.keys.set(w.alice.id, w.alice.pub)
    laptop.panes.set('tab-1', [{ machineId: w.alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }])
    const id = await added(w)
    await laptop.shared.refresh()
    expect(roster(laptop, id).owner.machineId).toBe(w.alice.id)
    return { id, laptop }
  }

  it('moves with a key change the old computer signs: members and the old computer follow, with no alert', async () => {
    const w = world()
    const { id, laptop } = await moving(w)
    const before = roster(w.bob, id)
    // A leader the owner chose while the studio held the tab: the laptop's first roster names it, as the setting does.
    w.backend.leaders.set('u-alice:tab-1', { machineId: w.alice.id, agentId: 'lead' })
    expect(await laptop.shared.move(id)).toEqual({ sharedTabId: id, version: before.version + 1 })
    expect(roster(laptop, id).leader).toEqual({ machineId: w.alice.id, agentId: 'lead' })
    // The old computer was asked, over the account's paired relay, to sign the laptop's key for this tab.
    expect(laptop.asked).toContainEqual([w.alice.id, { action: 'tab_keychange', sharedTabId: id, nextPub: laptop.pub, machineId: laptop.id }])
    expect(w.backend.shares.get(id)).toMatchObject({ ownerMachineId: laptop.id, version: before.version + 1 })
    const put = w.backend.puts.at(-1)!.roster
    expect(put.keyChange).toEqual({ previousPub: w.alice.pub, signature: expect.any(String) })
    // The laptop is the authority now: its own key pinned, its roster held, the members' harnesses carried over.
    expect(laptop.store.pinned(id)).toBe(laptop.pub)
    expect(roster(laptop, id)).toMatchObject({ version: before.version + 1, members: before.members,
      owner: { accountId: 'u-alice', machineId: laptop.id, machinePublicKey: laptop.pub } })
    expect(agents(roster(laptop, id))).toEqual(['m2-alice/lead', 'm3-bob/api'])
    // Bob reads the share again (the backend tells him) and takes the new roster: the pin moves with the signed change.
    await w.bob.shared.refresh()
    expect(w.bob.store.pinned(id)).toBe(laptop.pub)
    expect(roster(w.bob, id).owner.machineId).toBe(laptop.id)
    expect(w.bob.store.alerts()).toEqual([])
    expect(await w.bob.shared.untrusted()).toEqual([])
    expect(w.bob.shared.pendingInvites('f'.repeat(24))).toEqual([])
    // The studio follows too, and changes the tab no more.
    await w.alice.shared.refresh()
    expect(w.alice.store.pinned(id)).toBe(laptop.pub)
    expect(roster(w.alice, id).owner.machineId).toBe(laptop.id)
    expect(w.alice.store.alerts()).toEqual([])
    await expect(w.alice.shared.keyChange(id, laptop.pub, laptop.id)).rejects.toMatchObject({ code: 'NOT_OWNER' })
    // The laptop signs the tab from now on, and the members' requests reach it. The studio may still choose the leader,
    // as any computer of the account may: the laptop signs it.
    await lead(w, id, null, laptop)
    await w.net.settle()
    expect(roster(w.bob, id).leader).toBeNull()
    expect(roster(w.alice, id).owner.machineId).toBe(laptop.id)
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'web'))
    await w.net.settle()
    expect(agents(roster(laptop, id))).toEqual(['m2-alice/lead', 'm3-bob/api', 'm3-bob/web'])
    // Moved again to where it is: nothing is asked, signed or put.
    const puts = w.backend.puts.length
    expect(await laptop.shared.move(id)).toEqual({ sharedTabId: id, version: roster(laptop, id).version })
    expect(w.backend.puts).toHaveLength(puts)
  })

  it('moves from the newest roster the shares list: a harness a member added since this computer last read them stays in', async () => {
    const w = world()
    const { id, laptop } = await moving(w)
    // Bob adds his web; the studio applies it and the backend holds it, while the laptop reads nothing.
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'web'))
    await w.net.settle()
    expect(agents(roster(laptop, id))).toEqual(['m2-alice/lead', 'm3-bob/api'])
    const { version } = await laptop.shared.move(id)
    // Signed from the listing's roster, not the stale one held: Bob's web is carried over, past the listing's version.
    expect(agents(roster(laptop, id))).toEqual(['m2-alice/lead', 'm3-bob/api', 'm3-bob/web'])
    expect(version).toBe(w.backend.shares.get(id)!.version)
    expect(agents(parseRoster(w.backend.puts.at(-1)!.roster.body)!)).toEqual(['m2-alice/lead', 'm3-bob/api', 'm3-bob/web'])
    expect(laptop.store.alerts()).toEqual([])
  })

  it('keeps the old computer\'s key change on every later roster, for a member that missed the move', async () => {
    const w = world()
    const { id, laptop } = await moving(w)
    await laptop.shared.move(id)
    await lead(w, id, LEAD_OF(w), laptop)
    // Bob was away for both: the roster he finds is the one after the move, still carrying the change.
    w.bob.online = false
    await w.net.settle()
    expect(w.backend.puts.at(-1)!.roster.keyChange?.previousPub).toBe(w.alice.pub)
    w.bob.online = true
    await w.bob.shared.refresh()
    expect(roster(w.bob, id)).toMatchObject({ owner: { machineId: laptop.id }, leader: LEAD_OF(w) })
    expect(w.bob.store.alerts()).toEqual([])
    // A laptop that starts again finds the change in the roster it holds and keeps carrying it.
    const restarted = new SharedTabs(laptop.deps)
    laptop.panes.set('tab-1', [{ machineId: w.alice.id, agentId: 'lead', name: 'lead 2', engine: 'codex' }])
    await restarted.refresh()
    expect(w.backend.puts.at(-1)!.roster.keyChange?.previousPub).toBe(w.alice.pub)
    expect(roster(laptop, id).harnesses[0].name).toBe('lead 2')
  })

  it('moves with no key change when the old computer is away: every member computer trusts again on its own', async () => {
    const w = world()
    const { id, laptop } = await moving(w)
    // Bob's second computer took the pin from his first (A2), so it holds the old key too.
    const bob2 = w.make('m5-bob', 'u-bob', 'bob@y.io')
    await bob2.shared.refresh()
    await w.net.settle()
    expect(bob2.store.pinned(id)).toBe(w.alice.pub)
    w.alice.online = false
    const { version } = await laptop.shared.move(id)
    expect(w.backend.puts.at(-1)!.roster.keyChange).toBeUndefined()
    expect(roster(laptop, id)).toMatchObject({ version, owner: { machineId: laptop.id } })
    // Neither of Bob's computers can verify it: each records it, keeps the last roster it trusted, and lists it to trust again.
    await w.bob.shared.refresh()
    await bob2.shared.refresh()
    for (const m of [w.bob, bob2]) {
      expect(m.store.alerts().map((a) => a.error)).toContain('unpinned_key')
      expect(m.store.pinned(id)).toBe(w.alice.pub)
      expect(roster(m, id).owner.machineId).toBe(w.alice.id)
      expect(await m.shared.untrusted()).toEqual([{ sharedTabId: id, ownerEmail: 'alice@x.io' }])
    }
    // Bob checks the new fingerprint and confirms it on his first computer (A3) ...
    const offer = await w.bob.shared.retrustOffer(id)
    expect(offer).toMatchObject({ ownerPub: laptop.pub, fingerprint: fingerprint(laptop.identity.pub), version })
    await w.bob.shared.retrust(id, offer.ownerPub)
    await w.net.settle()
    expect(roster(w.bob, id)).toMatchObject({ version, owner: { machineId: laptop.id } })
    expect(await w.bob.shared.untrusted()).toEqual([])
    // ... which his second computer does not take on his first's word: it keeps its own pin until he confirms there too.
    await bob2.shared.refresh()
    expect(bob2.store.pinned(id)).toBe(w.alice.pub)
    expect(await bob2.shared.untrusted()).toEqual([{ sharedTabId: id, ownerEmail: 'alice@x.io' }])
    await bob2.shared.retrust(id, (await bob2.shared.retrustOffer(id)).ownerPub)
    expect(roster(bob2, id).owner.machineId).toBe(laptop.id)
    expect(await bob2.shared.untrusted()).toEqual([])
  })

  it('the old computer, back, follows by the key the new computer reports, never by the one the roster names', async () => {
    const w = world()
    const { id, laptop } = await moving(w)
    w.alice.online = false
    const { version } = await laptop.shared.move(id)
    w.alice.online = true
    // It cannot ask the laptop yet: it keeps its roster, records what it could not verify, and asks no more for a while.
    const machineKey = vi.spyOn(w.alice.deps, 'machineKey')
    const askedLaptop = () => machineKey.mock.calls.filter(([m]) => m === laptop.id).length
    w.alice.keys.set(laptop.id, null)
    await w.alice.shared.refresh()
    await w.net.settle()
    expect(roster(w.alice, id).owner.machineId).toBe(w.alice.id)
    expect(w.alice.store.alerts().map((a) => a.error)).toEqual(['unpinned_key'])
    expect(askedLaptop()).toBe(1)
    w.alice.keys.set(laptop.id, laptop.pub)
    await w.alice.shared.refresh()
    await w.net.settle()
    expect(roster(w.alice, id).owner.machineId).toBe(w.alice.id)
    expect(askedLaptop()).toBe(1)
    // After the wait, it asks again and takes the laptop's roster under the key the laptop reports.
    w.tick(PULL_RETRY_MS)
    await w.alice.shared.refresh()
    await w.net.settle()
    expect(w.alice.store.pinned(id)).toBe(laptop.pub)
    expect(roster(w.alice, id)).toMatchObject({ version, owner: { machineId: laptop.id } })
    expect(w.alice.relay.open).toHaveBeenLastCalledWith(id)
    expect(askedLaptop()).toBe(2)
    // Following, it asks nothing more.
    w.tick(PULL_RETRY_MS)
    await w.alice.shared.refresh()
    expect(askedLaptop()).toBe(2)
    // It is no member: there is nothing to trust again, and the tab is its account's own.
    expect(await w.alice.shared.untrusted()).toEqual([])
    await expect(w.alice.shared.retrustOffer(id)).rejects.toMatchObject({ code: 'IS_OWNER' })
  })

  it('follows only a roster the reporting computer signed, naming it and this account, and newer than the one held', async () => {
    const w = world()
    const { id, laptop } = await moving(w)
    const held = roster(w.alice, id)
    const fake = newIdentity()
    const lists = (signed: SignedRoster, version: number) => Object.assign(w.backend.shares.get(id)!, { ownerMachineId: laptop.id, roster: signed, version })
    const as = (over: Partial<Roster>) => ({ ...held, version: held.version + 1, owner: { ...held.owner, machineId: laptop.id, machinePublicKey: laptop.pub }, ...over })
    for (const signed of [
      // Signed by another key than the one the laptop reports.
      resign(fake, as({ owner: { ...held.owner, machineId: laptop.id, machinePublicKey: b64e(fake.pub) } })),
      // The laptop's, but naming another computer, another account, another tab, or no newer than the one held.
      resign(laptop.identity, as({ owner: { ...held.owner, machineId: 'm9-alice', machinePublicKey: laptop.pub } })),
      resign(laptop.identity, as({ owner: { ...held.owner, accountId: 'u-carol', machineId: laptop.id, machinePublicKey: laptop.pub } })),
      resign(laptop.identity, as({ sharedTabId: 'f'.repeat(24) })),
      resign(laptop.identity, as({ version: held.version })),
      // Naming the laptop under another key, with a key change to that key the laptop's own key signed: it verifies
      // under the key the laptop reports, but is not the laptop's roster.
      resign(fake, as({ owner: { ...held.owner, machineId: laptop.id, machinePublicKey: b64e(fake.pub) } }),
        { previousPub: laptop.pub, signature: b64e(sign(laptop.identity.priv, keyChangeBytes(id, b64e(fake.pub)))) }),
      { body: 'nonsense', signature: 'x' },
    ]) {
      lists(signed, held.version + 1)
      w.tick(PULL_RETRY_MS)
      await w.alice.shared.refresh()
      await w.net.settle()
      expect(w.alice.store.pinned(id)).toBe(w.alice.pub)
      expect(roster(w.alice, id)).toEqual(held)
    }
    // The laptop's own, naming it and the account, and newer: that one is followed.
    lists(resign(laptop.identity, as({})), held.version + 1)
    w.tick(PULL_RETRY_MS)
    await w.alice.shared.refresh()
    await w.net.settle()
    expect(w.alice.store.pinned(id)).toBe(laptop.pub)
    expect(roster(w.alice, id).owner.machineId).toBe(laptop.id)
  })

  it('refuses a move from a computer the backend does not list as the owner\'s, or when it cannot read the shares', async () => {
    const w = world()
    const { id, laptop } = await moving(w)
    await expect(w.bob.shared.move(id)).rejects.toMatchObject({ code: 'NOT_OWNER' })
    await expect(laptop.shared.move('f'.repeat(24))).rejects.toMatchObject({ code: 'NOT_OWNER' })
    w.backend.down = true
    await expect(laptop.shared.move(id)).rejects.toMatchObject({ code: 'SHARES_UNAVAILABLE' })
    w.backend.down = false
    // A move the backend refuses changes nothing here: the old computer's roster and key stay.
    const refusing = new SharedTabs({ ...laptop.deps, backend: async (method, path, body) => path.endsWith('/move')
      ? { status: 403, body: { success: false, error: { code: 'FORBIDDEN', message: 'no' } } } : laptop.deps.backend(method, path, body) })
    await expect(refusing.move(id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(laptop.store.pinned(id)).toBe(w.alice.pub)
    expect(roster(laptop, id).owner.machineId).toBe(w.alice.id)
    expect(w.backend.shares.get(id)!.ownerMachineId).toBe(w.alice.id)
  })

  it.each<[string, (w: World) => Record<string, unknown> | null]>([
    ['a signature that does not verify', (w) => ({ previousPub: w.alice.pub, signature: b64e(new Uint8Array(64)) })],
    ['a change signed by another key than the held roster names', (w) => {
      const other = newIdentity()
      return { previousPub: b64e(other.pub), signature: b64e(sign(other.priv, keyChangeBytes(shareIdOf('u-alice', 'tab-1'), w.net.machines.get('m4-alice')!.pub))) }
    }],
    ['no key', (w) => ({ signature: b64e(sign(w.alice.identity.priv, keyChangeBytes(shareIdOf('u-alice', 'tab-1'), w.net.machines.get('m4-alice')!.pub))) })],
    ['no signature', (w) => ({ previousPub: w.alice.pub, signature: 7 })],
    ['a refusal', () => ({ error: { code: 'NOT_OWNER', message: 'no' } })],
  ])('takes no key change from %s, and moves without one', async (_what, answer) => {
    const w = world()
    const { id, laptop } = await moving(w)
    laptop.answer = async () => answer(w)
    await laptop.shared.move(id)
    expect(w.backend.puts.at(-1)!.roster.keyChange).toBeUndefined()
    await w.bob.shared.refresh()
    expect(w.bob.store.alerts().map((a) => a.error)).toEqual(['unpinned_key'])
  })

  it('moves to a computer that held no roster yet: the desk\'s panes and the members, past the backend\'s version', async () => {
    const w = world()
    const id = await added(w)
    const mini = w.make('m5-alice', 'u-alice', 'alice@x.io')
    mini.panes.set('tab-1', [{ machineId: mini.id, agentId: 'notes', name: 'notes', engine: 'claude' }])
    const version = w.backend.shares.get(id)!.version
    expect(await mini.shared.move(id)).toEqual({ sharedTabId: id, version: version + 1 })
    expect(roster(mini, id)).toMatchObject({ name: 'app', members: [{ accountId: 'u-bob' }], owner: { machineId: mini.id } })
    expect(agents(roster(mini, id))).toEqual(['m5-alice/notes'])
    // With nothing to start from, a roster whose name cannot be read starts unnamed.
    const other = world()
    const oid = await share(other)
    other.backend.shares.get(oid)!.roster = 'nonsense'
    const spare = other.make('m6-alice', 'u-alice', 'alice@x.io')
    spare.panes.set('tab-1', null)
    await spare.shared.move(oid)
    expect(roster(spare, oid)).toMatchObject({ name: '', harnesses: [] })
  })

  it('an owner\'s other computer never trusts its own account\'s tab by a fingerprint, whatever the backend says', async () => {
    const w = world()
    const { id, laptop } = await moving(w)
    // The backend tells the laptop it is a member of its own account's tab, under a key of the backend's choosing.
    const fake = newIdentity()
    const lying = new SharedTabs({ ...laptop.deps, backend: async (method, path, body) => {
      const reply = await laptop.deps.backend(method, path, body)
      if (method === 'GET' && path === '/api/agent-messages/shares') {
        const data = reply.body.data as { shares: Record<string, unknown>[] }
        data.shares = data.shares.map((s) => ({ ...s, owner: false,
          roster: resign(fake, { ...roster(w.alice, id), version: 99, owner: { ...roster(w.alice, id).owner, machinePublicKey: b64e(fake.pub) } }) }))
      }
      return reply
    } })
    expect(await lying.untrusted()).toEqual([])
    await expect(lying.retrustOffer(id)).rejects.toMatchObject({ code: 'IS_OWNER' })
    await expect(lying.retrust(id, b64e(fake.pub))).rejects.toMatchObject({ code: 'IS_OWNER' })
    expect(laptop.store.pinned(id)).toBe(w.alice.pub)
  })

  it('signs a key change only for a tab this computer is the authority of, under its own key, for a well-formed key', async () => {
    const w = world()
    const { id, laptop } = await moving(w)
    const answer = await w.alice.shared.keyChange(id, laptop.pub, laptop.id)
    expect(answer.previousPub).toBe(w.alice.pub)
    expect(verify(w.alice.identity.pub, keyChangeBytes(id, laptop.pub), b64d(answer.signature))).toBe(true)
    // The laptop holds the tab but is not its authority; a tab not held at all; a key that is not one.
    await expect(laptop.shared.keyChange(id, laptop.pub, laptop.id)).rejects.toMatchObject({ code: 'NOT_OWNER' })
    await expect(w.alice.shared.keyChange('f'.repeat(24), laptop.pub, laptop.id)).rejects.toMatchObject({ code: 'NOT_OWNER' })
    for (const bad of ['', 'x', 7, null]) await expect(w.alice.shared.keyChange(id, bad, laptop.id)).rejects.toMatchObject({ code: 'INVALID_KEY' })
    // A key that is not the named machine's own (a paired app's, or one no machine holds), no machine named, or a
    // machine that cannot be asked: nothing is signed.
    const sign = vi.spyOn(w.alice.key, 'signKeyChange')
    for (const [pub, machineId] of [[b64e(newIdentity().pub), laptop.id], [w.bob.pub, laptop.id], [laptop.pub, undefined], [laptop.pub, ''], [laptop.pub, 7], [laptop.pub, 'm9-alice']] as const) {
      await expect(w.alice.shared.keyChange(id, pub, machineId)).rejects.toMatchObject({ code: 'NOT_OUR_MACHINE' })
    }
    expect(sign).not.toHaveBeenCalled()
    // The studio after a new data folder: the roster names it, but under a key it no longer has.
    const reborn = new SharedTabs({ ...w.alice.deps, key: new TabSessions(() => newIdentity(), () => w.alice.id) })
    await expect(reborn.keyChange(id, laptop.pub, laptop.id)).rejects.toMatchObject({ code: 'NOT_OWNER' })
  })
})

describe('a member', () => {
  it('lists its invitations, and accepts one: pins the owner key of the first roster, keeps it, and gives its fingerprint', async () => {
    const w = world()
    const id = await share(w)
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    const invites = await w.bob.shared.invites()
    expect(invites).toEqual([{ id: 'inv-1', sharedTabId: id, ownerEmail: 'alice@x.io', ownerMachineId: w.alice.id, expiresAt: '2026-11-01T00:00:00.000Z', tabName: 'app' }])
    const answer = await w.bob.shared.accept('inv-1')
    expect(answer).toEqual({ sharedTabId: id, fingerprint: fingerprint(w.alice.identity.pub) })
    expect(roster(w.bob, id).owner.machinePublicKey).toBe(w.alice.pub)
    expect(w.bob.relay.open).toHaveBeenCalledWith(id)
    expect(w.backend.calls.filter((c) => c.startsWith('POST /api/agent-messages/invites/'))).toEqual(['POST /api/agent-messages/invites/inv-1/accept'])
  })

  it('accepts with the owner key the person was shown, and leaves when the roster is signed by another', async () => {
    const w = world()
    const id = await share(w)
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    await expect(w.bob.shared.accept('inv-1', b64e(newIdentity().pub))).rejects.toMatchObject({ code: 'OWNER_KEY_MISMATCH' })
    expect(w.backend.members.get(id)?.has('u-bob')).toBe(false)
    expect(w.bob.shared.rosters()).toEqual([])
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    expect(await w.bob.shared.accept('inv-2', w.alice.pub)).toMatchObject({ sharedTabId: id })
  })

  it('leaves when the roster it is given cannot be read or does not verify, and trusts again on a new accept', async () => {
    const w = world()
    const id = await share(w)
    const good = w.backend.shares.get(id)!.roster as SignedRoster
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    w.backend.shares.get(id)!.roster = { body: good.body, signature: b64e(new Uint8Array(64)) }
    await expect(w.bob.shared.accept('inv-1')).rejects.toMatchObject({ code: 'ROSTER_INVALID' })
    expect(w.backend.members.get(id)?.has('u-bob')).toBe(false)
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    w.backend.shares.get(id)!.roster = 'nonsense'
    await expect(w.bob.shared.accept('inv-2')).rejects.toMatchObject({ code: 'ROSTER_INVALID' })
    // A pin left from an earlier membership is replaced by an explicit accept.
    w.bob.store.pin(id, b64e(newIdentity().pub))
    w.backend.shares.get(id)!.roster = good
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    expect(await w.bob.shared.accept('inv-3')).toMatchObject({ sharedTabId: id })
    expect(roster(w.bob, id).owner.machinePublicKey).toBe(w.alice.pub)
    await expect(w.bob.shared.accept('inv-9')).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('stays a member when the roster cannot be read after accepting: three more tries 1 s apart, then pending, for trust later', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = world()
    const id = await share(w)
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    const real = w.bob.deps.backend
    let reads = 0
    w.bob.deps.backend = async (method, path, body) => {
      if (path !== '/api/agent-messages/shares') return real(method, path, body)
      reads++
      return { status: 502, body: {} }
    }
    const answer = w.bob.shared.accept('inv-1')
    await vi.advanceTimersByTimeAsync(999)
    expect(reads).toBe(1)
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await answer).toEqual({ sharedTabId: id, pending: true })
    expect(reads).toBe(4)
    // Still a member, with nothing pinned or opened: the person trusts the owner once the roster can be read (A3).
    expect(w.backend.members.get(id)?.has('u-bob')).toBe(true)
    expect(w.bob.store.pinned(id)).toBeNull()
    expect(w.bob.relay.open).not.toHaveBeenCalled()
    w.bob.deps.backend = real
    expect(await w.bob.shared.untrusted()).toEqual([{ sharedTabId: id, ownerEmail: 'alice@x.io' }])
    const offer = await w.bob.shared.retrustOffer(id)
    expect(await w.bob.shared.retrust(id, offer.ownerPub)).toEqual({ sharedTabId: id, fingerprint: fingerprint(w.alice.identity.pub) })
  })

  it('takes the roster on a later try after a backend that failed, threw, or did not list the tab yet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = world()
    const id = await share(w)
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    const real = w.bob.deps.backend
    const answers: Array<() => Promise<{ status: number; body: Record<string, unknown> }>> = [
      async () => ({ status: 502, body: {} }), async () => { throw new Error('socket hang up') }, async () => ok({ shares: [] })]
    w.bob.deps.backend = async (method, path, body) => path === '/api/agent-messages/shares' && answers.length ? answers.shift()!() : real(method, path, body)
    const answer = w.bob.shared.accept('inv-1')
    await vi.advanceTimersByTimeAsync(3_000)
    expect(await answer).toEqual({ sharedTabId: id, fingerprint: fingerprint(w.alice.identity.pub) })
    expect(roster(w.bob, id).owner.machinePublicKey).toBe(w.alice.pub)
  })

  it('adds a harness: opens the relay, hellos the owner\'s machine, waits for the welcome and sends the request sealed', async () => {
    // Bob's machine is the lower id here, so Bob says hello.
    const w = world({ bob: 'm1-bob' })
    const id = await joined(w)
    expect(await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))).toEqual({ queued: true })
    expect(w.bob.shared.pending()).toEqual([{ sharedTabId: id, op: 'add', machineId: 'm1-bob', agentId: 'api', name: 'api', since: expect.any(String) }])
    await w.net.settle()
    expect(w.net.kinds('m1-bob', w.alice.id)).toEqual(['hello', 'sealed'])
    expect(w.net.kinds(w.alice.id, 'm1-bob')[0]).toBe('welcome')
    expect(agents(roster(w.alice, id))).toContain('m1-bob/api')
    expect(w.bob.shared.pending()).toEqual([])
    // One already in the roster is nothing to ask for.
    const sent = w.net.sent.length
    expect(await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))).toEqual({ queued: true })
    await w.net.settle()
    expect(w.net.sent.length).toBe(sent)
    expect(w.bob.shared.pending()).toEqual([])
  })

  it('adds a harness on another of its machines by asking that machine, never naming it in a request of its own', async () => {
    const w = world()
    const id = await joined(w)
    const laptop = { machineId: 'm8-bob', agentId: 'web', name: 'web', engine: 'codex' }
    w.bob.answer = async () => ({ queued: true, by: 'm8-bob' })
    const sent = w.net.sent.length
    expect(await w.bob.shared.addHarness(id, laptop)).toEqual({ queued: true, by: 'm8-bob' })
    // Marked as handed on, so that the machine it names asks for it itself and hands it no further.
    expect(w.bob.asked).toEqual([['m8-bob', { action: 'share_add', sharedTabId: id, harness: laptop, forwarded: true }]])
    await w.net.settle()
    expect(w.net.sent.length).toBe(sent)
    expect(w.bob.shared.pending()).toEqual([])
    // That machine cannot be asked: nothing waits here either.
    w.bob.answer = async () => null
    await expect(w.bob.shared.addHarness(id, laptop)).rejects.toMatchObject({ code: 'MACHINE_AWAY' })
    expect(w.bob.shared.pending()).toEqual([])
    // It refuses: its refusal is told as it said it, never as a machine away.
    w.bob.answer = async () => ({ error: { code: 'MESSAGES_OFF', message: 'Agent Messages are off there.' } })
    await expect(w.bob.shared.addHarness(id, laptop)).rejects.toMatchObject({ code: 'MESSAGES_OFF', message: 'Agent Messages are off there.' })
    expect(w.bob.shared.pending()).toEqual([])
    await expect(w.bob.shared.addHarness(id, { machineId: '', agentId: 'x', name: 'x', engine: 'codex' })).rejects.toMatchObject({ code: 'INVALID_HARNESS' })
    await expect(w.bob.shared.addHarness(id, null as never)).rejects.toMatchObject({ code: 'INVALID_HARNESS' })
    await expect(w.bob.shared.addHarness(id, { machineId: w.bob.id, agentId: 'x', engine: 'codex' } as never)).rejects.toMatchObject({ code: 'INVALID_HARNESS' })
    await expect(w.bob.shared.addHarness('f'.repeat(24), laptop)).rejects.toMatchObject({ code: 'NOT_SHARED' })
    // Its own machine's key, when even that cannot be read, leaves nothing to ask for.
    w.bob.keys.delete(w.bob.id)
    await expect(w.bob.shared.addHarness(id, harnessOf(w.bob, 'x'))).rejects.toMatchObject({ code: 'MACHINE_AWAY' })
    expect(w.bob.asked).toHaveLength(3)
  })

  it('records the consent of the harness\'s own machine as it asks, and takes it back as it asks out or leaves', async () => {
    const w = world()
    const id = await joined(w)
    const key = (m: Machine, agentId: string) => `${id}\n${m.id}\n${agentId}`
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    expect(w.bob.consent.keys()).toEqual(new Set([key(w.bob, 'api')]))
    // Asked again once listed (the owner listed it first, unasked): recorded as listed, so the owner taking it out
    // later needs asking again.
    w.bob.consent.revoke(id, w.bob.id, 'api')
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    expect(JSON.parse(readFileSync(join(root, `${w.bob.id}-consent.json`), 'utf8'))).toEqual([{ sharedTabId: id, machineId: w.bob.id, agentId: 'api', listed: true }])
    // An add handed on to the harness's own machine is recorded there, never on the machine that handed it on.
    const laptop = w.make('m8-bob', 'u-bob', 'bob@y.io')
    await laptop.shared.pinChanged(id)
    await w.net.settle()
    await w.bob.shared.addHarness(id, harnessOf(laptop, 'web'))
    expect(laptop.consent.keys()).toEqual(new Set([key(laptop, 'web')]))
    expect(w.bob.consent.keys()).toEqual(new Set([key(w.bob, 'api')]))
    // Taken out by the member: gone before the owner applies it.
    w.alice.online = false
    await w.bob.shared.removeHarness(id, w.bob.id, 'api')
    expect(w.bob.consent.keys()).toEqual(new Set())
    // Leaving the tab forgets all of it.
    w.alice.online = true
    await laptop.shared.leave(id)
    expect(laptop.consent.keys()).toEqual(new Set())
  })

  it('hands a removal of a harness on another of its machines to that machine, which takes its consent back there', async () => {
    const w = world()
    const id = await joined(w)
    const laptop = w.make('m8-bob', 'u-bob', 'bob@y.io')
    await laptop.shared.pinChanged(id)
    await w.net.settle()
    await w.bob.shared.addHarness(id, harnessOf(laptop, 'web'))
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toContain('m8-bob/web')
    expect(laptop.consent.keys()).toEqual(new Set([`${id}\nm8-bob\nweb`]))
    await w.bob.shared.refresh()
    await w.net.settle()
    expect(agents(roster(w.bob, id))).toContain('m8-bob/web')
    // The laptop away: refused, and nothing changes; neither the roster nor the laptop's consent.
    laptop.online = false
    await expect(w.bob.shared.removeHarness(id, 'm8-bob', 'web')).rejects.toMatchObject({ code: 'MACHINE_AWAY' })
    expect(laptop.consent.keys()).toEqual(new Set([`${id}\nm8-bob\nweb`]))
    laptop.online = true
    // Its refusal is told as it said it.
    w.bob.answer = async () => ({ error: { code: 'MESSAGES_OFF', message: 'Agent Messages are off there.' } })
    await expect(w.bob.shared.removeHarness(id, 'm8-bob', 'web')).rejects.toMatchObject({ code: 'MESSAGES_OFF', message: 'Agent Messages are off there.' })
    w.bob.answer = undefined
    // Taken out from the studio: the laptop's consent goes at once, before the owner applies it, and the laptop asks.
    w.alice.online = false
    expect(await w.bob.shared.removeHarness(id, 'm8-bob', 'web')).toEqual({ ok: true })
    expect(laptop.consent.keys()).toEqual(new Set())
    expect(laptop.shared.pending()).toEqual([expect.objectContaining({ op: 'remove', machineId: 'm8-bob', agentId: 'web' })])
    expect(w.bob.shared.pending()).toEqual([])
    // The owner applies it and lists the harness again while the laptop is away: seeing only the re-listing, the laptop
    // still holds no consent, and Share grants nobody a view of it.
    const relisted = { ...roster(w.alice, id), version: roster(w.alice, id).version + 2 }
    laptop.consent.reconcile(() => relisted)
    expect(laptop.consent.keys()).toEqual(new Set())
    expect(rosterGrants([relisted], { machineId: 'm8-bob', accountId: 'u-bob' }, laptop.consent.keys())).toEqual([])
    w.alice.online = true
    await laptop.shared.refresh()
    await w.net.settle()
    expect(agents(roster(w.alice, id))).not.toContain('m8-bob/web')
    // A removal handed on for a harness not on the machine it reached is refused, never handed on again; one that is
    // not in the tab, or is another account's, is refused before anyone is asked.
    const asked = w.bob.asked.length
    await expect(laptop.shared.removeHarness(id, w.bob.id, 'api', true)).rejects.toMatchObject({ code: 'NOT_THIS_MACHINE' })
    await expect(w.bob.shared.removeHarness(id, 'm8-bob', 'nothing')).rejects.toMatchObject({ code: 'NOT_IN_TAB' })
    await expect(w.bob.shared.removeHarness(id, w.alice.id, 'lead')).rejects.toMatchObject({ code: 'NOT_YOURS' })
    expect(w.bob.asked.length).toBe(asked)
    // A roster listing a harness of this machine under another account (the owner's word): its consent here, if any,
    // goes, but taking it out is not this account's to ask.
    const held = roster(w.bob, id)
    w.bob.store.offer(resign(w.alice.identity, { ...held, version: held.version + 1,
      harnesses: [...held.harnesses, { accountId: 'u-alice', machineId: w.bob.id, machinePublicKey: w.bob.pub, agentId: 'theirs', name: 'theirs', engine: 'codex' }] }))
    await expect(w.bob.shared.removeHarness(id, w.bob.id, 'theirs')).rejects.toMatchObject({ code: 'NOT_YOURS' })
  })

  it('tells a real machine\'s refusal of a forwarded add as it said it, and refuses to hand one on a second time', async () => {
    const w = world()
    const id = await joined(w)
    // Bob's laptop is on but holds no such tab yet: its NOT_SHARED comes back as it is.
    const laptop = w.make('m8-bob', 'u-bob', 'bob@y.io')
    await expect(w.bob.shared.addHarness(id, harnessOf(laptop, 'web'))).rejects.toMatchObject({ code: 'NOT_SHARED', message: 'This computer holds no such shared tab.' })
    laptop.online = false
    await expect(w.bob.shared.addHarness(id, harnessOf(laptop, 'web'))).rejects.toMatchObject({ code: 'MACHINE_AWAY' })
    // Handed an add for a harness that is not its own, a machine holding the tab refuses it rather than hand it on again.
    laptop.online = true
    await laptop.shared.pinChanged(id)
    await w.net.settle()
    expect(laptop.store.pinned(id)).toBe(w.alice.pub)
    const asked = laptop.asked.length
    await expect(laptop.shared.addHarness(id, { machineId: 'm9-bob', agentId: 'db', name: 'db', engine: 'codex' }, true)).rejects.toMatchObject({ code: 'NOT_THIS_MACHINE' })
    await expect(w.bob.shared.addHarness(id, { ...harnessOf(laptop, 'web'), machineId: w.bob.id }, true)).resolves.toEqual({ queued: true })
    expect(laptop.asked.length).toBe(asked)
    expect(laptop.shared.pending()).toEqual([])
  })

  it('waits for another machine\'s answer outside its queue: a slow machine holds up nothing else', async () => {
    const w = world()
    const id = await joined(w)
    let answer!: (v: Record<string, unknown>) => void
    w.bob.answer = () => new Promise((done) => { answer = done })
    const forwarded = w.bob.shared.addHarness(id, { machineId: 'm8-bob', agentId: 'web', name: 'web', engine: 'codex' })
    await vi.waitFor(() => expect(w.bob.asked).toHaveLength(1))
    // A refresh and an add of its own run while the other machine has not answered.
    await w.bob.shared.refresh()
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toContain(`${w.bob.id}/api`)
    answer({ queued: true })
    expect(await forwarded).toEqual({ queued: true })
  })

  it('a forwarded add reaches the machine it names, which asks the owner for it as its own', async () => {
    const w = world()
    const id = await joined(w)
    // Bob's laptop holds the tab as Bob's mini does (its pin and roster, as both would after accepting).
    const laptop = w.make('m8-bob', 'u-bob', 'bob@y.io')
    laptop.store.pin(id, w.alice.pub)
    laptop.store.offer(w.bob.store.current(id)!.signed)
    w.bob.keys.set('m8-bob', laptop.pub)
    expect(await w.bob.shared.addHarness(id, harnessOf(laptop, 'web'))).toEqual({ queued: true })
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toContain('m8-bob/web')
    expect(roster(w.alice, id).harnesses.find((x) => x.machineId === 'm8-bob')!.machinePublicKey).toBe(laptop.pub)
    // Both of Bob's machines take the roster as theirs: the laptop's entry is on a machine of his, under its own key.
    await w.bob.shared.refresh()
    await w.net.settle()
    expect(roster(w.bob, id).version).toBe(roster(w.alice, id).version)
    expect([...w.bob.store.alerts(), ...laptop.store.alerts()]).toEqual([])
    // Bob's mini never sent the owner a request naming the laptop.
    expect(w.net.sent.filter((x) => x.from === w.bob.id && x.to === w.alice.id).length).toBe(0)
  })

  it('asks for the same harness once: twice yields one request and one entry', async () => {
    const w = world()
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    expect(w.bob.shared.pending()).toHaveLength(1)
    await w.net.settle()
    w.alice.online = true
    await w.bob.shared.onFrame({ sharedTabId: id, ready: true })
    await w.net.settle()
    expect(agents(roster(w.alice, id)).filter((a) => a.endsWith('/api'))).toHaveLength(1)
    // Sent twice more by hand, it is still one entry, and no new version.
    const version = roster(w.alice, id).version
    const link: TabLink = { sharedTabId: id, machineId: w.alice.id, peerPub: w.alice.pub }
    for (let i = 0; i < 2; i++) {
      const sealed = await w.bob.key.seal(link, { kind: 'roster_request', id: `add:${w.bob.id}/api`, op: 'add',
        harness: { accountId: 'u-bob', machineId: w.bob.id, machinePublicKey: w.bob.pub, agentId: 'api', name: 'api', engine: 'claude' } }) as { frame: Record<string, unknown> }
      await w.bob.relay.send(id, w.alice.id, sealed.frame)
    }
    await w.net.settle()
    expect(roster(w.alice, id).version).toBe(version)
    expect(agents(roster(w.alice, id)).filter((a) => a.endsWith('/api'))).toHaveLength(1)
  })

  it('keeps an add queued while the owner\'s computer is away, retries every 30 s, and it is applied exactly once', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const w = world()
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    // Undeliverable: still waiting, and nothing reached Alice.
    expect(w.bob.shared.pending()).toHaveLength(1)
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    const puts = w.backend.puts.length
    vi.advanceTimersByTime(RETRY_MS)
    await w.net.settle()
    expect(w.bob.shared.pending()).toHaveLength(1)
    // Back: the next retry carries it.
    w.alice.online = true
    w.tick(HELLO_RETRY_MS)
    vi.advanceTimersByTime(RETRY_MS)
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead', `${w.bob.id}/api`])
    expect(w.backend.puts.length).toBe(puts + 1)
    expect(w.bob.shared.pending()).toEqual([])
    // Nothing waits: no timer runs, and nothing more is sent.
    expect(vi.getTimerCount()).toBe(0)
    w.bob.shared.close()
  })

  it('drops a queued add the person withdrew, with its consent, without waiting for the owner (final review of 1c, I3)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const w = world()
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    expect(w.bob.shared.pending()).toHaveLength(1)
    expect(w.bob.consent.keys()).toEqual(new Set([`${id}\n${w.bob.id}\napi`]))
    // Withdrawn while still `Joining…`: answered at once, nothing waits, and no consent is left.
    expect(await w.bob.shared.removeHarness(id, w.bob.id, 'api')).toEqual({ ok: true })
    expect(w.bob.shared.pending()).toEqual([])
    expect(w.bob.deps.requests!.load()).toEqual([])
    expect(w.bob.consent.keys()).toEqual(new Set())
    expect(vi.getTimerCount()).toBe(0)
    // The owner's computer comes back: nothing of it is applied.
    w.alice.online = true
    w.tick(HELLO_RETRY_MS)
    await w.bob.shared.refresh()
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    // A second remove finds nothing to withdraw.
    await expect(w.bob.shared.removeHarness(id, w.bob.id, 'api')).rejects.toMatchObject({ code: 'NOT_IN_TAB' })
    w.bob.shared.close()
  })

  it('sends a waiting request when the relay says it is ready', async () => {
    const w = world()
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    w.alice.online = true
    await w.bob.shared.onFrame({ sharedTabId: id, ready: true })
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toContain(`${w.bob.id}/api`)
    w.bob.shared.close()
  })

  it('removes its own harness through the owner, never another\'s', async () => {
    const w = world()
    const id = await added(w)
    await expect(w.bob.shared.removeHarness(id, w.alice.id, 'lead')).rejects.toMatchObject({ code: 'NOT_YOURS' })
    await expect(w.bob.shared.removeHarness(id, w.bob.id, 'ghost')).rejects.toMatchObject({ code: 'NOT_IN_TAB' })
    await expect(w.bob.shared.removeHarness('f'.repeat(24), w.bob.id, 'api')).rejects.toMatchObject({ code: 'NOT_SHARED' })
  })

  it('leaves: the membership is deleted, the roster forgotten and the relay closed', async () => {
    const w = world()
    const id = await added(w)
    // A second tab Bob is in, with a session and a request of its own, which leaving the first leaves alone.
    w.alice.panes.set('tab-2', [{ machineId: w.alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }])
    const { sharedTabId: other } = await w.alice.shared.share('tab-2', 'two')
    await w.alice.shared.invite(other, ['bob@y.io'], 7)
    await w.bob.shared.accept((await w.bob.shared.invites())[0].id)
    await w.alice.shared.refresh()
    await w.bob.shared.addHarness(other, harnessOf(w.bob, 'two'))
    await w.net.settle()
    w.alice.online = false
    await w.bob.shared.removeHarness(id, w.bob.id, 'api')
    await w.bob.shared.addHarness(other, harnessOf(w.bob, 'three'))
    await w.net.settle()
    expect(w.bob.shared.pending()).toHaveLength(2)
    const drop = vi.spyOn(w.bob.key, 'drop')
    await w.bob.shared.leave(id)
    expect(w.bob.shared.pending().map((p) => p.sharedTabId)).toEqual([other])
    expect(drop.mock.calls.map(([link]) => link.sharedTabId)).toEqual([id])
    expect(w.bob.shared.rosters().map((r) => r.sharedTabId)).toEqual([other])
    // Leaving forgets the owner's key too: joining again is trusting it again.
    expect(w.bob.store.pinned(id)).toBeNull()
    w.bob.shared.close()
    expect(w.backend.members.get(id)?.has('u-bob')).toBe(false)
    expect(w.bob.relay.close).toHaveBeenCalledWith(id)
    await expect(w.bob.shared.leave(id)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('takes a newer roster from the backend on refresh, and rejects a forged one, keeping the last valid and alerting', async () => {
    const w = world()
    const id = await joined(w)
    const held = roster(w.bob, id).version
    const latest = roster(w.alice, id)
    await w.bob.shared.refresh()
    expect(roster(w.bob, id).version).toBe(latest.version)
    expect(held).toBeLessThanOrEqual(latest.version)
    // Mallory's roster: a higher version, her key, no key change signed by Alice's.
    const mallory = newIdentity()
    const forged = { ...latest, version: latest.version + 5, owner: { ...latest.owner, machinePublicKey: b64e(mallory.pub) } }
    w.backend.shares.get(id)!.roster = resign(mallory, forged)
    await w.bob.shared.refresh()
    expect(roster(w.bob, id).version).toBe(latest.version)
    expect(w.bob.store.alerts().map((a) => a.error)).toEqual(['unpinned_key'])
    // Alice's key, a version that never verified.
    w.backend.shares.get(id)!.roster = { ...resign(w.alice.identity, { ...latest, version: latest.version + 6 }), signature: b64e(new Uint8Array(64)) }
    await w.bob.shared.refresh()
    expect(roster(w.bob, id).version).toBe(latest.version)
    expect(w.bob.store.alerts().map((a) => a.error)).toEqual(['unpinned_key', 'bad_signature'])
  })

  it('reads nothing into a backend that cannot answer or answers something else', async () => {
    const w = world()
    const id = await joined(w)
    w.backend.down = true
    await w.bob.shared.refresh()
    expect(roster(w.bob, id)).toBeTruthy()
    await expect(w.bob.shared.invites()).rejects.toMatchObject({ code: 'BACKEND_UNAVAILABLE' })
    w.backend.down = false
    const odd = new SharedTabs({ key: w.bob.key, relay: w.bob.relay, store: w.bob.store,
      backend: async (_m, path) => ok(path.endsWith('/invites') ? { invites: [{ id: 1 }, null, { id: 'i', sharedTabId: id, ownerEmail: 'a', ownerMachineId: 'm', expiresAt: 'x', tabName: 'app\u202e' }, { id: 'j', sharedTabId: id, ownerEmail: 'a', ownerMachineId: 'm', expiresAt: 'x', tabName: 7 }, { id: 'k', sharedTabId: id, ownerEmail: 'a', ownerMachineId: 'm', expiresAt: 'x', tabName: 'y'.repeat(300) }, { id: 'l', sharedTabId: id, ownerEmail: 'a', ownerMachineId: 'm', expiresAt: 'x' }] } : { shares: [null, { sharedTabId: 'x' }, { sharedTabId: id, owner: false, roster: null }] }),
      self: async () => ({ machineId: w.bob.id, accountId: 'u-bob', email: 'bob@y.io' }), ownPanes: async () => [], machineKey: async () => null, askMachine: async () => null, ownMachines: async () => null })
    await odd.refresh()
    expect(roster(w.bob, id)).toBeTruthy()
    // The name is another account's: cleaned and cut here too, and '' from a backend that sends none or not text.
    const base = { sharedTabId: id, ownerEmail: 'a', ownerMachineId: 'm', expiresAt: 'x' }
    expect(await odd.invites()).toEqual([{ id: 'i', ...base, tabName: 'app' }, { id: 'j', ...base, tabName: '' }, { id: 'k', ...base, tabName: 'y'.repeat(200) }, { id: 'l', ...base, tabName: '' }])
    const empty = new SharedTabs({ key: w.bob.key, relay: w.bob.relay, store: w.bob.store, backend: async () => ok({}),
      self: async () => ({ machineId: w.bob.id, accountId: 'u-bob', email: 'bob@y.io' }), ownPanes: async () => [], machineKey: async () => null, askMachine: async () => null, ownMachines: async () => null })
    expect(await empty.invites()).toEqual([])
    await empty.refresh()
  })
})

describe('a member\'s check of its own account\'s entries (detect, not block)', () => {
  const other = b64e(newIdentity().pub)
  const entry = (machineId: string, agentId: string, pub = other): RosterHarness => ({ accountId: 'u-bob', machineId, machinePublicKey: pub, agentId, name: agentId, engine: 'claude' })
  /** A roster Alice's key signs past the one Bob holds, as an owner's computer or a backend gone wrong could serve it:
   *  it verifies, so Bob takes it, and then checks what it lists under his account. */
  async function served(w: World, id: string, harnesses: RosterHarness[]): Promise<void> {
    const held = roster(w.bob, id)
    const next = { ...held, version: held.version + 1, harnesses: [...held.harnesses.filter((x) => x.accountId !== 'u-bob'), ...harnesses] }
    Object.assign(w.backend.shares.get(id)!, { roster: resign(w.alice.identity, next), version: next.version })
    await w.bob.shared.refresh()
    expect(roster(w.bob, id).version).toBe(next.version)
  }
  /** Each time an alert was recorded: the same one within ALERT_WINDOW_MS is counted on the last (rosterStore.ts). */
  const errors = (m: Machine) => m.store.alerts().flatMap((a) => Array<string>(a.count ?? 1).fill(a.error))
  /** The check runs beside the queue: what it records is waited for, and what it must not record is looked at once
   *  everything in flight has run. */
  const recorded = (m: Machine, want: string[]) => vi.waitFor(() => expect(errors(m)).toEqual(want))
  const after = async (w: World, m: Machine, want: string[]) => { await w.net.settle(); expect(errors(m)).toEqual(want) }

  it('records an entry under its own account on a machine it does not have, once, and keeps the roster as signed', async () => {
    const w = world()
    const own = vi.spyOn(w.alice.deps, 'ownMachines')
    const id = await joined(w)
    await served(w, id, [entry('not-mine', 'x'), entry('not-mine', 'y')])
    await after(w, w.bob, ['foreign_machine'])
    expect(w.bob.store.alerts()[0].sharedTabId).toBe(id)
    expect(agents(roster(w.bob, id))).toEqual(['m2-alice/lead', 'not-mine/x', 'not-mine/y'])
    // The same version again, and a refresh that finds nothing newer: nothing new.
    await w.bob.shared['adopt'](roster(w.bob, id))
    await w.bob.shared.refresh()
    await after(w, w.bob, ['foreign_machine'])
    // The owner's computer never checks its own roster that way.
    expect(own).not.toHaveBeenCalled()
  })

  it('records a machine of its own whose key differs from the one listed; an unreachable machine records nothing', async () => {
    const w = world()
    const id = await joined(w)
    w.bob.mine = [w.bob.id, 'm8-bob', 'm9-bob']
    w.bob.keys.set('m8-bob', b64e(newIdentity().pub))
    await served(w, id, [entry(w.bob.id, 'api', w.bob.pub), entry('m8-bob', 'web'), entry('m9-bob', 'db')])
    await after(w, w.bob, ['machine_key_mismatch'])
    // The directory unreadable: no machine is called foreign, and a key its machine answers is still compared.
    w.bob.mine = null
    await served(w, id, [entry('m7-bob', 'z'), entry('m8-bob', 'web')])
    await after(w, w.bob, ['machine_key_mismatch', 'machine_key_mismatch'])
    // A directory that does not list this machine never makes this machine's own entry foreign.
    w.bob.mine = []
    await served(w, id, [entry(w.bob.id, 'api', w.bob.pub)])
    await after(w, w.bob, ['machine_key_mismatch', 'machine_key_mismatch'])
  })

  it('records a roster that lists one of its own machines under another account, once per version and machine', async () => {
    const w = world()
    const id = await joined(w)
    w.bob.mine = [w.bob.id, 'm8-bob']
    const theirs = (machineId: string, agentId: string): RosterHarness => ({ ...entry(machineId, agentId), accountId: 'u-alice' })
    await served(w, id, [theirs('m8-bob', 'x'), theirs('m8-bob', 'y'), theirs(w.bob.id, 'z'), theirs('m5-alice', 'w')])
    await after(w, w.bob, ['own_machine_listed', 'own_machine_listed'])
    // The same version again: nothing new.
    await w.bob.shared['adopt'](roster(w.bob, id))
    await after(w, w.bob, ['own_machine_listed', 'own_machine_listed'])
    // The directory unreadable: only this machine is known to be its own, and the laptop is looked at again later.
    w.bob.mine = null
    await served(w, id, [theirs('m8-bob', 'x'), theirs(w.bob.id, 'z')])
    await after(w, w.bob, ['own_machine_listed', 'own_machine_listed', 'own_machine_listed'])
    w.bob.mine = [w.bob.id, 'm8-bob']
    await w.bob.shared['adopt'](roster(w.bob, id))
    await after(w, w.bob, ['own_machine_listed', 'own_machine_listed', 'own_machine_listed', 'own_machine_listed'])
  })

  it('checks beside the queue: a frame for another tab is handled while a machine of its own has not answered', async () => {
    const w = world()
    const id = await joined(w)
    // Bob is in a second tab of Alice's too.
    w.alice.panes.set('tab-2', [{ machineId: w.alice.id, agentId: 'two', name: 'two', engine: 'codex' }])
    const { sharedTabId: other } = await w.alice.shared.share('tab-2', 'two')
    await w.alice.shared.invite(other, ['bob@y.io'], 7)
    await w.bob.shared.accept((await w.bob.shared.invites())[0].id)
    await w.net.settle()
    // His laptop is asleep: its key ask has not answered yet.
    w.bob.mine = [w.bob.id, 'm8-bob']
    let answer!: (pub: string | null) => void
    const asking = vi.spyOn(w.bob.deps, 'machineKey').mockImplementation((machineId) =>
      machineId === 'm8-bob' ? new Promise((done) => { answer = done }) : Promise.resolve(w.bob.keys.get(machineId) ?? null))
    await served(w, id, [entry('m8-bob', 'web')])
    await vi.waitFor(() => expect(asking).toHaveBeenCalledWith('m8-bob'))
    // A frame for the other tab is handled at once: the relay says Bob was taken out of it.
    await w.bob.shared.onFrame({ sharedTabId: other, closed: { code: 4403, reason: 'Not in this shared tab' } })
    expect(w.bob.store.current(other)).toBeNull()
    expect(w.bob.shared.notices()).toEqual([expect.objectContaining({ sharedTabId: other, kind: 'removed' })])
    expect(errors(w.bob)).toEqual([])
    // The laptop answers, with another key than the roster lists: recorded then.
    answer(b64e(newIdentity().pub))
    await recorded(w.bob, ['machine_key_mismatch'])
  })
})

describe('the pin reaches the member\'s other computers', () => {
  /** Alice shares tab-1 and invites Bob, whose laptop is there before he accepts on his mini. */
  async function invited(w: World): Promise<{ id: string; laptop: Machine }> {
    const id = await share(w)
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    return { id, laptop: w.make('m8-bob', 'u-bob', 'bob@y.io') }
  }
  const accept = async (w: World) => { await w.bob.shared.accept((await w.bob.shared.invites())[0].id); await w.net.settle() }
  const pins = (m: Machine) => m.asked.filter(([, p]) => p.action === 'tab_pin')
  const codeOf = (run: () => unknown) => { try { run(); return null } catch (error) { return (error as MessageError).code } }

  it('a computer with no pin takes the accepting one\'s, holds its roster, opens the relay and adds a harness of its own', async () => {
    const w = world()
    const { id, laptop } = await invited(w)
    await accept(w)
    // The mini told its other computer at once, which asked it for the pin.
    expect(w.bob.asked).toEqual([['m8-bob', { action: 'tab_pin_changed', sharedTabId: id }]])
    expect(pins(laptop)).toEqual([[w.bob.id, { action: 'tab_pin', sharedTabId: id }]])
    expect(laptop.store.pinned(id)).toBe(w.alice.pub)
    expect(roster(laptop, id)).toEqual(roster(w.bob, id))
    expect(laptop.relay.open).toHaveBeenCalledWith(id)
    // Holding the tab, the laptop asks the owner for its own harness, as the machine it runs on.
    await w.alice.shared.refresh()
    await w.net.settle()
    expect(await laptop.shared.addHarness(id, harnessOf(laptop, 'web'))).toEqual({ queued: true })
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toContain('m8-bob/web')
    expect(roster(laptop, id).version).toBe(roster(w.alice, id).version)
    expect([...w.bob.store.alerts(), ...laptop.store.alerts()]).toEqual([])
    // A machine holding the tab answers its pin; one that holds none says so.
    expect(w.bob.shared.pinOf(id)).toEqual({ ownerPub: w.alice.pub, signed: w.bob.store.current(id)!.signed })
    expect(codeOf(() => w.bob.shared.pinOf('f'.repeat(24)))).toBe('NOT_SHARED')
  })

  it('takes only an answer that verifies against the key it names: anything else leaves no pin and no relay', async () => {
    const w = world()
    const { id, laptop } = await invited(w)
    laptop.online = false
    await accept(w)
    laptop.online = true
    const good = w.bob.store.current(id)!.signed
    const mallory = newIdentity()
    const answers: Array<Record<string, unknown> | null> = [
      // Another key than the one that signed it, and Alice's key on a roster whose signature is not hers.
      { ownerPub: b64e(mallory.pub), signed: good },
      { ownerPub: w.alice.pub, signed: { ...good, signature: b64e(new Uint8Array(64)) } },
      // A roster of another tab, nonsense, and a refusal.
      { ownerPub: w.alice.pub, signed: resign(w.alice.identity, { ...roster(w.bob, id), sharedTabId: 'f'.repeat(24) }) },
      { ownerPub: w.alice.pub, signed: 'nonsense' },
      { ownerPub: 7, signed: good },
      { error: { code: 'NOT_SHARED', message: 'This computer holds no such shared tab.' } },
    ]
    for (const answer of answers) {
      laptop.answer = async () => answer
      await laptop.shared.pinChanged(id)
      await w.net.settle()
      expect(laptop.store.pinned(id)).toBeNull()
      expect(laptop.shared.rosters()).toEqual([])
    }
    expect(laptop.relay.open).not.toHaveBeenCalled()
    // What did not verify is recorded, as any roster that does not.
    expect(laptop.store.alerts().map((a) => a.error)).toEqual(['unpinned_key', 'bad_signature'])
    // Asked together, the first answer that verifies is taken, after one that did not; a later one changes nothing.
    laptop.mine = ['m7-bob', w.bob.id, laptop.id, 'm6-bob']
    laptop.answer = async (machineId) => machineId === 'm7-bob' ? answers[0] : w.bob.shared.pinOf(id)
    await laptop.shared.pinChanged(id)
    await w.net.settle()
    expect(laptop.store.pinned(id)).toBe(w.alice.pub)
    expect(roster(laptop, id)).toEqual(roster(w.bob, id))
    expect(laptop.relay.open).toHaveBeenCalledWith(id)
  })

  it('asks again for a pin it could not get only after a minute, or at once when told it changed', async () => {
    const w = world()
    const { id, laptop } = await invited(w)
    laptop.online = false
    await accept(w)
    laptop.online = true
    // The mini is asleep: the laptop's ask is not answered for a while.
    let answer!: (v: null) => void
    laptop.answer = () => new Promise((done) => { answer = done })
    await laptop.shared.refresh()
    await laptop.shared.refresh()
    expect(pins(laptop)).toHaveLength(1)
    answer(null)
    await w.net.settle()
    laptop.answer = undefined
    w.bob.online = false
    w.tick(PULL_RETRY_MS - 1)
    await laptop.shared.refresh()
    await w.net.settle()
    expect(pins(laptop)).toHaveLength(1)
    w.tick(1)
    await laptop.shared.refresh()
    await w.net.settle()
    expect(pins(laptop)).toHaveLength(2)
    expect(laptop.store.pinned(id)).toBeNull()
    // Back within the minute, the mini is not asked again until it says the pin changed.
    w.bob.online = true
    await laptop.shared.refresh()
    await w.net.settle()
    expect(pins(laptop)).toHaveLength(2)
    expect(await remote(laptop, { action: 'tab_pin_changed', sharedTabId: id })).toEqual({ ok: true })
    await w.net.settle()
    expect(pins(laptop)).toHaveLength(3)
    expect(laptop.store.pinned(id)).toBe(w.alice.pub)
    // Pinned, it asks no more.
    w.tick(PULL_RETRY_MS)
    await laptop.shared.refresh()
    await w.net.settle()
    expect(pins(laptop)).toHaveLength(3)
  })

  it('tells every other computer of the account once it accepts, without waiting for any; a directory it cannot read tells none', async () => {
    const w = world()
    const id = await share(w)
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    w.bob.mine = null
    await accept(w)
    expect(w.bob.asked).toEqual([])
    // Accepted again, with two other computers that never answer: accepting does not wait for them.
    const laptop = w.make('m8-bob', 'u-bob', 'bob@y.io')
    laptop.mine = null
    w.bob.mine = [w.bob.id, 'm8-bob', 'm9-bob']
    w.bob.answer = () => new Promise(() => {})
    await w.alice.shared.invite(id, ['bob@y.io'], 7)
    await accept(w)
    await vi.waitFor(() => expect(w.bob.asked).toEqual([['m8-bob', { action: 'tab_pin_changed', sharedTabId: id }], ['m9-bob', { action: 'tab_pin_changed', sharedTabId: id }]]))
    // A computer that cannot read its own directory has no one to ask.
    await laptop.shared.pinChanged(id)
    await w.net.settle()
    expect(laptop.asked).toEqual([])
    expect(laptop.store.pinned(id)).toBeNull()
  })
})

describe('trusting the owner again without a new invitation', () => {
  /** The owner's computer begins again with a new key (a new data folder) and signs the next roster with it, with no
   *  key change signed by the old one: the backend serves it, and Bob's pin cannot verify it. */
  function moved(w: World, id: string, by = newIdentity(), version?: number): { by: Identity; roster: Roster } {
    const latest = roster(w.alice, id)
    const next = { ...latest, version: version ?? latest.version + 1, owner: { ...latest.owner, machinePublicKey: b64e(by.pub) } }
    Object.assign(w.backend.shares.get(id)!, { roster: resign(by, next), version: next.version })
    return { by, roster: next }
  }

  it('checks then confirms: shows the listed key\'s fingerprint beside the pinned one, then pins it and holds its roster', async () => {
    const w = world()
    const id = await added(w)
    const { by, roster: next } = moved(w, id)
    await w.bob.shared.refresh()
    expect(w.bob.store.alerts().map((a) => a.error)).toEqual(['unpinned_key'])
    expect(await w.bob.shared.untrusted()).toEqual([{ sharedTabId: id, ownerEmail: 'alice@x.io' }])
    const offer = await w.bob.shared.retrustOffer(id)
    expect(offer).toEqual({ sharedTabId: id, ownerEmail: 'alice@x.io', ownerPub: b64e(by.pub), fingerprint: fingerprint(by.pub),
      version: next.version, pinnedFingerprint: fingerprint(w.alice.identity.pub) })
    // The check changes nothing.
    expect(w.bob.store.pinned(id)).toBe(w.alice.pub)
    expect(roster(w.bob, id).version).toBe(next.version - 1)
    const drop = vi.spyOn(w.bob.key, 'drop')
    expect(await w.bob.shared.retrust(id, offer.ownerPub)).toEqual({ sharedTabId: id, fingerprint: fingerprint(by.pub) })
    expect(w.bob.store.pinned(id)).toBe(b64e(by.pub))
    expect(roster(w.bob, id)).toEqual(next)
    expect(await w.bob.shared.untrusted()).toEqual([])
    // The session with the owner's machine under its old key does not carry on.
    expect(drop.mock.calls.map(([link]) => [link.machineId, link.peerPub])).toEqual([[w.alice.id, w.alice.pub]])
    expect(w.bob.relay.open).toHaveBeenLastCalledWith(id)
    // From then on the new key's rosters are taken as any other.
    Object.assign(w.backend.shares.get(id)!, { roster: resign(by, { ...next, version: next.version + 1 }), version: next.version + 1 })
    await w.bob.shared.refresh()
    expect(roster(w.bob, id).version).toBe(next.version + 1)
    expect(w.bob.store.alerts().map((a) => a.error)).toEqual(['unpinned_key'])
  })

  it('refuses a key that changed between the check and the confirm, and the old pin stays', async () => {
    const w = world()
    const id = await joined(w)
    const held = roster(w.bob, id)
    moved(w, id)
    const offer = await w.bob.shared.retrustOffer(id)
    const { by: other } = moved(w, id, newIdentity(), held.version + 2)
    await expect(w.bob.shared.retrust(id, offer.ownerPub)).rejects.toMatchObject({ code: 'OWNER_KEY_MISMATCH' })
    expect(w.bob.store.pinned(id)).toBe(w.alice.pub)
    expect(roster(w.bob, id)).toEqual(held)
    // Shown the key that is listed now, the person confirms that one.
    expect(await w.bob.shared.retrust(id, b64e(other.pub))).toEqual({ sharedTabId: id, fingerprint: fingerprint(other.pub) })
  })

  it('refuses a listed roster older than the verifiable one held here (STALE_ROSTER), and the pin stays', async () => {
    const w = world()
    const id = await joined(w)
    await w.alice.shared.invite(id, ['carol@z.io'], 7)
    await w.bob.shared.refresh()
    const held = roster(w.bob, id)
    const { by } = moved(w, id, newIdentity(), held.version - 1)
    expect(await w.bob.shared.retrustOffer(id)).toMatchObject({ version: held.version - 1, ownerPub: b64e(by.pub) })
    await expect(w.bob.shared.retrust(id, b64e(by.pub))).rejects.toMatchObject({ code: 'STALE_ROSTER' })
    expect(w.bob.store.pinned(id)).toBe(w.alice.pub)
    expect(roster(w.bob, id)).toEqual(held)
    // The same version as the one held is no older: the person may confirm it.
    const { by: same } = moved(w, id, newIdentity(), held.version)
    expect(await w.bob.shared.retrust(id, b64e(same.pub))).toMatchObject({ sharedTabId: id })
    expect(roster(w.bob, id).owner.machinePublicKey).toBe(b64e(same.pub))
  })

  it('refuses the owner (IS_OWNER), a tab not listed (NOT_SHARED), an unreadable listing, and a roster that does not verify', async () => {
    const w = world()
    const id = await joined(w)
    await expect(w.alice.shared.retrustOffer(id)).rejects.toMatchObject({ code: 'IS_OWNER' })
    await expect(w.alice.shared.retrust(id, w.alice.pub)).rejects.toMatchObject({ code: 'IS_OWNER' })
    // Another computer of the owner's account, which holds nothing: the tab is still its account's own.
    const mini = w.make('m4-alice', 'u-alice', 'alice@x.io')
    await expect(mini.shared.retrustOffer(id)).rejects.toMatchObject({ code: 'IS_OWNER' })
    await expect(w.bob.shared.retrustOffer('f'.repeat(24))).rejects.toMatchObject({ code: 'NOT_SHARED' })
    await expect(w.bob.shared.retrust('f'.repeat(24), w.alice.pub)).rejects.toMatchObject({ code: 'NOT_SHARED' })
    w.backend.down = true
    await expect(w.bob.shared.retrustOffer(id)).rejects.toMatchObject({ code: 'SHARES_UNAVAILABLE' })
    w.backend.down = false
    const good = w.backend.shares.get(id)!.roster as SignedRoster
    const latest = roster(w.alice, id)
    for (const bad of [{ body: good.body, signature: b64e(new Uint8Array(64)) }, 'nonsense', { body: 'not a roster', signature: good.signature },
      resign(w.alice.identity, { ...latest, sharedTabId: 'f'.repeat(24) }),
      resign(w.alice.identity, { ...latest, members: Array.from({ length: ROSTER_LIMITS.members + 1 }, (_, i) => ({ ...latest.members[0], accountId: `u-${i}` })) })]) {
      w.backend.served.set(`u-bob:${id}`, bad)
      await expect(w.bob.shared.retrustOffer(id)).rejects.toMatchObject({ code: 'ROSTER_INVALID' })
      await expect(w.bob.shared.retrust(id, w.alice.pub)).rejects.toMatchObject({ code: 'ROSTER_INVALID' })
    }
    expect(w.bob.store.pinned(id)).toBe(w.alice.pub)
  })

  it('lists a membership with a lost pin as untrusted, and confirming its owner again trusts it', async () => {
    const w = world()
    const id = await joined(w)
    expect(await w.bob.shared.untrusted()).toEqual([])
    // The owner's own tabs are never listed.
    expect(await w.alice.shared.untrusted()).toEqual([])
    w.bob.store.forget(id)
    expect(await w.bob.shared.untrusted()).toEqual([{ sharedTabId: id, ownerEmail: 'alice@x.io' }])
    expect(await w.bob.shared.retrustOffer(id)).toMatchObject({ ownerPub: w.alice.pub, pinnedFingerprint: null })
    await w.bob.shared.retrust(id, w.alice.pub)
    expect(w.bob.store.pinned(id)).toBe(w.alice.pub)
    expect(await w.bob.shared.untrusted()).toEqual([])
    // A listed roster that cannot be read is no roster held here either.
    w.backend.served.set(`u-bob:${id}`, 'nonsense')
    expect(await w.bob.shared.untrusted()).toEqual([{ sharedTabId: id, ownerEmail: 'alice@x.io' }])
    // Nor is one the pinned key signed for another tab.
    w.backend.served.set(`u-bob:${id}`, resign(w.alice.identity, { ...roster(w.alice, id), sharedTabId: 'f'.repeat(24) }))
    expect(await w.bob.shared.untrusted()).toEqual([{ sharedTabId: id, ownerEmail: 'alice@x.io' }])
    w.backend.down = true
    await expect(w.bob.shared.untrusted()).rejects.toMatchObject({ code: 'SHARES_UNAVAILABLE' })
  })
})

describe('frames between machines', () => {
  it('refuses a hello from a machine that is not in the roster, and opens nothing it sends', async () => {
    const w = world()
    const id = await added(w)
    const carol = w.make('m0-carol', 'u-carol', 'carol@z.io')
    const accept = vi.spyOn(w.alice.key, 'accept'), open = vi.spyOn(w.alice.key, 'open')
    const sends = w.net.sent.length
    const hello = await carol.key.hello({ sharedTabId: id, machineId: w.alice.id, peerPub: w.alice.pub })
    await w.alice.shared.onFrame({ sharedTabId: id, from: { machineId: carol.id, userId: 'u-carol' }, payload: { kind: 'hello', hello, pub: carol.pub } })
    // Bob's listed machine, but the relay says another account sent it.
    await w.alice.shared.onFrame({ sharedTabId: id, from: { machineId: w.bob.id, userId: 'u-carol' }, payload: { kind: 'hello', hello, pub: carol.pub } })
    expect(accept).not.toHaveBeenCalled()
    await w.alice.shared.onFrame({ sharedTabId: id, from: { machineId: carol.id, userId: 'u-carol' }, payload: { __e2e: { v: 1, k: 'p', n: 0, ct: 'AAAA' } } })
    await w.alice.shared.onFrame({ sharedTabId: id, from: { machineId: carol.id, userId: 'u-carol' }, payload: { kind: 'knock', pub: carol.pub } })
    await w.net.settle()
    expect(open).not.toHaveBeenCalled()
    expect(w.net.sent.length).toBe(sends)
  })

  it('lets the lower machine id say hello, and the higher one only knock', async () => {
    const low = world({ alice: 'm2-alice', bob: 'm3-bob' })
    await added(low)
    expect(low.net.kinds('m3-bob', 'm2-alice')).not.toContain('hello')
    expect(low.net.kinds('m3-bob', 'm2-alice')[0]).toBe('knock')
    expect(low.net.kinds('m2-alice', 'm3-bob')[0]).toBe('hello')
    const high = world({ alice: 'm2-alice', bob: 'm1-bob' })
    await added(high)
    expect(high.net.kinds('m2-alice', 'm1-bob')).not.toContain('hello')
    expect(high.net.kinds('m1-bob', 'm2-alice')[0]).toBe('hello')
  })

  it('drops a peer\'s session when a newer roster changes its key', async () => {
    const w = world()
    const id = await added(w)
    // Alice moves to a new key, and her old key signs the move.
    const next = newIdentity()
    const latest = roster(w.alice, id)
    const moved = { ...latest, version: latest.version + 1, owner: { ...latest.owner, machinePublicKey: b64e(next.pub) },
      harnesses: latest.harnesses.map((h) => h.machineId === w.alice.id ? { ...h, machinePublicKey: b64e(next.pub) } : h) }
    const keyChange = { previousPub: w.alice.pub, signature: b64e(sign(w.alice.identity.priv, keyChangeBytes(id, b64e(next.pub)))) }
    w.backend.shares.get(id)!.roster = resign(next, moved, keyChange)
    const drop = vi.spyOn(w.bob.key, 'drop')
    await w.bob.shared.refresh()
    expect(roster(w.bob, id).owner.machinePublicKey).toBe(b64e(next.pub))
    expect(drop).toHaveBeenCalledWith({ sharedTabId: id, machineId: w.alice.id, peerPub: w.alice.pub })
    // The old session is gone: a frame sealed with it is not opened, and Bob asks for a new one.
    const sends = w.net.sent.length
    await w.bob.shared.onFrame({ sharedTabId: id, from: { machineId: w.alice.id, userId: 'u-alice' }, payload: { __e2e: { v: 1, k: 'p', n: 5, ct: 'AAAA' } } })
    expect(w.net.sent.slice(sends).map((s) => s.payload.kind)).toEqual(['knock'])
  })

  it('opens a new session after a lost one: a frame it cannot open asks the peer to start again', async () => {
    const w = world()
    const id = await added(w)
    // Alice's gateway restarted: her sessions are gone, Bob still has his.
    w.alice.key.clear()
    w.tick(HELLO_RETRY_MS)
    await w.bob.shared.removeHarness(id, w.bob.id, 'api')
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    expect(w.bob.shared.pending()).toEqual([])
  })

  it('starts again after a welcome that fails, once the hello is old enough', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    w.alice.online = true
    // A welcome that is not for this hello spends it.
    await w.bob.shared.onFrame({ sharedTabId: id, ready: true })
    const hellos = () => w.net.kinds('m1-bob', w.alice.id).filter((k) => k === 'hello').length
    const before = hellos()
    const last = w.net.sent.filter((s) => s.from === 'm1-bob' && s.payload.kind === 'hello').at(-1)!.payload.hello as { ephemeral: string }
    // A welcome for another hello is not this one's: it spends nothing.
    await w.bob.shared.onFrame({ sharedTabId: id, from: { machineId: w.alice.id, userId: 'u-alice' }, payload: { kind: 'welcome', welcome: { ephemeral: 'x', signature: 'y' }, to: 'other' } })
    await w.bob.shared.onFrame({ sharedTabId: id, from: { machineId: w.alice.id, userId: 'u-alice' }, payload: { kind: 'welcome', welcome: { ephemeral: 'x', signature: 'y' }, to: last.ephemeral } })
    expect(hellos()).toBe(before)
    w.tick(HELLO_RETRY_MS)
    await w.bob.shared.onFrame({ sharedTabId: id, ready: true })
    await w.net.settle()
    expect(hellos()).toBe(before + 1)
    expect(agents(roster(w.alice, id))).toContain('m1-bob/api')
    // A welcome nobody waits for is nothing.
    await w.bob.shared.onFrame({ sharedTabId: id, from: { machineId: w.alice.id, userId: 'u-alice' }, payload: { kind: 'welcome', welcome: {} } })
    w.bob.shared.close()
  })

  it('ignores a refusal for a request it never made, a request sent to a member, and a roster for another tab or none', async () => {
    const w = world()
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    w.alice.online = true
    await w.bob.shared.onFrame({ sharedTabId: id, ready: true })
    await w.net.settle()
    // A sealed refusal from Alice for something Bob never asked is nothing.
    const link: TabLink = { sharedTabId: id, machineId: w.bob.id, peerPub: w.bob.pub }
    for (const frame of [{ kind: 'roster_request', id: 'add:x', op: 'add', harness: {} }, { kind: 'roster_refused', id: 'add:nothing', error: 'TAB_FULL' }, { kind: 'roster_refused', id: 7 }, { kind: 'mystery' }, { kind: 'roster', signed: { body: 1 } },
      { kind: 'roster', signed: resign(w.alice.identity, { ...roster(w.alice, id), sharedTabId: 'f'.repeat(24) }) }]) {
      const sealed = await w.alice.key.seal(link, frame) as { frame: Record<string, unknown> }
      await w.alice.relay.send(id, w.bob.id, sealed.frame)
    }
    await w.net.settle()
    expect(w.bob.shared.notices()).toEqual([])
  })

  it('forgets a tab the relay closes with 4403 and records that the person was removed; any other close keeps it', async () => {
    const w = world()
    const id = await added(w)
    const sends = w.net.sent.length
    await w.bob.shared.onFrame({ sharedTabId: id, ready: true })
    expect(w.net.sent.length).toBe(sends)
    await w.bob.shared.onFrame({ sharedTabId: id, closed: { code: 4409, reason: 'taken over' } })
    expect(w.bob.shared.rosters()).toHaveLength(1)
    await w.bob.shared.onFrame({ sharedTabId: id, closed: { code: 4403, reason: 'not in the tab' } })
    expect(w.bob.shared.rosters()).toEqual([])
    expect(readAll(w.bob.shared)).toEqual([{ id: expect.any(String), sharedTabId: id, kind: 'removed', ownerEmail: 'alice@x.io', at: expect.any(String) }])
    await w.bob.shared.onFrame({ sharedTabId: id, closed: { code: 4403, reason: 'again' } })
    expect(w.bob.shared.notices()).toEqual([])
  })

  it('keeps the owner\'s pin through a 4403, only the relay\'s word: listed still, the tab is taken back under it with no new trust', async () => {
    const w = world()
    const id = await added(w)
    const held = roster(w.bob, id)
    // A 4403 the backend sent while Bob is still a member: his roster, sessions and consent go, his pin stays.
    await w.bob.shared.onFrame({ sharedTabId: id, closed: { code: 4403, reason: 'not in the tab' } })
    expect(w.bob.shared.rosters()).toEqual([])
    expect(w.bob.store.pinned(id)).toBe(w.alice.pub)
    expect(w.bob.consent.keys()).toEqual(new Set())
    // An older roster of the tab is never taken back: the version held is kept as a floor.
    expect(w.bob.store.offer(w.alice.store.current(id)!.signed)).toEqual({ roster: held })
    w.bob.store.release(id)
    const older = resign(w.alice.identity, { ...held, version: held.version - 1 })
    expect(w.bob.store.offer(older)).toEqual({ stale: true })
    // The backend still lists him: the next read takes the roster back under the pin he had, asking no one for it.
    await w.bob.shared.refresh()
    expect(roster(w.bob, id)).toEqual(held)
    expect(w.bob.asked.filter(([, p]) => p.action === 'tab_pin')).toEqual([])
    expect(w.bob.store.alerts()).toEqual([])
    // A roster under another key, served after it, is refused against that pin and recorded; nothing is trusted anew.
    w.bob.store.release(id)
    const mallory = newIdentity()
    Object.assign(w.backend.shares.get(id)!, { roster: resign(mallory, { ...held, version: held.version + 1,
      owner: { ...held.owner, machinePublicKey: b64e(mallory.pub) } }), version: held.version + 1 })
    await w.bob.shared.refresh()
    expect(w.bob.shared.rosters()).toEqual([])
    expect(w.bob.store.pinned(id)).toBe(w.alice.pub)
    expect(w.bob.store.alerts().map((a) => a.error)).toEqual(['unpinned_key'])
    // A tab of this account's own forgets its pin on a 4403, as before: its trust is its computers' keys.
    await w.alice.shared.onFrame({ sharedTabId: id, closed: { code: 4403, reason: 'not in the tab' } })
    expect(w.alice.store.pinned(id)).toBeNull()
    // So does a computer that cannot read its account as the 4403 comes (just restarted): the tab goes all the same.
    expect(w.bob.store.offer(resign(w.alice.identity, { ...held, version: held.version + 2 }))).toMatchObject({ roster: { version: held.version + 2 } })
    const restarted = new SharedTabs({ ...w.bob.deps, self: async () => { throw new MessageError('ACCOUNT_UNAVAILABLE', 'not yet') } })
    await restarted.onFrame({ sharedTabId: id, closed: { code: 4403, reason: 'not in the tab' } })
    expect(w.bob.store.pinned(id)).toBeNull()
  })

  it('takes a roster frame only from the owner\'s account: a member\'s, however it is signed, is not even looked at', async () => {
    const w = world()
    const id = await added(w)
    const held = roster(w.alice, id)
    // Bob's machine, in session with Alice's, sends a roster that does not verify, twenty times.
    const forged = resign(w.bob.identity, { ...held, version: held.version + 1 })
    for (let i = 0; i < 20; i++) await w.bob.shared['sealTo'](roster(w.bob, id), w.alice.id, { kind: 'roster', signed: forged })
    await w.net.settle()
    expect(w.net.sent.filter((s) => s.from === w.bob.id && s.to === w.alice.id).length).toBeGreaterThanOrEqual(20)
    expect(w.alice.store.alerts()).toEqual([])
    expect(roster(w.alice, id)).toEqual(held)
    // The owner's own roster frames still reach the members.
    await lead(w, id, LEAD_OF(w))
    await w.net.settle()
    expect(roster(w.bob, id).leader).toEqual(LEAD_OF(w))
  })

  /** Another socket of this machine took the tab over (4409): the gateway dropped the tab's socket, as it does. */
  const takenOver = async (m: Machine, id: string): Promise<void> => {
    m.opened.delete(id)
    await m.shared.onFrame({ sharedTabId: id, closed: { code: 4409, reason: 'Replaced by a newer connection' } })
  }

  it('opens a relay taken over (4409) again after RELAY_TAKEOVER_MS, and not before, whatever asks for it meanwhile', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = world()
    const id = await added(w)
    w.bob.relay.open.mockClear()
    // Any other close is the gateway's to dial again after: nothing waits here.
    await w.bob.shared.onFrame({ sharedTabId: id, closed: { code: 1011, reason: 'server error' } })
    expect(vi.getTimerCount()).toBe(0)
    await takenOver(w.bob, id)
    // A second word of the same takeover waits the same once.
    await takenOver(w.bob, id)
    expect(vi.getTimerCount()).toBe(1)
    // Opened again at once, it would take the tab back from the socket that just took it, and that one back again.
    await w.bob.shared.refresh()
    await w.bob.shared.removeHarness(id, w.bob.id, 'api')
    await vi.advanceTimersByTimeAsync(RELAY_TAKEOVER_MS - 1)
    expect(w.bob.relay.open).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(w.bob.relay.open.mock.calls).toEqual([[id]])
    expect(w.bob.opened.has(id)).toBe(true)
    expect(vi.getTimerCount()).toBe(0)
    // Open again, it is used as before.
    await w.bob.shared.refresh()
    expect(w.bob.relay.open.mock.calls.length).toBeGreaterThan(1)
    expect(w.bob.shared.notices()).toEqual([])
    w.bob.shared.close()
  })

  it('does not open a relay taken over again once the tab is no longer held, or Agent Messages went to sleep', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = world()
    const id = await added(w)
    w.bob.relay.open.mockClear()
    // Forgotten from the store while it waits (left again after a failed trust): nothing to open.
    await takenOver(w.bob, id)
    const held = w.bob.store.current(id)!.signed
    w.bob.store.forget(id)
    await vi.advanceTimersByTimeAsync(RELAY_TAKEOVER_MS)
    expect(w.bob.relay.open).not.toHaveBeenCalled()
    // Removed while it waits (4403): the wait goes with the tab.
    w.bob.store.pin(id, w.alice.pub)
    w.bob.store.offer(held)
    await takenOver(w.bob, id)
    await w.bob.shared.onFrame({ sharedTabId: id, closed: { code: 4403, reason: 'not in the tab' } })
    expect(vi.getTimerCount()).toBe(0)
    // Asleep while it waits: no timer runs.
    const v = world()
    const other = await added(v)
    await takenOver(v.bob, other)
    expect(vi.getTimerCount()).toBe(1)
    v.bob.shared.close()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops opening a relay taken over a fourth time within ten minutes, and tells the person (relay_taken)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = world()
    const id = await added(w)
    w.bob.relay.open.mockClear()
    for (let i = 0; i < 3; i++) {
      await takenOver(w.bob, id)
      w.tick(RELAY_TAKEOVER_MS)
      await vi.advanceTimersByTimeAsync(RELAY_TAKEOVER_MS)
    }
    expect(w.bob.relay.open).toHaveBeenCalledTimes(3)
    expect(w.bob.shared.notices()).toEqual([])
    await takenOver(w.bob, id)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(RELAY_TAKEOVER_MS)
    // Nothing opens it now: not a refresh, not a message to send.
    await w.bob.shared.refresh()
    await w.bob.shared.removeHarness(id, w.bob.id, 'api')
    expect(w.bob.relay.open).toHaveBeenCalledTimes(3)
    expect(w.bob.opened.has(id)).toBe(false)
    expect(readAll(w.bob.shared)).toEqual([{ id: expect.any(String), sharedTabId: id, kind: 'relay_taken', ownerEmail: 'alice@x.io', at: expect.any(String) }])
    // Not told again.
    await takenOver(w.bob, id)
    expect(w.bob.shared.notices()).toEqual([])
    w.bob.shared.close()
  })

  it('keeps opening a relay taken over now and then: only takeovers within ten minutes count', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const w = world()
    const id = await added(w)
    w.bob.relay.open.mockClear()
    for (let i = 0; i < 6; i++) {
      await takenOver(w.bob, id)
      await vi.advanceTimersByTimeAsync(RELAY_TAKEOVER_MS)
      w.tick(RELAY_TAKEOVER_WINDOW_MS / 3 + 1)
    }
    expect(w.bob.relay.open).toHaveBeenCalledTimes(6)
    expect(w.bob.shared.notices()).toEqual([])
    w.bob.shared.close()
  })

  it('ignores frames for tabs it does not hold, frames without a sender, and anything malformed', async () => {
    const w = world()
    const id = await added(w)
    const from = { machineId: w.alice.id, userId: 'u-alice' }
    const sends = w.net.sent.length
    for (const event of [
      { sharedTabId: 'f'.repeat(24), from, payload: { kind: 'knock', pub: w.alice.pub } },
      { sharedTabId: id, payload: { kind: 'knock' } },
      { sharedTabId: id, from },
      { sharedTabId: id, from, payload: { kind: 'hello', hello: 'x', pub: w.alice.pub } },
      { sharedTabId: id, from, payload: { kind: 'hello', hello: { ephemeral: 'x', signature: 'y' } } },
      { sharedTabId: id, from, payload: { kind: 'other' } },
      { sharedTabId: id, from, payload: { kind: 'welcome', welcome: 'x' } },
      { sharedTabId: id, undeliverable: 'm-nobody' },
    ] as TabFrame[]) await w.bob.shared.onFrame(event)
    expect(w.net.sent.length).toBe(sends)
    // An unreadable sealed frame on a live session is dropped, and the session stays.
    await w.bob.shared.onFrame({ sharedTabId: id, from, payload: { __e2e: { v: 1, k: 'p', n: 999, ct: 'AAAA' } } })
    expect(w.net.sent.length).toBe(sends)
  })

  it('a sealed roster older than the one it holds changes nothing', async () => {
    const w = world()
    const id = await added(w)
    const before = roster(w.bob, id).version
    const link: TabLink = { sharedTabId: id, machineId: w.bob.id, peerPub: w.bob.pub }
    const old = w.backend.puts[1].roster
    const sealed = await w.alice.key.seal(link, { kind: 'roster', signed: old }) as { frame: Record<string, unknown> }
    await w.alice.relay.send(id, w.bob.id, sealed.frame)
    await w.net.settle()
    expect(roster(w.bob, id).version).toBe(before)
  })

  it('carries the roster to the owner\'s other computers, which trust the key their own account vouches for', async () => {
    const w = world()
    const laptop = w.make('m4-alice', 'u-alice', 'alice@x.io')
    w.alice.keys.set('m4-alice', laptop.pub)
    laptop.keys.set(w.alice.id, w.alice.pub)
    w.alice.panes.set('tab-1', [{ machineId: w.alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }, { machineId: 'm4-alice', agentId: 'web', name: 'web', engine: 'claude' }])
    const id = await share(w)
    await laptop.shared.refresh()
    expect(roster(laptop, id).version).toBe(2)
    expect(laptop.relay.open).toHaveBeenCalledWith(id)
    // A change on Alice's desk reaches the laptop over the relay.
    w.alice.panes.set('tab-1', [{ machineId: w.alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }, { machineId: 'm4-alice', agentId: 'web', name: 'web 2', engine: 'claude' }])
    await w.alice.shared.refresh()
    await w.net.settle()
    expect(roster(laptop, id).harnesses[1].name).toBe('web 2')
    // The owner's account is no member: a request from its other computer is refused, and changes nothing.
    const version = roster(w.alice, id).version
    const sealed = await laptop.key.seal({ sharedTabId: id, machineId: w.alice.id, peerPub: w.alice.pub }, { kind: 'roster_request', id: 'add:m4-alice/x', op: 'add',
      harness: { accountId: 'u-alice', machineId: 'm4-alice', machinePublicKey: laptop.pub, agentId: 'x', name: 'x', engine: 'claude' } }) as { frame: Record<string, unknown> }
    await laptop.relay.send(id, w.alice.id, sealed.frame)
    await w.net.settle()
    expect(roster(w.alice, id).version).toBe(version)
    expect(w.net.sent.at(-1)!.payload).toHaveProperty('__e2e')
    // A laptop that cannot read the owner's key keeps nothing.
    const other = w.make('m5-alice', 'u-alice', 'alice@x.io')
    await other.shared.refresh()
    expect(other.shared.rosters()).toEqual([])
  })

  it('heals when either side\'s gateway lost its sessions', async () => {
    const w = world()
    const id = await added(w)
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'web'))
    await w.net.settle()
    // Bob's gateway restarted: Alice's next roster cannot be opened there, so Bob knocks; Alice drops hers and says hello.
    w.bob.key.clear()
    await lead(w, id, LEAD_OF(w))
    await w.net.settle()
    expect(roster(w.bob, id).leader).toEqual(LEAD_OF(w))
    // Two requests wait while Alice is away; Bob's gateway restarts again, and the first seal finds no session.
    w.alice.online = false
    await w.bob.shared.removeHarness(id, w.bob.id, 'api')
    await w.bob.shared.removeHarness(id, w.bob.id, 'web')
    await w.net.settle()
    expect(w.bob.shared.pending()).toHaveLength(2)
    w.bob.key.clear()
    w.alice.online = true
    await w.bob.shared.onFrame({ sharedTabId: id, ready: true })
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    expect(w.bob.shared.pending()).toEqual([])
  })

  it('a restarted owner asks a member\'s unlisted machine for its key, and takes its request', async () => {
    const w = world()
    const id = await added(w)
    await w.bob.shared.removeHarness(id, w.bob.id, 'api')
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead'])
    // Alice's messages process restarts: the same keys and store, no session known and no share read yet.
    w.alice.shared = new SharedTabs(w.alice.deps)
    await w.alice.shared.refresh()
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'again'))
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toContain(`${w.bob.id}/again`)
    expect(w.bob.shared.pending()).toEqual([])
  })

  it('opens nothing for a refresh that was under way when it closed', async () => {
    const w = world()
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    let release!: () => void
    w.backend.hold = new Promise((done) => { release = done })
    const running = w.bob.shared.refresh()
    await new Promise((done) => setImmediate(done))
    w.bob.shared.close()
    release()
    await running
    expect(w.bob.opened.size).toBe(0)
  })

  it('goes quiet when closed: relays closed, no timer, later frames ignored', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    const w = world()
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    expect(vi.getTimerCount()).toBe(1)
    w.bob.shared.close()
    expect(vi.getTimerCount()).toBe(0)
    expect(w.bob.relay.close).toHaveBeenCalledWith(id)
    const sends = w.net.sent.length
    await w.bob.shared.onFrame({ sharedTabId: id, ready: true })
    await w.bob.shared.refresh()
    expect(w.net.sent.length).toBe(sends)
    expect(w.bob.opened.size).toBe(0)
  })

  it('a relay that refuses to send leaves the request waiting', async () => {
    const w = world()
    const id = await joined(w)
    w.bob.relay.send.mockImplementation(async () => false)
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    expect(w.bob.shared.pending()).toHaveLength(1)
    w.bob.shared.close()
  })
})

describe('Agent Messages\' requests between accounts', () => {
  /** What a request to Bob carried, as Alice's key sealed it. */
  const sealedBy = (m: Machine) => vi.spyOn(m.key, 'seal')
  const lastRid = (seal: ReturnType<typeof sealedBy>) => String(seal.mock.calls.filter(([, f]) => f.kind === 'agent_messages').at(-1)![1].rid)

  it('seals a request for the session, hands it to the other side\'s answer with the relay\'s stamp, and resolves on its result', async () => {
    const w = world()
    const id = await added(w)
    const asked: Array<[unknown, Record<string, unknown>]> = []
    w.bob.deps.answer = async (ctx, payload) => { asked.push([ctx, payload]); return { agents: [{ agentId: 'api', name: 'api' }] } }
    const sends = w.net.sent.length
    const reply = w.alice.shared.request(id, w.bob.id, { action: 'who', agentIds: ['api'] }, 5_000)
    await w.net.settle()
    await expect(reply).resolves.toEqual({ agents: [{ agentId: 'api', name: 'api' }] })
    // Bob's side was told the tab and who the relay says asked, and the request without its framing.
    expect(asked).toEqual([[{ sharedTabId: id, from: { machineId: w.alice.id, userId: 'u-alice' } }, { action: 'who', agentIds: ['api'] }]])
    // Both ways sealed: nothing of either in the clear on the relay.
    const carried = w.net.sent.slice(sends)
    expect(carried.map((s) => [s.from, s.to])).toEqual([[w.alice.id, w.bob.id], [w.bob.id, w.alice.id]])
    for (const s of carried) expect(Object.keys(s.payload)).toEqual(['__e2e'])
    // Bob asks Alice the same way: either side asks, whoever said hello.
    w.alice.deps.answer = async () => ({ statuses: [] })
    const back = w.bob.shared.request(id, w.alice.id, { action: 'status', ids: [] }, 5_000)
    await w.net.settle()
    await expect(back).resolves.toEqual({ statuses: [] })
  })

  it('answers a refusal as the other side said it, anything else as unavailable, and with no answer to give, as an unknown request', async () => {
    const w = world()
    const id = await added(w)
    const ask = async () => { const reply = w.alice.shared.request(id, w.bob.id, { action: 'deliver' }, 5_000); await w.net.settle(); return reply }
    w.bob.deps.answer = async () => { throw new MessageError('MAILBOX_FULL', 'Too many messages are waiting on that machine.') }
    expect(await ask()).toEqual({ error: 'MAILBOX_FULL', detail: 'Too many messages are waiting on that machine.' })
    w.bob.deps.answer = async () => { throw new Error('boom') }
    expect(await ask()).toEqual({ error: 'MESSAGES_UNAVAILABLE', detail: expect.any(String) })
    // The answer's own `kind` and `rid` never replace the reply's framing.
    w.bob.deps.answer = async () => ({ kind: 'roster', rid: 'other', ok: true })
    expect(await ask()).toEqual({ ok: true })
    delete w.bob.deps.answer
    expect(await ask()).toEqual({ error: 'UNKNOWN_ACTION', detail: expect.any(String) })
  })

  it('rejects UNCONFIRMED when no result comes in time, and ignores a late one', async () => {
    const w = world()
    const id = await added(w)
    w.alice.panes.set('tab-2', [{ machineId: w.alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }])
    const other = (await w.alice.shared.share('tab-2', 'two')).sharedTabId
    let late: (value: Record<string, unknown>) => void = () => {}
    w.bob.deps.answer = () => new Promise((done) => { late = done })
    const reply = expect(w.alice.shared.request(id, w.bob.id, { action: 'deliver' }, 50)).rejects.toMatchObject({ code: 'UNCONFIRMED' })
    await w.net.settle()
    // Another tab dropped, another machine unreachable: neither is the one this request waits on.
    await w.alice.shared.onFrame({ sharedTabId: other, closed: { code: 4403, reason: 'not in the tab' } })
    await w.alice.shared.onFrame({ sharedTabId: id, undeliverable: 'm9-nobody' })
    await reply
    late({ statuses: [] })
    await w.net.settle()
  })

  it('rejects PEER_AWAY while no session is open, and starts one: once it opens, the next request goes through', async () => {
    const w = world()
    const id = await added(w)
    // Alice's daemon restarted: no session with Bob's machine yet.
    const opened: Array<[string, string]> = []
    w.alice.shared.close()
    w.alice.shared = new SharedTabs({ ...w.alice.deps, opened: (tab, machineId) => { opened.push([tab, machineId]) } })
    w.alice.key.clear()
    const sends = w.net.sent.length
    await expect(w.alice.shared.request(id, w.bob.id, { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'PEER_AWAY' })
    // Alice's id is the lower: she said hello, and nothing else.
    expect(w.net.kinds(w.alice.id, w.bob.id).slice(-1)).toEqual(['hello'])
    expect(w.net.sent.length).toBe(sends + 1)
    await w.net.settle()
    expect(opened).toEqual([[id, w.bob.id]])
    w.bob.deps.answer = async () => ({ agents: [] })
    const reply = w.alice.shared.request(id, w.bob.id, { action: 'who' }, 5_000)
    await w.net.settle()
    await expect(reply).resolves.toEqual({ agents: [] })
  })

  it('rejects PEER_AWAY when the other machine cannot be reached, its session is lost, or the relay will not send', async () => {
    const w = world()
    const id = await added(w)
    w.bob.online = false
    const away = expect(w.alice.shared.request(id, w.bob.id, { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'PEER_AWAY' })
    await w.net.settle()
    await away
    w.bob.online = true
    // The gateway lost the session as it was sealed: started again, and this request is not sent.
    vi.spyOn(w.alice.key, 'seal').mockResolvedValueOnce({ lost: true })
    await expect(w.alice.shared.request(id, w.bob.id, { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'PEER_AWAY' })
    await w.net.settle()
    w.alice.relay.send.mockResolvedValueOnce(false)
    await expect(w.alice.shared.request(id, w.bob.id, { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'PEER_AWAY' })
  })

  it('refuses a tab it does not hold, a machine its roster does not list, a request too large for a frame, and a relay taken over', async () => {
    const w = world()
    const id = await added(w)
    await expect(w.alice.shared.request('f'.repeat(24), w.bob.id, { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'NOT_SHARED' })
    await expect(w.alice.shared.request(id, 'm9-nobody', { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'NOT_IN_TAB' })
    const sends = w.net.sent.length
    await expect(w.alice.shared.request(id, w.bob.id, { action: 'deliver', text: '\u0001'.repeat(30_000) }, 5_000)).rejects.toMatchObject({ code: 'TOO_LARGE' })
    expect(w.net.sent.length).toBe(sends)
    // Another socket of this machine took the tab's relay (4409): a send waits, never lost in a socket that is not there.
    await w.alice.shared.onFrame({ sharedTabId: id, closed: { code: 4409, reason: 'taken over' } })
    await expect(w.alice.shared.request(id, w.bob.id, { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'RELAY_TAKEN' })
    for (let i = 0; i < 3; i++) await w.alice.shared.onFrame({ sharedTabId: id, closed: { code: 4409, reason: 'taken over' } })
    await expect(w.alice.shared.request(id, w.bob.id, { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'RELAY_TAKEN' })
    expect(w.net.sent.length).toBe(sends)
    w.alice.shared.close()
  })

  it('ignores a result for a request it never made, from another machine than the one asked, or for another tab', async () => {
    const w = world()
    const id = await added(w)
    const carol = w.make('m4-carol', 'u-carol', 'carol@z.io')
    await w.alice.shared.invite(id, ['carol@z.io'], 7)
    await carol.shared.accept((await carol.shared.invites())[0].id)
    await w.alice.shared.refresh()
    await carol.shared.addHarness(id, harnessOf(carol, 'web'))
    await w.net.settle()
    const seal = sealedBy(w.alice)
    w.bob.deps.answer = () => new Promise(() => {})
    const reply = w.alice.shared.request(id, w.bob.id, { action: 'who' }, 200)
    const unconfirmed = expect(reply).rejects.toMatchObject({ code: 'UNCONFIRMED' })
    await w.net.settle()
    const rid = lastRid(seal)
    const toAlice = async (from: Machine, frame: Record<string, unknown>, tab = id) => {
      const sealed = await from.key.seal({ sharedTabId: id, machineId: w.alice.id, peerPub: w.alice.pub }, frame) as { frame: Record<string, unknown> }
      await w.alice.shared.onFrame({ sharedTabId: tab, from: { machineId: from.id, userId: from.userId }, payload: sealed.frame })
    }
    // Carol answers the request Alice made of Bob, and Bob answers a request never made.
    await toAlice(carol, { kind: 'agent_messages_result', rid, statuses: ['forged'] })
    await toAlice(w.bob, { kind: 'agent_messages_result', rid: 'never', statuses: [] })
    await toAlice(w.bob, { kind: 'agent_messages_result', statuses: [] })
    // A request whose id is not one: not answered.
    const sends = w.net.sent.length
    await toAlice(w.bob, { kind: 'agent_messages', rid: 7, action: 'who' })
    await toAlice(w.bob, { kind: 'agent_messages', rid: 'r'.repeat(65), action: 'who' })
    await w.net.settle()
    expect(w.net.sent.length).toBe(sends)
    await unconfirmed
  })

  it('rejects what waits when the tab goes or the tabs close, and answers nothing for a tab gone meanwhile', async () => {
    const w = world()
    const id = await added(w)
    let answered: (value: Record<string, unknown>) => void = () => {}
    w.bob.deps.answer = () => new Promise((done) => { answered = done })
    const removed = w.alice.shared.request(id, w.bob.id, { action: 'who' }, 5_000)
    await w.net.settle()
    // Bob's side forgets the tab while its answer is being made: no reply is sealed for it.
    await w.bob.shared.onFrame({ sharedTabId: id, closed: { code: 4403, reason: 'not in the tab' } })
    const sends = w.net.sent.length
    answered({ agents: [] })
    await w.net.settle()
    expect(w.net.sent.length).toBe(sends)
    // Alice's side: the tab is dropped (4403), then a request to another tab is under way as the tabs close.
    const gone = expect(removed).rejects.toMatchObject({ code: 'PEER_AWAY' })
    await w.alice.shared.onFrame({ sharedTabId: id, closed: { code: 4403, reason: 'not in the tab' } })
    await gone
    const w2 = world()
    const id2 = await added(w2)
    w2.bob.deps.answer = () => new Promise(() => {})
    const closing = w2.alice.shared.request(id2, w2.bob.id, { action: 'who' }, 5_000)
    await w2.net.settle()
    const closed = expect(closing).rejects.toMatchObject({ code: 'PEER_AWAY' })
    // One asked just as the tabs close, before its turn in the queue: given up on once, not twice.
    const racing = expect(w2.alice.shared.request(id2, w2.bob.id, { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'PEER_AWAY' })
    w2.alice.shared.close()
    await closed
    await racing
    await expect(w2.alice.shared.request(id2, w2.bob.id, { action: 'who' }, 5_000)).rejects.toMatchObject({ code: 'PEER_AWAY' })
    // Bob's answer for a closed SharedTabs is sealed for no one.
    let late: (value: Record<string, unknown>) => void = () => {}
    const w3 = world()
    const id3 = await added(w3)
    w3.bob.deps.answer = () => new Promise((done) => { late = done })
    void w3.alice.shared.request(id3, w3.bob.id, { action: 'who' }, 100).catch(() => {})
    await w3.net.settle()
    w3.bob.shared.close()
    const quiet = w3.net.sent.length
    late({ agents: [] })
    await w3.net.settle()
    expect(w3.net.sent.length).toBe(quiet)
  })
})

describe('the request queue across a restart', () => {
  const requestsOf = (m: Machine) => m.deps.requests!.load()
  const queued = (m: Machine, id: string, agentId: string, op: 'add' | 'remove' = 'add', machine = m): QueuedRequest => ({ sharedTabId: id, op, since: 7,
    harness: { accountId: m.userId, machineId: machine.id, machinePublicKey: machine.pub, agentId, name: agentId, engine: 'claude' } })
  /** A new process on the same disk: what the old one held in memory is gone. */
  const restart = (m: Machine): SharedTabs => { m.shared.close(); m.shared = new SharedTabs(m.deps); return m.shared }

  it('keeps an add the owner has not answered, and sends it once, when the process starts again and the owner is reachable', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    expect(requestsOf(w.bob)).toEqual([expect.objectContaining({ sharedTabId: id, op: 'add', harness: expect.objectContaining({ agentId: 'api' }) })])
    const again = restart(w.bob)
    expect(again.pending()).toEqual([expect.objectContaining({ sharedTabId: id, op: 'add', agentId: 'api' })])
    w.alice.online = true
    await again.refresh()
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toContain('m1-bob/api')
    expect(roster(w.alice, id).harnesses.filter((h) => h.agentId === 'api')).toHaveLength(1)
    // Settled by the owner's roster: nothing left to resend, here or after the next restart.
    expect(again.pending()).toEqual([])
    expect(requestsOf(w.bob)).toEqual([])
    again.close()
  })

  it('writes nothing over a queue it could not read, keeps new requests in memory, and takes the file\'s back once it reads', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await joined(w)
    w.alice.online = false
    await w.bob.shared.addHarness(id, harnessOf(w.bob, 'api'))
    await w.net.settle()
    const file = join(root, `${w.bob.id}-requests.json`), before = readFileSync(file, 'utf8')
    // The process starts again, and the disk refuses the read once (EIO, EMFILE, EACCES).
    vi.spyOn(w.bob.deps.requests!, 'load').mockImplementationOnce(() => { throw Object.assign(new Error('i/o error'), { code: 'EIO' }) })
    const again = restart(w.bob)
    expect(again.pending()).toEqual([])
    await again.addHarness(id, harnessOf(w.bob, 'web'))
    await w.net.settle()
    expect(again.pending().map((p) => p.agentId)).toEqual(['web'])
    expect(readFileSync(file, 'utf8')).toBe(before)
    // The next refresh reads it: both wait, and both are written down.
    await again.refresh()
    await w.net.settle()
    expect(again.pending().map((p) => p.agentId).sort()).toEqual(['api', 'web'])
    expect(requestsOf(w.bob).map((r) => r.harness.agentId).sort()).toEqual(['api', 'web'])
    w.alice.online = true
    await again.refresh()
    await w.net.settle()
    expect(agents(roster(w.alice, id))).toEqual(expect.arrayContaining(['m1-bob/api', 'm1-bob/web']))
    expect(requestsOf(w.bob)).toEqual([])
    again.close()
  })

  it('lets what was asked while the queue could not be read win over the file, for the same harness either way', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await added(w, 'api')
    const heard = vi.spyOn(w.alice.key, 'open')
    w.alice.online = false
    // The file holds an add of api and a remove of web; the read refuses once as the process starts again.
    w.bob.deps.requests!.save([queued(w.bob, id, 'api'), queued(w.bob, id, 'web', 'remove')])
    vi.spyOn(w.bob.deps.requests!, 'load').mockImplementationOnce(() => { throw Object.assign(new Error('i/o error'), { code: 'EIO' }) })
    const again = restart(w.bob)
    // Meanwhile the person takes api out and puts web in: the opposite of each.
    await again.removeHarness(id, w.bob.id, 'api')
    await again.addHarness(id, harnessOf(w.bob, 'web'))
    await w.net.settle()
    // The roster held here now lists web and not api, so the file's two would not be settled by it: only the newer
    // word keeps them out.
    const now = roster(w.bob, id), web = { accountId: 'u-bob', machineId: w.bob.id, machinePublicKey: w.bob.pub, agentId: 'web', name: 'web', engine: 'claude' }
    w.bob.store.offer(resign(w.alice.identity, { ...now, version: now.version + 1, harnesses: [...now.harnesses.filter((h) => h.agentId !== 'api'), web] }))
    await again.refresh()
    await w.net.settle()
    const asked = (list: Array<{ op: string; agentId?: string; harness?: { agentId: string } }>) => list.map((r) => `${r.op} ${r.agentId ?? r.harness!.agentId}`).sort()
    expect(asked(again.pending())).toEqual(['add web', 'remove api'])
    expect(asked(requestsOf(w.bob))).toEqual(['add web', 'remove api'])
    // Sent once the owner is back: those two, and nothing of the file's.
    w.alice.online = true
    await again.refresh()
    await w.net.settle()
    const requests = (await Promise.all(heard.mock.results.map((r) => r.value as Promise<{ frame?: Record<string, unknown> }>)))
      .map((r) => r.frame).filter((f) => f?.kind === 'roster_request')
    expect(requests.map((f) => `${f!.op} ${(f!.harness as { agentId: string }).agentId}`).sort()).toEqual(['add web', 'remove api'])
    expect(agents(roster(w.alice, id))).toEqual(['m2-alice/lead', 'm1-bob/web'])
    expect(again.pending()).toEqual([])
    again.close()
  })

  it('drops a restored request the held roster already settles: nothing is sent and no timer runs', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await added(w)
    expect(agents(roster(w.bob, id))).toContain('m1-bob/api')
    // The add was applied, but the queue was never written down after it; a remove of a harness not listed is settled too.
    w.bob.deps.requests!.save([queued(w.bob, id, 'api'), queued(w.bob, id, 'ghost', 'remove')])
    const sent = w.net.sent.length
    const shared = restart(w.bob)
    expect(shared.pending()).toEqual([])
    expect(requestsOf(w.bob)).toEqual([])
    await w.net.settle()
    expect(w.net.sent.length).toBe(sent)
    expect((shared as unknown as { timer: unknown }).timer).toBeNull()
    shared.close()
  })

  it('retries every 30 s from the moment it starts, with no new request', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await joined(w)
    w.bob.deps.requests!.save([queued(w.bob, id, 'api')])
    vi.useFakeTimers()
    const reads = vi.fn(w.bob.deps.backend)
    const shared = new SharedTabs({ ...w.bob.deps, backend: reads })
    await vi.advanceTimersByTimeAsync(RETRY_MS)
    expect(reads).toHaveBeenCalledWith('GET', '/api/agent-messages/shares')
    shared.close()
  })

  it('drops what it no longer holds a tab for, and an add naming another machine, and keeps the rest', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await joined(w)
    const laptop = w.make('m8-bob', 'u-bob', 'bob@y.io')
    w.bob.deps.requests!.save([queued(w.bob, 'f'.repeat(24), 'old'), queued(w.bob, id, 'api'), queued(w.bob, id, 'web', 'add', laptop), queued(w.alice, id, 'lead', 'remove', w.alice)])
    const shared = restart(w.bob)
    await vi.waitFor(() => expect(requestsOf(w.bob).map((r) => r.harness.agentId)).toEqual(['api', 'lead']))
    expect(shared.pending().map((p) => `${p.op}:${p.agentId}`)).toEqual(['add:api', 'remove:lead'])
    shared.close()
  })

  it('goes without the timer when everything was dropped, and keeps a request it could not check when its own machine cannot be read', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await joined(w)
    const laptop = w.make('m8-bob', 'u-bob', 'bob@y.io')
    w.bob.deps.requests!.save([queued(w.bob, id, 'web', 'add', laptop)])
    const shared = restart(w.bob)
    await vi.waitFor(() => expect(requestsOf(w.bob)).toEqual([]))
    expect(shared.pending()).toEqual([])
    w.bob.deps.requests!.save([queued(w.bob, id, 'api')])
    const blind = new SharedTabs({ ...w.bob.deps, self: async () => { throw new Error('signed out') } })
    await new Promise((done) => setImmediate(done))
    expect(blind.pending()).toHaveLength(1)
    expect(requestsOf(w.bob)).toHaveLength(1)
    blind.close()
    shared.close()
  })

  it('leaves only the latest word for one harness: an add then a remove, or a remove then an add', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await joined(w)
    w.alice.online = false
    const bob = w.bob.shared as unknown as { enqueue(tab: string, op: 'add' | 'remove', h: RosterHarness): void }
    const h = queued(w.bob, id, 'api').harness
    bob.enqueue(id, 'add', h)
    bob.enqueue(id, 'remove', h)
    expect(requestsOf(w.bob).map((r) => r.op)).toEqual(['remove'])
    bob.enqueue(id, 'add', h)
    expect(requestsOf(w.bob).map((r) => r.op)).toEqual(['add'])
    expect(w.bob.shared.pending()).toHaveLength(1)
  })

  it('keeps working in memory when the disk refuses the queue', async () => {
    const w = world({ bob: 'm1-bob' })
    const id = await joined(w)
    const failing = new SharedTabs({ ...w.bob.deps, requests: { load: () => [], save: () => { throw new Error('disk full') } } as unknown as RequestStore })
    w.bob.shared = failing
    w.alice.online = false
    await expect(failing.addHarness(id, harnessOf(w.bob, 'api'))).resolves.toEqual({ queued: true })
    expect(failing.pending()).toHaveLength(1)
    failing.close()
  })
})

describe('what the directory reads of shared tabs', () => {
  it('names the desk tab an own tab is shared from, on the sharing computer and the account\'s others, and none for a member', async () => {
    const w = world()
    const laptop = w.make('m4-alice', 'u-alice', 'alice@x.io')
    laptop.keys.set(w.alice.id, w.alice.pub)
    for (const m of [w.alice, w.bob, laptop]) m.deps.changed = vi.fn()
    const id = await added(w)
    expect(w.alice.shared.deskTab(id)).toBe('tab-1')
    expect(w.bob.shared.deskTab(id)).toBeNull()
    expect(w.alice.shared.deskTab('f'.repeat(24))).toBeNull()
    // Every roster taken is a change of the directory: Bob's harness reached Alice's tab, and Bob holds the tab.
    expect(w.alice.deps.changed).toHaveBeenCalled()
    expect(w.bob.deps.changed).toHaveBeenCalled()
    // The account's other computer learns the desk tab from the shares it reads, and holds the roster for it.
    expect(laptop.shared.deskTab(id)).toBeNull()
    await laptop.shared.refresh()
    expect(laptop.shared.deskTab(id)).toBe('tab-1')
    expect(laptop.deps.changed).toHaveBeenCalled()
    // Stopped, the tab is no one's here: the directory is told.
    vi.mocked(w.alice.deps.changed!).mockClear()
    await w.alice.shared.stop(id)
    expect(w.alice.shared.deskTab(id)).toBeNull()
    expect(w.alice.deps.changed).toHaveBeenCalled()
  })
})
