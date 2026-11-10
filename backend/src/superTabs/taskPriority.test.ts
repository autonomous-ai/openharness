import { describe, expect, it } from 'vitest'
import { TASK_PRIORITIES, proposalPriority } from './taskPriority.js'

// A task's priority, P0-P3 (task #3117): one scale for the PM, people and Buddies' proposals.
describe('task priorities', () => {
  it('are P0 to P3', () => {
    expect(TASK_PRIORITIES).toEqual(['P0', 'P1', 'P2', 'P3'])
  })

  it('maps a Buddy proposal\'s high, normal and low onto P1, P2 and P3, and never onto P0', () => {
    expect(proposalPriority('high')).toBe('P1')
    expect(proposalPriority('normal')).toBe('P2')
    expect(proposalPriority('low')).toBe('P3')
    for (const other of [undefined, null, '', 'urgent', 'P0', 3]) expect(proposalPriority(other), String(other)).toBe('P2')
  })
})
