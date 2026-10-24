import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ADAPTER_DATA_DIR must be set before config/env.js loads (see manager.test.ts). Every store here is
// in memory anyway — several "machines" share this one process.
type Frame = Record<string, unknown>
let C: typeof import('./core.js')
let G: typeof import('./trustGroup.js')
let S: typeof import('./groupSyncer.js')

beforeAll(async () => {
  process.env.ADAPTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'e2ee-groupsync-'))
  C = await import('./core.js')
  G = await import('./trustGroup.js')
  S = await import('./groupSyncer.js')
})

afterEach(() => { vi.useRealTimers() })

interface Pin { machineId: string; pub: string; label: string; linkedAt: number; shared?: true }
class MemPeers {
  pins = new Map<string, Pin>()
  get(id: string): Pin | null { return this.pins.get(id) ?? null }
  pin(machineId: string, pub: string, label: string, at = 1, shared = false): void {
    this.pins.set(machineId, { machineId, pub, label, linkedAt: at, ...(shared ? { shared: true as const } : {}) })
  }
  unlink(id: string): boolean { return this.pins.delete(id) }
  list(): Array<Pin & { fingerprint: string }> { return [...this.pins.values()].map((p) => ({ ...p, fingerprint: 'fp' })) }
}

interface Node {
  name: string
  pub: string
  machineId: string | null
  peers: MemPeers
  trusted: Map<string, { kind?: string; machineId?: string; shared?: boolean }>
  syncer: InstanceType<typeof S.GroupSyncer>
  online: boolean
  /** What `ready` answers: the device key log is this sign-in's. */
  ready: boolean
  droppedSessions: string[]
  /** What this machine's copy of the account's machine list says each machine is; `kindOf` for any it does not name. */
  kinds: Map<string, 'team' | 'computer' | null>
  kindOf: 'team' | 'computer' | null
  /** No team machine ever on this computer (machineKinds.ts teamFree): the trust group as before team machines. */
  teamFree: boolean
  /** How often the list was read again. */
  reads: number
}

/** A small fleet whose "relay" is a direct call: a request reaches the target only if the caller pinned
 *  it and the target trusts the caller — exactly what the real hello/welcome would allow. */
