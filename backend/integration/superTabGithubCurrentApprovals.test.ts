import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { PrismaApprovals } from '../src/github/approvals.js'
import { approveCurrentPairs, GRANDFATHERED_BY } from '../src/github/currentApprovals.js'

// Task #1694 (option B, 11-03): once every Swarm needs a repository approval before App tokens, the (Swarm, project,
// repository) pairs in use before are approved once, on the owner's go. This suite runs the listing and its script against a
// fresh loopback MongoDB only; it never reads DATABASE_URL from the environment or any existing database.
let replica: MongoMemoryReplSet
let db: PrismaClient
let uri: string
let store: SuperTabStore
const owner: AuthUser = { sub: '300000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  uri = replica.getUri(`super_tab_github_current_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: 'prod', name: 'Olive Owner' } })
  await db.machine.create({ data: { machineId: 'owner-mac', userId: owner.sub, apiKey: 'fixture-owner-mac', managerId: 'fixture', autonomousEnv: 'prod',
    authMode: 'remote', name: 'Owner Mac' } })
  store = new SuperTabStore(db, Date.now, null)
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})
beforeEach(async () => {
  await db.gitHubRepositoryApproval.deleteMany({})
  await db.superTab.deleteMany({})
  await db.swarmHead.deleteMany({})
})

const run = (tab: string, command: Command) => store.execute(owner, tab, { operationId: randomUUID(), command })
/** A Swarm whose first project's Lead works in a folder on [repositoryUrl]. */
async function swarm(name: string, repositoryUrl: string | null) {
  const tab = (await store.create(owner, randomUUID(), name)).id
  await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'owner-mac', harnessId: randomUUID(), name: 'Lead',
    configuration: config, lead: true, project: { cwd: `/work/${name}`, repositoryUrl } } as Command)
  return tab
}
/** A second project in [tab], its own Lead in a folder on [repositoryUrl]. */
async function project(tab: string, name: string, repositoryUrl: string | null) {
  const created = (await run(tab, { type: 'project.create', name, visibility: 'public', brief: '' } as Command)).result
  const projectId = String(created.projectId)
  const state = (await store.read(owner, tab)).state
  const leadConversationId = state.projects!.find(p => p.id === projectId)!.leadConversationId
  await run(tab, { type: 'agent.add', conversationId: leadConversationId, machineId: 'owner-mac', harnessId: randomUUID(), name: `${name} Lead`,
    configuration: config, lead: true, project: { cwd: `/work/${name}`, repositoryUrl } } as Command)
  return projectId
}
const approve = (tabId: string, projectId: string, repository: string, approvedBy = owner.sub) => db.gitHubRepositoryApproval.create({ data: {
  id: randomUUID(), autonomousEnv: 'prod', tabId, projectId, repository, approvedBy, githubLogin: 'olive' } })

/** Swarms covering each case the listing must tell apart; [listed] are the pairs it should find. */
async function fixtures() {
  const a = await swarm('A', 'https://github.com/Acme/App.git')
  const b = await swarm('B', 'https://gitlab.com/acme/b.git')
  const bSecond = await project(b, 'Web', 'https://github.com/acme/web')
  await project(b, 'Empty', null)
  const deleted = await swarm('C', 'https://github.com/acme/gone')
  await db.superTab.update({ where: { id: deleted }, data: { deletedAt: new Date() } })
  const approved = await swarm('D', 'https://github.com/acme/d')
  await approve(approved, 'lead', 'acme/d')
  const wide = await swarm('E', 'https://github.com/acme/e')
  await approve(wide, '*', 'acme/e')
  const listed = [{ autonomousEnv: 'prod', tabId: a, projectId: 'lead', repository: 'acme/app' },
    { autonomousEnv: 'prod', tabId: b, projectId: bSecond, repository: 'acme/web' }]
  return { a, b, bSecond, deleted, approved, wide, listed }
}
const byKey = <T extends { tabId: string; projectId: string }>(rows: T[]) => [...rows].sort((x, y) => `${x.tabId}/${x.projectId}` < `${y.tabId}/${y.projectId}` ? -1 : 1)

