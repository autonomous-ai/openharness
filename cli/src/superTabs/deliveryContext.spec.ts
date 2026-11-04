import { describe, expect, it } from 'vitest'
import { placeLine, threadLine, workLine } from './deliveryContext.js'

const state = {
  projects: [{ id: 'app', name: 'App', leadConversationId: 'lead-app' }],
  people: [{ id: 'ken', email: 'ken@example.com', username: 'ken15' }] as Array<Record<string, unknown>>,
  agents: [{ id: 'pm', name: 'PM' }, { id: 'dev1', name: 'Dev1' }, { id: 'buddy', name: 'Ken\'s Buddy', buddyOf: { personId: 'ken' } }],
  conversations: [
    { id: 'lead-app', projectId: 'app', title: 'App', leadId: 'pm', agentIds: ['pm'], archived: false, assignment: null },
    { id: 'g12', projectId: 'app', number: 12, title: 'Fix login', leadId: 'pm', archived: false, assignment: { agentId: 'dev1', status: 'working' } },
    { id: 'g13', projectId: 'app', number: 13, title: 'Review: Fix login', reviewOf: 'g12', leadId: 'pm', archived: false, assignment: null },
    { id: 'g14', projectId: 'app', number: 14, title: 'Docs', leadId: 'pm', archived: false, assignment: { agentId: 'dev1', status: 'review' } },
    { id: 'g15', projectId: 'app', number: 15, title: 'Old', leadId: 'pm', archived: false, assignment: { agentId: 'dev1', status: 'done' } },
    { id: 'chat', kind: 'buddy', projectId: 'app', title: 'Buddy', leadId: null, agentIds: ['buddy'], archived: false, assignment: null },
  ],
}

describe('placeLine', () => {
  it('names a task by its number and title', () => {
    expect(placeLine(state, 'g12')).toBe('In task #12 "Fix login" (conversation g12).')
  })
  it('names the project chat', () => {
    expect(placeLine(state, 'lead-app')).toBe('In the project chat of App (conversation lead-app).')
  })
  // By the name the Swarm shows them, never their email (task #2954).
  it('names a Buddy chat by its person', () => {
    expect(placeLine(state, 'chat')).toBe('In ken15\'s Buddy chat (conversation chat).')
    const named = { ...state, people: state.people.map(p => ({ ...p, name: 'Ken' })) }
    expect(placeLine(named, 'chat')).toBe('In Ken\'s Buddy chat (conversation chat).')
  })
  it('gives the id alone when it does not know the conversation', () => {
    expect(placeLine(state, 'gone')).toBe('In conversation gone.')
  })
})

describe('workLine', () => {
  it('names the agent\'s open tasks and leaves out finished ones', () => {
    expect(workLine(state, 'dev1')).toBe('You are assigned task #12 "Fix login" (working) and task #14 "Docs" (review).')
  })
  it('names three, then how many more', () => {
    const many = { ...state, conversations: [...state.conversations,
      ...[20, 21, 22].map(n => ({ id: `g${n}`, projectId: 'app', number: n, title: `T${n}`, leadId: 'pm', archived: false, assignment: { agentId: 'dev1', status: 'working' } }))] }
    expect(workLine(many, 'dev1')).toBe('You are assigned task #12 "Fix login" (working), task #14 "Docs" (review) and task #20 "T20" (working). And 2 more: mine.')
  })
  it('gives the coordinator its project\'s open tasks', () => {
    // g12 and g14: the linked g13 is a step of g12, not a task of its own.
    expect(workLine(state, 'pm')).toBe('Open tasks in your project: 2; mine lists them.')
  })
  it('says nothing for an agent with none', () => {
    expect(workLine(state, 'nobody')).toBeNull()
  })
})

describe('threadLine', () => {
  it('names the root, its replies and who wrote them, and how to read it', () => {
    expect(threadLine({ author: 'Ken', createdAt: '2026-11-02T09:15:30.000Z', text: 'Should we ship today?\nDetails…' }, 4, ['Dev1', 'Rev1'],
      'harness super-tab --tab t messages g12 --thread m1')).toBe(
      'In a thread Ken started (2026-11-02 09:15 UTC): "Should we ship today?" — 4 replies so far, from Dev1, Rev1. '
      + 'Read the whole thread before acting on it: harness super-tab --tab t messages g12 --thread m1')
  })
  it('keeps the root and the command without counts', () => {
    expect(threadLine({ author: 'Ken', createdAt: '2026-11-02T09:15:30.000Z', text: 'Ship?' }, null, [], 'cmd')).toBe(
      'In a thread Ken started (2026-11-02 09:15 UTC): "Ship?". Read the whole thread before acting on it: cmd')
  })
  it('cuts a long root line at 200 characters', () => {
    expect(threadLine({ author: 'Ken', createdAt: '2026-11-02T09:15:30.000Z', text: 'r'.repeat(250) }, 2, ['A'], 'cmd'))
      .toContain(`"${'r'.repeat(200)}…"`)
  })
})

describe('steps', () => {
  const stepped = { ...state, conversations: [...state.conversations,
    { id: 'g20', projectId: 'app', number: 20, title: 'Thiết kế "v2"', step: 'Thiết kế "v2"', reviewOf: 'g12', leadId: 'pm', archived: false, assignment: { agentId: 'rev', status: 'working' } }] }
  it('a step\'s row says its task and step', () => {
    expect(placeLine(stepped, 'g20')).toBe('In task #12 "Fix login", step "Thiết kế \\"v2\\"" (conversation g20).')
  })
  it('names a step the agent holds by its task', () => {
    expect(workLine(stepped, 'rev')).toBe('You are assigned task #12 "Fix login", step "Thiết kế \\"v2\\"" (working).')
  })
})

describe('a linked task with no step name', () => {
  it('is said as its task and its title', () => {
    expect(placeLine(state, 'g13')).toBe('In task #12 "Fix login", step "Review: Fix login" (conversation g13).')
  })
})
