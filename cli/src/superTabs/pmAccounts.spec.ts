import { describe, expect, it } from 'vitest'
import { PM_ACCOUNT_NOTE, withPmAccounts } from './pmAccounts.js'
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
    expect(PM_ACCOUNT_NOTE(['lamp (Faye)'])).toBe('This account runs the PM of lamp (Faye). It keeps 20% of its week for its PM until the PM\'s daily spend is measured (3 days).')
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

  // Task #3222: the share an account keeps is what its PMs will spend until its weekly reset, measured; 20% until then.
  describe('the share a PM\'s account keeps', () => {
    const DAY = 86_400_000, now = Date.parse('2026-11-05T12:00:00Z')
    const measured = (share: number, extra: Record<string, unknown> = {}) => ({ machineId: 'studio', engine: 'claude', project: 'openharness', pm: 'River',
      daily: { share, days: 5 }, resetsAt: now + 2.5 * DAY, ...extra })
    const noteOf = (accounts: unknown[]) => withPmAccounts(read({ pmAccounts: accounts }), [probe()], now)[0]!.notes

    it('is the days to the reset × the PM\'s daily share, and says both', () => {
      expect(noteOf([measured(3)])).toEqual(['This account runs the PM of openharness (River). It keeps 7.5% of its week for its PM: 2.5 days to the reset × 3% a day.'])
    })

    it('is never under 5%, and is 20% while any PM on it is not measured', () => {
      expect(noteOf([measured(1, { resetsAt: now + DAY })])[0]).toContain('It keeps 5% of its week for its PM: 1 day to the reset × 1% a day.')
      const lamp = { machineId: 'studio', engine: 'claude', project: 'lamp', pm: 'Faye' }
      expect(noteOf([measured(3), lamp])[0]).toContain('It keeps 20% of its week for its PMs until each PM\'s daily spend is measured (3 days).')
      // Two measured PMs: their shares add up.
      expect(noteOf([measured(3), { ...measured(2), project: 'lamp', pm: 'Faye' }])[0]).toContain('It keeps 12.5% of its week for its PMs: 2.5 days to the reset × 5% a day.')
    })

    it('keeps more than 20% when the measured spend says so, measured or not', () => {
      expect(noteOf([measured(10)])[0]).toContain('It keeps 25% of its week for its PM: 2.5 days to the reset × 10% a day.')
      expect(noteOf([measured(10), { machineId: 'studio', engine: 'claude', project: 'lamp', pm: 'Faye' }])[0])
        .toContain('It keeps 25% of its week for its PMs')
    })

    it('takes the weekly reset from the candidate\'s own quota when the account names none', () => {
      // Its quota's own reset is the tightest window's, here the 5-hour one: the week's is in its windows.
      const p = probe({ quota: { known: true, leftPercent: 17, resetsAt: now + 3_600_000, windows: [{ name: '5-hour', leftPercent: 17, resetsAt: now + 3_600_000 },
        { name: 'weekly', leftPercent: 60, resetsAt: now + 4 * DAY }] } })
      expect(withPmAccounts(read({ pmAccounts: [measured(2, { resetsAt: undefined })] }), [p], now)[0]!.notes[0])
        .toContain('It keeps 8% of its week for its PM: 4 days to the reset × 2% a day.')
    })
  })
})
