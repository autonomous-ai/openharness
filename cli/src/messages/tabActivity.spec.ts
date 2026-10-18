import { describe, expect, it } from 'vitest'
import { ACTIVITY_IDLE_KEEP_MS, ACTIVITY_LEASE_MS, ACTIVITY_REFUSED_MS, ACTIVITY_RENEW_MS, ActivityIn, ActivityOut } from './tabActivity.js'

const TAB = 'a'.repeat(24)
const OTHER = 'b'.repeat(24)
describe('ActivityOut', () => {
  it('sends a change once, renews working every ACTIVITY_RENEW_MS, and sends idle once', () => {
    const out = new ActivityOut()
    expect(out.due(TAB, 0, { a1: { state: 'idle' } })).toEqual([{ agentId: 'a1', state: 'idle' }])
    expect(out.due(TAB, 5_000, { a1: { state: 'idle' } })).toEqual([])
    expect(out.due(TAB, 10_000, { a1: { state: 'working' } })).toEqual([{ agentId: 'a1', state: 'working' }])
    expect(out.due(TAB, 10_000 + ACTIVITY_RENEW_MS - 1, { a1: { state: 'working' } })).toEqual([])
    expect(out.due(TAB, 10_000 + ACTIVITY_RENEW_MS, { a1: { state: 'working' } })).toEqual([{ agentId: 'a1', state: 'working' }])
    expect(out.due(TAB, 40_000, { a1: { state: 'idle' } })).toEqual([{ agentId: 'a1', state: 'idle' }])
  })
  it('sends a changed summary at once under the same state, and not one that did not change', () => {
    const out = new ActivityOut()
    expect(out.due(TAB, 0, { a1: { state: 'idle', summary: 'Fix the login' } })).toEqual([{ agentId: 'a1', state: 'idle', summary: 'Fix the login' }])
    expect(out.due(TAB, 1, { a1: { state: 'idle', summary: 'Fix the login' } })).toEqual([])
    expect(out.due(TAB, 2, { a1: { state: 'idle', summary: 'Add a test' } })).toEqual([{ agentId: 'a1', state: 'idle', summary: 'Add a test' }])
    // A summary that went away is a change too: the other account stops showing the old one.
    expect(out.due(TAB, 3, { a1: { state: 'idle' } })).toEqual([{ agentId: 'a1', state: 'idle' }])
    expect(out.due(TAB, 4, { a1: { state: 'idle' } })).toEqual([])
  })
  it('sends at most 64 agents in a frame', () => {
    const out = new ActivityOut()
    const many = Object.fromEntries(Array.from({ length: 70 }, (_, i) => [`a${i}`, { state: 'working' as const }]))
    expect(out.due(TAB, 0, many)).toHaveLength(64)
  })
  it('stops asking a machine that refused for ACTIVITY_REFUSED_MS, for that tab only', () => {
    const out = new ActivityOut()
    expect(out.refusing(TAB, 'm', 0)).toBe(false)
    out.refused(TAB, 'm', 0)
    expect(out.refusing(TAB, 'm', ACTIVITY_REFUSED_MS - 1)).toBe(true)
    expect(out.refusing(TAB, 'm', ACTIVITY_REFUSED_MS)).toBe(false)
    expect(out.refusing(OTHER, 'm', 1)).toBe(false)
    expect(out.refusing(TAB, 'n', 1)).toBe(false)
  })
  it('prunes the tabs no longer held', () => {
    const out = new ActivityOut()
    out.due(TAB, 0, { a1: { state: 'idle' } })
    out.due(OTHER, 0, { a1: { state: 'idle' } })
    out.prune(new Set([OTHER]))
    expect(out.due(TAB, 1, { a1: { state: 'idle' } })).toHaveLength(1)
    expect(out.due(OTHER, 1, { a1: { state: 'idle' } })).toEqual([])
  })
  it('starts again for a tab it forgot', () => {
    const out = new ActivityOut()
    expect(out.due(TAB, 0, { a1: { state: 'idle' } })).toHaveLength(1)
    expect(out.due(TAB, 1, { a1: { state: 'idle' } })).toEqual([])
    out.forget(TAB)
    expect(out.due(TAB, 2, { a1: { state: 'idle' } })).toEqual([{ agentId: 'a1', state: 'idle' }])
  })
})

