import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Duplex } from 'node:stream'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { BackendNotice, TabFrame, TurnDelivery } from '../core/api.js'
import { TabSessions } from '../gateway/tabKey.js'
import { TabRelaySockets } from '../gateway/tabRelay.js'
import { b64e, fingerprint, newIdentity, type Identity } from '../lib/e2ee/core.js'
import type { RegisteredSession } from '../lib/registry.js'
import { setAgentSettingsForTest, signedOutForTest } from '../testing/agentSettings.js'
import { fakeCore } from '../testing/fakeCore.js'
import { MessageError } from './model.js'
import { parseRoster, type Roster } from './roster.js'
import { RosterStore } from './rosterStore.js'
import { SharedTabs } from './sharedTabs.js'
import { HELD_OUTSIDE_MS, LEFT_TAB_REASON, startAgentMessages, TICK_MS, type AgentMessages } from './service.js'
import { FakeBackend, resign, shareIdOf, type Pane } from './sharedTabsFixtures.js'

/*
 * Shared tabs across three accounts, with every piece real but the backend: each machine has its own TabSessions
 * (keys and sessions), RosterStore (in a folder of its own), SharedTabs, and a TabRelaySockets that dials a local
 * WebSocketServer standing in for the backend's relay (backend/src/lib/agentMessagesWs.ts). The routes are the fake
 * backend of sharedTabsFixtures.ts, which tells the relay when a share changes, as the routes' `share-changed` does, and
 * tells the owner's and the members' machines of a roster put, as its `desk_changed` does.
 *
 * The stand-in relay reproduces Task 7's wire: a token that does not authenticate is refused 401 before the upgrade;
 * a socket is admitted for one (account, machine, share) — the account owns the machine and owns the share or is an
 * accepted member — or closed 4403; it says `amsg_ready`, carries `amsg_frame` to the one socket of the addressed
 * machine in that share with `from` stamped by itself, answers `amsg_undeliverable` when there is none, closes a
 * replaced socket 4409, closes 4403 on the re-check after a change, and 1008 on anything malformed.
 */

const SHARE_ID = /^[a-f0-9]{24}$/
const MAX_FRAME = 128 * 1024
const NOT_IN_TAB = 'Not in this shared tab'

interface Socket { ws: WebSocket; userId: string; machineId: string; share: string }

class StandInRelay {
  readonly server: Server = createServer((_req, res) => { res.statusCode = 404; res.end() })
  private readonly wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, handleProtocols: (p) => [...p][0] ?? false })
  /** The admitted sockets, by `<share>:<machine>`: one each, as the relay's subscription per machine is. */
  readonly live = new Map<string, Socket>()
  /** Token → account; machine → the account that owns it. */
  readonly tokens = new Map<string, string>()
  readonly machines = new Map<string, string>()
  /** Machines whose network is gone: their dials never reach the relay. */
  private readonly away = new Set<string>()
  readonly carried: Array<{ share: string; from: string; to: string; delivered: boolean }> = []
  readonly closes: Array<{ share: string; machine: string; code: number }> = []
  readonly unauthorized: string[] = []

  constructor(private readonly backend: FakeBackend) {
    this.server.on('upgrade', (req, socket, head) => this.upgrade(req, socket, head))
    backend.changed = () => this.recheck()
  }

  url(): string { return `ws://127.0.0.1:${(this.server.address() as AddressInfo).port}` }

  /** agentMessageShares.ts `admits`: the account owns the machine, and owns the share or accepted an invitation to it. */
  private admits(userId: string, machineId: string, share: string): boolean {
    const s = this.backend.shares.get(share)
    return this.machines.get(machineId) === userId && !!s && !s.stopped
      && (s.ownerUserId === userId || !!this.backend.members.get(share)?.has(userId))
  }

  private upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const token = String(req.headers['sec-websocket-protocol'] ?? '').split(',')[0].trim()
    const url = new URL(req.url ?? '/', 'http://relay')
    const share = url.searchParams.get('share') ?? '', machineId = url.searchParams.get('machine') ?? ''
    if (url.pathname !== '/api/agent-messages-ws' || !token || !SHARE_ID.test(share) || !machineId || this.away.has(machineId)) {
      socket.destroy()
      return
    }
    const userId = this.tokens.get(token)
    if (!userId) {
      // Before the upgrade, as a status: the daemon refreshes its token and dials again (never 4403, which stops it).
      this.unauthorized.push(machineId)
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n')
      return
    }
    const allowed = this.admits(userId, machineId, share)
    this.wss.handleUpgrade(req, socket, head, (ws) => {
      if (!allowed) this.close(ws, share, machineId, 4403, NOT_IN_TAB)
      else this.attach({ ws, userId, machineId, share })
    })
  }

  private attach(s: Socket): void {
    const key = `${s.share}:${s.machineId}`
    const before = this.live.get(key)
    if (before) this.close(before.ws, s.share, s.machineId, 4409, 'Replaced by a newer connection')
    this.live.set(key, s)
    s.ws.on('close', () => { if (this.live.get(key) === s) this.live.delete(key) })
    s.ws.on('message', (raw, binary) => {
      let frame: { type?: unknown; to?: unknown; payload?: unknown } | null = null
      try { frame = JSON.parse(String(raw)) } catch { /* malformed */ }
      if (binary || (raw as Buffer).byteLength > MAX_FRAME || !frame || frame.type !== 'amsg_frame' || typeof frame.to !== 'string'
        || !frame.to || frame.to.length > 128 || !frame.payload || typeof frame.payload !== 'object') {
        s.ws.close(1008, 'Invalid shared tab message')
        return
      }
      const target = this.live.get(`${s.share}:${frame.to}`)
      this.carried.push({ share: s.share, from: s.machineId, to: frame.to, delivered: !!target })
      // `from` is the relay's own word: the socket's machine and account, never anything the sender wrote.
      if (target) target.ws.send(JSON.stringify({ type: 'amsg_frame', from: { machineId: s.machineId, userId: s.userId }, payload: frame.payload }))
      else s.ws.send(JSON.stringify({ type: 'amsg_undeliverable', to: frame.to }))
    })
    s.ws.send(JSON.stringify({ type: 'amsg_ready' }))
  }

  private close(ws: WebSocket, share: string, machine: string, code: number, reason: string): void {
    this.closes.push({ share, machine, code })
    ws.close(code, reason)
  }

  /** On every share change, as the relay's `share-changed` subscription does: a socket no longer admitted goes 4403. */
  private recheck(): void {
    for (const s of [...this.live.values()]) {
      if (!this.admits(s.userId, s.machineId, s.share)) this.close(s.ws, s.share, s.machineId, 4403, NOT_IN_TAB)
    }
  }

  goAway(machineId: string): void {
    this.away.add(machineId)
    for (const s of this.live.values()) if (s.machineId === machineId) s.ws.terminate()
  }
  comeBack(machineId: string): void { this.away.delete(machineId) }

  async stop(): Promise<void> {
    for (const client of this.wss.clients) client.terminate()
    await new Promise<void>((done) => this.wss.close(() => done()))
    await new Promise<void>((done) => this.server.close(() => done()))
  }
}

