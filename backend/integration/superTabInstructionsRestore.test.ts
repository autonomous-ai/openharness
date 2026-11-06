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
import { INSTRUCTIONS_TEMPLATE } from '../src/superTabs/instructionsTemplate.js'
import { attributedRules, droppedRules, removedLines } from '../src/superTabs/instructionsDiff.js'
import { rebasedDocument as rebase } from '../src/superTabs/instructionsRebase.js'
import { REBASE_SUMMARY } from '../src/superTabs/migration/rebase.js'
import { revisionId } from '../src/superTabs/instructionsStore.js'
import { restoreAll, RESTORE_PREFIX } from '../src/superTabs/migration/restoreRebase.js'

// Task #3679 (anh Dee, P0): the first move onto the new base lost the lines no person's name guarded. A project it moved is given
// them back, once, word for word, as one saved revision, unless its PM already saved since. A fresh loopback replica set, made here.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const now = Date.parse('2026-11-06T04:00:00.000Z')
const owner: AuthUser = { sub: '100000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
/** Who asked for the move, named per Swarm: never its owner by default (review round 2 of #3300). */
const DEE = '6a8fe4fcf1a6b5972eed0103'
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
/** The document a project of this Swarm's own words moves to: every line kept (task #3679); the template alone moves in rules mode. */
const rebasedDocument = (before: string, facts = '') => rebase(before, facts, before === INSTRUCTIONS_TEMPLATE ? 'rules' : 'everything')
const run = (tab: string, command: Command, asAgentId?: string) => store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId)

