import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import type { Command } from '../src/superTabs/commands.js'
import { localDatabase, type LocalDatabase } from './bench/mongo.js'

// A terminal observer socket against a real database and store. Redis is replaced by one process's channels, and
// the observer relay's global client by this suite's database; every permission read is real.
const shared = vi.hoisted(() => ({ db: null as unknown as PrismaClient, channels: null as unknown as EventEmitter }))
vi.mock('../src/lib/prisma.js', async original => ({ ...await original<typeof import('../src/lib/prisma.js')>(), get prisma() { return shared.db } }))
vi.mock('../src/lib/bus.js', async original => {
  const listen = (channel: string, callback: () => void) => {
    shared.channels.on(channel, callback)
    return Promise.resolve(() => { shared.channels.off(channel, callback) })
  }
  return { ...await original<typeof import('../src/lib/bus.js')>(),
    publishDown: async () => 1, subscribeUp: async () => () => {},
    subscribeShareChanged: (id: string, callback: () => void) => listen(`share:${id}`, callback),
    publishShareChanged: async (id: string) => { shared.channels.emit(`share:${id}`); return 1 },
    subscribeSwarmAccessChanged: (tabId: string, callback: () => void) => listen(`swarm:${tabId}`, callback),
    publishSwarmAccessChanged: async (tabId: string) => { shared.channels.emit(`swarm:${tabId}`); return 1 } }
})
vi.mock('../src/lib/hub.js', () => ({ trackSocketLiveness: () => () => {} }))
const { SuperTabStore } = await import('../src/superTabs/store.js')
const { attachObserver } = await import('../src/lib/observerWs.js')
const { publishSwarmAccessChanged } = await import('../src/lib/bus.js')
const { tellSessionViewers } = await import('../src/routes/harnessLinks.js')

let database: LocalDatabase
let store: InstanceType<typeof SuperTabStore>
const owner: AuthUser = { sub: '100000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '100000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '100000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const run = (tab: string, command: Command, user = owner) => store.execute(user, tab, { operationId: randomUUID(), command })

class Socket extends EventEmitter {
  readyState = 1; bufferedAmount = 0
  send = vi.fn()
  close = vi.fn((_code?: number, _reason?: string) => { this.readyState = 3; this.emit('close') })
  terminate = vi.fn(() => this.close())
}
const until = async (condition: () => boolean, ms: number) => {
  for (const end = Date.now() + ms; !condition(); await new Promise(resolve => setTimeout(resolve, 10))) {
    if (Date.now() > end) return false
  }
  return true
}

beforeAll(async () => {
  database = await localDatabase()
  shared.db = database.db
  // The routes' wiring (routes/superTabs.ts): a narrowing of who may watch, and a session turning confidential, are told after
  // their commit.
  store = new SuperTabStore(database.db, Date.now, null, { accessChanged: tabId => { void publishSwarmAccessChanged(tabId) },
    sessionsConfidential: sessions => { void tellSessionViewers(sessions) } })
  for (const user of [owner, peer, host]) await database.db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  await database.db.machine.create({ data: { machineId: 'test-host', userId: host.sub, apiKey: 'fixture-only', managerId: 'fixture',
    autonomousEnv: 'prod', authMode: 'remote' } })
  await database.db.machineShare.create({ data: { machineId: 'test-host', ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email, peer.email] } })
})
beforeEach(() => { shared.channels = new EventEmitter() })
afterAll(async () => { await database?.stop() })

describe('a terminal observer of a Swarm agent', () => {
  /** Peer watches a Builder on host's machine through the Swarm's share. */
  async function watching(withLead = true) {
    const tab = (await store.create(owner, randomUUID(), 'Observed')).id
    if (withLead) await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Lead', configuration: config, lead: true })
    for (const person of [peer, host]) {
      const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
      await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
    }
    const harnessId = randomUUID()
    const builder = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId, name: 'Builder', configuration: config, lead: false }))
      .result.agentId as string
    const share = await database.db.harnessShare.create({ data: { id: randomUUID(), superTabId: tab, ownerId: host.sub, machineId: 'test-host',
      agentId: harnessId, recipientEmail: peer.email, autonomousEnv: 'prod', name: 'Builder', ownerPublicKey: 'fixture-key',
      expiresAt: new Date(Date.now() + 86_400_000), revokedAt: null } })
    const ws = new Socket()
    await attachObserver(ws as never, peer, share)
    expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'observer_connected' }))
    return { tab, ws, builder, harnessId }
  }

  it('closes within a second of its viewer being removed from the Swarm', async () => {
    const { tab, ws } = await watching()
    await run(tab, { type: 'member.remove', userId: peer.sub })
    expect(await until(() => ws.close.mock.calls.length > 0, 1_000)).toBe(true)
    expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String))
  })

  it('closes within a second of the agent’s project no longer being shared with its viewer', async () => {
    const { tab, ws } = await watching()
    await run(tab, { type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [host.sub] })
    expect(await until(() => ws.close.mock.calls.length > 0, 1_000)).toBe(true)
    expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String))
  })

  it('closes a link\'s viewer within a second of the watched session turning confidential, here by becoming its project’s Lead', async () => {
    const { tab, builder, harnessId } = await watching(false)
    const link = await database.db.harnessLink.create({ data: { id: randomUUID(), ownerId: host.sub, machineId: 'test-host', agentId: harnessId,
      autonomousEnv: 'prod', name: 'Builder', engine: null, ownerPublicKey: 'fixture-key', visibility: 'public', revokedAt: null } })
    const viewers = [new Socket(), new Socket()]
    // A public link opens for anyone, signed in or not.
    await attachObserver(viewers[0] as never, peer, link, 'prod')
    await attachObserver(viewers[1] as never, null, link, 'prod')
    for (const ws of viewers) expect(ws.send).toHaveBeenCalledWith(JSON.stringify({ type: 'observer_connected' }))
    await run(tab, { type: 'conversation.agent', conversationId: 'lead', agentId: builder, present: true, lead: true })
    for (const ws of viewers) {
      expect(await until(() => ws.close.mock.calls.length > 0, 1_000)).toBe(true)
      expect(ws.close).toHaveBeenCalledWith(4403, expect.any(String))
    }
  })

  it('stays open through a change that leaves its viewer allowed, the watched agent becoming its project’s Lead included', async () => {
    const { tab, ws, builder } = await watching(false)
    await run(tab, { type: 'conversation.create', title: 'Another task', brief: '', checks: [] })
    await run(tab, { type: 'project.sharing', projectId: 'lead', visibility: 'private', memberIds: [host.sub, peer.sub] })
    // Every member watches the current Lead, view only (Ken, 2026-10-28).
    await run(tab, { type: 'conversation.agent', conversationId: 'lead', agentId: builder, present: true, lead: true })
    // Told to check again, it checks the Lead and stays.
    await publishSwarmAccessChanged(tab)
    expect(await until(() => ws.close.mock.calls.length > 0, 500)).toBe(false)
  })
})
