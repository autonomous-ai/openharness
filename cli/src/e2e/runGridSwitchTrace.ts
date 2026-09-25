/**
 * Run the grid-switch journey for REAL: create a fresh agent through the daemon (like "New agent"
 * in the app), run it subscription -> grid -> back home with the scenario on every leg, delete
 * it, and leave a review bundle the `e2e-watchdog` agent (autonomous-grid-cli, e2e/) reads.
 *
 *   agent_create   — a new codex/claude in its own tmux pane, in a scratch folder; nobody's pane is borrowed
 *   subscription   — checks on it as it is (its own login): the baseline
 *   grid           — agent_retarget onto a grid model (pane respawned, session resumed), checks again
 *   agent_delete   — gone at the end, unless E2E_KEEP_AGENT=1 (the reviewer, autonomous-grid-cli's
 *                    e2e-watchdog, reads the bundle afterwards; keep the agent when it should type into the pane)
 *
 * Usage (zero-config; everything is read from this machine's harness install):
 *   harness e2e grid-switch            (or: npx tsx src/e2e/runGridSwitchTrace.ts)
 *
 * Env (all optional):
 *   HARNESS_ENGINE=codex|claude      engine under test (default codex)
 *   HARNESS_GRID_MODEL / HARNESS_GRID_NAME   pin the grid model (default: smallest listed — pin the fastest
 *                                            one from `grid stats <grid> --verbose` when it matters)
 *   HARNESS_AGENT_ID + HARNESS_PANE_ID       reuse an existing agent instead of creating one (not deleted)
 *   HARNESS_PORT / HARNESS_MACHINE_ID        override what env.ts / computer-id say
 *   E2E_GRID_HOME + E2E_GRID_NAME (+ E2E_GRID_CONTROL_PLANE_URL)   move onto a grid from ANOTHER grid home —
 *                                            a local relay checkout under test — instead of the daemon's own
 *   E2E_KEEP_AGENT=1                         leave the created agent running for inspection
 *
 * The daemon is the one `harness` started (`ws://127.0.0.1:${PORT}/api/local-ws`) — the exact
 * transport and commands the desktop app uses.
 */
