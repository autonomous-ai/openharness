import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { b64e, newIdentity, sign } from '../lib/e2ee/core.js'
import { encodeRoster, keyChangeBytes, rosterBytes, type Roster } from './roster.js'
import { ALERT_WINDOW_MS, RosterStore, type RosterAlertCode } from './rosterStore.js'

const owner = newIdentity(), stranger = newIdentity()
const TAB = 'a1b2c3d4e5f6a1b2c3d4e5f6'
const roster = (version: number): Roster => ({
  sharedTabId: TAB, version, name: 'app',
  owner: { accountId: 'u-alice', email: 'a@x.io', machineId: 'alice-mac', machinePublicKey: b64e(owner.pub) },
  leader: null, members: [], invites: [],
  harnesses: [{ accountId: 'u-alice', machineId: 'alice-mac', machinePublicKey: b64e(owner.pub), agentId: 'lead', name: 'lead', engine: 'codex' }],
})
const signed = (version: number, by = owner) => {
  const r = roster(version), body = encodeRoster(r)
  return { body, signature: b64e(sign(by.priv, rosterBytes(TAB, version, body))) }
}

describe('the roster store', () => {
  let dir: string, path: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'rosters-')); path = join(dir, 'rosters.json') })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('says it changed after every save, so that Share derives its observers again, and not when nothing was saved', () => {
    let changes = 0
    const store = new RosterStore(path, Date.now, (kind) => { if (kind === 'tabs') changes++ })
    store.pin(TAB, b64e(owner.pub))
    expect(changes).toBe(1)
    store.pin(TAB, b64e(owner.pub))
    expect(store.offer(signed(2))).toEqual({ roster: roster(2) })
    expect(changes).toBe(2)
    expect(store.offer(signed(2))).toEqual({ stale: true })
    expect(changes).toBe(2)
    store.forget(TAB)
    expect(changes).toBe(3)
    // An alert is saved, but changes no tab: neither the observers nor the consent follow it (final review of 1b), and a
    // roster refused for its signature, at the relay's 20 frames a second, wakes nothing.
    store.pin(TAB, b64e(owner.pub))
    expect(changes).toBe(4)
    store.alert(TAB, 'own_machine_listed')
    expect(store.offer(signed(3, stranger))).toEqual({ error: 'bad_signature' })
    expect(changes).toBe(4)
    expect(store.alerts()).toHaveLength(2)
    store.forget(TAB)
    expect(changes).toBe(5)
    // What it saved is on disk by the time it says so.
    const seen: number[] = []
    const reader = new RosterStore(path, Date.now, () => { seen.push(RosterStore.readRosters(path)!.length) })
    reader.pin(TAB, b64e(owner.pub)); reader.offer(signed(3))
    expect(seen).toEqual([0, 1])
  })

  it('tells its owner whether tabs or only alerts changed', () => {
    const kinds: string[] = []
    const store = new RosterStore(path, () => 1_000, (kind) => kinds.push(kind))
    store.alert(TAB, 'bad_signature')
    store.pin(TAB, b64e(owner.pub))
    expect(kinds).toEqual(['alerts', 'tabs'])
  })

  it('releases a tab on the relay\'s word: the roster goes, the pin and the version held stay, and the same roster is taken back', () => {
    let changes = 0
    const store = new RosterStore(path, Date.now, () => { changes++ })
    store.release(TAB)
    expect(changes).toBe(0)
    store.pin(TAB, b64e(owner.pub)); store.offer(signed(3))
    store.release(TAB)
    expect(changes).toBe(3)
    expect(store.current(TAB)).toBeNull()
    expect(store.all()).toEqual([])
    expect(store.pinned(TAB)).toBe(b64e(owner.pub))
    // Read again from the file, released twice: the floor is the version it held, never lowered.
    const again = new RosterStore(path)
    again.release(TAB)
    expect(again.offer(signed(2))).toEqual({ stale: true })
    expect(again.offer(signed(3, stranger))).toEqual({ error: 'bad_signature' })
    expect(again.offer(signed(3))).toEqual({ roster: roster(3) })
    // A pin taken with no roster yet has no floor: any version it signed is taken.
    const fresh = new RosterStore(join(dir, 'fresh.json'))
    fresh.pin(TAB, b64e(owner.pub)); fresh.release(TAB)
    expect(fresh.offer(signed(1))).toEqual({ roster: roster(1) })
    // Forgotten, the pin goes too.
    again.forget(TAB)
    expect(again.pinned(TAB)).toBeNull()
  })

  it('takes nothing for a tab it never pinned', () => {
    expect(new RosterStore(path).offer(signed(1))).toEqual({ error: 'not_pinned' })
  })

  it('keeps the newest valid roster, and says an older or equal one is stale', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub))
    expect(store.offer(signed(2))).toEqual({ roster: roster(2) })
    expect(store.offer(signed(1))).toEqual({ stale: true })
    expect(store.offer(signed(2))).toEqual({ stale: true })
    expect(store.current(TAB)?.roster.version).toBe(2)
    expect(store.alerts()).toEqual([])
  })

  it('keeps the last valid roster and records an alert when a forged one arrives', () => {
    const store = new RosterStore(path, () => Date.parse('2026-10-15T10:00:00Z'))
    store.pin(TAB, b64e(owner.pub))
    store.offer(signed(2))
    expect(store.offer(signed(5, stranger))).toEqual({ error: 'bad_signature' })
    expect(store.current(TAB)?.roster.version).toBe(2)
    expect(store.alerts()).toEqual([{ id: expect.any(String), sharedTabId: TAB, at: '2026-10-15T10:00:00.000Z', error: 'bad_signature' }])
  })

  it('survives a restart, and keeps its file private', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub)); store.offer(signed(3))
    const again = new RosterStore(path)
    expect(again.current(TAB)?.roster.version).toBe(3)
    expect(again.all().map(r => r.version)).toEqual([3])
    expect(statSync(path).mode & 0o777).toBe(0o600)
  })

  it('persists the pin it was given', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub))
    expect(JSON.parse(readFileSync(path, 'utf8')).tabs[TAB].pinned).toBe(b64e(owner.pub))
  })

  it('forgets a tab entirely', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub)); store.offer(signed(1)); store.forget(TAB)
    expect(store.current(TAB)).toBeNull()
    expect(store.offer(signed(2))).toEqual({ error: 'not_pinned' })
  })

  it('moves an unreadable file aside, starts empty and records file_unreadable, rather than refusing to start', () => {
    const at = Date.parse('2026-10-15T10:00:00Z')
    writeFileSync(path, '{bad')
    const store = new RosterStore(path, () => at)
    expect(store.all()).toEqual([])
    expect(store.alerts()).toEqual([{ id: expect.any(String), sharedTabId: '', at: '2026-10-15T10:00:00.000Z', error: 'file_unreadable' }])
    // Kept for the person, under a name the next start never reads.
    expect(readFileSync(`${path}.unreadable-${at}`, 'utf8')).toBe('{bad')
    // The fresh file is the store's own: read again, it gives the same alert and no other.
    expect(new RosterStore(path, () => at + 1).alerts()).toHaveLength(1)
    // A file that reads but is not the store's shape is moved aside the same way.
    writeFileSync(path, JSON.stringify({ tabs: 7, alerts: [] }))
    const again = new RosterStore(path, () => at + 2)
    expect(again.alerts()).toEqual([{ id: expect.any(String), sharedTabId: '', at: '2026-10-15T10:00:00.002Z', error: 'file_unreadable' }])
    expect(readFileSync(`${path}.unreadable-${at + 2}`, 'utf8')).toBe('{"tabs":7,"alerts":[]}')
    again.pin(TAB, b64e(owner.pub))
    expect(new RosterStore(path).pinned(TAB)).toBe(b64e(owner.pub))
  })

  it('throws, and moves nothing aside, when the file cannot be read at all: it may be whole, and the next wake tries again', () => {
    // A folder where the file should be: reading it fails as EACCES, EMFILE or EIO would, never as bad contents.
    mkdirSync(path)
    expect(() => new RosterStore(path)).toThrow(expect.objectContaining({ code: 'EISDIR' }))
    expect(RosterStore.readRosters(path)).toBeNull()
    expect(readdirSync(dir)).toEqual(['rosters.json'])
  })

  it('reads the rosters for another process without writing, renaming or alerting; null when the file is unreadable', () => {
    expect(RosterStore.readRosters(path)).toEqual([])
    expect(readdirSync(dir)).toEqual([])
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub)); store.offer(signed(3))
    // A tab pinned with no roster yet, and one whose stored roster no longer verifies, give nothing.
    store.pin('b'.repeat(24), b64e(owner.pub))
    const state = JSON.parse(readFileSync(path, 'utf8'))
    state.tabs['c'.repeat(24)] = { pinned: b64e(stranger.pub), signed: signed(4) }
    writeFileSync(path, JSON.stringify(state))
    const before = readFileSync(path, 'utf8')
    expect(RosterStore.readRosters(path)).toEqual([roster(3)])
    expect(readFileSync(path, 'utf8')).toBe(before)
    writeFileSync(path, '{bad')
    expect(RosterStore.readRosters(path)).toBeNull()
    expect(readFileSync(path, 'utf8')).toBe('{bad')
    expect(readdirSync(dir)).toEqual(['rosters.json'])
  })

  it('says not pinned when the body hides its tab id, and when the tab is unknown', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub))
    expect(store.offer({ body: '{}', signature: '' })).toEqual({ error: 'not_pinned' })
    expect(store.current('ffffffffffffffffffffffff')).toBeNull()
  })

  it('stamps alerts with the real clock by default, and keeps only the latest fifty', () => {
    const store = new RosterStore(path)
    const codes: RosterAlertCode[] = ['foreign_machine', 'machine_key_mismatch', 'own_machine_listed', 'already_pinned']
    for (let i = 0; i < 52; i++) store.alert(`${i % 13}`.padStart(24, 'a'), codes[Math.floor(i / 13)])
    expect(store.alerts()).toHaveLength(50)
    expect(store.alerts()[0]).toMatchObject({ sharedTabId: '2'.padStart(24, 'a'), error: 'foreign_machine' })
    expect(Number.isNaN(Date.parse(store.alerts()[0].at))).toBe(false)
  })

  it('counts the same alert for the same tab within ALERT_WINDOW_MS on the last one, so a flood pushes no other out', () => {
    let clock = Date.UTC(2026, 9, 16)
    const store = new RosterStore(path, () => clock)
    store.pin(TAB, b64e(owner.pub))
    store.alert(TAB, 'foreign_machine')
    // A member's machine sending a bad roster 20 times a second for ten seconds: one alert, counted, at the last time.
    for (let i = 0; i < 200; i++) { clock += 50; store.offer(signed(i + 1, stranger)) }
    expect(store.alerts()).toEqual([{ id: expect.any(String), sharedTabId: TAB, at: new Date(Date.UTC(2026, 9, 16)).toISOString(), error: 'foreign_machine' },
      { id: expect.any(String), sharedTabId: TAB, at: new Date(clock).toISOString(), error: 'bad_signature', count: 200 }])
    // Kept on disk as counted; another tab's, or another error, is an alert of its own, and the latest comes last.
    expect(new RosterStore(path).alerts()).toEqual(store.alerts())
    store.alert('b'.repeat(24), 'bad_signature')
    store.alert(TAB, 'foreign_machine')
    expect(store.alerts().map((a) => [a.sharedTabId, a.error, a.count])).toEqual([
      [TAB, 'bad_signature', 200], ['b'.repeat(24), 'bad_signature', undefined], [TAB, 'foreign_machine', 2]])
    // Once the window has passed since the last, the next is a new alert.
    clock += ALERT_WINDOW_MS
    store.offer(signed(1, stranger))
    expect(store.alerts().map((a) => [a.error, a.count])).toEqual([['bad_signature', 200], ['bad_signature', undefined], ['foreign_machine', 2], ['bad_signature', undefined]])
  })

  it('keeps the held roster when a tab is pinned again, and drops one whose stored copy no longer verifies', () => {
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub)); store.offer(signed(1)); store.pin(TAB, b64e(owner.pub))
    expect(store.current(TAB)?.roster.version).toBe(1)
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.tabs[TAB].signed.body = file.tabs[TAB].signed.body.replace('"app"', '"evil"')
    writeFileSync(path, JSON.stringify(file))
    const again = new RosterStore(path)
    expect(again.current(TAB)).toBeNull()
    expect(again.all()).toEqual([])
  })

  it('refuses a roster whose body names two tabs, filing it under neither', () => {
    const TAB2 = 'b1b2c3d4e5f6a1b2c3d4e5f6'
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub)); store.pin(TAB2, b64e(owner.pub))
    const body2 = encodeRoster({ ...roster(1), sharedTabId: TAB2 })
    const body = `{"sharedTabId":"${TAB}",${body2.slice(1)}`
    const signature = b64e(sign(owner.priv, rosterBytes(TAB2, 1, body)))
    expect(store.offer({ body, signature })).toEqual({ error: 'malformed' })
    expect(store.current(TAB)).toBeNull()
    expect(store.alerts().map(a => a.error)).toEqual(['malformed'])
  })

  it('does not return a stored roster that names another tab than the one it is filed under', () => {
    const TAB2 = 'b1b2c3d4e5f6a1b2c3d4e5f6'
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub)); store.offer(signed(1))
    const file = JSON.parse(readFileSync(path, 'utf8'))
    file.tabs[TAB2] = file.tabs[TAB]
    writeFileSync(path, JSON.stringify(file))
    expect(new RosterStore(path).current(TAB2)).toBeNull()
  })

  it('refuses to replace a pin with a different key, records it, and lets the same key pin again', () => {
    const store = new RosterStore(path)
    expect(store.pin(TAB, b64e(owner.pub))).toBe('pinned')
    store.offer(signed(8))
    expect(store.pin(TAB, b64e(owner.pub))).toBe('pinned')
    expect(store.pin(TAB, b64e(stranger.pub))).toBe('already_pinned')
    expect(store.current(TAB)?.roster.version).toBe(8)
    expect(store.offer(signed(1, stranger))).toEqual({ error: 'bad_signature' })
    expect(store.alerts().map(a => a.error)).toEqual(['already_pinned', 'bad_signature'])
    store.forget(TAB)
    expect(store.pin(TAB, b64e(stranger.pub))).toBe('pinned')
  })

  it('moves the pin on a key change the old key signed, and then refuses the old key', () => {
    const next = newIdentity()
    const store = new RosterStore(path)
    store.pin(TAB, b64e(owner.pub)); store.offer(signed(1))
    const moved = encodeRoster({ ...roster(2), owner: { ...roster(2).owner, machinePublicKey: b64e(next.pub) } })
    const keyChange = { previousPub: b64e(owner.pub), signature: b64e(sign(owner.priv, keyChangeBytes(TAB, b64e(next.pub)))) }
    expect(store.offer({ body: moved, signature: b64e(sign(next.priv, rosterBytes(TAB, 2, moved))), keyChange })).toHaveProperty('roster')
    const again = new RosterStore(path)
    expect(again.current(TAB)?.roster.version).toBe(2)
    const third = encodeRoster({ ...roster(3), owner: { ...roster(2).owner, machinePublicKey: b64e(next.pub) } })
    expect(again.offer({ body: third, signature: b64e(sign(next.priv, rosterBytes(TAB, 3, third))) })).toHaveProperty('roster')
    expect(again.offer(signed(4))).toEqual({ error: 'unpinned_key' })
    expect(again.current(TAB)?.roster.version).toBe(3)
  })
  it('records an alert a member\'s own check raises, and keeps it across a restart', () => {
    const store = new RosterStore(path, () => Date.parse('2026-10-15T11:00:00Z'))
    store.alert(TAB, 'foreign_machine')
    store.alert(TAB, 'machine_key_mismatch')
    const expected = [{ id: expect.any(String), sharedTabId: TAB, at: '2026-10-15T11:00:00.000Z', error: 'foreign_machine' },
      { id: expect.any(String), sharedTabId: TAB, at: '2026-10-15T11:00:00.000Z', error: 'machine_key_mismatch' }]
    expect(store.alerts()).toEqual(expected)
    expect(new RosterStore(path).alerts()).toEqual(expected)
  })

  it('says which owner key a tab is pinned to, with or without a roster yet, and none once forgotten', () => {
    const store = new RosterStore(path)
    expect(store.pinned(TAB)).toBeNull()
    store.pin(TAB, b64e(owner.pub))
    expect(store.pinned(TAB)).toBe(b64e(owner.pub))
    store.offer(signed(1))
    expect(new RosterStore(path).pinned(TAB)).toBe(b64e(owner.pub))
    store.forget(TAB)
    expect(store.pinned(TAB)).toBeNull()
  })

  it('gives each alert an id, hides a dismissed one, and starts a new one when it happens again', () => {
    let t = 1_000
    const store = new RosterStore(path, () => t)
    store.alert(TAB, 'bad_signature')
    const [a] = store.alerts()
    expect(a).toMatchObject({ id: expect.any(String), sharedTabId: TAB, error: 'bad_signature' })
    expect(store.dismiss(a.id)).toBe(true)
    expect(store.alerts()).toEqual([])
    t += 1_000
    // Within ALERT_WINDOW_MS, but the last was dismissed.
    store.alert(TAB, 'bad_signature')
    expect(store.alerts()).toEqual([expect.objectContaining({ error: 'bad_signature' })])
    expect(store.alerts()[0].count).toBeUndefined()
    expect(store.alerts()[0].id).not.toBe(a.id)
    expect(store.dismiss(a.id)).toBe(false)
    expect(store.dismiss('nope')).toBe(false)
  })

  it('tells the windows of a dismissed alert, as an alert change only', () => {
    const kinds: string[] = []
    const store = new RosterStore(path, Date.now, (kind) => kinds.push(kind))
    store.alert(TAB, 'bad_signature')
    store.dismiss(store.alerts()[0].id)
    expect(kinds).toEqual(['alerts', 'alerts'])
    expect(new RosterStore(path).alerts()).toEqual([])
  })

  it('tells of an alert only when one is added or dismissed, never for a repeat counted on it (final review of 1c, I4)', () => {
    const kinds: string[] = []
    let t = 1_000
    const store = new RosterStore(path, () => t, (kind) => kinds.push(kind))
    for (let i = 0; i < 20; i++) { store.alert(TAB, 'bad_signature'); t += 50 }
    expect(store.alerts()).toEqual([expect.objectContaining({ error: 'bad_signature', count: 20 })])
    // The count is saved, but nobody is woken for it.
    expect(new RosterStore(path).alerts()[0].count).toBe(20)
    expect(kinds).toEqual(['alerts'])
    store.alert(TAB, 'malformed')
    store.dismiss(store.alerts()[0].id)
    expect(kinds).toEqual(['alerts', 'alerts', 'alerts'])
    // A file from 1b given ids on load wakes nobody either.
    writeFileSync(path, JSON.stringify({ tabs: {}, alerts: [{ sharedTabId: TAB, at: '2026-10-16T10:00:00.000Z', error: 'bad_signature' }] }))
    const told: string[] = []
    new RosterStore(path, Date.now, (kind) => told.push(kind))
    expect(told).toEqual([])
  })

  it('gives an id to an alert a file from 1b kept without one, and keeps it', () => {
    writeFileSync(path, JSON.stringify({ tabs: {}, alerts: [{ sharedTabId: TAB, at: '2026-10-16T10:00:00.000Z', error: 'bad_signature' }] }))
    const id = new RosterStore(path).alerts()[0].id
    expect(id).toEqual(expect.any(String))
    expect(new RosterStore(path).alerts()[0].id).toBe(id)
  })

  it('keeps an alert\'s id when it happens again, so it can still be dismissed', () => {
    let t = 1_000
    const store = new RosterStore(path, () => t)
    store.alert(TAB, 'bad_signature')
    const { id } = store.alerts()[0]
    t += 1_000
    store.alert(TAB, 'bad_signature')
    expect(store.alerts()).toEqual([expect.objectContaining({ id, count: 2 })])
    expect(store.dismiss(id)).toBe(true)
    expect(store.alerts()).toEqual([])
  })
})
