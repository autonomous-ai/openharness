import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { listNamedIndexes } from '../src/superTabs/parts/indexed.js'
import { purgeSwarm } from '../src/superTabs/purge.js'
import type { TaskKind } from '../src/superTabs/taskTokens.js'
import type { StoredCreate } from '../src/superTabs/steps.test-support.js'
import { plan, planDatabase, profiled, reads } from './plans.test-support.js'
import { storeCreate } from './storedWork.test-support.js'

// Swarm allocator, package 12 (2026-11-11): each builder's own daemon counts what its agent's conversation used on a task,
// and the server keeps the totals (superTabs/taskTokens.ts) for the project's members, as it keeps verdict records. Only the
// agent the caller's own machine runs writes, on its project's repository; only a reader of that project reads; the read is
// by its index. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '360000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '360000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const stranger: AuthUser = { sub: '360000000000000000000003', email: 'stranger@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const NOW = Date.parse('2026-11-11T12:00:00Z')
const SONNET = { model: 'claude-sonnet-5-5', input: 1200, output: 3400, cacheRead: 560_000, cacheWrite: 78_000 }
// A model whose name has a dot, and a count past 32 bits: both come back as they went in.
const GPT = { model: 'gpt-5.5', input: 10, output: 20, cacheRead: 5_000_000_000, cacheWrite: 0 }

