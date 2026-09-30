import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { ed25519 } from '@noble/curves/ed25519'
import {
  applyDevLogEntries, DevLogError, emptyDevLogState, nextDevLogEntry, signDevLogEntry,
  type DevLogEntry, type DevLogState,
} from './deviceLog.js'
import { DeviceLogStore } from './deviceLogStore.js'
import { DeviceLogSyncer, type DeviceLogAppendAnswer, type DeviceLogFetched } from './deviceLogSyncer.js'

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const key = (n: number) => { const priv = new Uint8Array(32).fill(n); return { priv, pub: b64(ed25519.getPublicKey(priv)) } }
const ACCT = 'acct-1'
const me = key(1), box2 = key(2), phone = key(3), evil = key(9)
const MID_ME = 'a'.repeat(32), MID2 = 'b'.repeat(32)

/** The backend's side: holds the log, refuses what breaks a rule, can be told to lie. */
class FakeBackend {
  entries: DevLogEntry[] = []
  state: DevLogState = emptyDevLogState(ACCT)
  /** When set, what `fetch` serves instead of the real log. */
  lie: DevLogEntry[] | null = null
  offline = false

  add(k: { priv: Uint8Array; pub: string }, kind: 'machine' | 'viewer', machineId: string, label: string, at = 1_000): DevLogEntry {
    const e = signDevLogEntry(nextDevLogEntry(this.state, { op: 'add', pub: k.pub, kind, machineId, label, signer: k.pub }, at), k.priv)
    this.push(e)
    return e
  }

  removeBy(target: string, by: { priv: Uint8Array; pub: string }): DevLogEntry {
    const t = this.state.active[target]
    const e = signDevLogEntry(nextDevLogEntry(this.state, { op: 'remove', pub: t.pub, kind: t.kind, machineId: t.machineId, label: t.label, signer: by.pub }, 2_000), by.priv)
    this.push(e)
    return e
  }

  private push(e: DevLogEntry): void {
    this.state = applyDevLogEntries(this.state, [e]).state
    this.entries.push(e)
  }

  fetch = vi.fn(async (since: number): Promise<DeviceLogFetched | null> => {
    if (this.offline) return null
    const log = this.lie ?? this.entries
    const head = log.length ? applyDevLogEntries(emptyDevLogState(ACCT), log).state.head : emptyDevLogState(ACCT).head
    return { acct: ACCT, head, entries: log.filter((e) => e.seq > since) }
  })

  append = vi.fn(async (entry: DevLogEntry): Promise<DeviceLogAppendAnswer | null> => {
    if (this.offline) return null
    if (entry.seq !== this.state.head.seq + 1 || entry.prev !== this.state.head.hash) return { error: 'STALE_HEAD', head: this.state.head }
    try { this.push(entry) } catch (err) { return { error: err instanceof DevLogError ? err.code : 'X' } }
    return { head: this.state.head }
  })
}

function setup(opts: { known?: string[]; tombstoned?: string[]; blocked?: string[] } = {}) {
  const backend = new FakeBackend()
  const store = new DeviceLogStore(join(mkdtempSync(join(tmpdir(), 'devlog-')), 'devlog.json'))
  const calls = {
    adopt: vi.fn(), drop: vi.fn(), announce: vi.fn(), signedOut: vi.fn(), changed: vi.fn(),
  }
  const tombstoned = new Set(opts.tombstoned ?? [])
  const syncer = new DeviceLogSyncer({
    store,
    identity: () => me,
    self: () => ({ machineId: MID_ME, label: 'my-mac' }),
    fetch: backend.fetch,
    append: backend.append,
    adopt: calls.adopt,
    drop: (pub) => { tombstoned.delete(pub); calls.drop(pub) },
    knownBefore: (pub) => (opts.known ?? []).includes(pub),
    tombstoned: (pub) => tombstoned.has(pub),
    blocked: (pub) => (opts.blocked ?? []).includes(pub),
    announce: calls.announce,
    signedOut: calls.signedOut,
    changed: calls.changed,
    now: () => 5_000,
    sleep: async () => {},
  })
  return { backend, store, syncer, calls }
}