interface Machine {
  id: string; userId: string; email: string; identity: Identity; pub: string
  key: TabSessions; store: RosterStore; relay: TabRelaySockets; shared: SharedTabs
  panes: Map<string, Pane[]>
  /** Everything its relay socket told Agent Messages, in order. */
  heard: TabFrame[]
  /** Every token ask, with its options. */
  asks: Array<{ force?: boolean; failedToken?: string }>
}

let root: string
let backend: FakeBackend
let relay: StandInRelay
let alice: Machine, bob: Machine, carol: Machine
/** Alice's shared tab-1 and Bob's. */
let A: string, B: string

function machine(id: string, userId: string, email: string, staleToken?: string): Machine {
  const identity = newIdentity(), token = `token-${id}`
  backend.emails.set(userId, email)
  relay.machines.set(id, userId)
  relay.tokens.set(token, userId)
  let stale = staleToken
  const m = { id, userId, email, identity, pub: b64e(identity.pub), panes: new Map<string, Pane[]>(), heard: [], asks: [] } as unknown as Machine
  m.key = new TabSessions(() => identity, () => id)
  m.store = new RosterStore(join(root, `${id}.json`))
  m.relay = new TabRelaySockets({
    base: relay.url(), environment: 'prod', machineId: () => id,
    accessToken: async (options) => {
      m.asks.push(options ?? {})
      if (options?.force) stale = undefined
      return stale ?? token
    },
    emit: (event) => { m.heard.push(event); void m.shared.onFrame(event) },
  })
  m.shared = new SharedTabs({
    key: m.key, relay: m.relay, store: m.store, backend: backend.as(userId),
    self: async () => ({ machineId: id, accountId: userId, email }),
    ownPanes: async (tabId) => m.panes.get(tabId) ?? [],
    // The only key a machine here can read is its own: no machine is paired with another.
    machineKey: async (machineId) => (machineId === id ? m.pub : null),
    askMachine: async () => null,
    // The account's machines, as the relay's stand-in knows who owns which.
    ownMachines: async () => [...relay.machines].filter(([, owner]) => owner === userId).map(([machineId]) => machineId),
  })
  return m
}

const until = (check: () => void) => vi.waitFor(check, { timeout: 15_000, interval: 20 })
const quiet = (ms = 300) => new Promise((done) => setTimeout(done, ms))
const roster = (m: Machine, id: string): Roster => m.store.current(id)!.roster
const agents = (r: Roster) => r.harnesses.map((h) => `${h.machineId}/${h.agentId}`).sort()
const harness = (m: Machine, agentId: string): Pane => ({ machineId: m.id, agentId, name: agentId, engine: 'claude' })
/** What the backend holds for a share: the owner's latest published version. */
const published = (id: string) => backend.shares.get(id)!.version
const putsOf = (id: string) => backend.puts.filter((p) => parseRoster(p.roster.body)?.sharedTabId === id)
const heardSince = (m: Machine, from: number) => m.heard.slice(from)

