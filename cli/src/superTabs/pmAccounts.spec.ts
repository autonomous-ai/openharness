import { describe, expect, it } from 'vitest'
import { PM_ACCOUNT_NOTE, PM_DAY_NOTE, withPmAccounts } from './pmAccounts.js'
import type { Probe } from './route.js'

const probe = (patch: Partial<Probe> = {}): Probe => ({ kind: 'new', machineId: 'studio', machineName: 'Studio', engine: 'claude', model: 'opus',
  effort: 'high', quality: 3, cost: 3, quota: { known: true, leftPercent: 17, resetsAt: 1_000 }, activity: 'new', known: true, refusals: [], notes: [], ...patch })

/** What the backend sends an agent of openharness: its own PM, and lamp's (a project it may read) on the same Studio. */
const read = (over: Record<string, unknown> = {}) => ({
  pmAccounts: [{ machineId: 'studio', engine: 'claude', project: 'openharness', pm: 'River' }, { machineId: 'studio', engine: 'claude', project: 'lamp', pm: 'Faye' }],
  machines: [{ machineId: 'studio' }, { machineId: 'studio-team', hostMachineId: 'studio' }, { machineId: 'gray' }],
  ...over,
})
const both = PM_ACCOUNT_NOTE(['openharness (River)', 'lamp (Faye)'])

