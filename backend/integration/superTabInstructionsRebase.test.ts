import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore } from '../src/superTabs/store.js'
import type { Command } from '../src/superTabs/commands.js'
import { instructionsHash } from '../src/superTabs/instructions.js'
import { INSTRUCTIONS_TEMPLATE } from '../src/superTabs/instructionsTemplate.js'
import { attributedRules, droppedRules } from '../src/superTabs/instructionsDiff.js'
import { rebasedDocument } from '../src/superTabs/instructionsRebase.js'
import { rebaseAll, rebaseDone, rebaseUntilDone, REBASE_SUMMARY, REBASE_SWARMS } from '../src/superTabs/migration/rebase.js'
import { logger } from '../src/utils/logger.js'

// Task #3600 (anh Dee, 11-06: "ALL OF THEM"; River: "ship it asap", no preview): after the release every project's
// instructions move onto the new base once, by themselves, with no person's rule lost. A fresh loopback replica set, made here.
let replica: MongoMemoryReplSet
let db: PrismaClient
let store: SuperTabStore
const now = Date.parse('2026-11-06T04:00:00.000Z')
const owner: AuthUser = { sub: '100000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
/** Who asked for the move, named per Swarm: never its owner by default (review round 2 of #3300). */
const DEE = '6a8fe4fcf1a6b5972eed0103'
const config = { engine: 'codex', model: 'fixture-model', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const run = (tab: string, command: Command, asAgentId?: string) => store.execute(owner, tab, { operationId: randomUUID(), command }, asAgentId)

const BEFORE = `# Project instructions

How this project works (Ken, 2026-11-02).

## Roles

### PM

- Talks with people in the project chat.
- Owns the product completely (Dee, 2026-11-03). Its one mission is the positioning:
  - Tell the PM what you want, and your crew ships it.

### Integrator

- Merges and releases, in place of the PM (Ken, 2026-11-05).

## Workflow

1. One accepted request is one task.
2. Findings go straight to the Engineer (Ken, 2026-11-04; Dee, 2026-11-05).

## Talking in the project chat (anh Dee, 2026-11-04)

- Reacts instead of acknowledging.
`

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`rebase_test_${randomUUID().replaceAll('-', '_')}`)
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

/** A Swarm whose first project has BEFORE at revision 2 and a PM, and a second project still on the template. */
async function swarm(id: string = randomUUID()) {
  const tab = (await store.create(owner, id, 'Pilot')).id
  const pm = (await run(tab, { type: 'agent.add', conversationId: 'lead', machineId: 'test-host', harnessId: randomUUID(), name: 'Lead',
    configuration: config, lead: true })).result.agentId as string
  await run(tab, { type: 'instructions.save', projectId: 'lead', baseRevision: 1, text: BEFORE, summary: 'Our process.' })
  const app = (await run(tab, { type: 'project.create', name: 'App', visibility: 'public', brief: '' })).result.projectId as string
  return { tab, pm, app }
}
const projects = async (tab: string) => (await store.read(owner, tab)).state.projects!

describe('every project on the new base, once, by itself', () => {
  it('writes each project\'s new revision with every person\'s rule, keeps the before in its History, and tells its agents', async () => {
    const { tab, pm, app } = await swarm()
    const report = await rebaseAll(db, { now: () => now, swarms: [{ tabId: tab, askedBy: DEE }] })
    expect(report.failed).toEqual([])
    expect(report.held).toEqual([])
    expect(rebaseDone(report)).toBe(true)
    expect(report.written.filter(w => w.tabId === tab).map(w => [w.projectId, w.from, w.to])).toEqual([['lead', 2, 3], [app, 1, 2]])
    const after = await store.instructions(owner, tab, 'lead')
    expect(after).toMatchObject({ revision: 3, text: rebasedDocument(BEFORE).text, hash: instructionsHash(rebasedDocument(BEFORE).text) })
    // The one check that must be right: no person's rule dropped, reworded or left without its person.
    expect(droppedRules(BEFORE, after.text)).toEqual([])
    for (const rule of attributedRules(BEFORE)) expect(after.text.replace(/\s+/g, ' ')).toContain(rule.text)
    expect(after.text).not.toContain('Talks with people in the project chat')
    // The run's record: the before and after both readable in the History, the lines that went listed, written by the Swarm.
    expect((await store.instructionRevision(owner, tab, 'lead', 2)).text).toBe(BEFORE)
    const revision = await store.instructionRevision(owner, tab, 'lead', 3)
    expect(revision).toMatchObject({ text: after.text, summary: REBASE_SUMMARY, writtenBy: { kind: 'system', id: 'rebase' }, askedBy: DEE })
    expect(JSON.stringify(revision)).toContain('Talks with people in the project chat')
    expect((await store.instructions(owner, tab, app)).text).toBe(rebasedDocument(INSTRUCTIONS_TEMPLATE).text)
    // The new revision and hash on the head are what every agent's host compares: its PM is told the instructions changed and
    // reads them again (cli swarmInstructionsSkill.ts), as for any save.
    const head = await projects(tab)
    expect(head.map(p => [p.instructionsRevision, p.instructionsBase])).toEqual([[3, 1], [2, 1]])
    expect((await store.instructions(owner, tab, 'lead', pm)).revision).toBe(3)
  })

  it('runs once: a second run writes nothing, and a later save by a person stays', async () => {
    const { tab } = await swarm()
    await rebaseAll(db, { now: () => now, swarms: [{ tabId: tab, askedBy: DEE }] })
    await run(tab, { type: 'instructions.save', projectId: 'lead', baseRevision: 3, text: `${(await store.instructions(owner, tab, 'lead')).text}\n## This project\n\n- Repository: acme/app.\n`, summary: 'Facts.' })
    const again = await rebaseAll(db, { now: () => now, swarms: [{ tabId: tab, askedBy: DEE }] })
    expect(again.written).toEqual([])
    // A project made after the move starts on the base already (commands.ts project.create): nothing to move.
    const later = (await run(tab, { type: 'project.create', name: 'Later', visibility: 'public', brief: '' })).result.projectId as string
    expect((await rebaseAll(db, { now: () => now, swarms: [{ tabId: tab, askedBy: DEE }] })).written).toEqual([])
    expect((await store.instructions(owner, tab, later)).text).toBe(rebasedDocument(INSTRUCTIONS_TEMPLATE).text)
    expect((await projects(tab))[0]!.instructionsRevision).toBe(4)
    expect((await store.instructions(owner, tab, 'lead')).text).toContain('Repository: acme/app.')
  })

  it('holds back a project whose new document would lose a person\'s rule, writes nothing of it, and says so every run', async () => {
    const { tab, app } = await swarm()
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    // A builder that drops one rule, as a fault in it would: the job's own check, not the builder's word, decides.
    const faulty = (before: string) => {
      const built = rebasedDocument(before)
      return { ...built, text: built.text.replace(/^.*Merges and releases.*$/m, ''), lost: [] }
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await rebaseAll(db, { now: () => now, build: faulty, swarms: [{ tabId: tab, askedBy: DEE }] })
      expect(report.held.filter(h => h.tabId === tab)).toEqual([expect.objectContaining({ projectId: 'lead',
        rules: [expect.stringContaining('Merges and releases, in place of the PM (Ken, 2026-11-05).')] })])
      expect(rebaseDone(report)).toBe(false)
    }
    expect(error.mock.calls.filter(call => JSON.stringify(call).includes('would lose') && JSON.stringify(call).includes(tab))).toHaveLength(2)
    error.mockRestore()
    const head = await projects(tab)
    expect(head.find(p => p.id === 'lead')).toMatchObject({ instructionsRevision: 2 })
    expect(head.find(p => p.id === 'lead')!.instructionsBase).toBeUndefined()
    expect((await store.instructions(owner, tab, 'lead')).text).toBe(BEFORE)
    // The other project went on as planned.
    expect(head.find(p => p.id === app)).toMatchObject({ instructionsRevision: 2, instructionsBase: 1 })
  })

  // Review of #3300, Critical: Dee's "ALL OF THEM" is this Swarm's projects. Another team's Swarm is never touched.
  it('moves only the Swarm that asked for it, as asked by the person named for it, and leaves every other Swarm as it was', async () => {
    // Asked by anh Dee, a collaborator there, not by the Swarm's owner (ken15): review round 2 of #3300.
    expect(REBASE_SWARMS).toEqual([{ tabId: 'c51479bd73b59e58176ad9e4', askedBy: '6a8fe4fcf1a6b5972eed0103' }])
    const ours = await swarm()
    const theirs = await swarm()
    // By default it reads only the Swarm that asked, which is none of these: nothing on the server is scanned or written.
    const none = await rebaseAll(db, { now: () => now })
    expect(none).toMatchObject({ swarms: 0, written: [], held: [], failed: [], skipped: [] })
    expect(rebaseDone(none)).toBe(true)
    const report = await rebaseAll(db, { now: () => now, swarms: [{ tabId: ours.tab, askedBy: DEE }] })
    expect(report.swarms).toBe(1)
    expect(report.written.map(w => w.tabId)).toEqual([ours.tab, ours.tab])
    expect((await projects(theirs.tab)).map(p => [p.instructionsRevision, p.instructionsBase])).toEqual([[2, undefined], [1, undefined]])
    expect((await store.instructions(owner, theirs.tab, 'lead')).text).toBe(BEFORE)
    expect((await store.instructionRevision(owner, ours.tab, 'lead', 3)).askedBy).toBe(DEE)
  })

  // Review of #3300, Important 3: the hourly retries end. A held project is tried a bounded number of times, then the job
  // stops, saying so as an error; a Swarm that cannot be read keeps nothing waiting either.
  it('stops after a bounded number of passes while a project stays held back, saying it gave up', async () => {
    const { tab } = await swarm()
    const error = vi.spyOn(logger, 'error').mockImplementation(() => logger)
    const faulty = (before: string) => ({ ...rebasedDocument(before), text: rebasedDocument(before).text.replace(/^.*Merges and releases.*$/m, '') })
    const waits: number[] = []
    const report = await rebaseUntilDone(db, { swarms: [{ tabId: tab, askedBy: DEE }], build: faulty, passes: 3, wait: async ms => { waits.push(ms) } })
    expect(report?.held).toHaveLength(1)
    expect(waits).toHaveLength(2)
    expect(error.mock.calls.some(call => JSON.stringify(call).includes('gave up'))).toBe(true)
    error.mockRestore()
    // Done at once when nothing is held: one pass, no wait.
    const done: number[] = []
    expect(rebaseDone((await rebaseUntilDone(db, { swarms: [{ tabId: tab, askedBy: DEE }], wait: async ms => { done.push(ms) } }))!)).toBe(true)
    expect(done).toEqual([])
  })
})
