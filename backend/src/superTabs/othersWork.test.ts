import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'
import { DAY_MS, WEEK_MS, weekStart } from './leaderboard/week.js'
import { othersWorkNotice } from './othersWork.js'

// Contributor view (#2444): a machine's owner hears, once a week per machine, when someone else's work starts on it.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
// Thursday 2026-10-29 noon UTC.
const NOW = Date.UTC(2026, 9, 29, 12)
const NOTICE = 'others-work-notice'

function fixture() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0, now = NOW
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  // The owner's Mac Studio, contributed, with its Claude subscription's week read.
  const pool: ContributedMachine = { machineId: 'host', name: 'Mac Studio', contributorId: 'owner', membershipGeneration: state.people[0]!.generation,
    generation: 'g1', cwd: '/repo', scope: 'swarm', engines: ['claude'], maxAgents: 4, paused: false,
    observation: { receivedAt: NOW, runningHarnessIds: [], stoppedHarnessIds: [], quotas: [{ engine: 'claude', known: true, windows: [{ name: 'weekly', usedPercent: 38, resetsAt: NOW + 3 * DAY_MS }] }] } as never }
  state.machines = [pool]
  const add = (harnessId: string, group = 'lead', lead = false) => run({ type: 'agent.add', conversationId: group, machineId: 'host', harnessId,
    name: harnessId, configuration: config, lead }, owner, { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }).result.agentId as string
  const create = (actor: Actor, extra: Record<string, unknown> = {}) =>
    run(commandSchema.parse({ type: 'conversation.create', title: 'Fix login', brief: 'Fix it.', checks: [], ...extra }), actor).result.conversationId as string
  const assign = (id: string, worker = add(`worker-${id}`, id)) => run({ type: 'work.assign', conversationId: id, agentId: worker })
  const told = (effects: ReturnType<typeof run>) => effects.messages.filter(m => (m.source as { kind?: string } | undefined)?.kind === NOTICE)
  const buddyChat = () => state.conversations.find(c => c.kind === 'swarm-buddy')
  return { run, add, create, assign, told, buddyChat, get state() { return state }, at(ms: number) { now = ms } }
}

describe('the owner hears when someone else\'s work starts on their machine', () => {
  it('tells the owner in their own Buddy chat, naming who, the task, the machine and its week', () => {
    const f = fixture(), id = f.create(peer)
    const told = f.told(f.assign(id))
    expect(told).toEqual([expect.objectContaining({ conversationId: f.buddyChat()!.id, recipients: [], source: { kind: NOTICE, machineId: 'host' },
      text: 'peer\'s work "Fix login" started on your Mac Studio (Claude, 38% of this week used, resets in 3d). '
        + 'Members › your card shows what it runs and ships; Manage › Machines can pause new work.' })])
    expect(f.buddyChat()!.audience).toEqual({ people: [{ id: 'owner', generation: f.state.people[0]!.generation }] })
    expect(f.state.machines![0]!.othersToldWeek).toBe(weekStart(NOW))
  })

  it('tells once a week per machine: not again this week, again next week', () => {
    const f = fixture()
    expect(f.told(f.assign(f.create(peer)))).toHaveLength(1)
    expect(f.told(f.assign(f.create(peer)))).toHaveLength(0)
    f.at(NOW + WEEK_MS)
    expect(f.told(f.assign(f.create(peer)))).toHaveLength(1)
  })

  it('says nothing for the owner\'s own request, a PM\'s work or a private chat', () => {
    const f = fixture()
    expect(f.told(f.assign(f.create(owner)))).toHaveLength(0)
    const pm = f.add('pm', 'lead', true)
    expect(f.state.conversations.find(c => c.id === 'lead')!.leadId).toBe(pm)
    expect(f.state.machines![0]!.othersToldWeek).toBeUndefined()
  })

  it('says the reset is unknown when its week was never read, and still tells', () => {
    const f = fixture()
    f.state.machines![0]!.observation = undefined
    expect(f.told(f.assign(f.create(peer)))[0]!.text).toBe('peer\'s work "Fix login" started on your Mac Studio (Claude). '
      + 'Members › your card shows what it runs and ships; Manage › Machines can pause new work.')
  })

  it('names neither the task nor its project to an owner who may not read that project', () => {
    const f = fixture(), id = f.create(owner), worker = f.add('worker', id)
    // The machine is the peer's, and the owner's project is private with no members: the peer may not read it.
    f.state.machines![0]!.contributorId = 'peer'
    f.state.projects = [{ id: 'lead', name: 'Pilot', ownerId: 'owner', leadConversationId: 'lead', visibility: 'private', members: [], updateMinutes: 5 }]
    const group = f.state.conversations.find(c => c.id === id)!, agent = f.state.agents.find(a => a.id === worker)!
    const told = othersWorkNotice(f.state, group, agent, NOW, 'Claude')
    expect(told?.text).toBe('owner\'s work started on your Mac Studio (Claude, 38% of this week used, resets in 3d). '
      + 'Members › your card shows what it runs and ships; Manage › Machines can pause new work.')
    expect(f.state.conversations.find(c => c.id === told!.conversationId)!.audience)
      .toEqual({ people: [{ id: 'peer', generation: f.state.people.find(p => p.id === 'peer')!.generation }] })
  })

  it('keeps the week told when the owner saves the machine\'s settings again', () => {
    const f = fixture()
    f.assign(f.create(peer))
    f.run({ type: 'machine.contribute', machineId: 'host', name: 'Mac Studio', cwd: '/repo', engines: ['claude'], maxAgents: 4 } as Command, owner,
      { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } })
    expect(f.state.machines!.find(m => m.machineId === 'host')!.othersToldWeek).toBe(weekStart(NOW))
  })
})
