import { describe, expect, it } from 'vitest'
import {
  activityPhrase, COMPARE_HINT, deviceRegistration, deviceStatusValue, formatDeviceDetail, formatDeviceHistory, formatDeviceList, shortFingerprint, fullDateTime, isNewDevice,
  confirmsRemoval, logOrder, orderDevices, relativeAgo, removeConfirmation, type DeviceRow,
} from './deviceDisplay.js'

const NOW = Date.UTC(2026, 9, 1, 12, 0, 0)
const MIN = 60_000
const H = 60 * MIN
const D = 24 * H

describe('relativeAgo', () => {
  const cases: Array<[number, string]> = [
    [0, 'just now'], [59_000, 'just now'], [MIN, '1 minute ago'], [59 * MIN, '59 minutes ago'],
    [H, '1 hour ago'], [23 * H, '23 hours ago'], [24 * H, 'yesterday'], [47 * H, 'yesterday'],
    [2 * D, '2 days ago'], [13 * D, '13 days ago'], [14 * D, '2 weeks ago'], [59 * D, '8 weeks ago'],
    [60 * D, '2 months ago'], [364 * D, '12 months ago'], [365 * D, 'over a year ago'], [-5 * MIN, 'just now'],
  ]
  it.each(cases)('%i ms ago reads %s', (ago, text) => expect(relativeAgo(NOW - ago, NOW)).toBe(text))
})

describe('fullDateTime', () => {
  it('spells the local date and 24-hour time', () => {
    expect(fullDateTime(new Date(2026, 9, 1, 14, 5).getTime())).toBe('1 Oct 2026, 14:05')
  })
})

describe('activityPhrase', () => {
  it('says active now, last active, or added', () => {
    expect(activityPhrase(NOW - MIN, NOW - D, NOW)).toBe('active now')
    expect(activityPhrase(NOW - 2 * D, NOW - 30 * D, NOW)).toBe('last active 2 days ago')
    expect(activityPhrase(undefined, NOW - 21 * D, NOW)).toBe('added 3 weeks ago')
  })
  it('stops reading active now at 5 minutes', () => {
    expect(activityPhrase(NOW - 5 * MIN + 1, NOW - D, NOW)).toBe('active now')
    expect(activityPhrase(NOW - 5 * MIN, NOW - D, NOW)).toBe('last active 5 minutes ago')
  })
})

const row = (pub: string, addedAt: number, over: Partial<DeviceRow> = {}): DeviceRow =>
  ({ pub, label: pub, kind: 'viewer', machineId: '', addedAt, fingerprint: pub, self: false, ...over })

describe('orderDevices / isNewDevice', () => {
  it('puts this machine, then new devices (newest log entry first), then the rest by activity; ties keep log order', () => {
    const rows = [
      row('old-a', NOW - 90 * D, { seq: 1 }), row('self', NOW - 100 * D, { self: true, seq: 2 }), row('new-1', NOW - 2 * D, { seq: 3, firstSeen: NOW - 2 * D }),
      row('old-b', NOW - 80 * D, { seq: 4 }), row('new-2', NOW - D, { seq: 5, firstSeen: NOW - D }), row('old-c', NOW - 90 * D, { seq: 6 }),
    ]
    const out = orderDevices(rows, { 'old-a': NOW - 10 * D }, NOW).map((r) => r.pub)
    expect(out).toEqual(['self', 'new-2', 'new-1', 'old-a', 'old-b', 'old-c'])
  })
  it('orders the rest by addedAt when never seen, and a fresh lastSeen lifts an old device', () => {
    const rows = [row('a', NOW - 300 * D), row('b', NOW - 200 * D), row('c', NOW - 100 * D)]
    expect(orderDevices(rows, undefined, NOW).map((r) => r.pub)).toEqual(['c', 'b', 'a'])
    expect(orderDevices(rows, { a: NOW - MIN }, NOW).map((r) => r.pub)).toEqual(['a', 'c', 'b'])
  })
  it('does not reorder the input array', () => {
    const rows = [row('a', NOW - 300 * D), row('b', NOW - D)]
    orderDevices(rows, undefined, NOW)
    expect(rows.map((r) => r.pub)).toEqual(['a', 'b'])
  })
  it('flags a non-self device this machine first saw under 7 days ago', () => {
    expect(isNewDevice(row('x', 0, { firstSeen: NOW - 7 * D + 1 }), NOW)).toBe(true)
    expect(isNewDevice(row('x', 0, { firstSeen: NOW - 7 * D }), NOW)).toBe(false)
    expect(isNewDevice(row('x', 0, { firstSeen: NOW - D, self: true }), NOW)).toBe(false)
  })
  it('does not let the adding device hide itself by backdating its entry', () => {
    // `addedAt` is the entry's own `at`; the flag and the new-group order must not read it.
    const rows = [row('old', NOW - 90 * D, { seq: 1 }), row('liar', NOW - 400 * D, { seq: 2, firstSeen: NOW - 60_000 })]
    expect(isNewDevice(rows[1], NOW)).toBe(true)
    expect(orderDevices(rows, { old: NOW - D }, NOW).map((r) => r.pub)).toEqual(['liar', 'old'])
  })
  it('flags nothing when the daemon sent no firstSeen, even for a just-added row', () => {
    expect(isNewDevice(row('x', NOW - 60_000), NOW)).toBe(false)
  })
})

