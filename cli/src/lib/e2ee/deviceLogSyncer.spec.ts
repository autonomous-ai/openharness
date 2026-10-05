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
import { DeviceLogSyncer, devLogDivergence, type DeviceLogAppendAnswer, type DeviceLogFetched, type DeviceLogRebaseline } from './deviceLogSyncer.js'
import { ADOPTED_SIGN_IN } from '../authSession.js'

const b64 = (u: Uint8Array): string => Buffer.from(u).toString('base64')
const key = (n: number) => { const priv = new Uint8Array(32).fill(n); return { priv, pub: b64(ed25519.getPublicKey(priv)) } }
const ACCT = 'acct-1'
const me = key(1), box2 = key(2), phone = key(3), evil = key(9)
const MID_ME = 'a'.repeat(32), MID2 = 'b'.repeat(32)

/** The backend's side: holds the log, refuses what breaks a rule, can be told to lie. */
class FakeBackend {
  acct = ACCT
  entries: DevLogEntry[] = []
  state: DevLogState = emptyDevLogState(ACCT)

  /** Another account's log. */
  static of(acct: string): FakeBackend {
    const b = new FakeBackend()
    b.acct = acct
    b.state = emptyDevLogState(acct)
    return b
  }
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
    const head = log.length ? applyDevLogEntries(emptyDevLogState(this.acct), log).state.head : emptyDevLogState(this.acct).head
    return { acct: this.acct, head, entries: log.filter((e) => e.seq > since) }
  })

  append = vi.fn(async (entry: DevLogEntry): Promise<DeviceLogAppendAnswer | null> => {
    if (this.offline) return null
    if (entry.seq !== this.state.head.seq + 1 || entry.prev !== this.state.head.hash) return { error: 'STALE_HEAD', head: this.state.head }
    try { this.push(entry) } catch (err) { return { error: err instanceof DevLogError ? err.code : 'X' } }
    return { head: this.state.head }
  })
}

/** `signIn`: the sign-in's epoch (one starting ADOPTED_SIGN_IN is adopted), made at `signInAt` (the
 *  clock's 5_000 by default — just now). */
