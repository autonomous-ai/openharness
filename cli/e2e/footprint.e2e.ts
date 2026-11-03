/**
 * FOOTPRINT=1 E2E_BUNDLE=1: what the daemon costs in memory at idle, every process of it.
 *
 *     FOOTPRINT=1 E2E_BUNDLE=1 npx vitest run --config vitest.e2e.config.ts e2e/footprint.e2e.ts
 *
 * An isolated daemon from the run's bundle (as a release ships it), signed in to the fake backend, with two agents
 * (Claude Code and Codex) in one tab, measured once for each state of Agent Messages (FOOTPRINT_SCENARIOS, all three
 * by default): `on`, turned on for the account (Settings ▸ Experimental), and active (it has given both agents their
 * note); `off`, turned off; and `defaults`, never turned at all, as most accounts are (off). After a warm-up
 * (FOOTPRINT_WARMUP_SECONDS, 20) each stays idle for FOOTPRINT_SECONDS (30) while `ps` reads, every second, the
 * resident memory of every process under the master: the master (`harnessd`), the core (`harnessd-core`), each
 * service process (`harnessd-<name>`) and the engine workers. Each is named by its process title, or by the pid the
 * master logged it under. Reported per process as the mean over the window, and in total: a readable table on stdout
 * for each, and JSON of all of them to FOOTPRINT_REPORT when it is set. Processes that are not the daemon's own (a `ps`
 * the monitor ran at that moment) are listed apart and left out of the total.
 *
 * Measurement only, no limit: it was written to answer what Agent Messages costs in a process of its own against in
 * the edge host (2026-10-12). Run it on two builds on the same machine, one after the other, and compare.
 */
import { execFile, execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { cpus, platform, release, totalmem } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LocalClient } from './harness/client.js'
import { CLI_ROOT, IsolatedDaemon, until } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'
import { FakeBackend, type FakeMachine } from './harness/fakeBackend.js'

const ME: FakeMachine = { machineId: 'f0'.repeat(16), computerId: 'e2e-computer-0000-0000-0000000000f0', name: 'footprint', token: 'e2e-token-footprint' }
const MIB = 1024 * 1024
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms))

