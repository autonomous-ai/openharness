import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { planDatabase } from './plans.test-support.js'
import { dropPushDevice, type PushPlatform } from '../src/push/devices.js'

// A fresh loopback replica set with the schema pushed; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
beforeAll(async () => { ({ replica, db } = await planDatabase('push_devices_test')) })
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

let next = 0
const person = () => `person-${++next}`
const token = (n: number) => `${'ab'.repeat(32)}${n}`

// Records written by a supported older backend; the current product cannot register a new one.
async function legacyToken(userId: string, platform: PushPlatform, value: string) {
  const id = createHash('sha256').update(`${platform}\n${value}`).digest('hex')
  await db.pushDevice.create({ data: { id, userId, platform, token: value, seenAt: new Date() } })
  return id
}

describe('legacy push token cleanup after Swarm removal', () => {
  it('drops only the requested token belonging to the signed-in person', async () => {
    const user = person()
    const id = await legacyToken(user, 'ios', token(1))
    const kept = await legacyToken(user, 'ios', token(2))
    expect(await dropPushDevice(db, user, { platform: 'ios', token: token(1) })).toBe(true)
    expect(await db.pushDevice.findUnique({ where: { id } })).toBeNull()
    expect(await db.pushDevice.findUnique({ where: { id: kept } })).toMatchObject({ userId: user, token: token(2) })
  })

  it('cannot unregister a token belonging to another person', async () => {
    const owner = person(), other = person()
    const id = await legacyToken(owner, 'android', token(3))
    expect(await dropPushDevice(db, other, { platform: 'android', token: token(3) })).toBe(false)
    expect(await db.pushDevice.findUnique({ where: { id } })).toMatchObject({ userId: owner, token: token(3) })
  })

  it('accepts repeated cleanup without deleting anything else', async () => {
    const user = person()
    await legacyToken(user, 'ios', token(4))
    expect(await dropPushDevice(db, user, { platform: 'ios', token: token(4) })).toBe(true)
    expect(await dropPushDevice(db, user, { platform: 'ios', token: token(4) })).toBe(false)
  })

  it('keeps the other platform when the token text is the same', async () => {
    const user = person()
    const ios = await legacyToken(user, 'ios', token(5))
    const android = await legacyToken(user, 'android', token(5))
    expect(await dropPushDevice(db, user, { platform: 'ios', token: token(5) })).toBe(true)
    expect(await db.pushDevice.findUnique({ where: { id: ios } })).toBeNull()
    expect(await db.pushDevice.findUnique({ where: { id: android } })).toMatchObject({ platform: 'android', token: token(5) })
  })
})