function fleet(): { add: (name: string, machine?: boolean) => Node; link: (joiner: Node, target: Node) => void; nodes: Node[] } {
  const nodes: Node[] = []
  let clock = 1_000
  const add = (name: string, machine = true): Node => {
    const memStore = new (class extends G.TrustGroupStore {
      roster: import('./trustGroup.js').Roster = { members: [], removed: [] }
      override read() { return JSON.parse(JSON.stringify(this.roster)) }
      override write(r: import('./trustGroup.js').Roster) { this.roster = JSON.parse(JSON.stringify(r)) }
      held = new Set<string>()
      override blocked() { return new Set(this.held) }
      override block(pub: string) { this.held.add(pub) }
      override unblock(pub: string) { this.held.delete(pub) }
    })()
    const node = {
      name,
      pub: C.b64e(C.newIdentity().pub),
      machineId: machine ? name.repeat(32).slice(0, 32) : null,
      peers: new MemPeers(),
      trusted: new Map(),
      online: true,
      ready: true,
      droppedSessions: [],
      kinds: new Map(),
      kindOf: 'computer',
      teamFree: false,
      reads: 0,
    } as unknown as Node
    node.syncer = new S.GroupSyncer({
      store: memStore,
      peers: node.peers as unknown as import('./machinePeers.js').MachinePeerStore,
      self: () => ({ pub: node.pub, kind: machine ? 'machine' : 'viewer', label: name, at: S.SELF_STAMP, ...(node.machineId ? { machineId: node.machineId } : {}) }),
      trust: (p) => { node.trusted.set(p.pub, { kind: p.kind, machineId: p.machineId }) },
      untrust: (p) => { node.trusted.delete(p) },
      paired: () => [...node.trusted].map(([identityPub, t]) => ({ identityPub, label: 'x', pairedAt: 1, role: 'web' as const, ...(t.kind ? { kind: t.kind as 'machine' } : {}), ...(t.machineId ? { machineId: t.machineId } : {}), ...(t.shared ? { shared: true as const } : {}) })),
      shared: (pub) => node.trusted.get(pub)?.shared === true,
      machineKinds: {
        kind: (machineId) => node.kinds.has(machineId) ? node.kinds.get(machineId)! : node.kindOf,
        fresh: async () => { node.reads++ },
        teamFree: () => node.teamFree,
      },
      request: async (machineId, frame: Frame) => {
        const target = nodes.find((n) => n.machineId === machineId)
        if (!target?.online) return null
        const pin = node.peers.get(machineId)
        if (!pin || pin.pub !== target.pub) return null
        // What remoteRelay.ts does when the machine answers e2e_denied: the pin goes.
        if (!target.trusted.has(node.pub)) { node.peers.unlink(machineId); return null }
        return { type: 'group_sync_result', payload: target.syncer.handle(node.pub, frame.payload as Record<string, unknown>) }
      },
      dropSessions: (machineId) => { node.droppedSessions.push(machineId) },
      ready: () => node.ready,
      now: () => ++clock,
    })
    nodes.push(node)
    return node
  }
  /** What a password link does on both ends (manager.ts round 4/5 + cli.ts completeLink). */
  const link = (joiner: Node, target: Node): void => {
    target.trusted.set(joiner.pub, { kind: joiner.machineId ? 'machine' : 'viewer', machineId: joiner.machineId ?? undefined })
    if (joiner.machineId) target.peers.pin(joiner.machineId, joiner.pub, joiner.name)
    target.syncer.linked({ pub: joiner.pub, kind: joiner.machineId ? 'machine' : 'viewer', label: joiner.name, ...(joiner.machineId ? { machineId: joiner.machineId } : {}) })
    joiner.peers.pin(target.machineId!, target.pub, target.name)
    if (joiner.machineId) {
      joiner.trusted.set(target.pub, { kind: 'machine', machineId: target.machineId! })
      joiner.syncer.linked({ pub: target.pub, kind: 'machine', label: target.name, machineId: target.machineId! })
    }
  }
  return { add, link, nodes }
}

