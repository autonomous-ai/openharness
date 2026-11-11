import { describe, expect, it } from 'vitest'
import { applyCommand, type Command, type CommandContext } from './commands.js'
import { createSuperTab, type Actor, type AgentConfiguration } from './model.js'
import { archiveEmptyChats, EMPTY_CHAT_MS } from './paneChats.js'

// PSW-B review (2026-11-11): Attach asked for a chat under a new random request each time, so a retry or the person's other
// computer made a second chat that stayed empty for good. A session's chat is now named by the session.
const owner: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'owner', email: 'owner@example.com' }
const peer: Extract<Actor, { kind: 'person' }> = { kind: 'person', userId: 'peer', email: 'peer@example.com' }
const config: AgentConfiguration = { engine: 'claude', model: null, effort: null, contextWindow: null, engineVersion: null }
const own = (who: Extract<Actor, { kind: 'person' }>) => ({ contribution: { machineOwnerId: who.userId, contributorId: who.userId } })

function fixture() {
  let state = createSuperTab('tab', 'Personal', { id: 'owner', email: owner.email }, 'prod')
  let sequence = 0
  const run = (command: Command, actor: Actor = owner, context: Partial<CommandContext> = {}) => {
    const effects = applyCommand(state, actor, command, { now: 1000, operationId: `op-${++sequence}`, ...context })
    state = effects.state
    return effects
  }
  /** Desktop's Attach: the session's chat, then the session in it, each under a request of its own. */
  const chatFor = (harnessId: string, who = owner) => run({ type: 'agent.new', kind: 'regular', machineId: `${who.userId}-mac`, engine: 'claude', name: harnessId,
    local: true, harnessId }, who, own(who)).result
  const add = (chat: string, harnessId: string, who = owner) => run({ type: 'agent.add', conversationId: chat, machineId: `${who.userId}-mac`, harnessId,
    name: harnessId, configuration: config, lead: false }, who, own(who)).result.agentId as string
  const chats = () => state.conversations.filter(c => c.kind === 'agent-chat')
  return { run, chatFor, add, chats, get state() { return state } }
}

describe('joining a running session (Attach)', () => {
  it('gives the session one chat however often and from wherever it is asked, and joins it once', () => {
    const f = fixture()
    const first = f.chatFor('juno').conversationId as string
    // A retry after a lost answer, or the person's other computer, under a new request.
    expect(f.chatFor('juno').conversationId).toBe(first)
    expect(f.chats()).toHaveLength(1)
    const agentId = f.add(first, 'juno')
    expect(f.state.agents.find(a => a.id === agentId)!.chatId).toBe(first)
    expect(f.chatFor('juno')).toEqual({ conversationId: first, agentId })
    expect(f.add(first, 'juno')).toBe(agentId)
    expect(f.state.agents).toHaveLength(1)
    expect(f.chats().map(c => c.agentIds)).toEqual([[agentId]])
  })

  it('opens the same chat again when the session joins again after it was taken out', () => {
    const f = fixture()
    const chat = f.chatFor('juno').conversationId as string
    const agentId = f.add(chat, 'juno')
    f.run({ type: 'agent.remove', agentId })
    const again = f.chatFor('juno').conversationId as string
    expect(again).toBe(chat)
    expect(f.add(again, 'juno')).toBe(agentId)
    expect(f.chats()).toHaveLength(1)
  })

  it('opens again a session\'s chat archived while it was empty', () => {
    const f = fixture()
    const chat = f.chatFor('juno').conversationId as string
    expect(archiveEmptyChats(f.state, 1000 + EMPTY_CHAT_MS)).toBe(1)
    expect(f.chatFor('juno').conversationId).toBe(chat)
    expect(f.chats()).toEqual([expect.objectContaining({ id: chat, archived: false })])
    expect(f.chats()[0]).not.toHaveProperty('dormant')
  })

  it('refuses a session someone else brought, and keeps one chat per person', () => {
    const f = fixture()
    f.run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: f.chatFor('juno').conversationId as string })
    const invite = f.state.invitations[0]!.id
    f.run({ type: 'invite.accept', inviteId: invite }, peer)
    const theirs = f.chatFor('pip', peer).conversationId as string
    f.add(theirs, 'pip', peer)
    // The same session id on another machine is another session.
    expect(f.run({ type: 'agent.new', kind: 'regular', machineId: 'owner-mac', engine: 'claude', name: 'Pip two', local: true, harnessId: 'pip' }, owner, own(owner))
      .result.conversationId).not.toBe(theirs)
    f.state.agents[0]!.machineId = 'owner-mac'
    expect(() => f.run({ type: 'agent.new', kind: 'regular', machineId: 'owner-mac', engine: 'claude', name: 'Pip three', local: true, harnessId: 'pip' }, owner, own(owner)))
      .toThrow(expect.objectContaining({ code: 'ALREADY_SHARED' }))
  })

  it('still opens a new chat for each + New agent, which names no session', () => {
    const f = fixture()
    const fresh = (name: string) => f.run({ type: 'agent.new', kind: 'regular', machineId: 'owner-mac', engine: 'claude', name, local: true }, owner, own(owner)).result.conversationId
    expect(fresh('Ada')).not.toBe(fresh('Bo'))
  })
})

describe('archiveEmptyChats', () => {
  it('archives an agent\'s chat left with no agent and no message for an hour, and nothing awaited', () => {
    const f = fixture()
    const empty = f.chatFor('empty').conversationId as string
    const spoken = f.chatFor('spoken').conversationId as string
    f.state.conversations.find(c => c.id === spoken)!.lastMessageSequence = 3
    const joined = f.chatFor('joined').conversationId as string
    f.add(joined, 'joined')
    const young = f.run({ type: 'agent.new', kind: 'regular', machineId: 'owner-mac', engine: 'claude', name: 'Ada', local: true }, owner,
      { ...own(owner), now: 1000 + EMPTY_CHAT_MS }).result.conversationId as string
    const awaited = f.chatFor('awaited').conversationId as string
    f.state.projects![0]!.pmChat = { id: awaited }
    const started = f.chatFor('started').conversationId as string
    f.state.starts = [{ id: 's', request: { conversationId: started } as never, harnessId: null, error: null } as never]
    expect(archiveEmptyChats(f.state, 1000 + EMPTY_CHAT_MS)).toBe(1)
    const shown = (id: string) => f.state.conversations.find(c => c.id === id)!
    expect(shown(empty)).toMatchObject({ archived: true, dormant: true })
    for (const id of [spoken, joined, young, awaited, started]) expect(shown(id).archived).toBe(false)
    expect(archiveEmptyChats(f.state, 1000 + EMPTY_CHAT_MS)).toBe(0)
  })
})
