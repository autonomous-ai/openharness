import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'

// A Personal Swarm adds its person's own machines by itself (#2181). A machine they took out must stay out on every computer, so the
// removal is the server's: a client's memory holds only on the computer that saw it (both security reviews of #2623).
let replica: MongoMemoryReplSet
let db: PrismaClient
const owner: AuthUser = { sub: '230000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '230000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const add = { name: 'Rig', cwd: '/repo', engines: ['codex'] as ['codex'], maxAgents: 4 }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_removals_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, peer]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'rig', userId: owner.sub, apiKey: 'fixture-rig', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await db.machine.create({ data: { machineId: 'peers', userId: peer.sub, apiKey: 'fixture-peers', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
}, 120_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

async function swarm() {
  const store = new SuperTabStore(db)
  const tab = (await store.create(owner, randomUUID(), 'Personal', 'public')).id
  const execute = (command: Command, user = owner) => store.execute(user, tab, { operationId: randomUUID(), command })
  /** The machine in the Swarm's list, as its person reads it. */
  const listed = async (user = owner, machineId = 'rig') => !!(await store.read(user, tab)).state.machines?.some(m => m.machineId === machineId)
  /** What the person reads of the machines they took out, on a store with nothing in memory: as another computer's first read. */
  const removed = async (user = owner) => ((await new SuperTabStore(db).read(user, tab)).state as { removedMachines?: string[] }).removedMachines
  /** The machine is taken out, and its host has finished cleaning up after it. */
  const removeAndClean = async (machineId = 'rig') => {
    const removalId = String((await execute({ type: 'machine.remove', machineId })).result.removalId)
    await execute({ type: 'machine.cleaned', machineId, removalId })
  }
  return { store, tab, execute, listed, removed, removeAndClean }
}

describe('a machine its person took out of a Swarm', () => {
  it('is recorded, and read by its person from any computer', async () => {
    const f = await swarm()
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add })
    await f.execute({ type: 'machine.remove', machineId: 'rig' })
    expect(await f.removed()).toEqual(['rig'])
  })

  it('stays out of an automatic add, on any computer, and that add writes nothing', async () => {
    const f = await swarm()
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add })
    await f.removeAndClean()
    expect(await f.listed()).toBe(false)
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add, ifMissing: true, unlessRemoved: true } as Command)
    expect(await f.listed()).toBe(false)
    expect(await f.removed()).toEqual(['rig'])
  })

  it('comes back when its person adds it by hand, and the record goes', async () => {
    const f = await swarm()
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add })
    await f.removeAndClean()
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add })
    expect(await f.listed()).toBe(true)
    expect(await f.removed()).toBeUndefined()
    // And the next removal is recorded again.
    await f.execute({ type: 'machine.remove', machineId: 'rig' })
    expect(await f.removed()).toEqual(['rig'])
  })

  it('an automatic add of a machine never removed still adds it, once', async () => {
    const f = await swarm()
    const unless = { ...add, ifMissing: true, unlessRemoved: true }
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...unless } as Command)
    expect(await f.listed()).toBe(true)
    const before = await db.swarmMachine.findFirstOrThrow({ where: { tabId: f.tab, key: 'rig' } })
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...unless, maxAgents: 1 } as Command)
    const after = await db.swarmMachine.findFirstOrThrow({ where: { tabId: f.tab, key: 'rig' } })
    expect(after.data).toEqual(before.data)
  })

  it('an automatic add without unlessRemoved, as a Lead\'s host sends, is unchanged', async () => {
    const f = await swarm()
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add })
    await f.removeAndClean()
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add, ifMissing: true } as Command)
    expect(await f.listed()).toBe(true)
  })

  it('names only the reader\'s own machines: no one reads another person\'s record', async () => {
    const f = await swarm()
    const invitation = await f.execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
    await f.execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add })
    await f.execute({ type: 'machine.remove', machineId: 'rig' })
    expect(await f.removed(peer)).toBeUndefined()
    expect(await f.removed(owner)).toEqual(['rig'])
  })

  it('never stops another person\'s automatic add of their own machine', async () => {
    const f = await swarm()
    const invitation = await f.execute({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
    await f.execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add })
    await f.execute({ type: 'machine.remove', machineId: 'rig' })
    await expect(f.execute({ type: 'machine.contribute', machineId: 'rig', ...add, ifMissing: true, unlessRemoved: true } as Command, peer))
      .rejects.toMatchObject({ code: expect.any(String) })
  })

  it('keeps at most 64 records: the oldest goes', async () => {
    const f = await swarm()
    const head = await db.swarmHead.findFirstOrThrow({ where: { id: `${f.tab}:head` } })
    await db.swarmHead.update({ where: { id: head.id }, data: { data: { ...head.data as object,
      removedMachines: Array.from({ length: 64 }, (_, i) => ({ machineId: `old-${i}`, contributorId: owner.sub })) } } })
    await f.execute({ type: 'machine.contribute', machineId: 'rig', ...add })
    await f.execute({ type: 'machine.remove', machineId: 'rig' })
    const removed = await f.removed()
    expect(removed).toHaveLength(64)
    expect(removed).toContain('rig')
    expect(removed).not.toContain('old-0')
  })
})