describe('GroupSyncer', () => {
  it('never makes a machine shared across accounts part of the group, either way', async () => {
    vi.useFakeTimers()
    const f = fleet()
    // Dee's two machines, linked; Kim's machine and phone, another account.
    const [dee, dee2, kim] = [f.add('d'), f.add('e'), f.add('k')]
    const kimPhone = f.add('p', false)
    f.link(dee, dee2)
    f.link(kimPhone, kim)
    await dee.syncer.syncAll()
    await kim.syncer.syncAll()
    // Dee shares her machine with Kim (gateway/sharedTrust.ts): Kim pins it, it trusts Kim's machine.
    kim.peers.pin(dee.machineId!, dee.pub, 'Dee’s machine', 1, true)
    dee.trusted.set(kim.pub, { kind: 'machine', machineId: kim.machineId!, shared: true })

    // Kim's rounds never dial it, and an exchange with it is refused before anything is sent.
    expect(await kim.syncer.syncWith(dee.machineId!)).toBe(false)
    await kim.syncer.syncAll()
    // A group_sync from Kim's machine is refused by Dee's.
    expect(dee.syncer.handle(kim.pub, { self: { pub: kim.pub, kind: 'machine', label: 'k', machineId: kim.machineId, at: S.SELF_STAMP },
      members: [{ pub: kimPhone.pub, kind: 'viewer', label: 'p', at: 5 }], removed: [] })).toEqual({ error: 'SHARED' })
    await dee.syncer.syncAll()

    expect(dee.trusted.has(kimPhone.pub)).toBe(false)
    expect(dee2.trusted.has(kim.pub)).toBe(false)
    expect(kim.trusted.has(dee.pub)).toBe(false)
    expect(kim.trusted.has(dee2.pub)).toBe(false)
    expect(dee.syncer.roster().members.map((m) => m.pub)).not.toContain(kim.pub)
    expect(kim.syncer.roster().members.map((m) => m.pub)).not.toContain(dee.pub)
    // Nor is either seeded from the other as the daemon starts again.
    kim.syncer.start(); dee.syncer.start()
    expect(kim.syncer.roster().members.map((m) => m.pub)).not.toContain(dee.pub)
    expect(dee.syncer.roster().members.map((m) => m.pub)).not.toContain(kim.pub)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('never swaps rosters with one of the account\'s team machines, either way, and keeps it reachable', async () => {
    vi.useFakeTimers()
    const f = fleet()
    // Dee's two machines and her Mac's Harness Team account, all on her account and linked to each other.
    const [dee, dee2, team] = [f.add('d'), f.add('e'), f.add('t')]
    f.link(dee, dee2)
    f.link(dee, team)
    f.link(dee2, team)
    for (const n of [dee, dee2]) n.kinds.set(team.machineId!, 'team')
    // The team daemon cannot read the account's machine list (a team session may not): it places nobody.
    team.kindOf = null
    // A hostile team daemon holds a key of its own choosing, and a removal of Dee's other machine.
    const planted = { pub: C.b64e(C.newIdentity().pub), kind: 'viewer', label: 'planted', at: 5_000 }
    team.syncer.linked({ pub: planted.pub, kind: 'viewer', label: 'planted' })
    const handle = vi.spyOn(team.syncer, 'handle')

    // Dee's rounds never dial it, and an exchange with it is refused before anything is sent.
    await dee.syncer.syncAll()
    expect(dee.reads).toBeGreaterThan(0)
    expect(await dee.syncer.syncWith(team.machineId!)).toBe(false)
    expect(handle).not.toHaveBeenCalled()
    // A group_sync from it is refused, whether it describes itself as the machine it is or as an app.
    const asItself = { self: { pub: team.pub, kind: 'machine', label: 't', machineId: team.machineId, at: S.SELF_STAMP },
      members: [planted], removed: [{ pub: dee2.pub, at: 9_000_000 }] }
    expect(dee.syncer.handle(team.pub, asItself)).toEqual({ error: 'TEAM_MACHINE' })
    expect(dee.syncer.handle(team.pub, { self: { pub: team.pub, kind: 'viewer', label: 't', at: S.SELF_STAMP }, members: [planted], removed: [] }))
      .toEqual({ error: 'TEAM_MACHINE' })
    expect(dee.syncer.handle(team.pub, { members: [planted], removed: [] })).toEqual({ error: 'TEAM_MACHINE' })
    await dee2.syncer.syncAll()

    // Nothing it holds reached Dee's machines; nothing of theirs was dropped; it is still pinned and trusted.
    for (const n of [dee, dee2]) {
      expect(n.trusted.has(planted.pub)).toBe(false)
      expect(n.syncer.roster().members.map((m) => m.pub)).not.toContain(planted.pub)
      expect(n.peers.get(team.machineId!)?.pub).toBe(team.pub)
      expect(n.trusted.has(team.pub)).toBe(true)
    }
    expect(dee.trusted.has(dee2.pub)).toBe(true)
    expect(dee.peers.get(dee2.machineId!)?.pub).toBe(dee2.pub)
    // Dee's own machines still swap rosters with each other.
    expect(await dee.syncer.syncWith(dee2.machineId!)).toBe(true)
    // And the team daemon, which places nobody, sends its roster to none of them.
    expect(await team.syncer.syncWith(dee.machineId!)).toBe(false)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('fails closed when the account\'s machine list cannot say what a machine is, and takes a phone as before', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    const phone = f.add('p', false)
    f.link(a, b)
    f.link(phone, a)
    a.kindOf = null
    b.kindOf = null
    const handle = vi.spyOn(b.syncer, 'handle')
    expect(await a.syncer.syncWith(b.machineId!)).toBe(false)
    await a.syncer.syncAll()
    expect(handle).not.toHaveBeenCalled()
    const self = { pub: a.pub, kind: 'machine', label: 'a', machineId: a.machineId, at: S.SELF_STAMP }
    expect(b.syncer.handle(a.pub, { self, members: [], removed: [] })).toEqual({ error: 'MACHINE_UNKNOWN' })
    // A machine key with no machine id anywhere is not taken for an app.
    const stray = C.b64e(C.newIdentity().pub)
    expect(b.syncer.handle(stray, { self: { pub: stray, kind: 'machine', label: 's', at: S.SELF_STAMP }, members: [], removed: [] }))
      .toEqual({ error: 'MACHINE_UNKNOWN' })
    // A phone is no machine: its roster is merged and it is answered, list or not.
    const reply = a.syncer.handle(phone.pub, { self: { pub: phone.pub, kind: 'viewer', label: 'p', at: S.SELF_STAMP }, members: [], removed: [] })
    expect(reply.error).toBeUndefined()
    expect((reply.members as Array<{ pub: string }>).map((m) => m.pub)).toContain(b.pub)
    // Once the list says both are the person's own, they swap again.
    a.kindOf = 'computer'
    b.kindOf = 'computer'
    expect(await a.syncer.syncWith(b.machineId!)).toBe(true)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('syncs as before team machines on a computer that never had one, whatever the list says or fails to say', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    f.link(a, b)
    // A regular user: no list read yet, a stale one, or a new machine not on it.
    for (const n of [a, b]) { n.kindOf = null; n.teamFree = true }
    const handle = vi.spyOn(b.syncer, 'handle')
    expect(await a.syncer.syncWith(b.machineId!)).toBe(true)
    expect(handle).toHaveBeenCalled()
    const self = { pub: a.pub, kind: 'machine', label: 'a', machineId: a.machineId, at: S.SELF_STAMP }
    expect(b.syncer.handle(a.pub, { self, members: [], removed: [] }).error).toBeUndefined()
    const stray = C.b64e(C.newIdentity().pub)
    expect(b.syncer.handle(stray, { self: { pub: stray, kind: 'machine', label: 's', at: S.SELF_STAMP }, members: [], removed: [] }).error).toBeUndefined()
    for (const n of f.nodes) n.syncer.stop()
  })

  it('A links B, A links C ⇒ B and C reach each other both ways, no password', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b, c] = [f.add('a'), f.add('b'), f.add('c')]
    f.link(a, b)
    f.link(a, c)
    await a.syncer.syncAll()

    expect(b.peers.get(c.machineId!)?.pub).toBe(c.pub)
    expect(c.peers.get(b.machineId!)?.pub).toBe(b.pub)
    expect(b.trusted.has(c.pub)).toBe(true)
    expect(c.trusted.has(b.pub)).toBe(true)
    // …and the link made one way already works the other way (B dials A).
    expect(b.peers.get(a.machineId!)?.pub).toBe(a.pub)
    expect(a.trusted.has(b.pub)).toBe(true)
    // B↔C can now exchange directly.
    await b.syncer.syncWith(c.machineId!)
    expect(c.syncer.roster().members.map((m) => m.pub)).toEqual(expect.arrayContaining([a.pub, b.pub]))
    for (const n of f.nodes) n.syncer.stop()
  })

  it('a phone linked to one machine is trusted by every member, and gets every machine key', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b, c] = [f.add('a'), f.add('b'), f.add('c')]
    const phone = f.add('p', false)
    f.link(a, b)
    f.link(a, c)
    f.link(phone, a)
    await a.syncer.syncAll()
    expect(b.trusted.has(phone.pub)).toBe(true)
    expect(c.trusted.has(phone.pub)).toBe(true)
    // The phone pulls the roster from A (what the Dart viewer does after linking).
    const reply = a.syncer.handle(phone.pub, { self: { pub: phone.pub, kind: 'viewer', label: 'p', at: S.SELF_STAMP }, members: [], removed: [] })
    const machines = (reply.members as Array<{ kind: string; machineId?: string }>).filter((m) => m.kind === 'machine').map((m) => m.machineId)
    expect(machines).toEqual(expect.arrayContaining([b.machineId, c.machineId]))
    expect((reply.self as { machineId: string }).machineId).toBe(a.machineId)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('a phone can bring a new machine in: D, linked only by the phone, learns and is learned by the group', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    const d = f.add('d')
    const phone = f.add('p', false)
    f.link(a, b)
    f.link(phone, a)
    await a.syncer.syncAll()
    const roster = a.syncer.handle(phone.pub, { members: [], removed: [] })
    // Phone links D over D's password, then hands D everything it knows (itself included).
    f.link(phone, d)
    const phoneSelf = { pub: phone.pub, kind: 'viewer', label: 'p', at: S.SELF_STAMP }
    const members = [...(roster.members as unknown[]), roster.self, { pub: d.pub, kind: 'machine', machineId: d.machineId, label: 'd', at: 5_000 }]
    d.syncer.handle(phone.pub, { self: phoneSelf, members, removed: [] })
    expect(d.peers.get(a.machineId!)?.pub).toBe(a.pub)
    expect(d.peers.get(b.machineId!)?.pub).toBe(b.pub)
    // …and the phone tells A about D, which pushes it on.
    a.syncer.handle(phone.pub, { self: phoneSelf, members: [{ pub: d.pub, kind: 'machine', machineId: d.machineId, label: 'd', at: 5_000 }], removed: [] })
    await a.syncer.syncAll()
    expect(b.trusted.has(d.pub)).toBe(true)
    expect(b.peers.get(d.machineId!)?.pub).toBe(d.pub)
    await d.syncer.syncWith(b.machineId!)
    expect(b.syncer.roster().members.some((m) => m.pub === d.pub)).toBe(true)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('removing a member on one machine removes it on every member it reaches', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b, c] = [f.add('a'), f.add('b'), f.add('c')]
    f.link(a, b)
    f.link(a, c)
    await a.syncer.syncAll()
    expect(b.syncer.remove(c.pub)).toBe(true)
    expect(b.peers.get(c.machineId!)).toBeNull()
    expect(b.droppedSessions).toEqual([c.machineId]) // a pooled session to C must not outlive the pin
    expect(b.trusted.has(c.pub)).toBe(false)
    await b.syncer.syncAll()
    expect(a.peers.get(c.machineId!)).toBeNull()
    expect(a.trusted.has(c.pub)).toBe(false)
    expect(a.droppedSessions).toEqual([c.machineId])
    // C describing itself cannot bring it back (its self entry is older than any removal).
    await c.syncer.syncWith(a.machineId!) // refused: A no longer trusts C
    a.syncer.handle(c.pub, { self: { pub: c.pub, kind: 'machine', machineId: c.machineId, label: 'c', at: S.SELF_STAMP }, members: [], removed: [] })
    expect(a.trusted.has(c.pub)).toBe(false)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('while the device key log is not this sign-in\'s, no roster is swapped either way', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    f.link(a, b)
    const stranger = { pub: C.b64e(C.newIdentity().pub), kind: 'viewer', label: 'old account', at: 5 }
    b.ready = false
    // Answered with nothing, and nothing taken in.
    const reply = b.syncer.handle(a.pub, { self: { pub: a.pub, kind: 'machine', label: 'a', at: S.SELF_STAMP, machineId: a.machineId }, members: [stranger], removed: [] })
    expect(reply).toEqual({ members: [], removed: [], digest: G.rosterDigest({ members: [], removed: [] }) })
    expect(b.syncer.roster().members.some((m) => m.pub === stranger.pub)).toBe(false)
    // Nor sent: no dial at all.
    b.ready = true
    a.ready = false
    const handle = vi.spyOn(b.syncer, 'handle')
    await a.syncer.syncAll()
    expect(await a.syncer.syncWith(b.machineId!)).toBe(false)
    expect(handle).not.toHaveBeenCalled()
    a.ready = true
    expect(await a.syncer.syncWith(b.machineId!)).toBe(true)
    expect(handle).toHaveBeenCalledTimes(1)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('a peer may describe only itself: a self entry under another key is ignored', () => {
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    const forged = { pub: C.b64e(C.newIdentity().pub), kind: 'machine', machineId: 'f'.repeat(32), label: 'x', at: S.SELF_STAMP }
    a.syncer.handle(b.pub, { self: forged, members: [], removed: [] })
    expect(a.syncer.roster().members).toEqual([])
  })

  it('start() seeds the group from links made before it existed (one-way links become mutual on contact)', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    // An old one-way link: A pinned B; B trusts A but knows nothing else about it.
    a.peers.pin(b.machineId!, b.pub, 'b')
    b.trusted.set(a.pub, {})
    a.syncer.start()
    expect(a.syncer.roster().members.map((m) => m.pub)).toEqual([b.pub])
    await a.syncer.syncWith(b.machineId!)
    expect(b.peers.get(a.machineId!)?.pub).toBe(a.pub) // B can now dial A
    expect(a.trusted.has(b.pub)).toBe(true)             // and A lets B in
    for (const n of f.nodes) n.syncer.stop()
  })

  it('a machine that heard of another before being heard of recovers: the refused dial\'s unpin is undone', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b, c] = [f.add('a'), f.add('b'), f.add('c')]
    f.link(a, b)
    f.link(a, c)
    // A tells B about C, but C has not heard of B yet: B's dial to C is refused.
    await a.syncer.syncWith(b.machineId!)
    await b.syncer.syncWith(c.machineId!)
    b.peers.unlink(c.machineId!) // what remoteRelay.ts does on e2e_denied
    await a.syncer.syncWith(c.machineId!)
    await b.syncer.syncAll()
    expect(b.peers.get(c.machineId!)?.pub).toBe(c.pub)
    expect(c.syncer.roster().members.some((m) => m.pub === b.pub)).toBe(true)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('an unpairing on one machine is not undone by the group, and linking again lifts it', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b, c] = [f.add('a'), f.add('b'), f.add('c')]
    f.link(a, b)
    f.link(a, c)
    await a.syncer.syncAll()
    // `harness unpair <c>` on B: E2eeManager drops the pairing, then tells the group.
    b.trusted.delete(c.pub)
    b.syncer.unpaired(c.pub)
    expect(b.peers.get(c.machineId!)).toBeNull()
    await b.syncer.syncAll()
    await a.syncer.syncAll()
    await b.syncer.syncWith(a.machineId!)
    expect(b.trusted.has(c.pub)).toBe(false)
    expect(b.peers.get(c.machineId!)).toBeNull()
    // Local only: A and C still trust each other.
    expect(a.trusted.has(c.pub)).toBe(true)
    // C links to B again with B's password: trusted again.
    f.link(c, b)
    expect(b.trusted.has(c.pub)).toBe(true)
    await b.syncer.syncAll()
    expect(b.trusted.has(c.pub)).toBe(true)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('two members that heard of each other at different moments converge on their own, soon', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b, c] = [f.add('a'), f.add('b'), f.add('c')]
    f.link(a, b)
    f.link(a, c)
    // A tells B first. B's own push reaches C before A has told C: refused, and B's pin to C goes.
    await a.syncer.syncWith(b.machineId!)
    await b.syncer.syncWith(c.machineId!)
    expect(b.peers.get(c.machineId!)).toBeNull()
    // Now A tells C. Nobody links anything or opens a session after this.
    await a.syncer.syncWith(c.machineId!)
    await vi.advanceTimersByTimeAsync(20_000)
    expect(b.peers.get(c.machineId!)?.pub).toBe(c.pub)
    expect(c.peers.get(b.machineId!)?.pub).toBe(b.pub)
    expect(b.trusted.has(c.pub) && c.trusted.has(b.pub)).toBe(true)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('a member reaching us puts back the pin a refused dial dropped, even when nothing else changed', async () => {
    const f = fleet()
    const [a, b, c] = [f.add('a'), f.add('b'), f.add('c')]
    f.link(a, b)
    f.link(a, c)
    await a.syncer.syncWith(b.machineId!)
    await a.syncer.syncWith(c.machineId!)
    b.peers.unlink(c.machineId!) // B dialed C a moment too early; remoteRelay dropped the pin
    expect(await c.syncer.syncWith(b.machineId!)).toBe(true) // C reaches B; B's roster is unchanged
    expect(b.peers.get(c.machineId!)?.pub).toBe(c.pub)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('a round that missed a member tries again soon, then backs off', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    f.link(a, b)
    await vi.advanceTimersByTimeAsync(0) // the fan-out the link scheduled
    b.online = false
    const handle = vi.spyOn(b.syncer, 'handle')
    await a.syncer.syncAll()
    b.online = true
    await vi.advanceTimersByTimeAsync(14_000)
    expect(handle).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(handle).toHaveBeenCalledTimes(1)
    // It answered: no more retries.
    await vi.advanceTimersByTimeAsync(5 * 60_000)
    expect(handle).toHaveBeenCalledTimes(1)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('sessionOpened() does not re-sync a machine it just synced with', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    f.link(a, b)
    const spy = vi.spyOn(b.syncer, 'handle')
    await a.syncer.syncWith(b.machineId!)
    a.syncer.sessionOpened(b.machineId!)
    await Promise.resolve()
    expect(spy).toHaveBeenCalledTimes(1)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('carries the device key log head both ways, and still works with a peer that has no log', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    f.link(a, b)
    const heardByA = vi.fn(), heardByB = vi.fn(() => ({ head: { seq: 2, hash: 'hb' }, frozen: false }))
    a.syncer.devlog = { gossip: () => ({ head: { seq: 1, hash: 'ha' }, frozen: false }), heard: heardByA }
    b.syncer.devlog = { gossip: () => undefined, heard: heardByB }
    await a.syncer.syncWith(b.machineId!)
    expect(heardByB).toHaveBeenCalledWith(a.pub, { head: { seq: 1, hash: 'ha' }, frozen: false })
    expect(heardByA).toHaveBeenCalledWith(b.pub, { head: { seq: 2, hash: 'hb' }, frozen: false })
    // An older peer: nothing about the log on the wire, and the roster exchange is unchanged.
    a.syncer.devlog = null
    heardByB.mockClear()
    expect(await a.syncer.syncWith(b.machineId!)).toBe(true)
    expect(heardByB).toHaveBeenCalledWith(a.pub, undefined)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('a key the device key log holds joins the group, so a member that predates the log learns it', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    f.link(a, b)
    const phonePub = C.b64e(C.newIdentity().pub)
    a.syncer.adoptFromLog([{ pub: phonePub, kind: 'viewer', machineId: '', label: 'phone', addedAt: 500 }])
    expect(a.trusted.has(phonePub)).toBe(true)
    await a.syncer.syncWith(b.machineId!)
    expect(b.trusted.has(phonePub)).toBe(true)
    // A removal the group made first is not undone by the log.
    a.syncer.remove(phonePub)
    expect(a.syncer.tombstoned(phonePub)).toBe(true)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('a key the roster holds as the log names it, and this machine does not trust, is trusted again', () => {
    vi.useFakeTimers()
    const f = fleet()
    const a = f.add('a')
    const phonePub = C.b64e(C.newIdentity().pub)
    const phone = { pub: phonePub, kind: 'viewer' as const, machineId: '', label: 'phone', addedAt: 500 }
    a.syncer.adoptFromLog([phone])
    // The trust was lost (a crash between the roster and paired.json): the roster still holds the member
    // exactly as the log names it, so a merge has nothing new to say about it.
    a.trusted.delete(phonePub)
    a.syncer.adoptFromLog([phone])
    expect(a.trusted.has(phonePub)).toBe(true)
    // Not a key this machine's user unpaired.
    a.syncer.unpaired(phonePub)
    a.syncer.adoptFromLog([phone])
    expect(a.trusted.has(phonePub)).toBe(false)
    for (const n of f.nodes) n.syncer.stop()
  })
})

describe('GroupSyncer — suspended keys', () => {
  it('never pins, trusts or dials a suspended key; suspend() unlinks it, resume() puts it back', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    f.link(a, b)
    expect(a.peers.get(b.machineId!)).not.toBeNull()
    const suspended = new Set<string>()
    ;(a.syncer as unknown as { deps: { suspended?: () => Set<string> } }).deps.suspended = () => suspended
    suspended.add(b.pub)
    a.syncer.suspend([b.pub])
    expect(a.peers.get(b.machineId!)).toBeNull()
    expect(a.trusted.has(b.pub)).toBe(false)
    expect(a.droppedSessions).toContain(b.machineId)
    a.syncer.resume()
    expect(a.peers.get(b.machineId!)).toBeNull() // still suspended: not re-pinned
    suspended.clear()
    a.syncer.resume()
    expect(a.peers.get(b.machineId!)?.pub).toBe(b.pub)
    expect(a.trusted.has(b.pub)).toBe(true)
    for (const n of f.nodes) n.syncer.stop()
  })

  it('a suspended member is not a syncAll target', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b] = [f.add('a'), f.add('b')]
    f.link(a, b)
    ;(a.syncer as unknown as { deps: { suspended?: () => Set<string> } }).deps.suspended = () => new Set([b.pub])
    const spy = vi.spyOn(a.syncer, 'syncWith')
    await a.syncer.syncAll()
    expect(spy).not.toHaveBeenCalled()
    for (const n of f.nodes) n.syncer.stop()
  })
})

describe('relayRequester', () => {
  it('resolves with the matching _result and detaches; null on timeout', async () => {
    let detached = 0
    let sink: import('../../backendSocket.js').LocalClientSink | null = null
    const pool = {
      acquireIsolated: async (_m: string, _e: string, _sel: Frame, s: import('../../backendSocket.js').LocalClientSink) => {
        sink = s
        return {
          send: async (frame: Frame) => {
            const rid = (frame.payload as Record<string, unknown>).requestId
            setTimeout(() => {
              sink!.sendFrame({ type: 'group_sync_result', payload: { requestId: 'other' } })
              sink!.sendFrame({ type: 'group_sync_result', payload: { requestId: rid, ok: 1 } })
            }, 1)
          },
          sendBinary: async () => {},
          detach: () => { detached++ },
        }
      },
    }
    const request = S.relayRequester(pool, () => 'prod')
    const reply = await request('m', { type: 'group_sync', payload: { requestId: 'r1' } }, 1_000)
    expect(reply?.payload).toEqual({ requestId: 'r1', ok: 1 })
    expect(detached).toBe(1)

    const silent = S.relayRequester({ acquireIsolated: async () => ({ send: async () => {}, sendBinary: async () => {}, detach: () => { detached++ } }) }, () => 'prod')
    expect(await silent('m', { type: 'group_sync', payload: { requestId: 'r2' } }, 20)).toBeNull()
    expect(detached).toBe(2)
  })

  it('a removal that arrives through the group is handed on (so the device key log hears of it)', async () => {
    vi.useFakeTimers()
    const f = fleet()
    const [a, b, c] = [f.add('a'), f.add('b'), f.add('c')]
    f.link(a, b)
    f.link(a, c)
    await a.syncer.syncAll()
    const dropped: string[] = []
    b.syncer.onDropped = (pub) => dropped.push(pub)
    a.syncer.remove(c.pub)
    await a.syncer.syncWith(b.machineId!)
    expect(dropped).toEqual([c.pub])
    for (const n of f.nodes) n.syncer.stop()
  })
})
