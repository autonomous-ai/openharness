import { describe, expect, it } from 'vitest'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, type Conversation, type SuperTabState } from './model.js'
import { DEFAULT_ROUTING_POLICY } from './routingPolicy.js'
import { RELAYED_QUOTA, reviewCapacityNotice } from './reviewCapacity.js'

// Overnight 2026-10-30, 12 pull requests waited hours for a review: every Codex Reviewer was out of weekly quota, a Claude
// Reviewer may not check a Claude build, and nobody was told until people noticed in the morning (Tony: "don't let the
// workflow get stuck"). The notice says so in the project chat, once per cause, tagging who can fix it.

const NOW = 10_000_000
const HOUR = 3_600_000

type Window = { name: string; usedPercent: number }
function machine(id: string, name: string, contributorId: string, codex: { windows?: Window[]; known?: boolean; signedIn?: boolean } | null,
  extra: Partial<ContributedMachine> = {}): ContributedMachine {
  return { machineId: id, name, contributorId, membershipGeneration: 'g', generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: codex ? ['claude', 'codex'] : ['claude'],
    maxAgents: 4, paused: false, ...extra,
    observation: { generation: 'g1', receivedAt: NOW - 1000, sessionKind: 'computer',
      resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
        deviceType: null, chip: null, os: null, gpuPercent: null },
      tools: {}, runningHarnessIds: [], stoppedHarnessIds: [],
      readiness: { engines: [{ engine: 'claude', installed: true, signedIn: true }, ...codex ? [{ engine: 'codex', installed: true, signedIn: codex.signedIn ?? true }] : []] },
      quotas: codex ? [{ engine: 'codex', known: codex.known ?? true, windows: (codex.windows ?? []).map(w => ({ ...w, resetsAt: null })) }] : [],
      ...extra.observation } as ContributedMachine['observation'] }
}
const out = [{ name: 'weekly', usedPercent: 100 }]
const low = [{ name: 'weekly', usedPercent: 85 }]
const plenty = [{ name: '5-hour', usedPercent: 10 }, { name: 'weekly', usedPercent: 15 }]

/** A Swarm whose project has a build group [built] on [engine] and machines [machines]; Ken's project, Tony a teammate. */
function swarm(machines: ContributedMachine[], engine = 'claude', visibility: 'public' | 'private' = 'public') {
  const state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'ken', email: 'ken15@example.com' }, 'prod')
  state.people.push({ id: 'tony', email: 'tony@example.com', role: 'collaborator', generation: 'gt' }, { id: 'huy', email: 'huy@example.com', role: 'collaborator', generation: 'gh' })
  state.projects![0]!.visibility = visibility
  state.machines = machines
  const built: Conversation = { id: 'built', number: 7, title: 'Offline edits', leadId: null, agentIds: [], archived: false, brief: 'Build it.', checks: [], lastMessageSequence: 0,
    assignment: { id: 'a1', agentId: 'builder', status: 'review', configuration: { engine, model: 'claude-opus-4-7', effort: 'high' }, result: null } } as unknown as Conversation
  state.conversations.push(built)
  return { state, built, project: state.projects![0]! }
}
const anyMachine = () => true
const notice = (state: SuperTabState, group: Conversation, mayRun: (machineId: string) => boolean = anyMachine, now = NOW) =>
  reviewCapacityNotice(state, group, DEFAULT_ROUTING_POLICY, target => mayRun(target.machineId), now)

