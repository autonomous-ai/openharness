import { describe, expect, it } from 'vitest'
import { chatlessAgents, giveAgentsChats } from './agentChats.js'
import { agentChatId } from './agentKind.js'
import { agent } from './model.js'
import { agentProjectId, canReadAgent, projectsOf } from './projects.js'
import { stepsFixture } from './steps.test-support.js'

// Swarm v4 (anh Dee 2026-11-09): every agent has one 1:1 chat with its person, an agent from before v4 too.
describe('giveAgentsChats', () => {
  it('opens a PM from before its 1:1 chat with its person, once', () => {
    const f = stepsFixture()
    f.state.conversations = f.state.conversations.filter(c => c.kind !== 'agent-chat')
    for (const a of f.state.agents) delete a.chatId
    expect(agentChatId(f.state, agent(f.state, f.lead))).toBe('lead')
    expect(chatlessAgents(f.state)).toContain(f.lead)
    giveAgentsChats(f.state, 1_000)
    const chat = f.state.conversations.find(c => c.id === agent(f.state, f.lead).chatId)!
    expect(chat).toMatchObject({ kind: 'agent-chat', agentIds: [f.lead], audience: { people: [{ id: agent(f.state, f.lead).contributorId }] } })
    expect(agentChatId(f.state, agent(f.state, f.lead))).toBe(chat.id)
    expect(chatlessAgents(f.state)).toEqual([])
    const count = f.state.conversations.length
    giveAgentsChats(f.state, 2_000)
    expect(f.state.conversations).toHaveLength(count)
  })

  it('records the 1:1 chat an agent is already in rather than opening another', () => {
    const f = stepsFixture()
    const chat = f.state.conversations.find(c => c.kind === 'agent-chat' && c.agentIds.includes(f.lead))!
    delete agent(f.state, f.lead).chatId
    giveAgentsChats(f.state, 1_000)
    expect(agent(f.state, f.lead).chatId).toBe(chat.id)
    expect(f.state.conversations.filter(c => c.kind === 'agent-chat' && c.agentIds.includes(f.lead))).toEqual([chat])
  })
})

// 2026-11-09: anh Dee's Mac 3 showed offline from v1.4.42 on. An agent from before v4 has no project of its own and was
// placed by the first conversation it is in; its new 1:1 chat is in none, so that first one could be the chat, the fallback
// was the project 'lead', which his Swarm does not have, and its host's reads were refused "This project is unavailable".
describe('an agent\'s project, once it has its 1:1 chat', () => {
  it('is still the project of the conversations it works in, whichever is first', () => {
    const f = stepsFixture()
    const [legacy] = projectsOf(f.state)
    f.state.projects = [{ ...legacy, id: 'web' }]
    for (const c of f.state.conversations) if (c.kind !== 'agent-chat') c.projectId = 'web'
    // An agent added before its Swarm had projects keeps no project id of its own.
    delete agent(f.state, f.dev).projectId
    giveAgentsChats(f.state, 1_000)
    const chat = f.state.conversations.find(c => c.id === agent(f.state, f.dev).chatId)!
    f.state.conversations = [chat, ...f.state.conversations.filter(c => c !== chat)]
    expect(agentProjectId(f.state, agent(f.state, f.dev))).toBe('web')
    expect(canReadAgent(f.state, { kind: 'person', userId: 'owner', email: 'owner@example.com' }, agent(f.state, f.dev))).toBe(true)
  })
})
