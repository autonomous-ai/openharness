import { describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { z } from 'zod'
import { recordingDb, type Query } from '../lib/queryRecorder.test-support.js'
import { logger } from '../utils/logger.js'
import { commandSchema } from './commands.js'
import { RETIRED_COMMANDS, RETIRED_NOTE, type RetiredCommand } from './retired.js'
import { SuperTabStore } from './store.js'

const user = { sub: 'u1', email: 'u@example.com', autonomousEnv: 'prod', role: 'user' } as never

/** What the last older apps and agents sent for each retired command: the shape its schema had when the command went. */
const OLD_PAYLOADS = {
  'process.confirm': { projectId: 'lead', noteId: 'note-3' },
  'project.digest': { projectId: 'lead', time: '08:00', timeZone: 'Asia/Ho_Chi_Minh' },
} satisfies Record<RetiredCommand, object>

describe('commands Swarm v4 no longer has', () => {
  it('has an old payload for each, so each answer below is tried with what a client sent', () => {
    expect(Object.keys(OLD_PAYLOADS).sort()).toEqual([...RETIRED_COMMANDS].sort())
  })

  it.each(RETIRED_COMMANDS)('accepts %s as an older client sent it and keeps only its type', type => {
    expect(commandSchema.parse({ type, ...OLD_PAYLOADS[type] })).toEqual({ type })
  })

  it.each(RETIRED_COMMANDS)('answers %s as ignored, reads and writes nothing, and logs who sent it', async type => {
    const queries: Query[] = []
    const info = vi.spyOn(logger, 'info').mockImplementation(() => undefined)
    const store = new SuperTabStore(recordingDb(queries) as PrismaClient)
    const command = commandSchema.parse({ type, ...OLD_PAYLOADS[type] })

    expect(await store.execute(user, 'tab-1', { operationId: 'op-1', command }, undefined, undefined, { kind: 'cli', version: '0.5.34' }))
      .toEqual({ result: { ignored: true, note: RETIRED_NOTE }, parts: [] })
    expect(queries).toEqual([])
    expect(info).toHaveBeenCalledWith('Swarm command retired', { type, client: 'cli', version: '0.5.34' })
    info.mockRestore()
  })

  it('still refuses a type nobody retired, and serves each type from one schema', () => {
    expect(commandSchema.safeParse({ type: 'project.nonsense', projectId: 'lead' }).success).toBe(false)
    const served = (commandSchema.options as unknown as { shape: { type: z.ZodLiteral<string> } }[]).flatMap(option => [...option.shape.type.values])
    expect(served.filter((type, i) => served.indexOf(type) !== i)).toEqual([])
    expect(served).toEqual(expect.arrayContaining([...RETIRED_COMMANDS, 'message.send']))
  })
})
