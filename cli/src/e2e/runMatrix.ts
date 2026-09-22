/**
 * runMatrix — CLI entry: the cronjob's action. Reads current vs latest for each engine, plans the
 * matrix runs, emits namespaced audit entries (argv + login/grid NOTIFYs + the planned smoke
 * checks per leg) and writes a report. The live journey is `harness e2e grid-switch`; the reviewer
 * (opencode `e2e-watchdog`) lives with the relay in autonomous-grid-cli and reads the run afterwards.
 *
 * Env:
 *   E2E_VERSION_SOURCE=mock|npm   (default mock until the real reader is validated)
 *   E2E_ENGINES=codex,claude      engines under test
 *
 * Dry-run: proves trigger + argv + naming + notify + the check plan with zero network/accounts;
 * every check is `not-run`. The live journey with real checks is `runGridSwitchTrace.ts`.
 *
 * Usage: npx tsx src/e2e/runMatrix.ts
 */
import { writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { AgentEngine } from '../engines/types.js'
import { versionSourceFromEnv } from './versionSource.js'
import { InstalledCurrentVersion, ENGINE_BIN } from './currentVersion.js'
import { planMatrixRuns } from './trigger.js'
import { buildMatrixEntry, type EngineStatus } from './matrix.js'
import { outDir } from './artifacts.js'

const execFileP = promisify(execFile)

const ENGINES: AgentEngine[] = (process.env.E2E_ENGINES ?? 'codex,claude')
  .split(',')
  .map((e) => e.trim() as AgentEngine)
  .filter(Boolean)

async function claudeLoggedIn(): Promise<boolean> {
  try {
    const { stdout } = await execFileP('claude', ['auth', 'status'], { timeout: 15_000 })
    return (JSON.parse(stdout) as { loggedIn?: boolean }).loggedIn === true
  } catch {
    return false
  }
}

function hasBinary(bin: string): boolean {
  // Hard to verify PATH without a shell tool here; report presence by the binary name only.
  return !!bin
}

async function statusOf(engine: AgentEngine): Promise<EngineStatus> {
  const bin = ENGINE_BIN[engine] ?? engine
  const binary = hasBinary(bin)
  let login = false
  if (binary) {
    switch (engine) {
      case 'codex':
        login = existsSync(join(process.env.HOME ?? '', '.codex', 'auth.json'))
        break
      case 'claude':
        // Not a file check: on macOS Claude Code keeps its login in the Keychain, so the only honest
        // answer is the tool's own (`claude auth status` → { loggedIn }).
        login = await claudeLoggedIn()
        break
      default:
        login = false
    }
  }
  return { binary, login, grid: true } // grid status filled by caller when it resolves
}

async function main(): Promise<number> {
  const source = versionSourceFromEnv()
  const current = new InstalledCurrentVersion()
  const plans = await planMatrixRuns(source, current, ENGINES)

  const toRun = plans.filter((p) => p.plan)
  console.log('=== trigger plan (current vs latest) ===')
  for (const p of plans) {
    console.log(`  ${p.engine.padEnd(8)} current=${String(p.current).padEnd(12)} latest=${String(p.latest).padEnd(12)} reason=${p.reason} run=${p.plan}`)
  }
  if (toRun.length === 0) {
    console.log('Nothing to run — all engines at latest.')
    return 0
  }

  const entries = []
  for (const plan of toRun) {
    const entry = await buildMatrixEntry(plan, {
      status: statusOf,
      grid: async () => null,
    })
    entries.push(entry)
  }

  const report = { generatedAt: new Date().toISOString(), mode: 'dry-run', engines: entries }
  const reportPath = join(outDir(), `report-${Date.now()}.json`)
  writeFileSync(reportPath, JSON.stringify(report, null, 2))
  console.log(`\nWrote report → ${reportPath}`)

  for (const e of entries) {
    console.log(`\n▶ ${e.session}`)
    console.log(`  status: ${JSON.stringify(e.status)}`)
    for (const n of e.notify) console.log(`  ⚠ NOTIFY: ${n}`)
    if ('error' in e.gridSpawn) {
      console.log(`  gridSpawn ERROR: ${e.gridSpawn.error} — ${e.gridSpawn.detail}`)
    } else {
      console.log(`  grid command: ${e.gridSpawn.command.join(' ')}`)
      console.log(`  grid env:     ${e.gridSpawn.envKeys.join(', ') || '(none)'}`)
      console.log(`  clearEnv:     ${e.gridSpawn.clearEnv.join(', ') || '(none)'}`)
    }
    console.log(`  checks:       ${e.legs.map((l) => `${l.leg}[${l.checks.map((c) => c.id).join(',')}]`).join(' → ')} (dry-run: not-run)`)
  }

  return 0
}

main().then((code) => process.exit(code))
