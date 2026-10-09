/** Fresh private catalog workloads. No daemon, vendor binary or owner input. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const workload = process.argv[2] ?? 'empty'
const cli = process.env.CATALOG_COST_CLI ?? resolve(import.meta.dirname, '../..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'home-catalog-cost-')))
for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) process.env[name] = join(root, name)
process.env.CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
const data = process.env.ADAPTER_DATA_DIR!, file = join(data, 'engine-homes.json')
mkdirSync(data)
try {
  const homes = await import(pathToFileURL(join(cli, 'src/lib/engineHomes.ts')).href)
  const roots = homes.nativeSessionRoots ?? homes.sessionRoots
  const count = workload === 'eight' ? 8 : workload === 'full' || workload === 'large' ? 63 : 0
  const known = Array.from({ length: count }, (_, i) => join(root, `moved-${i}${workload === 'large' ? 'x'.repeat(940) : ''}`))
  const text = JSON.stringify({ claude: [], codex: known })
  if (workload !== 'empty') writeFileSync(file, text, { mode: 0o600 })
  if (workload === 'malformed') writeFileSync(file, '{')
  if (workload === 'oversized') writeFileSync(file, ' '.repeat(65537))
  if (workload === 'same-stamp') {
    const changed = JSON.stringify({ codex: [join(root, 'added')] })
    writeFileSync(file, '{"codex":[]}'.padEnd(changed.length, ' '))
    const at = new Date('2026-10-09T00:00:00Z'); utimesSync(file, at, at)
    roots('codex')
    writeFileSync(file, changed); utimesSync(file, at, at)
  }
  if (workload === 'unsaved') {
    chmodSync(data, 0o500)
    homes.adoptHomes({ CODEX_HOME: join(root, 'unsaved') })
    if (readFileSync(file, 'utf8') !== text) throw new Error('The private write-failure fixture was not effective')
  }
  const bytes = workload === 'empty' ? 0 : statSync(file).size
  const latenciesMs: number[] = [], outcomes: Record<string, number> = {}
  const cpu = process.cpuUsage()
  for (let i = 0; i < 25; i++) {
    const started = performance.now()
    let outcome: string
    try { outcome = `roots:${roots('codex').length}` }
    catch (error) {
      if ((error as { code?: string }).code !== 'IDENTITY_UNAVAILABLE') throw error
      outcome = 'held'
    }
    latenciesMs.push(Number((performance.now() - started).toFixed(4)))
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  const used = process.cpuUsage(cpu)
  console.log(JSON.stringify({ workload, iterations: 25, bytes, outcomes, latenciesMs,
    cpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }))
} finally { chmodSync(data, 0o700); rmSync(root, { recursive: true, force: true }) }