import { mkdirSync, realpathSync, writeFileSync, cpSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { GridSwitchDriver, pickGridModel, type GridSwitchTraceStep } from './gridSwitchDriver.js'
import { probeLeg, realTmux, waitForPaneSettle } from './paneProbe.js'
import { firstStuck, plannedLegs, quotaHit, LEGS, type LegOutcome, type LogKind } from './smokeChecks.js'

const LAST_LEG = LEGS[LEGS.length - 1]
import { prepareWorkspace, readLog, readWorkspaceFile, removeCodexMcp, preAcceptClaudeBypassMode } from './workspace.js'
import { sessionName, workspaceDirName } from './sessionName.js'
import { TESTCASE } from './matrix.js'
import { outDir, runDir } from './artifacts.js'
import { env } from '../config/env.js'
import { daemonUrl, machineId, waitForPane, gridOverrideFromEnv } from './harnessLocal.js'
import { parseVersionLine } from './currentVersion.js'
import { preTrustClaudeProject, preTrustCodexProject } from '../lib/claudeTrust.js'
import { useByRef } from './sessionTools.js'

const execFileP = promisify(execFile)

function mkdirAll(dir: string): string {
  mkdirSync(dir, { recursive: true })
  return dir
}

export interface GridSwitchRunResult {
  session: string
  reportPath: string
  runDir: string
  stuck: ReturnType<typeof firstStuck>
  error: string | null
}

/**
 * The live journey, as a function: `harness e2e grid-switch` and the cron runner call this; the
 * env described at the top of this file is the only configuration.
 */
export async function runGridSwitch(): Promise<GridSwitchRunResult> {
const engine = process.env.HARNESS_ENGINE ?? 'codex'
const url = daemonUrl()
const machine = await machineId()
const version = await (async () => {
  try {
    const { stdout } = await execFileP(engine, ['--version'], { timeout: 10_000 })
    return parseVersionLine(stdout) ?? 'UNKNOWN'
  } catch {
    return 'UNKNOWN'
  }
})()

console.error(`[grid-e2e] dialing ${url} · machine ${machine} · ${engine} ${version}`)

const legs: LegOutcome[] = []
const planned = plannedLegs()
let pane: string | null = process.env.HARNESS_PANE_ID ?? null
let workspace: string | null = null
// A subscription model answers in seconds; a local model on a grid may take a minute. Only the
// grid leg gets the long budget, so a stuck check on the tool's own login is known in 45s, not 90.
const CHECK_TIMEOUT_MS: Record<LegOutcome['leg'], number> = { subscription: 120_000, grid: 120_000 }

async function checks(leg: LegOutcome['leg']): Promise<void> {
  const readLogs = workspace ? (kind: LogKind) => readLog(workspace!, kind) : undefined
  const readFile = workspace ? (rel: string) => readWorkspaceFile(workspace!, rel) : undefined
  const outcome = pane
    ? await probeLeg(realTmux, pane, leg, { engine, checkTimeoutMs: CHECK_TIMEOUT_MS[leg], ...(readLogs ? { readLog: readLogs } : {}), ...(readFile ? { readFile } : {}) })
    : planned.find((l) => l.leg === leg)!
  legs.push(outcome)
  console.error(`[grid-e2e] ${leg}: ${outcome.checks.map((c) => `${c.id}=${c.status}`).join(' ')}${outcome.dialogs ? ` (answered: ${outcome.dialogs.join(', ')})` : ''}`)
  // The marker shows before the tool's turn is fully over (hooks still reporting); a retarget on a
  // turn in flight is refused AGENT_BUSY. Let the pane go quiet first, the way a person would —
  // but only when a retarget follows: after the last leg the agent is deleted, not moved.
  if (pane && leg !== LAST_LEG) {
    await waitForPaneSettle(realTmux, pane, { settleMs: 3_000, settleTimeoutMs: 60_000 })
    await new Promise((r) => setTimeout(r, 3_000))
  }
}

const driver = new GridSwitchDriver(url, machine)
let trace: GridSwitchTraceStep[] = []
let gridModel: string | null = null
let agentId: string | null = process.env.HARNESS_AGENT_ID ?? null
// codex's MCP server is registered globally (`codex mcp add`, see workspace.ts). Tracked so the run
// removes exactly what it added, and removes it even when the run stops early.
let registeredCodexMcp = false
// How the MCP server got registered for this engine, and in which permission mode the agent runs —
// both in the trace, because an MCP step that never fired is read very differently once you know
// the server was never registered or the engine was launched in a mode that refuses it.
let mcpSetup: { config: string | null; note: string } | null = null
const permissionMode = process.env.E2E_PERMISSION_MODE ?? 'full'
const created = !agentId
let error: string | null = null
// Named before anything runs so the scratch folder and the trace share it; the grid model is
// stamped on once known.
const startedAt = new Date()
try {
  await driver.machineSelect()

  // Which grid and model — settled BEFORE the agent exists, and asked of the daemon only when the
  // run did not pin them. `grid_models_list` starts one Python `grid` per grid the account can see,
  // all at once (~125 MB each); on grid-dev that was ten of them, 1.2 GB, landing while claude
  // started, and the 1.5 GB container OOM-killed claude. Pinned (HARNESS_GRID_NAME +
  // HARNESS_GRID_MODEL, or a relay under test), the list is never needed; unpinned, it is asked
  // while nothing else is running.
  // A relay under test (E2E_GRID_HOME + E2E_GRID_NAME) replaces the daemon's own grid; the model
  // then has to be pinned (HARNESS_GRID_MODEL), since that grid's list is not in `grid_models_list`.
  const local = await gridOverrideFromEnv()
  const pinned = !!process.env.HARNESS_GRID_MODEL && (!!process.env.HARNESS_GRID_NAME || !!local)
  const models = pinned ? null : await driver.gridModels()
  const picked = local || !models ? null : pickGridModel(models)
  gridModel = process.env.HARNESS_GRID_MODEL ?? picked?.model ?? null
  const gridName = local ? local.name : (process.env.HARNESS_GRID_NAME ?? (process.env.HARNESS_GRID_MODEL ? undefined : picked?.gridName))
  console.error(`[grid-e2e] grid model: ${gridModel ?? '(none)'}${gridName ? ` on ${gridName}` : ''}${local ? ` (relay under test: ${local.override.baseUrl})` : ''}${pinned ? ' (pinned — no model list asked)' : ''}`)

  if (created) {
    // realpath: $TMPDIR is a symlink on macOS (`/var/…` → `/private/var/…`) and the engine keys its
    // trust on the resolved path — a trust written for the symlink is never matched.
    const cwd = realpathSync(mkdirAll(join(outDir(), 'agents', workspaceDirName(sessionName({ engine, version, testcase: TESTCASE, at: startedAt })))))
    // The person's project: a script tool, an MCP server registered for this engine, and their logs.
    const laid = prepareWorkspace(cwd, engine)
    workspace = cwd
    console.error(`[grid-e2e] workspace ${cwd} · tool ${laid.tool} · mcp ${laid.mcpConfig ?? '(none)'} — ${laid.mcpNote}`)
    // codex's registration is global (`codex mcp add`), so it is this run's to take back out.
    if (engine === 'codex' && laid.mcpConfig) registeredCodexMcp = true
    mcpSetup = { config: laid.mcpConfig, note: laid.mcpNote }
    // The scratch folder is this run's own, so answer the engine's "trust this folder?" the way the
    // daemon does for a workspace it made — otherwise the first check would be typed into that dialog.
    try {
      if (engine === 'claude') {
        preTrustClaudeProject(cwd)
        // `full` means `--dangerously-skip-permissions`, and an interactive claude meets that with a
        // warning whose default answer exits the engine. Accept it here, before the pane exists.
        if (permissionMode === 'full') console.error(`[grid-e2e] bypass-permissions warning: ${preAcceptClaudeBypassMode()}`)
      }
      if (engine === 'codex') preTrustCodexProject(cwd)
    } catch (err) {
      console.error(`[grid-e2e] pre-trust ${cwd}: ${(err as Error).message}`)
    }
    // `full` unless someone deliberately narrows it: see gridSwitchDriver.createAgent for why the
    // MCP steps depend on it.
    // REGISTRATION_FAILED right after the daemon starts is not the test's to report: the saved
    // registry still holds an agent from before the restart (a container, a reboot), tmux numbers
    // the new pane %0 again, and the stale row owns that key until discovery confirms it gone —
    // measured on grid-dev: refused at 07:41:11, the stale row forgotten at 07:41:20. Wait it out.
    let made = await driver.createAgent(engine, cwd, `e2e ${engine} ${version}`, permissionMode)
    for (let retry = 1; !made.ok && made.error === 'REGISTRATION_FAILED' && retry <= 3; retry++) {
      console.error(`[grid-e2e] agent_create REGISTRATION_FAILED — a stale agent from before the daemon restart still holds the pane; retry ${retry}/3 in 15s`)
      await new Promise((r) => setTimeout(r, 15_000))
      made = await driver.createAgent(engine, cwd, `e2e ${engine} ${version}`, permissionMode)
    }
    if (!made.ok) throw new Error(`${made.error}: ${made.detail ?? ''}`)
    agentId = made.agentId
    pane = made.pane ?? (await waitForPane(agentId))
    console.error(`[grid-e2e] created agent ${agentId}${pane ? ` in pane ${pane}` : ' (pane not registered yet: checks not-run)'}`)
    // A fresh codex/claude has a trust / first-run screen before its prompt; let it draw.
    if (pane) await waitForPaneSettle(realTmux, pane, { settleMs: 3_000, settleTimeoutMs: 90_000 })
  }


  // Out of usage ends the journey where it happened: an account that cannot answer on its own login
  // tells us nothing about a switch, and switching it anyway only spends the grid's time too.
  await checks('subscription')
  if (!quotaHit(legs)) {
    if (!gridModel) throw new Error('GRID_UNAVAILABLE: grid_models_list returned no model')
    const onto = await driver.retargetToGrid(agentId!, gridModel, gridName, local?.override)
    if (!onto.ok) throw new Error(`${onto.error}: ${onto.detail ?? ''}`)
    await checks('grid')
  }

} catch (err) {
  error = (err as Error).message
  console.error(`[grid-e2e] stopped: ${error}`)
} finally {
  trace = [...driver.trace]
}

// How each step got done, and by which model: read from the engine's own session file now that the
// run is over. Reported, never judged — a step's pass/fail is its result on disk (smokeChecks.ts).
if (workspace) {
  const refs = legs.flatMap((l) => l.checks.map((c) => c.ref).filter((r): r is string => !!r))
  const used = useByRef(engine, workspace, refs)
  for (const l of legs) for (const c of l.checks) {
    const u = c.ref ? used[c.ref] : undefined
    if (u) { c.tools = u.tools; c.models = u.models }
  }
}

const session = sessionName({ engine, version, testcase: TESTCASE, gridModel: gridModel ?? undefined, at: startedAt })
const report = {
  generatedAt: new Date().toISOString(),
  mode: 'live',
  engines: [
    {
      engine,
      session,
      version,
      testcase: TESTCASE,
      gridModel,
      agentId,
      pane,
      /** The folder the agent worked in: tools/calc.sh, the MCP config, and .e2e/*.log with every tool/MCP call. */
      workspace,
      /** The mode the engine was launched in. `full` is what lets claude call an MCP tool at all. */
      permissionMode,
      /** Where this engine's MCP server was registered, and how — null config means the MCP steps could not pass. */
      mcp: mcpSetup,
      /** true: this run made the agent. It stays alive through the review (so the reviewer can type into the pane), then is deleted unless E2E_KEEP_AGENT=1. */
      createdByRun: created,
      keptAlive: !created || process.env.E2E_KEEP_AGENT === '1',
      notify: error ? [error] : [],
      /** Set when the tool said its account is out of usage: { leg, check, resets }. The pipeline
       *  reads this before anything else — no review, one plain message, and a retry later. */
      quota: quotaHit(legs),
      // Every leg, run or not, so a table built from this always has its three rows.
      legs: [...legs, ...planned.filter((p) => !legs.some((l) => l.leg === p.leg))],
      trace,
    },
  ],
}
// The durable review bundle: everything a person (or the watchdog, later) needs to look back at this run.
const bundle = runDir(session)
const reportPath = join(bundle, 'trace.json')
;(report.engines[0] as Record<string, unknown>).runDir = bundle
writeFileSync(reportPath, JSON.stringify(report, null, 2))
if (workspace) {
  for (const rel of ['tools', '.e2e', '.codex', '.mcp.json']) {
    const src = join(workspace, rel)
    if (existsSync(src)) cpSync(src, join(bundle, 'workspace', rel), { recursive: true })
  }
}

for (const step of trace) {
  console.log(`\n▶ ${step.step}`)
  console.log(`  request: ${JSON.stringify(step.request)}`)
  console.log(`  reply:   ${JSON.stringify(step.reply)}`)
}
const stuck = firstStuck(legs)
console.log(`\n=== ${session} ===`)
console.log(stuck ? `STUCK AT ${stuck.leg} / ${stuck.check} (${stuck.status})` : error ? `STOPPED: ${error}` : 'clean')
console.log(`Wrote trace → ${reportPath}`)

// Everything to look back at: the daemon's own lines for this agent, the watchdog's raw events, and
// a manifest that says how to reopen each piece.
try {
  const daemonLog = join(env.ADAPTER_DATA_DIR, 'harness.log')
  if (existsSync(daemonLog) && agentId) {
    const short = agentId.slice(0, 8)
    const lines = readFileSync(daemonLog, 'utf8').split('\n').filter((l) => l.includes(agentId!) || l.includes(short))
    // The [turn]/[hooks]/[recap] lines are keyed by the ENGINE session id; find it from the attach line.
    const sid = /session=([0-9a-f]{8})/.exec(lines.join('\n'))?.[1]
    const all = sid ? readFileSync(daemonLog, 'utf8').split('\n').filter((l) => l.includes(agentId!) || l.includes(short) || l.includes(sid)) : lines
    writeFileSync(join(bundle, 'daemon.log'), all.join('\n') + '\n')
  }
} catch (err) {
  console.error(`[grid-e2e] daemon log slice: ${(err as Error).message}`)
}
writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({
  session,
  engine,
  version,
  agentId,
  pane,
  workspace,
  gridModel,
  reportPath,
  // Filled by the reviewer's runner (autonomous-grid-cli e2e/run.sh): { model, sessionID, reopen }.
  watchdog: null,
  files: { trace: 'trace.json', daemonLog: 'daemon.log', watchdogEvents: 'watchdog.jsonl', watchdogReview: 'watchdog.md', workspace: 'workspace/', evidence: 'evidence/' },
  generatedAt: new Date().toISOString(),
}, null, 2))
console.log(`Review bundle → ${bundle}`)

// The run is over; the agent this run made can go. Kept only on request — for a person, or for the
// reviewer to type into the pane (E2E_KEEP_AGENT=1; delete it in the app afterwards).
if (created && agentId && process.env.E2E_KEEP_AGENT !== '1') {
  try {
    await driver.deleteAgent(agentId)
    console.log(`Deleted agent ${agentId}${pane ? ` (pane ${pane})` : ''}`)
  } catch (err) {
    console.log(`Could not delete agent ${agentId}: ${(err as Error).message} — delete it in the app`)
  }
} else if (created && agentId) {
  console.log(`Kept agent ${agentId}${pane ? ` in pane ${pane}` : ''} (E2E_KEEP_AGENT=1)`)
}
// Take the global codex entry back out. Not when the agent is being kept: someone who asked to keep
// the pane wants to type into it, and an agent whose MCP server has been unregistered is not the
// agent the run left behind.
if (registeredCodexMcp && process.env.E2E_KEEP_AGENT !== '1') {
  console.log(removeCodexMcp() ? 'Unregistered the codex MCP server' : 'Could not unregister the codex MCP server — remove it with `codex mcp remove e2e_calc`')
}
driver.close()
return { session, reportPath, runDir: bundle, stuck, error }
}

// `npx tsx src/e2e/runGridSwitchTrace.ts` still works; `harness e2e grid-switch` is the same call.
if (process.argv[1] && /runGridSwitchTrace\.(ts|js)$/.test(process.argv[1])) {
  runGridSwitch().then((r) => process.exit(r.error || r.stuck ? 1 : 0))
}
