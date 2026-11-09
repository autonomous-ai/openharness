import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { REPOSITORY_UNREACHABLE, repositoryReachOf, type RepositoryReach } from './repositoryReach.js'

// 11-05, Huy's groupme (task #3266): the Harness GitHub App was not on ngochuy13/groupme, so a Reviewer in the Mac's Team
// account, which reaches GitHub only through the app, failed to start twice and Claude was suspended there. Such a start
// is refused at once, naming what the owner must install or approve.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const requirements = { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const reading = (sessionKind: 'team' | 'computer') => ({ generation: 'g1', receivedAt: NOW, sessionKind, resources, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [],
  ...(sessionKind === 'team' ? { privacy: { mode: 'account' as const, passed: true as const, checkedAt: NOW - 1000, seenAt: NOW - 1000 } } : {}) })
const INSTALL = 'https://github.com/apps/harness-for-autonomous/installations/new'
const notInstalled: RepositoryReach = { state: 'not-installed', repository: 'ngochuy13/groupme', installUrl: INSTALL }
const notApproved: RepositoryReach = { state: 'not-approved', repository: 'ngochuy13/groupme' }

function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const generation = state.people.find(p => p.id === 'owner')!.generation
  const pool = (machineId: string, sessionKind: 'team' | 'computer', extra: Partial<ContributedMachine> = {}): ContributedMachine => ({ machineId, name: machineId, contributorId: 'owner',
    membershipGeneration: generation, generation: 'g1', cwd: '/swarm', scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false, observation: reading(sessionKind), ...extra })
  state.machines = [pool('mac', 'computer'), pool('mac-team', 'team', { hostMachineId: 'mac' })]
  state.projects!.find(p => p.id === 'lead')!.repository = { machineId: 'owner-host', cwd: '/repo', repositoryUrl: 'https://github.com/ngochuy13/groupme' }
  const run = (command: Command, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, owner, command, { now: NOW, operationId: `op-${++sequence}`,
      contribution: { machineOwnerId: 'owner', contributorId: 'owner', hostGrant: null }, ...context })
    state = effects.state
    return effects
  }
  const member = (id: string, machineId: string, machineOwnerId = 'owner') => {
    state.agents.push({ id, machineId, harnessId: `harness-${id}`, projectId: 'lead', machineOwnerId, contributorId: 'owner',
      membershipGeneration: generation, hostGrant: null, name: id, configuration: config })
    return id
  }
  const group = (extra: Partial<Extract<Command, { type: 'conversation.create' }>> = {}) => String(run({ type: 'conversation.create', projectId: 'lead', title: 'Work', brief: 'Build it.',
    checks: [], ...extra }).result.conversationId)
  const start = (conversationId: string, machineId: string, context: Partial<CommandContext> = {}) => run({ type: 'agent.start',
    request: { conversationId, machineId, engine: 'claude', name: 'Reviewer', cwd: '/swarm/lead', worktree: true, requirements } }, context)
  return { run, group, member, start, get state() { return state } }
}
const refused = (body: () => unknown): SuperTabError | null => {
  try { body(); return null } catch (error) { if (error instanceof SuperTabError) return error; throw error }
}

describe('a start whose account cannot reach the project repository', () => {
  it('starts the owner\'s own work in their own account, which uses their own GitHub login', () => {
    const f = swarm()
    f.start(f.group(), 'mac', { repositoryReach: notInstalled, pushOrigin: 'clean' })
    expect(f.state.starts!.at(-1)!.request.machineId).toBe('mac')
  })

  // Swarm v3 has no Team account to hold it (task #4120, the PM's ruling): code nobody can place runs on the project owner's own
  // computer, which reaches the repository with the owner's own GitHub login.
  it('starts work whose pusher GitHub cannot show on the project owner\'s own computer', () => {
    const f = swarm(), review = f.group({ reviewOf: f.group(), step: 'Review' })
    f.start(review, 'mac', { repositoryReach: notInstalled, pushOrigin: 'unknown' })
    expect(f.state.starts!.at(-1)!.request.machineId).toBe('mac')
  })
})

describe('an assignment whose agent cannot reach the project repository', () => {
  // A Team account's agent takes no new work at all in Swarm v3 (task #4120).
  it('is refused for a Team agent, and taken by the owner\'s agent in their own account', () => {
    const f = swarm(), task = f.group()
    expect(refused(() => f.run({ type: 'work.assign', conversationId: task, agentId: f.member('team-builder', 'mac-team') }))?.code)
      .toBe('TEAM_ACCOUNTS_REMOVED')
    expect(f.state.conversations.find(c => c.id === task)!.assignment).toBeNull()
    f.run({ type: 'work.assign', conversationId: task, agentId: f.member('own-builder', 'mac') }, { repositoryReach: notInstalled })
    expect(f.state.conversations.find(c => c.id === task)!.assignment?.agentId).toBe('own-builder')
  })

  it('is refused for a teammate\'s agent in the teammate\'s own account, which gets the app\'s token for another person\'s project', () => {
    const f = swarm(), task = f.group()
    expect(refused(() => f.run({ type: 'work.assign', conversationId: task, agentId: f.member('teammate-builder', 'mac', 'teammate') }, { repositoryReach: notApproved }))?.code)
      .toBe(REPOSITORY_UNREACHABLE)
  })
})

describe('the access Project details reads, as a start reads it', () => {
  it('keeps what says whether the app reaches the repository, and reads nothing it cannot be asked of', () => {
    expect(repositoryReachOf({ state: 'not-installed', repository: 'ngochuy13/groupme', installUrl: INSTALL, canApprove: true })).toEqual(notInstalled)
    expect(repositoryReachOf({ state: 'not-approved', repository: 'ngochuy13/groupme', canApprove: false, approvedFor: ['Other'] })).toEqual(notApproved)
    expect(repositoryReachOf({ state: 'covered', repository: 'ngochuy13/groupme' })).toEqual({ state: 'covered', repository: 'ngochuy13/groupme' })
    for (const access of [{ state: 'unavailable' }, { state: 'no-repository' }, { state: 'not-github', repositoryUrl: 'https://gitlab.com/a/b' }] as const) {
      expect(repositoryReachOf(access)).toBeUndefined()
    }
  })
})
