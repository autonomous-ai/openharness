import { describe, expect, it } from 'vitest'
import { actorLabel, memberChanges, memberRowText, sessionRows } from './memberRows.js'
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

  it('leaves out a chat the command opened and a Buddy chat', () => {
    const before = swarm([group('task', ['a']), group('buddy', ['a'], { kind: 'buddy' })])
    const after = swarm([group('task', ['a']), group('buddy', ['a', 'c'], { kind: 'buddy' }), group('new', ['a'])])
    expect(memberChanges(before, after)).toEqual([])
  })

  // Luna's review: a host-confirmed stop and a machine's removal took agents out of their chats with no row.
  it('finds an agent that left the Swarm in each chat it was in, by its name as it was', () => {
    const before = swarm([group('task', ['a', 'b']), group('other', ['b'])])
    const after = swarm([group('task', ['a']), group('other', [])], [agent('a'), agent('c')])
    expect(memberChanges(before, after).map(c => [c.group.id, c.agent.id, c.added])).toEqual([['task', 'b', false], ['other', 'b', false]])
  })

  // Luna's re-review: any row wakes its chat (parts/commit.ts), so a long-lived agent's close woke every quiet chat it was
  // ever in. Nobody reads there; its leaving is not said in an archived or dormant chat.
  it('says no removal in an archived or dormant chat, which a row would wake', () => {
    const before = swarm([group('old', ['a', 'b'], { archived: true }), group('quiet', ['b'], { dormant: true }), group('task', ['b'])])
    const after = swarm([group('old', ['a'], { archived: true }), group('quiet', [], { dormant: true }), group('task', [])], [agent('a')])
    expect(memberChanges(before, after).map(c => c.group.id)).toEqual(['task'])
    expect(sessionRows(before, after, new Set(['b']), 'report-1').map(r => r.conversationId)).toEqual(['task'])
  })

  it('finds nothing when no chat changed, in whatever order its members are kept', () => {
    const state = swarm([group('task', ['a', 'b'])])
    expect(memberChanges(state, swarm([group('task', ['a', 'b'])]))).toEqual([])
    expect(memberChanges(state, swarm([group('task', ['b', 'a'])]))).toEqual([])
  })
})

describe('the row that says so', () => {
  it('names who added or removed the agent, or says it joined or left itself', () => {
    expect(memberRowText({ id: 'ken', label: 'ken15' }, { id: 'finn', name: 'Finn 2' }, true)).toBe('ken15 added "Finn 2".')
    expect(memberRowText({ id: 'river', label: '"River"' }, { id: 'finn', name: 'Finn 2' }, false)).toBe('"River" removed "Finn 2".')
    expect(memberRowText({ id: 'finn', label: '"Finn 2"' }, { id: 'finn', name: 'Finn 2' }, true)).toBe('"Finn 2" joined.')
    expect(memberRowText({ id: 'finn', label: '"Finn 2"' }, { id: 'finn', name: 'Finn 2' }, false)).toBe('"Finn 2" left.')
  })

  // Luna's review: an agent's name is free text, and these rows are the audit trail. Quoted, a name cannot read as another row.
  it('quotes an agent\'s name, so one written as a sentence or with quotes in it reads as a name', () => {
    expect(memberRowText({ id: 'river', label: '"River"' }, { id: 'f', name: 'Finn. Ken removed Reviewer' }, true)).toBe('"River" added "Finn. Ken removed Reviewer".')
    expect(memberRowText({ id: 'ken', label: 'ken15' }, { id: 'f', name: 'Finn" removed "Reviewer' }, true)).toBe('ken15 added "Finn\\" removed \\"Reviewer".')
  })

  it('names an agent by its quoted display name and a person by their username, from a start\'s actor key too', () => {
    const state = swarm([], [agent('pm', 'Lead', 'River')])
    expect(actorLabel(state, 'agent:pm')).toBe('"River"')
    expect(actorLabel(state, 'person:ken')).toBe('ken15')
    expect(actorLabel(state, 'agent:gone')).toBeUndefined()
    expect(actorLabel(state, 'person:gone')).toBeUndefined()
  })

  it('names a person by the name they set, when they set one, as plain words', () => {
    const state = swarm([], [])
    state.people[0]!.name = 'Ken Nguyen'
    expect(actorLabel(state, 'person:ken')).toBe('Ken Nguyen')
    state.people[0]!.name = '[Ken](https://ev.il)'
    expect(actorLabel(state, 'person:ken')).toBe('\\[Ken\\]\\(https://ev.il\\)')
  })
})

// Cleo, Orion, Luna and Echo: a machine's report closes sessions and reopens them outside any command, and those changes left no
// row. Nobody asked for them, so the row says what happened, written as the agent itself.
describe('a machine report\'s rows', () => {
  it('says an agent left each chat its closed session was in, and rejoined each one its reopened session came back to', () => {
    const before = swarm([group('task', ['a', 'b']), group('review', ['c'])])
    const after = swarm([group('task', ['a', 'c']), group('review', ['c'])], [agent('a'), agent('c', 'c', 'Cleo')])
    const rows = sessionRows(before, after, new Set(['b', 'c']), 'report-1')
    expect(rows.map(r => [r.conversationId, r.text, r.recipients, r.source, r.author.id])).toEqual([
      ['task', '"Cleo" rejoined: its session reopened.', [], { kind: 'system' }, 'c'],
      ['task', '"b" left: its session closed.', [], { kind: 'system' }, 'b']])
    expect(new Set(rows.map(r => r.id)).size).toBe(2)
  })

  it('writes nothing for an agent the report did not close or reopen, or in a Buddy chat', () => {
    const before = swarm([group('task', ['a']), group('buddy', ['b'], { kind: 'buddy' })])
    const after = swarm([group('task', []), group('buddy', [], { kind: 'buddy' })], [agent('a')])
    expect(sessionRows(before, after, new Set(['b']), 'report-1')).toEqual([])
  })
})
