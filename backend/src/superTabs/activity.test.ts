import { describe, expect, it } from 'vitest'
import { createSuperTab, touchActivity, visibleState, type Assignment, type Conversation, type SuperTabState } from './model.js'

const owner = { id: 'owner', email: 'owner@example.com' }
const configuration = { engine: 'codex', model: null, effort: null, contextWindow: null, engineVersion: null }
const assignment = (over: Partial<Assignment> = {}): Assignment => ({ id: 'attempt', agentId: 'a1', status: 'working', configuration,
  execution: { machineId: 'm', harnessId: 'h', machineOwnerId: 'owner' }, result: null, ...over })
const group = (id: string, over: Partial<Conversation> = {}): Conversation => ({ id, title: id, leadId: null, agentIds: [], archived: false,
  brief: '', checks: [], assignment: null, lastMessageSequence: 0, ...over })
/** A tab whose groups are [groups], and the same tab after a command changed what [change] says. */
function tab(groups: Conversation[]): SuperTabState {
  const state = createSuperTab('tab', 'Team', owner, 'test')
  state.conversations.push(...groups)
  return state
}
const AT = 1_790_000_000_000

describe('when a workgroup last had activity', () => {
  it('is the time of a message posted to it, and of no other group', () => {
    const before = tab([group('a'), group('b')])
    const after = structuredClone(before)
    touchActivity(before, after, [{ conversationId: 'a' }], AT)
    expect(after.conversations.find(c => c.id === 'a')!.lastActivityAt).toBe(AT)
    expect(after.conversations.find(c => c.id === 'b')!.lastActivityAt).toBeUndefined()
    expect(after.conversations.find(c => c.id === 'lead')!.lastActivityAt).toBeUndefined()
  })

  it('is the time its assignment changed hands, status or result', () => {
    const before = tab([group('a', { assignment: assignment() }), group('b', { assignment: assignment({ id: 'other' }) }), group('c')])
    for (const change of [{ status: 'needs_human' }, { result: 'Done: PR 12' }, { agentId: 'a2' }, { id: 'next' }] as Array<Partial<Assignment>>) {
      const after = structuredClone(before)
      Object.assign(after.conversations.find(c => c.id === 'a')!.assignment!, change)
      touchActivity(before, after, [], AT)
      expect(after.conversations.find(c => c.id === 'a')!.lastActivityAt, JSON.stringify(change)).toBe(AT)
      expect(after.conversations.find(c => c.id === 'b')!.lastActivityAt).toBeUndefined()
    }
  })

  it('is the time an assignment was first made or taken away', () => {
    const before = tab([group('a'), group('b', { assignment: assignment() })])
    const after = structuredClone(before)
    after.conversations.find(c => c.id === 'a')!.assignment = assignment()
    after.conversations.find(c => c.id === 'b')!.assignment = null
    touchActivity(before, after, [], AT)
    expect(after.conversations.find(c => c.id === 'a')!.lastActivityAt).toBe(AT)
    expect(after.conversations.find(c => c.id === 'b')!.lastActivityAt).toBe(AT)
  })

  it('is the time a workgroup was created', () => {
    const before = tab([])
    const after = tab([group('new')])
    touchActivity(before, after, [], AT)
    expect(after.conversations.find(c => c.id === 'new')!.lastActivityAt).toBe(AT)
    expect(after.conversations.find(c => c.id === 'lead')!.lastActivityAt).toBeUndefined()
  })

  it('does not move for a command that touched neither, and keeps the time a group already had', () => {
    const before = tab([group('a', { assignment: assignment(), lastActivityAt: 123 }), group('b', { lastActivityAt: 456 })])
    const after = structuredClone(before)
    // Fields that are not the assignment's who, status or result, and unrelated edits: not activity.
    after.conversations.find(c => c.id === 'a')!.assignment!.configuration = { ...configuration, model: 'opus' }
    after.conversations.find(c => c.id === 'b')!.archived = true
    after.paused = true
    touchActivity(before, after, [], AT)
    expect(after.conversations.find(c => c.id === 'a')!.lastActivityAt).toBe(123)
    expect(after.conversations.find(c => c.id === 'b')!.lastActivityAt).toBe(456)
  })

  it('reaches a reader in the group, and an older group without it reads as none', () => {
    const state = tab([group('a', { lastActivityAt: AT }), group('b')])
    const seen = visibleState(state, { kind: 'person', userId: 'owner', email: 'owner@example.com' })
    expect(seen.conversations.find(c => c.id === 'a')!.lastActivityAt).toBe(AT)
    expect(seen.conversations.find(c => c.id === 'b')!).not.toHaveProperty('lastActivityAt')
  })
})
