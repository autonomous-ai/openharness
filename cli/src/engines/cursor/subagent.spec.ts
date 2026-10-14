import { afterEach, expect, it, vi } from 'vitest'
import { CursorNormalizer, cursorTaskId } from './normalizer.js'
import { CursorSubagentManager } from './subagent.js'

// No native child exists in this ordering fixture; never inspect a host engine home.
vi.mock('node:fs/promises', async original => ({ ...await original<object>(), readdir: async () => [] }))
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks() })

it.each([false, true])('keeps later task IDs outside the original Stop cleanup (revoked=%s)', async revoked => {
  vi.useFakeTimers()
  const emit = vi.fn(), normalizer = new CursorNormalizer('live', 'session')
  const manager = new CursorSubagentManager('/fixture/cursor', emit, '/fixture/cursor-data')
  const original = { toolUseId: 'original', input: { prompt: 'original' } }
  normalizer.ingestTaskHook(original); manager.register('session', original, normalizer)
  const ids = normalizer.pendingTaskIds()
  let current = true
  manager.closeParent('session', false, () => current, ids)
  const later = { toolUseId: 'later', input: { prompt: 'successor before its user record' } }
  normalizer.ingestTaskHook(later); manager.register('session', later, normalizer)
  if (revoked) current = false
  await vi.advanceTimersByTimeAsync(2_000)
  if (revoked) expect(emit).not.toHaveBeenCalled()
  else expect(emit).toHaveBeenCalledExactlyOnceWith('session', [expect.objectContaining({
    type: 'tool_end', payload: expect.objectContaining({ id: cursorTaskId('session', 'original') }),
  })])
  expect(normalizer.pendingTaskIds().has(cursorTaskId('session', 'later'))).toBe(true)
  manager.stop()
})
