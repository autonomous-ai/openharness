import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { planDatabase, profiled, reads, plan } from './plans.test-support.js'
import { PUSH_DEVICES_PER_PERSON, devicesOf, dropPushDevice, forgetPushDevice, markSandbox, registerPushDevice } from '../src/push/devices.js'

// A fresh loopback replica set with the schema pushed; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
beforeAll(async () => { ({ replica, db } = await planDatabase('push_devices_test')) })
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const NOW = Date.UTC(2026, 10, 5, 9)
let next = 0
const person = () => `person-${++next}`
const token = (n: number) => `${'ab'.repeat(32)}${n}`

describe('Push devices: a phone token belongs to whoever registered it last (task #2905)', () => {
  it('keeps a registered token for its person', async () => {
    const a = person()
    await registerPushDevice(db, a, { platform: 'ios', token: token(1) }, NOW)
    expect(await devicesOf(db, [a])).toEqual([expect.objectContaining({ userId: a, platform: 'ios', token: token(1), sandbox: false })])
  })

  it('moves a token to the next person who signs in on that phone, so the first stops hearing the second\'s notices', async () => {
    const a = person(), b = person()
    await registerPushDevice(db, a, { platform: 'android', token: token(2) }, NOW)
    await registerPushDevice(db, b, { platform: 'android', token: token(2) }, NOW + 1000)
    expect(await devicesOf(db, [a])).toEqual([])
    expect((await devicesOf(db, [b])).map(d => d.token)).toEqual([token(2)])
  })

  it('registering the same token again keeps one row', async () => {
    const a = person()
    await registerPushDevice(db, a, { platform: 'ios', token: token(3) }, NOW)
    await registerPushDevice(db, a, { platform: 'ios', token: token(3) }, NOW + 1000)
    expect(await devicesOf(db, [a])).toHaveLength(1)
  })

  it(`keeps the ${PUSH_DEVICES_PER_PERSON} phones registered last`, async () => {
    const a = person()
    for (let i = 0; i <= PUSH_DEVICES_PER_PERSON; i++) await registerPushDevice(db, a, { platform: 'ios', token: token(100 + i) }, NOW + i * 1000)
    const kept = (await devicesOf(db, [a])).map(d => d.token).sort()
    expect(kept).toHaveLength(PUSH_DEVICES_PER_PERSON)
    expect(kept).not.toContain(token(100))
  })

  it('drops a token only for the person it belongs to', async () => {
    const a = person(), b = person()
    await registerPushDevice(db, a, { platform: 'ios', token: token(4) }, NOW)
    expect(await dropPushDevice(db, b, { platform: 'ios', token: token(4) })).toBe(false)
    expect(await devicesOf(db, [a])).toHaveLength(1)
    expect(await dropPushDevice(db, a, { platform: 'ios', token: token(4) })).toBe(true)
    expect(await devicesOf(db, [a])).toEqual([])
  })

  it('forgets a dead token and remembers a sandbox one', async () => {
    const a = person()
    await registerPushDevice(db, a, { platform: 'ios', token: token(5) }, NOW)
    await registerPushDevice(db, a, { platform: 'ios', token: token(6) }, NOW)
    const [first, second] = (await devicesOf(db, [a])).sort((x, y) => x.token.localeCompare(y.token))
    await forgetPushDevice(db, first!.id)
    await markSandbox(db, second!.id)
    expect(await devicesOf(db, [a])).toEqual([expect.objectContaining({ token: token(6), sandbox: true })])
  })

  it('reads nothing for nobody', async () => {
    expect(await devicesOf(db, [])).toEqual([])
  })

  it('reads the told people\'s devices through the userId index', async () => {
    const people = Array.from({ length: 5 }, person)
    for (const [i, p] of people.entries()) await registerPushDevice(db, p, { platform: 'ios', token: token(200 + i) }, NOW)
    const rows = reads(await profiled(db, () => devicesOf(db, people.slice(0, 2))), 'push_devices', ['userId'])
    expect(rows).toHaveLength(1)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ userId: 1/)
    expect(rows[0]!.docsExamined).toBe(2)
  })
})