const BEFORE = `# Project instructions

## Rules for every agent

- Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.
- Stop only processes you started, by id, never by name or pattern.
- Owns the product completely (Dee, 2026-11-03).

## PM schedule

- Daily at 07:03: the day's product metrics, as a new message in the project chat (Dee, 2026-11-04).
- Hourly, it finds where work waits and fixes the slowest step itself, unasked.
`

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`restore_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  store = new SuperTabStore(db, () => now)
  await db.user.create({ data: { id: owner.sub, externalId: `fixture-${owner.sub}`, email: owner.email, autonomousEnv: owner.autonomousEnv } })
  await db.machine.create({ data: { machineId: 'test-host', userId: owner.sub, apiKey: 'fixture-only', managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})

/** A Swarm whose first project has BEFORE at revision 2 and the first run's result at revision 3: only what a person's name guards,
 *  written as the Swarm (the move's own record) and marked on the base. The move itself now refuses such a document (rebase.ts), so
 *  this writes what the first run wrote, as it did. */
async function moved(id: string = randomUUID()) {
  const tab = (await store.create(owner, id, 'Pilot')).id
  await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Lead', configuration: config, lead: true })
  await run(tab, { type: 'instructions.save', projectId: 'lead', baseRevision: 1, text: BEFORE, summary: 'Our process.' })
  await run(tab, { type: 'instructions.save', projectId: 'lead', baseRevision: 2, text: rebase(BEFORE, '', 'rules').text, summary: REBASE_SUMMARY })
  await db.superTabInstructionsRevision.update({ where: { id: revisionId(tab, 'lead', 3) }, data: { writtenByKind: 'system', writtenBy: 'rebase', askedBy: DEE } })
  const head = await db.swarmHead.findUniqueOrThrow({ where: { id: `${tab}:head` } })
  const data = head.data as unknown as { projects: Array<Record<string, unknown>> }
  await db.swarmHead.update({ where: { id: head.id }, data: { version: head.version + 1, data: { ...data, projects: data.projects.map(p => ({ ...p, instructionsBase: 1 })) } as object } })
  return tab
}
const swarms = (tab: string) => [{ tabId: tab, askedBy: DEE }]
const projects = async (tab: string) => (await store.read(owner, tab)).state.projects!

describe('the lines the first move lost, given back', () => {
  it('appends them to the project as one saved revision, word for word, and reports them', async () => {
    const tab = await moved()
    // The first run's own check let them go: the lines are gone from the document it wrote.
    const lost = removedLines(BEFORE, (await store.instructions(owner, tab, 'lead')).text)
    expect(lost).toEqual(expect.arrayContaining(['Never run a test that signs the Mac out of the real CLI; Desktop tests use a memory store and a fake sign-in.',
      'Hourly, it finds where work waits and fixes the slowest step itself, unasked.']))
    const report = await restoreAll(db, { now: () => now, swarms: swarms(tab) })
    expect(report.failed).toEqual([])
    expect(report.held).toEqual([])
    expect(report.restored).toEqual([expect.objectContaining({ tabId: tab, projectId: 'lead', from: 3, to: 4, lines: lost })])
    const after = await store.instructions(owner, tab, 'lead')
    expect(after.revision).toBe(4)
    expect(removedLines(BEFORE, after.text)).toEqual([])
    expect(after.text).toContain('## Restored lines')
    expect(after.text).toContain('### Rules for every agent')
    // The move's own revision is still in the History, and the restore says what it is.
    const revision = await store.instructionRevision(owner, tab, 'lead', 4)
    expect(revision).toMatchObject({ text: after.text, writtenBy: { kind: 'system', id: 'restore' }, askedBy: DEE })
    expect(revision.summary.startsWith(RESTORE_PREFIX)).toBe(true)
    expect((await projects(tab)).find(p => p.id === 'lead')).toMatchObject({ instructionsRevision: 4, instructionsBase: 1 })
  })

  it('gives nothing back twice', async () => {
    const tab = await moved()
    await restoreAll(db, { now: () => now, swarms: swarms(tab) })
    const again = await restoreAll(db, { now: () => now, swarms: swarms(tab) })
    expect(again.restored).toEqual([])
    expect(again.held).toEqual([])
    expect((await store.instructions(owner, tab, 'lead')).revision).toBe(4)
  })

  // Review of #3327: the daily tidy is a save, so most projects are saved since the move. The lines the move lost were never in a later
  // revision, so no later save chose to drop them.
  it('gives a project saved since the move the lines the move lost, and keeps what its own save did', async () => {
    const tab = await moved()
    const text = `${(await store.instructions(owner, tab, 'lead')).text}\n- The PM's own note.\n`
    await run(tab, { type: 'instructions.save', projectId: 'lead', baseRevision: 3, text, summary: 'The daily tidy.' })
    const report = await restoreAll(db, { now: () => now, swarms: swarms(tab) })
    expect(report.held).toEqual([])
    expect(report.restored).toEqual([expect.objectContaining({ tabId: tab, projectId: 'lead', from: 4, to: 5 })])
    const after = await store.instructions(owner, tab, 'lead')
    expect(after.text).toContain("- The PM's own note.")
    expect(removedLines(BEFORE, after.text)).toEqual([])
    expect((await store.instructionRevision(owner, tab, 'lead', 4)).text).toBe(text)
  })

  it('leaves a project whose PM restored by hand alone, and tells that PM by a note which lines are still missing', async () => {
    const tab = await moved()
    // Its PM put one lost line back by hand and chose to leave the rest out, as harness did at revision 81.
    const text = `${(await store.instructions(owner, tab, 'lead')).text}\n- Stop only processes you started, by id, never by name or pattern.\n`
    await run(tab, { type: 'instructions.save', projectId: 'lead', baseRevision: 3, text, summary: 'Restored a safety rule.' })
    const report = await restoreAll(db, { now: () => now, swarms: swarms(tab) })
    expect(report.restored).toEqual([])
    expect(report.left).toEqual([expect.objectContaining({ tabId: tab, projectId: 'lead', missing: expect.any(Number) })])
    expect(report.left[0]!.missing).toBeGreaterThan(0)
    expect((await store.instructions(owner, tab, 'lead')).text).toBe(text)
    const notes = await db.superTabPmNote.findMany({ where: { tabId: tab, projectId: 'lead' } })
    expect(notes.map(n => n.text)).toEqual([expect.stringContaining('still missing')])
    expect(notes[0]!.askedBy).toBe(DEE)
    // Told once: a second pass adds no second note.
    await restoreAll(db, { now: () => now, swarms: swarms(tab) })
    expect(await db.superTabPmNote.count({ where: { tabId: tab, projectId: 'lead' } })).toBe(1)
  })

  it('does nothing for a project that lost nothing, and touches only the Swarm named', async () => {
    const tab = await moved()
    const other = await moved()
    const app = (await run(tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result.projectId as string
    const report = await restoreAll(db, { now: () => now, swarms: swarms(tab) })
    expect(report.restored.map(r => r.projectId)).toEqual(['lead'])
    expect((await projects(tab)).find(p => p.id === app)).toMatchObject({ instructionsRevision: 1 })
    expect((await store.instructions(owner, other, 'lead')).revision).toBe(3)
    // By default it reads only the Swarm that asked, which is none of these.
    expect(await restoreAll(db, { now: () => now })).toMatchObject({ swarms: 0, restored: [] })
  })
})
