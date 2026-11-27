import { readFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import { planDatabase } from './plans.test-support.js'
import { oldBackendHello } from './oldDeviceHello.test-support.js'
import { logger } from '../src/utils/logger.js'

// A fresh loopback replica set with the schema pushed; never DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
beforeAll(async () => { ({ replica, db } = await planDatabase('old_device_hello')) })
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

const NEW_CLI_HELLO = JSON.parse(readFileSync(new URL('../../tests/fixtures/cli-device-hello.json', import.meta.url), 'utf8'))
// A row as the released backend left it after an older CLI's hello.
const row = (deviceId: string) => db.deviceBinding.create({ data: { userId: 'owner', deviceId, computerId: deviceId, chip: 'harness-cli', firmwareVersion: '0.6.95' } })
const read = (deviceId: string) => db.deviceBinding.findUnique({ where: { deviceId } })

describe('the released backend and a new CLI', () => {
  it('the released backend meets a new CLI\'s hello: the row keeps its last version and nothing fails', async () => {
    await row('cmp-new-cli')
    const warn = vi.spyOn(logger, 'warn')
    await expect(oldBackendHello(db, 'cmp-new-cli', NEW_CLI_HELLO)).resolves.toBeUndefined()
    expect(await read('cmp-new-cli')).toMatchObject({ chip: 'harness-cli', firmwareVersion: '0.6.95' })
    expect(warn).not.toHaveBeenCalled()
  })

  it('the copy is the released code: an older CLI\'s hello still writes its firmwareVersion', async () => {
    await row('cmp-old-cli')
    await oldBackendHello(db, 'cmp-old-cli', { type: 'device_hello', payload: { chip: 'harness-cli', firmwareVersion: '0.6.96', caps: ['e2ee_data', 'multi_machine'] } })
    expect((await read('cmp-old-cli'))?.firmwareVersion).toBe('0.6.96')
  })
})
