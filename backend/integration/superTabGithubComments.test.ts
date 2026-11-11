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
import type { StoredCreate } from '../src/superTabs/steps.test-support.js'
import { storeCreate } from './storedWork.test-support.js'

// anh Dee, 2026-11-10: the backend records which agent posted each GitHub comment (superTabs/githubComments.ts), so the merger
// and GitHub news stop parsing signatures. Only the agent the caller's own machine runs records, on its project's repository;
// only a reader of that project reads. A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '350000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const peer: AuthUser = { sub: '350000000000000000000002', email: 'peer@example.com', autonomousEnv: 'prod', role: 'user' }
const stranger: AuthUser = { sub: '350000000000000000000003', email: 'stranger@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`super_tab_github_comments_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const user of [owner, peer, stranger]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'owner-mac', userId: owner.sub, computerId: 'cccccccccccccccccccccccccccccccc', sessionKind: 'computer',
    apiKey: 'fixture-owner-mac', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
}, 120_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** The owner's Swarm with the peer in it: project Web on github.com/Acme/App with its PM Juno and a builder Oak, and project
 *  Docs with no repository and its PM Ivy, all on the owner's computer. */
async function scene() {
  const tab = (await store.create(owner, randomUUID(), 'Comments')).id
  const run = (command: Command | StoredCreate, user: AuthUser = owner) => command.type === 'conversation.create' ? storeCreate(db, tab, command, user)
    : store.execute(user, tab, { operationId: randomUUID(), command })
  const invitation = await run({ type: 'invite.create', email: peer.email, role: 'collaborator', conversationId: 'lead' })
  await run({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, peer)
  const project = async (name: string, repositoryUrl: string | null, pm: string) => {
    const made = (await run({ type: 'project.create', name, visibility: 'public', brief: '' })).result as { projectId: string; conversationId: string }
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
  const record = (agentId: string, commentId: string, user: AuthUser = owner, repository = 'acme/app') =>
    store.recordGithubComment(user, tab, agentId, { repository, kind: 'issue', commentId })
  return { tab, web, docs, oak, record }
}

describe('which agent wrote a GitHub comment', () => {
  it('records the comment of the agent its caller\'s machine runs, once, and lets no other agent claim it', async () => {
    const s = await scene()
    expect(await s.record(s.web.agentId, '101')).toEqual({ recorded: true })
    expect(await s.record(s.web.agentId, '101', owner, 'Acme/App')).toEqual({ recorded: true })
    await expect(s.record(s.oak, '101')).rejects.toMatchObject({ code: 'COMMENT_NOT_YOURS', status: 409 })
    expect(await s.record(s.oak, '102')).toEqual({ recorded: true })
    const rows = await db.superTabGithubComment.findMany({ where: { tabId: s.tab }, orderBy: { id: 'asc' } })
    expect(rows.map(r => [r.id, r.projectId, r.agentId])).toEqual([[`${s.tab}|acme/app|issue|101`, s.web.projectId, s.web.agentId], [`${s.tab}|acme/app|issue|102`, s.web.projectId, s.oak]])
  })

  it('refuses another person speaking as an agent they do not host, and an agent on a repository of no project it reads', async () => {
    const s = await scene()
    await expect(s.record(s.web.agentId, '201', peer)).rejects.toMatchObject({ status: 403 })
    await expect(s.record(s.docs.agentId, '202')).rejects.toMatchObject({ code: 'REPOSITORY_NOT_PROJECT', status: 422 })
    await expect(s.record(s.web.agentId, '203', owner, 'acme/other')).rejects.toMatchObject({ code: 'REPOSITORY_NOT_PROJECT', status: 422 })
    expect(await db.superTabGithubComment.count({ where: { tabId: s.tab } })).toBe(0)
  })

  it('tells a reader of the project who wrote what was recorded, and a stranger only that there is no such project', async () => {
    const s = await scene()
    await s.record(s.web.agentId, '301')
    await s.record(s.oak, '302')
    const ids = ['issue:301', 'issue:302', 'issue:303', 'review:301']
    const authors = { 'issue:301': { agentId: s.web.agentId, name: 'Juno' }, 'issue:302': { agentId: s.oak, name: 'Oak' } }
    expect(await store.githubCommentAuthors(peer, s.tab, 'ACME/app', ids)).toEqual({ authors })
    expect(await store.githubCommentAuthors(owner, s.tab, 'acme/app', ids, s.oak)).toEqual({ authors })
    await expect(store.githubCommentAuthors(stranger, s.tab, 'acme/app', ids)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
    await expect(store.githubCommentAuthors(peer, s.tab, 'acme/unknown', ids)).rejects.toMatchObject({ code: 'NOT_FOUND', status: 404 })
  })
})