function setup(opts: { known?: string[]; tombstoned?: string[]; blocked?: string[]; store?: DeviceLogStore; backend?: FakeBackend; signIn?: () => string | null; signInAt?: number | null } = {}) {
  const backend = opts.backend ?? new FakeBackend()
  const store = opts.store ?? new DeviceLogStore(join(mkdtempSync(join(tmpdir(), 'devlog-')), 'devlog.json'))
  const calls = {
    adopt: vi.fn(), drop: vi.fn(), announce: vi.fn(), signedOut: vi.fn(), changed: vi.fn(),
    removed: vi.fn(), conflict: vi.fn(), suspend: vi.fn(), resume: vi.fn(),
  }
  /** What this machine trusts "now": tests push into it to play a roster that outran the log. */
  const trusted: string[] = [...(opts.known ?? [])]
  const tombstoned = new Set(opts.tombstoned ?? [])
  const syncer = new DeviceLogSyncer({
    store,
    identity: () => me,
    signIn: () => {
      const epoch = opts.signIn?.() ?? null
      return epoch ? { epoch, adopted: epoch.startsWith(ADOPTED_SIGN_IN), at: opts.signInAt === undefined ? 5_000 : opts.signInAt } : null
    },
    self: () => ({ machineId: MID_ME, label: 'my-mac' }),
    fetch: backend.fetch,
    append: backend.append,
    adopt: calls.adopt,
    drop: (pub) => { tombstoned.delete(pub); calls.drop(pub) },
    trustedNow: () => [...trusted],
    tombstoned: (pub) => tombstoned.has(pub),
    blocked: (pub) => (opts.blocked ?? []).includes(pub),
    announce: calls.announce,
    removed: calls.removed,
    conflict: calls.conflict,
    suspend: calls.suspend,
    resume: calls.resume,
    signedOut: calls.signedOut,
    changed: calls.changed,
    now: () => 5_000,
    sleep: async () => {},
  })
  return { backend, store, syncer, calls, trusted }
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

  it('records when it first applied a new key, ignoring the entry\'s own backdated time, and not for the first read', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    expect(t.store.read().firstSeen?.[box2.pub]).toBeUndefined()
    t.backend.add(phone, 'viewer', '', 'phone', 1) // the adding device claims it happened long ago
    await t.syncer.refresh()
    const file = t.store.read()
    expect(file.firstSeen?.[phone.pub]).toBe(5_000) // this machine's clock (setup `now`)
    expect(t.syncer.list().members.find((m) => m.pub === phone.pub)).toMatchObject({ firstSeen: 5_000, addedAt: 1 })
    expect(t.syncer.list().members.find((m) => m.pub === box2.pub)?.firstSeen).toBeUndefined()
    t.backend.removeBy(phone.pub, me)
    await t.syncer.refresh()
    expect(t.store.read().firstSeen?.[phone.pub]).toBeUndefined()
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
      expect((preview as DeviceLogRebaseline).added.map((m) => m.pub)).toEqual([phone.pub])
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
      expect(t.syncer.gossip()).toMatchObject({ head: t.backend.state.head, frozen: false })
    expect(t.syncer.gossip()?.hashes).toEqual(t.backend.state.hashes.map((hash, i) => ({ seq: i + 1, hash })))
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

    /** Hold the next fetch's answer (taken when it is asked) until `release()`. */
    const holdNextFetch = (): (() => void) => {
      let release!: () => void
      const gate = new Promise<void>((resolve) => { release = resolve })
      const real = t.backend.fetch.getMockImplementation()!
      t.backend.fetch.mockImplementationOnce(async (since) => { const got = await real(since); await gate; return got })
      return release
    }
    const headAt = (seq: number) => applyDevLogEntries(emptyDevLogState(ACCT), t.backend.entries.slice(0, seq)).state.head

    it('reads a page again when a peer moved the log while it was on its way, rather than calling it a fork', async () => {
      const viaPeer = t.backend.add(phone, 'viewer', '', 'phone')
      t.backend.add(key(5), 'viewer', '', 'tablet')
      const release = holdNextFetch()
      const refreshed = t.syncer.refresh() // asks for everything after seq 2
      t.syncer.heard(box2.pub, { head: headAt(3), tail: [viaPeer] })
      release()
      await refreshed
      expect(t.store.read().frozen).toBeNull()
      expect(t.store.read().state?.head).toEqual(t.backend.state.head)
      expect(t.calls.announce.mock.calls.map(([m]) => m.label)).toEqual(['phone', 'tablet'])
    })

    it('reads a page again when a peer moved the log past it, rather than calling it a rollback', async () => {
      t.backend.add(phone, 'viewer', '', 'phone')
      const release = holdNextFetch() // the backend's answer stops at seq 3
      const refreshed = t.syncer.refresh()
      t.backend.add(key(5), 'viewer', '', 'tablet')
      t.syncer.heard(box2.pub, { head: t.backend.state.head, tail: t.backend.entries.slice(2) })
      release()
      await refreshed
      expect(t.store.read().frozen).toBeNull()
      expect(t.store.read().state?.head).toEqual(t.backend.state.head)
      expect(t.calls.announce.mock.calls.map(([m]) => m.label)).toEqual(['phone', 'tablet'])
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

const hashesOf = (state: DevLogState) => state.hashes.map((hash, i) => ({ seq: i + 1, hash }))
const MID_HOLDER = MID_ME

describe('DeviceLogSyncer — what is new, and what stays visible', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => { t = setup() })

  it('announces a key the roster already held before the log read that adds it, once, and keeps it pending', async () => {
    await t.syncer.register()
    t.trusted.push(box2.pub) // the trust group spread it before this machine read the entry
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
    await t.syncer.refresh()
    expect(t.calls.announce).toHaveBeenCalledOnce()
    expect(t.store.read().pending).toEqual([box2.pub])
    expect(t.syncer.list()).toMatchObject({ pending: [box2.pub] })
    expect(t.syncer.list().members.find((m) => m.pub === box2.pub)?.pending).toBe(true)
  })

  it('does the same when the entry arrives in a peer\'s tail, with the roster already ahead', async () => {
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.register()
    t.trusted.push(box2.pub)
    const entry = t.backend.add(box2, 'machine', MID2, 'box2')
    t.backend.offline = true
    t.syncer.heard(phone.pub, { head: t.backend.state.head, tail: [entry] })
    expect(t.calls.announce).toHaveBeenCalledOnce()
    expect(t.store.read().pending).toEqual([box2.pub])
  })

  it('a first read of an existing log announces nothing, reports the baseline and the joined point', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.refresh()
    expect(t.calls.announce).not.toHaveBeenCalled()
    expect(t.syncer.list()).toMatchObject({ baselineSeen: false, joinedSeq: 2, pending: [] })
  })

  it('an empty first log still announces the first device added later', async () => {
    await t.syncer.refresh()
    expect(t.store.read()).toMatchObject({ joinedSeq: 0 })
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
    expect(t.calls.announce).toHaveBeenCalledOnce()
  })

  it('a key trusted when this machine joined never becomes pending', async () => {
    t = setup({ known: [box2.pub] })
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.refresh()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
    expect(t.store.read().pending).toEqual([])
    expect(t.calls.announce).not.toHaveBeenCalled()
  })

  it('pending survives a new syncer on the same store; dismiss clears one, all, and the baseline', async () => {
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.register()
    t.backend.add(box2, 'machine', MID2, 'box2')
    t.backend.add(evil, 'viewer', '', 'evil')
    await t.syncer.refresh()
    const again = setup({ store: t.store, backend: t.backend })
    expect(again.syncer.list().pending).toEqual([box2.pub, evil.pub])
    again.syncer.dismiss({ pub: box2.pub })
    expect(t.store.read().pending).toEqual([evil.pub])
    expect(again.syncer.list().baselineSeen).toBe(false)
    again.syncer.dismiss({ baseline: true })
    expect(t.store.read()).toMatchObject({ pending: [evil.pub], baselineSeen: true })
    again.syncer.dismiss()
    expect(t.store.read().pending).toEqual([])
    expect(again.calls.changed).toHaveBeenCalled()
  })

  it('a rebaseline replay does not announce what was announced already', async () => {
    await t.syncer.register()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
    t.backend.lie = t.backend.entries.slice(0, 1)
    await t.syncer.refresh()
    t.backend.lie = null
    await t.syncer.rebaseline(true)
    expect(t.calls.announce).toHaveBeenCalledOnce()
    expect(t.store.read().announced).toEqual([box2.pub])
  })

  it('migrates a file from before the joined point: nothing up to notifiedUpTo is announced again', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    t.backend.add(phone, 'viewer', '', 'phone')
    t.backend.add(evil, 'viewer', '', 'evil')
    await t.syncer.register()
    const file = t.store.read()
    // What a client that predates the marks left behind, at seq 3.
    t.store.write({ state: file.state, recent: file.recent, frozen: null, notifiedUpTo: 3 })
    expect(t.store.read().joinedSeq).toBeUndefined()
    t.backend.add(key(7), 'viewer', '', 'late')
    await t.syncer.refresh()
    expect(t.calls.announce).toHaveBeenCalledOnce()
    expect(t.calls.announce).toHaveBeenCalledWith(expect.objectContaining({ label: 'late' }))
    expect(t.store.read()).toMatchObject({ joinedSeq: 3, baselineSeen: true })
  })

  it('a downgrade that strips the marks mid-run re-announces nothing it announced before', async () => {
    await t.syncer.register()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
    const file = t.store.read()
    t.store.write({ state: file.state, recent: file.recent, frozen: null, notifiedUpTo: file.notifiedUpTo })
    await t.syncer.refresh()
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.refresh()
    expect(t.calls.announce).toHaveBeenCalledTimes(2)
    expect(t.calls.announce.mock.calls.map(([m]) => m.pub)).toEqual([box2.pub, phone.pub])
  })

  it('a signed-in-to-another-account read starts the marks over', async () => {
    const who = { user: 'u1' }
    const s = setup({ signIn: () => who.user })
    s.backend.add(box2, 'machine', MID2, 'box2')
    await s.syncer.register()
    const file = s.store.read()
    s.store.write({ ...file, state: { ...file.state!, acct: 'other' }, pending: ['x'], suspended: ['y'] })
    who.user = 'u2'
    await s.syncer.refresh()
    expect(s.store.read()).toMatchObject({ pending: [], suspended: [], baselineSeen: false })
  })

  it('without a sign-in at hand, an account flip from the backend freezes and never starts over', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    const file = t.store.read()
    t.store.write({ ...file, state: { ...file.state!, acct: 'other' }, pending: ['x'] })
    await t.syncer.refresh()
    expect(t.store.read()).toMatchObject({ pending: ['x'], frozen: { reason: 'invalid' }, state: { acct: 'other' } })
  })

  describe('the local sign-in decides when the log starts over, never the backend', () => {
    const wrongAcct = async (): Promise<DeviceLogFetched> => ({ acct: 'x', head: emptyDevLogState('x').head, entries: [] })

    it('a backend that flips the account id and back keeps a fork\'s marks', async () => {
      let user = 'u1'
      const s = setup({ signIn: () => user })
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      s.backend.add(phone, 'viewer', '', 'phone')
      await s.syncer.refresh()
      s.store.update((f) => ({ ...f, suspended: [phone.pub] }))
      expect(s.store.read().pending).toContain(phone.pub)
      s.backend.fetch.mockImplementationOnce(wrongAcct)
      await s.syncer.refresh()
      expect(s.store.read().frozen?.reason).toBe('invalid')
      await s.syncer.refresh() // the real log again
      expect(s.store.read()).toMatchObject({ suspended: [phone.pub], pending: [phone.pub], frozen: { reason: 'invalid' } })
      expect(s.store.read().state?.acct).toBe(ACCT)
      expect(s.syncer.list().members.find((m) => m.pub === phone.pub)).toMatchObject({ suspended: true, pending: true })
    })

    /** Signed in as `user` on the account the backend at hand serves; `serve` points `fetch` elsewhere. */
    const signedIn = () => {
      const who = { user: 'u1' }
      const s = setup({ signIn: () => who.user })
      const real = s.backend.fetch.getMockImplementation()!
      const serve = (b: FakeBackend | null): void => { s.backend.fetch.mockImplementation(b ? b.fetch : real) }
      return { s, who, serve }
    }
    /** A fork suspended `phone`, still pending, and the list is frozen on it. */
    const forked = async (s: ReturnType<typeof setup>): Promise<void> => {
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      s.backend.add(phone, 'viewer', '', 'phone')
      await s.syncer.refresh()
      s.store.update((f) => ({ ...f, suspended: [phone.pub], frozen: { reason: 'fork', at: 1, lastGoodHead: f.state!.head } }))
    }

    it('a new sign-in id on the same account (a new machine id, a re-login) keeps the file and its marks', async () => {
      const { s, who } = signedIn()
      await forked(s)
      who.user = 'u2'
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ owner: 'u2', suspended: [phone.pub], pending: [phone.pub], frozen: { reason: 'fork' } })
      expect(s.store.read().joinedSeq).toBe(1)
      // That sign-in is the file's now: the backend flipping the account freezes, never starts over.
      s.store.update((f) => ({ ...f, frozen: null }))
      s.backend.fetch.mockImplementationOnce(wrongAcct)
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ suspended: [phone.pub], pending: [phone.pub], frozen: { reason: 'invalid' } })
    })

    it('a sign-in the backend forced, onto a made-up account and back, gives the first account its marks back', async () => {
      const { s, who, serve } = signedIn()
      await forked(s)
      // Signed out by the backend, signed in again by hand — and told it is another account, whose
      // log has the suspended key in it.
      const fake = FakeBackend.of('x')
      fake.add(phone, 'viewer', '', 'phone')
      fake.add(evil, 'viewer', '', 'evil')
      who.user = 'u2'
      serve(fake)
      s.calls.adopt.mockClear()
      await s.syncer.refresh()
      expect(s.store.read().state?.acct).toBe('x')
      const adopted = s.calls.adopt.mock.calls.flatMap(([ms]) => ms.map((m: { pub: string }) => m.pub))
      expect(adopted).toContain(evil.pub)
      expect(adopted).not.toContain(phone.pub)
      expect(s.syncer.suspendedKeys()).toContain(phone.pub)
      // And again, back to the real account.
      who.user = 'u3'
      serve(null)
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({
        owner: 'u3', state: { acct: ACCT }, suspended: [phone.pub], pending: [phone.pub], frozen: { reason: 'fork' }, joinedSeq: 1,
      })
    })

    it('a sign-in by hand to another account starts it fresh, and switching back restores the first', async () => {
      const { s, who, serve } = signedIn()
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      s.backend.add(phone, 'viewer', '', 'phone')
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ owner: 'u1', pending: [phone.pub] })
      const other = FakeBackend.of('acct-2')
      other.add(key(7), 'machine', 'c'.repeat(32), 'theirs')
      who.user = 'u2'
      serve(other)
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ owner: 'u2', state: { acct: 'acct-2' }, pending: [], baselineSeen: false })
      who.user = 'u3'
      serve(null)
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ owner: 'u3', state: { acct: ACCT, head: s.backend.state.head }, pending: [phone.pub] })
      expect(s.calls.announce).toHaveBeenCalledTimes(1)
    })

    it('an adopted sign-in (from before epochs) takes the file over but never starts one', async () => {
      const { s, who } = signedIn()
      await forked(s)
      who.user = `${ADOPTED_SIGN_IN}z`
      s.backend.fetch.mockImplementationOnce(wrongAcct)
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ owner: 'u1', state: { acct: ACCT }, suspended: [phone.pub], pending: [phone.pub] })
      await s.syncer.refresh()
      expect(s.store.read().owner).toBe(`${ADOPTED_SIGN_IN}z`)
    })

    it('a file from before it recorded its sign-in starts over for a sign-in by hand to another account', async () => {
      const { s, serve } = signedIn()
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      s.store.update((f) => { const { owner: _o, ...rest } = f; return { ...rest, pending: ['x'] } })
      serve(FakeBackend.of('acct-2'))
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ owner: 'u1', state: { acct: 'acct-2' }, pending: [], frozen: null })
    })

    it('no sign-in id at hand (the daemon reading before its session got one) never starts over on an account flip', async () => {
      const { s, who } = signedIn()
      await forked(s)
      s.store.update((f) => ({ ...f, frozen: null }))
      const none = who as { user: string | null }
      none.user = null
      s.backend.fetch.mockImplementationOnce(wrongAcct)
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({
        owner: 'u1', state: { acct: ACCT }, suspended: [phone.pub], pending: [phone.pub], frozen: { reason: 'invalid' }, joinedSeq: 1,
      })
    })

    it('a file from before it recorded its sign-in belongs to the current one', async () => {
      const s = setup({ signIn: () => 'u1' })
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      s.store.update((f) => { const { owner: _o, ...rest } = f; return { ...rest, pending: ['x'] } })
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ owner: 'u1', pending: ['x'] })
    })
  })

  it('a rebaseline during the history walk does not freeze the fresh log', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.register()
    const alt = new FakeBackend()
    alt.add(evil, 'viewer', '', 'evil')
    alt.add(me, 'machine', MID_ME, 'my-mac')
    const real = t.backend.fetch.getMockImplementation()!
    t.backend.fetch.mockImplementation(async (since) => {
      // The person confirms a review while this page is on its way: the file, and what the backend
      // serves, are another list now.
      if (since === 0) { t.store.update((f) => ({ ...f, state: alt.state })); t.backend.lie = alt.entries }
      return real(since)
    })
    const h = await t.syncer.history()
    expect(t.store.read().frozen).toBeNull()
    expect(h.complete).toBe(false)
  })

  it('a peer tail that arrives while the first read is still open announces nothing', async () => {
    const s = setup()
    s.backend.add(box2, 'machine', MID2, 'box2')
    s.backend.add(phone, 'viewer', '', 'phone')
    s.backend.add(evil, 'viewer', '', 'evil')
    const real = s.backend.fetch.getMockImplementation()!
    // The first read comes in one entry at a time; between its pages a peer hands over the rest.
    s.backend.fetch.mockImplementationOnce(async (since) => { const g = await real(since); return g && { ...g, entries: g.entries.slice(0, 1) } })
    s.backend.fetch.mockImplementationOnce(async (since) => {
      s.syncer.heard(box2.pub, { head: s.backend.state.head, frozen: false, tail: s.backend.entries.slice(1) })
      return real(since)
    })
    await s.syncer.refresh()
    expect(s.calls.announce).not.toHaveBeenCalled()
    expect(s.store.read()).toMatchObject({ joinedSeq: 3, pending: [] })
    expect(s.store.read().joining).toBeUndefined()
    s.backend.add(key(7), 'viewer', '', 'later')
    await s.syncer.refresh()
    expect(s.calls.announce).toHaveBeenCalledTimes(1)
  })

  it('a first read the backend cuts short ends the joining: what it held back is news', async () => {
    const s = setup()
    s.backend.add(box2, 'machine', MID2, 'box2')
    s.backend.add(phone, 'viewer', '', 'phone')
    s.backend.add(evil, 'viewer', '', 'evil')
    const real = s.backend.fetch.getMockImplementation()!
    s.backend.fetch.mockImplementationOnce(async (since) => { const g = await real(since); return g && { ...g, entries: g.entries.slice(0, 1) } })
    s.backend.fetch.mockImplementationOnce(async () => null)
    await s.syncer.refresh()
    expect(s.store.read()).toMatchObject({ joinedSeq: 1, pending: [] })
    expect(s.store.read().joining).toBeUndefined()
    s.syncer.heard(box2.pub, { head: s.backend.state.head, frozen: false, tail: s.backend.entries.slice(1) })
    expect(s.calls.announce.mock.calls.map(([m]) => m.pub)).toEqual([phone.pub, evil.pub])
    expect(s.store.read()).toMatchObject({ joinedSeq: 1, pending: [phone.pub, evil.pub] })
  })

  it('"Got it" on the already-on-your-account list ends the joining', async () => {
    const s = setup()
    s.backend.add(box2, 'machine', MID2, 'box2')
    s.backend.add(evil, 'viewer', '', 'evil')
    const real = s.backend.fetch.getMockImplementation()!
    s.backend.fetch.mockImplementationOnce(async (since) => { const g = await real(since); return g && { ...g, entries: g.entries.slice(0, 1) } })
    s.backend.fetch.mockImplementationOnce(async (since) => { s.syncer.dismiss({ baseline: true }); return real(since) })
    await s.syncer.refresh()
    expect(s.calls.announce).toHaveBeenCalledWith(expect.objectContaining({ pub: evil.pub }))
    expect(s.store.read()).toMatchObject({ joinedSeq: 1, pending: [evil.pub], baselineSeen: true })
  })

  it('a key taken into an acknowledged already-on-your-account list shows that list again', async () => {
    const s = setup()
    s.backend.add(box2, 'machine', MID2, 'box2')
    s.backend.add(evil, 'viewer', '', 'evil')
    const real = s.backend.fetch.getMockImplementation()!
    s.backend.fetch.mockImplementationOnce(async (since) => { const g = await real(since); return g && { ...g, entries: g.entries.slice(0, 1) } })
    s.backend.fetch.mockImplementationOnce(async (since) => {
      // Acknowledged by a client that did not end the joining.
      s.store.update((f) => ({ ...f, baselineSeen: true }))
      return real(since)
    })
    await s.syncer.refresh()
    expect(s.calls.announce).not.toHaveBeenCalled()
    expect(s.store.read()).toMatchObject({ joinedSeq: 2, baselineSeen: false })
    expect(s.syncer.list().baseline).toContain(evil.pub)
  })

  describe('every write path keeps the marks', () => {
    beforeEach(async () => {
      t.backend.add(box2, 'machine', MID2, 'box2')
      await t.syncer.register()
    })

    it('accept', async () => {
      t.store.update((f) => ({ ...f, preLog: ['pre'], baselineSeen: false }))
      t.backend.add(phone, 'viewer', '', 'phone')
      await t.syncer.refresh()
      expect(t.store.read()).toMatchObject({ joinedSeq: 1, preLog: ['pre'], baselineSeen: false, pending: [phone.pub] })
    })

    it('freeze', async () => {
      t.store.update((f) => ({ ...f, preLog: ['pre'], baselineSeen: false }))
      t.backend.lie = t.backend.entries.slice(0, 1)
      await t.syncer.refresh()
      expect(t.store.read()).toMatchObject({ joinedSeq: 1, preLog: ['pre'], baselineSeen: false })
      expect(t.store.read().frozen).not.toBeNull()
    })

    it('loose removals', async () => {
      t.store.update((f) => ({ ...f, preLog: ['pre'], baselineSeen: false }))
      t.backend.lie = t.backend.entries.slice(0, 1)
      await t.syncer.refresh()
      t.backend.lie = null
      const removal = t.backend.removeBy(box2.pub, me)
      await t.syncer.refresh()
      expect(t.store.read()).toMatchObject({ joinedSeq: 1, preLog: ['pre'], baselineSeen: false })
      expect(t.store.read().looseRemoved).toEqual([removal])
      expect(t.store.read().recent.map((e) => e.seq)).toEqual([1, 2])
    })

    it('rebaseline', async () => {
      t.store.update((f) => ({ ...f, preLog: ['pre'], baselineSeen: false, suspended: [box2.pub] }))
      t.backend.lie = t.backend.entries.slice(0, 1)
      await t.syncer.refresh()
      await t.syncer.rebaseline(true)
      expect(t.store.read()).toMatchObject({ joinedSeq: 1, preLog: ['pre'], baselineSeen: false, suspended: [], looseRemoved: [] })
      expect(t.calls.resume).toHaveBeenCalledOnce()
    })

    it('register conflict', async () => {
      const taken = setup()
      taken.backend.add(box2, 'machine', MID_HOLDER, 'old-install')
      await taken.syncer.refresh()
      taken.store.update((f) => ({ ...f, preLog: ['pre'] }))
      await taken.syncer.register()
      expect(taken.store.read()).toMatchObject({ joinedSeq: 1, preLog: ['pre'], baselineSeen: false, conflict: { pub: box2.pub } })
    })

    it('dismiss', () => {
      t.store.update((f) => ({ ...f, preLog: ['pre'] }))
      t.syncer.dismiss({ pub: box2.pub })
      expect(t.store.read()).toMatchObject({ joinedSeq: 1, preLog: ['pre'], baselineSeen: false })
    })
  })
})