function knob(name: string, fallback: number, min: number, max: number): number {
  const n = Number(process.env[name] ?? fallback)
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${name} must be an integer from ${min} to ${max}`)
  return n
}

interface Row { pid: number; ppid: number; rssBytes: number; cpuSeconds: number; command: string }

/** `ps`'s cumulative CPU time, `[[dd-]hh:]mm:ss[.ss]`, in seconds. */
function cpuSeconds(time: string): number {
  const [days, clock] = time.includes('-') ? time.split('-') : ['0', time]
  return Number(days) * 86_400 + clock.split(':').reverse().reduce((sum, part, i) => sum + Number(part) * 60 ** i, 0)
}

/** Every process on the machine, as `ps` sees it: pid, parent, resident memory, CPU time so far and command line. */
const table = () => new Promise<Row[]>((done, fail) => {
  execFile('ps', ['-axo', 'pid=,ppid=,rss=,time=,command='], { timeout: 5_000, maxBuffer: 16 * MIB }, (error, stdout) => {
    if (error) { fail(error); return }
    done(String(stdout).split('\n').flatMap((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/.exec(line)
      return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), rssBytes: Number(match[3]) * 1024, cpuSeconds: cpuSeconds(match[4]),
        command: match[5].trim() }] : []
    }))
  })
})

/** The processes under [root], [root] included. */
function tree(rows: Row[], root: number): Row[] {
  const children = new Map<number, Row[]>()
  for (const row of rows) children.set(row.ppid, [...(children.get(row.ppid) ?? []), row])
  const found: Row[] = []
  const pending = rows.filter((row) => row.pid === root)
  while (pending.length) {
    const row = pending.pop()!
    found.push(row)
    pending.push(...(children.get(row.pid) ?? []))
  }
  return found
}

/**
 * What a process is called: its title (`harnessd`, `harnessd-core`, `harnessd-edge`…), which the master's hard links
 * give it in a release (harnessd/processName.ts) and a service sets itself (serviceProcess.ts); else the name the
 * master logged its pid under; else `other: <program>`.
 */
function nameOf(row: Row, logged: ReadonlyMap<number, string>): string {
  const program = basename(row.command.split(/\s+/)[0] ?? '')
  if (/^harnessd(-[\w-]+)?$/.test(program)) return program
  const known = logged.get(row.pid)
  if (known) return known === 'master' ? 'harnessd' : `harnessd-${known}`
  return `other: ${program}`
}

type Scenario = 'on' | 'off' | 'defaults'
const SCENARIOS: Record<Scenario, string> = {
  on: 'Agent Messages on for the account, active: both agents have their note',
  off: 'Agent Messages turned off for the account',
  defaults: 'never turned: every switch at its default (off)',
}
const chosen = (process.env.FOOTPRINT_SCENARIOS ?? 'on,off,defaults').split(',').map((name) => name.trim()).filter((name): name is Scenario => name in SCENARIOS)
/** CPU % of one core over the window: each pid's CPU time from its first sample to its last, summed, over the window's
 *  length. A pid seen once (born or gone in the window) adds nothing; null with no time to divide by. */
function cpuOver(samples: Array<Array<{ pid: number; cpuSeconds: number }>>, spanSeconds: number): number | null {
  const first = new Map<number, number>(), last = new Map<number, number>()
  for (const sample of samples) for (const p of sample) { if (!first.has(p.pid)) first.set(p.pid, p.cpuSeconds); last.set(p.pid, p.cpuSeconds) }
  const spent = [...last].reduce((sum, [pid, seconds]) => sum + seconds - first.get(pid)!, 0)
  return spanSeconds > 0 ? 100 * spent / spanSeconds : null
}

/** The median and the slowest of a few timed reads. */
function latency(times: number[]): { count: number; p50Ms: number | null; maxMs: number | null } {
  const sorted = [...times].sort((a, b) => a - b)
  return { count: sorted.length, p50Ms: sorted.length ? sorted[Math.floor((sorted.length - 1) / 2)]! : null, maxMs: sorted.at(-1) ?? null }
}

/** Every scenario measured in this run, written whole to FOOTPRINT_REPORT after each. */
const reports: Record<string, unknown> = {}

describe.runIf(process.env.FOOTPRINT === '1')('the daemon\'s memory at idle', () => {
  it.each(chosen)('reports every process\'s resident memory, and the total, with two agents in a tab: Agent Messages %s', async (scenario) => {
    const seconds = knob('FOOTPRINT_SECONDS', 30, 5, 3_600)
    const warmup = knob('FOOTPRINT_WARMUP_SECONDS', 20, 0, 600)
    const bundle = process.env.E2E_BUNDLE_PATH
    if (!bundle) throw new Error('FOOTPRINT requires E2E_BUNDLE=1: every process runs the bundle a release ships')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: CLI_ROOT, encoding: 'utf8', timeout: 5_000 }).trim()
    const backend = await FakeBackend.start()
    backend.addMachine(ME)
    let daemon: IsolatedDaemon | undefined
    let client: LocalClient | undefined
    try {
      const d = daemon = await IsolatedDaemon.create({ env: { BACKEND_WS_URL: backend.wsUrl, WEB_URL: backend.httpUrl, ADAPTER_COMPUTER_ID: ME.computerId } })
      writeFileSync(join(d.root, 'auth', 'session.json'), JSON.stringify({
        version: 1, accessToken: ME.token, autonomousEnv: 'prod', computerId: ME.computerId,
        machineId: ME.machineId, expiresAt: Date.now() + 30 * 24 * 3600_000, updatedAt: Date.now(), signInEpoch: 'e2e',
      }), { mode: 0o600 })
      // Turned as the person turns it, for the account the daemon keeps it for; never left to the default but in
      // `defaults`.
      if (scenario !== 'defaults') backend.experiments.agent_messages = scenario === 'on'
      await d.start()
      await until('signed in to the fake backend', () => backend.nodeUp(ME.machineId) || null, 60_000, 250)
      client = await LocalClient.connect(d, { machineId: ME.machineId })
      const agents: Array<Record<string, any>> = []
      for (const engine of ['claude', 'codex']) {
        const cwd = join(d.projectsDir, `footprint-${engine}`)
        mkdirSync(cwd, { recursive: true })
        const created = await client.request('agent_create', { engine, cwd, bypassPermission: true }, 90_000)
        expect(created.error, JSON.stringify(created)).toBeUndefined()
        agents.push(await until(`the ${engine} agent to bind its conversation`, async () => {
          const rows = (await client!.request<{ agents: Array<Record<string, any>> }>('agents_list', { includeStopped: true }, 30_000)).agents
          const agent = rows.find((row) => row.id === created.agent.id)
          return agent?.sessionId && agent.status === 'active' ? agent : null
        }, 60_000, 500))
      }
      // One tab holds both: on, Agent Messages reads it from the account and gives each its note.
      backend.agentMessages = { revision: 1, machines: [{ machineId: ME.machineId, name: ME.name }],
        tabs: [{ id: 'footprint', name: 'footprint', panes: agents.map((agent) => ({ machineId: ME.machineId, agentId: agent.id })) }] }
      if (scenario === 'on') {
        await until('Agent Messages to give both agents their note', () => {
          try {
            const state = JSON.parse(readFileSync(join(d.dataDir, 'agent-messages', 'state.json'), 'utf8')) as { notes: Record<string, unknown> }
            return Object.keys(state.notes).length === agents.length || null
          } catch { return null }
        }, 60_000, 500)
      }
      client.close()
      client = undefined
      await sleep(warmup * 1_000)

      const master = d.pid!
      const samples: Array<{ at: number; processes: Array<{ name: string; pid: number; rssBytes: number; cpuSeconds: number }> }> = []
      const backendReads = (path: string) => backend.seen.filter((line) => line.split('?')[0] === `GET ${path}`).length
      const reads = backendReads('/api/agent-messages'), experimentReads = backendReads('/api/experimental-settings')
      // Every FOOTPRINT_PROBE_SECONDS, a window's read of each through this daemon, as Desktop makes it: its latency.
      const probeEvery = knob('FOOTPRINT_PROBE_SECONDS', 30, 5, 600) * 1_000
      const probes: Record<string, number[]> = { '/api/agent-messages': [], '/api/experimental-settings': [] }
      let probedAt = 0
      const started = Date.now()
      while (Date.now() - started < seconds * 1_000) {
        const at = Date.now()
        const logged = new Map([...harnessdProcesses(d)].map(([name, pid]) => [pid, name] as const))
        samples.push({ at, processes: tree(await table(), master).map((row) => ({ name: nameOf(row, logged), pid: row.pid, rssBytes: row.rssBytes,
          cpuSeconds: row.cpuSeconds })) })
        if (at - probedAt >= probeEvery) {
          probedAt = at
          for (const path of Object.keys(probes)) {
            const sent = performance.now()
            const answer = await fetch(`http://127.0.0.1:${d.port}${path}`, { headers: d.localHeaders({ 'x-adapter-local': '1' }) })
            await answer.arrayBuffer()
            if (answer.ok) probes[path]!.push(performance.now() - sent)
          }
        }
        await sleep(Math.max(0, 1_000 - (Date.now() - at)))
      }
      expect(d.coresStarted(), 'the core never restarted while it was measured').toBe(1)

      const ours = (name: string) => name.startsWith('harnessd')
      const names = [...new Set(samples.flatMap((sample) => sample.processes.map((p) => p.name)))]
      const span = samples.length > 1 ? (samples.at(-1)!.at - samples[0]!.at) / 1_000 : 0
      const byName = names.map((name) => {
        const seen = samples.flatMap((sample) => sample.processes.filter((p) => p.name === name))
        const sums = samples.map((sample) => sample.processes.filter((p) => p.name === name).reduce((sum, p) => sum + p.rssBytes, 0)).filter((sum) => sum > 0)
        return {
          name, pids: [...new Set(seen.map((p) => p.pid))], samples: sums.length,
          rssMeanMiB: sums.length ? sums.reduce((a, b) => a + b, 0) / sums.length / MIB : 0,
          rssMaxMiB: sums.length ? Math.max(...sums) / MIB : 0,
          cpuPercent: cpuOver(samples.map((sample) => sample.processes.filter((p) => p.name === name)), span),
        }
      }).sort((a, b) => b.rssMeanMiB - a.rssMeanMiB)
      const totals = samples.map((sample) => sample.processes.filter((p) => ours(p.name)).reduce((sum, p) => sum + p.rssBytes, 0))
      const probed = Object.values(probes).reduce((sum, times) => sum + times.length, 0) / Object.keys(probes).length
      const report = {
        schema: 1, scenario, measuredAt: new Date(started).toISOString(),
        source: { commit: git('rev-parse', 'HEAD'), dirty: Boolean(git('status', '--porcelain')),
          bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex') },
        machine: { platform: platform(), release: release(), node: process.version, logicalCpus: cpus().length, cpu: cpus()[0]?.model, ramBytes: totalmem() },
        workload: { signedIn: true, agents: agents.map((agent) => agent.engine), tab: 'one tab, both agents', agentMessages: SCENARIOS[scenario], warmupSeconds: warmup, seconds, sampleEveryMs: 1_000 },
        // How often the daemon read the account's tabs and experiments while it was measured, on its own: the probes'
        // reads below are left out.
        tabReadsInWindow: backendReads('/api/agent-messages') - reads - probed,
        experimentReadsInWindow: backendReads('/api/experimental-settings') - experimentReads - probed,
        readLatencyMs: Object.fromEntries(Object.entries(probes).map(([path, times]) => [path, latency(times)])),
        processes: byName.filter((p) => ours(p.name)),
        others: byName.filter((p) => !ours(p.name)),
        total: { rssMeanMiB: totals.reduce((a, b) => a + b, 0) / totals.length / MIB, rssMaxMiB: Math.max(...totals) / MIB, samples: totals.length,
          cpuPercent: cpuOver(samples.map((sample) => sample.processes.filter((p) => ours(p.name))), span) },
      }
      expect(report.processes.map((p) => p.name)).toEqual(expect.arrayContaining(['harnessd', 'harnessd-core']))
      reports[scenario] = report
      if (process.env.FOOTPRINT_REPORT) {
        const file = resolve(process.env.FOOTPRINT_REPORT)
        mkdirSync(dirname(file), { recursive: true })
        writeFileSync(file, JSON.stringify(reports, null, 2) + '\n')
      }
      const width = Math.max(...report.processes.map((p) => p.name.length), 'total'.length) + 2
      const line = (name: string, mean: number, max: number, cpu: number | null, pids: string) =>
        `${name.padEnd(width)}${mean.toFixed(1).padStart(10)}${max.toFixed(1).padStart(10)}${(cpu === null ? '-' : cpu.toFixed(2)).padStart(8)}  ${pids}`
      const timed = (path: string) => { const l = report.readLatencyMs[path]!; return `${path} p50 ${l.p50Ms?.toFixed(1) ?? '-'} ms, max ${l.maxMs?.toFixed(1) ?? '-'} ms (${l.count})` }
      // Straight to stdout: the run's reporter keeps a passing test's console to itself.
      process.stdout.write([
        `FOOTPRINT ${scenario} · ${report.source.commit.slice(0, 10)}${report.source.dirty ? ' (dirty)' : ''} · ${SCENARIOS[scenario]}`,
        `${seconds} s idle after ${warmup} s · RSS MiB, mean and max · CPU % of one core · on its own the daemon read the tabs ${report.tabReadsInWindow} times and the experiments ${report.experimentReadsInWindow} times`,
        `reads through the daemon: ${timed('/api/agent-messages')}; ${timed('/api/experimental-settings')}`,
        `${'process'.padEnd(width)}${'mean'.padStart(10)}${'max'.padStart(10)}${'cpu %'.padStart(8)}  pid`,
        ...report.processes.map((p) => line(p.name, p.rssMeanMiB, p.rssMaxMiB, p.cpuPercent, p.pids.join(','))),
        line('total', report.total.rssMeanMiB, report.total.rssMaxMiB, report.total.cpuPercent, ''),
        ...(report.others.length ? [`not the daemon's own, left out: ${report.others.map((p) => `${p.name} (${p.samples} samples)`).join(', ')}`] : []),
      ].join('\n') + '\n\n')
    } finally {
      client?.close()
      await daemon?.close().catch(() => {})
      await backend.close()
    }
  }, 900_000)
})
