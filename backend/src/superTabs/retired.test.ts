import { describe, expect, it } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { z } from 'zod'
import { recordingDb, type Query } from '../lib/queryRecorder.test-support.js'
import { commandSchema } from './commands.js'
import { REFUSED_TO_PEOPLE, RETIRED_COMMANDS, RETIRED_NOTE, RETIRED_STEP } from './retired.js'
import { counted, OLD_PAYLOADS } from './retired.test-support.js'
import { SuperTabStore } from './store.js'

const user = { sub: 'u1', email: 'u@example.com', autonomousEnv: 'prod', role: 'user' } as never

describe('commands Swarm v4 no longer has', () => {
  it('has an old payload for each, so each answer is tried with what a client sent', () => {
    expect(Object.keys(OLD_PAYLOADS).sort()).toEqual([...RETIRED_COMMANDS].sort())
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

    const asPerson = store.execute(user, 'tab-1', { operationId: 'op-1', command }, undefined, undefined, { kind: 'cli', version: '0.5.34' })
    // A person's that an older app would take an ok answer for as saved is refused in words it shows (REFUSED_TO_PEOPLE).
    const refused = REFUSED_TO_PEOPLE[type]
    if (refused) await expect(asPerson).rejects.toMatchObject(refused)
    else expect(await asPerson).toEqual(answer)
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

// Steps and linked tasks are gone with Swarm v4 (2026-11-10): an agent of an older CLI still opens a review or a test of its task with
// `reviewOf`, and is told nothing was done rather than given a task nobody reads. It is counted as a retired command, under a type of its own.
describe('a step an older agent opens', () => {
  it('answers a conversation.create naming reviewOf or step as ignored, reads and writes nothing, and counts it', async () => {
    const queries: Query[] = []
    const store = new SuperTabStore(recordingDb(queries) as PrismaClient)
    const before = await counted(RETIRED_STEP, 'cli')
    for (const step of [{ reviewOf: 'task-1', step: 'Security review' }, { reviewOf: 'task-1' }, { step: 'Test' }]) {
      const command = commandSchema.parse({ type: 'conversation.create', title: 'Review', brief: 'Review it.', checks: [], ...step })
      expect(await store.execute(user, 'tab-1', { operationId: 'op-1', command }, 'agent-1', undefined, { kind: 'cli', version: '0.5.34' }))
        .toEqual({ result: { ignored: true, note: RETIRED_NOTE }, parts: [] })
    }
    expect(queries).toEqual([])
    expect(await counted(RETIRED_STEP, 'cli')).toBe(before + 3)
  })
})

// Desktop sends `oneBuddy` with every post and reaction while its last read said the Swarm had one Buddy per person
// (controller.dart), and keeps that until it restarts: refusing it would stop a running Desktop posting anything.
describe('a running Desktop\'s Buddy flag', () => {
  it('takes a post and a reaction that still carry it', () => {
    expect(commandSchema.safeParse({ type: 'message.send', conversationId: 'c', text: 'Hi', replyTo: null, recipientIds: [], oneBuddy: true }).success).toBe(true)
    expect(commandSchema.safeParse({ type: 'message.react', conversationId: 'c', messageId: 'm', emoji: 'eyes', on: true, oneBuddy: true }).success).toBe(true)
  })
})