describe('DeviceLogSyncer — removal notices', () => {
  let t: ReturnType<typeof setup>
  beforeEach(async () => {
    t = setup()
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.register()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
  })

  it('says nothing about a removal this device signed, or one before it joined', async () => {
    t.backend.removeBy(box2.pub, me)
    await t.syncer.refresh()
    expect(t.calls.removed).not.toHaveBeenCalled()
  })

  it('a device that removed itself is "signed out"', async () => {
    t.syncer.dismiss()
    t.backend.removeBy(box2.pub, box2)
    await t.syncer.refresh()
    expect(t.calls.removed).toHaveBeenCalledWith(expect.objectContaining({ pub: box2.pub, label: 'box2', selfRemoved: true, signerPending: false }))
  })

  it('a removal by a device that was already trusted is a normal notice naming the signer', async () => {
    t.syncer.dismiss()
    t.backend.removeBy(box2.pub, phone)
    await t.syncer.refresh()
    expect(t.calls.removed).toHaveBeenCalledWith(expect.objectContaining({
      pub: box2.pub, signer: phone.pub, signerLabel: 'phone', selfRemoved: false, signerPending: false, kind: 'machine',
    }))
  })

  it('is red when the signer is itself a new device nobody looked at', async () => {
    t.backend.removeBy(phone.pub, box2)
    await t.syncer.refresh()
    expect(t.calls.removed).toHaveBeenCalledWith(expect.objectContaining({ pub: phone.pub, signer: box2.pub, signerPending: true, signerLabel: 'box2' }))
  })

  it('also fires for a removal applied while frozen, and keeps it for the history', async () => {
    t.backend.lie = t.backend.entries.slice(0, 2)
    await t.syncer.refresh()
    t.backend.lie = null
    t.backend.removeBy(phone.pub, box2)
    await t.syncer.refresh()
    expect(t.calls.removed).toHaveBeenCalledWith(expect.objectContaining({ pub: phone.pub, signerPending: true }))
    expect(t.store.read().looseRemoved?.[0]).toMatchObject({ op: 'remove', pub: phone.pub })
  })
})

