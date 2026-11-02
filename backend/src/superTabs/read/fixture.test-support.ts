/** Test support only: a Swarm built through real commands, for the read views and the migration tests. */
import { applyCommand, type Command, type CommandContext } from '../commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type SuperTabState } from '../model.js'
import { buddyChatId } from '../buddies.js'

export const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: '100000000000000000000001', email: 'owner@example.com' }
export const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: '100000000000000000000002', email: 'peer@example.com' }
export const outsider: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: '100000000000000000000003', email: 'outsider@example.com' }
export const config: AgentConfiguration = { engine: 'codex', model: 'test-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
export const NOW = 1_793_010_000_000

export function swarm(now = NOW) {
  let state = createSuperTab('tab', 'Pilot', { id: owner.userId, email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects.result
  }
  const join = (person: typeof peer) => {
    const { inviteId } = run({ type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
    run({ type: 'invite.accept', inviteId: inviteId as string }, person)
  }
  const add = (harnessId: string, conversationId: string, lead = false, contributor = owner, machineId = 'host', machineOwnerId = `${contributor.userId}-machine`) =>
    run({ type: 'agent.add', conversationId, machineId, harnessId, name: harnessId, configuration: config, lead }, contributor,
      { contribution: { machineOwnerId, contributorId: contributor.userId } }).agentId as string
  const group = (title: string, projectId?: string, actor: Actor = owner) => run({ type: 'conversation.create', ...(projectId ? { projectId } : {}),
    title, brief: `${title} brief`, checks: [{ description: `${title} works`, independent: false }] }, actor).conversationId as string
  const contribute = (machineId: string, scope?: 'swarm') => run({ type: 'machine.contribute', machineId, name: machineId, cwd: '/repo',
    ...(scope ? { scope } : {}), engines: ['codex'], maxAgents: 3 }, owner, { contribution: { machineOwnerId: owner.userId, contributorId: owner.userId } })
  /** Writes outside commands (store observations, ledger, audiences), as the store would. */
  const edit = (change: (draft: SuperTabState) => void) => { change(state) }
  return { run, join, add, group, contribute, edit, get state(): SuperTabState { return state } }
}

/** Two projects (the Swarm's first, public; "Secret", private to the owner), a Lead, two workers, finished and running work. */
export function richSwarm(now = NOW) {
  const s = swarm(now)
  s.join(peer)
  s.join(outsider)
  const lead = s.add('lead-harness', 'lead', true)
  const secret = s.run({ type: 'project.create', name: 'Secret', visibility: 'private', brief: '' }).projectId as string
  const web = s.group('Web')
  const worker = s.add('worker-harness', web)
  const assignmentId = s.run({ type: 'work.assign', conversationId: web, agentId: worker }).assignmentId as string
  const done = s.group('Done work')
  const secretGroup = s.group('Secret work', secret)
  // Not a spread: `state` stays a live getter.
  return Object.assign(s, { lead, worker, secret, web, done, secretGroup, assignmentId })
}

/** `richSwarm`, plus everything `visibleState` filters or drops: peer in the private project, a machine whose reading lists a
 *  gone session and a failed privacy check, peer's Buddy and its chat, a dormant conversation, report progress, and the
 *  owner-only and host-only records (sharing, reservations, released and closing sessions, overlap alerts). */
export function fullSwarm(now = NOW) {
  const s = richSwarm(now)
  s.run({ type: 'project.sharing', projectId: s.secret, visibility: 'private', memberIds: [peer.userId] })
  s.contribute('host')
  const machineOwnerId = `${owner.userId}-machine`
  // A function, not one object: a stored state never holds one object twice (cloneData.test.ts reachedOnce).
  const tokens = () => ({ 'test-model': { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 } })
  s.edit(state => {
    state.machines!.find(m => m.machineId === 'host')!.observation = { generation: 'g1', receivedAt: now, sessionKind: 'team',
      resources: { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
        deviceType: null, chip: null, os: null, gpuPercent: null },
      tools: {}, quotas: [], runningHarnessIds: ['worker-harness', 'gone-harness'], stoppedHarnessIds: [],
      harnessTokens: { 'worker-harness': tokens(), 'gone-harness': tokens() },
      privacy: { mode: 'account', passed: false, item: 'disk-encryption', detail: '/Users/owner/secret', checkedAt: now, seenAt: now } }
  })
  const generation = s.state.people.find(p => p.id === peer.userId)!.generation
  const projectId = s.state.projects![0]!.id
  const buddy = 'buddy', buddyChat = buddyChatId(projectId, { id: peer.userId, generation })
  s.edit(state => {
    state.agents.push({ id: buddy, projectId, machineId: 'host', harnessId: 'buddy-harness', machineOwnerId, contributorId: peer.userId,
      membershipGeneration: generation, name: 'Buddy', configuration: config, buddyOf: { personId: peer.userId, generation } })
    state.conversations.push({ id: buddyChat, kind: 'buddy', projectId, title: 'Buddy', leadId: null, agentIds: [buddy], archived: false,
      brief: '', checks: [], assignment: null, lastMessageSequence: 0, audience: { people: [{ id: peer.userId, generation }] } })
    Object.assign(state.conversations.find(c => c.id === s.done)!, { archived: true, dormant: true })
    for (const project of state.projects!) project.progress = { since: now, summarizedFloor: 0, summarized: {}, requestedFloor: 0, requested: {} }
    state.sharing = { revision: 1, generation: 'sharing-1', access: { mode: 'invited', role: 'collaborator' } }
    state.harnessReservations = [{ machineId: 'host', harnessId: 'worker-harness', generation: 'g1', renewed: false }]
    state.releasedHarnesses = [{ machineId: 'host', harnessId: 'old-harness' }]
    state.overlapAlerts = ['a:b']
    state.closingSessions = [{ agentId: 'removed-agent', machineId: 'host', harnessId: 'old-harness', machineOwnerId }]
  })
  // Not a spread: `state` stays a live getter.
  return Object.assign(s, { buddy, buddyChat })
}
