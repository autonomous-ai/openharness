import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { MongoMemoryReplSet } from 'mongodb-memory-server-core'
import { PrismaClient } from '@prisma/client'
import type { AuthUser } from '../src/lib/ssoAuth.js'
import { SuperTabStore, type SwarmChanged } from '../src/superTabs/store.js'
import { configureSwarmStamps } from '../src/superTabs/cache.js'
import { MemoryStamps } from '../src/superTabs/cache.test-support.js'
import { localReportMemory, machineReportLine, RECORD_TTL_MS, type ReportMemory } from '../src/superTabs/machineReports.js'
import { SWEEP_EVERY_MS } from '../src/superTabs/liveness.js'
import type { Command } from '../src/superTabs/commands.js'
import type { MachineObservation } from '../src/superTabs/machines.js'
import type { MachineData } from '../src/superTabs/parts/index.js'
import { poolRows } from './hostRows.test-support.js'
import { storeAssignment } from './storedWork.test-support.js'

// Machine reports that change only the machine's reading skip the Swarm load (DB roadmap 2.5). A fresh loopback replica
// set, created here; Redis is MemoryStamps and an in-process report memory. This suite never reads DATABASE_URL.
let replica: MongoMemoryReplSet
let db: PrismaClient
let stamps: MemoryStamps
const owner: AuthUser = { sub: '300000000000000000000001', email: 'owner@example.com', autonomousEnv: 'prod', role: 'user' }
const host: AuthUser = { sub: '300000000000000000000003', email: 'host@example.com', autonomousEnv: 'prod', role: 'user' }
const config = { engine: 'codex', model: 'gpt-6.1-sol', effort: 'high', contextWindow: 200000, engineVersion: 'fixture' }
const BEAT = 15_000
const MINUTE = 60_000