describe('DeviceLogSyncer — another key holds this machine\'s id', () => {
  it('records the conflict once (neutral when the holder predates joining), and shows it while the holder is active', async () => {
    const t = setup()
    t.backend.add(box2, 'machine', MID_HOLDER, 'old-install')
    await t.syncer.register()
    await t.syncer.register()
    expect(t.calls.conflict).toHaveBeenCalledOnce()
    expect(t.calls.conflict).toHaveBeenCalledWith(expect.objectContaining({ pub: box2.pub, label: 'old-install', afterJoin: false }))
    expect(t.syncer.list().conflict).toMatchObject({ pub: box2.pub, afterJoin: false })
    expect(t.backend.append).not.toHaveBeenCalled()
  })

  it('is afterJoin when the holder joined after this machine read the log', async () => {
    const t = setup()
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.refresh()
    t.backend.add(box2, 'machine', MID_HOLDER, 'new-install')
    await t.syncer.register()
    expect(t.calls.conflict).toHaveBeenCalledWith(expect.objectContaining({ afterJoin: true }))
  })

  it('clears when the holder is removed, and this machine registers itself', async () => {
    const t = setup()
    t.backend.add(box2, 'machine', MID_HOLDER, 'old-install')
    await t.syncer.register()
    t.backend.removeBy(box2.pub, box2)
    await t.syncer.refresh()
    await vi.waitFor(() => expect(t.backend.state.active[me.pub]).toBeDefined())
    expect(t.store.read().conflict).toBeUndefined()
    expect(t.syncer.list().conflict).toBeNull()
  })
})

describe('DeviceLogSyncer — a fork', () => {
  let t: ReturnType<typeof setup>
  let other: FakeBackend
  beforeEach(async () => {
    t = setup()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register() // box2 (1), me (2)
    t.backend.add(phone, 'viewer', '', 'phone') // 3: new since joining
    await t.syncer.refresh()
    other = new FakeBackend()
    other.add(box2, 'machine', MID2, 'box2')
    other.add(evil, 'viewer', '', 'evil')
    other.add(phone, 'viewer', '', 'phone')
  })

  it('suspends only the new keys at or after the split, and tells the group syncer', () => {
    t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
    expect(t.store.read().frozen?.reason).toBe('fork')
    expect(t.store.read().suspended).toEqual([phone.pub])
    expect(t.calls.suspend).toHaveBeenCalledWith([phone.pub])
    expect(t.syncer.suspendedKeys()).toEqual([phone.pub])
    expect(t.syncer.list().members.find((m) => m.pub === phone.pub)?.suspended).toBe(true)
  })

  it('suspends nothing without hashes, outside the window, on bad hashes', () => {
    t.syncer.heard(box2.pub, { head: other.state.head })
    expect(t.calls.suspend).not.toHaveBeenCalled()
    t.syncer.heard(box2.pub, { head: other.state.head, hashes: [{ seq: 3, hash: other.state.head.hash }] }) // split not provable
    t.syncer.heard(box2.pub, { head: other.state.head, hashes: 'junk' })
    t.syncer.heard(box2.pub, { head: other.state.head, hashes: [{ seq: 2, hash: 'x' }, { seq: 5, hash: 'y' }] })
    expect(t.calls.suspend).not.toHaveBeenCalled()
    expect(t.store.read().suspended).toEqual([])
  })

  it('a rollback suspends nothing', async () => {
    t.backend.lie = t.backend.entries.slice(0, 1)
    await t.syncer.refresh()
    expect(t.store.read().frozen?.reason).toBe('rollback')
    expect(t.calls.suspend).not.toHaveBeenCalled()
  })

  it('rebaseline clears the suspension and trusts the log again', async () => {
    t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
    await t.syncer.rebaseline(true)
    expect(t.store.read().suspended).toEqual([])
    expect(t.calls.resume).toHaveBeenCalledOnce()
    expect(t.calls.adopt).toHaveBeenLastCalledWith(expect.arrayContaining([expect.objectContaining({ pub: phone.pub })]))
  })

  it('rebaseline lifts the suspension only after dropping what the reviewed log removed', async () => {
    t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
    t.backend.removeBy(box2.pub, me)
    await t.syncer.rebaseline(true)
    expect(t.calls.drop).toHaveBeenCalledWith(box2.pub)
    expect(t.calls.resume.mock.invocationCallOrder[0]).toBeGreaterThan(Math.max(...t.calls.drop.mock.invocationCallOrder))
  })

  it('a log already frozen on a fork still learns the split from a peer that is ahead', async () => {
    t.backend.lie = other.entries // same length, different entry at 2: a fork the backend showed
    await t.syncer.refresh()
    expect(t.store.read().frozen?.reason).toBe('fork')
    expect(t.calls.suspend).not.toHaveBeenCalled()
    other.add(key(7), 'viewer', '', 'later')
    t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
    expect(t.store.read().suspended).toEqual([phone.pub])
    expect(t.calls.suspend).toHaveBeenCalledWith([phone.pub])
  })

  it('a removal signed by a suspended key does not count while frozen', async () => {
    t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
    t.calls.drop.mockClear()
    t.backend.removeBy(box2.pub, phone) // the suspended key tries to take out a device trusted here
    await t.syncer.refresh()
    expect(t.calls.drop).not.toHaveBeenCalled()
    expect(t.calls.removed).not.toHaveBeenCalled()
    expect(t.store.read().state?.active[box2.pub]).toBeDefined()
    expect(t.store.read().looseRemoved ?? []).toEqual([])
  })

  it('never adopts a suspended key from the log', async () => {
    t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
    t.calls.adopt.mockClear()
    t.store.update((f) => ({ ...f, frozen: null }))
    t.backend.add(evil, 'viewer', '', 'evil')
    await t.syncer.refresh()
    expect(t.calls.adopt.mock.calls.flat(2).some((m: { pub: string }) => m.pub === phone.pub)).toBe(false)
  })
})

describe('devLogDivergence', () => {
  const log = new FakeBackend()
  log.add(box2, 'machine', MID2, 'box2')
  log.add(phone, 'viewer', '', 'phone')
  log.add(evil, 'viewer', '', 'evil')
  const mine = log.state
  const theirs = (mutate: (h: Array<{ seq: number; hash: string }>) => void) => {
    const h = hashesOf(mine).map((x) => ({ ...x }))
    mutate(h)
    return { head: h.at(-1), hashes: h }
  }

  it('finds the first position that differs when the one before matches', () => {
    expect(devLogDivergence(mine, theirs((h) => { h[1].hash = 'x'; h[2].hash = 'y' }))).toBe(2)
    expect(devLogDivergence(mine, theirs((h) => { h[0].hash = 'x'; h[1].hash = 'y'; h[2].hash = 'z' }))).toBe(1)
    expect(devLogDivergence(mine, theirs((h) => { h[2].hash = 'z' }))).toBe(3)
  })

  it('is null when everything matches, or the input is not usable', () => {
    expect(devLogDivergence(mine, theirs(() => {}))).toBeNull()
    expect(devLogDivergence(mine, null)).toBeNull()
    expect(devLogDivergence(mine, { head: mine.head })).toBeNull()
    expect(devLogDivergence(mine, { head: mine.head, hashes: [{ seq: 1 }] })).toBeNull()
    expect(devLogDivergence(mine, { head: { seq: 3, hash: 'other' }, hashes: hashesOf(mine) })).toBeNull()
  })

  it('is null when the window starts at the split (not provable)', () => {
    const h = hashesOf(mine).slice(1).map((x, i) => (i === 0 ? { ...x, hash: 'x' } : x))
    expect(devLogDivergence(mine, { head: h.at(-1), hashes: h })).toBeNull()
  })
})

