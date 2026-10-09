/** Fresh private native stores; no vendor binary, daemon, saved-home catalog or owner input. */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'
const root = realpathSync(mkdtempSync(join(tmpdir(), 'exact-resume-cost-')))
const workload = process.argv[2] ?? 'claude'
const cli = process.env.EXACT_COST_CLI ?? resolve(import.meta.dirname, '../..')
const id = 'aaaaaaaa-1111-4222-8333-444444444444'
const cwd = join(root, 'work')
for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR',
  'CODEX_HOME', 'CURSOR_HOME', 'COPILOT_HOME', 'GROK_HOME', 'AGY_HOME', 'PI_HOME', 'MUSE_HOME', 'COMMANDCODE_HOME',
  'HERMES_HOME', 'AMP_SESSIONS_DIR', 'OPENCODE_DATA_DIR', 'KILO_DATA_DIR', 'DEVIN_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
  process.env[name] = join(root, name)
}
process.env.CLAUDE_PROJECTS_DIR = join(process.env.CLAUDE_CONFIG_DIR!, 'projects')
try {
  mkdirSync(cwd)
  const engine = workload === 'claude' || workload === 'unavailable' ? 'claude' : workload === 'pi' ? 'pi' : 'codex'
  const folder = engine === 'claude' ? join(process.env.CLAUDE_PROJECTS_DIR!, 'work') : engine === 'codex'
    ? join(process.env.CODEX_HOME!, 'sessions', 'day') : join(process.env.PI_HOME!, 'agent', 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)
  mkdirSync(folder, { recursive: true })
  const filename = engine === 'claude' ? `${id}.jsonl` : `${engine === 'pi' ? 'day_' : 'rollout-'}${id}.jsonl`
  const header = JSON.stringify(engine === 'codex' ? { type: 'session_meta', payload: { id, cwd, source: 'cli' } }
    : engine === 'pi' ? { type: 'session', id, cwd } : { type: 'user', sessionId: id, cwd }) + '\n'
  writeFileSync(join(folder, filename), header)
  const unrelated = workload === 'populated' ? 1000 : workload === 'limit' ? 4200 : 0
  for (let i = 0; i < unrelated; i++) writeFileSync(join(folder, `unrelated-${i}.jsonl`), '{}\n')
  if (workload === 'duplicate') {
    const other = join(process.env.CODEX_HOME!, 'sessions', 'other'); mkdirSync(other)
    writeFileSync(join(other, filename), header)
  }
  const { findResumedTranscript } = await import(pathToFileURL(join(cli, 'src/lib/sessionRepair.ts')).href)
  if (workload === 'unavailable') {
    const moved = join(root, 'moved'); mkdirSync(moved); writeFileSync(join(moved, 'projects'), 'not a directory')
    const { adoptHomes } = await import(pathToFileURL(join(cli, 'src/lib/engineHomes.ts')).href)
    adoptHomes({ CLAUDE_CONFIG_DIR: moved })
  }
  const latenciesMs: number[] = [], outcomes: Record<string, number> = {}
  const cpu = process.cpuUsage()
  for (let i = 0; i < 10; i++) {
    const at = performance.now()
    let outcome: string
    try { outcome = await findResumedTranscript(engine, id, { cwd }) ? 'exact' : 'absent' }
    catch (error) {
      if ((error as { code?: string }).code !== 'IDENTITY_UNAVAILABLE') throw error
      outcome = 'held'
    }
    latenciesMs.push(Number((performance.now() - at).toFixed(2)))
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  const used = process.cpuUsage(cpu)
  console.log(JSON.stringify({ workload, iterations: 10, unrelated, outcomes, latenciesMs,
    cpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }))
} finally { rmSync(root, { recursive: true, force: true }) }
