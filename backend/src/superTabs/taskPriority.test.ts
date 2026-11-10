import { describe, expect, it } from 'vitest'
import { TASK_PRIORITIES } from './taskPriority.js'

// A task's priority, P0-P3 (task #3117): one scale for the PM and people.
describe('task priorities', () => {
  it('are P0 to P3', () => {
    expect(TASK_PRIORITIES).toEqual(['P0', 'P1', 'P2', 'P3'])
  })
})
