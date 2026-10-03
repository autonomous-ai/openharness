import { describe, it, expect, beforeAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// ADAPTER_DATA_DIR must be set before config/env.js loads (see manager.test.ts).
let C: typeof import('./core.js')
let G: typeof import('./trustGroup.js')

beforeAll(async () => {
  process.env.ADAPTER_DATA_DIR = mkdtempSync(join(tmpdir(), 'e2ee-group-'))
  C = await import('./core.js')
  G = await import('./trustGroup.js')
})

beforeEach(() => {
  try { rmSync(join(process.env.ADAPTER_DATA_DIR as string, 'e2e'), { recursive: true, force: true }) } catch { /* none */ }
})

const pub = (): string => C.b64e(C.newIdentity().pub)
const MID_B = 'b'.repeat(32)
const MID_C = 'c'.repeat(32)
const empty = (): import('./trustGroup.js').Roster => ({ members: [], removed: [] })

describe('parseMember / parseRoster', () => {
  it('keeps a well-formed machine and viewer, drops malformed ones', () => {
    const now = 1_000_000
    const good = { pub: pub(), machineId: MID_B, kind: 'machine', label: 'b', at: 10 }
    const viewer = { pub: pub(), kind: 'viewer', label: "Dee's iPhone", at: 11, machineId: MID_C }
    const roster = G.parseRoster({
      members: [
        good,
        viewer,
        { ...good, pub: 'not-a-key' },
        { ...good, machineId: '../etc' },            // a machine without a valid id is refused
        { ...good, kind: 'server' },
        { ...good, at: now + 25 * 60 * 60 * 1000 },  // stamped too far ahead
        { ...good, at: -1 },
        'junk',
      ],
      removed: [{ pub: good.pub, at: 5 }, { pub: 'x', at: 1 }],
    }, now)
    expect(roster.members).toEqual([good, { pub: viewer.pub, kind: 'viewer', label: "Dee's iPhone", at: 11 }])
    expect(roster.removed).toEqual([{ pub: good.pub, at: 5 }])
  })

  it('cleans a label and falls back to the machine id', () => {
    const p = pub()
    expect(G.parseMember({ pub: p, machineId: MID_B, kind: 'machine', label: ' a\u0000b\n ', at: 1 })?.label).toBe('a b')
    expect(G.parseMember({ pub: p, machineId: MID_B, kind: 'machine', at: 1 })?.label).toBe(MID_B)
  })

  it('caps the lists', () => {
    const members = Array.from({ length: G.MAX_MEMBERS + 10 }, (_, i) => ({ pub: pub(), kind: 'viewer', label: 'v', at: i + 1 }))
    expect(G.parseRoster({ members }).members).toHaveLength(G.MAX_MEMBERS)
  })
})

describe('mergeRoster', () => {
  it('takes new members, reporting them as upserted', () => {
    const self = pub()
    const b = { pub: pub(), machineId: MID_B, kind: 'machine' as const, label: 'b', at: 10 }
    const r = G.mergeRoster(empty(), { members: [b], removed: [] }, self)
    expect(r.roster.members).toEqual([b])
    expect(r.upserted).toEqual([b])
    expect(r.dropped).toEqual([])
  })

  it('never takes itself in, and ignores a tombstone for itself', () => {
    const self = pub()
    const r = G.mergeRoster(empty(), { members: [{ pub: self, kind: 'viewer', label: 'me', at: 5 }], removed: [{ pub: self, at: 9 }] }, self)
    expect(r.roster).toEqual(empty())
  })

  it('the newer entry for a key wins; an equal or older one changes nothing', () => {
    const self = pub()
    const k = pub()
    const old = { pub: k, machineId: MID_B, kind: 'machine' as const, label: 'old', at: 10 }
    const renamed = { ...old, label: 'new', at: 20 }
    const r1 = G.mergeRoster({ members: [old], removed: [] }, { members: [renamed], removed: [] }, self)
    expect(r1.roster.members).toEqual([renamed])
    expect(r1.upserted).toEqual([renamed])
    const r2 = G.mergeRoster({ members: [renamed], removed: [] }, { members: [old], removed: [] }, self)
    expect(r2.roster.members).toEqual([renamed])
    expect(r2.upserted).toEqual([])
  })

  it('a tombstone beats every entry it is not older than, and reports what it dropped', () => {
    const self = pub()
    const b = { pub: pub(), machineId: MID_B, kind: 'machine' as const, label: 'b', at: 10 }
    const r = G.mergeRoster({ members: [b], removed: [] }, { members: [], removed: [{ pub: b.pub, at: 10 }] }, self)
    expect(r.roster.members).toEqual([])
    expect(r.roster.removed).toEqual([{ pub: b.pub, at: 10 }])
    expect(r.dropped).toEqual([b])
    // …and an incoming stale copy of the removed member stays out.
    const again = G.mergeRoster(r.roster, { members: [b], removed: [] }, self)
    expect(again.roster.members).toEqual([])
    expect(again.upserted).toEqual([])
  })

  it('linking again stamps a newer entry, which beats the tombstone', () => {
    const self = pub()
    const k = pub()
    const removed = { members: [], removed: [{ pub: k, at: 10 }] }
    const relinked = { pub: k, machineId: MID_B, kind: 'machine' as const, label: 'b', at: 11 }
    const r = G.mergeRoster(removed, { members: [relinked], removed: [] }, self)
    expect(r.roster.members).toEqual([relinked])
    expect(r.upserted).toEqual([relinked])
  })

  it('two separate groups become one', () => {
    const self = pub()
    const a = { pub: pub(), machineId: 'a'.repeat(32), kind: 'machine' as const, label: 'a', at: 1 }
    const b = { pub: pub(), machineId: MID_B, kind: 'machine' as const, label: 'b', at: 2 }
    const c = { pub: pub(), machineId: MID_C, kind: 'machine' as const, label: 'c', at: 3 }
    const phone = { pub: pub(), kind: 'viewer' as const, label: 'phone', at: 4 }
    const r = G.mergeRoster({ members: [a, b], removed: [] }, { members: [c, phone], removed: [] }, self)
    expect(new Set(r.roster.members.map((m) => m.pub))).toEqual(new Set([a.pub, b.pub, c.pub, phone.pub]))
  })

  it('the digest ignores order and tracks content', () => {
    const a = { pub: pub(), kind: 'viewer' as const, label: 'a', at: 1 }
    const b = { pub: pub(), kind: 'viewer' as const, label: 'b', at: 2 }
    expect(G.rosterDigest({ members: [a, b], removed: [] })).toBe(G.rosterDigest({ members: [b, a], removed: [] }))
    expect(G.rosterDigest({ members: [a], removed: [] })).not.toBe(G.rosterDigest({ members: [a, b], removed: [] }))
  })
})

describe('TrustGroupStore', () => {
  it('persists 0600, uncached, and remove() stamps past the current entry', () => {
    const self = pub()
    const store = new G.TrustGroupStore()
    const b = { pub: pub(), machineId: MID_B, kind: 'machine' as const, label: 'b', at: 5_000 }
    store.add(b, self)
    expect(new G.TrustGroupStore().read().members).toEqual([b])
    const file = join(process.env.ADAPTER_DATA_DIR as string, 'e2e', 'group.json')
    expect(statSync(file).mode & 0o777).toBe(0o600)
    // A clock behind the entry's stamp must still remove it.
    const r = store.remove(b.pub, self, 1_000)
    expect(r.dropped).toEqual([b])
    expect(store.read().removed).toEqual([{ pub: b.pub, at: 5_001 }])
    expect(store.list()).toEqual([])
  })
})

describe('group_sync on the wire', () => {
  it('is always sealed, both ways — the roster carries keys', async () => {
    const F = await import('./applicationFrames.js')
    expect(F.encryptDownFrame('group_sync')).toBe(true)
    expect(F.encryptRpcResult('group_sync_result')).toBe(true)
  })
})
