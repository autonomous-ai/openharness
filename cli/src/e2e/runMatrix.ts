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
import { writeFileSync } from 'node:fs'
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

/**
 * Codex's own answer, not the presence of a file.
 *
 * `~/.codex/auth.json` existing proved nothing: on a machine whose codex was pointed at a grid, that
 * file holds `auth_mode: "apikey"` with a grid token, `codex login status` says "Logged in using an
 * API key - open_5fb***_grid", and every own-account turn comes back 401 from api.openai.com. A
 * matrix that called that "logged in" sent the run off to fail for a reason it had already been
 * told. The mode is carried out with the answer so the report can name it.
 */
async function codexLogin(): Promise<{ loggedIn: boolean; mode: string | null }> {
  try {
    const { stdout } = await execFileP('codex', ['login', 'status'], { timeout: 15_000 })
    const line = stdout.trim().split('\n')[0] ?? ''
    if (!/logged in/i.test(line)) return { loggedIn: false, mode: line || null }
    // An API key here is a key for api.openai.com. A grid token (`…_grid`) is not one, however much
    // it looks like a login — it is the one case that passes every offline check and still 401s.
    const apiKey = /api key/i.test(line)
    const gridKey = apiKey && /_grid\b/i.test(line)
    return { loggedIn: !gridKey, mode: gridKey ? `grid token in apikey mode (${line})` : apiKey ? 'apikey' : 'chatgpt' }
  } catch (err) {
    return { loggedIn: false, mode: `codex login status failed: ${(err as Error).message.split('\n')[0]}` }
  }
}

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
  let note: string | null = null
  if (binary) {
    switch (engine) {
      case 'codex': {
        const codex = await codexLogin()
        login = codex.loggedIn
        note = codex.mode
        break
      }
      case 'claude':
        // Not a file check: on macOS Claude Code keeps its login in the Keychain, so the only honest
        // answer is the tool's own (`claude auth status` → { loggedIn }).
        login = await claudeLoggedIn()
        break
      default:
        login = false
    }
  }
  // grid status filled by caller when it resolves
  return { binary, login, grid: true, ...(note ? { loginNote: note } : {}) }
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
