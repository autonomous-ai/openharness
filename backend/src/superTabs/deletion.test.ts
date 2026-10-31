import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, stableId, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { indexesOf } from './parts/commit.js'
import { touchesFor } from './parts/touches.js'
import { isPersonalSwarm, PERSONAL_SWARM_OPERATION, SWARM_DELETE_GRACE_MS } from './deletion.js'

// Deleting a Swarm (deletion.ts): its owner alone, everyone else answered as for a Swarm that does not exist; every agent and
// machine goes with it; it leaves every list in the same write; its owner can restore it during the grace, and nobody after.

const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const viewer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'viewer', email: 'viewer@example.com' }
const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const NOW = 1_000_000

function fixture(id = 'tab') {
  let state = createSuperTab(id, 'Lampos', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const join = (who: Extract<Actor, { kind: 'person' }>, role: 'viewer' | 'collaborator') => {
    const invited = run({ type: 'invite.create', email: who.email, role, conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, who)
  }
  const add = (harnessId: string, machineId = 'host', lead = false) => run({ type: 'agent.add', conversationId: 'lead', machineId, harnessId, name: harnessId,
    configuration: config, lead }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId as string
  const contribute = (machineId = 'host') => {
    state.machines = [...(state.machines ?? []), { machineId, name: 'Studio', contributorId: 'owner', membershipGeneration: state.people[0]!.generation,
      generation: 'g1', cwd: '/repo', engines: ['claude'], maxAgents: 2, paused: false, observation: { generation: 'g1', receivedAt: NOW,
        resources: { cpuPercent: null, memoryTotalBytes: null, memoryUsedBytes: null, diskFreeBytes: null, diskTotalBytes: null, projectDiskFreeBytes: null,
          deviceType: null, chip: null, os: null, gpuPercent: null }, tools: {}, quotas: [], runningHarnessIds: [], stoppedHarnessIds: [] } } as never]
  }
  return { run, join, add, contribute, get state(): SuperTabState { return state }, set state(next: SuperTabState) { state = next } }
}

/** What applying [command] as [actor] threw, or 'applied'. */
const refusal = (f: ReturnType<typeof fixture>, command: Command, actor: Actor, context: Partial<CommandContext> = {}) => {
  try { f.run(command, actor, context); return 'applied' } catch (error) {
    const e = error as { code?: string; message: string; status?: number; unreachable?: boolean }
    return { code: e.code, message: e.message, status: e.status, unreachable: e.unreachable }
  }
}
const MISSING = { code: 'NOT_FOUND', message: 'This Super Tab is unavailable.', status: 404, unreachable: false }

describe('swarm.delete', () => {
  it('is its owner\'s alone: a collaborator, a viewer, an agent and a made-up agent are each answered as for a missing Swarm', () => {
    const f = fixture()
    f.join(peer, 'collaborator')
    f.join(viewer, 'viewer')
    const lead = f.add('lead', 'host', true)
    const del = { type: 'swarm.delete', name: 'Lampos' } as const
    for (const actor of [peer, viewer, { kind: 'agent', agentId: lead } as Actor, { kind: 'agent', agentId: 'made-up' } as Actor,
      { kind: 'person', userId: 'stranger', email: 'stranger@example.com' } as Actor]) {
      expect(refusal(f, del, actor)).toEqual(MISSING)
    }
    expect(f.state.deletion).toBeUndefined()
  })

  it('needs the Swarm\'s exact name, and refuses the owner\'s Personal Swarm', () => {
    const f = fixture()
    expect(refusal(f, { type: 'swarm.delete', name: 'lampos' }, owner)).toMatchObject({ code: 'NAME_MISMATCH', status: 400 })
    expect(refusal(f, { type: 'swarm.delete', name: '' }, owner)).toMatchObject({ code: 'NAME_MISMATCH' })
    const personalId = stableId('super-tab', 'prod', 'owner', PERSONAL_SWARM_OPERATION)
    const personal = fixture(personalId)
    expect(isPersonalSwarm(personal.state)).toBe(true)
    expect(refusal(personal, { type: 'swarm.delete', name: 'Lampos' }, owner)).toMatchObject({ code: 'PERSONAL_SWARM', status: 409 })
    expect(personal.state.deletion).toBeUndefined()
    // Another person's Personal Swarm id is not this owner's: only the owner's own request derives it.
    expect(isPersonalSwarm({ ...personal.state, ownerId: 'peer' })).toBe(false)
  })

  it('stops every agent, its Product Manager too, and releases every machine to its host\'s cleanup in the same write', () => {
    const f = fixture()
    f.contribute('host')
    const lead = f.add('lead', 'host', true), worker = f.add('worker', 'host'), shared = f.add('shared', 'elsewhere')
    const effects = f.run({ type: 'swarm.delete', name: ' Lampos ' })
    expect(f.state.agents).toEqual([])
    expect(new Set(effects.cancelledAgents)).toEqual(new Set([lead, worker, shared]))
    // Each session is closed by its host, and the contributed machine stays listed only for its cleanup.
    expect(new Set(f.state.closingSessions!.map(c => c.agentId))).toEqual(new Set([lead, worker, shared]))
    expect(f.state.machines).toEqual([expect.objectContaining({ machineId: 'host', paused: true, removal: expect.objectContaining({ state: 'cleaning' }) })])
    expect(f.state.deletion).toEqual({ at: new Date(NOW).toISOString(), by: 'owner', purgeAt: new Date(NOW + SWARM_DELETE_GRACE_MS).toISOString() })
    expect(effects.result.purgeAt).toBe(f.state.deletion!.purgeAt)
  })

  it('fails starts not yet launched, and waits for one already launching', () => {
    const f = fixture()
    const start = (id: string, dispatched: boolean) => ({ id, creationId: 'c', actorKey: 'person:owner', contributorId: 'owner',
      membershipGeneration: f.state.people[0]!.generation, machineOwnerId: 'owner', hostGrant: null, ...(dispatched ? { dispatched: true } : {}),
      request: { conversationId: 'lead', machineId: 'host', engine: 'claude', name: 'Builder', cwd: '/repo', worktree: true,
        requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }) as never
    f.state.starts = [start('queued', false), start('launching', true)]
    expect(refusal(f, { type: 'swarm.delete', name: 'Lampos' }, owner)).toMatchObject({ code: 'STARTS_PENDING' })
    f.state.starts = [start('queued', false)]
    f.run({ type: 'swarm.delete', name: 'Lampos' })
    expect(f.state.starts![0]!.error).toBe('Its Swarm was deleted.')
  })

  it('leaves every person\'s and invitee\'s lists in the same write, and keeps its machines indexed for their cleanup', () => {
    const f = fixture()
    f.join(peer, 'collaborator')
    f.run({ type: 'invite.create', email: 'later@example.com', role: 'viewer', conversationId: 'lead' })
    f.contribute('host')
    f.add('worker', 'host')
    expect(indexesOf(f.state)).toMatchObject({ memberIds: ['owner', 'peer'], invitedEmails: ['later@example.com'], deletedAt: null, purgeAt: null })
    f.run({ type: 'swarm.delete', name: 'Lampos' })
    expect(indexesOf(f.state)).toMatchObject({ memberIds: [], invitedEmails: [], machineIds: ['host'], cleanupMachineIds: ['host'],
      deletedAt: new Date(NOW), purgeAt: new Date(NOW + SWARM_DELETE_GRACE_MS) })
    // People and invitations are kept, for a restore; only the index stops naming them.
    expect(f.state.people.map(p => p.id)).toEqual(['owner', 'peer'])
  })
})

describe('a write racing the delete', () => {
  it('meets it: the delete moves every person\'s part, which each person\'s own write relies on', () => {
    const f = fixture()
    f.join(peer, 'collaborator')
    f.join(viewer, 'viewer')
    const before = f.state
    const effects = f.run({ type: 'swarm.delete', name: 'Lampos' })
    const touched = touchesFor({ type: 'swarm.delete', name: 'Lampos' }, owner, before, effects).filter(t => t.kind === 'member').map(t => t.key)
    expect(new Set(touched)).toEqual(new Set(['owner', 'peer', 'viewer']))
  })
})

describe('a deleted Swarm', () => {
  const deleted = () => {
    const f = fixture()
    f.join(peer, 'collaborator')
    f.contribute('host')
    f.add('worker', 'host')
    f.run({ type: 'swarm.delete', name: 'Lampos' })
    return f
  }

  it('answers every other command, from anyone, its owner too, as a missing Swarm does', () => {
    const f = deleted()
    const commands: Command[] = [{ type: 'message.send', conversationId: 'lead', text: 'hello', replyTo: null, recipientIds: [] },
      { type: 'tab.rename', name: 'Back' }, { type: 'swarm.delete', name: 'Lampos' }, { type: 'invite.create', email: 'x@example.com', role: 'viewer', conversationId: 'lead' },
      { type: 'project.create', name: 'New', visibility: 'public', brief: '' } as Command]
    for (const command of commands) for (const actor of [owner, peer]) expect(refusal(f, command, actor)).toEqual(MISSING)
    // An invitation sent before the deletion cannot be accepted either.
    const g = fixture()
    const invite = g.run({ type: 'invite.create', email: peer.email, role: 'viewer', conversationId: 'lead' }).result.inviteId as string
    g.run({ type: 'swarm.delete', name: 'Lampos' })
    expect(refusal(g, { type: 'invite.accept', inviteId: invite }, peer)).toEqual(MISSING)
  })

  it('still takes its hosts\' close and cleanup confirmations, so their agents stop and folders go', () => {
    const f = deleted()
    const closing = f.state.closingSessions![0]!
    f.run({ type: 'agent.sessionClosed', agentId: closing.agentId, harnessId: closing.harnessId } as Command, owner)
    expect(f.state.closingSessions ?? []).toEqual([])
    const removal = f.state.machines![0]!.removal!
    f.run({ type: 'machine.cleaned', machineId: 'host', removalId: removal.id }, owner)
    expect(f.state.machines ?? []).toEqual([])
    expect(indexesOf(f.state)).toMatchObject({ machineIds: [], cleanupMachineIds: [], memberIds: [] })
  })

  it('is restored by its owner alone, during the grace: people, chats and projects come back, without agents or machines', () => {
    const f = deleted()
    for (const actor of [peer, { kind: 'agent', agentId: 'made-up' } as Actor, { kind: 'person', userId: 'stranger', email: 's@example.com' } as Actor]) {
      expect(refusal(f, { type: 'swarm.restore' }, actor)).toEqual(MISSING)
    }
    expect(f.run({ type: 'swarm.restore' }, owner).result).toEqual({ restored: true })
    expect(f.state.deletion).toBeUndefined()
    expect(f.state.agents).toEqual([])
    expect(indexesOf(f.state)).toMatchObject({ memberIds: ['owner', 'peer'], deletedAt: null, purgeAt: null })
    expect(f.state.conversations.some(c => c.id === 'lead')).toBe(true)
    // Live again: it takes commands as before.
    f.run({ type: 'tab.rename', name: 'Lampos again' })
    // And a live Swarm has nothing to restore: answered as missing, telling nothing.
    expect(refusal(f, { type: 'swarm.restore' }, owner)).toEqual(MISSING)
  })

  it('answers a host whose close or cleanup is not waiting as a missing Swarm, never "nothing waiting"', () => {
    const f = deleted()
    expect(refusal(f, { type: 'agent.sessionClosed', agentId: 'made-up', harnessId: 'h' } as Command, owner)).toEqual(MISSING)
    expect(refusal(f, { type: 'machine.cleaned', machineId: 'other', removalId: 'r' }, owner)).toEqual(MISSING)
    // A live Swarm still says what is not waiting.
    const live = fixture()
    expect(refusal(live, { type: 'machine.cleaned', machineId: 'other', removalId: 'r' }, owner)).toMatchObject({ code: 'NOT_FOUND', message: 'This machine has no cleanup waiting.' })
  })

  it('leaves out of a restore whoever the store read as no longer in the Workspace, never its owner', () => {
    const f = deleted()
    f.run({ type: 'swarm.restore' }, owner, { workspaceLost: ['peer', 'owner'] })
    expect(f.state.people.map(p => p.id)).toEqual(['owner'])
    expect(indexesOf(f.state).memberIds).toEqual(['owner'])
  })

  it('lets a Workspace removal take a person out of it, and nothing else', () => {
    const f = deleted()
    expect(refusal(f, { type: 'member.remove', userId: 'peer' }, peer)).toEqual(MISSING)
    f.run({ type: 'member.remove', userId: 'peer' }, peer, { workspaceLeave: true })
    expect(f.state.people.map(p => p.id)).toEqual(['owner'])
    expect(f.state.deletion).toBeDefined()
  })

  it('cannot be restored once its grace is over', () => {
    const f = deleted()
    expect(refusal(f, { type: 'swarm.restore' }, owner, { now: NOW + SWARM_DELETE_GRACE_MS })).toEqual(MISSING)
    expect(f.state.deletion).toBeDefined()
    f.run({ type: 'swarm.restore' }, owner, { now: NOW + SWARM_DELETE_GRACE_MS - 1 })
    expect(f.state.deletion).toBeUndefined()
  })
})