beforeAll(async () => {
  ({ replica, db } = await planDatabase('super_tab_task_tokens'))
  store = new SuperTabStore(db, () => NOW)
  for (const user of [owner, peer, stranger]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'owner-mac', userId: owner.sub, computerId: 'cccccccccccccccccccccccccccccccc', sessionKind: 'computer',
    apiKey: 'fixture-owner-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await listNamedIndexes(db)
}, 120_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** The owner's Swarm with the peer in it: project Web on github.com/Acme/App with its PM Juno and a builder Oak, and project
 *  Docs with no repository and its PM Ivy, all on the owner's computer. */
async function scene() {
  const tab = (await store.create(owner, randomUUID(), 'Tokens')).id
  const run = (command: Command | StoredCreate, user: AuthUser = owner) => command.type === 'conversation.create' ? storeCreate(db, tab, command, user)
    : store.execute(user, tab, { operationId: randomUUID(), command })
  const invitation = await run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await run({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const project = async (name: string, repositoryUrl: string | null, pm: string, visibility: 'public' | 'private' = 'public') => {
    const made = (await run({ type: 'project.create', name, visibility, brief: '' })).result as { projectId: string; conversationId: string }
    const agentId = String((await run({ type: 'agent.add', conversationId: made.conversationId, machineId: 'owner-mac', harnessId: randomUUID(), name: pm,
      configuration: config, lead: true, project: { cwd: `/work/${name}`, repositoryUrl } } as Command)).result.agentId)
    return { ...made, agentId }
  }
  const web = await project('Web', 'https://github.com/Acme/App.git', 'Juno')
  const docs = await project('Docs', null, 'Ivy')
  const task = String((await run({ type: 'conversation.create', projectId: web.projectId, title: 'Work', brief: 'Do it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const oak = String((await run({ type: 'agent.add', conversationId: task, machineId: 'owner-mac', harnessId: randomUUID(), name: 'Oak',
    configuration: config, lead: false } as Command)).result.agentId)
  const row = (number: number, kind: TaskKind = 'build', over: Record<string, unknown> = {}) =>
    ({ repository: 'acme/app', number, kind, tokens: [SONNET], rounds: 0, startedAt: NOW - 42 * 60_000, endedAt: NOW - 60_000, ...over })
  const record = (agentId: string, number: number, kind: TaskKind = 'build', over: Record<string, unknown> = {}, user: AuthUser = owner) =>
    store.recordTaskTokens(user, tab, agentId, row(number, kind, over) as Parameters<SuperTabStore['recordTaskTokens']>[3])
  return { tab, web, docs, oak, record, project }
}

describe('what an agent\'s conversation used on a task', () => {
  it('keeps the totals the agent its caller\'s machine runs wrote, replaces them with its later ones, and gives them back as they went in', async () => {
    const s = await scene()
    expect(await s.record(s.oak, 14)).toEqual({ recorded: true })
    expect(await s.record(s.oak, 14, 'build', { repository: 'Acme/App', tokens: [SONNET, GPT], endedAt: NOW })).toEqual({ recorded: true })
    expect(await s.record(s.oak, 20, 'fix', { rounds: 2 })).toEqual({ recorded: true })
    expect(await s.record(s.web.agentId, 20, 'read', { rounds: 1 })).toEqual({ recorded: true })
    const stored = await db.superTabTaskTokens.findMany({ where: { tabId: s.tab }, orderBy: [{ number: 'asc' }, { kind: 'asc' }] })
    expect(stored.map(r => [r.id, r.projectId, r.repository, r.number, r.kind, r.rounds])).toEqual([
      [`${s.tab}|acme/app|14|${s.oak}|build`, s.web.projectId, 'acme/app', 14, 'build', 0],
      [`${s.tab}|acme/app|20|${s.oak}|fix`, s.web.projectId, 'acme/app', 20, 'fix', 2],
      [`${s.tab}|acme/app|20|${s.web.agentId}|read`, s.web.projectId, 'acme/app', 20, 'read', 1],
    ])
    const { rows } = await store.taskTokens(peer, s.tab, 'ACME/app', [14, 20, 99])
    expect([...rows].sort((a, b) => a.number - b.number || a.kind.localeCompare(b.kind))).toEqual([
      { number: 14, kind: 'build', agentId: s.oak, name: 'Oak', tokens: [SONNET, GPT], rounds: 0, startedAt: NOW - 42 * 60_000, endedAt: NOW },
      { number: 20, kind: 'fix', agentId: s.oak, name: 'Oak', tokens: [SONNET], rounds: 2, startedAt: NOW - 42 * 60_000, endedAt: NOW - 60_000 },
      { number: 20, kind: 'read', agentId: s.web.agentId, name: 'Juno', tokens: [SONNET], rounds: 1, startedAt: NOW - 42 * 60_000, endedAt: NOW - 60_000 },
    ])
    // As an agent of the project too: the PM's person's daemon reads as its PM.
    expect((await store.taskTokens(owner, s.tab, 'acme/app', [14], s.web.agentId)).rows).toHaveLength(1)
  })

  it('refuses another person speaking as an agent they do not host, and an agent on a repository of no project it reads', async () => {
    const s = await scene()
    await expect(s.record(s.web.agentId, 14, 'build', {}, peer)).rejects.toMatchObject({ status: 403 })
    await expect(s.record(s.docs.agentId, 14)).rejects.toMatchObject({ code: 'REPOSITORY_NOT_PROJECT', status: 422 })
    await expect(s.record(s.web.agentId, 14, 'build', { repository: 'acme/other' })).rejects.toMatchObject({ code: 'REPOSITORY_NOT_PROJECT', status: 422 })
    expect(await db.superTabTaskTokens.count({ where: { tabId: s.tab } })).toBe(0)
  })

  it('tells a stranger, and a reader of no project of the repository, only that there is no such project', async () => {
    const s = await scene()
    await s.record(s.oak, 14)
    await expect(store.taskTokens(stranger, s.tab, 'acme/app', [14])).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    await expect(store.taskTokens(peer, s.tab, 'acme/unknown', [14])).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })

  it('keeps a private project\'s rows from a member who is not in it, on a repository two projects share', async () => {
    const s = await scene()
    const secret = await s.project('Secret', 'https://github.com/acme/app', 'Rex', 'private')
    await s.record(s.oak, 14)
    await s.record(secret.agentId, 14, 'read', { rounds: 1 })
    expect((await db.superTabTaskTokens.findMany({ where: { tabId: s.tab }, orderBy: { kind: 'asc' } })).map(r => r.projectId)).toEqual([s.web.projectId, secret.projectId])
    // The owner is in both projects, the peer in the public one alone; the private project's own PM reads its own.
    expect((await store.taskTokens(owner, s.tab, 'acme/app', [14])).rows.map(r => r.name).sort()).toEqual(['Oak', 'Rex'])
    expect((await store.taskTokens(peer, s.tab, 'acme/app', [14])).rows.map(r => r.name)).toEqual(['Oak'])
    expect((await store.taskTokens(owner, s.tab, 'acme/app', [14], secret.agentId)).rows.map(r => r.name)).toEqual(['Rex'])
  })

  it('reads only the rows asked for, by the index of the Swarm, the repository and the number', async () => {
    const s = await scene(), other = await scene()
    for (let number = 1; number <= 40; number++) await s.record(s.oak, number)
    await other.record(other.oak, 14)
    const entries = await profiled(db, () => store.taskTokens(peer, s.tab, 'acme/app', [14, 20]))
    const read = reads(entries, 'SuperTabTaskTokens', ['tabId', 'repository', 'number'])
    expect(read, JSON.stringify(plan(read))).toHaveLength(1)
    expect(read[0]!.planSummary, JSON.stringify(plan(read))).toMatch(/IXSCAN \{ tabId: 1, repository: 1, number: 1 \}/)
    expect(read[0]!.nreturned).toBe(2)
    expect(read[0]!.docsExamined, JSON.stringify(plan(read))).toBe(2)
  })

  it('goes with its Swarm when the Swarm is purged', async () => {
    const s = await scene(), kept = await scene()
    await s.record(s.oak, 14)
    await kept.record(kept.oak, 14)
    await db.superTab.update({ where: { id: s.tab }, data: { deletedAt: new Date(NOW - 40 * 86_400_000), purgeAt: new Date(NOW - 2 * 86_400_000) } })
    expect(await purgeSwarm(db, s.tab, null, NOW)).toBe('purged')
    expect(await db.superTabTaskTokens.count({ where: { tabId: s.tab } })).toBe(0)
    expect(await db.superTabTaskTokens.count({ where: { tabId: kept.tab } })).toBe(1)
  })
})
