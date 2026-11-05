import { describe, expect, it } from 'vitest'
import { PRIORITY_MEANING, TASK_PRIORITIES, priorityLine, proposalPriority, titlePriority } from './taskPriority.js'

// A task's priority, P0-P3 (task #3117): one scale for the PM, people and Buddies' proposals.
describe('task priorities', () => {
  it('are P0 to P3, each with its meaning in plain words', () => {
    expect(TASK_PRIORITIES).toEqual(['P0', 'P1', 'P2', 'P3'])
    expect(PRIORITY_MEANING).toEqual({
      P0: 'Hotfix: something shipped is broken',
      P1: 'Needed by users soon',
      P2: 'Planned goal',
      P3: 'Tools, docs or process',
    })
  })

  it('maps a Buddy proposal\'s high, normal and low onto P1, P2 and P3, and never onto P0', () => {
    expect(proposalPriority('high')).toBe('P1')
    expect(proposalPriority('normal')).toBe('P2')
    expect(proposalPriority('low')).toBe('P3')
    for (const other of [undefined, null, '', 'urgent', 'P0', 3]) expect(proposalPriority(other), String(other)).toBe('P2')
  })

  it('reads a title\'s old urgent or high marker as P0 or P1, as the apps read it', () => {
    expect(titlePriority('URGENT: Sign-in broken')).toBe('P0')
    expect(titlePriority('Sign-in broken (urgent)')).toBe('P0')
    expect(titlePriority('Faster sync (Ken, high)')).toBe('P1')
    expect(titlePriority('Faster sync (high priority)')).toBe('P1')
    for (const plain of ['Faster sync', 'URGENT', '(urgent)', 'Fix the (urgent) path']) expect(titlePriority(plain), plain).toBeNull()
  })

  it('says a change in one line, naming who changed it and what it was', () => {
    expect(priorityLine('Ken', 'P0', 'P2')).toBe('Ken changed the priority to P0, hotfix: something shipped is broken (was P2).')
    expect(priorityLine('River', 'P3', 'P1')).toBe('River changed the priority to P3, tools, docs or process (was P1).')
  })
})
