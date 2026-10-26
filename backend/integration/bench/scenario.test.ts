import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AttemptCounter } from './attempts.js'
import { runBench } from './bench.js'
import { DEFAULT_CONFIG, type BenchConfig } from './config.js'
import { person } from './fixtures.js'
import { legacyDriver } from './legacyDriver.js'
import { localDatabase, type LocalDatabase } from './mongo.js'
import { plan, planDigest } from './plan.js'
import type { BenchReport } from './report.js'
import { renderMarkdown } from './report.js'

// A short run of the whole scenario through today's driver, on its own loopback replica set.
const config: BenchConfig = { ...DEFAULT_CONFIG, groups: 6, doneShare: 0.5, workers: 3, machines: 2, durationMs: 6_000, desktopReaders: 2, hostReaders: 1,
  every: { workerPostMs: 600, leadSendMs: 800, nativeTurnMs: 1_500, observeMs: 2_000, deliveryPassMs: 700, desktopPollMs: 1_000, hostTickMs: 500 },
  text: { briefChars: 400, resultChars: 100, messageChars: 80 } }
// The cross-group lane on a hot Swarm: every group active, fewer workers than groups.
const lane: BenchConfig = { ...config, doneShare: 0, workers: 2, lane: 'cross-group' }
let database: LocalDatabase, laneDatabase: LocalDatabase, partsDatabase: LocalDatabase
let report: BenchReport, laneReport: BenchReport, partsReport: BenchReport
const op = (name: string, from = report) => from.load.ops.find(row => row.key === name)

beforeAll(async () => {
  database = await localDatabase()
  report = await runBench(config, 'legacy', database.db)
  // Each run seeds its own accounts, so it gets a fresh database.
  laneDatabase = await localDatabase()
  laneReport = await runBench(lane, 'legacy', laneDatabase.db)
  // The state's size and the polls' cost on the store by parts (#1726 group 2): `SuperTab` is only a fixed fence there.
  partsDatabase = await localDatabase()
  partsReport = await runBench(config, 'parts', partsDatabase.db)
})
afterAll(async () => { await database?.stop(); await laneDatabase?.stop(); await partsDatabase?.stop() })

