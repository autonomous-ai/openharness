import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DAY, HOUR, row } from './fixtures.mjs'
import { DEFAULT_POLICY, decide, formatDuration, humanIdle, normalizePolicy, parseDuration, protectionFor, simulate } from '../lib/policy.mjs'

test('durations parse the units a person types, and refuse the rest', () => {
  assert.equal(parseDuration('4h'), 4 * HOUR)
  assert.equal(parseDuration('90m'), 90 * 60_000)
  assert.equal(parseDuration('14d'), 14 * DAY)
  assert.equal(parseDuration('1w'), 7 * DAY)
  assert.equal(parseDuration(1500), 1500)
  assert.throws(() => parseDuration('4 hours'), /Not a duration/)
  assert.throws(() => parseDuration('soon'), /Not a duration/)
  assert.throws(() => parseDuration(-1), /Not a duration/)
})

test('formatDuration round-trips whole units', () => {
  for (const value of ['30s', '15m', '4h', '3d', '2w']) assert.equal(formatDuration(parseDuration(value)), value)
})

test('humanIdle never shows two units', () => {
  assert.equal(humanIdle(10_000), 'now')
  assert.equal(humanIdle(22 * 60_000), '22m')
  assert.equal(humanIdle(4 * HOUR), '4h')
  assert.equal(humanIdle(3 * DAY + 4 * HOUR), '3d')
  assert.equal(humanIdle(15 * DAY), '2w')
  assert.equal(humanIdle(400 * DAY), '9w+')
})

test('a policy with a bad number fails at load, not mid-fleet', () => {
  assert.throws(() => normalizePolicy({ runningCeiling: -1 }), /runningCeiling/)
  assert.throws(() => normalizePolicy({ runningCeiling: 1.5 }), /runningCeiling/)
  assert.throws(() => normalizePolicy({ pauseAfterIdle: 'ages' }), /Not a duration/)
  assert.throws(() => normalizePolicy({ pauseAfterIdle: '2d', hideAfterIdle: '1d' }), /at least pauseAfterIdle/)
})

test('a policy keeps keys it does not know about', () => {
  const policy = normalizePolicy({ somethingNewer: 7 })
  assert.equal(policy.somethingNewer, 7)
  assert.equal(policy.runningCeiling, DEFAULT_POLICY.runningCeiling)
})

test('protections are reported in the order a person would say them', () => {
  const policy = normalizePolicy({})
  assert.equal(protectionFor(row({ pinned: true, working: true }), policy).by, 'pinned')
  assert.equal(protectionFor(row({ needsInput: true, working: true }), policy).by, 'needsInput')
  assert.equal(protectionFor(row({ working: true }), policy).by, 'working')
  assert.equal(protectionFor(row({ attached: true }), policy).by, 'attached')
  assert.equal(protectionFor(row(), policy), null)
})

test('the idle rules pause what has gone quiet and leave the fresh alone', () => {
  const rows = [
    row({ id: 'fresh', idleMs: 5 * 60_000 }),
    row({ id: 'stale', idleMs: 2 * DAY }),
    row({ id: 'ancient', idleMs: 20 * DAY }),
    row({ id: 'paused-stale', state: 'paused', idleMs: 20 * DAY, rssBytes: 0 }),
  ]
  const { entries, totals } = decide(rows, { runningCeiling: 99 })
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  assert.equal(byId.fresh.action, 'keep')
  assert.equal(byId.stale.action, 'pause')
  assert.equal(byId.stale.rule, 'pauseAfterIdle')
  assert.equal(byId.ancient.action, 'pause')
  assert.equal(byId['paused-stale'].action, 'keep', 'already paused: there is nothing left to do to it')
  assert.equal(totals.pause, 2)
})

test('the reason echoes the threshold as it was written, not as the clock reads it back', () => {
  const { entries } = decide([row({ idleMs: 20 * DAY })], { pauseAfterIdle: '90m' })
  assert.match(entries[0].why, /past 90m/)
})

