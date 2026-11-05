import { describe, expect, it } from 'vitest'
import type { Agent, MessageDraft, SuperTabState } from './model.js'
import { addFooting, pmFooting } from './pmFooting.js'

const NOW = Date.UTC(2026, 10, 5, 3, 0)
const DAY = 86_400_000

const agent = (id: string, machineId: string, engine = 'claude'): Agent => ({ id, name: id, contributorId: 'ken', membershipGeneration: 'g', machineId, harnessId: `h-${id}`,
  machineOwnerId: 'ken', configuration: { engine, model: 'opus', effort: 'high', contextWindow: null, engineVersion: null } } as unknown as Agent)

/** A Mac "Mac Studio" owned by ken, with a Harness Team account pool on it, and one reading of Claude's week on the Mac. */
function swarm(quotas: unknown, pmMachine = 'mac'): SuperTabState {
  const base = { contributorId: 'ken', membershipGeneration: 'g', generation: 'g', cwd: '/x', engines: ['claude'], maxAgents: 4, paused: false }
  return {
    version: 1, id: 'tab', name: 'Swarm', ownerId: 'ken', environment: 'prod', paused: false, invitations: [],
    people: [{ id: 'ken', email: 'ken@example.com', username: 'ken', role: 'owner', generation: 'g' }],
    agents: [agent('pm', pmMachine)], conversations: [],
    projects: [{ id: 'p1', name: 'openharness', ownerId: 'ken', leadConversationId: 'lead-p1', visibility: 'public', members: [], updateMinutes: 5 }],
    machines: [{ ...base, machineId: 'mac', name: 'Mac Studio', observation: { receivedAt: NOW, quotas } },
      { ...base, machineId: 'team', name: 'Mac Studio', hostMachineId: 'mac' }],
  } as unknown as SuperTabState
}
const known = [{ engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 10, resetsAt: null }, { name: 'weekly', usedPercent: 38, resetsAt: NOW + 3 * DAY + 3_600_000 }] }]
const pm = (state: SuperTabState) => state.agents[0]!

describe('the PM\'s footing line in every built-in wake', () => {
  it('says the machine, the account and the weekly quota left with its reset, when the reading is known', () => {
    expect(pmFooting(swarm(known), pm(swarm(known)), NOW)).toBe('You run on Mac Studio, ken\'s own account: weekly 62% left, resets in 3d.')
  })
  it('names a Harness Team account as that, with its Mac\'s name and the Mac\'s reading', () => {
    const state = swarm(known, 'team')
    expect(pmFooting(state, pm(state), NOW)).toBe('You run on Mac Studio, the Harness Team account: weekly 62% left, resets in 3d.')
  })
  it('leaves the reset out when only it is unknown, and says nothing at all when the week is unknown', () => {
    const noReset = [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 38, resetsAt: null }] }]
    expect(pmFooting(swarm(noReset), pm(swarm(noReset)), NOW)).toBe('You run on Mac Studio, ken\'s own account: weekly 62% left.')
    for (const quotas of [undefined, [], [{ engine: 'claude', known: false, windows: [] }], [{ engine: 'codex', known: true, windows: [{ name: 'weekly', usedPercent: 1, resetsAt: null }] }],
      [{ engine: 'claude', known: true, windows: [{ name: '5-hour', usedPercent: 1, resetsAt: null }] }]]) {
      const state = swarm(quotas)
      expect(pmFooting(state, pm(state), NOW), JSON.stringify(quotas)).toBeNull()
    }
  })
  it('says nothing for a machine the Swarm does not list, and never names an email', () => {
    const state = swarm(known, 'gone')
    expect(pmFooting(state, pm(state), NOW)).toBeNull()
    const noName = swarm(known)
    noName.people[0]!.username = undefined
    expect(pmFooting(noName, pm(noName), NOW) ?? '').not.toMatch(/@|example\.com/)
  })
  it('adds it once to each built-in wake the PM gets, and to no other message', () => {
    const state = swarm(known)
    const draft = (kind: string, over: Partial<MessageDraft> = {}) => ({ id: kind, conversationId: 'lead-p1', text: `A ${kind}.`, recipients: ['pm'], source: { kind }, ...over }) as unknown as MessageDraft
    const wakes = ['schedule-request', 'update-request', 'digest-request', 'notice-digest', 'work-lost', 'work-stalled', 'idle'].map(k => draft(k))
    const others = [draft('review-failed'), draft('idle', { id: 'to-other', recipients: ['eng'] })]
    const line = 'You run on Mac Studio, ken\'s own account: weekly 62% left, resets in 3d.'
    addFooting(state, pm(state), [...wakes, ...others], NOW)
    for (const w of wakes) expect(w.text, w.id).toBe(`A ${w.id}.\n\n${line}`)
    expect(others.map(o => o.text)).toEqual(['A review-failed.', 'A idle.'])
    addFooting(state, pm(state), wakes, NOW)
    for (const w of wakes) expect(w.text.split('You run on ').length, w.id).toBe(2)
  })
  it('leaves every wake as it is when the reading is unknown', () => {
    const state = swarm(undefined)
    const wake = { id: 'w', conversationId: 'lead-p1', text: 'Built-in schedule.', recipients: ['pm'], source: { kind: 'schedule-request' } } as unknown as MessageDraft
    addFooting(state, pm(state), [wake], NOW)
    expect(wake.text).toBe('Built-in schedule.')
  })
})
