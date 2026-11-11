import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { AttemptCounter } from './attempts.js'
import { runBench } from './bench.js'
import { DEFAULT_CONFIG, type BenchConfig } from './config.js'
import { machineId, person } from './fixtures.js'
import { partsDriver } from './drivers/parts.js'
import { localDatabase, type LocalDatabase } from './mongo.js'
import { plan, planDigest } from './plan.js'
import type { BenchReport } from './report.js'
import { renderMarkdown } from './report.js'
import { AGENT_CONFIGURATION } from './seed.js'

// A short run of the whole Swarm v4 scenario through the routes its clients call, on its own loopback replica set.
const config: BenchConfig = { ...DEFAULT_CONFIG, agents: 5, projects: 2, machines: 2, durationMs: 6_000, desktopReaders: 2, hostReaders: 1,
  every: { channelPostMs: 800, chatTurnMs: 1_200, observeMs: 2_000, deliveryPassMs: 700, desktopPollMs: 1_000, hostTickMs: 500 },
  text: { messageChars: 80 } }
let database: LocalDatabase
let report: BenchReport
const op = (name: string) => report.load.ops.find(row => row.key === name)

beforeAll(async () => {
  database = await localDatabase()
  report = await runBench(config, database.db)
})
afterAll(async () => { await database?.stop() })

describe('the Swarm load benchmark', () => {
  it('builds a v4 Swarm: every agent with its chat, every project with its channel and PM', () => {
    expect(report.setup).toMatchObject({ agents: 5, pms: 2, conversations: 7 })
    expect(report.planDigest).toBe(planDigest(plan(config)))
  })

  it('runs every planned channel post, chat turn, machine report and poll exactly once', () => {
    const p = plan(config)
    const sends = (prefix: string) => report.load.writers.filter(w => w.key.startsWith(prefix)).reduce((sum, w) => sum + (w.byOp['message.send'] ?? 0), 0)
    const turns = p.agents.reduce((sum, a) => sum + a.turns.length, 0)
    // A person's post that ran out of retries gets no answer (load.ts); that is counted, never lost.
    expect(sends('person-')).toBe(turns)
    expect(sends('agent-') + (report.load.skipped['chat answers'] ?? 0)).toBe(p.agents.reduce((sum, a) => sum + a.posts.length, 0) + turns)
    expect(op('observeMachine')?.count).toBe(p.machines.reduce((sum, m) => sum + m.observations.length, 0))
    expect(op('read.desktop')?.count).toBe(p.readers.filter(r => r.kind === 'desktop').reduce((sum, r) => sum + r.polls.length, 0))
    expect(op('read.host')?.count).toBe(p.readers.filter(r => r.kind === 'host').reduce((sum, r) => sum + r.polls.length, 0))
    expect(Object.keys(report.load.skipped).filter(k => k !== 'chat answers')).toEqual([])
  })

  it('gets no error back but a busy Swarm', () => {
    for (const row of report.load.ops) {
      expect(row.errors, row.key).toEqual({})
      expect(row.ok + row.swarmBusy, row.key).toBe(row.count)
    }
  })

  it('claims and acknowledges the deliveries people\'s chats and Members\' channel posts create', () => {
    expect(op('delivery.claim')!.ok).toBeGreaterThan(0)
    expect(op('delivery.ack')!.count).toBe(op('delivery.claim')!.ok)
    expect(op('deliveries.list')!.count).toBeGreaterThan(0)
  })

  it('keeps each kind of writer apart: agents, people, machines, delivery passes, Desktop and host readers', () => {
    const kinds = Object.fromEntries(report.load.writerKinds.map(k => [k.key, k.count]))
    expect(Object.keys(kinds)).toEqual(['agent', 'delivery', 'desktop', 'host', 'machine', 'person'])
    expect(kinds.host).toBe(op('read.host')!.count)
    expect(kinds.delivery).toBe(op('deliveries.list')!.count + op('delivery.claim')!.count + op('delivery.ack')!.count)
  })

  it('measures what a poll costs and how big the state is', () => {
    const desktop = op('read.desktop')!.bytes!, host = op('read.host')!.bytes!
    expect(desktop.mean).toBeGreaterThan(host.mean)
    expect(report.state.afterSetup.bytes).toBeGreaterThan(0)
    // The stored parts grow during the load: messages raise their conversations' counters, reports their watermarks.
    expect(report.state.afterLoad.bytes).toBeGreaterThan(report.state.afterSetup.bytes)
    expect(report.isolatedPolls.map(p => p.reader).sort()).toEqual(report.load.readers.map(r => r.key).sort())
    for (const poll of report.isolatedPolls) expect(poll.responseBytes).toBeGreaterThan(0)
    expect(report.kpis?.isolated?.polls).toBeGreaterThan(0)
  })

  it('writes a markdown report with the run, the operations, the writers and the readers', () => {
    const markdown = renderMarkdown(report)
    for (const heading of ['## Run', '## Operations', '## Writer kinds', '## Writers', '## Readers', '## State']) expect(markdown).toContain(heading)
    expect(markdown).toContain('| Swarm | 5 agents (2 of them PMs), 2 projects, 7 conversations, 2 machines |')
    expect(markdown).toContain('| message.send |')
  })

  it('counts the write conflicts the store retries when posts in one Swarm run at once', async () => {
    const counter = new AttemptCounter(), owner = person(0)
    const driver = await partsDriver(counter.wrap(database.db), () => [owner])
    try {
      const tab = (await driver.createSwarm(owner, 'conflict-check', 'Conflicts')).data!.id
      const chat = String((await driver.execute(tab, owner, 'conflict-agent', { type: 'agent.new', kind: 'regular', machineId: machineId(0), engine: 'codex',
        name: 'Pip', local: true })).data!.result.conversationId)
      expect((await driver.execute(tab, owner, 'conflict-add', { type: 'agent.add', conversationId: chat, machineId: machineId(0), harnessId: 'conflict-pip',
        name: 'Pip', configuration: AGENT_CONFIGURATION, lead: false })).code).toBeNull()
      const sends = await Promise.all(Array.from({ length: 10 }, (_, i) => counter.track(() => driver.execute(tab, owner, `conflict-${i}`,
        { type: 'message.send', conversationId: chat, text: `Note ${i}`, replyTo: null, recipientIds: [] }))))
      expect(sends.map(s => s.value?.code ?? 'ok')).toEqual(Array(10).fill('ok'))
      expect(sends.flatMap(s => s.failedAttempts).filter(code => code === 'P2034').length).toBeGreaterThan(0)
    } finally {
      await driver.close()
    }
  })
})
