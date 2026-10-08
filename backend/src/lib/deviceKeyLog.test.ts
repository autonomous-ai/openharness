import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'

type Row = { userId: string; seq: number; hash: string; entry: string; sessionId: string | null }
const m = vi.hoisted(() => ({
  rows: [] as Array<{ userId: string; seq: number; hash: string; entry: string; sessionId: string | null }>,
  failNextCreate: null as unknown,
  snaps: new Map<string, Record<string, unknown> & { userId: string; seq: number; hash: string }>(),
  failSnapshot: null as unknown,
  publishChanged: vi.fn(), publishDown: vi.fn(), revoke: vi.fn(),
  seen: {} as Record<string, Record<string, string>>,
  hsetCalls: 0,
}))
vi.mock('./prisma.js', () => ({
  prisma: {
    deviceKeyLogEntry: {
      findMany: vi.fn(async ({ where }: { where: { userId: string; seq?: { gt: number } } }) =>
        m.rows.filter(r => r.userId === where.userId && r.seq > (where.seq?.gt ?? 0)).sort((a, b) => a.seq - b.seq)),
      findFirst: vi.fn(async ({ where }: { where: { userId: string } }) =>
        m.rows.filter(r => r.userId === where.userId).sort((a, b) => b.seq - a.seq)[0] ?? null),
      create: vi.fn(async ({ data }: { data: Row }) => {
        if (m.failNextCreate) { const err = m.failNextCreate; m.failNextCreate = null; throw err }
        m.rows.push(data); return data
      }),
    },
    deviceKeyLogState: {
      findUnique: vi.fn(async ({ where }: { where: { userId: string } }) => structuredClone(m.snaps.get(where.userId) ?? null)),
      updateMany: vi.fn(async ({ where, data }: { where: { userId: string; seq: number | { lt: number }; hash?: string }; data: Record<string, unknown> }) => {
        if (m.failSnapshot) throw m.failSnapshot
        const cur = m.snaps.get(where.userId)
        const fits = cur && (typeof where.seq === 'number' ? cur.seq === where.seq && cur.hash === where.hash : cur.seq < where.seq.lt)
        if (!fits) return { count: 0 }
        m.snaps.set(where.userId, { ...cur, ...structuredClone(data) } as typeof cur)
        return { count: 1 }
      }),
      create: vi.fn(async ({ data }: { data: { userId: string; seq: number; hash: string } }) => {
        if (m.failSnapshot) throw m.failSnapshot
        if (m.snaps.has(data.userId)) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
        m.snaps.set(data.userId, structuredClone(data)); return data
      }),
    },
    harnessSession: { updateMany: m.revoke },
  },
}))
vi.mock('./bus.js', () => ({
  publishDeviceKeysChanged: m.publishChanged,
  publishDown: m.publishDown,
  pub: {
    multi: () => {
      const ops: Array<() => void> = []
      const chain = {
        hset: (key: string, field: string, value: string) => { ops.push(() => { m.hsetCalls++; (m.seen[key] ??= {})[field] = value }); return chain },
        hsetnx: (key: string, field: string, value: string) => { ops.push(() => { (m.seen[key] ??= {})[field] ??= value }); return chain },
        expire: () => chain,
        exec: async () => { for (const op of ops) op(); return [] },
      }
      return chain
    },
    hgetall: async (key: string) => m.seen[key] ?? {},
  },
}))
import { appendDeviceKey, deviceKeysSeen, readDeviceKeyLog, touchDeviceKey } from './deviceKeyLog.js'
import { emptyDevLogState, nextDevLogEntry, signDevLogEntry, applyDevLogEntries, DEVLOG_MAX_ACTIVE, type DevLogState } from './deviceLogCore.js'
import { prisma } from './prisma.js'

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const key = (n: number) => { const priv = new Uint8Array(32).fill(n); return { priv, pub: b64(ed25519.getPublicKey(priv)) } }
const box1 = key(1), box2 = key(2), phone = key(3)
const USER = 'user-1'
const MID1 = 'a'.repeat(32), MID2 = 'b'.repeat(32)