describe('DeviceLogSyncer — history', () => {
  let t: ReturnType<typeof setup>
  beforeEach(async () => {
    t = setup()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    t.backend.add(phone, 'viewer', '', 'phone')
    t.backend.add(evil, 'viewer', '', 'evil')
    await t.syncer.refresh()
  })

  it('lists every entry newest first, with who removed what', async () => {
    t.backend.removeBy(evil.pub, phone)
    t.backend.removeBy(phone.pub, phone)
    const h = await t.syncer.history()
    expect(h.complete).toBe(true)
    expect(h.rows.map((r) => [r.seq, r.op])).toEqual([[6, 'signedOut'], [5, 'removed'], [4, 'added'], [3, 'added'], [2, 'added'], [1, 'added']])
    expect(h.rows[1]).toMatchObject({ pub: evil.pub, label: 'evil', by: { pub: phone.pub, label: 'phone' }, active: false })
    expect(h.rows.find((r) => r.pub === me.pub)).toMatchObject({ thisDevice: true, afterJoin: true })
    expect(h.rows.find((r) => r.pub === box2.pub)).toMatchObject({ afterJoin: false, active: true })
    expect(h.rows.find((r) => r.pub === phone.pub)).toMatchObject({ afterJoin: true })
  })

  it('shows a rename, and marks pending devices', async () => {
    const renamed = signDevLogEntry(nextDevLogEntry(t.backend.state, { op: 'add', pub: phone.pub, kind: 'viewer', machineId: '', label: 'pixel', signer: phone.pub }, 3_000), phone.priv)
    t.backend.entries.push(renamed)
    t.backend.state = applyDevLogEntries(t.backend.state, [renamed]).state
    const h = await t.syncer.history()
    expect(h.rows[0]).toMatchObject({ op: 'renamed', label: 'pixel', previousLabel: 'phone' })
    expect(h.rows.find((r) => r.op === 'added' && r.pub === phone.pub)?.pending).toBe(true)
  })

  it('a second call fetches only what is missing', async () => {
    await t.syncer.history()
    t.backend.fetch.mockClear()
    t.backend.add(key(7), 'viewer', '', 'late')
    await t.syncer.history()
    const since = t.backend.fetch.mock.calls.map(([s]) => s)
    expect(since).toEqual([4, 4]) // the refresh, then the one missing entry — never from 0
  })

  it('freezes when the backend serves a different entry at a verified position', async () => {
    const forged = new FakeBackend()
    forged.add(box2, 'machine', MID2, 'box2')
    forged.add(me, 'machine', MID_ME, 'my-mac', 9_999) // not what this machine verified at 2
    t.backend.lie = null
    const real = t.backend.fetch.getMockImplementation()!
    t.backend.fetch.mockImplementation(async (since) => {
      const got = await real(since)
      return got && since < 2 ? { ...got, entries: got.entries.map((e) => ((e as DevLogEntry).seq === 2 ? forged.entries[1] : e)) } : got
    })
    const fresh = setup({ store: t.store, backend: t.backend })
    const h = await fresh.syncer.history()
    expect(h.complete).toBe(false)
    expect(t.store.read().frozen?.reason).toBe('fork')
  })

  it('offline: what is kept locally, not complete', async () => {
    t.backend.offline = true
    const fresh = setup({ store: t.store, backend: t.backend })
    const h = await fresh.syncer.history()
    expect(h.complete).toBe(false)
    expect(h.rows.map((r) => r.seq)).toEqual([4, 3, 2, 1])
  })

  it('removals applied while frozen carry whileFrozen', async () => {
    t.backend.lie = t.backend.entries.slice(0, 2)
    await t.syncer.refresh()
    t.backend.lie = null
    t.backend.removeBy(evil.pub, phone)
    await t.syncer.refresh()
    const h = await t.syncer.history()
    expect(h.rows.find((r) => r.op === 'removed')).toMatchObject({ whileFrozen: true, pub: evil.pub })
  })
})

describe('DeviceLogSyncer — what the backend cannot bend', () => {
  let t: ReturnType<typeof setup>
  beforeEach(() => { t = setup() })

  /** A first page whose head claims far more than the entries it carries. */
  function inflateFirstPage(claim: number): void {
    const real = t.backend.fetch.getMockImplementation()!
    let first = true
    t.backend.fetch.mockImplementation(async (since) => {
      const got = await real(since)
      if (!got || !first) return got
      first = false
      return { ...got, head: { seq: claim, hash: 'x'.repeat(64) } }
    })
  }

  it('the joined point is the VERIFIED head, never the one the backend claims', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    t.backend.add(phone, 'viewer', '', 'phone')
    inflateFirstPage(1000)
    await t.syncer.refresh()
    expect(t.store.read().frozen).toBeNull()
    expect(t.store.read().joinedSeq).toBe(2)
    // A key forged below the claimed 1000 is still new.
    t.backend.add(evil, 'viewer', '', 'evil')
    await t.syncer.refresh()
    expect(t.calls.announce).toHaveBeenCalledWith(expect.objectContaining({ pub: evil.pub }))
    expect(t.store.read().pending).toEqual([evil.pub])
  })

  it('a head that is not a position is not read at all', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    for (const seq of [1.5, -1, Number.NaN, 2 ** 60]) {
      const real = t.backend.fetch.getMockImplementation()!
      t.backend.fetch.mockImplementationOnce(async (since) => {
        const got = await real(since)
        return got && { ...got, head: { seq, hash: 'h' } }
      })
      await t.syncer.refresh()
      expect(t.store.read().state).toBeNull()
    }
  })

  it('a first read cut short is verified as far as it went (nothing beyond it hides)', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    t.backend.add(phone, 'viewer', '', 'phone')
    const real = t.backend.fetch.getMockImplementation()!
    let calls = 0
    t.backend.fetch.mockImplementation(async (since) => {
      const got = await real(since)
      if (!got) return got
      calls++
      return calls === 1 ? { ...got, entries: got.entries.slice(0, 1) } : got
    })
    // The page is short; the run goes on reading from where it verified, still as the join.
    await t.syncer.refresh()
    expect(t.store.read().joinedSeq).toBe(2)
    expect(t.calls.announce).not.toHaveBeenCalled()
  })

  describe('rebaseline(confirm)', () => {
    beforeEach(async () => {
      t.backend.add(box2, 'machine', MID2, 'box2')
      await t.syncer.register()
      t.backend.lie = t.backend.entries.slice(0, 1)
      await t.syncer.refresh() // frozen (rolled back)
      t.backend.lie = null
    })

    it('a key the preview did not show is pending and announced', async () => {
      const preview = await t.syncer.rebaseline(false) as { head: { seq: number; hash: string } }
      t.backend.add(evil, 'viewer', '', 'evil') // the backend adds it between preview and confirm
      const done = await t.syncer.rebaseline(true)
      expect(done).not.toBeNull()
      expect(t.store.read().pending).toEqual([evil.pub])
      expect(t.calls.announce).toHaveBeenCalledWith(expect.objectContaining({ pub: evil.pub }))
      expect(preview.head.seq).toBeLessThan(t.backend.state.head.seq)
    })

    it('refuses when the backend head is no longer the one previewed', async () => {
      const preview = await t.syncer.rebaseline(false) as { head: { seq: number; hash: string } }
      t.backend.add(evil, 'viewer', '', 'evil')
      expect(await t.syncer.rebaseline(true, preview.head)).toEqual({ error: 'LOG_CHANGED' })
      expect(t.store.read().frozen).not.toBeNull()
      expect(t.store.read().state?.active[evil.pub]).toBeUndefined()
      expect(t.calls.announce).not.toHaveBeenCalled()
      const again = await t.syncer.rebaseline(false) as { head: { seq: number; hash: string } }
      expect(await t.syncer.rebaseline(true, again.head)).toMatchObject({ head: t.backend.state.head })
      expect(t.store.read().frozen).toBeNull()
    })
  })

  describe('a fork does not cost the user the devices they reviewed', () => {
    let other: FakeBackend
    beforeEach(async () => {
      t.backend.add(box2, 'machine', MID2, 'box2')
      await t.syncer.register()
      t.backend.add(phone, 'viewer', '', 'phone') // 3: new since joining, pending
      await t.syncer.refresh()
      other = new FakeBackend()
      other.add(box2, 'machine', MID2, 'box2')
      other.add(evil, 'viewer', '', 'evil')
      other.add(phone, 'viewer', '', 'phone')
    })

    it('a key already marked as seen is not suspended', () => {
      t.syncer.dismiss({ pubs: [phone.pub] })
      t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
      expect(t.store.read().frozen?.reason).toBe('fork')
      expect(t.store.read().suspended).toEqual([])
      expect(t.calls.suspend).not.toHaveBeenCalled()
    })

    it('a key let in by a review (rebaseline --yes) is not suspended', async () => {
      t.backend.lie = t.backend.entries.slice(0, 1)
      await t.syncer.refresh()
      t.backend.lie = null
      await t.syncer.rebaseline(true)
      expect(t.store.read().pending).toContain(phone.pub)
      t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
      expect(t.store.read().suspended).toEqual([])
    })

    it('a key added after the fork was proven is still suspended when it is new here', () => {
      t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
      expect(t.store.read().suspended).toEqual([phone.pub])
    })

    it('"It\'s mine" on a suspended key lifts its suspension here; a list that was merely viewed does not', () => {
      t.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
      t.syncer.dismiss({ pubs: [phone.pub] })
      expect(t.store.read().suspended).toEqual([phone.pub])
      expect(t.store.read().pending).toEqual([phone.pub]) // still flagged
      t.calls.resume.mockClear()
      t.calls.adopt.mockClear()
      t.syncer.dismiss({ pub: phone.pub })
      expect(t.store.read()).toMatchObject({ suspended: [], pending: [] })
      expect(t.calls.resume).toHaveBeenCalledOnce()
      expect(t.calls.adopt).toHaveBeenCalledWith([expect.objectContaining({ pub: phone.pub })])
    })
  })

  it('two history() calls at once share one walk and freeze nothing', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    t.backend.add(phone, 'viewer', '', 'phone')
    t.backend.add(evil, 'viewer', '', 'evil')
    await t.syncer.refresh()
    const fresh = setup({ store: t.store, backend: t.backend })
    const [a, b] = await Promise.all([fresh.syncer.history(), fresh.syncer.history()])
    expect(t.store.read().frozen).toBeNull()
    expect(a.complete).toBe(true)
    expect(b.rows.map((r) => r.seq)).toEqual([4, 3, 2, 1])
  })

  it('a second history() while one is walking joins it instead of walking again', async () => {
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.refresh()
    const once = setup({ store: t.store, backend: t.backend })
    t.backend.fetch.mockClear()
    await once.syncer.history()
    const single = t.backend.fetch.mock.calls.length
    const twice = setup({ store: t.store, backend: t.backend })
    t.backend.fetch.mockClear()
    const [a, b] = await Promise.all([twice.syncer.history(), twice.syncer.history()])
    expect(t.backend.fetch.mock.calls.length).toBe(single)
    expect(a).toBe(b)
    expect(t.store.read().frozen).toBeNull()
  })

  it('dismiss with a list clears only what it names (a key accepted since the window read stays pending)', async () => {
    await t.syncer.register()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.refresh()
    t.syncer.dismiss({ pubs: [box2.pub] })
    expect(t.store.read().pending).toEqual([phone.pub])
  })

  it('keys this machine trusted at joining, whose entry came after the joined point, are in the baseline', async () => {
    t = setup({ known: [box2.pub] })
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.refresh()
    t.backend.add(box2, 'machine', MID2, 'box2') // seq 2 > joinedSeq 1, but trusted before joining
    await t.syncer.refresh()
    expect(t.syncer.list().baseline.sort()).toEqual([box2.pub, phone.pub].sort())
    expect(t.syncer.list().pending).toEqual([])
  })

  it('a removal is described by the label and kind the key had, not the remove entry\'s own', async () => {
    t.backend.add(phone, 'viewer', '', 'phone')
    await t.syncer.register()
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.refresh()
    t.syncer.dismiss()
    const lie = signDevLogEntry(nextDevLogEntry(t.backend.state, {
      op: 'remove', pub: box2.pub, kind: 'viewer', machineId: '', label: 'Totally Fine', signer: phone.pub,
    }, 2_000), phone.priv)
    t.backend.entries.push(lie)
    t.backend.state = applyDevLogEntries(t.backend.state, [lie]).state
    await t.syncer.refresh()
    expect(t.calls.removed).toHaveBeenCalledWith(expect.objectContaining({ pub: box2.pub, label: 'box2', kind: 'machine' }))
    const h = await t.syncer.history()
    expect(h.rows[0]).toMatchObject({ op: 'removed', pub: box2.pub, label: 'box2', kind: 'machine' })
  })
})

