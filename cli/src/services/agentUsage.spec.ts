import { afterEach, expect, it, vi } from 'vitest'
import { AgentTokenUsageCache } from '../lib/agentTokenUsage.js'
import { usageTarget } from '../lib/agentUsageWire.js'
import { createAgentUsage } from './agentUsage.js'

const target = usageTarget({ agentId: 'a', sessionId: 's', engine: 'claude', transcriptPath: '/fixture/transcript', registeredAt: 1 })
afterEach(() => vi.restoreAllMocks())

it('accepts only complete targets and aggregate snapshots; disposal stops its reader', async () => {
  const read = vi.spyOn(AgentTokenUsageCache.prototype, 'read').mockResolvedValue(null)
  const dispose = vi.spyOn(AgentTokenUsageCache.prototype, 'dispose')
  const service = createAgentUsage('/unused-fixture')
  expect(await service.read({ target: {} })).toEqual({ error: 'INVALID_USAGE_TARGET' })
  expect(read).not.toHaveBeenCalled()
  expect(await service.read({ target })).toEqual({ target, value: null })
  read.mockResolvedValueOnce({ totalTokens: -1, updatedAt: '' })
  expect(await service.read({ target })).toEqual({ error: 'INVALID_USAGE_READING' })
  read.mockRejectedValueOnce(new Error('unreadable'))
  expect(await service.read({ target })).toEqual({ error: 'USAGE_UNAVAILABLE' })
  const value = { totalTokens: 4, updatedAt: '2026-10-01T00:00:00Z', rawTranscript: 'must not cross' }
  read.mockResolvedValueOnce(value)
  expect(await service.read({ target })).toEqual({ target, value: { totalTokens: 4, updatedAt: value.updatedAt } })
  service.stop()
  expect(dispose).toHaveBeenCalledOnce()
})