describe('logOrder', () => {
  it('sorts by seq and keeps array order without one', () => {
    expect(logOrder([row('b', 0, { seq: 5 }), row('a', 0, { seq: 2 })]).map((r) => r.pub)).toEqual(['a', 'b'])
    expect(logOrder([row('b', 0), row('a', 0)]).map((r) => r.pub)).toEqual(['b', 'a'])
  })
  it('is unaffected by activity or newness, so a number keeps naming one device', () => {
    const rows = [row('p', NOW - 50 * D, { seq: 1 }), row('q', NOW - 40 * D, { seq: 2 })]
    const before = logOrder(rows).map((r) => r.pub)
    // q opens a session: the display order flips, the numbering does not.
    expect(orderDevices(rows, { q: NOW - MIN }, NOW).map((r) => r.pub)).toEqual(['q', 'p'])
    expect(logOrder(rows).map((r) => r.pub)).toEqual(before)
  })
})

describe('deviceRegistration', () => {
  const file = (active: string[], removed: string[]) => ({
    state: { active: Object.fromEntries(active.map((p) => [p, {}])), removed },
    recent: [], frozen: null, notifiedUpTo: 0,
  }) as never
  it('tells the three states and the spent identity apart', () => {
    expect(deviceRegistration('p', file(['p'], []), false)).toBe('active')
    expect(deviceRegistration('p', file([], ['p']), false)).toBe('removed')
    expect(deviceRegistration('p', file([], []), false)).toBe('unregistered')
    expect(deviceRegistration(null, file([], []), true)).toBe('removed')
    expect(deviceRegistration(null, file([], []), false)).toBeNull()
  })
  it('words the status value', () => {
    expect(deviceStatusValue('AAAA', 'active')).toBe('AAAA  (in your account)')
    expect(deviceStatusValue(null, 'removed')).toBe('(removed — run harness login)')
    expect(deviceStatusValue(null, null)).toBeNull()
  })
})

const FP_SELF = 'E2FB·0DF5·5FD8·E6C7'
const FP_NEW = '1111·2222·3333·4444'
const FP_OLD = 'AAAA·BBBB·CCCC·DDDD'
const listing = () => ({
  members: [
    row('old', NOW - 90 * D, { seq: 1, label: 'old-mac', kind: 'machine', machineId: 'm_0123456789abcdef', fingerprint: FP_OLD }),
    row('self', NOW - 100 * D, { seq: 2, label: 'mbp', kind: 'machine', machineId: 'm_selfselfself', fingerprint: FP_SELF, self: true }),
    row('new', NOW - 2 * D, { seq: 3, firstSeen: NOW - 2 * D, label: '', fingerprint: FP_NEW }),
  ],
  lastSeen: { old: NOW - 3 * D, self: NOW - MIN },
})

describe('formatDeviceList', () => {
  it('shows self, new, rest in that order, each row keeping its stable log-order number', () => {
    const lines = formatDeviceList(listing(), NOW)
    expect(lines).toContain(`  This machine: mbp  ${FP_SELF}`)
    const rows = lines.filter((l) => /^\s+\d+\. /.test(l))
    expect(rows).toEqual([
      `    2. mbp  computer m_selfse  ${FP_SELF}  active now  (this machine)`,
      `    3. (no name)  app  ${FP_NEW}  added 2 days ago  new`,
      `    1. old-mac  computer m_012345  ${FP_OLD}  last active 3 days ago`,
    ])
    expect(lines.join('\n')).toContain('harness devices show <#|fingerprint>')
    // Removal is offered by key code, which cannot drift the way a number can.
    expect(lines.join('\n')).toContain('harness devices remove <fingerprint>')
    expect(lines.join('\n')).not.toContain('remove <#')
  })
  it('never prints an ISO-style date', () => {
    expect(formatDeviceList(listing(), NOW).join('\n')).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })
  it('falls back to the identity on disk when the log has no row for this machine', () => {
    const l = listing()
    l.members = l.members.filter((m) => !m.self)
    const lines = formatDeviceList(l, NOW, { label: 'mbp', fp: FP_SELF })
    expect(lines).toContain(`  This machine: mbp  ${FP_SELF}  (not registered yet)`)
    expect(lines.join('\n')).not.toContain('(this machine)')
  })
  it('prints no header at all without a self row or fallback', () => {
    const l = listing()
    l.members = l.members.filter((m) => !m.self)
    expect(formatDeviceList(l, NOW).join('\n')).not.toContain('This machine:')
  })
})

