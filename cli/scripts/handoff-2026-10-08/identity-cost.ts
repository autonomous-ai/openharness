/** Run unchanged against both source trees with node --import tsx. Private native fixtures only. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

const root = mkdtempSync(join(tmpdir(), 'identity-cost-'))
const workload = process.argv[2] ?? 'pool'
if (!['pool', 'process', 'limit', 'homes'].includes(workload)) throw new Error('Unknown workload')
const home = join(root, 'claude')
const cwd = join(root, 'workspace')
mkdirSync(cwd)
Object.assign(process.env, { HOME: join(root, 'home'), ADAPTER_DATA_DIR: join(root, 'data'),
  CLAUDE_PROJECTS_DIR: join(home, 'projects'), CLAUDE_CONFIG_DIR: home, CODEX_HOME: join(root, 'codex'),
  HARNESS_CONNECTIONS_PORT: '0', TZ: 'UTC' })
const put = (path: string, text: string) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, text) }
const started = Math.floor(Date.now() / 1000) * 1000
const id = '11111111-2222-4333-8444-555555555555'
const count = workload === 'limit' ? 420 : 160
for (let i = 0; i < count; i++) put(join(home, 'projects', `project-${i % 10}`, `${i === 0 ? id : `other-${i}`}.jsonl`),
  JSON.stringify({ cwd: i === 0 ? cwd : join(root, `other-${i}`), isSidechain: false }) + '\n' + 'x'.repeat(8192))
if ((workload === 'process' || workload === 'homes')) put(join(home, 'sessions', '77.json'), JSON.stringify({ pid: 77,
  procStart: new Date(started).toISOString(), cwd, sessionId: id }))
if (workload === 'homes') put(join(root, 'data', 'engine-homes.json'), JSON.stringify({
  claude: Array.from({ length: 63 }, (_, i) => join(root, `missing-home-${i}`)),
}))
try {
  const { findLiveSession } = await import('../../src/lib/sessionRepair.js')
  const cpu = process.cpuUsage()
  const latencies: number[] = []
  const outcomes: Record<string, number> = {}
  for (let i = 0; i < 10; i++) {
    const begin = performance.now()
    let outcome: string
    try {
      const found = await findLiveSession('claude', cwd, started, (workload === 'process' || workload === 'homes') ? { pid: 77 } : { bornOnly: true })
      outcome = found?.sessionId === id ? 'exact' : found ? 'other' : 'absent'
    } catch (error) { outcome = (error as { code?: string }).code === 'IDENTITY_UNAVAILABLE' ? 'held' : 'error' }
    latencies.push(Math.round((performance.now() - begin) * 100) / 100)
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  const used = process.cpuUsage(cpu)
  console.log(JSON.stringify({ workload, files: count, iterations: 10, outcomes, latenciesMs: latencies,
    cpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }))
} finally { rmSync(root, { recursive: true, force: true }) }