describe('DeviceLogSyncer — departed keys, sign-ins and kept accounts', () => {
  describe('a new key that leaves before anyone looked stays flagged', () => {
    let t: ReturnType<typeof setup>
    beforeEach(async () => {
      t = setup()
      t.backend.add(box2, 'machine', MID2, 'box2')
      await t.syncer.register() // box2 (1), me (2)
      t.backend.add(evil, 'viewer', '', 'evil') // 3: new, pending
      await t.syncer.refresh()
    })
    const departedPubs = (s: ReturnType<typeof setup>): string[] => s.syncer.list().departed.map((d) => d.pub)

    it('removed by itself: departed survives a restart, keeps its history row new, and goes on dismiss', async () => {
      t.backend.removeBy(evil.pub, evil)
      await t.syncer.refresh()
      expect(t.syncer.list().pending).toEqual([])
      expect(t.syncer.list().departed).toEqual([expect.objectContaining({
        pub: evil.pub, label: 'evil', kind: 'viewer', addedAt: 1_000, removedAt: 2_000, removedBy: evil.pub, selfRemoved: true,
      })])
      // A new daemon (or `harness devices`) over the same file.
      const again = setup({ store: t.store, backend: t.backend })
      expect(departedPubs(again)).toEqual([evil.pub])
      const h = await again.syncer.history()
      expect(h.rows.filter((r) => r.pub === evil.pub).map((r) => [r.op, r.pending])).toEqual([['signedOut', true], ['added', true]])
      again.syncer.dismiss({ pub: evil.pub })
      expect(departedPubs(again)).toEqual([])
      expect((await again.syncer.history()).rows.some((r) => r.pending)).toBe(false)
    })

    it('removed by another key: says by whom', async () => {
      t.backend.removeBy(evil.pub, box2)
      await t.syncer.refresh()
      expect(t.syncer.list().departed).toEqual([expect.objectContaining({
        pub: evil.pub, removedBy: box2.pub, removedByLabel: 'box2', selfRemoved: false,
      })])
    })

    it('added and removed within one page: announced, and departed', async () => {
      t.backend.add(phone, 'viewer', '', 'phone')
      t.backend.removeBy(phone.pub, phone)
      await t.syncer.refresh()
      expect(t.calls.announce).toHaveBeenCalledWith(expect.objectContaining({ pub: phone.pub }))
      expect(departedPubs(t)).toEqual([phone.pub])
    })

    it('removed while the list is frozen: departed too', async () => {
      t.store.update((f) => ({ ...f, frozen: { reason: 'fork', at: 1, lastGoodHead: f.state!.head } }))
      t.backend.removeBy(evil.pub, box2)
      await t.syncer.refresh()
      expect(t.store.read().looseRemoved).toHaveLength(1)
      expect(departedPubs(t)).toEqual([evil.pub])
    })

    it('a key already marked as seen is not departed', async () => {
      t.syncer.dismiss({ pub: evil.pub })
      t.backend.removeBy(evil.pub, evil)
      await t.syncer.refresh()
      expect(departedPubs(t)).toEqual([])
    })

    it('clears for its own pub, a list naming it, or every one — never for the baseline or another key', async () => {
      t.backend.removeBy(evil.pub, evil)
      await t.syncer.refresh()
      t.syncer.dismiss({ baseline: true })
      t.syncer.dismiss({ pubs: [box2.pub] })
      t.syncer.dismiss({ pub: box2.pub })
      expect(departedPubs(t)).toEqual([evil.pub])
      t.syncer.dismiss({ pubs: [evil.pub] })
      expect(departedPubs(t)).toEqual([])
      t.store.update((f) => ({ ...f, departed: [depOf(evil.pub)] }))
      t.syncer.dismiss()
      expect(departedPubs(t)).toEqual([])
    })

    it('kept newest first-in-last-out up to the cap', async () => {
      for (let i = 10; i < 10 + 33; i++) {
        const k = key(i)
        t.backend.add(k, 'viewer', '', `k${i}`)
        t.backend.removeBy(k.pub, k)
      }
      await t.syncer.refresh()
      const d = t.syncer.list().departed
      expect(d).toHaveLength(32)
      expect(d.at(-1)?.label).toBe('k42')
      expect(d[0].label).toBe('k11')
    })
  })

  const depOf = (pub: string) => ({
    pub, label: 'x', kind: 'viewer' as const, machineId: '', fingerprint: 'F', addedAt: 1, removedAt: 2, removedBy: pub, removedByLabel: '', selfRemoved: true,
  })

  describe('a sign-in by hand starts the log over only shortly after it was made', () => {
    it('one made over 10 minutes ago, with no read of its account yet, only freezes', async () => {
      const who = { user: 'u1' }
      const s = setup({ signIn: () => who.user, signInAt: 5_000 - 11 * 60_000 })
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      s.backend.add(phone, 'viewer', '', 'phone')
      await s.syncer.refresh()
      who.user = 'u2'
      s.backend.fetch.mockImplementation(FakeBackend.of('acct-2').fetch)
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ state: { acct: ACCT }, pending: [phone.pub], frozen: { reason: 'invalid' } })
      expect(s.store.archivedSuspended()).toEqual([])
    })

    it('one with no time recorded only freezes', async () => {
      const who = { user: 'u1' }
      const s = setup({ signIn: () => who.user, signInAt: null })
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      who.user = 'u2'
      s.backend.fetch.mockImplementation(FakeBackend.of('acct-2').fetch)
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ state: { acct: ACCT }, frozen: { reason: 'invalid' } })
    })

    it('one made just now starts it over', async () => {
      const who = { user: 'u1' }
      const s = setup({ signIn: () => who.user, signInAt: 5_000 - 9 * 60_000 })
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      who.user = 'u2'
      s.backend.fetch.mockImplementation(FakeBackend.of('acct-2').fetch)
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ state: { acct: 'acct-2' }, frozen: null, owner: 'u2' })
    })
  })

  describe('gossip waits for the new sign-in\'s first read', () => {
    it('neither judges nor says anything while the file is not this sign-in\'s', async () => {
      const who = { user: 'u1' }
      const s = setup({ signIn: () => who.user })
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      const other = FakeBackend.of(ACCT)
      other.add(evil, 'viewer', '', 'evil')
      other.add(phone, 'viewer', '', 'phone') // another entry at the same position: a fork
      who.user = 'u2'
      expect(s.syncer.gossip()).toBeUndefined()
      expect(s.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state), tail: other.entries })).toBeUndefined()
      expect(s.store.read().frozen).toBeNull()
      expect(s.store.read().state?.head).toEqual(s.backend.state.head)
      await s.syncer.refresh() // same account: the file is this sign-in's now
      expect(s.syncer.gossip()).toBeDefined()
      s.syncer.heard(box2.pub, { head: other.state.head, hashes: hashesOf(other.state) })
      expect(s.store.read().frozen?.reason).toBe('fork')
    })
  })

  describe('a suspension kept in another account\'s log shows, and lifts, in this one', () => {
    /** Signed in to ACCT, where a fork suspended evil; then signed in by hand to acct-2, whose log has evil. */
    const moved = async () => {
      const who = { user: 'u1' }
      const s = setup({ signIn: () => who.user })
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      s.backend.add(evil, 'viewer', '', 'evil')
      await s.syncer.refresh()
      s.store.update((f) => ({ ...f, suspended: [evil.pub] }))
      const b = FakeBackend.of('acct-2')
      b.add(phone, 'viewer', '', 'phone')
      b.add(evil, 'viewer', '', 'evil')
      who.user = 'u2'
      s.backend.fetch.mockImplementation(b.fetch)
      s.calls.adopt.mockClear()
      await s.syncer.refresh()
      return { s, who, b }
    }

    it('is suspended and new in the list, never adopted', async () => {
      const { s } = await moved()
      expect(s.store.read().state?.acct).toBe('acct-2')
      expect(s.syncer.list().members.find((m) => m.pub === evil.pub)).toMatchObject({ suspended: true, pending: true })
      expect(s.calls.adopt.mock.calls.flat(2).some((m: { pub: string }) => m.pub === evil.pub)).toBe(false)
    })

    it('"It\'s mine" lifts it here and in the kept log', async () => {
      const { s } = await moved()
      s.syncer.dismiss({ pub: evil.pub })
      expect(s.syncer.suspendedKeys()).not.toContain(evil.pub)
      expect(s.store.archivedSuspended()).not.toContain(evil.pub)
      expect(s.calls.adopt).toHaveBeenLastCalledWith([expect.objectContaining({ pub: evil.pub })])
    })

    it('a review does not lift it (it never showed it as suspended): only "It\'s mine" does', async () => {
      const { s } = await moved()
      await s.syncer.rebaseline(true)
      expect(s.syncer.suspendedKeys()).toContain(evil.pub)
      expect(s.store.archivedSuspended()).toContain(evil.pub)
      expect(s.syncer.list().members.find((m) => m.pub === evil.pub)).toMatchObject({ suspended: true, pending: true })
      expect(s.calls.adopt.mock.calls.flat(2).some((m: { pub: string }) => m.pub === evil.pub)).toBe(false)
    })

  })

  it('a kept log restored is suspended where another kept log says so', async () => {
    const who = { user: 'u1' }
    const s = setup({ signIn: () => who.user })
    const real = s.backend.fetch.getMockImplementation()!
    s.backend.add(box2, 'machine', MID2, 'box2')
    await s.syncer.register()
    s.backend.add(phone, 'viewer', '', 'phone')
    await s.syncer.refresh()
    s.syncer.dismiss({ pub: phone.pub })
    const b = FakeBackend.of('acct-2')
    b.add(phone, 'viewer', '', 'phone')
    who.user = 'u2'
    s.backend.fetch.mockImplementation(b.fetch)
    await s.syncer.refresh()
    // A fork in acct-2 suspended phone; then back to ACCT, where phone is on the list.
    s.store.update((f) => ({ ...f, suspended: [phone.pub] }))
    who.user = 'u3'
    s.backend.fetch.mockImplementation(real)
    await s.syncer.refresh()
    expect(s.store.read().state?.acct).toBe(ACCT)
    expect(s.syncer.list().members.find((m) => m.pub === phone.pub)).toMatchObject({ suspended: true, pending: true })
  })

  it('a review of another account\'s list after a sign-in keeps the one it leaves', async () => {
    const who = { user: 'u1' }
    // Made long ago: the new account's list freezes instead of starting over.
    const t = setup({ signIn: () => who.user, signInAt: 5_000 - 11 * 60_000 })
    t.backend.add(box2, 'machine', MID2, 'box2')
    await t.syncer.register()
    t.store.update((f) => ({ ...f, suspended: ['k'] }))
    who.user = 'u2'
    t.backend.fetch.mockImplementation(FakeBackend.of('acct-2').fetch)
    await t.syncer.refresh()
    expect(t.store.read()).toMatchObject({ state: { acct: ACCT }, frozen: { reason: 'invalid' } })
    await t.syncer.rebaseline(true)
    expect(t.store.read()).toMatchObject({ state: { acct: 'acct-2' }, frozen: null, owner: 'u2' })
    expect(t.store.archivedSuspended()).toEqual(['k'])
  })

  describe('another account\'s list under the sign-in the live log belongs to', () => {
    /** Signed in to ACCT, a new key K pending; the backend then serves an empty "acct-2" under the same sign-in. */
    const switched = async (signIn: boolean) => {
      const t = setup(signIn ? { signIn: () => 'u1' } : {})
      t.backend.add(box2, 'machine', MID2, 'box2')
      await t.syncer.register()
      t.backend.add(evil, 'viewer', '', 'K')
      await t.syncer.refresh()
      expect(t.store.read().pending).toEqual([evil.pub])
      t.backend.fetch.mockImplementation(FakeBackend.of('acct-2').fetch)
      await t.syncer.refresh()
      expect(t.store.read()).toMatchObject({ state: { acct: ACCT }, frozen: { reason: 'invalid' } })
      t.calls.adopt.mockClear(); t.calls.drop.mockClear(); t.calls.announce.mockClear(); t.calls.changed.mockClear(); t.calls.resume.mockClear()
      return t
    }

    for (const signIn of [true, false]) {
      it(`refuses the preview and the confirm (OTHER_ACCOUNT), writing nothing${signIn ? '' : ' (no sign-in recorded)'}`, async () => {
        const t = await switched(signIn)
        const before = JSON.stringify(t.store.read())
        expect(await t.syncer.rebaseline(false)).toEqual({ error: 'OTHER_ACCOUNT' })
        expect(await t.syncer.rebaseline(true)).toEqual({ error: 'OTHER_ACCOUNT' })
        expect(await t.syncer.rebaseline(true, FakeBackend.of('acct-2').state.head)).toEqual({ error: 'OTHER_ACCOUNT' })
        // Said before LOG_CHANGED: a confirm on another head is still about another account.
        expect(await t.syncer.rebaseline(true, { seq: 99, hash: 'x' })).toEqual({ error: 'OTHER_ACCOUNT' })
        expect(JSON.stringify(t.store.read())).toBe(before)
        expect(t.store.archivedFile(ACCT)).toBeNull()
        expect(t.store.archivedFile('acct-2')).toBeNull()
        expect(t.syncer.list().pending).toEqual([evil.pub])
        for (const c of [t.calls.adopt, t.calls.drop, t.calls.announce, t.calls.changed, t.calls.resume]) expect(c).not.toHaveBeenCalled()
      })
    }

    it('a file stamped by a sign-in, then this machine taken over by an adopted one: neither goes ahead', async () => {
      const who = { user: 'u1' }
      const t = setup({ signIn: () => who.user })
      t.backend.add(box2, 'machine', MID2, 'box2')
      await t.syncer.register()
      t.backend.add(evil, 'viewer', '', 'K')
      await t.syncer.refresh()
      t.backend.fetch.mockImplementation(FakeBackend.of('acct-2').fetch)
      await t.syncer.refresh()
      expect(t.store.read()).toMatchObject({ state: { acct: ACCT }, frozen: { reason: 'invalid' }, owner: 'u1', pending: [evil.pub] })
      who.user = `${ADOPTED_SIGN_IN}x` // an older binary refreshed the token: the sign-in by hand is gone
      const before = JSON.stringify(t.store.read())
      expect(await t.syncer.rebaseline(false)).toEqual({ error: 'OTHER_ACCOUNT' })
      expect(await t.syncer.rebaseline(true)).toEqual({ error: 'OTHER_ACCOUNT' })
      expect(JSON.stringify(t.store.read())).toBe(before)
      expect(t.store.archivedFile(ACCT)).toBeNull()
      expect(t.store.archivedFile('acct-2')).toBeNull()
    })

    /** A file no sign-in stamped yet (written before sign-ins were recorded, or by an older version after
     *  a downgrade) on ACCT with K pending; then the backend serves an empty "acct-2" under `epoch`. */
    const unstamped = async (epoch: string) => {
      const t = setup({ signIn: () => epoch, signInAt: 5_000 - 11 * 60_000 })
      t.backend.add(box2, 'machine', MID2, 'box2')
      await t.syncer.register()
      t.backend.add(evil, 'viewer', '', 'K')
      await t.syncer.refresh()
      t.store.update((f) => { const { owner: _o, ...rest } = f; return rest })
      t.backend.fetch.mockImplementation(FakeBackend.of('acct-2').fetch)
      await t.syncer.refresh()
      expect(t.store.read()).toMatchObject({ state: { acct: ACCT }, frozen: { reason: 'invalid' }, pending: [evil.pub] })
      expect(t.store.read().owner).toBeUndefined()
      return t
    }

    it('an unstamped file under an adopted sign-in (the session it was written under) refuses too', async () => {
      const t = await unstamped(`${ADOPTED_SIGN_IN}a`)
      const before = JSON.stringify(t.store.read())
      expect(await t.syncer.rebaseline(false)).toEqual({ error: 'OTHER_ACCOUNT' })
      expect(await t.syncer.rebaseline(true)).toEqual({ error: 'OTHER_ACCOUNT' })
      expect(JSON.stringify(t.store.read())).toBe(before)
      expect(t.store.archivedFile(ACCT)).toBeNull()
    })

    it('an unstamped file under a sign-in by hand is that sign-in moving accounts: the review goes ahead', async () => {
      const t = await unstamped('u2')
      expect(await t.syncer.rebaseline(true)).not.toHaveProperty('error')
      expect(t.store.read()).toMatchObject({ state: { acct: 'acct-2' }, frozen: null, owner: 'u2' })
      expect(t.store.archivedFile(ACCT)?.pending).toEqual([evil.pub])
    })
  })
})

