import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { PERSONAL_SWARM_OPERATION } from './deletion.js'
import { createSuperTab, stableId, visibleState, type Actor, type AgentConfiguration, type SuperTabState } from './model.js'

// PSW-B review (2026-11-11): every Personal Swarm was made with a public, repo-less project named after it ("Personal"), which
// Desktop hid and the phone, web and CLI showed. Its projects are its person's repos (anh Dee 2026-11-11): it is made without one,
// and the store's one-time job deletes the one already made wherever nothing is in it.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const personalId = stableId('super-tab', 'prod', 'owner', PERSONAL_SWARM_OPERATION)
const own = { contribution: { machineOwnerId: 'owner', contributorId: 'owner' } }

function fixture(firstProject: boolean, id = personalId) {
  let state = createSuperTab(id, 'Personal', { id: 'owner', email: owner.email }, 'prod', 'private', firstProject)
  let sequence = 0
  const run = (command: Command, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, owner, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const removal = () => run({ type: 'project.delete', projectId: 'lead' }, { personalProject: true })
  const code = (act: () => unknown) => { try { act(); return 'applied' } catch (error) { return (error as { code?: string }).code } }
  return { run, removal, code, get state(): SuperTabState { return state } }
}

describe('a Personal Swarm without the "Personal" project', () => {
  it('is made with no project, and its person\'s agents, chats and repos\' projects work in it', () => {
    const f = fixture(false)
    expect(f.state.projects).toEqual([])
    expect(f.state.conversations).toEqual([])
    const chat = f.run({ type: 'agent.new', kind: 'regular', machineId: 'mac', engine: 'claude', name: 'Juno', local: true }, own).result.conversationId as string
    const juno = f.run({ type: 'agent.add', conversationId: chat, machineId: 'mac', harnessId: 'juno', name: 'Juno', configuration: config, lead: false }, own)
      .result.agentId as string
    f.run({ type: 'message.send', conversationId: chat, text: 'Fix the docs', replyTo: null, recipientIds: [] })
    const repo = f.run({ type: 'project.create', name: 'openharness', visibility: 'private', brief: '' }).result.projectId as string
    expect(visibleState(f.state, owner).projects!.map(p => p.id)).toEqual([repo])
    f.run({ type: 'agent.remove', agentId: juno })
    expect(f.state.agents).toEqual([])
  })
})

describe('the one-time removal of the "Personal" project', () => {
  it('deletes it where nothing was ever in it', () => {
    const f = fixture(true)
    f.removal()
    expect(f.state.projects).toEqual([])
    expect(f.state.conversations.some(c => c.id === 'lead')).toBe(false)
  })

  it('keeps it, as any project, once something was said in it or an agent is in it', () => {
    const said = fixture(true)
    said.state.conversations.find(c => c.id === 'lead')!.lastMessageSequence = 1
    expect(said.code(said.removal)).toBe('PERSONAL_PROJECT_KEPT')
    const task = fixture(true)
    task.state.conversations.push({ id: 'old-task', title: 'Old', leadId: null, agentIds: [], archived: true, dormant: true, brief: '', checks: [],
      assignment: null, lastMessageSequence: 3 })
    expect(task.code(task.removal)).toBe('PERSONAL_PROJECT_KEPT')
    const staffed = fixture(true)
    staffed.run({ type: 'agent.add', conversationId: 'lead', machineId: 'mac', harnessId: 'pm', name: 'Pm', configuration: config, lead: true }, own)
    expect(staffed.code(staffed.removal)).toBe('PERSONAL_PROJECT_KEPT')
    for (const f of [said, task, staffed]) expect(f.state.projects!.map(p => p.id)).toEqual(['lead'])
  })

  it('touches no other Swarm\'s first project, and nothing but the store asks it', () => {
    const team = fixture(true, 'team')
    expect(team.code(team.removal)).toBe('NOT_FOUND')
    const f = fixture(true)
    const other = f.run({ type: 'project.create', name: 'Repo', visibility: 'private', brief: '' }).result.projectId as string
    expect(f.code(() => f.run({ type: 'project.delete', projectId: other }, { personalProject: true }))).toBe('NOT_FOUND')
    expect(f.state.projects!.map(p => p.id)).toEqual(['lead', other])
  })
})
