/** SETUP_PERF=1 E2E_BUNDLE=1: run alone, against the same frozen baseline/candidate bundle workload. */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'
import { LocalClient } from './harness/client.js'
import { IsolatedDaemon } from './harness/daemon.js'
import { harnessdProcesses } from './harness/endurance.js'

const exec = promisify(execFile)
// ps reports hundredths of a CPU second: this window resolves 0.033 percentage points of one core.
const IDLE_MS = 30_000
const stats = (values: number[]) => {
  const ordered = [...values].sort((a, b) => a - b)
  return { n: values.length, medianMs: ordered[Math.floor(ordered.length / 2)], p95Ms: ordered[Math.ceil(ordered.length * 0.95) - 1], valuesMs: values }
}
const usage = async (pid: number) => {
  const { stdout } = await exec('ps', ['-p', String(pid), '-o', 'time=,rss='], { timeout: 2000 })
  const [time, rss] = stdout.trim().split(/\s+/)
  return { cpuSeconds: time!.split(':').reverse().reduce((total, part, index) => total + Number(part) * 60 ** index, 0), rssKiB: Number(rss) }
}

it.runIf(process.env.SETUP_PERF === '1')('measures cold setup, cached launch, core requests and input on a private daemon', async () => {
  const bundle = process.env.E2E_BUNDLE_PATH, report = process.env.SETUP_PERF_REPORT
  if (!bundle || !report) throw Error('SETUP_PERF requires a frozen E2E bundle and report path')
  const d = await IsolatedDaemon.create()
  let client: LocalClient | undefined
  try {
    // The same real executable file serves every launch, so help-cache behavior is measurable.
    const binary = d.env.CLAUDE_PATH!, probeLog = join(d.root, 'probe-invocations.jsonl')
    const shim = readFileSync(binary, 'utf8'), line = shim.indexOf('\n')
    writeFileSync(binary, shim.slice(0, line + 1) + `if (process.argv.includes('--help') || process.argv.includes('--version')) require('node:fs').appendFileSync(${JSON.stringify(probeLog)}, JSON.stringify({ pid: process.pid, parent: process.ppid, kind: process.argv.includes('--help') ? 'help' : 'version' })+'\\n');\n` + shim.slice(line + 1), { mode: 0o755 })
    await d.start(); const c = client = await LocalClient.connect(d), core = d.corePid()
    if (!core) throw Error('missing fixture core')
    const setupBefore = harnessdProcesses(d).has('engineSetup')
    const launch: number[] = [], agents: string[] = []
    for (let index = 0; index < 7; index++) {
      const cwd = join(d.projectsDir, `launch-${index}`); mkdirSync(cwd, { recursive: true })
      const start = performance.now()
      const result = await c.request('agent_create', { engine: 'claude', cwd, bypassPermission: true }, 90_000)
      launch.push(performance.now() - start)
      expect(result.error, JSON.stringify(result)).toBeUndefined(); agents.push(result.agent.id)
    }
    const requests: number[] = [], input: number[] = []
    for (let index = 0; index < 50; index++) {
      const start = performance.now(); expect((await c.request('agents_list', {})).error).toBeUndefined()
      requests.push(performance.now() - start)
    }
    for (let index = 0; index < 10; index++) {
      const content = `setup-perf-${index}`, agentId = agents[index % agents.length]!
      const ended = c.next(frame => frame.type === 'turn_ended' && frame.agentId === agentId, 30_000, content)
      const start = performance.now(); c.send('message', { agentId, content }); await ended
      input.push(performance.now() - start)
    }
    const first = await usage(core), at = performance.now()
    // This is the measurement interval, not synchronization or a correctness assertion.
    await new Promise<void>(done => setTimeout(done, IDLE_MS))
    const last = await usage(core), elapsed = performance.now() - at
    const probes = readFileSync(probeLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    writeFileSync(report, JSON.stringify({ schema: 1, node: process.version, platform: process.platform,
      bundleSha256: createHash('sha256').update(readFileSync(bundle)).digest('hex'), source: process.env.SETUP_PERF_SOURCE ?? null,
      workload: { agents: 7, cachedLaunches: 6, requests: 50, turns: 10, idleMs: IDLE_MS },
      setupBefore, setupAfter: harnessdProcesses(d).has('engineSetup'), coreStarts: d.coresStarted(),
      coldLaunchMs: launch[0], cachedLaunch: stats(launch.slice(1)), coreRequest: stats(requests), input: stats(input),
      idleCore: { durationMs: elapsed, cpuPercent: 100_000 * (last.cpuSeconds - first.cpuSeconds) / elapsed, rssKiB: last.rssKiB },
      probes: { help: probes.filter(probe => probe.kind === 'help').length, version: probes.filter(probe => probe.kind === 'version').length,
        fromCore: probes.filter(probe => probe.parent === core).length },
    }, null, 2) + '\n')
    expect(d.corePid()).toBe(core); expect(d.coresStarted()).toBe(1)
  } finally { client?.close(); await d.close() }
})
