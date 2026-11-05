import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import type { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { cleanUpComputers, otherAccountsOnComputer, teamCleanupPending } from '../src/superTabs/computerMoves.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import { localReportMemory } from '../src/superTabs/machineReports.js'
import type { Command } from '../src/superTabs/commands.js'
import { planDatabase, plan, profiled, reads } from './plans.test-support.js'

// One computer, signed in as kelvin, then as ttkhoahcmus (Scholes, #3122): each account has its own machine row for it, joined
// only by the computer's id. A fresh loopback replica set, created here.
const COMPUTER = 'c'.repeat(32), OTHER = 'd'.repeat(32)
const kelvin = '500000000000000000000001', tt = '500000000000000000000002', other = '500000000000000000000003'
const user = (sub: string, email: string): AuthUser => ({ sub, email, autonomousEnv: 'prod', role: 'user' })
const owner = user('500000000000000000000009', 'owner@example.com'), kelvinUser = user(kelvin, 'kelvin@example.com'), ttUser = user(tt, 'ttkhoahcmus@example.com')
let replica: MongoMemoryReplSet
let db: PrismaClient
let uri: string
let store: SuperTabStore
/** Each machine's key in its account's device key log (lib/deviceKeyLog.ts): one key per computer, whatever account it signs
 *  in to, so a computer's machines of two accounts hold the same one (e2ee/store.ts identity.json). */
const keys: Array<{ userId: string; machineId: string; pub: string }> = [
  { userId: kelvin, machineId: 'kelvin-mac', pub: 'pub-computer' }, { userId: tt, machineId: 'tt-mac', pub: 'pub-computer' },
  { userId: kelvin, machineId: 'kelvin-old', pub: 'pub-duplicated' }, { userId: tt, machineId: 'tt-new', pub: 'pub-duplicated' },
]

beforeAll(async () => {
  ({ replica, db, uri } = await planDatabase('computer_moves'))
  const machine = (machineId: string, userId: string, computerId: string, extra: Record<string, unknown> = {}) => db.machine.create({ data: {
    machineId, userId, computerId, sessionKind: 'computer', apiKey: `fixture-${machineId}`, managerId: '', autonomousEnv: 'prod', authMode: 'remote', ...extra } })
  await machine('kelvin-mac', kelvin, COMPUTER)
  await machine('tt-mac', tt, COMPUTER)
  // Not another account's sign-in on this computer: a Team row, a deleted row, another environment's, another computer's.
  await machine('kelvin-team', kelvin, COMPUTER, { sessionKind: 'team', hostMachineId: 'kelvin-mac' })
  await machine('other-deleted', other, COMPUTER, { deletedAt: new Date() })
  await machine('other-stag', other, COMPUTER, { autonomousEnv: 'stag' })
  await machine('other-elsewhere', other, OTHER)
  // Many other computers' rows, which a read not bounded by the computer would examine too.
  for (let i = 0; i < 40; i++) await machine(`filler-${i}`, other, i.toString(16).padStart(32, '0'))
  for (const person of [owner, kelvinUser, ttUser]) {
    await db.user.create({ data: { id: person.sub, externalId: `fixture-${person.sub}`, email: person.email, autonomousEnv: 'prod' } })
  }
  const memory = localReportMemory(Date.now)
  store = new SuperTabStore(db, Date.now, null, { reports: { get: (t, m) => memory.get(t, m), set: (t, m, r) => memory.set(t, m, r), sweepDue: async () => false },
    machineKeys: async userIds => new Map(userIds.map(id => [id, keys.filter(k => k.userId === id).map(k => ({ ...k, kind: 'machine' as const }))])) })
}, 300_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe("a computer's other accounts", () => {
  it('are the live rows of other accounts signed in on it before, never the owner\'s own, a Team row, or another computer\'s', async () => {
    expect(await otherAccountsOnComputer(db, { computerId: COMPUTER, ownerId: tt, autonomousEnv: 'prod' }))
      .toEqual([{ machineId: 'kelvin-mac', userId: kelvin }])
    expect(await otherAccountsOnComputer(db, { computerId: COMPUTER, ownerId: kelvin, autonomousEnv: 'prod' }))
      .toEqual([{ machineId: 'tt-mac', userId: tt }])
  })

  it('are read from the index on the computer id', async () => {
    const entries = await profiled(db, () => otherAccountsOnComputer(db, { computerId: COMPUTER, ownerId: tt, autonomousEnv: 'prod' }))
    const rows = reads(entries, 'machines', ['computerId'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ computerId: 1, userId: 1 \}/)
    // Only this computer's six rows, not the 41 others.
    expect(rows[0]!.docsExamined, JSON.stringify(plan(rows))).toBeLessThanOrEqual(6)
  })
})

describe('a computer signed in as another account', () => {
  const run = (tab: string, command: Command, as: AuthUser = owner) => store.execute(as, tab, { operationId: randomUUID(), command })
  /** A Swarm with kelvin and ttkhoahcmus in it, and kelvin's Mac added, which reports nothing since he signed out of it. */
  async function swarm() {
    const tab = (await store.create(owner, randomUUID(), 'Machines')).id
    for (const person of [kelvinUser, ttUser]) {
      const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
      await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
    }
    await run(tab, { type: 'machine.contribute', machineId: 'kelvin-mac', name: 'MacBooks-MacBook-Pro-7', cwd: '/work', scope: 'swarm', engines: ['claude'],
      maxAgents: 2, teamAccountOnly: true }, kelvinUser)
    return tab
  }
  const machinesIn = async (tab: string) => (await store.read(owner, tab)).state.machines!.map(m => ({ machineId: m.machineId, contributorId: m.contributorId,
    previousOwner: m.previousOwner?.personId }))

  it("moves its entry in every Swarm to the new account, once", async () => {
    const tabs = [await swarm(), await swarm()]
    expect(await store.computerSignedIn({ machineId: 'tt-mac', ownerId: tt, computerId: COMPUTER, autonomousEnv: 'prod' })).toEqual(
      expect.arrayContaining(tabs.map(tabId => ({ tabId, from: 'kelvin-mac', fromOwner: kelvin, to: 'tt-mac', toOwner: tt }))))
    for (const tab of tabs) expect(await machinesIn(tab)).toEqual([{ machineId: 'tt-mac', contributorId: tt, previousOwner: kelvin }])
    expect(await store.computerSignedIn({ machineId: 'tt-mac', ownerId: tt, computerId: COMPUTER, autonomousEnv: 'prod' })).toEqual([])
    for (const tab of tabs) expect(await machinesIn(tab)).toEqual([{ machineId: 'tt-mac', contributorId: tt, previousOwner: kelvin }])
  })

  it('moves nothing for a computer id the signed-in machine does not have', async () => {
    const tab = await swarm()
    expect(await store.computerSignedIn({ machineId: 'tt-mac', ownerId: tt, computerId: OTHER, autonomousEnv: 'prod' })).toEqual([])
    expect(await store.computerSignedIn({ machineId: 'other-elsewhere', ownerId: other, computerId: COMPUTER, autonomousEnv: 'prod' })).toEqual([])
    expect(await machinesIn(tab)).toEqual([{ machineId: 'kelvin-mac', contributorId: kelvin, previousOwner: undefined }])
  })

  // Security review 1 of #3100: the computer id is self-declared. Someone who learned it, signed in to their own account
  // anywhere, must not take that computer's entry while it sleeps: only the computer's own key, which its sign-in to the new
  // account registered in that account's log, proves it is the same computer.
  it("moves nothing for an account that claims a computer's id without that computer's key", async () => {
    const VICTIM = 'b'.repeat(32)
    await db.machine.create({ data: { machineId: 'kelvin-victim', userId: kelvin, computerId: VICTIM, sessionKind: 'computer', apiKey: 'fixture-kelvin-victim',
      managerId: '', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machine.create({ data: { machineId: 'forged-mac', userId: tt, computerId: VICTIM, sessionKind: 'computer', apiKey: 'fixture-forged-mac',
      managerId: '', autonomousEnv: 'prod', authMode: 'remote' } })
    keys.push({ userId: kelvin, machineId: 'kelvin-victim', pub: 'pub-victim' }, { userId: tt, machineId: 'forged-mac', pub: 'pub-forger' })
    const tab = (await store.create(owner, randomUUID(), 'Forged')).id
    for (const person of [kelvinUser, ttUser]) {
      const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
      await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
    }
    await run(tab, { type: 'machine.contribute', machineId: 'kelvin-victim', name: 'Victim Mac', cwd: '/work', scope: 'swarm', engines: ['claude'],
      maxAgents: 2, teamAccountOnly: true }, kelvinUser)
    expect(await store.computerSignedIn({ machineId: 'forged-mac', ownerId: tt, computerId: VICTIM, autonomousEnv: 'prod' })).toEqual([])
    // Nor with no key at all: a machine that never registered one proves nothing.
    keys.splice(keys.findIndex(k => k.machineId === 'forged-mac'), 1)
    expect(await store.computerSignedIn({ machineId: 'forged-mac', ownerId: tt, computerId: VICTIM, autonomousEnv: 'prod' })).toEqual([])
    expect(await machinesIn(tab)).toEqual([{ machineId: 'kelvin-victim', contributorId: kelvin, previousOwner: undefined }])
  })

  it('cannot be asked for by a person', async () => {
    const tab = await swarm()
    await expect(run(tab, { type: 'machine.moved', machineId: 'kelvin-mac' }, kelvinUser)).rejects.toThrow()
    await expect(run(tab, { type: 'machine.moved', machineId: 'kelvin-mac' }, ttUser)).rejects.toThrow()
    expect(await machinesIn(tab)).toEqual([{ machineId: 'kelvin-mac', contributorId: kelvin, previousOwner: undefined }])
  })
})

describe('the one-time cleanup of computers listed under two accounts', () => {
  const run = (tab: string, command: Command, as: AuthUser = owner) => store.execute(as, tab, { operationId: randomUUID(), command })
  const DUPLICATED = 'e'.repeat(32)
  const machinesIn = async (tab: string) => (await store.read(owner, tab)).state.machines!.map(m => `${m.machineId}:${m.contributorId}`).sort()

  it('leaves each computer listed once, under the account seen last, writes nothing on a dry run, and moves nothing the second time', async () => {
    // The reported Mac: added by kelvin, then by ttkhoahcmus once they signed in on it, so both are listed (Scholes, 11-05).
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    for (const [machineId, userId, seen] of [['kelvin-old', kelvin, at(50)], ['tt-new', tt, at(1)]] as const) {
      await db.machine.create({ data: { machineId, userId, computerId: DUPLICATED, sessionKind: 'computer', apiKey: `fixture-${machineId}`, managerId: '',
        autonomousEnv: 'prod', authMode: 'remote', lastSeenAt: seen } })
    }
    const tab = (await store.create(owner, randomUUID(), 'Duplicates')).id
    for (const person of [kelvinUser, ttUser]) {
      const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
      await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
    }
    const add = (machineId: string, as: AuthUser) => run(tab, { type: 'machine.contribute', machineId, name: 'MacBooks-MacBook-Pro-7', cwd: '/work',
      scope: 'swarm', engines: ['claude'], maxAgents: 2, teamAccountOnly: true }, as)
    await add('kelvin-old', kelvinUser)
    await add('tt-new', ttUser)

    // Security review 2 of #3100: what Ken's go covers is exactly what the write changes. A computer shared by two accounts whose
    // machine key does not match is found, and moved neither in the dry run nor in the write.
    await db.machine.update({ where: { machineId: 'forged-mac' }, data: { lastSeenAt: new Date() } })
    const moved = { tabId: tab, from: 'kelvin-old', fromOwner: kelvin, to: 'tt-new', toOwner: tt }
    const dry = await cleanUpComputers(db, store, 'prod', { write: false })
    expect(dry.computers).toContainEqual({ signedIn: { machineId: 'tt-new', ownerId: tt }, others: ['kelvin-old'] })
    expect(dry.computers.some(c => c.signedIn.machineId === 'forged-mac')).toBe(true)
    expect(dry.moves).toEqual([moved])
    expect(await machinesIn(tab)).toEqual([`kelvin-old:${kelvin}`, `tt-new:${tt}`])

    expect((await cleanUpComputers(db, store, 'prod', { write: true })).moves).toEqual([moved])
    expect(await machinesIn(tab)).toEqual([`tt-new:${tt}`])
    const again = await cleanUpComputers(db, store, 'prod', { write: true })
    expect(again.moves).toEqual([])
    expect(await machinesIn(tab)).toEqual([`tt-new:${tt}`])
  })
})

// Task #3227 (Ken, 11-05): on prod the write moved nothing where the dry run, run just after, listed a move. The dry run read
// the entry alone; the write runs machine.moved as its owner, through every check a command meets (the Swarm loaded for them,
// their access to it, the move read from both account rows). One computer, one Swarm, the same data through both.
describe('the cleanup\'s dry run and its write', () => {
  const run = (tab: string, command: Command, as: AuthUser = owner) => store.execute(as, tab, { operationId: randomUUID(), command })
  const machinesIn = async (tab: string) => (await store.read(owner, tab)).state.machines!.map(m => `${m.machineId}:${m.contributorId}`).sort()
  let computer = 0
  /** A computer listed in one new Swarm under kelvin (seen first) and ttkhoahcmus (seen last), its key in both logs. */
  async function listedTwice() {
    const id = (0xf0 + computer++).toString(16).repeat(16), from = `kelvin-${id.slice(0, 4)}`, to = `tt-${id.slice(0, 4)}`
    const at = (minutes: number) => new Date(Date.now() - minutes * 60_000)
    for (const [machineId, userId, seen] of [[from, kelvin, at(50)], [to, tt, at(1)]] as const) {
      await db.machine.create({ data: { machineId, userId, computerId: id, sessionKind: 'computer', apiKey: `fixture-${machineId}`, managerId: '',
        autonomousEnv: 'prod', authMode: 'remote', lastSeenAt: seen } })
    }
    keys.push({ userId: kelvin, machineId: from, pub: `pub-${id}` }, { userId: tt, machineId: to, pub: `pub-${id}` })
    const tab = (await store.create(owner, randomUUID(), 'Twice')).id
    for (const person of [kelvinUser, ttUser]) {
      const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
      await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
    }
    for (const [machineId, as] of [[from, kelvinUser], [to, ttUser]] as const) {
      await run(tab, { type: 'machine.contribute', machineId, name: 'MacBooks-MacBook-Pro-7', cwd: '/work', scope: 'swarm', engines: ['claude'], maxAgents: 2,
        teamAccountOnly: true }, as)
    }
    return { tab, from, to }
  }
  const mine = (moves: Array<{ tabId: string }>, tab: string) => moves.filter(m => m.tabId === tab)

  it('decide the same moves on the same data, and say why one is left', async () => {
    const { tab, from, to } = await listedTwice()
    // The entry's owner was taken out of the Swarm's Workspace and is still listed in the Swarm (a Workspace removal whose leave
    // did not reach this Swarm): no command of theirs reaches it, machine.moved included.
    const { workspaceId } = (await store.read(owner, tab)).state
    const membership = { workspaceId: workspaceId!, userId: kelvin }
    await db.swarmWorkspaceMember.updateMany({ where: membership, data: { removedAt: new Date() } })
    try {
      const dry = await cleanUpComputers(db, store, 'prod', { write: false })
      const written = await cleanUpComputers(db, store, 'prod', { write: true })
      expect(mine(written.moves, tab)).toEqual([])
      expect(mine(dry.moves, tab)).toEqual(mine(written.moves, tab))
      // Both name the entry left and the Swarm's own refusal, so a dry run says what the write will not do.
      const left = { tabId: tab, from, fromOwner: kelvin, to, toOwner: tt, code: 'WORKSPACE_ACCESS_REVOKED' }
      expect(mine(dry.left, tab)).toEqual([left])
      expect(mine(written.left, tab)).toEqual([left])
    } finally { await db.swarmWorkspaceMember.updateMany({ where: membership, data: { removedAt: null } }) }
    expect(await machinesIn(tab)).toEqual([`${from}:${kelvin}`, `${to}:${tt}`])

    // The Swarm reachable again: both decide the move, and the write makes it.
    const dry = await cleanUpComputers(db, store, 'prod', { write: false })
    const moved = { tabId: tab, from, fromOwner: kelvin, to, toOwner: tt }
    expect(mine(dry.moves, tab)).toEqual([moved])
    expect(mine((await cleanUpComputers(db, store, 'prod', { write: true })).moves, tab)).toEqual([moved])
    expect(await machinesIn(tab)).toEqual([`${to}:${tt}`])
  })
})

// Task #3227: on prod the script printed its JSON and never exited, and its env check refused to start without billing's
// credential key. Run as Ken runs it, with only the database's URL, and Redis nowhere to be reached.
describe('the cleanup script', () => {
  const script = (env: NodeJS.ProcessEnv) => new Promise<{ code: number; stdout: string; stderr: string }>(resolve => {
    execFile(join(process.cwd(), 'node_modules/.bin/tsx'), ['scripts/swarm-computer-moves/run.ts'],
      { env: { PATH: process.env.PATH, HOME: process.env.HOME, DATABASE_URL: uri, REDIS_URL: 'redis://127.0.0.1:1', ...env }, timeout: 60_000 },
      (error, stdout, stderr) => resolve({ code: error ? (typeof error.code === 'number' ? error.code : -1) : 0, stdout, stderr }))
  })

  it('runs without billing\'s environment and exits once it has printed', async () => {
    const started = Date.now()
    const { code, stdout } = await script({ SWARM_WORKSPACES_REQUIRED: '0' })
    expect(code).toBe(0)
    const printed = JSON.parse(stdout.slice(stdout.indexOf('{'))) as { write: boolean; env: string; moves: unknown[]; left: unknown[] }
    expect(printed).toMatchObject({ write: false, env: 'prod', moves: expect.any(Array), left: expect.any(Array) })
    expect(Date.now() - started).toBeLessThan(60_000)
  }, 90_000)

  // Security review 1 of #3146: the Workspace check reads anything but '1' as not required, so a run that forgot the server's
  // setting would pass a Swarm the server refuses, in its dry run and its write alike. It must be said, either way.
  it('will not start unless told whether this server requires Workspaces', async () => {
    const { code, stdout, stderr } = await script({})
    expect(code).toBe(1)
    expect(stdout).toBe('')
    expect(stderr).toContain('SWARM_WORKSPACES_REQUIRED')
  }, 90_000)
})

describe("a Mac whose owner's Team account is about to join", () => {
  const run = (tab: string, command: Command, as: AuthUser = owner) => store.execute(as, tab, { operationId: randomUUID(), command })
  it('reads joining, not "not set up", until its Team account is listed, from an indexed read of the owners\' Team machines', async () => {
    const tab = (await store.create(owner, randomUUID(), 'Joining')).id
    const invitation = await run(tab, { type: 'invite.create', email: kelvinUser.email, role: 'collaborator', conversationId: 'lead' })
    await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, kelvinUser)
    await db.machine.create({ data: { machineId: 'kelvin-joining', userId: kelvin, computerId: 'f'.repeat(32), sessionKind: 'computer',
      apiKey: 'fixture-kelvin-joining', managerId: '', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machine.create({ data: { machineId: 'kelvin-joining-team', userId: kelvin, computerId: 'a'.repeat(31) + 'f', sessionKind: 'team',
      hostMachineId: 'kelvin-joining', apiKey: 'fixture-kelvin-joining-team', managerId: '', autonomousEnv: 'prod', authMode: 'remote' } })
    await run(tab, { type: 'machine.contribute', machineId: 'kelvin-joining', name: 'MacBooks-MacBook-Pro-7', cwd: '/work', scope: 'swarm',
      engines: ['claude'], maxAgents: 2, teamAccountOnly: true }, kelvinUser)
    await store.observeMachine(kelvinUser, tab, 'kelvin-joining', { generation: (await store.read(kelvinUser, tab)).state.machines![0]!.generation,
      resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9, diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9,
        deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null }, quotas: [], tools: {}, runningHarnessIds: [], stoppedHarnessIds: [] })
    const teamWork = async () => ((await store.read(kelvinUser, tab)).state.machines!.find(m => m.machineId === 'kelvin-joining') as { teamWork?: { code?: string } })
      .teamWork?.code
    expect(await teamWork()).toBe('TEAM_ACCOUNT_JOINING')
    const { state } = await store.readLoad(kelvinUser, tab)
    const entries = await profiled(db, () => store.joiningTeams(db, state))
    const rows = reads(entries, 'machines', ['hostMachineId'])
    expect(rows, JSON.stringify(plan(rows))).toHaveLength(1)
    expect(rows[0]!.planSummary, JSON.stringify(plan(rows))).toMatch(/IXSCAN \{ userId: 1/)
  })
})

describe("a Harness Team account's previous account's Swarm cleanup", () => {
  it('is pending while a Swarm lists its Team machine for cleanup, read from the computer and cleanup indexes', async () => {
    const TEAM_COMPUTER = '9'.repeat(32)
    await db.machine.create({ data: { machineId: 'kelvin-team-c', userId: kelvin, computerId: TEAM_COMPUTER, sessionKind: 'team', hostMachineId: 'kelvin-mac',
      apiKey: 'fixture-kelvin-team-c', managerId: '', autonomousEnv: 'prod', authMode: 'remote' } })
    const tab = (await store.create(owner, randomUUID(), 'Cleanup')).id
    // What a commit writes for a Swarm whose machineCleanups name that machine (parts/commit.ts): the index the read uses.
    await db.superTab.update({ where: { id: tab }, data: { cleanupMachineIds: ['kelvin-team-c'] } })
    expect(await teamCleanupPending(db, { computerId: TEAM_COMPUTER, userId: tt })).toBe(true)
    // Its own account signing in again (a plain repair) waits on nothing of its own.
    expect(await teamCleanupPending(db, { computerId: TEAM_COMPUTER, userId: kelvin })).toBe(false)
    const entries = await profiled(db, () => teamCleanupPending(db, { computerId: TEAM_COMPUTER, userId: tt }))
    const machines = reads(entries, 'machines', ['computerId'])
    expect(machines[0]!.planSummary, JSON.stringify(plan(machines))).toMatch(/IXSCAN \{ computerId: 1, userId: 1 \}/)
    const swarms = reads(entries, 'SuperTab', ['cleanupMachineIds'])
    expect(swarms[0]!.planSummary, JSON.stringify(plan(swarms))).toMatch(/IXSCAN \{ autonomousEnv: 1, cleanupMachineIds: 1/)
    await db.superTab.update({ where: { id: tab }, data: { cleanupMachineIds: [] } })
    expect(await teamCleanupPending(db, { computerId: TEAM_COMPUTER, userId: tt })).toBe(false)
  })
})