describe('formatDeviceDetail', () => {
  it('shows a computer in full, with the guidance and the remove hint', () => {
    const old = listing().members[0]
    const text = formatDeviceDetail(old, NOW - 3 * D, NOW).join('\n')
    expect(text).toContain('kind         Computer')
    expect(text).toContain(`added        ${fullDateTime(NOW - 90 * D)} (3 months ago)`)
    expect(text).toContain(`last active  3 days ago (${fullDateTime(NOW - 3 * D)})`)
    expect(text).toContain('machine      m_012345')
    expect(text).toContain(`key code     ${FP_OLD}`)
    expect(text).toContain(COMPARE_HINT)
    expect(text).toContain(`Not yours? harness devices remove ${FP_OLD}`)
    expect(text).not.toContain('This is this machine.')
  })
  it('shows an app without a machine row, and unknown activity', () => {
    const app = listing().members[2]
    const text = formatDeviceDetail(app, undefined, NOW).join('\n')
    expect(text).toContain('kind         App')
    expect(text).toContain('last active  unknown')
    expect(text).not.toContain('machine  ')
    expect(text).toContain('(no name)')
  })
  it('says this is this machine instead of offering removal', () => {
    const self = listing().members[1]
    const text = formatDeviceDetail(self, NOW - MIN, NOW).join('\n')
    expect(text).toContain('mbp  (this machine)')
    expect(text).toContain('This is this machine.')
    expect(text).not.toContain('Not yours?')
    expect(text).toContain(COMPARE_HINT)
  })
})

describe('removeConfirmation', () => {
  const num = (key: string) => ({ byNumber: true, key })
  const code = (key: string) => ({ byNumber: false, key })
  it('asks before removing by number at a terminal', () => {
    expect(removeConfirmation(num('2'), { yes: false, interactive: true })).toBe('ask')
  })
  it('refuses a number when nobody can see or answer the question', () => {
    expect(removeConfirmation(num('2'), { yes: false, interactive: false })).toBe('refuse')
  })
  it('goes ahead on a number or a short key-code start with --yes, terminal or not', () => {
    expect(removeConfirmation(num('2'), { yes: true, interactive: false })).toBe('go')
    expect(removeConfirmation(num('2'), { yes: true, interactive: true })).toBe('go')
    expect(removeConfirmation(code('1A'), { yes: true, interactive: false })).toBe('go')
  })
  it('treats a key-code start under 4 characters like a number', () => {
    expect(removeConfirmation(code('1A'), { yes: false, interactive: false })).toBe('refuse')
    expect(removeConfirmation(code('AAA'), { yes: false, interactive: true })).toBe('ask')
  })
  it('never asks for a key-code start of 4 or more characters, digits or not', () => {
    expect(removeConfirmation(code('AAAA'), { yes: false, interactive: false })).toBe('go')
    expect(removeConfirmation(code('E2FB0DF5'), { yes: false, interactive: false })).toBe('go')
    expect(removeConfirmation(code('12AB'), { yes: false, interactive: true })).toBe('go')
    expect(removeConfirmation(code('1111'), { yes: false, interactive: false })).toBe('go')
  })
  it('a list number is confirmed however many digits it has', () => {
    expect(removeConfirmation(num('1111'), { yes: false, interactive: false })).toBe('refuse')
    expect(removeConfirmation(num('1111'), { yes: false, interactive: true })).toBe('ask')
  })
})

describe('confirmsRemoval', () => {
  it.each(['y', 'Y', 'yes', 'YES', '  y  ', 'yes\n'])('%j removes', (a) => expect(confirmsRemoval(a)).toBe(true))
  it.each(['', 'n', 'no', 'yep', 'sure', 'y y', '\n'])('%j does not', (a) => expect(confirmsRemoval(a)).toBe(false))
})

