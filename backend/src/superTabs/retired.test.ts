import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { z } from 'zod'
import { recordingDb, type Query } from '../lib/queryRecorder.test-support.js'
import { commandSchema } from './commands.js'
import { RETIRED_COMMANDS, RETIRED_NOTE } from './retired.js'
import { counted, OLD_PAYLOADS } from './retired.test-support.js'
import { SuperTabStore } from './store.js'

const user = { sub: 'u1', email: 'u@example.com', autonomousEnv: 'prod', role: 'user' } as never

describe('commands Swarm v4 no longer has', () => {
  it('has an old payload for each, so each answer is tried with what a client sent', () => {
    expect(Object.keys(OLD_PAYLOADS).sort()).toEqual([...RETIRED_COMMANDS].sort())
  })

  it('retires what the people chat\'s profile sent: a person\'s status, time zone, username and name', () => {
    expect(RETIRED_COMMANDS).toEqual(expect.arrayContaining(['member.status', 'member.timeZone', 'member.username', 'member.name']))
  })

  it.each(RETIRED_COMMANDS)('accepts %s as an older client sent it and keeps only its type', type => {
    expect(commandSchema.parse({ type, ...OLD_PAYLOADS[type] })).toEqual({ type })
  })

  it.each(RETIRED_COMMANDS)('answers %s as ignored, reads and writes nothing, and counts it by type and client', async type => {
    const queries: Query[] = []
    const store = new SuperTabStore(recordingDb(queries) as PrismaClient)
    const command = commandSchema.parse({ type, ...OLD_PAYLOADS[type] })
    const [cli, other] = [await counted(type, 'cli'), await counted(type, 'other')]
    const answer = { result: { ignored: true, note: RETIRED_NOTE }, parts: [] }

    expect(await store.execute(user, 'tab-1', { operationId: 'op-1', command }, undefined, undefined, { kind: 'cli', version: '0.5.34' })).toEqual(answer)
    // An agent's, from a client that declares none: the same answer, and the database is never asked.
    expect(await store.execute(user, 'tab-1', { operationId: 'op-2', command }, 'agent-1')).toEqual(answer)
    expect(queries).toEqual([])
    expect([await counted(type, 'cli'), await counted(type, 'other')]).toEqual([cli + 1, other + 1])
  })

  it('still refuses a type nobody retired, and serves each type from one schema', () => {
    expect(commandSchema.safeParse({ type: 'project.nonsense', projectId: 'lead' }).success).toBe(false)
    const served = (commandSchema.options as unknown as { shape: { type: z.ZodLiteral<string> } }[]).flatMap(option => [...option.shape.type.values])
    expect(served.filter((type, i) => served.indexOf(type) !== i)).toEqual([])
    expect(served).toEqual(expect.arrayContaining([...RETIRED_COMMANDS, 'message.send']))
  })
})