describe('approving the repository pairs in use before every Swarm needed approval', () => {
  it('lists each live Swarm\'s GitHub projects without an approval, and writes nothing in a dry run', async () => {
    const f = await fixtures()
    const before = await db.gitHubRepositoryApproval.count()
    const report = await approveCurrentPairs(db, { apply: false })
    expect(byKey(report.pairs)).toEqual(byKey(f.listed))
    expect(report).toMatchObject({ apply: false, alreadyApproved: 2, written: 0, skipped: [], failed: [] })
    expect(report.swarms).toBe(4)
    expect(await db.gitHubRepositoryApproval.count()).toBe(before)
  })

  it('with apply, approves exactly those pairs once, marked as granted by the migration, and a second run writes nothing', async () => {
    const f = await fixtures()
    const report = await approveCurrentPairs(db, { apply: true })
    expect(report).toMatchObject({ apply: true, written: 2, failed: [] })
    const rows = await db.gitHubRepositoryApproval.findMany({ where: { approvedBy: GRANDFATHERED_BY } })
    expect(byKey(rows.map(r => ({ autonomousEnv: r.autonomousEnv, tabId: r.tabId, projectId: r.projectId, repository: r.repository, githubLogin: r.githubLogin }))))
      .toEqual(byKey(f.listed.map(p => ({ ...p, githubLogin: '' }))))
    // A person's own approval is left as it was.
    expect(await db.gitHubRepositoryApproval.findMany({ where: { tabId: f.approved }, select: { approvedBy: true, githubLogin: true } }))
      .toEqual([{ approvedBy: owner.sub, githubLogin: 'olive' }])
    const again = await approveCurrentPairs(db, { apply: true })
    expect(again).toMatchObject({ pairs: [], written: 0, alreadyApproved: 4 })
  })

  it('a grandfathered approval gives tokens but never reads as the reader\'s own push access', async () => {
    const f = await fixtures()
    await approveCurrentPairs(db, { apply: true })
    const approvals = new PrismaApprovals(db)
    expect(await approvals.approved('prod', f.a, 'lead', 'acme/app')).toBe(true)
    expect(await approvals.reader('prod', f.a, 'lead', 'acme/app', owner.sub)).toBeNull()
  })

  it('lists a Swarm still kept in one row as skipped, never passing over it silently', async () => {
    await swarm('A', 'https://github.com/acme/app')
    const legacy = randomUUID()
    await db.superTab.create({ data: { id: legacy, ownerId: owner.sub, autonomousEnv: 'prod', memberIds: [owner.sub], invitedEmails: [],
      autoJoinDeclined: [], machineIds: [], format: 1, state: { project: { machineId: 'owner-mac', cwd: '/work', repositoryUrl: 'https://github.com/acme/old' } } } })
    const report = await approveCurrentPairs(db, { apply: false })
    expect(report.skipped).toEqual([legacy])
    expect(report.pairs.map(p => p.repository)).toEqual(['acme/app'])
  })

  it('its script prints the dry run and writes nothing, and refuses anything but --apply', async () => {
    const f = await fixtures()
    const tsx = join(process.cwd(), 'node_modules/.bin/tsx'), script = 'scripts/swarm-github-approvals/approve-current.ts'
    const env = { ...process.env, DATABASE_URL: uri }
    const { stdout } = await promisify(execFile)(tsx, [script], { env, timeout: 60000 })
    const lines = stdout.trim().split('\n')
    expect(lines.at(-1)).toBe('Dry run: 2 pairs would be approved. Nothing was written; add --apply to write them.')
    const printed = JSON.parse(lines.slice(0, -1).join('\n'))
    expect(byKey(printed.pairs)).toEqual(byKey(f.listed))
    expect(printed).toMatchObject({ apply: false, written: 0 })
    expect(await db.gitHubRepositoryApproval.count({ where: { approvedBy: GRANDFATHERED_BY } })).toBe(0)
    const refused = await promisify(execFile)(tsx, [script, '--bogus'], { env, timeout: 60000 }).then(() => null, (error: { code?: number; stderr?: string }) => error)
    expect(refused?.code).toBe(2)
    expect(refused?.stderr).toContain('Usage:')
  })
})
