import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { planDatabase } from './plans.test-support.js'

// #2299: three reports hid a Hub item only from each reporter. The hide row was created without `restoredAt`, and on Mongo
// `restoredAt: null` matches only an explicit null, so every other reader still saw it while the review queue said hidden.
const shared = vi.hoisted(() => ({ db: null as unknown as PrismaClient }))
vi.mock('../src/lib/prisma.js', async original => ({ ...await original<typeof import('../src/lib/prisma.js')>(), get prisma() { return shared.db } }))
const { fileReport, hiddenFrom, isHiddenFrom } = await import('../src/lib/communityReports.js')

let replica: MongoMemoryReplSet
let db: PrismaClient
const env = 'prod'

beforeAll(async () => {
  ({ replica, db } = await planDatabase('community_reports_test'))
  shared.db = db
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const report = (targetType: 'harness' | 'comment', targetId: string, harnessId: string, userId: string) =>
  fileReport({ autonomousEnv: env, targetType, targetId, harnessId, userId, reason: 'spam' })

/** Whether anonymous readers and a stranger are both kept from [targetId], by both readers of the hidden list. */
async function hiddenFromEveryone(targetType: 'harness' | 'comment', targetId: string, harnessId?: string) {
  return {
    anonymous: await isHiddenFrom(env, targetType, targetId),
    stranger: await isHiddenFrom(env, targetType, targetId, 'stranger'),
    anonymousList: (await hiddenFrom(env, targetType, undefined, harnessId)).includes(targetId),
    strangerList: (await hiddenFrom(env, targetType, 'stranger', harnessId)).includes(targetId),
  }
}
const everyone = { anonymous: true, stranger: true, anonymousList: true, strangerList: true }
const nobody = { anonymous: false, stranger: false, anonymousList: false, strangerList: false }

describe('community reports on Mongo', () => {
  it('three reports hide a harness from readers who did not report it', async () => {
    const harness = randomUUID()
    for (const reader of ['r1', 'r2', 'r3']) await report('harness', harness, harness, reader)
    expect(await hiddenFromEveryone('harness', harness)).toEqual(everyone)
  })

  it('the hide row three reports write stores restoredAt as an explicit null', async () => {
    const harness = randomUUID()
    for (const reader of ['r1', 'r2', 'r3']) await report('harness', harness, harness, reader)
    expect(await db.$runCommandRaw({ count: 'community_hidden', query: { targetId: harness, restoredAt: { $type: 'null' } } })).toMatchObject({ n: 1 })
  })

  it('three reports hide a comment from readers who did not report it', async () => {
    const harness = randomUUID(), comment = randomUUID()
    for (const reader of ['r1', 'r2', 'r3']) await report('comment', comment, harness, reader)
    expect(await hiddenFromEveryone('comment', comment)).toEqual(everyone)
    expect(await hiddenFromEveryone('comment', comment, harness)).toEqual(everyone)
    expect((await hiddenFrom(env, 'comment', undefined, randomUUID())).includes(comment)).toBe(false)
  })

  it('a hide row stored without restoredAt, as before the fix, hides it too', async () => {
    const harness = randomUUID(), comment = randomUUID()
    await db.$runCommandRaw({ insert: 'community_hidden', documents: [
      { autonomousEnv: env, targetType: 'harness', targetId: harness, harnessId: harness, createdAt: { $date: new Date().toISOString() } },
      { autonomousEnv: env, targetType: 'comment', targetId: comment, harnessId: harness, createdAt: { $date: new Date().toISOString() } },
    ] })
    expect(await db.$runCommandRaw({ count: 'community_hidden', query: { targetId: { $in: [harness, comment] }, restoredAt: { $exists: true } } }))
      .toMatchObject({ n: 0 })
    expect(await hiddenFromEveryone('harness', harness)).toEqual(everyone)
    expect(await hiddenFromEveryone('comment', comment, harness)).toEqual(everyone)
  })

  it('two reports hide it only from the readers who reported it', async () => {
    const harness = randomUUID()
    for (const reader of ['r1', 'r2']) await report('harness', harness, harness, reader)
    expect(await hiddenFromEveryone('harness', harness)).toEqual(nobody)
    expect(await isHiddenFrom(env, 'harness', harness, 'r1')).toBe(true)
    expect(await hiddenFrom(env, 'harness', 'r2')).toContain(harness)
  })

  it('a restored item is shown again until three new reports', async () => {
    const harness = randomUUID()
    await db.communityHidden.create({ data: { autonomousEnv: env, targetType: 'harness', targetId: harness, harnessId: harness, restoredAt: new Date(Date.now() - 1000) } })
    expect(await hiddenFromEveryone('harness', harness)).toEqual(nobody)
    for (const reader of ['r1', 'r2', 'r3']) await report('harness', harness, harness, reader)
    expect(await hiddenFromEveryone('harness', harness)).toEqual(everyone)
  })
})
