/** Whole registry load cost, including fresh catalog, root and final file proofs. Run alone. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const workload = process.argv[2] ?? 'single'
if (!['single', 'batch', 'many-homes'].includes(workload)) throw Error('Unknown workload')
const cli = process.env.BINDING_COST_CLI ?? resolve(import.meta.dirname, '../..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'binding-evidence-cost-')))
for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) process.env[name] = join(root, name)
process.env.CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
process.env.HARNESS_CONNECTIONS_PORT = '0'
const count = workload === 'single' ? 1 : 200, homeCount = workload === 'many-homes' ? 63 : 1
const data = process.env.ADAPTER_DATA_DIR!
mkdirSync(data, { mode: 0o700 })
try {
  const homes = Array.from({ length: homeCount }, (_, i) => join(root, `home-${i}`))
  for (const home of homes) mkdirSync(join(home, 'sessions'), { recursive: true })
  writeFileSync(join(data, 'engine-homes.json'), JSON.stringify({ codex: homes }), { mode: 0o600 })
  const rows = Array.from({ length: count }, (_, i) => {
    const id = `aaaaaaaa-1111-4222-8333-${String(i).padStart(12, '0')}`, home = homes[i % homeCount]!
    const transcriptPath = join(home, 'sessions', `rollout-${id}.jsonl`)
    writeFileSync(transcriptPath, JSON.stringify({ type: 'session_meta', payload: { id, cwd: root, source: 'cli' } }) + '\n', { mode: 0o600 })
    return { launcherId: `fixture-${i}`, engine: 'codex', sessionId: id, transcriptPath, tmuxPane: `%${i + 1}`,
      projectDir: 'fixture', cwd: root, processIdentity: null, registeredAt: 1, updatedAt: 1, lastHookAt: 1, lastTranscriptAt: 1 }
  })
  writeFileSync(join(data, 'registry.json'), JSON.stringify(rows), { mode: 0o600 })
  const { registry } = await import(pathToFileURL(join(cli, 'src/lib/registry.ts')).href)
  // Normalize the same legacy fixture before measuring unchanged complete v2 loads.
  registry.load()
  const expected = new Set(rows.map(row => row.sessionId))
  const outcomes: Record<string, number> = {}, latenciesMs: number[] = []
  const cpu = process.cpuUsage(), started = performance.now()
  for (let i = 0; i < 5; i++) {
    const before = performance.now(); registry.load(); latenciesMs.push(performance.now() - before)
    for (const row of registry.list()) {
      const result = row.identityHold ? 'held' : expected.has(row.sessionId) && row.transcriptPath ? 'complete' : 'wrong'
      outcomes[result] = (outcomes[result] ?? 0) + 1
    }
    if (registry.list().length !== count) throw Error('The measured load lost rows')
  }
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu)
  console.log(JSON.stringify({ workload, rows: count, homes: homeCount, iterations: 5, outcomes, latenciesMs, elapsedMs,
    cpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }))
} finally { rmSync(root, { recursive: true, force: true }) }