describe('the Swarm load benchmark on today\'s store', () => {
  it('runs every planned worker post, Lead message, terminal turn, machine report and poll exactly once', () => {
    const p = plan(config)
    const planned = (name: string) => p.workers.flatMap(w => w.actions).filter(a => a.op === name).length
    for (const name of ['work.status', 'work.check']) expect(op(name)?.count, name).toBe(planned(name))
    const workerSends = report.load.writers.filter(w => w.key.startsWith('worker-')).reduce((sum, w) => sum + (w.byOp['message.send'] ?? 0), 0)
    expect(workerSends).toBe(planned('message.send'))
    expect(report.load.writers.find(w => w.key === 'lead')!.byOp['message.send']).toBe(p.lead.length)
    // An answer whose prompt ran out of retries is not sent (load.ts); that is counted, never lost.
    expect(op('native.append')!.count + (report.load.skipped['native answers'] ?? 0)).toBe(2 * p.workers.reduce((sum, w) => sum + w.turns.length, 0))
    expect(op('observeMachine')?.count).toBe(p.machines.reduce((sum, m) => sum + m.observations.length, 0))
    expect(op('read.desktop')?.count).toBe(p.readers.filter(r => r.kind === 'desktop').reduce((sum, r) => sum + r.polls.length, 0))
    expect(op('read.host')?.count).toBe(p.readers.filter(r => r.kind === 'host').reduce((sum, r) => sum + r.polls.length, 0))
    expect(Object.keys(report.load.skipped).filter(k => k !== 'native answers')).toEqual([])
    expect(report.planDigest).toBe(planDigest(p))
  })

  it('gets no error back but a busy Swarm', () => {
    for (const row of report.load.ops) {
      expect(row.errors, row.key).toEqual({})
      expect(row.ok + row.swarmBusy, row.key).toBe(row.count)
    }
  })

  it('claims and acknowledges the deliveries the Lead and the terminals create', () => {
    expect(op('delivery.claim')!.ok).toBeGreaterThan(0)
    expect(op('delivery.ack')!.count).toBe(op('delivery.claim')!.ok)
    expect(op('deliveries.list')!.count).toBeGreaterThan(0)
  })

  it('keeps each kind of writer apart: delivery passes, host roster reads, machines, terminals, workers, the Lead', () => {
    const kinds = Object.fromEntries(report.load.writerKinds.map(k => [k.key, k.count]))
    expect(Object.keys(kinds)).toEqual(['delivery', 'desktop', 'host', 'lead', 'machine', 'terminal', 'worker'])
    expect(kinds.host).toBe(op('read.host')!.count)
    expect(kinds.delivery).toBe(op('deliveries.list')!.count + op('delivery.claim')!.count + op('delivery.ack')!.count)
  })

  it('measures what a poll costs and how big the state is (parts driver)', () => {
    const desktop = op('read.desktop', partsReport)!.bytes!, host = op('read.host', partsReport)!.bytes!
    expect(desktop.mean).toBeGreaterThan(host.mean)
    expect(partsReport.state.afterSetup.bytes).toBeGreaterThan(0)
    // The stored parts grow during the load: messages raise their groups' counters, reports their watermarks.
    expect(partsReport.state.afterLoad.bytes).toBeGreaterThan(partsReport.state.afterSetup.bytes)
    expect(partsReport.state.afterLoad.documents).toBeGreaterThan(1)
    expect(partsReport.isolatedPolls.map(p => p.reader).sort()).toEqual(partsReport.load.readers.map(r => r.key).sort())
    for (const poll of partsReport.isolatedPolls) expect(poll.responseBytes).toBeGreaterThan(0)
    // A host's roster reply is small, but today's roster route loads every live part to build it (group 3 replaces it).
    const hostPoll = partsReport.isolatedPolls.find(p => p.reader.startsWith('host:'))!
    expect(hostPoll.databaseBytesOut).toBeGreaterThan(partsReport.state.afterLoad.bytes / 2)
  })

  it('writes a markdown report with the run, the operations, the writers and the readers', () => {
    const markdown = renderMarkdown(report)
    for (const heading of ['## Run', '## Operations', '## Writer kinds', '## Writers', '## Readers', '## State']) expect(markdown).toContain(heading)
    expect(renderMarkdown(laneReport)).toContain('| Lane | cross-group')
    expect(markdown).toContain('| work.status |')
  })

  it('runs the cross-group lane: workers in all their groups, terminals and machine reports, no Lead and no delivery passes', () => {
    const p = plan(lane)
    expect(p.workers.map(w => w.groups.length)).toEqual([3, 3])
    const planned = (name: string) => p.workers.flatMap(w => w.actions).filter(a => a.op === name).length
    for (const name of ['message.send', 'work.status', 'work.check']) expect(op(name, laneReport)?.count ?? 0, name).toBe(planned(name))
    expect(op('native.append', laneReport)!.count + (laneReport.load.skipped['native answers'] ?? 0)).toBe(2 * p.workers.reduce((sum, w) => sum + w.turns.length, 0))
    expect(op('observeMachine', laneReport)?.count).toBe(p.machines.reduce((sum, m) => sum + m.observations.length, 0))
    for (const name of ['deliveries.list', 'delivery.claim', 'delivery.ack']) expect(op(name, laneReport), name).toBeUndefined()
    expect(laneReport.load.writers.map(w => w.key)).not.toContain('lead')
    for (const row of laneReport.load.ops) expect(row.errors, row.key).toEqual({})
    expect(laneReport.load.writerKinds.map(k => k.key)).toEqual(['desktop', 'host', 'machine', 'terminal', 'worker'])
  })

  it('counts the write conflicts the store retries when commands on one Swarm run at once', async () => {
    const counter = new AttemptCounter(), owner = person(0)
    const driver = await legacyDriver(counter.wrap(database.db), () => [owner])
    try {
      const tab = (await driver.createSwarm(owner, 'conflict-check', 'Conflicts')).data!.id
      const sends = await Promise.all(Array.from({ length: 10 }, (_, i) => counter.track(() => driver.execute(tab, owner, `conflict-${i}`,
        { type: 'message.send', conversationId: 'lead', text: `Note ${i}`, replyTo: null, recipientIds: [] }))))
      expect(sends.map(s => s.value?.code ?? 'ok')).toEqual(Array(10).fill('ok'))
      expect(sends.flatMap(s => s.failedAttempts).filter(code => code === 'P2034').length).toBeGreaterThan(0)
    } finally {
      await driver.close()
    }
  })
})
