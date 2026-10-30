import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'
import { threadMarks } from './sweeps.js'

describe('the hourly thread-mark sweep inside the Swarm sweeps', () => {
  it('says its failure and answers, so the sweeps after it in the pass still run', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    const failing = { superTabThreadMark: { aggregateRaw: async () => { throw new Error('connection reset') } },
      $runCommandRaw: async () => { throw new Error('connection reset') } } as unknown as PrismaClient
    await expect(threadMarks(failing, Date.now())).resolves.toEqual({ failed: true })
    expect(warn).toHaveBeenCalledWith('[swarm-sweeps] thread marks failed', { error: 'connection reset' })
    warn.mockRestore()
  })
})