beforeAll(async () => {
  replica = await MongoMemoryReplSet.create({ binary: { version: '7.0.24', downloadDir: join(tmpdir(), 'harness-super-tab-mongodb-binaries') },
    replSet: { count: 1, ip: '127.0.0.1', storageEngine: 'wiredTiger' } })
  const uri = replica.getUri(`swarm_machine_reports_test_${randomUUID().replaceAll('-', '_')}`)
  await promisify(execFile)(join(process.cwd(), 'node_modules/.bin/prisma'), ['db', 'push', '--skip-generate'], {
    env: { ...process.env, DATABASE_URL: uri }, timeout: 60000,
  })
  db = new PrismaClient({ datasources: { db: { url: uri } } })
  for (const user of [owner, host]) await db.user.create({ data: { id: user.sub, externalId: `fixture-${user.sub}`, email: user.email, autonomousEnv: user.autonomousEnv } })
  for (const machineId of ['lead-host', 'test-host', 'spare-host']) {
    await db.machine.create({ data: { machineId, userId: host.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
    await db.machineShare.create({ data: { machineId, ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
  }
})
afterAll(async () => {
  await db?.$disconnect()
  await replica?.stop()
})
beforeEach(() => { stamps = new MemoryStamps(); configureSwarmStamps(stamps) })
afterEach(() => configureSwarmStamps(new MemoryStamps()))

/** A memory whose sweeps are never due, so a test sees only the reason it is about. */
const quiet = (memory: ReportMemory): ReportMemory => ({ get: (t, m) => memory.get(t, m), set: (t, m, r) => memory.set(t, m, r), sweepDue: async () => false })
/** A server that remembers no full report: every reading runs in full. */
const never: ReportMemory = { get: async () => undefined, set: async () => {}, sweepDue: async () => false }
/** [memory], with each answer it gives to "is this Swarm's sweep due?" put in [asked]: a reading that is refused never asks. */
const logged = (asked: boolean[], memory: ReportMemory): ReportMemory => ({ get: (t, m) => memory.get(t, m), set: (t, m, r) => memory.set(t, m, r),
  sweepDue: async (t, at) => { const due = await memory.sweepDue(t, at); asked.push(due); return due } })

/** A Swarm whose Lead runs on lead-host and whose worker runs on test-host, working on a task the owner asked for. Swarms
 *  given one [shared] clock and memory are one server's. */
async function swarm(memory?: (now: () => number) => ReportMemory, shared?: { clock: { now: number }; reports: ReportMemory }) {
  const clock = shared?.clock ?? { now: 10_000_000 }
  const pushes: SwarmChanged[] = []
  const reports = shared?.reports ?? memory?.(() => clock.now) ?? quiet(localReportMemory(() => clock.now))
  const store = (with_: ReportMemory = reports) => new SuperTabStore(db, () => clock.now, null, { reports: with_, swarmChanged: change => pushes.push(change) })
  const timed = store()
  const tab = (await timed.create(owner, randomUUID(), 'Reports', 'public')).id
  const execute = (command: Command, user = owner, asAgentId?: string) => timed.execute(user, tab, { operationId: randomUUID(), command }, asAgentId)
  const invitation = await execute({ type: 'invite.create', email: host.email, role: 'collaborator', conversationId: 'lead' })
  await execute({ type: 'invite.accept', inviteId: invitation.result.inviteId as string }, host)
  for (const [machineId, name] of [['lead-host', 'Lead Mac'], ['test-host', 'Worker Mac']]) {
    await execute({ type: 'machine.contribute', machineId: machineId!, name: name!, cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
  }
  const generations = new Map<string, string>()
  for (const machineId of ['lead-host', 'test-host']) generations.set(machineId, (await poolRows(timed, host, machineId)).find(p => p.tabId === tab)!.machine.generation)
  const harness = { lead: randomUUID(), worker: randomUUID() }
  // An agent runs as its own person, on their own computer (task #4120): the machines are host's, so host adds the worker.
  const add = async (conversationId: string, machineId: string, harnessId: string, name: string, lead = false, user = owner) => String((await execute({ type: 'agent.add',
    conversationId, machineId, harnessId, name, configuration: config, lead }, user)).result.agentId)
  const lead = await add('lead', 'lead-host', harness.lead, 'Lead', true)
  const group = String((await execute({ type: 'conversation.create', title: 'Ship the parser', brief: 'Implement it',
    checks: [{ description: 'Verified', independent: false }] })).result.conversationId)
  const worker = await add(group, 'test-host', harness.worker, 'Worker', false, host)
  await storeAssignment(db, tab, group, worker, clock.now)
  const reading = (machineId: string, running: string[], extra: Partial<MachineObservation> = {}): MachineObservation => ({
    generation: generations.get(machineId)!, resources: { cpuPercent: 10, memoryTotalBytes: 32e9, memoryUsedBytes: 4e9, diskFreeBytes: 120e9,
      diskTotalBytes: 500e9, projectDiskFreeBytes: 120e9, deviceType: 'Laptop', chip: 'Fixture', os: 'macOS', gpuPercent: null },
    quotas: [], tools: {}, runningHarnessIds: running, stoppedHarnessIds: [], ...extra })
  /** The worker's machine reports its session running, with what else [extra] says. */
  const beat = (extra: Partial<MachineObservation> = {}, by = timed) => by.observeMachine(host, tab, 'test-host', reading('test-host', [harness.worker], extra))
  const part = () => db.swarmMachine.findUniqueOrThrow({ where: { id: `${tab}:test-host` } })
  const assignment = async () => (await timed.read(owner, tab)).state.conversations.find(c => c.id === group)!.assignment!
  return { clock, pushes, reports, store, timed, tab, execute, lead, group, worker, harness, reading, beat, part, assignment }
}
type Scene = Awaited<ReturnType<typeof swarm>>

/** Which path the one report [run] sends took. */
async function pathOf(run: () => Promise<unknown>): Promise<'fast' | 'full'> {
  machineReportLine(0)
  let failed: unknown
  try { await run() } catch (error) { failed = error }
  const { fast, full } = machineReportLine(0)
  if (fast + full !== 1) throw new Error(`expected one report, saw ${fast} fast and ${full} full`)
  if (failed) throw failed
  return fast ? 'fast' : 'full'
}

/** Heartbeats every 15 s until one is stored fast; the paths taken, at most three. */
async function settle(f: Scene, extra: Partial<MachineObservation> = {}): Promise<Array<'fast' | 'full'>> {
  const paths: Array<'fast' | 'full'> = []
  while (paths.at(-1) !== 'fast' && paths.length < 3) {
    paths.push(await pathOf(() => f.beat(extra)))
    f.clock.now += BEAT
  }
  return paths
}

/** The part collections' operations MongoDB served while `run` ran, by collection (its profiler). */
async function partOps(run: () => Promise<unknown>): Promise<Record<string, number>> {
  await db.$runCommandRaw({ profile: 2 })
  const since = new Date()
  try {
    await run()
    const rows = await db.$runCommandRaw({ find: 'system.profile', filter: { ts: { $gte: { $date: since.toISOString() } },
      ns: { $regex: '\\.Swarm(Head|Member|Agent|Group|Machine|Start|Progress)$' } }, projection: { _id: 0, ns: 1 }, batchSize: 10_000 }) as
      { cursor: { firstBatch: Array<{ ns: string }> } }
    const counts: Record<string, number> = {}
    for (const { ns } of rows.cursor.firstBatch) counts[ns.slice(ns.lastIndexOf('.') + 1)] = (counts[ns.slice(ns.lastIndexOf('.') + 1)] ?? 0) + 1
    return counts
  } finally {
    await db.$runCommandRaw({ profile: 0 })
  }
}

describe('a reading-only heartbeat (DB 2.5)', () => {
  it('runs in full once, then is stored without loading the Swarm', async () => {
    const f = await swarm()
    const paths = await settle(f)
    expect(paths.at(-1)).toBe('fast')
    expect(paths[0]).toBe('full')
  })

  it('stores exactly what the full path stores, Lent included, and pushes the same to the same people', async () => {
    const f = await swarm()
    await settle(f, { harnessProgress: { [f.harness.worker]: f.clock.now } })
    const before = await f.part()
    const heartbeat = { harnessProgress: { [f.harness.worker]: f.clock.now - 1_000 }, resources: { ...f.reading('test-host', []).resources, cpuPercent: 77 } }
    f.pushes.length = 0
    const fast = await (async () => { let version = 0; expect(await pathOf(async () => { version = (await f.beat(heartbeat)).version })).toBe('fast'); return version })()
    const viaFast = { data: (await f.part()).data, pushes: [...f.pushes] }
    // The same heartbeat again from the same moment, by a server that remembers nothing: the full path.
    await db.swarmMachine.update({ where: { id: before.id }, data: { version: before.version, data: before.data as never, readAt: before.readAt } })
    f.pushes.length = 0
    const forgetful = f.store(never)
    let full = 0
    expect(await pathOf(async () => { full = (await f.beat(heartbeat, forgetful)).version })).toBe('full')
    const viaFull = { data: (await f.part()).data, pushes: [...f.pushes] }
    expect(fast).toBe(full)
    expect(viaFast.data).toEqual(viaFull.data)
    expect((viaFast.data as unknown as MachineData).contribution!.lent?.[0]?.busyMs).toBeGreaterThan(0)
    // Each push carries its own write's stamp; who is told, and of what, is the same.
    const pushed = (list: SwarmChanged[]) => list.map(({ lastChangedAt: _stamp, ...p }) => ({ ...p, userIds: [...p.userIds].sort() }))
    expect(pushed(viaFast.pushes)).toEqual(pushed(viaFull.pushes))
    expect(viaFast.pushes).toMatchObject([{ parts: ['machine'] }])
  })

  it('reads only the machine part among the Swarm\'s parts, writes it once, and moves only the machine stamp', async () => {
    const f = await swarm()
    await settle(f)
    const bumps = stamps.bumps.length
    let path: 'fast' | 'full' = 'full'
    const ops = await partOps(async () => { path = await pathOf(() => f.beat()) })
    expect(path).toBe('fast')
    expect(Object.keys(ops)).toEqual(['SwarmMachine'])
    // Its read, and its version-guarded write: Prisma's updateMany reads the matching ids, then updates them.
    expect(ops.SwarmMachine).toBeLessThanOrEqual(3)
    expect(stamps.bumps.slice(bumps)).toEqual([{ tabId: f.tab, scopes: ['machine'] }])
  })
})

describe('every reason a report runs in full (DB 2.5 spec, Tests)', () => {
  /** What changes before the heartbeat, the heartbeat itself, and which server it reaches. */
  type Change = { extra?: Partial<MachineObservation>; by?: SuperTabStore }
  const cases: Array<[string, (f: Scene) => Promise<Change | void>, { stopped?: true; progress?: true }?]> = [
    ['its running sessions changed', async f => ({ extra: { runningHarnessIds: [f.harness.worker, 'another'] } })],
    ['its stopped sessions changed', async () => ({ extra: { stoppedHarnessIds: ['gone'] } })],
    ['it proves a session stopped', async () => ({ extra: { stoppedReservations: [{ harnessId: 'gone', generation: 'g1' }] } }), { stopped: true }],
    ['a running session lost its progress entry', async () => ({ extra: { harnessProgress: {} } }), { progress: true }],
    // What concerns this machine changed since its last full report (task #3119): what its host reads (commit.ts hostsToTell).
    ['an agent was added on it', async f => {
      await f.execute({ type: 'agent.add', conversationId: f.group, machineId: 'test-host', harnessId: randomUUID(), name: 'Helper', configuration: config, lead: false }, host)
    }],
    ['a start was queued on it', async f => {
      await f.execute({ type: 'agent.start', request: { conversationId: f.group, machineId: 'test-host', engine: 'codex', name: 'Builder', cwd: '/repo',
        worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }, host)
    }],
    ['a conversation an agent on it works in changed', async f => {
      // The Lead's post: only agents post in a project's channel and its tasks' chats (agentsOnly.test.ts).
      await f.execute({ type: 'message.send', conversationId: f.group, text: 'hi', replyTo: null, recipientIds: [] }, host, f.lead)
    }],
    ['the Swarm\'s people changed', async f => {
      await f.execute({ type: 'invite.create', email: 'third@example.com', role: 'collaborator', conversationId: 'lead' })
    }],
    ['a server of the release before changed the Swarm', async f => {
      // It moves the main stamp alone: it knows no host stamps.
      await stamps.bumpAsOlderRelease(f.tab, ['main'])
    }],
    ['its record is missing', async f => ({ by: f.store(never) })],
    ['the stamps cannot be read', async () => { stamps.down = true }],
    ['its record is older than two minutes, whatever other machines wrote since', async f => {
      await f.reports.set(f.tab, 'test-host', { ...(await f.reports.get(f.tab, 'test-host'))!, at: f.clock.now - RECORD_TTL_MS })
    }],
    ['a bump of its Swarm is owed here', async f => {
      const bump = stamps.bump.bind(stamps)
      stamps.bump = async () => { throw new Error('Redis is unreachable') }
      await f.execute({ type: 'message.send', conversationId: 'lead', text: 'owed', replyTo: null, recipientIds: [] }, host, f.lead)
      stamps.bump = bump
    }],
    ['an engine suspension ends with this reading', async f => {
      const row = await f.part()
      const data = structuredClone(row.data) as unknown as MachineData
      data.contribution!.engineSuspensions = { codex: { at: f.clock.now - 7 * 60 * MINUTE, fine: false } }
      await db.swarmMachine.update({ where: { id: row.id }, data: { data: data as never } })
    }],
  ]
  for (const [reason, change, baseline] of cases) {
    it(reason, async () => {
      const f = await swarm()
      const settled: Partial<MachineObservation> = { ...baseline?.stopped ? { stoppedHarnessIds: ['gone'] } : {},
        ...baseline?.progress ? { harnessProgress: { [f.harness.worker]: f.clock.now } } : {} }
      expect((await settle(f, settled)).at(-1)).toBe('fast')
      const { extra = {}, by = f.timed } = await change(f) ?? {}
      expect(await pathOf(() => f.beat({ ...settled, ...extra }, by))).toBe('full')
    })
  }

  it('a machine of the Swarm is being removed', async () => {
    const f = await swarm()
    expect((await settle(f)).at(-1)).toBe('fast')
    // A spare machine leaves while online: it stays listed, cleaning, until its host confirms (machines.ts removal).
    await f.execute({ type: 'machine.contribute', machineId: 'spare-host', name: 'Spare Mac', cwd: '/repo', engines: ['codex'], maxAgents: 1 }, host)
    const generation = (await poolRows(f.timed, host, 'spare-host')).find(p => p.tabId === f.tab)!.machine.generation
    await f.timed.observeMachine(host, f.tab, 'spare-host', { ...f.reading('test-host', []), generation })
    await f.execute({ type: 'machine.remove', machineId: 'spare-host' }, host)
    expect(await pathOf(() => f.beat())).toBe('full')
    f.clock.now += BEAT
    expect(await pathOf(() => f.beat())).toBe('full')
  })

  it('its sweep is due', async () => {
    const f = await swarm(now => localReportMemory(now))
    const start = f.clock.now
    const paths: string[] = []
    // The first report sweeps; within 30 s the reports may go fast; at 30 s the next one sweeps, in full.
    for (const at of [0, 5_000, 10_000, 20_000, SWEEP_EVERY_MS]) {
      f.clock.now = start + at
      paths.push(await pathOf(() => f.beat()))
    }
    expect(paths[0]).toBe('full')
    expect(paths[3]).toBe('fast')
    expect(paths[4]).toBe('full')
  })

  it('its contribution was regenerated: refused as revoked', async () => {
    const f = await swarm()
    expect((await settle(f)).at(-1)).toBe('fast')
    await expect(f.beat({ generation: 'not-the-current-one' })).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
  })
})

describe('the sweep clock and Lent on the fast path', () => {

  it('counts the same Lent after N fast heartbeats as after N full ones, also right after the running set changed', async () => {
    const fast = await swarm(), full = await swarm()
    const forgetful = full.store(never)
    const run = async (f: Scene, by = f.timed) => {
      const paths: string[] = []
      // Not running yet, then running: the full report that changes the running set records the count for the next ones.
      paths.push(await pathOf(() => by.observeMachine(host, f.tab, 'test-host', f.reading('test-host', []))))
      for (let i = 0; i < 5; i++) {
        f.clock.now += BEAT
        paths.push(await pathOf(() => f.beat({}, by)))
      }
      return { paths, lent: ((await f.part()).data as unknown as MachineData).contribution!.lent }
    }
    const a = await run(fast), b = await run(full, forgetful)
    expect(a.paths).toContain('fast')
    expect(b.paths.every(p => p === 'full')).toBe(true)
    expect(a.lent).toEqual(b.lent)
    expect(a.lent?.[0]?.busyMs).toBe(4 * BEAT)
  })

  it('never lets a refused reading take the Swarm\'s sweep', async () => {
    const asked: boolean[] = []
    const f = await swarm(now => logged(asked, localReportMemory(now)))
    const lead = (extra: Partial<MachineObservation> = {}) => f.timed.observeMachine(host, f.tab, 'lead-host', { ...f.reading('lead-host', [f.harness.lead]), ...extra })
    await lead()
    await f.beat()
    // A while on, a revoked reading arrives first, then the Lead machine's own.
    f.clock.now += 125_000
    asked.length = 0
    await expect(lead({ generation: 'not-the-current-one' })).rejects.toMatchObject({ code: 'CONTRIBUTION_REVOKED' })
    expect(asked).toEqual([])
    await lead()
    expect(asked).toEqual([true])
  })

  it('sweeps a Swarm once per 30 seconds between servers sharing one memory', async () => {
    for (const shared of [true, false]) {
      const f = await swarm(now => localReportMemory(now))
      const asked: boolean[] = []
      const other = f.store(logged(asked, shared ? f.reports : localReportMemory(() => f.clock.now)))
      const lead = (by: SuperTabStore) => by.observeMachine(host, f.tab, 'lead-host', f.reading('lead-host', [f.harness.lead]))
      await lead(f.timed)
      await f.beat()
      // This server's sweep runs.
      f.clock.now += 100_000
      await lead(f.timed)
      // 25 s on, another server's report: only one whose sweep is due takes it.
      f.clock.now += 25_000
      await lead(other)
      expect(asked, shared ? 'shared clock' : 'own clock').toEqual([!shared])
      if (!shared) continue
      f.clock.now += 5_000
      await lead(other)
      expect(asked).toEqual([false, true])
    }
  })
})

describe('a machine\'s readings for all its Swarms in one call (DB 2.5)', () => {
  /** [count] Swarms the worker's machine is in, on one server. */
  async function server(count: number) {
    const clock = { now: 10_000_000 }, reports = quiet(localReportMemory(() => clock.now))
    const swarms: Scene[] = []
    for (let i = 0; i < count; i++) swarms.push(await swarm(undefined, { clock, reports }))
    return { clock, swarms, store: swarms[0]!.timed }
  }
  /** The `Machine` rows (collection `machines`) read while [run] ran. */
  const machineReads = async (run: () => Promise<unknown>) => {
    await db.$runCommandRaw({ profile: 2 })
    const since = new Date()
    try {
      await run()
      const rows = await db.$runCommandRaw({ find: 'system.profile', filter: { ts: { $gte: { $date: since.toISOString() } }, ns: { $regex: '\\.machines$' } },
        projection: { _id: 0, ns: 1 } }) as { cursor: { firstBatch: unknown[] } }
      return rows.cursor.firstBatch.length
    } finally {
      await db.$runCommandRaw({ profile: 0 })
    }
  }

  it('answers each Swarm on its own: one stored fast, one in full, one revoked; the machine\'s owner checked once', async () => {
    const { clock, swarms: [warm, cold, revoked], store } = await server(3)
    expect((await settle(warm!)).at(-1)).toBe('fast')
    clock.now += BEAT
    let results: Array<{ tabId: string; error?: unknown }> = []
    machineReportLine(0)
    const reads = await machineReads(async () => {
      results = await store.observeMachines(host, 'test-host', [{ tabId: warm!.tab, observation: warm!.reading('test-host', [warm!.harness.worker]) },
        { tabId: cold!.tab, observation: cold!.reading('test-host', [cold!.harness.worker]) },
        { tabId: revoked!.tab, observation: { ...revoked!.reading('test-host', [revoked!.harness.worker]), generation: 'not-the-current-one' } }])
    })
    expect(machineReportLine(0)).toMatchObject({ fast: 1, full: 2 })
    expect(results.map(r => [r.tabId, (r.error as { code?: string } | undefined)?.code])).toEqual([[warm!.tab, undefined], [cold!.tab, undefined],
      [revoked!.tab, 'CONTRIBUTION_REVOKED']])
    expect(reads).toBe(1)
    for (const f of [warm!, cold!]) expect(((await f.part()).data as unknown as MachineData).contribution!.observation!.receivedAt).toBe(clock.now)
  })

  it('stores a machine\'s readings for 21 Swarms in one call', async () => {
    const { clock, swarms, store } = await server(21)
    clock.now += BEAT
    const results = await store.observeMachines(host, 'test-host', swarms.map(f => ({ tabId: f.tab, observation: f.reading('test-host', [f.harness.worker]) })))
    expect(results.filter(r => r.error)).toEqual([])
    for (const f of swarms) expect(((await f.part()).data as unknown as MachineData).contribution!.observation!.receivedAt).toBe(clock.now)
  })
})

describe('a full report reads only the parts that changed since this server last read them (B3, #2597)', () => {
  /** What MongoDB sent back from the machine and conversation collections while [run] ran (its profiler's replies). */
  async function partBytes(run: () => Promise<unknown>): Promise<{ SwarmMachine: number; SwarmGroup: number }> {
    await db.$runCommandRaw({ profile: 2 })
    const since = new Date()
    try {
      await run()
      const rows = await db.$runCommandRaw({ find: 'system.profile', filter: { ts: { $gte: { $date: since.toISOString() } },
        ns: { $regex: '\\.Swarm(Group|Machine)$' } }, projection: { _id: 0, ns: 1, responseLength: 1 }, batchSize: 10_000 }) as
        { cursor: { firstBatch: Array<{ ns: string; responseLength?: number }> } }
      const bytes = { SwarmMachine: 0, SwarmGroup: 0 }
      for (const { ns, responseLength } of rows.cursor.firstBatch) bytes[ns.slice(ns.lastIndexOf('.') + 1) as keyof typeof bytes] += Number(responseLength ?? 0)
      return bytes
    } finally {
      await db.$runCommandRaw({ profile: 0 })
    }
  }

  it('reads under half the machine and conversation bytes on its next full report', async () => {
    const f = await swarm()
    // Eight machines, as a Swarm has: one reports, the others' parts stay as they are.
    for (let i = 0; i < 6; i++) {
      const machineId = `idle-${randomUUID()}`
      await db.machine.create({ data: { machineId, userId: host.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
      await db.machineShare.create({ data: { machineId, ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
      await f.execute({ type: 'machine.contribute', machineId, name: `Idle ${i}`, cwd: '/repo', engines: ['codex'], maxAgents: 4 }, host)
    }
    // A server that remembers no report: every reading runs in full.
    const forgetful = f.store(never)
    const first = await partBytes(() => f.beat({}, forgetful))
    f.clock.now += BEAT
    const second = await partBytes(() => f.beat({}, forgetful))
    expect(first.SwarmMachine).toBeGreaterThan(0)
    expect(first.SwarmGroup).toBeGreaterThan(0)
    expect(second.SwarmMachine).toBeLessThan(first.SwarmMachine / 2)
    expect(second.SwarmGroup).toBeLessThan(first.SwarmGroup / 2)
  })
})

describe('a busy Swarm\'s readings (task #3119)', () => {
  /** A store on [f]'s server whose every Prisma call is counted, by model and operation, as Ken's scan names them. */
  function counted(f: Scene, reports: ReportMemory = f.reports) {
    const ops: Record<string, number> = {}
    const client = db.$extends({ query: { $allModels: { async $allOperations({ model, operation, args, query }) {
      ops[`${model}.${operation}`] = (ops[`${model}.${operation}`] ?? 0) + 1
      return query(args)
    } } } }) as unknown as PrismaClient
    const store = new SuperTabStore(client, () => f.clock.now, null, { reports, swarmChanged: change => f.pushes.push(change) })
    /** The calls [run] made, and the path its one report took. */
    const during = async (run: () => Promise<unknown>) => {
      for (const key of Object.keys(ops)) delete ops[key]
      const path = await pathOf(run)
      return { path, ops: { ...ops }, calls: Object.values(ops).reduce((a, b) => a + b, 0) }
    }
    return { store, during }
  }
  /** The Lead's post in its project's channel, where only agents post (agentsOnly.test.ts). */
  const message = (f: Scene, text: string) => f.execute({ type: 'message.send', conversationId: 'lead', text, replyTo: null, recipientIds: [] }, host, f.lead)

  // Swarm v4 runs no v3 job on a report: it lost a task, nudged a crew member and kept a crew, so each full report read every
  // project's rules (one indexed read per project with a task assigned, and with crew) to judge them. Now none.
  it('reads no project rules in a full report, though a task is assigned in the Swarm', async () => {
    const f = await swarm()
    const { store, during } = counted(f, never)
    await f.beat({}, store)
    f.clock.now += BEAT
    const beat = await during(() => f.beat({}, store))
    expect(beat.path).toBe('full')
    expect((await f.assignment()).status).toBe('working')
    expect(Object.keys(beat.ops).filter(op => op.startsWith('SuperTabProjectRules.'))).toEqual([])
  })

  it('stores a reading fast, in four calls, after a change elsewhere in the Swarm', async () => {
    const f = await swarm()
    const { store, during } = counted(f)
    expect((await settle(f)).at(-1)).toBe('fast')
    // The Lead's chat moves: nothing the worker's machine hosts or decides from.
    await message(f, 'the Lead talks')
    const beat = await during(() => f.beat({}, store))
    expect(beat.path).toBe('fast')
    expect(beat.calls).toBeLessThanOrEqual(4)
    expect(Object.keys(beat.ops).filter(op => /^Swarm(Head|Member|Agent|Start|Group)\./.test(op))).toEqual([])
  })

  it('reads the same number of times in full whatever the Swarm\'s agents, starts and machines, one read per kind', async () => {
    const f = await swarm()
    const { store, during } = counted(f, never)
    // Its second full report: this server holds the Swarm's parts from its first, as in production.
    await f.beat({}, store)
    f.clock.now += BEAT
    const small = await during(() => f.beat({}, store))
    f.clock.now += BEAT
    // Ten more agents and ten more starts, and four more machines that each read since this server last read the Swarm.
    const spares: Array<[string, string]> = []
    for (let i = 0; i < 4; i++) {
      const machineId = `busy-${randomUUID()}`
      await db.machine.create({ data: { machineId, userId: host.sub, apiKey: `fixture-${machineId}`, managerId: 'fixture', autonomousEnv: 'prod', authMode: 'remote' } })
      await db.machineShare.create({ data: { machineId, ownerId: host.sub, autonomousEnv: 'prod', emails: [owner.email] } })
      await f.execute({ type: 'machine.contribute', machineId, name: `Busy ${i}`, cwd: '/repo', engines: ['codex'], maxAgents: 40 }, host)
      spares.push([machineId, (await poolRows(f.timed, host, machineId)).find(p => p.tabId === f.tab)!.machine.generation])
    }
    const [spare] = spares[0]!
    for (const [machineId, generation] of spares) await f.timed.observeMachine(host, f.tab, machineId, { ...f.reading('test-host', []), generation })
    for (let i = 0; i < 10; i++) {
      await f.execute({ type: 'agent.add', conversationId: f.group, machineId: spare, harnessId: randomUUID(), name: `Helper ${i}`, configuration: config, lead: false }, host)
      await f.execute({ type: 'agent.start', request: { conversationId: f.group, machineId: spare, engine: 'codex', name: `Builder ${i}`, cwd: '/repo',
        worktree: true, requirements: { memoryBytes: 0, diskBytes: 0, maxCpuPercent: 100, tools: [], devices: [], quotaRequired: false } } }, host)
    }
    await f.beat({}, store)
    f.clock.now += BEAT
    // Then each of the four reads on another server: its part moves past what this server holds.
    for (const [machineId] of spares) {
      const row = await db.swarmMachine.findUniqueOrThrow({ where: { id: `${f.tab}:${machineId}` } })
      await db.swarmMachine.update({ where: { id: row.id }, data: { version: row.version + 1, readAt: new Date(f.clock.now) } })
    }
    const big = await during(() => f.beat({}, store))
    expect([small.path, big.path]).toEqual(['full', 'full'])
    const reads = (ops: Record<string, number>) => Object.fromEntries(Object.entries(ops).filter(([op]) => !/\.(update|create|delete)/.test(op)))
    expect(reads(big.ops)).toEqual(reads(small.ops))
    expect(big.ops['SwarmMachine.findUnique']).toBeUndefined()
  })

  it('stores and pushes a changed quota and readiness at once, on the fast path', async () => {
    const f = await swarm()
    expect((await settle(f)).at(-1)).toBe('fast')
    await message(f, 'the Lead talks')
    f.pushes.length = 0
    const quotas: MachineObservation['quotas'] = [{ engine: 'codex', known: true, windows: [{ name: 'week', usedPercent: 97, resetsAt: null }] }]
    const tools: MachineObservation['tools'] = { git: true }
    expect(await pathOf(() => f.beat({ quotas, tools }))).toBe('fast')
    const stored = ((await f.part()).data as unknown as MachineData).contribution!.observation!
    expect(stored.quotas).toEqual(quotas)
    expect(stored.tools).toEqual(tools)
    expect(f.pushes).toMatchObject([{ tabId: f.tab, parts: ['machine'] }])
  })
})