describe('ActivityIn', () => {
  it('takes only listed agents of the sending machine, with a lease for working', () => {
    const into = new ActivityIn()
    const taken = into.take(TAB, 'm1', [{ agentId: 'a1', state: 'working' }, { agentId: 'zz', state: 'working' }, { agentId: 'a2', state: 'bogus' }, { agentId: 7, state: 'working' }], (id) => id !== 'zz', 0)
    expect(taken).toEqual([{ sharedTabId: TAB, machineId: 'm1', agentId: 'a1', state: 'working', validForMs: ACTIVITY_LEASE_MS }])
    expect(into.snapshot(ACTIVITY_LEASE_MS - 1)).toEqual([{ sharedTabId: TAB, machineId: 'm1', agentId: 'a1', state: 'working', validForMs: 1 }])
    expect(into.snapshot(ACTIVITY_LEASE_MS)).toEqual([])
  })
  it('takes a summary cleaned and cut to SUMMARY_MAX: no control or format character, never wider than a row', () => {
    const into = new ActivityIn()
    const long = 'x'.repeat(500)
    const taken = into.take(TAB, 'm1', [
      { agentId: 'a1', state: 'working', summary: 'Fix \u202Etxt.exe\u001b[31m the login\u200b' },
      { agentId: 'a2', state: 'idle', summary: long },
      { agentId: 'a3', state: 'idle', summary: '\u202E\u200b' },
      { agentId: 'a4', state: 'idle', summary: 42 },
    ], () => true, 0)
    expect(taken.map((a) => a.summary)).toEqual(['Fix txt.exe[31m the login', 'x'.repeat(120), undefined, undefined])
    expect(taken[2]).not.toHaveProperty('summary')
    expect(taken[3]).not.toHaveProperty('summary')
  })
  it('also drops line and paragraph separators and cuts by characters, never through a surrogate pair', () => {
    const into = new ActivityIn()
    const [a, b] = into.take(TAB, 'm1', [{ agentId: 'a1', state: 'idle', summary: 'one\u2028two\u2029three' }, { agentId: 'a2', state: 'idle', summary: '😀'.repeat(300) }], () => true, 0)
    expect(a.summary).toBe('onetwothree')
    expect(b.summary).toBe('😀'.repeat(120))
  })
  it('keeps an idle entry that carries a summary in the snapshot for ACTIVITY_IDLE_KEEP_MS, then lets it go; one without, never', () => {
    expect(ACTIVITY_IDLE_KEEP_MS).toBe(10 * 60_000)
    const into = new ActivityIn()
    into.take(TAB, 'm1', [{ agentId: 'a1', state: 'idle', summary: 'Fix it' }, { agentId: 'a2', state: 'idle' }, { agentId: 'a3', state: 'unknown', summary: 'Hm' }], () => true, 0)
    expect(into.snapshot(ACTIVITY_IDLE_KEEP_MS - 1)).toEqual([
      { sharedTabId: TAB, machineId: 'm1', agentId: 'a1', state: 'idle', summary: 'Fix it', validForMs: 0 },
      { sharedTabId: TAB, machineId: 'm1', agentId: 'a3', state: 'unknown', summary: 'Hm', validForMs: 0 },
    ])
    expect(into.snapshot(ACTIVITY_IDLE_KEEP_MS)).toEqual([])
  })
  it('keeps a working entry with a summary only for its lease, and its summary with it', () => {
    const into = new ActivityIn()
    into.take(TAB, 'm1', [{ agentId: 'a1', state: 'working', summary: 'Fix it' }], () => true, 0)
    expect(into.snapshot(10_000)).toEqual([{ sharedTabId: TAB, machineId: 'm1', agentId: 'a1', state: 'working', summary: 'Fix it', validForMs: ACTIVITY_LEASE_MS - 10_000 }])
    expect(into.snapshot(ACTIVITY_LEASE_MS)).toEqual([])
  })
  it('answers for one harness of one machine and tab (tab_activity): working within its lease, otherwise as last heard, else nothing', () => {
    const into = new ActivityIn()
    into.take(TAB, 'm1', [{ agentId: 'a1', state: 'working', summary: 'Fix it' }, { agentId: 'a2', state: 'idle', summary: 'Done' }, { agentId: 'a3', state: 'idle' }], () => true, 0)
    expect(into.of(TAB, 'm1', 'a1', 1_000)).toEqual({ state: 'working', summary: 'Fix it' })
    // A sender that went away is not said to be working for longer than its lease: nothing is known.
    expect(into.of(TAB, 'm1', 'a1', ACTIVITY_LEASE_MS)).toEqual({ state: 'unknown' })
    // The sender tells idle once, so it is not forgotten with the snapshot's window.
    expect(into.of(TAB, 'm1', 'a2', ACTIVITY_IDLE_KEEP_MS * 3)).toEqual({ state: 'idle', summary: 'Done' })
    expect(into.of(TAB, 'm1', 'a3', 1)).toEqual({ state: 'idle' })
    expect(into.of(TAB, 'm1', 'zz', 1)).toBeUndefined()
    expect(into.of(OTHER, 'm1', 'a1', 1)).toBeUndefined()
    expect(into.of(TAB, 'm2', 'a1', 1)).toBeUndefined()
  })
  it('hears idle at once, and shows nothing for it afterwards', () => {
    const into = new ActivityIn()
    expect(into.take(TAB, 'm1', [{ agentId: 'a1', state: 'working' }], () => true, 0)).toHaveLength(1)
    expect(into.take(TAB, 'm1', [{ agentId: 'a1', state: 'idle' }], () => true, 2_000)).toEqual([{ sharedTabId: TAB, machineId: 'm1', agentId: 'a1', state: 'idle', validForMs: 0 }])
    expect(into.snapshot(2_001)).toEqual([])
  })
  it('takes at most one frame per machine and tab a second, and at most 64 agents', () => {
    const into = new ActivityIn()
    const agents = Array.from({ length: 65 }, (_, i) => ({ agentId: `a${i}`, state: 'working' }))
    expect(into.take(TAB, 'm1', agents, () => true, 0)).toHaveLength(64)
    expect(into.take(TAB, 'm1', [{ agentId: 'a1', state: 'idle' }], () => true, 999)).toEqual([])
    expect(into.snapshot(999)).toHaveLength(64)
    expect(into.snapshot(999).find((a) => a.agentId === 'a1')?.state).toBe('working')
    expect(into.take(TAB, 'm2', [{ agentId: 'a1', state: 'idle' }], () => true, 999)).toHaveLength(1)
    expect(into.take(TAB, 'm1', [{ agentId: 'a1', state: 'idle' }], () => true, 1_000)).toHaveLength(1)
  })
  it('ignores what is not a list of objects', () => {
    const into = new ActivityIn()
    expect(into.take(TAB, 'm1', 'x', () => true, 0)).toEqual([])
    expect(into.take(TAB, 'm1', null, () => true, 2_000)).toEqual([])
    expect(into.take(TAB, 'm1', [1, 'a', null], () => true, 4_000)).toEqual([])
  })
  it('prunes the tabs no longer held', () => {
    const into = new ActivityIn()
    into.take(TAB, 'm1', [{ agentId: 'a1', state: 'working' }], () => true, 0)
    into.take(OTHER, 'm1', [{ agentId: 'a1', state: 'working' }], () => true, 0)
    into.prune(new Set([OTHER]))
    expect(into.snapshot(1).map((a) => a.sharedTabId)).toEqual([OTHER])
  })
  it('forgets a tab: what it heard and its frame pace', () => {
    const into = new ActivityIn()
    into.take(TAB, 'm1', [{ agentId: 'a1', state: 'working' }], () => true, 0)
    into.take(OTHER, 'm1', [{ agentId: 'a1', state: 'working' }], () => true, 0)
    into.forget(TAB)
    expect(into.snapshot(1).map((a) => a.sharedTabId)).toEqual([OTHER])
    expect(into.take(TAB, 'm1', [{ agentId: 'a1', state: 'working' }], () => true, 1)).toHaveLength(1)
  })
})
