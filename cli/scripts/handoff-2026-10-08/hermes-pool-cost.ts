/** Identical private stores on former and current production; no host engine, process or daemon. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'
const root = mkdtempSync(join(tmpdir(), 'hermes-pool-cost-'))
const workload = process.argv[2] ?? 'single'
const home = join(root, 'hermes'), cwd = join(root, 'work')
for (const name of ['HOME', 'ADAPTER_DATA_DIR', 'ADAPTER_RUNTIME_DIR', 'CLAUDE_CONFIG_DIR', 'CLAUDE_PROJECTS_DIR',
  'CODEX_HOME', 'CURSOR_HOME', 'COPILOT_HOME', 'GROK_HOME', 'AGY_HOME', 'PI_HOME', 'MUSE_HOME', 'COMMANDCODE_HOME',
  'AMP_SESSIONS_DIR', 'OPENCODE_DATA_DIR', 'KILO_DATA_DIR', 'DEVIN_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME']) {
  process.env[name] = join(root, name)
}
process.env.HERMES_HOME = home
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as {
  DatabaseSync: new (path: string) => { exec(sql: string): void; prepare(sql: string): { run(...args: unknown[]): void }; close(): void }
}
try {
  mkdirSync(cwd)
  const count = workload === 'single' ? 1 : workload === 'limit' ? 66 : 33
  for (let i = 0; i < count; i++) {
    const folder = i ? join(home, 'profiles', `profile-${String(i).padStart(3, '0')}`) : home
    mkdirSync(folder, { recursive: true })
    const path = join(folder, 'state.db')
    if (workload === 'unavailable' && i === count - 1) { writeFileSync(path, 'unavailable store'); continue }
    const db = new DatabaseSync(path)
    db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY, cwd TEXT, started_at REAL, source TEXT)')
    if (i === 0) db.prepare("INSERT INTO sessions VALUES (?, ?, ?, 'cli')").run('20261009_120000_abcd', cwd, 1791547200)
    db.close()
  }
  const { findLiveSession } = await import('../../src/lib/sessionRepair.js')
  const latenciesMs: number[] = [], outcomes: Record<string, number> = {}
  const cpu = process.cpuUsage()
  for (let i = 0; i < 10; i++) {
    const at = performance.now()
    let outcome: string
    try { outcome = await findLiveSession('hermes', cwd, 1791547140000) ? 'exact' : 'absent' }
    catch (error) {
      if ((error as { code?: string }).code !== 'IDENTITY_UNAVAILABLE') throw error
      outcome = 'held'
    }
    latenciesMs.push(Number((performance.now() - at).toFixed(2)))
    outcomes[outcome] = (outcomes[outcome] ?? 0) + 1
  }
  const used = process.cpuUsage(cpu)
  console.log(JSON.stringify({ workload, stores: count, iterations: 10, outcomes, latenciesMs,
    cpuMs: (used.user + used.system) / 1000, peakRssMiB: process.resourceUsage().maxRSS / 1024,
    node: process.version, platform: process.platform, arch: process.arch }))
  ;(await import('../../src/lib/sqliteBuiltin.js')).closeSqliteHandles()
} finally { rmSync(root, { recursive: true, force: true }) }