describe('DeviceLogSyncer — a review (rebaseline --yes)', () => {
  const k5 = key(5), k6 = key(6), k7 = key(7)
  let t: ReturnType<typeof setup>

  it('after a sign-in to another account it froze on, a key added below the old joined point is news', async () => {
    const who = { user: 'u1' }
    // Every sign-in here was made long ago: the backend held the new account's log back past the window.
    const s = setup({ signIn: () => who.user, signInAt: 5_000 - 11 * 60_000 })
    s.backend.add(box2, 'machine', MID2, 'box2')
    s.backend.add(phone, 'viewer', '', 'phone')
    s.backend.add(k5, 'viewer', '', 'k5')
    s.backend.add(k6, 'viewer', '', 'k6')
    await s.syncer.refresh()
    expect(s.store.read().joinedSeq).toBe(4)
    const b = FakeBackend.of('acct-2')
    b.add(k7, 'viewer', '', 'k7')
    who.user = 'u2'
    s.backend.fetch.mockImplementation(b.fetch)
    await s.syncer.refresh()
    expect(s.store.read().frozen?.reason).toBe('invalid')
    await s.syncer.rebaseline(true) // "Trust again"
    expect(s.store.read()).toMatchObject({ state: { acct: 'acct-2' }, frozen: null, joinedSeq: 0 })
    s.calls.announce.mockClear()
    b.add(evil, 'viewer', '', 'evil') // seq 2: below the old account's joined point
    await s.syncer.refresh()
    expect(s.calls.announce).toHaveBeenCalledWith(expect.objectContaining({ pub: evil.pub }))
    expect(s.store.read().pending).toContain(evil.pub)
    expect(s.syncer.list().baseline).not.toContain(evil.pub)
  })

  it('after a rollback 4 → 1 it was reviewed on, a key added at 2 is news', async () => {
    t = setup()
    t.backend.add(box2, 'machine', MID2, 'box2')
    t.backend.add(phone, 'viewer', '', 'phone')
    t.backend.add(k5, 'viewer', '', 'k5')
    t.backend.add(k6, 'viewer', '', 'k6')
    await t.syncer.refresh()
    expect(t.store.read().joinedSeq).toBe(4)
    t.backend.lie = t.backend.entries.slice(0, 1)
    await t.syncer.refresh()
    expect(t.store.read().frozen?.reason).toBe('rollback')
    const preview = await t.syncer.rebaseline(false) as DeviceLogRebaseline
    expect(preview.added).toEqual([])
    await t.syncer.rebaseline(true, preview.head)
    expect(t.store.read()).toMatchObject({ frozen: null, joinedSeq: 1 })
    const rolled = new FakeBackend()
    rolled.add(box2, 'machine', MID2, 'box2') // the same entry 1
    rolled.add(evil, 'viewer', '', 'evil')
    t.backend.lie = null
    t.backend.fetch.mockImplementation(rolled.fetch)
    await t.syncer.refresh()
    expect(t.calls.announce).toHaveBeenCalledWith(expect.objectContaining({ pub: evil.pub }))
    expect(t.store.read().pending).toEqual([evil.pub])
  })

  describe('back to an account this machine kept the log of', () => {
    /** ACCT: phone new and pending, evil suspended by a fork, k7 joined and left before anyone looked;
     *  then a review after a sign-in to acct-2; then the backend serves ACCT again. Every sign-in was made
     *  long ago, so a list of another account freezes rather than starts over. */
    const away = async () => {
      const who = { user: 'u1' }
      const s = setup({ signIn: () => who.user, signInAt: 5_000 - 11 * 60_000 })
      const real = s.backend.fetch.getMockImplementation()!
      s.backend.add(box2, 'machine', MID2, 'box2')
      await s.syncer.register()
      s.backend.add(phone, 'viewer', '', 'phone')
      s.backend.add(evil, 'viewer', '', 'evil')
      s.backend.add(k7, 'viewer', '', 'k7')
      s.backend.removeBy(k7.pub, box2)
      await s.syncer.refresh()
      s.store.update((f) => ({ ...f, suspended: [evil.pub] }))
      const b = FakeBackend.of('acct-2')
      b.add(k5, 'viewer', '', 'k5')
      who.user = 'u2'
      s.backend.fetch.mockImplementation(b.fetch)
      await s.syncer.refresh()
      expect(await s.syncer.rebaseline(true)).not.toHaveProperty('error')
      expect(s.store.read()).toMatchObject({ state: { acct: 'acct-2' }, frozen: null, owner: 'u2' })
      s.backend.fetch.mockImplementation(real) // the backend says ACCT
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ state: { acct: 'acct-2' }, frozen: { reason: 'invalid' } })
      s.calls.announce.mockClear()
      s.calls.adopt.mockClear()
      return { s, who }
    }

    /** …and signed in again (by hand) — the only way back to ACCT. */
    const back = async () => {
      const { s, who } = await away()
      who.user = 'u3'
      await s.syncer.refresh()
      expect(s.store.read()).toMatchObject({ state: { acct: 'acct-2' }, frozen: { reason: 'invalid' } })
      return s
    }

    it('without a sign-in, neither the preview nor "Trust again" goes back to it', async () => {
      const { s } = await away()
      const before = JSON.stringify(s.store.read())
      expect(await s.syncer.rebaseline(false)).toEqual({ error: 'OTHER_ACCOUNT' })
      expect(await s.syncer.rebaseline(true)).toEqual({ error: 'OTHER_ACCOUNT' })
      expect(JSON.stringify(s.store.read())).toBe(before)
      expect(s.store.archivedFile(ACCT)?.pending).toEqual(expect.arrayContaining([phone.pub, evil.pub]))
      expect(s.calls.adopt).not.toHaveBeenCalled()
    })

    it('the preview compares against the kept log, not the account being left', async () => {
      const s = await back()
      const preview = await s.syncer.rebaseline(false) as DeviceLogRebaseline
      expect(preview.added).toEqual([])
      expect(preview.removed).toEqual([])
    })

    it('"Trust again" goes on from its marks: pending, departed, suspended, nothing re-announced', async () => {
      const s = await back()
      await s.syncer.rebaseline(true)
      const f = s.store.read()
      expect(f).toMatchObject({ state: { acct: ACCT }, frozen: null, owner: 'u3' })
      expect(f.pending).toEqual(expect.arrayContaining([phone.pub, evil.pub]))
      expect(f.suspended).toEqual([evil.pub])
      expect(f.departed?.map((d) => d.pub)).toEqual([k7.pub])
      expect(s.syncer.list().members.find((m) => m.pub === phone.pub)).toMatchObject({ pending: true, suspended: false })
      expect(s.syncer.list().members.find((m) => m.pub === evil.pub)).toMatchObject({ pending: true, suspended: true })
      expect(s.syncer.suspendedKeys()).toContain(evil.pub)
      expect(s.calls.announce).not.toHaveBeenCalled()
      expect(s.calls.adopt.mock.calls.flat(2).some((m: { pub: string }) => m.pub === evil.pub)).toBe(false)
      // Taken out of the archive; the account left is kept there instead.
      expect(s.store.archivedFile(ACCT)).toBeNull()
      expect(s.store.archivedFile('acct-2')?.state?.active[k5.pub]).toBeDefined()
    })

    it('goes on from its marks even when keeping the account left pushes it out of the archive', async () => {
      const s = await back()
      const live = s.store.read()
      for (const acct of ['x1', 'x2', 'x3']) s.store.archive({ ...live, state: { ...live.state!, acct } })
      await s.syncer.rebaseline(true)
      const f = s.store.read()
      expect(f.state?.acct).toBe(ACCT)
      expect(s.store.archivedFile(ACCT)).toBeNull()
      expect(f.suspended).toEqual([evil.pub])
      expect(f.pending).toEqual(expect.arrayContaining([phone.pub, evil.pub]))
      expect(f.departed?.map((d) => d.pub)).toEqual([k7.pub])
      expect(s.calls.announce).not.toHaveBeenCalled()
    })
  })

  describe('what the reviewed list took out', () => {
    beforeEach(async () => {
      t = setup()
      t.backend.add(box2, 'machine', MID2, 'box2')
      t.backend.add(k5, 'viewer', '', 'k5')
      await t.syncer.register()
      t.backend.add(phone, 'viewer', '', 'phone') // 4: new, pending
      await t.syncer.refresh()
      expect(t.store.read().pending).toEqual([phone.pub])
    })

    it('a pending key the reviewed list does not have stays flagged as departed', async () => {
      t.backend.lie = t.backend.entries.slice(0, 3)
      await t.syncer.refresh()
      expect(t.store.read().frozen?.reason).toBe('rollback')
      await t.syncer.rebaseline(true)
      expect(t.store.read().pending).toEqual([])
      expect(t.store.read().departed).toEqual([expect.objectContaining({ pub: phone.pub, label: 'phone', removedBy: '', selfRemoved: false })])
    })

    it('a pending key removed while frozen is departed, with who removed it', async () => {
      t.backend.lie = t.backend.entries.slice(0, 3)
      await t.syncer.refresh()
      t.backend.lie = null
      t.backend.removeBy(phone.pub, box2)
      await t.syncer.rebaseline(true)
      expect(t.store.read().departed).toEqual([expect.objectContaining({ pub: phone.pub, removedBy: box2.pub, removedByLabel: 'box2' })])
    })

    it('a key added and removed while frozen is departed; a reviewed-out key nobody flagged is not', async () => {
      t.backend.lie = t.backend.entries.slice(0, 3)
      await t.syncer.refresh()
      t.backend.lie = null
      t.backend.add(evil, 'viewer', '', 'evil')
      t.backend.removeBy(evil.pub, box2)
      t.backend.removeBy(k5.pub, box2) // known since joining: not new
      await t.syncer.rebaseline(true)
      expect(t.store.read().departed?.map((d) => d.pub)).toEqual([evil.pub])
      expect(t.store.read().departed?.[0]).toMatchObject({ label: 'evil', removedBy: box2.pub })
    })

    it('a key that joined and left before the freeze, and was looked at, is not flagged again', async () => {
      t.backend.add(k6, 'viewer', '', 'k6')
      t.backend.removeBy(k6.pub, box2)
      await t.syncer.refresh()
      expect(t.store.read().departed?.map((d) => d.pub)).toEqual([k6.pub])
      t.syncer.dismiss({ pub: k6.pub })
      t.backend.lie = t.backend.entries.slice(0, 5)
      await t.syncer.refresh()
      expect(t.store.read().frozen?.reason).toBe('rollback')
      t.backend.lie = null
      await t.syncer.rebaseline(true)
      expect(t.store.read().departed).toEqual([])
    })
  })
})
