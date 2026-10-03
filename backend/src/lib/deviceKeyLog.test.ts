import { beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { ed25519 } from '@noble/curves/ed25519.js'

type Row = { userId: string; seq: number; hash: string; entry: string; sessionId: string | null }
const m = vi.hoisted(() => ({
  rows: [] as Array<{ userId: string; seq: number; hash: string; entry: string; sessionId: string | null }>,
  failNextCreate: null as unknown,
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
        expire: () => chain,
        exec: async () => { for (const op of ops) op(); return [] },
      }
      return chain
    },
    hgetall: async (key: string) => m.seen[key] ?? {},
  },
}))
import { appendDeviceKey, deviceKeysSeen, readDeviceKeyLog, touchDeviceKey } from './deviceKeyLog.js'
import { emptyDevLogState, nextDevLogEntry, signDevLogEntry, applyDevLogEntries, type DevLogState } from './deviceLogCore.js'

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
    expect(await deviceKeysSeen('user-seen')).toEqual({ [pubKey]: 1_000_000 })
    touchDeviceKey('user-seen', pubKey, 1_000_000 + 2 * 60 * 60 * 1000)
    await vi.waitFor(() => expect(m.hsetCalls).toBe(2))
  })

  it('ignores anything that is not a key', async () => {
    touchDeviceKey('user-seen-2', 'not a key')
    touchDeviceKey('user-seen-2', undefined)
    expect(await deviceKeysSeen('user-seen-2')).toEqual({})
  })
})
