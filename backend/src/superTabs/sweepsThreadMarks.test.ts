import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { logger } from '../utils/logger.js'
import { threadMarks } from './sweeps.js'

describe('the hourly thread-mark sweep inside the Swarm sweeps', () => {
  it('says its failure and answers, so the sweeps after it in the pass still run', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => logger)
    // Every call fails, as with the database out of reach.
    const reset = async () => { throw new Error('connection reset') }
    const failing = new Proxy({}, { get: (_, key) => key === 'then' ? undefined : key === '$runCommandRaw' ? reset
      : new Proxy({}, { get: (__, method) => method === 'then' ? undefined : reset }) }) as unknown as PrismaClient
    await expect(threadMarks(failing, Date.now())).resolves.toEqual({ failed: true })
    expect(warn).toHaveBeenCalledWith('[swarm-sweeps] thread marks failed', { error: 'connection reset' })
    warn.mockRestore()
  })
})
