import { describe, expect, it } from 'vitest'
import { effectivePriority, priorityRank, type TaskPriority } from './taskPriority.js'

// Task #3117: a task's priority is its field, else the title marker the PM wrote before there was one (Desktop backlog.dart
// superTabTitlePriority), else P2.
describe('a task\'s priority', () => {
  it('is its field when it is one of P0 to P3, over any title marker', () => {
    for (const priority of ['P0', 'P1', 'P2', 'P3']) expect(effectivePriority({ priority, title: 'Fix login (urgent)' })).toBe(priority)
  })

  it('reads a legacy title marker when the field is missing or not a priority', () => {
    expect(effectivePriority({ title: 'Fix login (urgent)' })).toBe('P0')
    for (const priority of ['P4', 'p0', 'urgent', 0, null]) expect(effectivePriority({ priority, title: 'Fix login (urgent)' })).toBe('P0')
  })

  it('reads a leading URGENT word as P0', () => {
    for (const title of ['URGENT Fix login', 'URGENT: Fix login', 'urgent: fix login', '  Urgent fix login']) expect(effectivePriority({ title }), title).toBe('P0')
    // A word that only starts with it, or the word alone, marks nothing.
    for (const title of ['Urgently fix login', 'URGENT', 'URGENT: ']) expect(effectivePriority({ title }), title).toBe('P2')
  })

  it('reads a closing (urgent) as P0 and (high) as P1, with a name before it or "priority" after it', () => {
    for (const title of ['Fix login (urgent)', 'Fix login (Ken, urgent)', 'Fix login (URGENT)', 'Fix login (urgent priority)']) expect(effectivePriority({ title }), title).toBe('P0')
    for (const title of ['Fix login (high)', 'Fix login (Ken, high)', 'Fix login (high priority)', 'Fix login (Ken, High Priority) ']) expect(effectivePriority({ title }), title).toBe('P1')
  })

  it('is P2 with no marker', () => {
    for (const title of ['Fix login', 'Fix login (low)', 'Fix (urgent) login', 'Fix login (Ken)', '(urgent)', '']) expect(effectivePriority({ title }), title).toBe('P2')
    expect(effectivePriority({})).toBe('P2')
    expect(effectivePriority({ title: 7 })).toBe('P2')
  })

  it('ranks P0 first', () => {
    const shuffled: TaskPriority[] = ['P2', 'P0', 'P3', 'P1']
    expect(shuffled.sort((a, b) => priorityRank(a) - priorityRank(b))).toEqual(['P0', 'P1', 'P2', 'P3'])
  })
})
