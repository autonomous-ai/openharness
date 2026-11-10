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
import * as parts from '../src/superTabs/parts/index.js'
import type { SuperTabState } from '../src/superTabs/model.js'
import { takeOutTeamMachinesOnce } from '../src/superTabs/migration/teamMachinesJob.js'

// Harness Team accounts are gone (anh Dee, 2026-11-10). What older releases left of one's machine in a Swarm, and its account
// row, go by a one-time job in the worker (migration/teamMachinesJob.ts). A fresh loopback replica set, created here.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const owner: AuthUser = { sub: '200000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const person: AuthUser = { sub: '200000000000000000000002', email: 'person@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const run = (tab: string, command: Command, user: AuthUser = owner) => store.execute(user, tab, { operationId: randomUUID(), command })

async function storedState(tab: string): Promise<SuperTabState> {
  return parts.reassemble(await db.$transaction(tx => parts.loadAll(tx, tab)))
}
/** Replaces a Swarm's parts with [state], as an older release would have left them. Versions keep rising. */
async function saveState(tab: string, state: SuperTabState) {
  await db.$transaction(async tx => {
    const current = await parts.loadAll(tx, tab)
    const version = Math.max(current.head.version, ...[...current.members, ...current.agents, ...current.groups, ...current.machines,
      ...current.starts, ...current.progress].map(p => p.version)) + 1
    for (const model of [tx.swarmHead, tx.swarmMember, tx.swarmAgent, tx.swarmGroup, tx.swarmMachine, tx.swarmStart, tx.swarmProgress] as unknown as
      Array<{ deleteMany(args: unknown): Promise<unknown> }>) await model.deleteMany({ where: { tabId: tab } })
    await parts.insertParts(tx, { ...parts.split(state, { tabId: tab, version, now: Date.now(), visibilityEpoch: current.visibilityEpoch }),
      sequenceBase: current.sequenceBase })
  })
}
const headVersion = async (tab: string) => (await db.swarmHead.findFirst({ where: { tabId: tab } }))!.version

/** The owner's Swarm with the person in it, as Swarm v4 runs it: the owner's PM on the owner's computer, the person's computer
 *  and their agent in a task, and words in it. Then what an older release recorded of the person's Harness Team account on that
 *  computer: its pool naming the Mac, and an agent that joined there, in the same task. */
