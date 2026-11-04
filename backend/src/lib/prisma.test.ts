import type { PrismaClient } from '@prisma/client'
import { describe, expect, it, vi } from 'vitest'
import { env } from '../config/env.js'
import { prisma, prismaSecondary, readReplica } from './prisma.js'

it('leaves the database connected on a shutdown signal, for the process to close after its drain', () => {
  const disconnect = vi.spyOn(prisma, '$disconnect').mockResolvedValue()
  try {
    // Only the listeners registered in this test process: nothing is signalled for real.
    process.emit('SIGTERM')
    process.emit('SIGINT')
    expect(disconnect).not.toHaveBeenCalled()
  } finally { disconnect.mockRestore() }
})

describe('readReplica', () => {
  const main = 'mongodb+srv://user:pw@cluster.example.net/harness?retryWrites=true&appName=autonomous-code-prod'
  const fake = () => ({ $extends: () => ({ fake: true }) }) as unknown as PrismaClient

  it('is a second client on the main connection string with the secondary options and the pool defaults, by default', () => {
    const make = vi.fn(fake)
    const replica = readReplica(prisma, main, 'on', make)
    expect(replica).not.toBe(prisma)
    expect(make).toHaveBeenCalledWith('mongodb+srv://user:pw@cluster.example.net/harness?retryWrites=true&appName=autonomous-code-prod-secondary'
      + '&readPreference=secondaryPreferred&maxStalenessSeconds=90&maxPoolSize=20&serverSelectionTimeoutMS=10000')
  })

  it('is the main client itself when the switch is off: every moved read goes back to the primary', () => {
    const make = vi.fn(fake)
    expect(readReplica(prisma, main, 'off', make)).toBe(prisma)
    expect(make).not.toHaveBeenCalled()
  })

  it('is on unless the setting says off', () => {
    expect(env.DATABASE_SECONDARY_READS).toBe('on')
    expect(prismaSecondary).not.toBe(prisma)
  })
})
