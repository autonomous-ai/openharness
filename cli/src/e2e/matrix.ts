/**
 * matrix — turn a planned trigger run into a concrete, auditable matrix entry: the exact spawn
 * argv (from the harness's real builders), the login/grid presence NOTIFYs, and a namespaced
 * session for every artifact. A matrix run is "the real test" — subscription -> grid -> back home.
 *
 * `--dry-run` (default) does everything except touch a live agent: it builds argv, checks
 * login/grid availability, names the session, and emits the report. It is the $0 offline path that
 * still proves the trigger + argv + naming + notify decision. Live switching adds a daemon + agent.
 */
import { type GridLaunchOverride, parseGridLaunchOverride } from '../lib/gridLaunch.js'
import type { AgentEngine } from '../engines/types.js'
import { gridSpawn, backHomeSpawn } from './gridArgv.js'
import { sessionName } from './sessionName.js'
import type { PlannedRun } from './trigger.js'
import { SUBSCRIPTION_MODEL } from './fixedModels.js'
import { plannedLegs, type LegOutcome } from './smokeChecks.js'
import type { GridSwitchTraceStep } from './gridSwitchDriver.js'

/** A placeholder override for dry-run: proves the argv builder without a real grid endpoint. */
export function probeGridOverride(): GridLaunchOverride {
  const raw = parseGridLaunchOverride({
    networkId: 'grid-probe',
    networkName: 'probe-grid',
    baseUrl: 'https://grid.invalid/probe/relay/v1',
    apiKey: 'probe-key',
    model: 'grid:gpt-5-mini',
  })
  return raw.state === 'ok' ? raw.override : (undefined as never)
}

export interface EngineStatus {
  binary: boolean
  login: boolean
  grid: boolean
}

export interface MatrixEntry {
  engine: AgentEngine
  session: string
  version: string
  testcase: string
  gridModel: string | null
  gridSpawn: { command: string[]; envKeys: string[]; clearEnv: string[] } | { error: string; detail: string }
  backHome: { command: string[]; clearEnv: string[] }
  /** Fixed model used for the real subscription round-trip leg (per user decision). */
  subscriptionModel: string | null
  status: EngineStatus
  notify: string[]
  /**
   * The smoke checks per leg (tool / mcp / recall on subscription, grid, back-home).
   * Dry run: every check `not-run`. Live (`runGridSwitchTrace.ts`): the real outcomes + pane tails.
   */
  legs: LegOutcome[]
  /** Live runs only: the daemon exchanges, in order. */
  trace?: GridSwitchTraceStep[]
}

export const TESTCASE = 'grid-switch'

export interface MatrixDeps {
  status: (engine: AgentEngine) => Promise<EngineStatus>
  grid: () => Promise<GridLaunchOverride | null> // null -> no grid resolved (live) -> NOTIFY
  at?: Date
}

const dryGrid = probeGridOverride()

/**
 * Build one dry-run audit entry for a planned run. Live switching (daemon + agent) is layered on
 * top of the same argv/session/status later; this is the decision + spawn + notify surface.
 */
export async function buildMatrixEntry(plan: PlannedRun, deps: MatrixDeps): Promise<MatrixEntry> {
  const session = sessionName({
    engine: plan.engine,
    version: plan.latest ?? 'UNKNOWN',
    testcase: TESTCASE,
    gridModel: plan.latest ? dryGrid.model : undefined,
    at: deps.at,
  })
  const status = await deps.status(plan.engine)
  const notify: string[] = []

  if (!status.binary) notify.push('ENGINE_MISSING: binary not found')
  if (!status.login) notify.push('NOT_LOGGED_IN: engine needs a subscription login')
  if (!status.grid) notify.push('GRID_UNAVAILABLE: machine not signed in to a grid (or no model)')

  const grid = (await deps.grid()) ?? dryGrid
  const build = gridSpawn(plan.engine, grid, 'SESSION_PLACEHOLDER')
  const backHome = backHomeSpawn(plan.engine, 'SESSION_PLACEHOLDER')

  const spawnResult: MatrixEntry['gridSpawn'] = isSpawnError(build)
    ? { error: build.error, detail: build.detail }
    : {
        command: build.command,
        envKeys: Object.keys(build.env),
        clearEnv: build.clearEnv,
      }

  return {
    engine: plan.engine,
    session,
    version: plan.latest ?? 'UNKNOWN',
    testcase: TESTCASE,
    gridModel: dryGrid.model ?? null,
    gridSpawn: spawnResult,
    backHome: { command: backHome.command, clearEnv: backHome.clearEnv },
    subscriptionModel: SUBSCRIPTION_MODEL[plan.engine] ?? null,
    status,
    notify,
    legs: plannedLegs(),
  }
}

function isSpawnError(spec: Awaited<ReturnType<typeof gridSpawn>>): spec is { ok: false; error: string; detail: string } {
  return 'ok' in spec && spec.ok === false
}
