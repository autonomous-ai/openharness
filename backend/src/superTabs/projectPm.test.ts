import { describe, expect, it } from 'vitest'
import { applyCommand, commandSchema, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { ledProject } from './projects.js'

// anh Dee 2026-11-11: a project's PM is one of its person's agents, chosen in the project's settings; choosing again switches
// it, and the one it replaces keeps running in their team. Its GitHub repository is the project's, set by the client.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: 'opus', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

function fixture() {
  let state = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, peer)
  /** A pane of [who]'s, on their own computer, joined to their team as Desktop joins one: its chat, then its session. */
  const join = (harnessId: string, who = owner) => {
    const own = { contribution: { machineOwnerId: who.userId, contributorId: who.userId } }
    const chat = run({ type: 'agent.new', kind: 'regular', machineId: `${who.userId}-mac`, engine: 'claude', name: harnessId, local: true }, who, own).result.conversationId as string
    return run({ type: 'agent.add', conversationId: chat, machineId: `${who.userId}-mac`, harnessId, name: harnessId, configuration: config, lead: false },
      who, own).result.agentId as string
  }
  const project = run({ type: 'project.create', name: 'Harness', visibility: 'public', brief: '' }).result as { projectId: string; conversationId: string }
  const choose = (agentId: string, actor: Actor = owner) => run({ type: 'project.pm', projectId: project.projectId, agentId }, actor)
  const channel = () => state.conversations.find(c => c.id === project.conversationId)!
  const agentOf = (id: string) => state.agents.find(a => a.id === id)!
  return { run, join, project, choose, channel, agentOf, get state() { return state } }
}

describe('project.pm', () => {
  it('makes one of its owner\'s agents the PM, and answers with that agent\'s own chat', () => {
    const f = fixture(), juno = f.join('juno')
    const { result } = f.choose(juno)
    expect(f.channel()).toMatchObject({ leadId: juno, agentIds: [juno] })
    expect(ledProject(f.state, juno)?.id).toBe(f.project.projectId)
    expect(f.agentOf(juno)).toMatchObject({ projectId: f.project.projectId })
    expect(f.agentOf(juno)).not.toHaveProperty('regular')
    expect(result.chatId).toBe(f.state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(juno))!.id)
    // The same choice again changes nothing.
    const before = JSON.stringify(f.state)
    f.choose(juno)
    expect(JSON.stringify(f.state)).toBe(before)
  })

  it('switches to another agent, and the one it replaces stays in the team, running, with its own chat', () => {
    const f = fixture(), juno = f.join('juno'), pip = f.join('pip')
    const junoChat = f.choose(juno).result.chatId as string
    const effects = f.choose(pip)
    expect(f.channel()).toMatchObject({ leadId: pip, agentIds: [pip] })
    expect(f.agentOf(juno)).toMatchObject({ regular: true })
    expect(f.state.conversations.find(c => c.id === junoChat)!.agentIds).toEqual([juno])
    expect(f.agentOf(juno)).not.toHaveProperty('projectId')
    expect(ledProject(f.state, juno)).toBeUndefined()
    expect(effects.cancelledAgents).toEqual([])
    expect(f.state.closingSessions).toBeUndefined()
  })

  it('takes only its owner\'s choice, of their own agent', () => {
    const f = fixture(), juno = f.join('juno'), theirs = f.join('theirs', peer)
    expect(() => f.choose(theirs, peer)).toThrow(expect.objectContaining({ code: 'PROJECT_OWNER_REQUIRED' }))
    // Another person's agent is not even seen; one of theirs on a computer someone shared with them is not theirs to choose.
    expect(() => f.choose(theirs)).toThrow(expect.objectContaining({ code: 'AGENT_UNAVAILABLE' }))
    const lent = f.join('lent')
    f.agentOf(lent).machineOwnerId = 'lender'
    expect(() => f.choose(lent)).toThrow(expect.objectContaining({ code: 'AGENT_NOT_YOURS' }))
    expect(() => f.choose(juno, { kind: 'agent', agentId: juno, machineOwnerId: 'owner' })).toThrow(expect.objectContaining({ code: 'HUMAN_REQUIRED' }))
    expect(() => f.choose('nobody')).toThrow(expect.objectContaining({ code: 'AGENT_UNAVAILABLE' }))
    expect(f.channel().leadId).toBeNull()
  })

  it('refuses an agent that leads another project or is stopping', () => {
    const f = fixture(), juno = f.join('juno'), pip = f.join('pip')
    f.choose(juno)
    const other = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }).result.projectId as string
    expect(() => f.run({ type: 'project.pm', projectId: other, agentId: juno })).toThrow(expect.objectContaining({ code: 'LEAD_ELSEWHERE' }))
    f.run({ type: 'agent.release', agentId: pip, decision: 'stop' })
    expect(() => f.run({ type: 'project.pm', projectId: other, agentId: pip })).toThrow(expect.objectContaining({ code: 'STOP_REQUESTED' }))
  })
})

