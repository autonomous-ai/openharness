import { describe, expect, it } from 'vitest'
import { actorName, memberChanges, memberRowText } from './memberRows.js'
import type { Agent, Conversation, SuperTabState } from './model.js'

const agent = (id: string, name = id, displayName?: string) => ({ id, name, ...(displayName ? { displayName } : {}) }) as Agent
const group = (id: string, agentIds: string[], patch: Partial<Conversation> = {}) => ({ id, agentIds, ...patch }) as Conversation
const swarm = (conversations: Conversation[], agents: Agent[] = [agent('a'), agent('b'), agent('c')]) =>
  ({ conversations, agents, people: [{ id: 'ken', email: 'ken15@autonomous.ai', role: 'owner', generation: 'g' }] }) as unknown as SuperTabState

// Ken, 2026-11-02: nothing recorded who put a Reviewer in the project chat. Every agent added to or removed from a chat leaves
// a row naming who did it.
describe('who joined or left each chat in one command', () => {
  it('finds each agent added to or removed from a chat that was there before', () => {
    const before = swarm([group('task', ['a', 'b']), group('other', ['c'])])
    const after = swarm([group('task', ['a', 'c']), group('other', ['c'])])
    expect(memberChanges(before, after).map(c => [c.group.id, c.agent.id, c.added])).toEqual([['task', 'c', true], ['task', 'b', false]])
  })

  it('leaves out a chat the command opened, a Buddy chat, and an agent removed from the Swarm, whose removal says so', () => {
    const before = swarm([group('task', ['a', 'b']), group('buddy', ['a'], { kind: 'buddy' })])
    const after = swarm([group('task', ['a']), group('buddy', ['a', 'c'], { kind: 'buddy' }), group('new', ['a'])], [agent('a'), agent('c')])
    expect(memberChanges(before, after)).toEqual([])
  })

  it('finds nothing when no chat changed, in whatever order its members are kept', () => {
    const state = swarm([group('task', ['a', 'b'])])
    expect(memberChanges(state, swarm([group('task', ['a', 'b'])]))).toEqual([])
    expect(memberChanges(state, swarm([group('task', ['b', 'a'])]))).toEqual([])
  })
})

describe('the row that says so', () => {
  it('names who added or removed the agent, or says it joined or left itself', () => {
    expect(memberRowText({ id: 'ken', name: 'Ken' }, { id: 'finn', name: 'Finn 2' }, true)).toBe('Ken added Finn 2.')
    expect(memberRowText({ id: 'river', name: 'River' }, { id: 'finn', name: 'Finn 2' }, false)).toBe('River removed Finn 2.')
    expect(memberRowText({ id: 'finn', name: 'Finn 2' }, { id: 'finn', name: 'Finn 2' }, true)).toBe('Finn 2 joined.')
    expect(memberRowText({ id: 'finn', name: 'Finn 2' }, { id: 'finn', name: 'Finn 2' }, false)).toBe('Finn 2 left.')
  })

  it('names an agent by its display name and a person by their username, from a start\'s actor key too', () => {
    const state = swarm([], [agent('pm', 'Lead', 'River')])
    expect(actorName(state, 'agent:pm')).toBe('River')
    expect(actorName(state, 'person:ken')).toBe('ken15')
    expect(actorName(state, 'agent:gone')).toBeUndefined()
    expect(actorName(state, 'person:gone')).toBeUndefined()
  })
})
