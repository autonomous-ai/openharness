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
import type { GitHubRepository } from '../src/github/repository.js'

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

/** The repositories the Harness GitHub App is installed on, as GitHubApp.resolve answers (lower case); [unknown] ones fail
 *  as GitHub not answering does. */
const INSTALLED = new Set(['acme/app', 'acme/web', 'acme/d', 'acme/e', 'acme/gone'])
const installation = (unknown: string[] = []) => async (repository: GitHubRepository) => {
  const name = repository.fullName.toLowerCase()
  if (unknown.includes(name)) throw Object.assign(new Error('GitHub did not answer'), { code: 'GITHUB_UNAVAILABLE' })
  return INSTALLED.has(name)
}

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
  // Named, but the app is not on it: no token today, so nothing working needs it approved (security reviews 1 and 2 of #2748).
  const foreign = await swarm('F', 'https://github.com/someone-else/private')
  const listed = [{ autonomousEnv: 'prod', tabId: a, projectId: 'lead', repository: 'acme/app' },
    { autonomousEnv: 'prod', tabId: b, projectId: bSecond, repository: 'acme/web' }]
  const notInstalled = [{ autonomousEnv: 'prod', tabId: foreign, projectId: 'lead', repository: 'someone-else/private' }]
  return { a, b, bSecond, deleted, approved, wide, foreign, listed, notInstalled }
}
const byKey = <T extends { tabId: string; projectId: string }>(rows: T[]) => [...rows].sort((x, y) => `${x.tabId}/${x.projectId}` < `${y.tabId}/${y.projectId}` ? -1 : 1)

