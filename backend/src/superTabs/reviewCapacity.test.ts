import { describe, expect, it } from 'vitest'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, type Conversation, type SuperTabState } from './model.js'
import { RELAYED_QUOTA, reviewCapacityNotice } from './reviewCapacity.js'

// Overnight 2026-10-30, 12 pull requests waited hours for a review while every Codex Reviewer was out of weekly quota, and
// nobody was told until people noticed in the morning (Tony: "don't let the workflow get stuck"). The notice speaks only when
// no new agent of either engine can start on any machine the project may use: once per cause, in the project chat, tagging
// who can fix it. No policy, quality or rules (project instructions, phase 4): a machine counts when the project may use it.

const NOW = 10_000_000
const HOUR = 3_600_000

type Window = { name: string; usedPercent: number }
/** An engine's reading on a machine: its windows, `unknown` when it cannot be read, or signed out. */
type Reading = Window[] | 'unknown' | { signedOut: Window[] }
function machine(id: string, name: string, contributorId: string, engines: { claude?: Reading; codex?: Reading },
  extra: Partial<ContributedMachine> = {}): ContributedMachine {
  const names = (['claude', 'codex'] as const).filter(e => engines[e] !== undefined)
  const windows = (r: Reading) => (Array.isArray(r) ? r : r === 'unknown' ? [] : r.signedOut).map(w => ({ ...w, resetsAt: null as string | null }))
  return { machineId: id, name, contributorId, membershipGeneration: 'g', generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: names,
    maxAgents: 4, paused: false, ...extra,
    observation: { generation: 'g1', receivedAt: NOW - 1000, sessionKind: 'computer',
      resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
        deviceType: null, chip: null, os: null, gpuPercent: null },
      tools: {}, runningHarnessIds: [], stoppedHarnessIds: [],
      readiness: { engines: names.map(e => ({ engine: e, installed: true, signedIn: !(typeof engines[e] === 'object' && !Array.isArray(engines[e])) })) },
      quotas: names.map(e => ({ engine: e, known: engines[e] !== 'unknown', windows: windows(engines[e]!) })),
      ...extra.observation } as ContributedMachine['observation'] }
}
const out = [{ name: 'weekly', usedPercent: 100 }]
const low = [{ name: 'weekly', usedPercent: 85 }]
const plenty = [{ name: '5-hour', usedPercent: 10 }, { name: 'weekly', usedPercent: 15 }]
const both = (w: Reading) => ({ claude: w, codex: w })

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
const notice = (state: SuperTabState, group: Conversation, teamOk: (machineId: string, contributorId: string) => boolean = anyMachine, now = NOW) =>
  reviewCapacityNotice(state, group, now, teamOk)