test('the ceiling pauses the least recently active, and never a protected row', () => {
  const rows = [
    row({ id: 'a', idleMs: 2 * HOUR }),
    row({ id: 'b', idleMs: 3 * HOUR }),
    row({ id: 'c', idleMs: 4 * HOUR }),
    row({ id: 'pinned', idleMs: 9 * HOUR, pinned: true }),
  ]
  const { entries, totals } = decide(rows, { runningCeiling: 2 })
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  assert.equal(byId.a.action, 'keep')
  assert.equal(byId.b.action, 'keep')
  assert.equal(byId.c.action, 'pause')
  assert.equal(byId.c.rule, 'runningCeiling')
  assert.equal(byId.pinned.action, 'keep')
  assert.equal(totals.runningAfter, 3) // the pinned one still counts as running
})

test('a ceiling of zero still cannot pause what is protected', () => {
  const { entries } = decide([row({ id: 'p', pinned: true, idleMs: 3 * HOUR })], { runningCeiling: 0 })
  assert.equal(entries[0].action, 'keep')
})

test('a workspace that no longer exists is paused, whatever its idle time', () => {
  const { entries } = decide([row({ idleMs: 2 * HOUR, workspaceGone: true })], {})
  assert.equal(entries[0].action, 'pause')
  assert.equal(entries[0].rule, 'workspaceGone')
})

test('the loosened defaults leave yesterday afternoon alone', () => {
  const { entries } = decide([row({ id: 'yesterday', idleMs: 18 * HOUR }), row({ id: 'last-week', idleMs: 6 * DAY })], {})
  assert.equal(entries[0].action, 'keep')
  assert.equal(entries[1].action, 'pause')
})

test('simulate is the same plan, without the keeps', () => {
  const rows = [row({ id: 'a', idleMs: 2 * DAY }), row({ id: 'b', idleMs: 60_000 })]
  const result = simulate(rows, {})
  assert.equal(result.pause, 1)
  assert.equal(result.plan.length, 1)
  assert.equal(result.plan[0].id, 'a')
  assert.equal(result.frees, rows[0].rssBytes)
})

test('a shell is left alone by every rule, however old it is', () => {
  const { entries, totals } = decide([row({ state: 'terminal', idleMs: 40 * DAY, rssBytes: 0 })], { runningCeiling: 0 })
  assert.equal(entries[0].action, 'keep')
  assert.match(entries[0].why, /a shell, not an engine/)
  assert.equal(totals.pause, 0)
})

test('the default ceiling is a backstop: a normal busy day never reaches it', () => {
  const rows = Array.from({ length: 60 }, (_, i) => row({ id: `h${i}`, name: `h${i}`, idleMs: (i + 2) * HOUR / 4 }))
  const { totals } = decide(rows, {})
  assert.equal(totals.pause, 0, 'sixty harnesses used today, and the default pauses none of them')
})

test('the rules never plan a pause for something that could not come back', () => {
  const { entries, totals } = decide([
    row({ id: 'opencode', engine: 'opencode', idleMs: 9 * DAY, resumable: false }),
    row({ id: 'unbound', sessionId: null, idleMs: 9 * DAY, resumable: false }),
    row({ id: 'fine', idleMs: 9 * DAY, resumable: true }),
  ], {})
  const byId = Object.fromEntries(entries.map((entry) => [entry.id, entry]))
  assert.equal(byId.opencode.action, 'keep')
  assert.match(byId.opencode.why, /cannot resume opencode/)
  assert.equal(byId.unbound.action, 'keep')
  assert.match(byId.unbound.why, /no conversation bound/)
  assert.equal(byId.fine.action, 'pause')
  assert.equal(totals.pause, 1)
})

test('another machine\'s harnesses are never planned, and never count against this machine\'s ceiling', () => {
  const { entries, totals } = decide([row({ id: 'far', local: false, machine: 'studio', idleMs: 9 * DAY }), row({ id: 'near', idleMs: 9 * DAY })], { runningCeiling: 0 })
  assert.equal(entries.find((entry) => entry.id === 'far').action, 'keep')
  assert.equal(totals.pause, 1)
})