describe('the notice that new Reviewers cannot start', () => {
  it('says once in the project chat that no Codex Reviewer can start, naming each machine and tagging its owner', () => {
    const { state, built, project } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out }), machine('huy-mac', 'MacBookPro2021', 'huy', { windows: plenty, signedIn: false }),
      machine('tony-mac', 'MacBook Pro 19', 'tony', { windows: [{ name: '5-hour', usedPercent: 100 }, { name: 'weekly', usedPercent: 40 }] })])
    const first = notice(state, built)
    expect(first).toMatchObject({ conversationId: project.leadConversationId, mentions: ['ken', 'huy', 'tony'], source: { kind: 'review-capacity', engine: 'codex', cause: 'out' } })
    expect(first!.text).toBe('Reviews of Claude Code builds cannot start a new Reviewer: Codex is unavailable on every machine this project may use '
      + '(Mac Studio: out of quota; MacBookPro2021: signed out; MacBook Pro 19: out of quota). More Codex quota, Codex signed in on another machine, '
      + 'or another machine in the Swarm would unblock them. @ken15 @huy @tony can fix it.')
    // A person's own numbers are never shown to the others.
    expect(first!.text).not.toMatch(/\d+ ?%/)
    expect(notice(state, built, anyMachine, NOW + HOUR)).toBeNull()
  })

  it('warns once when every Codex machine is close to running out of weekly quota, and again when it runs out', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: low }), machine('tony-mac', 'MacBook Pro 19', 'tony', { windows: out })])
    const warned = notice(state, built)
    expect(warned).toMatchObject({ mentions: ['ken', 'tony'], source: { kind: 'review-capacity', engine: 'codex', cause: 'low' } })
    expect(warned!.text).toBe('Codex quota for reviewing Claude Code builds is close to running out on every machine this project may use '
      + '(Mac Studio: close to running out; MacBook Pro 19: out of quota). More Codex quota, Codex signed in on another machine, '
      + 'or another machine in the Swarm would keep reviews going. @ken15 @tony can fix it.')
    expect(notice(state, built)).toBeNull()
    state.machines![0]!.observation!.quotas[0]!.windows[0]!.usedPercent = 100
    expect(notice(state, built)).toMatchObject({ source: { cause: 'out' } })
    expect(notice(state, built)).toBeNull()
  })

  it('says nothing while one Codex machine has quota, and once it recovers, says it again the next time it runs out', () => {
    const { state, built, project } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out }), machine('tony-mac', 'MacBook Pro 19', 'tony', { windows: plenty })])
    expect(notice(state, built)).toBeNull()
    state.machines![1]!.observation!.quotas[0]!.windows = out.map(w => ({ ...w, resetsAt: null }))
    expect(notice(state, built)).toMatchObject({ source: { cause: 'out' } })
    state.machines![0]!.observation!.quotas[0]!.windows = plenty.map(w => ({ ...w, resetsAt: null }))
    expect(notice(state, built)).toBeNull()
    expect(project.reviewCapacity).toBeUndefined()
    state.machines![0]!.observation!.quotas[0]!.windows = out.map(w => ({ ...w, resetsAt: null }))
    expect(notice(state, built)).toMatchObject({ source: { cause: 'out' } })
  })

  it('counts a quota it cannot read as usable, as starts do, and says nothing with no Codex machine at all (Claude reviews at its top tier)', () => {
    const unread = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out }), machine('x', 'Unread', 'tony', { known: false })])
    expect(notice(unread.state, unread.built)).toBeNull()
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', null)])
    expect(notice(state, built)).toBeNull()
  })

  it('reads a Team account\'s quota from its Mac when the account spends that subscription through the relay', () => {
    const mac = machine('tony-mac', 'MacBook Pro 19', 'tony', { windows: out })
    const team = machine('tony-team', 'MacBook Pro 19', 'tony', { known: false }, { hostMachineId: 'tony-mac' })
    team.observation!.quotaReasons = { codex: RELAYED_QUOTA }
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out }), mac, team])
    // The Mac is named once: the account is that Mac.
    expect(notice(state, built)!.text).toContain('(Mac Studio: out of quota; MacBook Pro 19: out of quota)')
    // Unknown for another reason, the account stays usable, as a start there is.
    team.observation!.quotaReasons = { codex: 'The allowance reader on this machine did not answer.' }
    const again = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out }), mac, team])
    expect(notice(again.state, again.built)).toBeNull()
  })

  it('says nothing while a used-up window resets inside the start window, as the review rule waits for it (rules.ts)', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out })])
    state.machines![0]!.observation!.quotas[0]!.windows[0]!.resetsAt = new Date(NOW + 10 * 60_000).toISOString()
    expect(notice(state, built)).toBeNull()
    state.machines![0]!.observation!.quotas[0]!.windows[0]!.resetsAt = new Date(NOW + 3 * 24 * HOUR).toISOString()
    expect(notice(state, built)).toMatchObject({ source: { cause: 'out' } })
  })

  it('counts an offline machine as unavailable, and leaves out machines this project may not use', () => {
    const offline = machine('tony-mac', 'MacBook Pro 19', 'tony', { windows: plenty })
    offline.observation!.receivedAt = NOW - HOUR
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out }), offline, machine('ruled', 'Ruled out', 'huy', { windows: plenty })])
    const said = notice(state, built, id => id !== 'ruled')
    expect(said!.text).toContain('(Mac Studio: out of quota; MacBook Pro 19: offline)')
    expect(said!.mentions).toEqual(['ken', 'tony'])
  })

  it('tags only people who read the project, and names no machine of someone who does not', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out }), machine('tony-mac', 'Tony private Mac', 'tony', { windows: out })], 'claude', 'private')
    const said = notice(state, built)
    expect(said!.mentions).toEqual(['ken'])
    expect(said!.text).not.toContain('tony')
    expect(said!.text).not.toContain('Tony private Mac')
    expect(said!.text).toContain('(Mac Studio: out of quota; another machine: out of quota)')
  })

  it('neither counts nor names a Buddy-only machine, which is its person\'s alone', () => {
    const buddy = machine('buddy', 'Huy private laptop', 'huy', { windows: plenty }, { buddyOnly: true })
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out }), buddy])
    const said = notice(state, built)
    expect(said).toMatchObject({ mentions: ['ken'], source: { cause: 'out' } })
    expect(said!.text).not.toContain('Huy private laptop')
  })

  it('says nothing for a build on a grid model, which any strong engine reviews, or a group with no build', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out })])
    const grid = swarm([machine('studio', 'Mac Studio', 'ken', { windows: out })])
    grid.state.agents.push({ id: 'builder', gridModel: 'moonshotai/kimi-k3' } as never)
    expect(notice(grid.state, grid.built)).toBeNull()
    expect(notice(state, { ...built, assignment: null })).toBeNull()
  })

  it('reviews a Codex build with Claude, the same way', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { windows: plenty })], 'codex')
    state.machines![0]!.observation!.quotas = [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 100, resetsAt: null }] }]
    expect(notice(state, built)).toMatchObject({ source: { engine: 'claude', cause: 'out' } })
    expect(notice(state, built)).toBeNull()
  })
})