describe('DeviceLogSyncer', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => { t = setup() })

  it('registers this machine into an empty log, without announcing anything', async () => {
    await t.syncer.register()
    expect(t.backend.state.active[me.pub]).toMatchObject({ kind: 'machine', machineId: MID_ME, label: 'my-mac' })
    expect(t.store.read().state?.head).toEqual(t.backend.state.head)
    expect(t.calls.announce).not.toHaveBeenCalled()
  })

  it('does not register twice', async () => {
    await t.syncer.register()
    await t.syncer.register()
    expect(t.backend.entries).toHaveLength(1)
  })

  it('on first read of an existing log trusts every device but announces none (an old sign-in joining)', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.register()
    expect(t.calls.adopt).toHaveBeenCalledWith(expect.arrayContaining([
      expect.objectContaining({ pub: box2.pub }), expect.objectContaining({ pub: phone.pub }),
    ]))
    expect(t.calls.announce).not.toHaveBeenCalled()
  })

  it('announces a device it never trusted, once, and trusts it', async () => {
    await t.syncer.register()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
    await t.syncer.refresh()
    expect(t.calls.adopt).toHaveBeenLastCalledWith([expect.objectContaining({ pub: box2.pub, machineId: MID2 })])
    expect(t.calls.announce).toHaveBeenCalledOnce()
    expect(t.calls.announce).toHaveBeenCalledWith(expect.objectContaining({ pub: box2.pub, label: 'box2' }))
  })

  it('does not announce a device this machine already trusted before the log', async () => {
    t = setup({ known: [box2.pub] })
    await t.syncer.register()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
    expect(t.calls.adopt).toHaveBeenCalled()
    expect(t.calls.announce).not.toHaveBeenCalled()
  })

  it('forgets a removed device', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    t.backend.removeBy(box2.pub, me)
    await t.syncer.refresh()
    expect(t.calls.drop).toHaveBeenCalledWith(box2.pub)
  })

  it('signs out when its own key is removed', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    t.backend.removeBy(me.pub, box2)
    await t.syncer.refresh()
    expect(t.calls.signedOut).toHaveBeenCalled()
  })

  it('removes a device with an entry it signs, and drops it at once', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    expect(await t.syncer.remove(box2.pub)).toEqual({ ok: true })
    expect(t.backend.state.active[box2.pub]).toBeUndefined()
    expect(t.backend.entries.at(-1)).toMatchObject({ op: 'remove', pub: box2.pub, signer: me.pub })
    expect(t.calls.drop).toHaveBeenCalledWith(box2.pub)
  })

  it('two removals of one key at once append one entry', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    const [a, b] = await Promise.all([t.syncer.remove(box2.pub), t.syncer.remove(box2.pub)])
    expect(a).toEqual({ ok: true })
    expect(b).toEqual({ ok: true })
    expect(t.backend.entries.filter((e) => e.op === 'remove')).toHaveLength(1)
  })

  it('retries an append that lost the race to another device', async () => {
    await t.syncer.refresh()
    // Another device appends between this machine's read and its append.
    const original = t.backend.append.getMockImplementation()!
    t.backend.append.mockImplementationOnce(async (e) => { t.backend.add(phone, 'viewer', '', 'phone'); return original(e) })
    await t.syncer.register()
    expect(t.backend.state.active[me.pub]).toBeDefined()
    expect(t.backend.append).toHaveBeenCalledTimes(2)
  })

  it('writes a removal the trust group made before the log into the log', async () => {
    t = setup({ tombstoned: [box2.pub] })
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    await vi.waitFor(() => expect(t.backend.state.removed).toContain(box2.pub))
    expect(t.calls.adopt.mock.calls.flat(2).some((m: { pub: string }) => m.pub === box2.pub)).toBe(false)
  })

  it('never adopts a key this machine unpaired locally', async () => {
    t = setup({ blocked: [box2.pub] })
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    expect(t.calls.adopt.mock.calls.flat(2).some((m: { pub: string }) => m.pub === box2.pub)).toBe(false)
  })

  describe('a backend that lies', () => {
    beforeEach(async () => {
      t.backend.add(box2, 'machine', MID2, 'box2')
      await t.syncer.register()
    })

    it('freezes on a rewritten log and adds nothing more from it', async () => {
      const forged = new FakeBackend()
      forged.add(box2, 'machine', MID2, 'box2')
      forged.add(evil, 'viewer', '', 'evil')
      forged.add(phone, 'viewer', '', 'phone')
      t.backend.lie = forged.entries
      await t.syncer.refresh()
      expect(t.store.read().frozen?.reason).toBe('fork')
      expect(t.calls.adopt.mock.calls.flat(2).some((m: { pub: string }) => m.pub === evil.pub)).toBe(false)
      expect(t.syncer.list().frozen).not.toBeNull()
    })

    it('freezes on a log rolled back behind what it verified', async () => {
      t.backend.lie = t.backend.entries.slice(0, 1)
      await t.syncer.refresh()
      expect(t.store.read().frozen?.reason).toBe('rollback')
    })

    it('still honours a removal signed by a trusted key while frozen', async () => {
      t.backend.lie = t.backend.entries.slice(0, 1)
      await t.syncer.refresh()
      t.backend.lie = null
      t.backend.removeBy(box2.pub, me)
      await t.syncer.refresh()
      expect(t.calls.drop).toHaveBeenCalledWith(box2.pub)
      expect(t.store.read().frozen).not.toBeNull()
    })

    it('shows what trusting the log again changes, and does it only when confirmed', async () => {
      t.backend.lie = t.backend.entries.slice(0, 1)
      await t.syncer.refresh()
      t.backend.lie = null
      t.backend.add(phone, 'viewer', '', 'phone')
      const preview = await t.syncer.rebaseline(false)
      expect(preview?.added.map((m) => m.pub)).toEqual([phone.pub])
      expect(t.store.read().frozen).not.toBeNull()
      await t.syncer.rebaseline(true)
      expect(t.store.read().frozen).toBeNull()
      expect(t.store.read().state?.head).toEqual(t.backend.state.head)
    })
  })

  describe('gossip over group_sync', () => {
    beforeEach(async () => {
      t.backend.add(box2, 'machine', MID2, 'box2')
      await t.syncer.register()
    })

    it('sends its head', () => {
      expect(t.syncer.gossip()).toEqual({ head: t.backend.state.head, frozen: false })
    })

    it('freezes when a peer holds a different entry at a position it verified', () => {
      const other = new FakeBackend()
      other.add(evil, 'viewer', '', 'evil')
      other.add(phone, 'viewer', '', 'phone')
      t.syncer.heard(box2.pub, { head: other.state.head })
      expect(t.store.read().frozen?.reason).toBe('fork')
    })

    it('hands a peer that is behind the entries it lacks', () => {
      const answer = t.syncer.heard(box2.pub, { head: { seq: 1, hash: t.backend.state.hashes[0] } })
      expect((answer?.tail as DevLogEntry[]).map((e) => e.seq)).toEqual([2])
    })

    it('takes a removal the backend held back from a peer that is ahead, then freezes on the rollback', async () => {
      const heldBack = t.backend.removeBy(box2.pub, me)
      t.backend.lie = t.backend.entries.slice(0, 2)
      t.syncer.heard(box2.pub, { head: t.backend.state.head, tail: [heldBack] })
      expect(t.calls.drop).toHaveBeenCalledWith(box2.pub)
      await t.syncer.refresh()
      expect(t.store.read().frozen?.reason).toBe('rollback')
    })

    it('lists machines that say their log is frozen', () => {
      t.syncer.heard(box2.pub, { head: t.backend.state.head, frozen: true })
      expect(t.syncer.list().frozenPeers).toEqual(['box2'])
    })
  })

  it('does nothing without a backend log (an older backend)', async () => {
    t.backend.offline = true
    await t.syncer.register()
    expect(t.store.read().state).toBeNull()
    expect(t.calls.adopt).not.toHaveBeenCalled()
  })
})
