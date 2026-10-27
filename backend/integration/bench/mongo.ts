import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'

export interface LocalDatabase {
  db: PrismaClient
  /** The MongoDB server version the run measured. */
  version: string
  stop(): Promise<void>
}

/** A fresh loopback replica set with the backend's schema, as integration/superTabs.test.ts makes one. The bench never
 *  reads DATABASE_URL or any existing database (spec: "Constraints all groups share", isolation). */
export async function localDatabase(): Promise<LocalDatabase> {
  const version = '7.0.24'
  const replica = await MongoMemoryReplSet.create({ binary: { version, downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_bench_${randomUUID().replaceAll('-', '_')}`)
  if (!new URL(uri).hostname.startsWith('127.0.0.1')) throw new Error(`Refusing a database that is not on this computer: ${uri}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  const db = new PrismaClient({ datasources: { db: { url: uri } } })
  return { db, version, async stop() { await db.$disconnect(); await replica.stop() } }
}
