import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, stableId, type Actor } from './model.js'
import { PERSONAL_SWARM_OPERATION } from './deletion.js'

// Task #3929 (for Diego's #3903): a no-repo tab's project in the Personal Swarm goes when the tab closes, if it never had a
// message; otherwise it is archived, read-only and out of the sidebar. Only the Personal Swarm's owner, only a tab's project.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const configuration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }

function setup({ personal = true } = {}) {
  const id = personal ? stableId('super-tab', 'test', 'owner', PERSONAL_SWARM_OPERATION) : 'team-swarm'
  let state = createSuperTab(id, 'Personal', { id: 'owner', email: owner.email }, 'test')
  state.people.push({ id: 'peer', email: peer.email, role: 'collaborator', generation: 'first' })
  let next = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}, operationId = `op${next++}`) => {
    const effects = applyCommand(state, actor, command, { operationId, now: 1000, contribution: { machineOwnerId: 'owner', contributorId: 'owner' }, ...context })
    state = effects.state
    return effects
  }
  const create = (operationId: string) => run({ type: 'project.create', name: 'Untitled tab', visibility: 'private', brief: '' }, owner, {}, operationId)
    .result.projectId as string
  /** Desktop's close of the tab whose project request was [tabOperation]. */
  const close = (projectId: string, tabOperation: string, actor: Actor = owner) => run({ type: 'project.closeTab', projectId, tabOperation } as Command, actor)
  const project = (projectId: string) => state.projects?.find(p => p.id === projectId)
  const chatOf = (projectId: string) => state.conversations.find(c => c.id === project(projectId)?.leadConversationId)
  const refusal = (body: () => unknown): string | null => { try { body(); return null } catch (error) { return (error as { code?: string }).code ?? 'thrown' } }
  return { run, create, close, project, chatOf, refusal, get state() { return state } }
}

describe('closing a tab\'s Personal project', () => {
  it('deletes it when none of its conversations has a message', () => {
    const f = setup()
    const tab = f.create('personal-tab-abc')
    const chat = f.chatOf(tab)!.id
    expect(f.close(tab, 'personal-tab-abc').result).toMatchObject({ outcome: 'deleted' })
    expect(f.project(tab)).toBeUndefined()
    expect(f.state.conversations.some(c => c.id === chat)).toBe(false)
  })

  it('archives it, read-only and with its agents gone, when one of its conversations has a message', () => {
    const f = setup()
    const tab = f.create('personal-tab-abc')
    const chat = f.chatOf(tab)!.id
    f.run({ type: 'message.send', conversationId: chat, text: 'A note to keep', replyTo: null, recipientIds: [] })
    // The store numbers the message as it writes it (parts/commit.ts numberMessages): its chat's sequence moves.
    f.chatOf(tab)!.lastMessageSequence = 1
    const lead = f.run({ type: 'agent.add', conversationId: chat, machineId: 'owner-mac', harnessId: 'pm', name: 'pm', configuration, lead: true }).result.agentId as string
    expect(f.close(tab, 'personal-tab-abc').result).toMatchObject({ outcome: 'archived' })
    expect(f.project(tab)).toMatchObject({ archived: true })
    expect(f.chatOf(tab)).toMatchObject({ archived: true })
    expect(f.state.agents.some(a => a.id === lead)).toBe(false)
  })

  it('refuses a repo project, a project that is not a tab\'s, another person, an agent, and a Swarm that is not Personal', () => {
    const f = setup()
    const repo = f.create('personal-repo-abc')
    expect(f.refusal(() => f.close(repo, 'personal-repo-abc'))).not.toBeNull()
    // A tab's request that did not make this project: another project of theirs is never closed under a tab's name.
    const other = f.create('some-other-project')
    expect(f.refusal(() => f.close(other, 'personal-tab-abc'))).toBe('NOT_FOUND')
    const tab = f.create('personal-tab-with-repo')
    f.state.projects!.find(p => p.id === tab)!.repository = { machineId: 'owner-mac', cwd: '/code/app', repositoryUrl: null }
    expect(f.refusal(() => f.close(tab, 'personal-tab-with-repo'))).toBe('NOT_FOUND')
    const mine = f.create('personal-tab-def')
    expect(f.refusal(() => f.close(mine, 'personal-tab-def', peer))).not.toBeNull()
    expect(f.refusal(() => f.close(mine, 'personal-tab-def', { kind: 'agent', agentId: 'pm', machineOwnerId: 'owner' }))).not.toBeNull()
    expect(f.project(mine)).toBeDefined()
    const team = setup({ personal: false })
    const theirs = team.create('personal-tab-abc')
    expect(team.refusal(() => team.close(theirs, 'personal-tab-abc'))).toBe('NOT_FOUND')
    expect(team.project(theirs)).toBeDefined()
  })
})