async function fixture() {
  const tab = (await store.create(owner, randomUUID(), 'Team machines')).id
  const invitation = await run(tab, { type: 'invite.create', email: person.email, role: 'collaborator', conversationId: 'lead' })
  await run(tab, { type: 'invite.accept', inviteId: invitation.result.inviteId as string }, person)
  const pm = String((await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'owner-host', harnessId: randomUUID(),
    name: 'Lead', configuration: config, lead: true })).result.agentId)
  const task = String((await run(tab, { type: 'conversation.create', projectId: 'lead', title: 'Work', brief: 'Do it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  await run(tab, { type: 'machine.contribute', machineId: 'personal-mac', name: 'MacBook', cwd: '/work', engines: ['codex'], maxAgents: 4 }, person)
  const own = String((await run(tab, { type: 'agent.add', conversationId: task, machineId: 'personal-mac', harnessId: randomUUID(),
    name: 'Builder', configuration: config, lead: false }, person)).result.agentId)
  // The PM's words: only agents post in a task's chat (agentsOnly.test.ts).
  const said = String((await store.execute(owner, tab, { operationId: randomUUID(), command: { type: 'message.send', conversationId: task,
    text: 'Start with the parser.', replyTo: null, recipientIds: [] } }, pm)).result.messageId)
  const state = await storedState(tab)
  const mac = state.machines!.find(m => m.machineId === 'personal-mac')!
  state.machines!.push({ ...structuredClone(mac), machineId: 'team-mac', hostMachineId: 'personal-mac' } as typeof mac)
  const builder = state.agents.find(a => a.id === own)!
  state.agents.push({ ...structuredClone(builder), id: 'team-agent', name: 'Helper', displayName: 'Helper', machineId: 'team-mac', harnessId: 'team-harness', teamAccount: true } as typeof builder)
  const taskAgents = [...state.conversations.find(c => c.id === task)!.agentIds]
  state.conversations.find(c => c.id === task)!.agentIds.push('team-agent')
  await saveState(tab, state)
  return { tab, pm, task, own, said, taskAgents }
}

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`super_tab_team_machines_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db)
  for (const user of [owner, person]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`,
    email: user.email, autonomousEnv: user.autonomousEnv } })
  const machine = (machineId: string, userId: string, computerId: string, sessionKind: string, hostMachineId?: string) => db.machine.create({ data: {
    machineId, userId, computerId, sessionKind, ...hostMachineId ? { hostMachineId } : {}, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
  await machine('owner-host', owner.sub, 'cccccccccccccccccccccccccccccccc', 'computer')
  await machine('personal-mac', person.sub, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'computer')
  await machine('team-mac', person.sub, 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'team', 'personal-mac')
  // A person's own computer they turned into a Team machine (`harness team on`): its row names no Mac.
  await machine('converted-mac', person.sub, 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', 'team')
}, 120_000)
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

describe('the one-time job that takes Harness Team accounts\' machines out', () => {
  it('takes each out of its Swarm with its agents, once, when two pods run it together, and keeps everything else', async () => {
    const f = await fixture()
    const untouched = (await store.create(owner, randomUUID(), 'No Team machine')).id
    const untouchedVersion = await headVersion(untouched)

    const pods = [new SuperTabStore(db), new SuperTabStore(db)]
    const passes = await Promise.all(pods.map(pod => takeOutTeamMachinesOnce(db, pod)))
    expect(passes.map(p => p.failed)).toEqual([0, 0])

    const state = await storedState(f.tab)
    // The Team machine and its agent are gone, and nothing waits on a host that can no longer connect.
    expect(state.machines!.map(m => m.machineId)).toEqual(['personal-mac'])
    expect(state.agents.map(a => a.id).sort()).toEqual([f.own, f.pm].sort())
    expect(state.machineCleanups ?? []).toEqual([])
    expect((state.closingSessions ?? []).filter(c => c.machineId === 'team-mac')).toEqual([])
    // Swarm v4's own data stays: the PM, the person's computer and agent, the task and its words.
    expect(state.conversations.find(c => c.id === f.task)!.agentIds).toEqual(f.taskAgents)
    const rows = await db.superTabMessage.findMany({ where: { tabId: f.tab, conversationId: f.task }, orderBy: { sequence: 'asc' } })
    expect(rows.some(r => r.id === f.said && r.text === 'Start with the parser.')).toBe(true)
    // Its readers are told once, though both pods ran.
    expect(rows.filter(r => r.text.startsWith('Harness Team accounts are gone')).map(r => r.text))
      .toEqual(['Harness Team accounts are gone, so the one on MacBook left the Swarm, and "Helper" with it.'])
    // The Team account's row on the Mac is soft-deleted; the person's own computer's is not, nor a computer of theirs they had
    // turned into a Team machine, whose own sign-in takes its row back (deleted, that sign-in would be refused and signed out).
    expect((await db.machine.findUnique({ where: { machineId: 'team-mac' } }))!.deletedAt).not.toBeNull()
    expect((await db.machine.findUnique({ where: { machineId: 'personal-mac' } }))!.deletedAt).toBeNull()
    expect((await db.machine.findUnique({ where: { machineId: 'converted-mac' } }))!.deletedAt).toBeNull()
    // A Swarm with no Team machine is read and never written.
    expect(await headVersion(untouched)).toBe(untouchedVersion)

    // Done: the next pass changes nothing, so the job stops.
    expect(await takeOutTeamMachinesOnce(db, store)).toEqual({ swarms: expect.any(Number), machines: 0, rows: 0, failed: 0 })
  })

  it('marks nothing on the task a Team agent was building: the Team-written guard went with Team accounts', async () => {
    const f = await fixture()
    const state = await storedState(f.tab)
    state.conversations.find(c => c.id === f.task)!.assignment = { id: 'team-work', agentId: 'team-agent', status: 'working', configuration: config,
      execution: { machineId: 'team-mac', harnessId: 'team-harness', machineOwnerId: person.sub }, result: null } as never
    await saveState(f.tab, state)
    expect((await takeOutTeamMachinesOnce(db, store)).failed).toBe(0)
    const after = await storedState(f.tab)
    expect(after.agents.map(a => a.id)).not.toContain('team-agent')
    expect(after.conversations.find(c => c.id === f.task)).not.toHaveProperty('teamWritten')
  })

  it('takes out the Team machines of a Swarm whose owner\'s account is gone, so the job can finish', async () => {
    const gone: AuthUser = { sub: '200000000000000000000003', email: 'gone@example.com', autonomousEnv: 'prod', role: 'user' }
    await db.user.create({ data: { id: gone.sub, externalId: `fixture-${gone.sub}`, email: gone.email, autonomousEnv: gone.autonomousEnv } })
    const tab = (await store.create(gone, randomUUID(), 'Owner gone')).id
    const state = await storedState(tab)
    ;(state.machines ??= []).push({ machineId: 'gone-team', name: 'Mini', contributorId: gone.sub, membershipGeneration: state.people[0]!.generation,
      generation: 'g', cwd: '/work', engines: ['codex'], maxAgents: 2, paused: false, hostMachineId: 'gone-mac' } as never)
    await saveState(tab, state)
    await db.user.delete({ where: { id: gone.sub } })
    expect(await store.takeOutTeamMachines(tab)).toBe(1)
    expect((await storedState(tab)).machines ?? []).toEqual([])
  })

  it('refuses a client that sends the store\'s own command', async () => {
    const f = await fixture()
    await expect(run(f.tab, { type: 'machine.teamGone', machineId: 'team-mac' })).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 })
    expect((await storedState(f.tab)).machines!.map(m => m.machineId)).toContain('team-mac')
  })
})
