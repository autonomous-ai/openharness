import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import type { ContributedMachine } from './machines.js'
import { createSuperTab, SuperTabError, type Actor, type SuperTabState } from './model.js'
import { agentChatId } from './agentKind.js'
import { agentDisplayName } from './agentNames.js'
import { ledProject, readConversation } from './projects.js'

// Task #4664 (anh Dee 11-07, 21:23): clicking his Lead in My agents opened its project chat, a Member a private chat. One rule,
// like iMessage: an agent is a direct message, a project a group chat. agent.chat opens the person's private chat with their
// own Lead, which only they and that Lead read; the Lead still leads and posts in its project chat.
const NOW = 50_000_000
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const mate: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'mate', email: 'mate@example.com' }
const resources = { cpuPercent: 1, memoryTotalBytes: 8, memoryUsedBytes: 1, diskFreeBytes: 8, diskTotalBytes: 8, projectDiskFreeBytes: 8,
  deviceType: null, chip: null, os: null, gpuPercent: null }
const reading = { generation: 'g1', receivedAt: NOW, sessionKind: 'computer' as const, resources, tools: {}, quotas: [], runningHarnessIds: [],
  stoppedHarnessIds: [], capabilities: ['leadStart', 'regularAgent'] }
const own = (userId: string) => ({ contribution: { machineOwnerId: userId, contributorId: userId } })
const configuration = { engine: 'claude' as const, model: 'opus', effort: 'high', contextWindow: null, engineVersion: null }
const code = (body: () => unknown): string | null => {
  try { body(); return null } catch (error) { return error instanceof SuperTabError ? error.code : 'INVALID' }
}
const say = (chat: string, text: string) => ({ type: 'message.send', conversationId: chat, text, replyTo: null, recipientIds: [] }) as Command

/** Mate's Lead (Faye here) of project Lamp, started and running on mate's own computer, and mate's Member Ada in her own chat. */
function swarm() {
  let state: SuperTabState = createSuperTab('tab', 'Pilot', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = mate, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: NOW, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  const invited = run({ type: 'invite.create', email: mate.email, role: 'collaborator', conversationId: 'lead' }, owner)
  run({ type: 'invite.accept', inviteId: invited.result.inviteId as string }, mate)
  const generation = (userId: string) => state.people.find(p => p.id === userId)!.generation
  const pool = (machineId: string, contributorId: string): ContributedMachine => ({
    machineId, name: machineId, contributorId, membershipGeneration: generation(contributorId), generation: 'g1', cwd: '/swarm', scope: 'swarm',
    engines: ['claude', 'codex'], maxAgents: 4, paused: false, observation: reading })
  state.machines = [pool('owner-mac', 'owner'), pool('mate-mac', 'mate')]
  const started = (made: { result: Record<string, unknown> }, harnessId: string) => {
    const startId = made.result.startId as string
    run({ type: 'agent.startDispatch', startId }, mate, own('mate'))
    return run({ type: 'agent.started', startId, harnessId, configuration }, mate, own('mate')).result.agentId as string
  }
  const lamp = run({ type: 'agent.new', kind: 'pm', projectName: 'Lamp', engine: 'claude', machineId: 'mate-mac' }, mate, own('mate'))
  const faye = started(lamp, 'h-faye')
  const ada = started(run({ type: 'agent.new', kind: 'regular', name: 'Ada', engine: 'claude', machineId: 'mate-mac' }, mate, own('mate')), 'h-ada')
  const open = (agentId: string, actor: Actor = mate) => run({ type: 'agent.chat', agentId } as Command, actor).result.conversationId as string
  return { run, open, faye, ada, projectChat: lamp.result.conversationId as string, get state() { return state } }
}

describe('a Lead\'s private chat with its person', () => {
  it('opens once, as the chat My agents names for it, beside its project chat', () => {
    const f = swarm()
    expect(ledProject(f.state, f.faye)?.leadConversationId).toBe(f.projectChat)
    expect(agentChatId(f.state, f.state.agents.find(a => a.id === f.faye)!)).toBeNull()
    const chat = f.open(f.faye)
    expect(chat).not.toBe(f.projectChat)
    // Named as My agents names it: its display name.
    const name = agentDisplayName(f.state.agents, f.faye)
    expect(f.state.conversations.find(c => c.id === chat)).toMatchObject({ kind: 'agent-chat', title: name, agentIds: [f.faye],
      audience: { people: [{ id: 'mate' }] } })
    expect(agentChatId(f.state, f.state.agents.find(a => a.id === f.faye)!)).toBe(chat)
    // A second click, or a second window, opens the same chat.
    expect(f.open(f.faye)).toBe(chat)
    expect(f.state.conversations.filter(c => c.agentIds.includes(f.faye) && c.kind === 'agent-chat')).toHaveLength(1)
    // It still leads its project.
    expect(ledProject(f.state, f.faye)?.leadConversationId).toBe(f.projectChat)
  })

  it('is read only by its person and that Lead', () => {
    const f = swarm()
    const chat = f.open(f.faye)
    const fayeActor: Actor = { kind: 'agent', agentId: f.faye, machineOwnerId: 'mate' }
    expect(code(() => readConversation(f.state, mate, chat))).toBeNull()
    expect(code(() => readConversation(f.state, fayeActor, chat))).toBeNull()
    expect(code(() => readConversation(f.state, owner, chat))).toBe('NOT_FOUND')
    expect(code(() => readConversation(f.state, { kind: 'agent', agentId: f.ada, machineOwnerId: 'mate' }, chat))).toBe('NOT_FOUND')
  })

  it('takes its person\'s message to the Lead and the Lead\'s reply; the Lead still posts in its project chat', () => {
    const f = swarm()
    const chat = f.open(f.faye)
    const fayeActor: Actor = { kind: 'agent', agentId: f.faye, machineOwnerId: 'mate' }
    const sent = f.run(say(chat, 'How is Lamp going?'))
    expect(sent.messages[0].recipients).toEqual([f.faye])
    expect(code(() => f.run(say(chat, 'Two tasks in review.'), fayeActor))).toBeNull()
    expect(code(() => f.run(say(f.projectChat, 'Release is out.'), fayeActor))).toBeNull()
    expect(code(() => f.run(say(chat, 'Hi Faye'), { kind: 'agent', agentId: f.ada, machineOwnerId: 'mate' }))).not.toBeNull()
  })

  it('opens only for the Lead\'s own person, a person, and an agent that leads a project', () => {
    const f = swarm()
    expect(code(() => f.open(f.faye, owner))).toBe('NOT_FOUND')
    expect(code(() => f.open(f.faye, { kind: 'agent', agentId: f.faye, machineOwnerId: 'mate' }))).toBe('HUMAN_REQUIRED')
    expect(code(() => f.open(f.ada))).toBe('AGENT_CHAT_LEAD_ONLY')
    expect(code(() => f.open('nobody'))).toBe('AGENT_UNAVAILABLE')
    expect(f.state.conversations.filter(c => c.kind === 'agent-chat')).toHaveLength(1)
  })

  it('opens only for a Lead running on its person\'s own computer, which is who reads the chat', () => {
    const f = swarm()
    f.state.agents.find(a => a.id === f.faye)!.machineOwnerId = 'owner'
    expect(code(() => f.open(f.faye))).toBe('AGENT_OWN_MACHINE')
  })
})