describe('the notice that new agents cannot start', () => {
  it('says when no machine the project may use can start either engine', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), machine('tony-mac', 'MacBook Pro 19', 'tony', both(out)),
      machine('huy-mac', 'Huy personal Mac', 'huy', both(plenty))])
    // Huy's machine has quota, but the project may not use it (machines.ts teamWorkCheck): it is not counted.
    const mayUse = (machineId: string) => machineId !== 'huy-mac'
    expect(notice(state, built, mayUse)).toMatchObject({ source: { kind: 'review-capacity', engine: 'any', cause: 'out' }, mentions: ['ken', 'tony'] })
    expect(notice(state, built, mayUse)).toBeNull()
    const usable = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), machine('tony-mac', 'MacBook Pro 19', 'tony', { claude: out, codex: plenty })])
    expect(notice(usable.state, usable.built)).toBeNull()
  })

  it('says nothing for a Claude build while Codex is out everywhere but Claude can start (Ken, 2026-10-30)', () => {
    // The morning of 10-30: every Codex out of weekly quota, Claude fine. Claude can start, so nobody is told.
    const { state, built, project } = swarm([machine('studio', 'Mac Studio', 'ken', { claude: plenty, codex: out }),
      machine('tony-mac', 'MacBook Pro 19', 'tony', { claude: plenty, codex: out })])
    expect(notice(state, built)).toBeNull()
    expect(project.reviewCapacity).toBeUndefined()
  })

  it('says once in the project chat that no agent of either engine can start, naming each machine and tagging its owner', () => {
    const { state, built, project } = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), machine('huy-mac', 'MacBookPro2021', 'huy', both({ signedOut: plenty })),
      machine('tony-mac', 'MacBook Pro 19', 'tony', { claude: out, codex: [{ name: '5-hour', usedPercent: 100 }, { name: 'weekly', usedPercent: 40 }] })])
    const first = notice(state, built)
    expect(first).toMatchObject({ conversationId: project.leadConversationId, mentions: ['ken', 'huy', 'tony'], source: { kind: 'review-capacity', engine: 'any', cause: 'out' } })
    expect(first!.text).toBe('No new agent can start: no machine this project may use can run Claude Code or Codex now '
      + '(Mac Studio: out of quota; MacBookPro2021: signed out; MacBook Pro 19: out of quota). @ken15 @huy @tony can fix it.')
    // A person's own numbers are never shown to the others.
    expect(first!.text).not.toMatch(/\d+ ?%/)
    expect(notice(state, built, anyMachine, NOW + HOUR)).toBeNull()
  })

  it('takes each machine at its best engine: one engine usable anywhere is enough', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { claude: out, codex: plenty })])
    expect(notice(state, built)).toBeNull()
    const codexOnly = swarm([machine('studio', 'Mac Studio', 'ken', { codex: plenty }), machine('tony-mac', 'MacBook Pro 19', 'tony', { claude: out })])
    expect(notice(codexOnly.state, codexOnly.built)).toBeNull()
  })

  it('counts a paused machine as unable to start an agent, as the route does', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', both(plenty), { paused: true })])
    expect(notice(state, built)!.text).toContain('(Mac Studio: paused)')
  })

  it('warns once when every machine is close to running out of weekly quota, and again when it runs out', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { claude: low, codex: out }), machine('tony-mac', 'MacBook Pro 19', 'tony', both(out))])
    const warned = notice(state, built)
    expect(warned).toMatchObject({ mentions: ['ken', 'tony'], source: { kind: 'review-capacity', engine: 'any', cause: 'low' } })
    expect(warned!.text).toBe('Quota for new agents is close to running out on every machine this project may use '
      + '(Mac Studio: close to running out; MacBook Pro 19: out of quota). @ken15 @tony can fix it.')
    expect(notice(state, built)).toBeNull()
    state.machines![0]!.observation!.quotas[0]!.windows[0]!.usedPercent = 100
    expect(notice(state, built)).toMatchObject({ source: { cause: 'out' } })
    expect(notice(state, built)).toBeNull()
  })

  it('says nothing while one machine has quota, and once it recovers, says it again the next time it runs out', () => {
    const { state, built, project } = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), machine('tony-mac', 'MacBook Pro 19', 'tony', { codex: plenty })])
    expect(notice(state, built)).toBeNull()
    state.machines![1]!.observation!.quotas[0]!.windows = out.map(w => ({ ...w, resetsAt: null }))
    expect(notice(state, built)).toMatchObject({ source: { cause: 'out' } })
    expect(project.reviewCapacity).toEqual({ any: 'out' })
    state.machines![0]!.observation!.quotas[0]!.windows = plenty.map(w => ({ ...w, resetsAt: null }))
    expect(notice(state, built)).toBeNull()
    expect(project.reviewCapacity).toBeUndefined()
    state.machines![0]!.observation!.quotas[0]!.windows = out.map(w => ({ ...w, resetsAt: null }))
    expect(notice(state, built)).toMatchObject({ source: { cause: 'out' } })
  })

  it('writes the project only when what it said changes, and drops a marker kept per engine before 2026-10-30', () => {
    const { state, built, project } = swarm([machine('studio', 'Mac Studio', 'ken', both(out))])
    project.reviewCapacity = { codex: 'out' }
    // An old server's marker says nothing of this rule, so the shortage is told once more, and the old key goes.
    expect(notice(state, built)).toMatchObject({ source: { cause: 'out' } })
    expect(project.reviewCapacity).toEqual({ any: 'out' })
    const kept = project.reviewCapacity
    expect(notice(state, built)).toBeNull()
    expect(project.reviewCapacity).toBe(kept)
  })

  it('counts a quota it cannot read as usable, as starts do, and says nothing with no machine for agents at all', () => {
    const unread = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), machine('x', 'Unread', 'tony', { codex: 'unknown' })])
    expect(notice(unread.state, unread.built)).toBeNull()
    const { state, built } = swarm([])
    expect(notice(state, built)).toBeNull()
  })

  it('reads a Team account\'s quota from its Mac when the account spends that subscription through the relay', () => {
    const mac = machine('tony-mac', 'MacBook Pro 19', 'tony', { codex: out })
    const team = machine('tony-team', 'MacBook Pro 19', 'tony', { codex: 'unknown' }, { hostMachineId: 'tony-mac' })
    team.observation!.quotaReasons = { codex: RELAYED_QUOTA }
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), mac, team])
    // The Mac is named once: the account is that Mac.
    expect(notice(state, built)!.text).toContain('(Mac Studio: out of quota; MacBook Pro 19: out of quota)')
    // Unknown for another reason, the account stays usable, as a start there is.
    team.observation!.quotaReasons = { codex: 'The allowance reader on this machine did not answer.' }
    const again = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), mac, team])
    expect(notice(again.state, again.built)).toBeNull()
  })

  it('says nothing while a used-up window resets inside the start window', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', { codex: out })])
    state.machines![0]!.observation!.quotas[0]!.windows[0]!.resetsAt = new Date(NOW + 10 * 60_000).toISOString()
    expect(notice(state, built)).toBeNull()
    state.machines![0]!.observation!.quotas[0]!.windows[0]!.resetsAt = new Date(NOW + 3 * 24 * HOUR).toISOString()
    expect(notice(state, built)).toMatchObject({ source: { cause: 'out' } })
  })

  it('counts an offline machine as unavailable, and leaves out machines this project may not use', () => {
    const offline = machine('tony-mac', 'MacBook Pro 19', 'tony', both(plenty))
    offline.observation!.receivedAt = NOW - HOUR
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), offline, machine('personal', 'Personal Mac', 'huy', both(plenty))])
    // Huy's personal machine takes no other person's project (machines.ts teamWorkCheck): left out altogether.
    const said = notice(state, built, (id, contributorId) => id !== 'personal' && contributorId !== 'huy')
    expect(said!.text).toContain('(Mac Studio: out of quota; MacBook Pro 19: offline)')
    expect(said!.mentions).toEqual(['ken', 'tony'])
  })

  it('tags only people who read the project, and names no machine of someone who does not', () => {
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), machine('tony-mac', 'Tony private Mac', 'tony', both(out))], 'claude', 'private')
    const said = notice(state, built)
    expect(said!.mentions).toEqual(['ken'])
    expect(said!.text).not.toContain('tony')
    expect(said!.text).not.toContain('Tony private Mac')
    expect(said!.text).toContain('(Mac Studio: out of quota; another machine: out of quota)')
  })

  it('neither counts nor names a Buddy-only machine, which is its person\'s alone', () => {
    const buddy = machine('buddy', 'Huy private laptop', 'huy', both(plenty), { buddyOnly: true })
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', both(out)), buddy])
    const said = notice(state, built)
    expect(said).toMatchObject({ mentions: ['ken'], source: { cause: 'out' } })
    expect(said!.text).not.toContain('Huy private laptop')
  })

  it('judges a Codex build and a grid build the same way, and says nothing for a group with no build', () => {
    const codex = swarm([machine('studio', 'Mac Studio', 'ken', { claude: plenty, codex: out })], 'codex')
    expect(notice(codex.state, codex.built)).toBeNull()
    const grid = swarm([machine('studio', 'Mac Studio', 'ken', both(out))])
    grid.state.agents.push({ id: 'builder', name: 'Builder', gridModel: 'moonshotai/kimi-k3' } as never)
    expect(notice(grid.state, grid.built)).toMatchObject({ source: { cause: 'out' } })
    const { state, built } = swarm([machine('studio', 'Mac Studio', 'ken', both(out))])
    expect(notice(state, { ...built, assignment: null })).toBeNull()
  })
})
