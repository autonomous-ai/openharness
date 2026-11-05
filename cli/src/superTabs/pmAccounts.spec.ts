import { describe, expect, it } from 'vitest'
import { PM_ACCOUNT_NOTE, withPmAccounts } from './pmAccounts.js'
import type { Probe } from './route.js'

const probe = (patch: Partial<Probe> = {}): Probe => ({ kind: 'new', machineId: 'studio', machineName: 'Studio', engine: 'claude', model: 'opus',
  effort: 'high', quality: 3, cost: 3, quota: { known: true, leftPercent: 17, resetsAt: 1_000 }, activity: 'new', known: true, refusals: [], notes: [], ...patch })

/** Two projects: openharness led by River on the Studio's Claude, lamp led by Faye on the same Studio's Claude. */
const swarm = (over: Record<string, unknown> = {}) => ({
  projects: [{ id: 'p1', name: 'openharness', leadConversationId: 'lead-p1' }, { id: 'p2', name: 'lamp', leadConversationId: 'lead-p2' }],
  conversations: [{ id: 'lead-p1', leadId: 'river' }, { id: 'lead-p2', leadId: 'faye' }],
  agents: [{ id: 'river', name: 'Lead', displayName: 'River', machineId: 'studio', configuration: { engine: 'claude' } },
    { id: 'faye', name: 'Lead', displayName: 'Faye', machineId: 'studio', configuration: { engine: 'claude' } }],
  ...over,
})

// Ken, 11-05: a PM started work on a machine and account another project's PM runs on, and could drain it until that PM
// stopped; the route said nothing about whose PM an account keeps alive.
describe('withPmAccounts', () => {
  it('notes every candidate on an account a PM runs on, naming each project and its PM', () => {
    const [onStudio, codex, elsewhere] = withPmAccounts(swarm(), [probe(), probe({ engine: 'codex' }), probe({ machineId: 'gray', machineName: 'Gray' })])
    expect(onStudio!.notes).toEqual([PM_ACCOUNT_NOTE(['openharness (River)', 'lamp (Faye)'])])
    expect(PM_ACCOUNT_NOTE(['lamp (Faye)'])).toBe('This account runs the PM of lamp (Faye).')
    expect(codex!.notes).toEqual([])
    expect(elsewhere!.notes).toEqual([])
  })

  it('matches by the subscription a reading names, so a Team account on the PM\'s Mac counts as that account', () => {
    const team = probe({ machineId: 'studio-team', machineName: 'Studio', quota: { known: true, leftPercent: 17, resetsAt: 1_000, account: 'sub-1' } })
    const own = probe({ quota: { known: true, leftPercent: 17, resetsAt: 1_000, account: 'sub-1' } })
    const other = probe({ machineId: 'gray', quota: { known: true, leftPercent: 80, resetsAt: 1_000, account: 'sub-2' } })
    const out = withPmAccounts(swarm(), [team, own, other])
    expect(out.map(p => p.notes.length)).toEqual([1, 1, 0])
  })

  it('falls back to the PM\'s machine and engine when no candidate was probed there', () => {
    const state = swarm({ agents: [{ id: 'river', displayName: 'River', machineId: 'gray', configuration: { engine: 'codex' } }] })
    const [p] = withPmAccounts(state, [probe({ machineId: 'gray', engine: 'codex', quota: { known: false, leftPercent: null, resetsAt: null } })])
    expect(p!.notes).toEqual([PM_ACCOUNT_NOTE(['openharness (River)'])])
  })

  it('leaves grid models, projects with no PM and unreadable state alone, and keeps a probe\'s own notes', () => {
    const grid = probe({ gridModel: 'kimi', gridName: 'kimi' })
    const kept = probe({ notes: ['Its screen showed a usage limit.'] })
    expect(withPmAccounts(swarm(), [grid])[0]!.notes).toEqual([])
    expect(withPmAccounts(swarm(), [kept])[0]!.notes).toEqual(['Its screen showed a usage limit.', PM_ACCOUNT_NOTE(['openharness (River)', 'lamp (Faye)'])])
    expect(withPmAccounts(swarm({ conversations: [{ id: 'lead-p1' }] }), [probe()])[0]!.notes).toEqual([])
    expect(withPmAccounts({ projects: 'x', agents: null }, [probe()])[0]!.notes).toEqual([])
    // An agent named only by its session name is still named.
    const unnamed = swarm({ agents: [{ id: 'river', name: 'Lead', machineId: 'studio', configuration: { engine: 'claude' } }] })
    expect(withPmAccounts(unnamed, [probe()])[0]!.notes).toEqual([PM_ACCOUNT_NOTE(['openharness (Lead)'])])
    // A project or PM with no name reads by its id.
    const bare = { projects: [{ id: 'p9', leadConversationId: 'lead-p9' }], conversations: [{ id: 'lead-p9', leadId: 'x' }],
      agents: [{ id: 'x', machineId: 'studio', configuration: { engine: 'claude' } }] }
    expect(withPmAccounts(bare, [probe()])[0]!.notes).toEqual([PM_ACCOUNT_NOTE(['p9 (x)'])])
  })
})