describe('pending, taken and history display', () => {
  it('isNewDevice follows pending when the daemon sends it, else the 7-day rule', () => {
    expect(isNewDevice(row('x', 0, { pending: true, firstSeen: NOW - 30 * D }), NOW)).toBe(true)
    expect(isNewDevice(row('x', 0, { pending: false, firstSeen: NOW - D }), NOW)).toBe(false)
    expect(isNewDevice(row('x', 0, { pending: true, self: true }), NOW)).toBe(false)
  })
  it('words the taken status and shortens a key code', () => {
    const f = { state: { active: { h: {} }, removed: [] }, conflict: { pub: 'h' } } as never
    expect(deviceRegistration('p', f, false)).toBe('taken')
    expect(deviceStatusValue('AAAA', 'taken', 'E2FB·0DF5·5FD8·E6C7')).toBe('AAAA  (not registered — another key holds this computer: E2FB·0DF5…)')
    expect(shortFingerprint('E2FB·0DF5·5FD8·E6C7')).toBe('E2FB…')
  })
  it('lists conflict, suspended and pending lines and the history footer', () => {
    const lines = formatDeviceList({
      ...listing(), pending: ['new'], suspended: ['old'],
      conflict: { label: 'old-install', fingerprint: FP_OLD, addedAt: NOW - D, afterJoin: true },
    }, NOW).join('\n')
    expect(lines).toContain("Another key took this computer's place on your account after it joined: old-install · AAAA·BBBB·CCCC·DDDD. If you did not set up")
    expect(lines).not.toContain('added yesterday')
    expect(lines).toContain('New since you last looked — mark them seen: harness devices dismiss')
    expect(lines).toContain('History: harness devices history')
    const neutral = formatDeviceList({ ...listing(), conflict: { label: 'x', fingerprint: FP_OLD, addedAt: NOW, afterJoin: false } }, NOW).join('\n')
    expect(neutral).toContain('This computer is held by another key on your account: x')
    const susp = formatDeviceList({ members: listing().members.map((m) => (m.pub === 'old' ? { ...m, suspended: true } : m)) }, NOW).join('\n')
    expect(susp).toContain('Not trusted here until you review the list: old-mac')
    expect(susp).toMatch(/old-mac.*  suspended/)
  })
  it('lists a new key that joined and left before anyone looked, with how to dismiss it', () => {
    const gone = { label: 'Chrome', fingerprint: FP_NEW, removedBy: 'x', removedByLabel: '', selfRemoved: true }
    const lines = formatDeviceList({ ...listing(), pending: ['new'], departed: [
      gone,
      { ...gone, label: '', fingerprint: FP_OLD, removedBy: 'old', removedByLabel: 'old-mac', selfRemoved: false },
      { ...gone, label: 'iPad', removedBy: 'new', removedByLabel: 'Evil', selfRemoved: false },
    ] }, NOW)
    expect(lines).toContain(`  ⚠ Chrome joined and left before you looked — mark it seen: harness devices dismiss ${FP_NEW}`)
    expect(lines).toContain(`  ⚠ (no name) joined and left before you looked (removed by old-mac) — mark it seen: harness devices dismiss ${FP_OLD}`)
    expect(lines).toContain(`  ⚠ iPad joined and left before you looked (removed by a new device you have not looked at: Evil) — mark it seen: harness devices dismiss ${FP_NEW}`)
    expect(formatDeviceList(listing(), NOW).join('\n')).not.toContain('joined and left')
  })
  it('says nothing about who removed a departed key that nothing removed (a review of the list)', () => {
    const reviewed = { label: 'Chrome', fingerprint: FP_NEW, removedBy: '', removedByLabel: '', selfRemoved: false }
    const lines = formatDeviceList({ ...listing(), departed: [reviewed] }, NOW)
    expect(lines).toContain(`  ⚠ Chrome joined and left before you looked — mark it seen: harness devices dismiss ${FP_NEW}`)
    expect(lines.join('\n')).not.toContain('removed by')
  })
  it('formats the history', () => {
    const r = { seq: 3, op: 'removed' as const, pub: 'p', kind: 'machine' as const, machineId: 'abcdef0123456789', label: 'box', fingerprint: FP_OLD, by: { pub: 'q', label: 'mac', fingerprint: FP_SELF },
      at: new Date(2026, 9, 1, 14, 5).getTime(), thisDevice: false, afterJoin: true, pending: true, active: false, whileFrozen: true }
    const lines = formatDeviceHistory({ rows: [r], complete: false })
    expect(lines).toContain(`  3  1 Oct 2026, 14:05  removed  box  computer abcdef01  ${FP_OLD}  by mac  left before you looked  (applied while the list was frozen)`)
    expect(formatDeviceHistory({ rows: [{ ...r, active: true }], complete: true }).join('\n')).toMatch(/by mac  new  \(applied/)
    expect(lines).toContain('  Older history needs a connection.')
    // A signer with no known name is "another device", never an empty or raw-key label.
    const nameless = formatDeviceHistory({ rows: [{ ...r, by: { pub: 'q', label: '', fingerprint: FP_SELF } }], complete: true }).join('\n')
    expect(nameless).toContain('by another device (E2FB·0DF5…)')
    expect(formatDeviceHistory({ rows: [], complete: true })).toContain('  No history yet.')
  })
})