describe('project.github', () => {
  it('is set and replaced by the project owner and its PM, as owner/name', () => {
    const f = fixture(), juno = f.join('juno')
    const set = (repository: string, actor: Actor = owner) => f.run({ type: 'project.github', projectId: f.project.projectId, repository }, actor)
    const stored = () => f.state.projects!.find(p => p.id === f.project.projectId)!.githubRepository
    expect(stored()).toBeUndefined()
    set('autonomous-ai/openharness')
    expect(stored()).toBe('autonomous-ai/openharness')
    f.choose(juno)
    set('autonomous-ai/harness.docs', { kind: 'agent', agentId: juno, machineOwnerId: 'owner' })
    expect(stored()).toBe('autonomous-ai/harness.docs')
    expect(() => set('someone/else', peer)).toThrow(expect.objectContaining({ code: 'PROJECT_OWNER_REQUIRED' }))
  })

  // Reviews of #4152: of a Swarm's projects on one repository, the one that got it first offers its tasks (githubComments.ts
  // repositoryProject), named or cloned.
  it('keeps when the project named its repository, and the same name again keeps its first time', () => {
    const f = fixture()
    const set = (repository: string, now: number) => f.run({ type: 'project.github', projectId: f.project.projectId, repository }, owner, { now })
    const named = () => f.state.projects!.find(p => p.id === f.project.projectId)!
    set('autonomous-ai/openharness', 2_000)
    expect(named().githubRepositoryAt).toBe(2_000)
    set('Autonomous-AI/OpenHarness', 3_000)
    expect(named()).toMatchObject({ githubRepository: 'Autonomous-AI/OpenHarness', githubRepositoryAt: 2_000 })
    set('autonomous-ai/harness.docs', 4_000)
    expect(named().githubRepositoryAt).toBe(4_000)
  })

  it('takes only a GitHub owner/name', () => {
    const valid = (repository: string) => commandSchema.safeParse({ type: 'project.github', projectId: 'p', repository }).success
    expect(['a/b', 'Owner-1/repo_name.x', `${'o'.repeat(39)}/${'r'.repeat(100)}`].map(valid)).toEqual([true, true, true])
    expect(['owner', 'owner/', '/repo', '-owner/repo', 'own--er/repo', 'owner-/repo', 'owner/..', 'owner/.', 'a/b/c', 'https://github.com/a/b',
      `${'o'.repeat(40)}/r`, `o/${'r'.repeat(101)}`, 'owner/re po'].map(valid)).toEqual(Array(13).fill(false))
  })
})

describe('project.pm, what each agent keeps', () => {
  it('keeps the replaced PM of a private project to that project, and gives a chatless PM its own chat', () => {
    const f = fixture(), juno = f.join('juno'), pip = f.join('pip')
    f.run({ type: 'project.sharing', projectId: f.project.projectId, visibility: 'private', memberIds: [] })
    f.choose(juno)
    // A PM from before Swarm v4 talked to its person in the channel: it had no chat of its own.
    const chat = f.state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(juno))!
    chat.agentIds = []
    f.choose(pip)
    expect(f.agentOf(juno)).toMatchObject({ regular: true, privateProjectId: f.project.projectId })
    expect(f.state.conversations.filter(c => c.kind === 'agent-chat' && c.agentIds.includes(juno))).toHaveLength(1)
  })

  it('refuses an agent of another project, and a PM a start or a claim is bringing', () => {
    const f = fixture(), juno = f.join('juno')
    const other = f.run({ type: 'project.create', name: 'Docs', visibility: 'public', brief: '' }).result.projectId as string
    f.agentOf(juno).regular = undefined
    f.agentOf(juno).projectId = other
    expect(() => f.choose(juno)).toThrow(expect.objectContaining({ code: 'AGENT_IN_PROJECT' }))
    const pip = f.join('pip')
    f.state.projects!.find(p => p.id === f.project.projectId)!.leadClaim = { id: 'claim', machineId: 'owner-mac', at: 1000 }
    expect(() => f.choose(pip)).toThrow(expect.objectContaining({ code: 'LEAD_STARTING' }))
  })
})

describe('project.github, beside a repository the project clones', () => {
  it('must name the repository the project already clones from GitHub', () => {
    const f = fixture()
    f.state.projects!.find(p => p.id === f.project.projectId)!.repository = { machineId: 'm', cwd: '/r', repositoryUrl: 'https://github.com/autonomous-ai/openharness.git' }
    expect(() => f.run({ type: 'project.github', projectId: f.project.projectId, repository: 'someone/else' })).toThrow(expect.objectContaining({ code: 'PROJECT_REPOSITORY_SET' }))
    f.run({ type: 'project.github', projectId: f.project.projectId, repository: 'Autonomous-AI/OpenHarness' })
    expect(f.state.projects!.find(p => p.id === f.project.projectId)!.githubRepository).toBe('Autonomous-AI/OpenHarness')
  })
})
