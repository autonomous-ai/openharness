/** Quiet macOS comparison of the real sealed owner path, using retained old/current bundles. Opt in with
 * OWNER_COMMANDS_BENCH_BASE and OWNER_COMMANDS_BENCH_REPORT; E2E_BUNDLE_PATH is the current bundle. The fixed workload
 * is one bound fake agent, valid task routing, refused sends to an unknown agent, and ordinary agent-list requests.
 * Six alternating rounds keep all samples. This does not replace the separate real P2P typing benchmark. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, until } from './harness/daemon.js'
import { startPhoneMachine, type PhoneMachine } from './harness/fleet.js'
import { RelayPhone } from './harness/relayPhone.js'

const BASE = process.env.OWNER_COMMANDS_BENCH_BASE
const REPORT = process.env.OWNER_COMMANDS_BENCH_REPORT
const COUNT = 500, ROUNDS = 6, WARMUP = 20
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const cpuMs = (pid: number) => {
  const value = execFileSync('ps', ['-o', 'cputime=', '-p', String(pid)], { encoding: 'utf8' }).trim()
  if (!/^\d+:\d+(?:\.\d+)?$/.test(value)) throw new Error(`unexpected benchmark CPU format: ${value}`)
  const [minutes, seconds] = value.split(':').map(Number)
  return (minutes * 60 + seconds) * 1000
}
const percentile = (values: number[], at: number) => [...values].sort((a, b) => a - b)[Math.ceil(at * values.length) - 1]
type Prepared = { world: PhoneMachine; window: LocalClient; phone: RelayPhone; agentId: string; core: number }

it.runIf(!!BASE && !!REPORT)('measures owner commands and ordinary RPCs on the same retained builds', async () => {
  if (process.platform !== 'darwin') throw new Error('this benchmark uses macOS ps CPU accounting')
  const current = process.env.E2E_BUNDLE_PATH
  if (!current) throw new Error('E2E_BUNDLE_PATH must name the retained current bundle')
  const fixtures: Prepared[] = []
  const prepare = async (bundle: string): Promise<Prepared> => {
    const world = await startPhoneMachine({ scriptPath: bundle })
    let window: LocalClient | undefined, phone: RelayPhone | undefined
    try {
      const { machine, backend } = world
      window = await LocalClient.connect(machine.daemon, { machineId: machine.machineId })
      const cwd = join(machine.daemon.projectsDir, 'owner-command-bench')
      mkdirSync(cwd, { recursive: true })
      const created = await window.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 60_000)
      expect(created.error).toBeUndefined()
      const agentId = created.agent.id as string
      await until('the benchmark agent to bind', async () => {
        const rows = (await window!.request('agents_list', {})).agents as Array<Record<string, unknown>>
        return rows.find(row => row.id === agentId && row.sessionId && row.status === 'active') || null
      }, 60_000, 250)
      await until('the benchmark gateway on the private relay', () => backend.nodeUp(machine.machineId) || null, 30_000)
      phone = new RelayPhone({ backend, machineId: machine.machineId, identity: world.phone.identity, machinePub: machine.identity.pub, token: world.phone.token })
      await phone.open()
      const fixture = { world, window, phone, agentId, core: machine.daemon.corePid()! }
      fixtures.push(fixture)
      return fixture
    } catch (error) {
      phone?.close(); window?.close(); await world.close()
      throw error
    }
  }
  const workloads = {
    route_task: { text: 'fixed owner command workload' },
    route_send: { agentId: 'unknown-benchmark-agent', text: 'fixed refused send workload' },
    agents_list: {},
  }
  try {
    const builds = { before: await prepare(BASE!), after: await prepare(current) }
    const ask = async (fixture: Prepared, type: keyof typeof workloads) => {
      const answer = await fixture.phone.request(type, workloads[type])
      expect(answer.error).toBeUndefined()
      if (type === 'route_task') expect(answer.agentId).toBe(fixture.agentId)
      else if (type === 'route_send') expect(answer.ok).toBe(false)
      else expect(answer.agents).toHaveLength(1)
    }
    const types = Object.keys(workloads) as Array<keyof typeof workloads>
    for (const fixture of Object.values(builds)) for (const type of types) for (let n = 0; n < WARMUP; n++) await ask(fixture, type)
    const samples: Array<Record<string, unknown>> = []
    for (let round = 0; round < ROUNDS; round++) {
      const order = round % 2 ? ['after', 'before'] as const : ['before', 'after'] as const
      for (const name of order) for (const type of types) {
        const fixture = builds[name], latencyMs: number[] = []
        const cpu = cpuMs(fixture.core), started = performance.now()
        for (let n = 0; n < COUNT; n++) {
          const start = performance.now()
          await ask(fixture, type)
          latencyMs.push(performance.now() - start)
        }
        const wallMs = performance.now() - started, used = cpuMs(fixture.core) - cpu
        expect(fixture.world.machine.daemon.corePid()).toBe(fixture.core)
        samples.push({ round, name, type, n: COUNT, wallMs, coreCpuMs: used, coreCpuUsPerRequest: used * 1000 / COUNT,
          p50Ms: percentile(latencyMs, .5), p95Ms: percentile(latencyMs, .95), latencyMs })
      }
    }
    writeFileSync(REPORT!, JSON.stringify({ schema: 1, node: process.version, platform: process.platform, arch: process.arch,
      source: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: CLI_ROOT, encoding: 'utf8' }).trim(),
      baselineSha256: sha(BASE!), currentSha256: sha(current), count: COUNT, rounds: ROUNDS, warmup: WARMUP, samples }, null, 2))
  } finally {
    await Promise.allSettled(fixtures.map(async fixture => {
      fixture.phone.close(); fixture.window.close(); await fixture.world.close()
    }))
  }
}, 600_000)
