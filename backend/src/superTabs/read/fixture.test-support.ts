/** Test support only: a Swarm built through real commands, for the read views and the migration tests. */
import { applyCommand, type Command, type CommandContext } from '../commands.js'
import { createSuperTab, type Actor, type AgentConfiguration, type SuperTabState } from '../model.js'

export const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
export const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
export const outsider: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'outsider', email: 'outsider@example.com' }
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
  const add = (harnessId: string, conversationId: string, lead = false, contributor = owner, machineId = 'host') =>
    run({ type: 'agent.add', conversationId, machineId, harnessId, name: harnessId, configuration: config, lead }, contributor,
      { contribution: { machineOwnerId: `${contributor.userId}-machine`, contributorId: contributor.userId } }).agentId as string
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