// Ken, 11-05: a PM started work on a machine and account another project's PM ran on, and could drain it until that PM
// stopped; the route said nothing about whose PM an account keeps alive.
describe('withPmAccounts', () => {
  it('notes every candidate on an account a PM runs on, naming each project and its PM', () => {
    const [onStudio, codex, elsewhere] = withPmAccounts(read(), [probe(), probe({ engine: 'codex' }), probe({ machineId: 'gray', machineName: 'Gray' })])
    expect(onStudio!.notes).toEqual([both])
    expect(PM_ACCOUNT_NOTE(['lamp (Faye)'])).toBe('This account runs the PM of lamp (Faye).')
    expect(codex!.notes).toEqual([])
    expect(elsewhere!.notes).toEqual([])
  })

  // As in production: a pool machine's probe names no subscription (machineId:engine), and a Team account's names its Mac
  // only while the relayed reading is fresh (review of #3134).
  it('counts a Mac\'s Harness Team account as the Mac\'s account, fresh relay or not', () => {
    const stale = probe({ machineId: 'studio-team' })
    const fresh = probe({ machineId: 'studio-team', quota: { known: true, leftPercent: 17, resetsAt: 1_000, account: 'studio:claude' } })
    expect(withPmAccounts(read(), [stale, fresh]).map(p => p.notes)).toEqual([[both], [both]])
    // A PM on the Team account, as the backend names it: its Mac.
    const onTeam = read({ pmAccounts: [{ machineId: 'studio-team', hostMachineId: 'studio', engine: 'claude', project: 'lamp', pm: 'Faye' }] })
    expect(withPmAccounts(onTeam, [probe()])[0]!.notes).toEqual([PM_ACCOUNT_NOTE(['lamp (Faye)'])])
  })

  it('follows the subscription a reading on the PM\'s Mac names to another machine signed in to it', () => {
    const own = probe({ quota: { known: true, leftPercent: 17, resetsAt: 1_000, account: 'sub-1' } })
    const sameSubscription = probe({ machineId: 'gray', quota: { known: true, leftPercent: 17, resetsAt: 1_000, account: 'sub-1' } })
    const other = probe({ machineId: 'gray', quota: { known: true, leftPercent: 80, resetsAt: 1_000, account: 'sub-2' } })
    expect(withPmAccounts(read(), [own, sameSubscription, other]).map(p => p.notes.length)).toEqual([1, 1, 0])
  })

  it('names a project the reader may not read as the backend sends it, and fills a missing name', () => {
    const hidden = read({ pmAccounts: [{ machineId: 'studio', engine: 'claude', project: 'another project', pm: 'its PM' }, { machineId: 'studio', engine: 'claude' }] })
    expect(withPmAccounts(hidden, [probe()])[0]!.notes).toEqual([PM_ACCOUNT_NOTE(['another project (its PM)'])])
  })

  // Ken, 11-05: a PM's account spends its week in daily shares of 17% of its weekly quota, unused days carried over; past
  // its share so far it takes no new work.
  it('says where a PM\'s account stands against its daily share: 17% per day since its weekly reset, carried over', () => {
    const D = 86_400_000, NOW = 1_800_000_000_000
    const week = (leftPercent: number, resetsIn: number) => probe({ quota: { known: true, leftPercent, resetsAt: NOW + resetsIn,
      windows: [{ name: '5-hour', leftPercent: 90, resetsAt: NOW + 3_600_000 }, { name: 'weekly', leftPercent, resetsAt: NOW + resetsIn }] } })
    // River at 15:38 on its first day: 10% used of 17%.
    expect(withPmAccounts(read(), [week(90, 7 * D - 11.6 * 3_600_000)], NOW)[0]!.notes).toEqual([both, PM_DAY_NOTE(1, 17, 10)])
    expect(PM_DAY_NOTE(1, 17, 10)).toBe('Day 1 of its week allows 17% of its weekly quota and it has used 10%, so it takes new work.')
    // Dee's account with 43 hours to its reset: day 6 allows 100%, 83% used.
    expect(withPmAccounts(read(), [week(17, 43 * 3_600_000)], NOW)[0]!.notes).toEqual([both, PM_DAY_NOTE(6, 100, 83)])
    // Past its share: day 2 allows 34%, 40% used.
    const over = withPmAccounts(read(), [week(60, 5.5 * D)], NOW)[0]!.notes
    expect(over).toEqual([both, PM_DAY_NOTE(2, 34, 40)])
    expect(PM_DAY_NOTE(2, 34, 40)).toBe('Day 2 of its week allows 34% of its weekly quota and it has used 40%, so it takes no new work.')
    // At the reset's own instant it is day 1; a reading whose reset has passed counts as day 7.
    expect(withPmAccounts(read(), [week(100, 7 * D)], NOW)[0]!.notes).toEqual([both, PM_DAY_NOTE(1, 17, 0)])
    expect(withPmAccounts(read(), [week(5, -D)], NOW)[0]!.notes).toEqual([both, PM_DAY_NOTE(7, 100, 95)])
    // No weekly window, or none with a reset: the PM note alone.
    expect(withPmAccounts(read(), [probe({ quota: { known: true, leftPercent: 50, resetsAt: null, windows: [{ name: 'weekly', leftPercent: 50, resetsAt: null }] } })], NOW)[0]!.notes).toEqual([both])
    // A candidate on no PM's account gets no day note.
    expect(withPmAccounts(read(), [{ ...week(60, 5.5 * D), machineId: 'gray' }], NOW)[0]!.notes).toEqual([])
  })

  it('leaves grid models and accounts with no machine or engine alone, and keeps a probe\'s own notes', () => {
    expect(withPmAccounts(read(), [probe({ gridModel: 'kimi', gridName: 'kimi' })])[0]!.notes).toEqual([])
    expect(withPmAccounts(read(), [probe({ notes: ['Its screen showed a usage limit.'] })])[0]!.notes).toEqual(['Its screen showed a usage limit.', both])
    expect(withPmAccounts(read({ pmAccounts: [{ machineId: 'studio' }, { engine: 'claude' }, 'x'] }), [probe()])[0]!.notes).toEqual([])
  })

  it('falls back, with a backend from before pmAccounts, to the PMs of the projects the reader sees', () => {
    const older = { projects: [{ id: 'p1', name: 'openharness', leadConversationId: 'lead-p1' }], conversations: [{ id: 'lead-p1', leadId: 'river' }],
      agents: [{ id: 'river', name: 'Lead', displayName: 'River', machineId: 'studio', configuration: { engine: 'claude' } }] }
    expect(withPmAccounts(older, [probe()])[0]!.notes).toEqual([PM_ACCOUNT_NOTE(['openharness (River)'])])
    // A project and a PM with no name read by their ids; a Swarm from before projects has its Lead conversation, `lead`.
    const bare = { projects: [{ id: 'p9', leadConversationId: 'lead-p9' }], conversations: [{ id: 'lead-p9', leadId: 'x' }],
      agents: [{ id: 'x', machineId: 'studio', configuration: { engine: 'claude' } }] }
    expect(withPmAccounts(bare, [probe()])[0]!.notes).toEqual([PM_ACCOUNT_NOTE(['p9 (x)'])])
    const legacy = { name: 'My Swarm', conversations: [{ id: 'lead', leadId: 'x' }], agents: [{ id: 'x', name: 'Lead', machineId: 'studio', configuration: { engine: 'claude' } }] }
    expect(withPmAccounts(legacy, [probe()])[0]!.notes).toEqual([PM_ACCOUNT_NOTE(['My Swarm (Lead)'])])
    expect(withPmAccounts({ conversations: [{ id: 'lead' }], agents: null }, [probe()])[0]!.notes).toEqual([])
  })
})