async function state(): Promise<DevLogState> {
  const { entries } = await readDeviceKeyLog(USER, 0)
  return applyDevLogEntries(emptyDevLogState(USER), entries).state
}
async function addEntry(k: { priv: Uint8Array; pub: string }, kind: 'machine' | 'viewer', machineId: string, label: string) {
  return signDevLogEntry(nextDevLogEntry(await state(), { op: 'add', pub: k.pub, kind, machineId, label, signer: k.pub }, 1_000), k.priv)
}
async function removeEntry(target: string, by: { priv: Uint8Array; pub: string }) {
  const s = await state()
  const t = s.active[target]
  return signDevLogEntry(nextDevLogEntry(s, { op: 'remove', pub: t.pub, kind: t.kind, machineId: t.machineId, label: t.label, signer: by.pub }, 2_000), by.priv)
}

describe('appendDeviceKey', () => {
  beforeEach(() => {
    m.rows.length = 0
    m.failNextCreate = null
    m.snaps.clear()
    m.failSnapshot = null
    m.seen = {}
    m.hsetCalls = 0
    vi.clearAllMocks()
    m.publishChanged.mockResolvedValue(1)
    m.publishDown.mockResolvedValue(1)
    m.revoke.mockResolvedValue({ count: 1 })
  })

  it('lets a machine add its own key over its socket and pushes the new head', async () => {
    const r = await appendDeviceKey(USER, await addEntry(box1, 'machine', MID1, 'box1'), { kind: 'machine', machineId: MID1 })
    expect(r).toMatchObject({ ok: true, head: { seq: 1 } })
    expect(m.publishChanged).toHaveBeenCalledWith(USER, (r as { head: unknown }).head)
    expect((await readDeviceKeyLog(USER, 0)).entries).toHaveLength(1)
  })

  it('refuses a machine registering a key under another machine id', async () => {
    const r = await appendDeviceKey(USER, await addEntry(box1, 'machine', MID2, 'box2?'), { kind: 'machine', machineId: MID1 })
    expect(r).toMatchObject({ ok: false, status: 403, code: 'WRONG_CHANNEL' })
    expect(m.rows).toHaveLength(0)
  })

  it('refuses a machine entry over the viewer channel', async () => {
    const r = await appendDeviceKey(USER, await addEntry(box1, 'machine', MID1, 'box1'), { kind: 'viewer' })
    expect(r).toMatchObject({ ok: false, status: 403, code: 'WRONG_CHANNEL' })
  })

  it('refuses an entry for another account', async () => {
    const e = await addEntry(phone, 'viewer', '', 'phone')
    const r = await appendDeviceKey('someone-else', e, { kind: 'viewer' })
    expect(r).toMatchObject({ ok: false, status: 400, code: 'WRONG_ACCOUNT' })
  })

  it('answers a stale head with 409 and the current head', async () => {
    const stale = await addEntry(phone, 'viewer', '', 'phone')
    await appendDeviceKey(USER, await addEntry(box1, 'machine', MID1, 'box1'), { kind: 'machine', machineId: MID1 })
    const r = await appendDeviceKey(USER, stale, { kind: 'viewer' })
    expect(r).toMatchObject({ ok: false, status: 409, code: 'STALE_HEAD', head: { seq: 1 } })
  })

  it('answers a lost insert race with 409', async () => {
    m.failNextCreate = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    const r = await appendDeviceKey(USER, await addEntry(phone, 'viewer', '', 'phone'), { kind: 'viewer' })
    expect(r).toMatchObject({ ok: false, status: 409, code: 'STALE_HEAD' })
    expect(m.publishChanged).not.toHaveBeenCalled()
  })

  it('refuses a tampered entry', async () => {
    const e = { ...(await addEntry(phone, 'viewer', '', 'phone')), label: 'evil' }
    expect(await appendDeviceKey(USER, e, { kind: 'viewer' })).toMatchObject({ ok: false, status: 400, code: 'BAD_SIGNATURE' })
  })

  it('signs a removed machine out', async () => {
    await appendDeviceKey(USER, await addEntry(box1, 'machine', MID1, 'box1'), { kind: 'machine', machineId: MID1 })
    await appendDeviceKey(USER, await addEntry(box2, 'machine', MID2, 'box2'), { kind: 'machine', machineId: MID2 })
    const r = await appendDeviceKey(USER, await removeEntry(box2.pub, box1), { kind: 'machine', machineId: MID1 })
    expect(r).toMatchObject({ ok: true, head: { seq: 3 } })
    expect(m.publishDown).toHaveBeenCalledWith(MID2, { connId: '', frame: { type: 'machine_revoked', payload: { reason: 'device_removed', pub: box2.pub } } })
  })

  it('ends the Harness session of a removed computer that a phone signed in by QR', async () => {
    await appendDeviceKey(USER, await addEntry(box1, 'machine', MID1, 'box1'), { kind: 'machine', machineId: MID1 })
    await appendDeviceKey(USER, await addEntry(box2, 'machine', MID2, 'box2'), { kind: 'machine', machineId: MID2, harnessSessionId: 'sess-qr' })
    await appendDeviceKey(USER, await removeEntry(box2.pub, box1), { kind: 'machine', machineId: MID1 })
    expect(m.publishDown).toHaveBeenCalledWith(MID2, expect.objectContaining({ frame: expect.objectContaining({ type: 'machine_revoked' }) }))
    expect(m.revoke).toHaveBeenCalledWith({ where: { id: 'sess-qr', userId: USER, OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] }, data: { revokedAt: expect.any(Date) } })
  })

  it('refuses a machine signing a removal with another machine key', async () => {
    await appendDeviceKey(USER, await addEntry(box1, 'machine', MID1, 'box1'), { kind: 'machine', machineId: MID1 })
    await appendDeviceKey(USER, await addEntry(box2, 'machine', MID2, 'box2'), { kind: 'machine', machineId: MID2 })
    const r = await appendDeviceKey(USER, await removeEntry(box2.pub, box1), { kind: 'machine', machineId: MID2 })
    expect(r).toMatchObject({ ok: false, status: 403, code: 'WRONG_CHANNEL' })
  })

  it('ends the Harness session of a removed phone', async () => {
    await appendDeviceKey(USER, await addEntry(phone, 'viewer', '', 'phone'), { kind: 'viewer', harnessSessionId: 'sess-1' })
    await appendDeviceKey(USER, await addEntry(box1, 'machine', MID1, 'box1'), { kind: 'machine', machineId: MID1 })
    await appendDeviceKey(USER, await removeEntry(phone.pub, box1), { kind: 'machine', machineId: MID1 })
    expect(m.revoke).toHaveBeenCalledWith({ where: { id: 'sess-1', userId: USER, OR: [{ revokedAt: null }, { revokedAt: { isSet: false } }] }, data: { revokedAt: expect.any(Date) } })
    expect(m.publishDown).not.toHaveBeenCalled()
  })

  const findMany = vi.mocked(prisma.deviceKeyLogEntry.findMany)
  const findFirst = vi.mocked(prisma.deviceKeyLogEntry.findFirst)
  const box1Joins = async () => appendDeviceKey(USER, await addEntry(box1, 'machine', MID1, 'box1'), { kind: 'machine', machineId: MID1 })
  const phoneJoins = async () => appendDeviceKey(USER, await addEntry(phone, 'viewer', '', 'phone'), { kind: 'viewer', harnessSessionId: 'sess-1' })
  /** Appends box2, counting only the reads the append itself makes. */
  async function box2Joins() {
    const e = await addEntry(box2, 'machine', MID2, 'box2')
    findMany.mockClear(); findFirst.mockClear()
    return appendDeviceKey(USER, e, { kind: 'machine', machineId: MID2 })
  }

  it('appends on top of a snapshot that matches the head, without reading the log', async () => {
    await box1Joins(); await phoneJoins()
    expect(m.snaps.get(USER)).toMatchObject({ seq: 2, sessions: { [phone.pub]: 'sess-1' } })
    expect(await box2Joins()).toMatchObject({ ok: true, head: { seq: 3 } })
    expect(findMany).not.toHaveBeenCalled()
    expect(m.snaps.get(USER)).toMatchObject({ seq: 3, hash: m.rows[2].hash })
    expect(Object.keys(m.snaps.get(USER)!.active as object)).toHaveLength(3)
  })

  it('verifies only what came after a stale snapshot', async () => {
    await box1Joins()
    m.failSnapshot = new Error('mongo down')
    await phoneJoins()
    m.failSnapshot = null
    expect(m.snaps.get(USER)).toMatchObject({ seq: 1 })
    expect(await box2Joins()).toMatchObject({ ok: true, head: { seq: 3 } })
    expect(findMany).toHaveBeenCalledTimes(1)
    expect(findMany.mock.calls[0][0]).toMatchObject({ where: { userId: USER, seq: { gt: 1 } } })
    expect(m.snaps.get(USER)).toMatchObject({ seq: 3, sessions: { [phone.pub]: 'sess-1' } })
  })

  it('replays the whole log once when there is no snapshot, and keeps one', async () => {
    await box1Joins(); await phoneJoins()
    m.snaps.clear()
    expect(await box2Joins()).toMatchObject({ ok: true, head: { seq: 3 } })
    expect(findMany.mock.calls.map(c => c[0]!.where)).toEqual([{ userId: USER }])
    expect(m.snaps.get(USER)).toMatchObject({ seq: 3, hash: m.rows[2].hash, sessions: { [phone.pub]: 'sess-1' } })
  })

  it.each([
    ['an older snapshot off the chain', { seq: 1, hash: Buffer.alloc(32, 9).toString('base64') }],
    ['a snapshot past the head', { seq: 9 }],
    ['a snapshot with another hash at the head', { hash: Buffer.alloc(32, 9).toString('base64') }],
  ])('replays the whole log over %s', async (_, bad) => {
    await box1Joins(); await phoneJoins()
    m.snaps.set(USER, { ...m.snaps.get(USER)!, ...bad })
    expect(await box2Joins()).toMatchObject({ ok: true, head: { seq: 3 } })
    expect(findMany.mock.calls.some(c => c[0]!.where?.seq === undefined)).toBe(true)
    expect(m.snaps.get(USER)).toMatchObject({ seq: 3, hash: m.rows[2].hash })
  })

  it('still appends when the snapshot cannot be saved', async () => {
    m.failSnapshot = new Error('mongo down')
    expect(await box1Joins()).toMatchObject({ ok: true, head: { seq: 1 } })
    expect(m.rows).toHaveLength(1)
    expect(m.snaps.size).toBe(0)
    expect(m.publishChanged).toHaveBeenCalled()
  })

  it('answers a lost race with the head alone, not the whole log again', async () => {
    await box1Joins()
    const e = await addEntry(phone, 'viewer', '', 'phone')
    findMany.mockClear(); findFirst.mockClear()
    m.failNextCreate = Object.assign(new Error('Unique constraint failed'), { code: 'P2002' })
    expect(await appendDeviceKey(USER, e, { kind: 'viewer' })).toMatchObject({ ok: false, status: 409, code: 'STALE_HEAD', head: { seq: 1, hash: m.rows[0].hash } })
    expect(findMany).not.toHaveBeenCalled()
    expect(findFirst).toHaveBeenCalledTimes(2)
  })

  it('signs out the session the snapshot remembers for a removed phone', async () => {
    await phoneJoins(); await box1Joins()
    const e = await removeEntry(phone.pub, box1)
    findMany.mockClear()
    await appendDeviceKey(USER, e, { kind: 'machine', machineId: MID1 })
    expect(findMany).not.toHaveBeenCalled()
    expect(m.revoke).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ id: 'sess-1' }) }))
    expect(m.snaps.get(USER)).toMatchObject({ seq: 3, sessions: {}, removed: [phone.pub] })
  })

  it('refuses a key past the most an account may have active', async () => {
    let s = emptyDevLogState(USER)
    const viewer = (i: number) => { const priv = new Uint8Array(32).fill(0x5a); priv[0] = i & 0xff; priv[1] = i >> 8; return { priv, pub: b64(ed25519.getPublicKey(priv)) } }
    for (let i = 0; i < DEVLOG_MAX_ACTIVE; i++) {
      const k = viewer(i)
      const e = signDevLogEntry(nextDevLogEntry(s, { op: 'add', pub: k.pub, kind: 'viewer', machineId: '', label: `v${i}`, signer: k.pub }, 1_000), k.priv)
      s = applyDevLogEntries(s, [e]).state
      m.rows.push({ userId: USER, seq: e.seq, hash: s.head.hash, entry: JSON.stringify(e), sessionId: null })
    }
    const k = viewer(DEVLOG_MAX_ACTIVE)
    const e = signDevLogEntry(nextDevLogEntry(s, { op: 'add', pub: k.pub, kind: 'viewer', machineId: '', label: 'one too many', signer: k.pub }, 1_000), k.priv)
    expect(await appendDeviceKey(USER, e, { kind: 'viewer' })).toMatchObject({ ok: false, status: 400, code: 'TOO_MANY' })
    expect(m.rows).toHaveLength(DEVLOG_MAX_ACTIVE)
    // The replay that found the log full kept a snapshot, so the next try does not verify it all again.
    expect(m.snaps.get(USER)).toMatchObject({ seq: DEVLOG_MAX_ACTIVE })
    findMany.mockClear()
    expect(await appendDeviceKey(USER, e, { kind: 'viewer' })).toMatchObject({ ok: false, status: 400, code: 'TOO_MANY' })
    expect(findMany).not.toHaveBeenCalled()
  })

  it('reads from a head, with the head itself', async () => {
    await appendDeviceKey(USER, await addEntry(box1, 'machine', MID1, 'box1'), { kind: 'machine', machineId: MID1 })
    await appendDeviceKey(USER, await addEntry(phone, 'viewer', '', 'phone'), { kind: 'viewer' })
    const page = await readDeviceKeyLog(USER, 1)
    expect(page.acct).toBe(USER)
    expect(page.head.seq).toBe(2)
    expect(page.entries).toHaveLength(1)
    expect((await readDeviceKeyLog('nobody', 0)).head.seq).toBe(0)
  })
})

