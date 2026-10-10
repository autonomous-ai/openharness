/** Matched native descriptor lookup, private process and homes only; no daemon or input. */
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

const workload = process.argv[2] ?? 'one'
if (!['one', 'duplicate', 'competing'].includes(workload)) throw Error('Unknown workload')
const cli = process.env.NATIVE_COST_CLI ?? resolve(import.meta.dirname, '../..')
const root = realpathSync(mkdtempSync(join(tmpdir(), 'native-descriptor-cost-')))
for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CODEX_HOME', 'CLAUDE_CONFIG_DIR']) process.env[name] = join(root, name)
process.env.CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
const cwd = join(root, 'workspace'), home = join(process.env.CODEX_HOME!, 'sessions')
mkdirSync(cwd); mkdirSync(home, { recursive: true })
if (process.env.HARNESS_PROCESS_IMAGES_ARTIFACT) {
  const artifact = JSON.parse(readFileSync(process.env.HARNESS_PROCESS_IMAGES_ARTIFACT, 'utf8'))
  Object.assign(globalThis, { __DARWIN_PROCESS_IMAGES__: JSON.stringify({ schema: 1, size: artifact.size, sha256: artifact.sha256, base64: artifact.base64 }) })
}
const files = [1, 2].map(n => {
  const id = `aaaaaaaa-1111-4222-8333-${String(n).padStart(12, '0')}`
  const path = join(home, 'day', `rollout-${id}.jsonl`)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify({ type: 'session_meta', payload: { id, cwd, source: 'cli' } }) + '\n')
  return path
})
const held = workload === 'competing' ? files : workload === 'duplicate' ? [files[0], files[0]] : [files[0]]
const code = `const fs = require('node:fs'); const fds = ${JSON.stringify(held)}.map(path => fs.openSync(path, 'r')); process.title = 'codex'; process.stdout.write('ready\\n'); setTimeout(() => process.exit(0), 30_000);`
const child = spawn(process.execPath, ['-e', code], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'pipe'] })
try {
  await Promise.race([once(child.stdout!, 'data'), once(child, 'exit').then(() => { throw Error('Private fixture did not become ready') })])
  const { openFileSessionOf } = await import(pathToFileURL(join(cli, 'src/lib/sessionRepair.ts')).href)
  const latenciesMs: number[] = [], outcomes: Record<string, number> = {}, holds: string[] = []
  const cpu = process.cpuUsage()
  for (let i = 0; i < 5; i++) {
    const started = performance.now()
    let outcome: string
    try { outcome = (await openFileSessionOf('codex', child.pid!, home, cwd))?.sessionId ? 'bound' : 'empty' }
    catch (error) { if ((error as { code?: string }).code !== 'IDENTITY_UNAVAILABLE') throw error; outcome = 'held'; holds.push((error as Error).message) }
    latenciesMs.push(Number((performance.now() - started).toFixed(4)))
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  const used = process.cpuUsage(cpu)
  console.log(JSON.stringify({ workload, iterations: 5, outcomes, holds, latenciesMs,
    cpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }))
} finally {
  if (child.exitCode === null && child.signalCode === null) { child.kill(); await once(child, 'exit') }
  rmSync(root, { recursive: true, force: true })
}