describe('approving the repository pairs in use before every Swarm needed approval', () => {
  it('lists each live Swarm\'s GitHub projects without an approval, and writes nothing in a dry run', async () => {
    const f = await fixtures()
    const before = await db.gitHubRepositoryApproval.count()
    const report = await approveCurrentPairs(db, { apply: false, installed: installation() })
    expect(byKey(report.pairs)).toEqual(byKey(f.listed))
    expect(report).toMatchObject({ apply: false, alreadyApproved: 2, written: 0, notInstalled: f.notInstalled, unknown: [], skipped: [], failed: [] })
    expect(report.swarms).toBe(5)
    expect(await db.gitHubRepositoryApproval.count()).toBe(before)
  })

  it('with apply, approves exactly those pairs once, marked as granted by the migration, and a second run writes nothing', async () => {
    const f = await fixtures()
    const report = await approveCurrentPairs(db, { apply: true, installed: installation() })
    expect(report).toMatchObject({ apply: true, written: 2, failed: [] })
    const rows = await db.gitHubRepositoryApproval.findMany({ where: { approvedBy: GRANDFATHERED_BY } })
    expect(byKey(rows.map(r => ({ autonomousEnv: r.autonomousEnv, tabId: r.tabId, projectId: r.projectId, repository: r.repository, githubLogin: r.githubLogin }))))
      .toEqual(byKey(f.listed.map(p => ({ ...p, githubLogin: '' }))))
    // A person's own approval is left as it was.
    expect(await db.gitHubRepositoryApproval.findMany({ where: { tabId: f.approved }, select: { approvedBy: true, githubLogin: true } }))
      .toEqual([{ approvedBy: owner.sub, githubLogin: 'olive' }])
    const again = await approveCurrentPairs(db, { apply: true, installed: installation() })
    expect(again).toMatchObject({ pairs: [], written: 0, alreadyApproved: 4, notInstalled: f.notInstalled })
    // The repository the app is not on got no approval.
    expect(await db.gitHubRepositoryApproval.count({ where: { tabId: f.foreign } })).toBe(0)
  })

  it('a grandfathered approval gives tokens but never reads as the reader\'s own push access', async () => {
    const f = await fixtures()
    await approveCurrentPairs(db, { apply: true, installed: installation() })
    const approvals = new PrismaApprovals(db)
    expect(await approvals.approved('prod', f.a, 'lead', 'acme/app')).toBe(true)
    expect(await approvals.reader('prod', f.a, 'lead', 'acme/app', owner.sub)).toBeNull()
  })

  it('lists a Swarm still kept in one row as skipped, never passing over it silently', async () => {
    await swarm('A', 'https://github.com/acme/app')
    const legacy = randomUUID()
    await db.superTab.create({ data: { id: legacy, ownerId: owner.sub, autonomousEnv: 'prod', memberIds: [owner.sub], invitedEmails: [],
      autoJoinDeclined: [], machineIds: [], format: 1, state: { project: { machineId: 'owner-mac', cwd: '/work', repositoryUrl: 'https://github.com/acme/old' } } } })
    const report = await approveCurrentPairs(db, { apply: false, installed: installation() })
    expect(report.skipped).toEqual([legacy])
    expect(report.pairs.map(p => p.repository)).toEqual(['acme/app'])
  })

  it('lists a repository GitHub could not answer for as unknown, with its code alone, and approves nothing for it', async () => {
    const f = await fixtures()
    const report = await approveCurrentPairs(db, { apply: true, installed: installation(['acme/web']) })
    expect(report.unknown).toEqual([{ autonomousEnv: 'prod', tabId: f.b, projectId: f.bSecond, repository: 'acme/web', error: 'GITHUB_UNAVAILABLE' }])
    expect(report.pairs.map(p => p.repository)).toEqual(['acme/app'])
    expect(report.written).toBe(1)
    expect(await db.gitHubRepositoryApproval.count({ where: { tabId: f.b } })).toBe(0)
  })

  it('counts a pair a person approved between the read and the write as already approved, not written, and keeps their row', async () => {
    const a = await swarm('A', 'https://github.com/acme/app')
    const report = await approveCurrentPairs(db, { apply: true, installed: async repository => {
      // A person allows it while the run checks GitHub.
      await approve(a, 'lead', 'acme/app')
      return INSTALLED.has(repository.fullName.toLowerCase())
    } })
    expect(report).toMatchObject({ written: 0, alreadyApproved: 1, failed: [] })
    expect(await db.gitHubRepositoryApproval.findMany({ where: { tabId: a }, select: { approvedBy: true } })).toEqual([{ approvedBy: owner.sub }])
  })

  it('reads a head stored without its deleted field, and lists a live Swarm with no head as skipped', async () => {
    const a = await swarm('A', 'https://github.com/acme/app')
    await db.$runCommandRaw({ update: 'SwarmHead', updates: [{ q: { tabId: a, key: 'head' }, u: { $unset: { deleted: '' } } }] })
    const headless = await swarm('H', 'https://github.com/acme/web')
    await db.swarmHead.deleteMany({ where: { tabId: headless } })
    const report = await approveCurrentPairs(db, { apply: false, installed: installation() })
    expect(report.pairs.map(p => p.tabId)).toEqual([a])
    expect(report.skipped).toEqual([headless])
  })

  it('a project approval covers only that project, a Swarm-wide one every project of that Swarm, and neither another Swarm', async () => {
    const approvals = new PrismaApprovals(db)
    await approve('tab-1', 'p1', 'acme/app')
    await approve('tab-2', '*', 'acme/app')
    expect(await approvals.approved('prod', 'tab-1', 'p1', 'Acme/App')).toBe(true)
    expect(await approvals.approved('prod', 'tab-1', 'p2', 'acme/app')).toBe(false)
    expect(await approvals.approved('prod', 'tab-2', 'any', 'acme/app')).toBe(true)
    expect(await approvals.approved('prod', 'tab-3', 'p1', 'acme/app')).toBe(false)
    expect(await approvals.approved('dev', 'tab-1', 'p1', 'acme/app')).toBe(false)
  })

  // It asks GitHub through the app which repositories it is installed on, so it needs the app's own configuration; the
  // listing it prints is approveCurrentPairs' report, tested above against the same database.
  it('its script refuses anything but --apply, and a server without the GitHub App, writing nothing', async () => {
    await fixtures()
    const tsx = join(process.cwd(), 'node_modules/.bin/tsx'), script = 'scripts/swarm-github-approvals/approve-current.ts'
    const env = { ...process.env, DATABASE_URL: uri, GITHUB_APP_ID: '', GITHUB_APP_PRIVATE_KEY: '', GITHUB_APP_SLUG: '' }
    const failed = (args: string[]) => promisify(execFile)(tsx, [script, ...args], { env, timeout: 60000 })
      .then(() => null, (error: { code?: number; stderr?: string }) => error)
    const bogus = await failed(['--bogus'])
    expect(bogus?.code).toBe(2)
    expect(bogus?.stderr).toContain('Usage:')
    const noApp = await failed([])
    expect(noApp?.code).toBe(2)
    expect(noApp?.stderr).toContain('GITHUB_APP_ID')
    expect(await db.gitHubRepositoryApproval.count({ where: { approvedBy: GRANDFATHERED_BY } })).toBe(0)
  })
})