beforeAll(async () => {
  vi.spyOn(console, 'log').mockImplementation(() => {})
  root = mkdtempSync(join(tmpdir(), 'shared-tabs-integration-'))
  backend = new FakeBackend()
  relay = new StandInRelay(backend)
  await new Promise<void>((done) => relay.server.listen(0, '127.0.0.1', () => done()))
  alice = machine('alice-mac', 'u-alice', 'alice@x.io')
  bob = machine('bob-mini', 'u-bob', 'bob@y.io')
  // Carol's daemon starts with a token the relay no longer takes: refused 401 before the upgrade, refreshed, dialled again.
  carol = machine('carol-pc', 'u-carol', 'carol@z.io', 'stale-carol')
  // Every machine of an account told `desk_changed` reads the shares again, as messages/service.ts does on the notice.
  backend.deskChanged = (userId) => { for (const m of [alice, bob, carol]) if (m?.userId === userId) void m.shared.refresh().catch(() => {}) }
  alice.panes.set('tab-1', [{ machineId: alice.id, agentId: 'lead', name: 'lead', engine: 'codex' }])
  bob.panes.set('tab-1', [{ machineId: bob.id, agentId: 'lead', name: 'lead', engine: 'claude' }])
})

afterAll(async () => {
  for (const m of [alice, bob, carol]) { m?.shared.close(); m?.relay.closeAll() }
  await relay?.stop()
  rmSync(root, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('shared tabs across three accounts, every piece real but the backend', { timeout: 60_000 }, () => {
  it('1. Alice and Bob each share a desk tab named tab-1: two shared tabs, and one\'s frames never reach the other\'s machines', async () => {
    A = (await alice.shared.share('tab-1', 'app')).sharedTabId
    B = (await bob.shared.share('tab-1', 'bob\'s app')).sharedTabId
    expect(A).toBe(shareIdOf('u-alice', 'tab-1'))
    expect(B).toBe(shareIdOf('u-bob', 'tab-1'))
    expect(A).not.toBe(B)
    expect(backend.shares.get(A)).toMatchObject({ ownerUserId: 'u-alice', ownerMachineId: alice.id, tabId: 'tab-1' })
    expect(backend.shares.get(B)).toMatchObject({ ownerUserId: 'u-bob', ownerMachineId: bob.id, tabId: 'tab-1' })
    expect(alice.shared.rosters().map((r) => r.sharedTabId)).toEqual([A])
    expect(bob.shared.rosters().map((r) => r.sharedTabId)).toEqual([B])
    expect(agents(roster(alice, A))).toEqual(['alice-mac/lead'])
    expect(agents(roster(bob, B))).toEqual(['bob-mini/lead'])
    await until(() => expect([...relay.live.keys()].sort()).toEqual([`${A}:${alice.id}`, `${B}:${bob.id}`].sort()))

    // Bob's machine is not admitted to Alice's tab, and a frame Alice addresses to it there is carried nowhere.
    await bob.relay.open(A)
    await until(() => expect(bob.heard).toContainEqual({ sharedTabId: A, closed: { code: 4403, reason: NOT_IN_TAB } }))
    expect(relay.closes).toContainEqual({ share: A, machine: bob.id, code: 4403 })
    expect(await alice.relay.send(A, bob.id, { kind: 'probe' })).toBe(true)
    await until(() => expect(alice.heard).toContainEqual({ sharedTabId: A, undeliverable: bob.id }))
    expect(relay.carried).toEqual([{ share: A, from: alice.id, to: bob.id, delivered: false }])
    expect(bob.heard.filter((e) => e.payload)).toEqual([])
    // The 4403 for a tab Bob does not hold changed nothing of his own.
    expect(bob.shared.rosters().map((r) => r.sharedTabId)).toEqual([B])
  })

  it('2. Alice invites Bob and Carol; both accept with her fingerprint; her refresh lists them; both then hold her latest roster', async () => {
    expect(await alice.shared.invite(A, ['bob@y.io', 'carol@z.io'], 7)).toEqual({ invited: ['bob@y.io', 'carol@z.io'], refused: [] })
    const [toBob] = await bob.shared.invites()
    const [toCarol] = await carol.shared.invites()
    expect(toBob).toMatchObject({ sharedTabId: A, ownerEmail: 'alice@x.io', ownerMachineId: alice.id })
    expect(toCarol).toMatchObject({ sharedTabId: A, ownerEmail: 'alice@x.io', ownerMachineId: alice.id })
    const shown = fingerprint(alice.identity.pub)
    expect(await bob.shared.accept(toBob.id, alice.pub)).toEqual({ sharedTabId: A, fingerprint: shown })
    expect(await carol.shared.accept(toCarol.id, alice.pub)).toEqual({ sharedTabId: A, fingerprint: shown })
    const accepted = published(A)
    expect(roster(bob, A).version).toBe(accepted)
    expect(roster(carol, A).version).toBe(accepted)

    await alice.shared.refresh()
    expect(published(A)).toBe(accepted + 1)
    expect(roster(alice, A).version).toBe(published(A))
    expect(roster(alice, A).members.map((m) => m.accountId).sort()).toEqual(['u-bob', 'u-carol'])
    expect(roster(alice, A).invites).toEqual([])
    // The new roster lists no machine of theirs yet, so it is not sent to them over the relay; the backend's roster put
    // tells the members' accounts too (`desk_changed`), and each reads it then, as its daemon does (messages/service.ts).
    await until(() => { for (const m of [bob, carol]) expect(roster(m, A).version).toBe(published(A)) })
    for (const m of [bob, carol]) {
      expect(roster(m, A)).toEqual(roster(alice, A))
      expect(m.store.current(A)!.signed).toEqual(alice.store.current(A)!.signed)
    }

    // Both relay sockets admitted as members; Carol's after its stale token was refused 401 and refreshed.
    await until(() => {
      expect(relay.live.has(`${A}:${bob.id}`)).toBe(true)
      expect(relay.live.has(`${A}:${carol.id}`)).toBe(true)
    })
    expect(relay.unauthorized).toEqual([carol.id])
    expect(carol.asks).toContainEqual({ force: true, failedToken: 'stale-carol' })
    // The ready notice lands a turn after the socket is admitted; asserting it at once failed CI under load (#1378).
    await until(() => expect(carol.heard).toContainEqual({ sharedTabId: A, ready: true }))
  })

  it('3. Bob adds bob/api and Carol adds carol/web: both appear in every member\'s roster', async () => {
    expect(await bob.shared.addHarness(A, harness(bob, 'api'))).toEqual({ queued: true })
    await until(() => expect(agents(roster(bob, A))).toContain('bob-mini/api'))
    expect(await carol.shared.addHarness(A, harness(carol, 'web'))).toEqual({ queued: true })
    const all = ['alice-mac/lead', 'bob-mini/api', 'carol-pc/web']
    await until(() => { for (const m of [alice, bob, carol]) expect(agents(roster(m, A))).toEqual(all) })
    for (const m of [alice, bob, carol]) {
      expect(roster(m, A).version).toBe(published(A))
      expect(roster(m, A)).toEqual(roster(alice, A))
      expect(m.shared.pending()).toEqual([])
    }
    // Each harness carries its own machine's key, and its own account.
    const byAgent = new Map(roster(alice, A).harnesses.map((h) => [h.agentId, h]))
    expect(byAgent.get('api')).toMatchObject({ accountId: 'u-bob', machinePublicKey: bob.pub })
    expect(byAgent.get('web')).toMatchObject({ accountId: 'u-carol', machinePublicKey: carol.pub })
  })

  it('4. A backend that serves Bob an older roster changes nothing; one signed by Carol\'s key is refused and recorded', async () => {
    const held = bob.store.current(A)!
    const alerts = bob.store.alerts().length
    const older = putsOf(A).find((p) => p.version === held.roster.version - 1)!
    expect(older).toBeDefined()

    backend.served.set(`u-bob:${A}`, older.roster)
    await bob.shared.refresh()
    expect(bob.store.current(A)).toEqual(held)
    expect(bob.store.alerts()).toHaveLength(alerts)

    // Carol's machine key signs a roster that would drop her own harness, one version ahead: not the owner's key.
    const forged = resign(carol.identity, { ...held.roster, version: held.roster.version + 1, harnesses: held.roster.harnesses.filter((h) => h.accountId !== 'u-carol') })
    backend.served.set(`u-bob:${A}`, forged)
    await bob.shared.refresh()
    backend.served.delete(`u-bob:${A}`)
    expect(bob.store.current(A)).toEqual(held)
    expect(bob.store.alerts().slice(alerts)).toEqual([{ id: expect.any(String), sharedTabId: A, at: expect.any(String), error: 'bad_signature' }])
    expect(agents(roster(bob, A))).toContain('carol-pc/web')
  })

  it('5. While Alice\'s machine is offline Bob\'s add of bob/db waits; once she is back it is applied, once', async () => {
    const puts = putsOf(A).length, carried = relay.carried.length
    relay.goAway(alice.id)
    await until(() => expect(relay.live.has(`${A}:${alice.id}`)).toBe(false))

    expect(await bob.shared.addHarness(A, harness(bob, 'db'))).toEqual({ queued: true })
    await until(() => expect(relay.carried.slice(carried)).toContainEqual({ share: A, from: bob.id, to: alice.id, delivered: false }))
    const waiting = [expect.objectContaining({ sharedTabId: A, op: 'add', machineId: bob.id, agentId: 'db' })]
    expect(bob.shared.pending()).toEqual(waiting)
    // The 30 s retry (the timer's tick is `refresh`) while she is still away: still waiting, nothing applied.
    await bob.shared.refresh()
    await quiet()
    expect(bob.shared.pending()).toEqual(waiting)
    expect(putsOf(A)).toHaveLength(puts)
    expect(agents(roster(bob, A))).not.toContain('bob-mini/db')

    const back = alice.heard.length
    relay.comeBack(alice.id)
    await until(() => expect(heardSince(alice, back)).toContainEqual({ sharedTabId: A, ready: true }))
    await bob.shared.refresh() // the next retry
    await until(() => expect(agents(roster(bob, A))).toContain('bob-mini/db'))
    expect(bob.shared.pending()).toEqual([])
    // Once: another retry and a moment later, still one roster put for it, listing bob/db once.
    await bob.shared.refresh()
    await quiet()
    const added = putsOf(A).slice(puts)
    expect(added).toHaveLength(1)
    expect(agents(parseRoster(added[0].roster.body)!)).toEqual(['alice-mac/lead', 'bob-mini/api', 'bob-mini/db', 'carol-pc/web'])
    await until(() => { for (const m of [alice, bob, carol]) expect(roster(m, A).version).toBe(published(A)) })
    expect(roster(carol, A)).toEqual(roster(alice, A))
  })

  it('5b. A machine of Bob\'s the roster does not list asks to add a harness on his other machine: refused FORBIDDEN, the roster unchanged', async () => {
    const laptop = machine('bob-laptop', 'u-bob', 'bob@y.io')
    try {
      // The laptop holds Alice's roster as Bob's mini does, and opens a session with her computer: her computer takes
      // the key of a member's machine it has not listed yet.
      laptop.store.pin(A, alice.pub)
      laptop.store.offer(bob.store.current(A)!.signed)
      const before = roster(alice, A), puts = putsOf(A).length
      const opened = vi.spyOn(laptop.key, 'open')
      await laptop.relay.open(A)
      await until(() => expect(laptop.heard).toContainEqual({ sharedTabId: A, ready: true }))
      expect(await laptop.relay.send(A, alice.id, { kind: 'knock', pub: laptop.pub })).toBe(true)
      const link = { sharedTabId: A, machineId: alice.id, peerPub: alice.pub }
      const frames = async () => (await Promise.all(opened.mock.results.map((r) => r.value as Promise<{ frame?: Record<string, unknown> }>))).map((f) => f.frame)
      // Open once her roster, which her computer sends as a session opens, has arrived.
      await until(async () => expect(await frames()).toContainEqual(expect.objectContaining({ kind: 'roster' })))
      const sealed = await laptop.key.seal(link, { kind: 'roster_request', id: 'add:bob-mini/sneak', op: 'add',
        harness: { accountId: 'u-bob', machineId: bob.id, machinePublicKey: bob.pub, agentId: 'sneak', name: 'sneak', engine: 'claude' } })
      expect(await laptop.relay.send(A, alice.id, (sealed as { frame: Record<string, unknown> }).frame)).toBe(true)
      await until(async () => expect(await frames()).toContainEqual({ kind: 'roster_refused', id: 'add:bob-mini/sneak', error: 'FORBIDDEN' }))
      expect(roster(alice, A)).toEqual(before)
      expect(putsOf(A)).toHaveLength(puts)
    } finally {
      laptop.shared.close()
      laptop.relay.closeAll()
      relay.machines.delete(laptop.id)
    }
  })

  it('6. Alice removes Carol: the relay closes Carol\'s socket 4403 on its re-check, Carol forgets the tab, Bob\'s roster drops carol/web', async () => {
    const heard = carol.heard.length
    await alice.shared.removeMember(A, 'u-carol')
    await until(() => expect(heardSince(carol, heard)).toContainEqual({ sharedTabId: A, closed: { code: 4403, reason: NOT_IN_TAB } }))
    expect(relay.closes).toContainEqual({ share: A, machine: carol.id, code: 4403 })
    await until(() => expect(carol.store.current(A)).toBeNull())
    expect(carol.shared.rosters()).toEqual([])
    expect(carol.shared.notices()).toEqual([expect.objectContaining({ sharedTabId: A, kind: 'removed' })])

    await until(() => expect(agents(roster(bob, A))).toEqual(['alice-mac/lead', 'bob-mini/api', 'bob-mini/db']))
    expect(roster(bob, A).members.map((m) => m.accountId)).toEqual(['u-bob'])
    expect(roster(bob, A)).toEqual(roster(alice, A))
    expect(roster(bob, A).version).toBe(published(A))
    // A 4403 is final: Carol's machine does not dial the tab again.
    await quiet()
    expect(relay.live.has(`${A}:${carol.id}`)).toBe(false)

    // And through it all, nothing of Alice's tab reached Bob's: his own tab-1 is as he shared it, and no frame was
    // carried in it (it lists no other machine), while every frame anyone heard from another account was in Alice's.
    expect(roster(bob, B)).toMatchObject({ sharedTabId: B, version: 2, owner: { accountId: 'u-bob', machineId: bob.id } })
    expect(agents(roster(bob, B))).toEqual(['bob-mini/lead'])
    expect(relay.carried.filter((c) => c.share === B)).toEqual([])
    for (const m of [alice, bob, carol]) expect(m.heard.filter((e) => e.from && e.sharedTabId !== A)).toEqual([])
  })

  it('7. Alice stops sharing and shares tab-1 again: Bob is out, and the version carries on past the stopped share\'s', async () => {
    const before = published(A), heard = bob.heard.length
    await alice.shared.stop(A)
    await until(() => expect(heardSince(bob, heard)).toContainEqual({ sharedTabId: A, closed: { code: 4403, reason: NOT_IN_TAB } }))
    await until(() => expect(bob.store.current(A)).toBeNull())
    expect(await alice.shared.share('tab-1', 'app')).toEqual({ sharedTabId: A })
    expect(published(A)).toBe(before + 2)
    expect(roster(alice, A)).toMatchObject({ version: before + 2, members: [] })
    expect(agents(roster(alice, A))).toEqual(['alice-mac/lead'])
  })
})

/*
 * Agent Messages between two accounts, every piece real but the backend: each daemon runs the whole service
 * (service.ts) on its own data folder, with its own keys (TabSessions) and relay sockets (TabRelaySockets) to a stand-in
 * relay of its own, over the fake backend's routes. Alice shares her desk tab, Bob joins and adds his `api`, and their
 * harnesses message each other through the tab's relay. The service's intervals are faked and its clock moved by the
 * test (`tick`); the sockets, the sealing and every check are real.
 */
describe('Agent Messages between two accounts, each daemon\'s whole service over the relay', { timeout: 60_000 }, () => {
  interface Daemon {
    id: string; userId: string; email: string; identity: Identity; relay: TabRelaySockets; service: AgentMessages
    ask(payload: Record<string, unknown>): Promise<Record<string, unknown>>
    /** What its core was asked to type, by agent: the delivery's text and id. */
    typed: Array<[string, string, string]>
    notices: Set<(notice: BackendNotice) => void>
  }
  let home: string
  let net: FakeBackend
  let relay2: StandInRelay
  let clock = Date.UTC(2026, 9, 15, 12)
  let alice2: Daemon, bob2: Daemon
  let carol2: Daemon | undefined
  let tab: string

  function daemon(id: string, userId: string, email: string, agents: Array<{ agentId: string; engine: string }>, deskTabs: (machineId: string) => unknown[]): Daemon {
    const identity = newIdentity(), token = `token-${id}`
    net.emails.set(userId, email)
    relay2.machines.set(id, userId)
    relay2.tokens.set(token, userId)
    const dataDir = join(home, id)
    mkdirSync(dataDir, { recursive: true })
    setAgentSettingsForTest(dataDir, { agentMessages: true })
    const key = new TabSessions(() => identity, () => id)
    const frames = new Set<(event: TabFrame) => void>()
    const relay = new TabRelaySockets({ base: relay2.url(), environment: 'prod', machineId: () => id, accessToken: async () => token,
      emit: (event) => { for (const l of frames) l(event) } })
    const notices = new Set<(notice: BackendNotice) => void>()
    const typed: Array<[string, string, string]> = []
    const heard = new Set<(event: TurnDelivery) => void>()
    const sessions = agents.map((a, i) => ({ agentId: a.agentId, sessionId: `s-${a.agentId}`, engine: a.engine, cwd: `/work/${a.agentId}`,
      tmuxPane: `%${i + 1}`, runtimes: [{ backend: 'tmux', paneId: `%${i + 1}` }], active: true, title: a.agentId })) as unknown as RegisteredSession[]
    const core = fakeCore({
      dataDir,
      daemon: { machineId: () => id, port: 1 },
      agents: { live: () => sessions, displayName: (s) => (s as unknown as { title: string }).title, terminalAvailable: () => true },
      // The core types the delivery into the idle agent at once, and says so.
      turns: { deliver: (agentId, text, deliveryId) => { typed.push([agentId, text, deliveryId]); queueMicrotask(() => { for (const l of heard) l({ deliveryId, sessionId: agentId, state: 'started' } as TurnDelivery) }) },
        onDelivery: (l) => { heard.add(l); return () => heard.delete(l) } },
      account: {
        backend: async (method, path, body) => (path === '/api/agent-messages'
          ? { status: 200, body: { success: true, data: { revision: 1, machines: [{ machineId: id, name: id }], tabs: deskTabs(id) } } }
          : net.as(userId)(method, path, body)),
        identity: async () => ({ accountId: userId, email }), tabKey: key, tabRelay: relay,
        onNotice: (l) => { notices.add(l); return () => notices.delete(l) },
      },
    })
    const service = startAgentMessages(core, { stateDir: join(dataDir, 'agent-messages'), inboxRoot: join(dataDir, 'inbox'), dataDir,
      // Each account here has one machine: nothing goes over a paired relay.
      rpc: async () => { throw new MessageError('NO_PEER_LINK', 'That machine is not paired with this one.') },
      watchSetting: () => () => {}, onTabFrame: (l) => { frames.add(l); return () => frames.delete(l) }, now: () => clock,
      // No test starts the real gh.
      tasks: async () => { throw new MessageError('GH_MISSING', 'No gh runs in this test.') } })
    return { id, userId, email, identity, relay, service, typed, notices,
      ask: (payload) => Promise.resolve(service.requests.agent_messages(payload, { local: true, owner: true })) as Promise<Record<string, unknown>> }
  }

  /** The service's next look (TICK_MS on its clock), and time for what it set off on the sockets. */
  const tick = async (ms = TICK_MS) => { clock += ms; vi.advanceTimersByTime(ms); await quiet(100) }
  const desk = (d: Daemon) => { for (const l of d.notices) l({ type: 'desk_changed', revision: 2 } as BackendNotice) }
  const history = async (d: Daemon) => (await d.ask({ action: 'history' })).messages as Array<{ id: string; tabId: string; statuses: Array<Record<string, unknown>> }>
  const statusOf = async (d: Daemon, id: string) => (await history(d)).find((m) => m.id === id)?.statuses[0]
  const typedOf = (d: Daemon, id: string) => d.typed.filter(([, text]) => text.includes(`[${id} from`))

  beforeAll(async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    home = mkdtempSync(join(tmpdir(), 'agent-messages-two-accounts-'))
    net = new FakeBackend()
    relay2 = new StandInRelay(net)
    await new Promise<void>((done) => relay2.server.listen(0, '127.0.0.1', () => done()))
    // Alice's desk tab-1 holds her lead; Bob's desk holds nothing he shares: his api joins Alice's tab from his roster.
    alice2 = daemon('alice-mac', 'u-alice', 'alice@x.io', [{ agentId: 'lead', engine: 'codex' }], (m) => [{ id: 'tab-1', name: 'app', panes: [{ machineId: m, agentId: 'lead' }] }])
    bob2 = daemon('bob-mini', 'u-bob', 'bob@y.io', [{ agentId: 'api', engine: 'claude' }], () => [])
    // A roster put tells the owner's and the members' accounts, as the route's `desk_changed` does.
    net.deskChanged = (userId) => { for (const d of [alice2, bob2]) if (d?.userId === userId) desk(d) }
    alice2.service.start()
    bob2.service.start()
  })

  afterAll(async () => {
    for (const d of [alice2, bob2, carol2]) { d?.service.stop(); d?.relay.closeAll() }
    await relay2?.stop()
    vi.useRealTimers()
    signedOutForTest()
    rmSync(home, { recursive: true, force: true })
  })

  it('1. Alice shares tab-1, Bob accepts and adds his api: each daemon\'s directory lists the other\'s harness', async () => {
    tab = (await alice2.ask({ action: 'share_tab', tabId: 'tab-1', name: 'app' })).sharedTabId as string
    expect(tab).toBe(shareIdOf('u-alice', 'tab-1'))
    expect(await alice2.ask({ action: 'share_invite', sharedTabId: tab, emails: ['bob@y.io'], days: 7 })).toEqual({ invited: ['bob@y.io'], refused: [] })
    const { invites } = await bob2.ask({ action: 'shares' }) as { invites: Array<{ id: string }> }
    expect(await bob2.ask({ action: 'share_accept', inviteId: invites[0].id, ownerPub: b64e(alice2.identity.pub) })).toMatchObject({ sharedTabId: tab })
    desk(alice2)
    await until(async () => expect((await alice2.ask({ action: 'shares' }) as { rosters: Roster[] }).rosters[0].members.map((m) => m.accountId)).toEqual(['u-bob']))
    expect(await bob2.ask({ action: 'share_add', sharedTabId: tab, harness: { machineId: bob2.id, agentId: 'api', name: 'api', engine: 'claude' } })).toEqual({ queued: true })
    await until(async () => expect(String((await alice2.ask({ action: 'send', pane: '%1' })).roster)).toMatch(/^ {2}api +Claude Code/m))
    await until(async () => expect(String((await bob2.ask({ action: 'send', pane: '%1' })).roster)).toMatch(/^ {2}lead +Codex/m))
  })

  it('2. Alice → Bob: through the tab, typed into Bob\'s api headed with Alice\'s account, and Alice sees it delivered', async () => {
    const sent = await alice2.ask({ action: 'send', pane: '%1', to: 'api', text: 'the build is green' }) as { id: string; recipients: Array<Record<string, unknown>> }
    expect(sent.recipients).toEqual([expect.objectContaining({ name: 'api', state: 'queued' })])
    expect(typedOf(bob2, sent.id)).toEqual([['api', expect.stringContaining(`[${sent.id} from lead · alice's account · Codex · alice-ma]\nthe build is green`), expect.any(String)]])
    // Alice's next look asks Bob's daemon, through the tab, what became of it.
    await tick()
    await until(async () => expect(await statusOf(alice2, sent.id)).toMatchObject({ machineId: bob2.id, agentId: 'api', state: 'delivered', via: 'prompt' }))
  })

  it('3. Bob → Alice the same way: logged on Alice\'s computer under her desk tab, and Bob sees it delivered', async () => {
    const sent = await bob2.ask({ action: 'send', pane: '%1', to: 'lead', text: 'thanks, rebasing' }) as { id: string }
    expect(typedOf(alice2, sent.id)).toEqual([['lead', expect.stringContaining(`[${sent.id} from api · bob's account · Claude Code · bob-mini]\nthanks, rebasing`), expect.any(String)]])
    expect((await history(alice2)).find((m) => m.id === sent.id)!.tabId).toBe('tab-1')
    expect((await history(bob2)).find((m) => m.id === sent.id)!.tabId).toBe(tab)
    // Bob's daemon asks at its next look that is REMOTE_STATUS_MS after its last.
    await until(async () => { await tick(); expect(await statusOf(bob2, sent.id)).toMatchObject({ machineId: alice2.id, agentId: 'lead', state: 'delivered' }) })
  })

  it('4. Bob\'s computer offline: Alice\'s message waits in her outbox, saying so; Bob back, it is delivered exactly once', async () => {
    relay2.goAway(bob2.id)
    await until(() => expect(relay2.live.has(`${tab}:${bob2.id}`)).toBe(false))
    const sent = await alice2.ask({ action: 'send', pane: '%1', to: 'api', text: 'when you are back' }) as { id: string; recipients: Array<Record<string, unknown>> }
    expect(sent.recipients).toEqual([{ name: 'api', state: 'queued', reason: 'bob\'s computer is away: handed over once it is back' }])
    // Tried again while he is away: still waiting, never dropped.
    await tick(60_000)
    await tick()
    expect(await statusOf(alice2, sent.id)).toMatchObject({ state: 'queued', reason: 'bob\'s computer is away: handed over once it is back' })
    expect(typedOf(bob2, sent.id)).toEqual([])
    relay2.comeBack(bob2.id)
    await until(() => expect(relay2.live.has(`${tab}:${bob2.id}`)).toBe(true))
    await until(async () => { await tick(60_000); expect(typedOf(bob2, sent.id)).toHaveLength(1) })
    await until(async () => { await tick(); expect(await statusOf(alice2, sent.id)).toMatchObject({ state: 'delivered' }) })
    // More looks, more time: still once.
    for (let i = 0; i < 3; i++) await tick(60_000)
    expect(typedOf(bob2, sent.id)).toHaveLength(1)
  })

  it('5. Bob removed while a message to him waits: it fails NOT_IN_TAB after the hold, and not before', async () => {
    relay2.goAway(bob2.id)
    await until(() => expect(relay2.live.has(`${tab}:${bob2.id}`)).toBe(false))
    const sent = await alice2.ask({ action: 'send', pane: '%1', to: 'api', text: 'one last thing' }) as { id: string }
    expect(await statusOf(alice2, sent.id)).toMatchObject({ state: 'queued' })
    await alice2.ask({ action: 'share_remove_member', sharedTabId: tab, accountId: 'u-bob' })
    await tick()
    expect(await statusOf(alice2, sent.id)).toMatchObject({ state: 'queued', reason: expect.stringContaining('waits 5 minutes') })
    await tick(HELD_OUTSIDE_MS - 2 * TICK_MS)
    expect(await statusOf(alice2, sent.id)).toMatchObject({ state: 'queued' })
    await tick(2 * TICK_MS)
    expect(await statusOf(alice2, sent.id)).toMatchObject({ state: 'failed', code: 'NOT_IN_TAB', reason: LEFT_TAB_REASON })
    expect(typedOf(bob2, sent.id)).toEqual([])
  })

  // Version skew (plan Task D3, case 4): a member whose daemon is from before shared tabs never opens the tab's relay.
  const membersOf = async () => ((await alice2.ask({ action: 'shares' })) as { rosters: Roster[] }).rosters.find((r) => r.sharedTabId === tab)!

  it('6. Dave, on an older Harness, accepts from elsewhere: Alice lists him with no harness, and nothing of his ever arrives', async () => {
    expect(await alice2.ask({ action: 'share_invite', sharedTabId: tab, emails: ['dave@w.io'], days: 7 })).toEqual({ invited: ['dave@w.io'], refused: [] })
    net.emails.set('u-dave', 'dave@w.io')
    // His machine is his, but its daemon has no shared tabs: it never dials the tab's relay, nor asks to add a harness.
    relay2.machines.set('dave-old', 'u-dave')
    const invite = [...net.invites.values()].find((i) => i.email === 'dave@w.io')!
    expect((await net.as('u-dave')('POST', `/api/agent-messages/invites/${invite.id}/accept`)).status).toBe(200)
    desk(alice2)
    await until(async () => expect((await membersOf()).members.map((m) => m.accountId)).toContain('u-dave'))
    for (let i = 0; i < 3; i++) await tick(60_000)
    const held = await membersOf()
    expect(held.harnesses.filter((h) => h.accountId === 'u-dave')).toEqual([])
    expect([...relay2.live.keys()].filter((k) => k.endsWith(':dave-old'))).toEqual([])
    expect(relay2.carried.filter((c) => c.from === 'dave-old' || c.to === 'dave-old')).toEqual([])
    // Alice's harnesses have no teammate of his to message.
    expect(String((await alice2.ask({ action: 'send', pane: '%1' })).roster)).not.toContain('dave')
  })

  it('7. Carol\'s computer goes back to an older Harness after adding her web: Alice\'s message to it waits, saying why, never dropped', async () => {
    carol2 = daemon('carol-pc', 'u-carol', 'carol@z.io', [{ agentId: 'web', engine: 'claude' }], () => [])
    carol2.service.start()
    expect(await alice2.ask({ action: 'share_invite', sharedTabId: tab, emails: ['carol@z.io'], days: 7 })).toEqual({ invited: ['carol@z.io'], refused: [] })
    const { invites } = await carol2.ask({ action: 'shares' }) as { invites: Array<{ id: string }> }
    expect(await carol2.ask({ action: 'share_accept', inviteId: invites[0].id, ownerPub: b64e(alice2.identity.pub) })).toMatchObject({ sharedTabId: tab })
    desk(alice2)
    await until(async () => expect((await membersOf()).members.map((m) => m.accountId)).toContain('u-carol'))
    expect(await carol2.ask({ action: 'share_add', sharedTabId: tab, harness: { machineId: carol2.id, agentId: 'web', name: 'web', engine: 'claude' } })).toEqual({ queued: true })
    await until(async () => expect((await membersOf()).harnesses.map((h) => `${h.machineId}/${h.agentId}`)).toContain('carol-pc/web'))
    // Her daemon restarts on a build from before shared tabs: none of them runs, and its relay is never dialled again.
    carol2.service.stop()
    carol2.relay.closeAll()
    await until(() => expect(relay2.live.has(`${tab}:${carol2!.id}`)).toBe(false))
    const sent = await alice2.ask({ action: 'send', pane: '%1', to: 'web', text: 'are you there?' }) as { id: string; recipients: Array<Record<string, unknown>> }
    const away = { state: 'queued', reason: 'carol\'s computer is away: handed over once it is back' }
    expect(sent.recipients).toEqual([{ name: 'web', ...away }])
    for (let i = 0; i < 6; i++) await tick(60_000)
    expect(await statusOf(alice2, sent.id)).toMatchObject(away)
    expect(typedOf(carol2, sent.id)).toEqual([])
  })
})
