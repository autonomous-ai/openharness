/** Matched catalog work: fresh native proof, or a registry-sized batch of legacy bound-home lookups. */
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const workload = process.argv[2] ?? 'native-one'
if (!['native-one', 'native-full', 'registry-one', 'registry-full'].includes(workload)) throw Error('Unknown workload')
const cli = process.env.ADOPTION_COST_CLI ?? resolve(import.meta.dirname, '../..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'home-adoption-cost-')))
for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) process.env[name] = join(root, name)
process.env.CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
const data = process.env.ADAPTER_DATA_DIR!, file = join(data, 'engine-homes.json')
mkdirSync(data, { mode: 0o700 })
try {
  const count = workload.endsWith('full') ? 63 : 1
  const known = Array.from({ length: count }, (_, i) => join(root, `moved-${i}`))
  // Both implementations see the same homes. The former reader ignores the new immutable records.
  writeFileSync(file, JSON.stringify({ claude: [], codex: known }), { mode: 0o600 })
  mkdirSync(file + '.adoptions', { mode: 0o700 }); mkdirSync(file + '.confirmations', { mode: 0o700 })
  let previous: string | null = null
  for (const [index, home] of known.entries()) {
    const number = String(index).padStart(3, '0')
    const text = JSON.stringify({ version: 1, previous, legacyRequired: true, homes: { claude: [], codex: [home] } }) + '\n'
    const hash = createHash('sha256').update(text).digest('hex')
    writeFileSync(join(file + '.adoptions', number + '.json'), text, { mode: 0o600 })
    writeFileSync(index ? join(file + '.confirmations', number + '.committed') : file + '.adopted', hash + '\n', { mode: 0o600 })
    previous = hash
  }
  const homes = await import(pathToFileURL(join(cli, 'src/lib/engineHomes.ts')).href)
  const iterations = workload.startsWith('registry') ? 200 : 25
  const latenciesMs: number[] = [], outcomes: Record<string, number> = {}
  const cpu = process.cpuUsage(), started = performance.now()
  const snapshot = workload.startsWith('registry') ? homes.engineHomeSnapshot?.() : undefined
  for (let i = 0; i < iterations; i++) {
    const before = performance.now()
    let outcome: string
    try {
      if (workload.startsWith('native')) outcome = homes.nativeSessionRoots('codex').length === count + 1 ? 'complete' : 'wrong'
      else {
        const home = known[i % count]
        outcome = homes.sessionCodexHome({ transcriptPath: join(home, 'sessions', `row-${i}.jsonl`) }, snapshot) === home ? 'complete' : 'wrong'
      }
    } catch (error) { if ((error as { code?: string }).code !== 'IDENTITY_UNAVAILABLE') throw error; outcome = 'held' }
    latenciesMs.push(Number((performance.now() - before).toFixed(4)))
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  snapshot?.verify()
  const elapsedMs = performance.now() - started, used = process.cpuUsage(cpu)
  console.log(JSON.stringify({ workload, records: count, iterations, outcomes, latenciesMs, elapsedMs,
    cpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }))
} finally { rmSync(root, { recursive: true, force: true }) }
