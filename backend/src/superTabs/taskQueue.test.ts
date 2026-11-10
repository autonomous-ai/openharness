import { describe, expect, it } from 'vitest'
import { createSuperTab, type Conversation } from './model.js'
import { projectsOf } from './projects.js'
import { placeAfter, queueKey, queueOrder, queueSiblings } from './taskQueue.js'

// A project's Next up (Tasks view, #2569): one sparse rank per task, so a move rewrites only the task moved.
const task = (id: string, number: number, queueRank?: number) => ({ id, number, ...queueRank === undefined ? {} : { queueRank } })

describe('the Next-up queue order', () => {
  const tasks = [task('a', 1), task('b', 2), task('c', 3)]

  it('sorts an unranked task by its number, so a new task comes last', () => {
    expect(queueKey(task('a', 7))).toBe(7)
    expect(queueKey(task('a', 7, 0.5))).toBe(0.5)
    expect(queueKey({})).toBe(0)
    const moved = [task('a', 1, 3.5), task('b', 2), task('c', 3), task('new', 4)]
    expect(queueOrder(moved).map(t => t.id)).toEqual(['b', 'c', 'a', 'new'])
    // A tie goes by number.
    expect(queueOrder([task('late', 9, 2), task('early', 2)]).map(t => t.id)).toEqual(['early', 'late'])
  })

  it('moves a task to the top, one below the first', () => {
    expect(placeAfter(tasks, 'c', null)).toEqual(new Map([['c', 0]]))
  })

  it('moves a task between two others, at their midpoint', () => {
    expect(placeAfter(tasks, 'c', 'a')).toEqual(new Map([['c', 1.5]]))
    expect(placeAfter(tasks, 'a', 'b')).toEqual(new Map([['a', 2.5]]))
  })

  it('moves a task to the bottom, one past the last', () => {
    expect(placeAfter(tasks, 'a', 'c')).toEqual(new Map([['a', 4]]))
  })

  it('renumbers every task 1..n in order once a gap runs out', () => {
    const tight = [task('a', 1, 1), task('b', 2, 1 + 5e-7), task('c', 3)]
    expect(placeAfter(tight, 'c', 'a')).toEqual(new Map([['a', 1], ['c', 2], ['b', 3]]))
    // Two tasks at the same rank leave no gap either.
    const tied = [task('a', 1, 2), task('b', 2), task('c', 3)]
    expect(placeAfter(tied, 'c', 'a')).toEqual(new Map([['a', 1], ['c', 2], ['b', 3]]))
  })

  it('lands in the same place when the same move comes again', () => {
    const once = placeAfter(tasks, 'c', 'a')
    const after = tasks.map(t => ({ ...t, ...once.has(t.id) ? { queueRank: once.get(t.id)! } : {} }))
    expect(placeAfter(after, 'c', 'a')).toEqual(once)
  })
})

// Proposal cards are gone (2026-11-10), but the cards made before are stored: one its PM never accepted or reshaped (Later too) is
// still no task, so nothing queues it or hands it out.
describe('a stored proposal card in Next up', () => {
  it('stays out until its PM accepted or reshaped it, as a task with no card is in', () => {
    const state = createSuperTab('swarm', 'Team', { id: 'owner', email: 'owner@example.com' }, 'test')
    const group = (id: string, number: number, proposal?: Conversation['proposal']): Conversation => ({ id, number, title: id, leadId: null, agentIds: [],
      archived: false, brief: 'Keep drafts.', checks: [], assignment: null, lastMessageSequence: 0, ...proposal ? { proposal } : {} })
    state.conversations.push(group('undecided', 2, { senders: [] }), group('later', 3, { senders: [], decision: { kind: 'later', reason: 'PM' } }), group('accepted', 4, { senders: [], decision: { kind: 'accept', reason: 'PM' } }),
      group('reshaped', 5, { senders: [], decision: { kind: 'reshape', reason: 'PM' } }), group('task', 6))
    expect(queueSiblings(state, projectsOf(state)[0]!).map(c => c.id)).toEqual(['accepted', 'reshaped', 'task'])
  })
})