describe('when a key was last seen', () => {
  beforeEach(() => { m.seen = {}; m.hsetCalls = 0 })

  it('records a key once per hour, and reads it back', async () => {
    const pubKey = key(7).pub
    touchDeviceKey('user-seen', pubKey, 1_000_000)
    touchDeviceKey('user-seen', pubKey, 1_000_000 + 60_000)
    await vi.waitFor(() => expect(m.hsetCalls).toBe(1))
    expect(await deviceKeysSeen('user-seen')).toEqual({ seen: { [pubKey]: 1_000_000 }, since: 1_000_000 })
    touchDeviceKey('user-seen', pubKey, 1_000_000 + 2 * 60 * 60 * 1000)
    await vi.waitFor(() => expect(m.hsetCalls).toBe(2))
  })

  it('keeps when the record began, which a later key does not move', async () => {
    touchDeviceKey('user-since', key(7).pub, 5_000)
    touchDeviceKey('user-since', key(8).pub, 9_000)
    await vi.waitFor(() => expect(m.hsetCalls).toBe(2))
    expect(await deviceKeysSeen('user-since')).toEqual({ seen: { [key(7).pub]: 5_000, [key(8).pub]: 9_000 }, since: 5_000 })
  })

  it('ignores anything that is not a key, and has no beginning when nothing was recorded', async () => {
    touchDeviceKey('user-seen-2', 'not a key')
    touchDeviceKey('user-seen-2', undefined)
    expect(await deviceKeysSeen('user-seen-2')).toEqual({ seen: {}, since: null })
    m.seen['devkeys:seen:user-seen-3'] = { _since: 'x', junk: '5' }
    expect(await deviceKeysSeen('user-seen-3')).toEqual({ seen: {}, since: null })
  })
})
