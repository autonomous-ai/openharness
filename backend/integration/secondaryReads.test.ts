import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import { secondaryReadsUrl } from '../src/lib/databaseUrl.js'

// Task #2970: the reads that tolerate a few seconds of lag (analytics, lib/analyticsQuery.ts) go to the secondary client,
// everything that must see the latest write stays on the primary. Fresh loopback replica sets; never DATABASE_URL.
const clients: PrismaClient[] = []
const client = (url: string) => { const made = new PrismaClient({ datasources: { db: { url } } }); clients.push(made); return made }
afterAll(async () => { await Promise.allSettled(clients.map(c => c.$disconnect())) })

describe('on a replica set with secondaries', () => {
  it('the secondary client\'s reads are served by a secondary, the main client\'s by the primary', async () => {
    const three = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
      replSet: { count: 3, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
    try {
      await three.waitUntilRunning()
      const url = three.getUri(`three_${randomUUID().replaceAll('-', '_')}`)
      const main = client(url), secondary = client(secondaryReadsUrl(url))
      await main.user.create({ data: { externalId: `fixture-${randomUUID()}`, email: `${randomUUID()}@example.com`, autonomousEnv: 'prod' } })
      const { primary } = await main.$runCommandRaw({ hello: 1 }) as unknown as { primary: string }
      // $collStats names the member that answered.
      const host = async (db: PrismaClient) => (await db.user.aggregateRaw({ pipeline: [{ $collStats: { count: {} } }] }) as unknown as Array<{ host: string }>)[0]!.host
      const port = (address: string) => address.split(':').at(-1)
      expect(port(await host(main))).toBe(port(primary))
      // A secondary answers once the collection has replicated to it.
      await expect.poll(async () => port(await host(secondary)), { timeout: 20_000 }).not.toBe(port(primary))
    } finally {
      await three.stop()
    }
  }, 120_000)
})
