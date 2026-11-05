import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { REPOSITORY_UNREACHABLE, repositoryReachOf, type RepositoryReach } from './repositoryReach.js'
import { TEAM_WRITTEN_WORK } from './teamWritten.js'

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
    const effects = applyCommand(state, owner, command, { now: NOW, operationId: `op-${++sequence}`, teamMachines: ['mac-team'],
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
  it('is refused at once in a Team account where the app is not installed, naming the repository and the install, and nothing is queued', () => {
    const f = swarm(), review = f.group({ reviewOf: f.group(), step: 'Review' })
    const error = refused(() => f.start(review, 'mac-team', { repositoryReach: notInstalled }))
    expect(error?.code).toBe(REPOSITORY_UNREACHABLE)
    expect(error?.status).toBe(409)
    expect(error?.message).toBe('An agent in this account reaches ngochuy13/groupme only through the Harness GitHub App, which is not installed on it. '
      + `An owner of ngochuy13 installs it (${INSTALL}), then start or assign it again.`)
    expect(f.state.starts ?? []).toEqual([])
  })

  it('says to approve it when the app is installed but nobody approved the repository for this project', () => {
    const f = swarm(), review = f.group({ reviewOf: f.group(), step: 'Review' })
    const error = refused(() => f.start(review, 'mac-team', { repositoryReach: notApproved }))
    expect(error?.code).toBe(REPOSITORY_UNREACHABLE)
    expect(error?.message).toBe('An agent in this account reaches ngochuy13/groupme only through the Harness GitHub App, and nobody who can push to it '
      + 'has approved it for this project. Someone who can push to it approves it in Harness (Project details, GitHub access), then start or assign it again.')
  })

  it('is refused where a start on the Mac moves into its Team account', () => {
    const f = swarm(), task = f.group()
    f.run({ type: 'work.assign', conversationId: task, agentId: f.member('team-builder', 'mac-team') })
    const review = f.group({ reviewOf: task, step: 'Review' })
    expect(refused(() => f.start(review, 'mac', { repositoryReach: notInstalled }))?.code).toBe(REPOSITORY_UNREACHABLE)
  })

  it('starts as before when the app covers it, when the read could not say, or with no read', () => {
    for (const repositoryReach of [{ state: 'covered', repository: 'ngochuy13/groupme' }, { state: 'unknown', repository: 'ngochuy13/groupme' }, undefined] as const) {
      const f = swarm(), review = f.group({ reviewOf: f.group(), step: 'Review' })
      f.start(review, 'mac-team', repositoryReach ? { repositoryReach } : {})
      expect(f.state.starts!.at(-1)!.request.machineId).toBe('mac-team')
    }
  })

  it('starts the owner\'s own work in their own account, which uses their own GitHub login', () => {
    const f = swarm()
    f.start(f.group(), 'mac', { repositoryReach: notInstalled, pushOrigin: 'clean' })
    expect(f.state.starts!.at(-1)!.request.machineId).toBe('mac')
  })

  it('names the install when it holds an own-account start for want of knowing who pushed', () => {
    const f = swarm(), review = f.group({ reviewOf: f.group(), step: 'Review' })
    const error = refused(() => f.start(review, 'mac', { repositoryReach: notInstalled, pushOrigin: 'unknown' }))
    expect(error?.code).toBe(TEAM_WRITTEN_WORK)
    expect(error?.message).toBe('GitHub cannot show who pushed this task\'s code because the Harness GitHub App is not installed on ngochuy13/groupme, '
      + 'so it may run only in a Team account, and a Team account reaches the repository only through that app. '
      + `An owner of ngochuy13 installs it (${INSTALL}); then it runs in your own account.`)
  })
})

describe('an assignment whose agent cannot reach the project repository', () => {
  it('is refused for a Team agent, and taken by the owner\'s agent in their own account', () => {
    const f = swarm(), task = f.group()
    expect(refused(() => f.run({ type: 'work.assign', conversationId: task, agentId: f.member('team-builder', 'mac-team') }, { repositoryReach: notInstalled }))?.code)
      .toBe(REPOSITORY_UNREACHABLE)
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
