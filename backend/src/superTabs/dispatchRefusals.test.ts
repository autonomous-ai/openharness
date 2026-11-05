import { describe, expect, it } from 'vitest'
import { RefusalMemory } from './dispatchRefusals.js'

// The crew dispatch's memory of refused picks (store.ts dispatchCrew, review 2 of #3230): bounded, and expired entries go
// whether or not their task is ever looked at again.
describe('the dispatch\'s refusal memory', () => {
  it('forgets an entry at its expiry, whether or not the same pick is asked about again', () => {
    const memory = new RefusalMemory(100)
    memory.remember('tab:task-a:round-1:ash', 1_000)
    memory.remember('tab:task-b:round-1:ash', 5_000)
    expect(memory.refused('tab:task-a:round-1:ash', 999)).toBe(true)
    // The task moved to another round: its old key is never asked about again, and still goes.
    memory.prune(1_000)
    expect(memory.size).toBe(1)
    expect(memory.refused('tab:task-a:round-1:ash', 999)).toBe(false)
    expect(memory.refused('tab:task-b:round-1:ash', 4_999)).toBe(true)
    expect(memory.refused('tab:task-b:round-1:ash', 5_000)).toBe(false)
  })

  it('holds at most its limit, forgetting the oldest first', () => {
    const memory = new RefusalMemory(3)
    for (const key of ['a', 'b', 'c', 'd']) memory.remember(key, 10_000)
    expect(memory.size).toBe(3)
    expect(memory.refused('a', 0)).toBe(false)
    expect(['b', 'c', 'd'].every(key => memory.refused(key, 0))).toBe(true)
  })
})
