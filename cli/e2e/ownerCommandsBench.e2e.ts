/** Quiet macOS comparison of the real sealed owner path, using retained old/current bundles. Opt in with
 * OWNER_COMMANDS_BENCH_BASE and OWNER_COMMANDS_BENCH_REPORT; E2E_BUNDLE_PATH is the current bundle. The fixed workload
 * is one bound fake agent, valid task routing, validation-refused empty sends, and ordinary agent-list requests.
 * A is baseline and B is current: BA,AB,BA,AB,BA,AB, with no adaptive retries. Core and devices CPU are separate and summed; all raw samples and partial failures are retained. This does not replace the separate real P2P typing benchmark. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, until } from './harness/daemon.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone } from './harness/relayPhone.js'
import { devicesPids } from './harness/desk.js'

const BASE = process.env.OWNER_COMMANDS_BENCH_BASE
const REPORT = process.env.OWNER_COMMANDS_BENCH_REPORT
const COUNT = 500, ROUNDS = 6, WARMUP = 20
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const cpuMs = (core: number, devices: number) => {
  const table = execFileSync('ps', ['-o', 'pid=,cputime=', '-p', `${core},${devices}`], { encoding: 'utf8' })
  const readings = new Map<number, number>()
  for (const line of table.trim().split('\n')) {
    const parts = /^\s*(\d+)\s+(\d+):(\d+(?:\.\d+)?)$/.exec(line)
    if (!parts) throw new Error('unexpected benchmark CPU format')
    readings.set(Number(parts[1]), (Number(parts[2]) * 60 + Number(parts[3])) * 1000)
  }
  if (!readings.has(core) || !readings.has(devices)) throw new Error('a benchmark process disappeared')
  return { core: readings.get(core)!, devices: readings.get(devices)! }
}
const percentile = (values: number[], at: number) => [...values].sort((a, b) => a - b)[Math.ceil(at * values.length) - 1]
type Fixture = { world: PhoneMachine; window?: LocalClient; phone?: RelayPhone }
type Prepared = Required<Fixture> & { agentId: string; core: number }

it.runIf(!!BASE && !!REPORT)('measures owner commands and ordinary RPCs on the same retained builds', async () => {
  if (process.platform !== 'darwin') throw new Error('this benchmark uses macOS ps CPU accounting')
  const current = process.env.E2E_BUNDLE_PATH
  if (!current) throw new Error('E2E_BUNDLE_PATH must name the retained current bundle')
  const fixtures: Fixture[] = [], samples: Array<Record<string, unknown>> = []
  const report: Record<string, unknown> = { schema: 3, node: process.version, platform: process.platform, arch: process.arch,
    source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CLI_ROOT, encoding: 'utf8' }).trim(),
    baselineSha256: sha(BASE!), currentSha256: sha(current), rigSha256: sha(fileURLToPath(import.meta.url)),
    configSha256: sha(join(CLI_ROOT, 'vitest.e2e.config.ts')), count: COUNT, rounds: ROUNDS, warmup: WARMUP,
    labels: { A: 'before', B: 'after' }, pairedOrder: ['BA', 'AB', 'BA', 'AB', 'BA', 'AB'],
    cpuResolutionMs: 10, status: 'running', samples }
  const save = () => writeFileSync(REPORT!, JSON.stringify(report, null, 2))
  const prepare = async (bundle: string): Promise<Prepared> => {
    const world = await startPhoneMachine({ scriptPath: bundle })
    // A later preparation failure must still retain this world's cleanup result.
    const fixture: Fixture = { world }
    fixtures.push(fixture)
    const { machine, backend } = world
    const window = fixture.window = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
    const cwd = join(machine.daemon.projectsDir, 'owner-command-bench')
    mkdirSync(cwd, { recursive: true })
    const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
    expect(created.error).toBeUndefined()
    const agentId = created.agent.id as string
    await until('the benchmark agent to bind', async () => {
      const rows = (await window.request('agents_list', {})).agents as Array<Record<string, unknown>>
      return rows.find(row => row.id === agentId && row.sessionId && row.status === 'active') || null
    }, 60_000, 250)
    await until('the benchmark gateway on the private relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
    const phone = fixture.phone = new RelayPhone({ backend, machineId: machine.machineId, identity: world.phone.identity, machinePub: machine.identity.pub, token: world.phone.token })
    await phone.open()
    return { world, window, phone, agentId, core: machine.daemon.corePid()! }
  }
  const workloads = {
    route_task: { text: 'fixed owner command workload' },
    route_send: { agentId: 'unknown-benchmark-agent', text: '' },
    agents_list: {},
  }
  try {
    const builds = { before: await prepare(BASE!), after: await prepare(current) }
    const ask = async (fixture: Prepared, type: keyof typeof workloads) => {
      const answer = await fixture.phone.request(type, workloads[type])
      if (type === 'route_send') {
        expect(answer.error).toBe('INVALID_REQUEST')
        expect(answer.ok).toBeUndefined()
      } else {
        expect(answer.error).toBeUndefined()
        if (type === 'route_task') expect(answer.agentId).toBe(fixture.agentId)
        else expect(answer.agents).toHaveLength(1)
      }
    }
    const types = Object.keys(workloads) as Array<keyof typeof workloads>
    for (const fixture of Object.values(builds)) for (const type of types) for (let n = 0; n < WARMUP; n++) await ask(fixture, type)
    const devices = Object.fromEntries(Object.entries(builds).map(([name, fixture]) => {
      const pids = devicesPids(fixture.world.machine.daemon)
      if (pids.length !== 1) throw new Error('expected exactly one benchmark devices process')
      return [name, pids[0]]
    }))
    for (let round = 0; round < ROUNDS; round++) {
      const order = round % 2 ? ['before', 'after'] as const : ['after', 'before'] as const
      for (const name of order) for (const type of types) {
        const fixture = builds[name], latencyMs: number[] = []
        const sample: Record<string, unknown> = { round, name, type, n: 0, latencyMs }
        samples.push(sample)
        const cpu = cpuMs(fixture.core, devices[name]), started = performance.now()
        for (let n = 0; n < COUNT; n++) {
          const start = performance.now()
          await ask(fixture, type)
          latencyMs.push(performance.now() - start)
          sample.n = latencyMs.length
        }
        const wallMs = performance.now() - started, end = cpuMs(fixture.core, devices[name])
        const coreCpuMs = end.core - cpu.core, devicesCpuMs = end.devices - cpu.devices
        const combinedCpuMs = coreCpuMs + devicesCpuMs
        expect(fixture.world.machine.daemon.corePid()).toBe(fixture.core)
        Object.assign(sample, { wallMs, coreCpuMs, devicesCpuMs, combinedCpuMs,
          coreCpuUsPerRequest: coreCpuMs * 1000 / COUNT, devicesCpuUsPerRequest: devicesCpuMs * 1000 / COUNT,
          combinedCpuUsPerRequest: combinedCpuMs * 1000 / COUNT,
          p50Ms: percentile(latencyMs, .5), p95Ms: percentile(latencyMs, .95) })
        save()
      }
    }
    report.status = 'passed'
  } catch (error) {
    report.status = 'failed'
    report.failure = error instanceof Error ? error.name : 'BENCHMARK_FAILURE'
    throw error
  } finally {
    const cleanup = await Promise.all(fixtures.map(async fixture => {
      // Fleet.close discards daemon cleanup failures; a benchmark must report them.
      const [phone, window, daemon] = await Promise.allSettled([
        Promise.resolve().then(() => fixture.phone?.close()),
        Promise.resolve().then(() => fixture.window?.close()),
        Promise.resolve().then(() => fixture.world.machine.daemon.close()),
      ])
      const [backend] = await Promise.allSettled([Promise.resolve().then(() => fixture.world.backend.close())])
      return { phone: phone.status, window: window.status, daemon: daemon.status, backend: backend.status }
    }))
    report.cleanup = cleanup
    if (cleanup.some(result => Object.values(result).includes('rejected'))) report.status = 'cleanup_failed'
    save()
    if (report.status === 'cleanup_failed') throw new Error('benchmark cleanup failed')
  }
}, 600_000)
