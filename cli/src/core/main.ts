/**
 * The core's entry: `harness __run`. `runForeground` is the composition root, which builds the core's
 * modules, starts the services through `serviceHost` and wires them to the socket
 * (cli/AGENTS.md). It moved here from cli.ts verbatim, with what only it uses, so that the core's process
 * is measured from its own entry rather than from the CLI's (docs/design/2026-10-06-core-boundary-next.md,
 * step 1); `src/architecture.spec.ts` walks the imports from this file and holds them to a budget.
 *
 * cli.ts stays the process's entry and the CLI: it parses the command and, for `__run` (and a start under tsx,
 * or `start -f` with `HARNESS_NO_MASTER=1`), calls in here. `start -f` runs harnessd's master, which starts
 * the core with `__run`.
 */
import { ensureBundledCoreHarnesses } from '../dsh/builtins.js'
import { createDeviceStore, deviceStoreAgents } from '../lib/autonomous-device/storeRuntime.js'
import { runningDevicePart, startDevicePart } from '../lib/autonomous-device/parts.js'
import { readFileSync, writeFileSync, openSync, existsSync, rmSync, statSync } from 'fs'
import { join } from 'path'
import { execFile, spawn, spawnSync } from 'child_process'
import { createServer, type Server } from 'http'
import { homedir, hostname } from 'os'
import { env } from '../config/env.js'
import { VERSION } from '../version.js'
import { sqlitePreflightMessage } from '../lib/sqliteAvailability.js'
import { warmLoginShellEnvironment } from '../lib/loginShellEnv.js'
import { DialLog } from '../cable/dialLog.js'
import { CableSession } from '../cable/cableSession.js'
import { CableFleet, testDialDiscovery } from '../cable/cableFleet.js'
import { DialVerdicts } from '../cable/dialPortVerdicts.js'
import { DaemonCableHost, cableEventFor, cableQuestionFor, cableQuestionCloseFor } from '../cable/cableHost.js'
import { terminalActivity } from '../cable/terminalActivity.js'
import { MachineListCache, withStaleMarker } from '../device/machineList.js'
import { registry, projectDisplayName, validTranscriptPath, type RegisteredSession } from '../lib/registry.js'
import { engineSessionTitle } from '../lib/sessionTitle.js'
import { machineNames } from '../lib/machineNames.js'
import { installCodexHooks } from '../lib/hooks.js'
import { DAEMON_LOG_FILE, PID_FILE, daemonPort, isAlive, readPid, LEGACY_LOG_FILE, MACHINE_NAME_FILE, tildify, computerId, thisDeviceLabel } from '../lib/daemonState.js'
import { clearSafeModeMarker, runBootHandoff, safeModeDisposition, safeModeStatusBody, SafeModeRequest, writeSafeModeMarker } from '../lib/daemonSafeMode.js'
import { awakeTimeout } from '../lib/sleepAware.js'
import { removePidFileIf, onError } from '../lib/daemonLaunch.js'
import { describeSpawnLockOwner, withSpawnLock } from '../lib/daemonSpawnLock.js'
import { ensureTmuxOnPath } from '../lib/tmuxOnPath.js'
import { AUTH_DIR, AuthSessionError, AuthSessionManager, clearAuthSession, ensureSignInEpoch, readAuthSession, signInOf, type AuthSession } from '../lib/authSession.js'
import { ENGINES, enginePathOverride } from '../lib/engineBin.js'
import { isTerminalEngine } from '../engines/types.js'
import { engineInstallRecipe } from '../lib/engineInstall.js'
import { buildEngineLaunchArgv } from '../lib/engineLaunch.js'
import { workspaceMissing } from '../lib/workspaceCheck.js'
import { type GridLaunchMachine } from '../lib/gridLaunch.js'
import { HERMES_SYSTEM_MANAGED_DIR } from '../lib/gridWebMcp.js'
import { writeGridConfigDir } from '../lib/gridConfigDir.js'
import { tmuxSupportsSessionEnv } from '../lib/tmuxVersion.js'
import { clearDeleted, isRecentlyDeleted, markDeleted } from '../lib/deletedSessions.js'
import { claudeProcessSession, findLiveSession, findResumedTranscript } from '../lib/sessionRepair.js'
import { handoffProviderDeps } from '../lib/handoffDiscovery.js'
import { TmuxBackend } from '../lib/tmuxBackend.js'
import { DEFAULT_HOST_THEME, loadHostTheme, saveHostTheme, type HostTheme } from '../lib/hostTheme.js'
import { restoreAgents, tmuxSurvey } from '../lib/restoreAgents.js'
import { createRetainExitedSession } from '../lib/retainExitedSession.js'
import { createKeepAbandonedConversation } from '../lib/keepAbandonedConversation.js'
import { OpenTabProtection } from '../lib/openTabProtection.js'
import { sessionCheckpoints } from '../lib/sessionCheckpoint.js'
import { repairClaudeCwd } from '../lib/cwdRepair.js'
import { stoppedAgents } from '../lib/stoppedAgents.js'
import { prepareAgentHandoff } from '../lib/agentHandoff.js'
import { ExternalSessions, OpenSessions } from '../lib/sessionSearch/external.js'
import { externalProviders } from '../lib/sessionSearch/externals/index.js'
import { type LaunchOverridesDeps } from '../lib/launchOverrides.js'
import { buildHarnessSessionLabel } from '../lib/harnessSessionLabel.js'
import { adoptLegacyHarnessSessions, listTmuxPanes } from '../lib/tmuxAgentDiscovery.js'
import { installedDsh, invalidateInstalledDsh } from '../dsh/installed.js'
import { prepareHarnessLaunch } from '../dsh/runtime.js'
import { ApiConnections } from '../lib/apiConnections.js'
import { rememberSavedApis } from '../lib/apiModels.js'
import { prepareApiInstructions } from '../lib/apiInstructions.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { AgentGridTarget, GridAnnotation } from '../lib/gridAnnotation.js'
import { clearPaneRemainOnExit, lookupPaneEngineProcess, resolvePaneEngineProcess, tmuxPaneInfo, tmuxPaneState } from '../lib/tmux.js'
import { ALL_TERMINAL_BACKENDS } from '../config/terminalConfig.js'
import { TerminalBackendCoordinator } from '../lib/terminalBackendCoordinator.js'
import { TerminalStreamManager } from '../lib/terminalStreamManager.js'
import { terminalRouteKey, terminalRuntimeLabel } from '../lib/terminalRuntime.js'
import { probeTerminalAgents } from '../lib/terminalAgentDiscovery.js'
import { RECONCILE_PASS_DEADLINE_MS, TerminalAgentReconciler } from '../lib/terminalAgentReconciler.js'
import { Watcher } from '../watcher/watcher.js'
import { startHookServer } from '../hookServer.js'
import { connectToMaster } from '../harnessd/coreLink.js'
import { createTerminalOpener } from './terminals/open.js'
import { SHELL_REQUESTS, startShell } from '../services/shell.js'
import { createTerminalControl } from './terminals/control.js'
import { createTerminalRequests } from './terminals/requests.js'
import { createAgentEvents } from './agents/events.js'
import { createSessionNormalizers } from './transcripts/normalizers.js'
import { createInput } from './input.js'
import { createQuestions } from './questions.js'
import { createTurnActivity } from './turns/activity.js'
import { createLastTurnReader } from './transcripts/lastTurn.js'
import { createRecaps } from './turns/recaps.js'
import { createUpdateHandoff, probeStagedMaster, probeVerdict } from './updateHandoff.js'
import { createHeartbeats } from './turns/heartbeats.js'
import { createEventFunnel, outsideConsumers } from './turns/funnel.js'
import { createAgyBackstop } from './turns/agyBackstop.js'
import { createIngest } from './transcripts/ingest.js'
import { createTurnHooks } from './turns/turnHooks.js'
import { createAttach } from './transcripts/attach.js'
import { createHistory } from './transcripts/history.js'
import { createRelaunchMarks, transcriptSize } from './transcripts/relaunch.js'
import { createForgetSession } from './agents/forget.js'
import { createBinding } from './agents/bind.js'
import { createDiscoveryHandlers } from './agents/discovery.js'
import { createLaunchHelpers } from './agents/launch.js'
import { createCancel, createCancelRequest } from './turns/cancel.js'
import { createPaneWatcher } from './agents/newPane.js'
import { createAdoption } from './agents/adopt.js'
import { createAgentCreator } from './agents/create.js'
import { createAgentForker } from './agents/fork.js'
import { createPaneSwap } from './agents/swap.js'
import { createAgentRetargeter } from './agents/retarget.js'
import { createAgentRestarter } from './agents/restart.js'
import { createAgentLifecycle, createPurgeRequest, createStopRequest } from './agents/lifecycle.js'
import { createAgentClosing, createCloseRequests } from './agents/close.js'
import { createHandoffRequest } from './agents/handoff.js'
import { createLaunchRequests } from './agents/launches.js'
import { createAgentList } from './agents/list.js'
import { createAgentUpdate } from './agents/update.js'
import { createEngineHooks, installEngineHooks } from './engines/hooks.js'
import { createCursorTaskHooks } from './engines/cursorTasks.js'
import { databaseHistory } from './transcripts/databaseHistory.js'
import { createCoreApi, emptyPorts, EXPERIMENTS, FLEET_FALLBACKS, LONG_ANSWERS, MODELS_FALLBACKS, MODELS_OFF, MODELS_REQUESTS, MONITOR_FALLBACKS, MONITOR_OFF, MONITOR_REQUESTS, ORCHESTRATOR_FALLBACKS, ORCHESTRATOR_REQUESTS, SHARE_REQUESTS, SHARING_FALLBACKS, PROJECTS_REQUESTS, SEARCH_FALLBACKS, SEARCH_REQUESTS, STORE_REQUESTS, TEAMS_FALLBACKS, TEAMS_REQUESTS, USAGE_REQUESTS, VIEWERS_FALLBACKS, WORKSPACES_FALLBACKS, type GatewayAccount, type GatewayOps, type GatewayStatus, type TeamsPort } from './api.js'
import { createServiceHost, testFaults } from './serviceHost.js'
import { startStalls } from './stall.js'
import { createServiceLinks, type ServiceLinks } from './serviceLinks.js'
import { createViewersLink } from './viewersLink.js'
import { createWorkspacesLink } from './workspacesLink.js'
import { createMonitorLink } from './monitorLink.js'
import { createStoreLink } from './storeLink.js'
import { createModelsLink } from './modelsLink.js'
import { answerAgentQuery } from './agentQueries.js'
import { createDeliveries } from './deliveries.js'
import { createTerminalWatch } from './terminalWatch.js'
import { createSharingLink } from './sharingLink.js'
import { createExperimentHooks, wakeExperiments } from './experiments.js'
import { answerExperimentQuery, createForExperiment } from './experimentQueries.js'
import { createOrchestratorLink } from './orchestratorLink.js'
import { daemonCommand } from '../lib/daemonCommand.js'
import { KNOWN_SERVICES, servicesTheMasterRuns } from '../harnessd/services.js'
import { createTeamsLink, teamsOutOfProcess } from './teamsLink.js'
import { startFleet } from '../services/fleet.js'
import { CORE_EXIT_STOP, CORE_EXIT_UPDATE, PROBE_COMMAND, PROBE_TIMEOUT_MS } from '../harnessd/protocol.js'
import { localSocketPath, refuseServedDataFolder, type LocalSocketServer } from '../lib/localSocket.js'
import { saveDaemonPort } from '../lib/daemonEndpoint.js'
import { publishHookRoute } from '../lib/hookRoutes.js'
import { commandBarService } from '../lib/commandBar.js'
import { BackendSocket, isLocalClientId } from '../backendSocket.js'
import { createGatewayLink, laneOf } from './gatewayLink.js'
import { AutonomousDeviceService } from '../lib/autonomous-device/service.js'
import { autonomousDeviceLocalRequest } from '../lib/autonomous-device/localApi.js'
import { attachLocalWsServer, LOCAL_WS_PATH, LOCAL_WS_PROTOCOL_VERSION } from '../localWsServer.js'
import { createWindowRouter } from '../cable/windowRoute.js'
import { WindowSelection } from '../cable/windowSelection.js'
import { WindowVisit } from '../cable/windowVisit.js'
import { WindowForm } from '../cable/windowForm.js'
import { TERMINAL_BINARY_VERSION } from '../lib/terminalBinary.js'
import { setVoiceRouterDeviceConnected, setVoiceRouterSessions, shutdownVoiceRouter } from '../lib/voiceRouter.js'
import { isLoopbackRequest, loopbackHosts } from '../lib/loopbackRequest.js'
import { startSelfUpdater, restore as restoreUpdate, DOWNLOAD_LIMITS, type Poller } from '../lib/selfUpdate.js'
import { managedNodePath } from '../lib/nodeRuntime.js'
import { startTuiUpdater } from '../tui/update.js'
import { type ActivityFrame } from '../lib/turnActivity.js'
import { CursorTranscriptDiscovery } from '../engines/cursor/discovery.js'
import { cursorDataDir } from '../engines/cursor/home.js'
import { loadCursorPendingTasks } from '../engines/cursor/pendingTasks.js'
import { opencodeMajorVersion } from '../engines/opencode/version.js'
import { hermesDbForSession } from '../lib/hermesHome.js'
import { TranscriptPager } from '../lib/transcriptPages.js'
import { AgentCreationReceipts } from '../lib/agentCreationReceipt.js'
import { agentFrame, lastActivityAt, type AgentFrame } from '../lib/agentFrame.js'
import { forgetAgentProject } from '../lib/agentProject.js'
import { agentTokenUsage } from '../lib/agentTokenUsage.js'
import { DeviceResultJournal } from '../lib/autonomous-device/resultJournal.js'
import { adaptSlashCommand } from '../lib/goalCommand.js'
import { RuntimeProfileManager, type RuntimeModelOption } from '../lib/runtimeProfile.js'
import { RuntimeProfileController } from '../lib/runtimeProfileController.js'
import { installTimestampedConsole, sid, prepareLogFile, trimLogFile, LOG_CHECK_INTERVAL_MS } from '../lib/log.js'
import { PROXY_BACKEND_TIMEOUT_MS, GRID_MINT_TIMEOUT_MS, backendHttpBase, postJson, controlPlaneAuth } from '../lib/controlPlane.js'

// Daemon stdout/stderr. Capped at LOG_MAX_BYTES — see prepareLogFile/trimLogFile in lib/log.ts.
const LOG_FILE = DAEMON_LOG_FILE

/** Pairing labels that stand in for a name rather than being one (manager.ts `addPaired` callers). */
const GENERIC_PAIR_LABELS: ReadonlySet<string> = new Set(['harness link', 'browser'])

/** The name a new terminal tile greets with: the machine's display name the backend gave it, else the host's. */
function terminalHintMachineName(): string {
  try { return readFileSync(MACHINE_NAME_FILE, 'utf-8').trim() || hostname() } catch { return hostname() }
}

/** The name the dial's wheel and the fleet give this computer: its display name, else "This machine". */
function dialMachineName(): string {
  try { return readFileSync(MACHINE_NAME_FILE, 'utf8').trim() || 'This machine' } catch { return 'This machine' }
}

// The dial's session, held at module scope for the same reason `backendRef` is: shutdown() is defined
// before the wiring that creates it, and the port has to be released on the way out.
let cableRef: CableFleet | null = null

/** The same object the session holds — module scope so the recap gates can ask which machine is selected
 *  without threading it through every constructor between here and there. */
let cableHostRef: DaemonCableHost | null = null

/**
 * The window's tiles, in tile order, as last reported.
 *
 * Kept HERE rather than only handed to the cable host, because the window can
 * report them before that host exists: the local websocket server is listening
 * long before the cable is wired up, and a daemon restart has the app
 * reconnecting into that window. The roster is only re-sent when it CHANGES, so
 * one early report used to leave the dial's ring flat and edgeless for as long
 * as the tiles held still — which looks exactly like the feature not being
 * installed, and cost most of a morning proving otherwise.
 */
let appPaneAgents: string[] = []

/**
 * The window's tabs, kept for the same reason: a window can connect while this daemon is still
 * booting (the app no longer waits for its first scan), and an `app_swarms` that lands before the
 * cable host exists was dropped — the dial then had no tab, drew "Choose a pane" and took no swipe
 * or voice until the window happened to send its tabs again (measured 2026-10-01: 80 s).
 */
let appSwarmsLatest: Parameters<DaemonCableHost['setSwarms']>[0] = null

// OpenCode's SQLite store — polled per session by OpencodeReader (no per-session transcript file).
const OPENCODE_DB = join(env.OPENCODE_DATA_DIR, 'opencode.db')

// Kilo's SQLite store — same shape, its own file and its own reader (see engines/kilo/).
const KILO_DB = join(env.KILO_DATA_DIR, 'kilo.db')

// Hermes keeps every surface's history in one SQLite store PER HOME — polled per session by
// HermesReader, against the home that session lives in (`hermesDbForSession`; `hermes -p <name>` has
// its own). Reading one fixed store is what left profile agents' activity empty (openharness#191).
// Devin likewise keeps all history in one SQLite store (WAL) — polled per session by DevinReader.
const DEVIN_DB = join(env.DEVIN_HOME, 'sessions.db')

/** How many agents' histories are read at once — the first reconcile pass after a boot asks for every
 *  agent's, and each read is a tmux probe, a `ps`, and the whole transcript or store (see `attaches`). */
const ATTACH_CONCURRENCY = 4

/** The currently-running script — dist/cli.js when built, src/cli.ts under tsx. Named by cli.ts, the
 *  process's entry, as it starts the core: under tsx this module's own URL is src/core/main.ts. */
let SCRIPT_PATH = ''

/**
 * Start harnessd's master, detached, on the bundle on disk, and name it in the pid file: how a core on its
 * own hands the machine to a newer build (core/updateHandoff.ts); the master judges it. Named at once, so a
 * `harness start` in the seconds after this core leaves finds a live daemon and starts no second master,
 * whose core would lose to this one's and roll the update back. Not `harness start`'s `spawnDaemon`, which
 * finds THIS daemon in the pid file and exits. The managed Node is re-read, so a runtime provisioned while
 * this ran is the master's. `ADAPTER_UPDATED_TO` (an older build's handoff) and `HARNESSD_SAFE_MODE` (a
 * master's word to its own core) are not for the master to pass to every core it starts.
 */
function startMasterHere(): void {
  // A log that cannot be opened (a full disk) costs the master's lines, never the handoff.
  let log: number | 'ignore' = 'ignore'
  try {
    prepareLogFile(LOG_FILE, LEGACY_LOG_FILE)
    log = openSync(LOG_FILE, 'a')
  } catch (e) { console.error('[update] the master starts without the log:', e instanceof Error ? e.message : e) }
  const { ADAPTER_UPDATED_TO: _handedOver, HARNESSD_SAFE_MODE: _safeMode, ...inherited } = process.env
  const master = spawn(managedNodePath(), [SCRIPT_PATH, '__harnessd'], { detached: true, env: inherited, stdio: ['ignore', log, log] })
  // A spawn failure (e.g. EMFILE) emits 'error' on the child; with no listener that is an
  // uncaughtException. This core is leaving either way, and the next `harness start` starts the daemon.
  master.on('error', (e) => console.error('[update] master spawn error:', e instanceof Error ? e.message : e))
  master.unref()
  try {
    if (master.pid) writeFileSync(PID_FILE, `${master.pid}\n`)
    else removePidFileIf(process.pid)
  } catch { /* the master claims it itself once its core has bound */ }
  console.log(`[update] harnessd's master started (pid ${master.pid ?? '?'})`)
}

/**
 * What a staged update does while the daemon is still starting up — and the little the boot needs to
 * know about itself to do it.
 *
 * The self-updater is started in `runForeground`'s prologue, before anything that can throw or hang,
 * because a daemon that cannot finish booting is a daemon that can never be fixed: there is no
 * supervisor, and the desktop app only re-runs `harness start` on the same broken bytes, once a
 * minute, for ever. Its `onStaged` therefore has to mean something LONG before `restartForUpdate`
 * exists — hence the indirection: `applyStagedUpdate` is `bootHandoff` until the body has built
 * everything `restartForUpdate` tears down, and is swapped for it at that one line.
 */
/** This process's channel to a harnessd master, when one started it (see harnessd/coreLink.ts).
 *  Inert otherwise: a daemon run on its own claims its pid file and hands off updates itself. */
const coreLink = connectToMaster()

const daemonBoot: {
  updater: Poller | null
  tuiUpdater: Poller | null
  /** The hook server, once bound — the only thing a mid-boot handoff has to release. */
  hookServer: Server | null
  /** Its Unix-socket twin (lib/localSocket.ts), when one could be opened. Read by `/api/status`. */
  localSocket: LocalSocketServer | null
  /** Set by the body so a failed boot can flip its own `/api/status` to not-ready. */
  markNotReady: ((reason: string) => void) | null
  /** Why this daemon is in safe mode, or null while it is healthy. Read by `/api/status`. */
  safeMode: string | null
  handingOff: boolean
  applyStagedUpdate: (version: string) => void | Promise<void>
  /** Opens the request gate of a start-up that did not finish, so its clients are answered (safe mode). */
  openRequests: (() => void) | null
} = { updater: null, tuiUpdater: null, hookServer: null, localSocket: null, markNotReady: null, safeMode: null, handingOff: false, applyStagedUpdate: bootHandoff, openRequests: null }

/**
 * Hand the machine to a newer build without finishing start-up.
 *
 * SYNCHRONOUS END TO END, and that is the whole safety argument: never awaiting means the half-built
 * `runForeground` body cannot interleave between the port closing and the exit, so it can never
 * reach the code that would bind the port the successor is about to take, and two daemons are
 * impossible by construction. That is also why it does not wait for the master to claim the pid file the
 * way `restartForUpdate` does — waiting would leave this process running alongside the new core, both
 * reconciling tmux and writing the registry.
 *
 * Without a master it spawns one rather than merely exiting, because on a machine with no desktop app
 * nothing else would ever start the successor, and even with one the next spawn window is up to ~70s
 * away. The master judges the update it starts on (core/updateHandoff.ts); the core this once spawned
 * instead ran it unjudged.
 */
function bootHandoff(version: string): void {
  if (daemonBoot.handingOff) return
  daemonBoot.handingOff = true
  daemonBoot.tuiUpdater?.stop()
  if (coreLink.supervised) {
    // The master starts the new bundle the moment this exits, and rolls it back if it does not stay
    // up; a successor spawned from here would be a daemon outside its supervision.
    console.log(`[update] ${VERSION} → ${version} staged during start-up — handing back to harnessd`)
    try { daemonBoot.hookServer?.close() } catch { /* already gone */ }
    try { daemonBoot.localSocket?.closeSync() } catch { /* already gone */ }
    process.exit(CORE_EXIT_UPDATE)
  }
  runBootHandoff(VERSION, version, {
    // The hook port has no fallback: a successor that cannot bind it is a daemon that does not come up.
    closeServer: () => {
      try { (daemonBoot.hookServer as unknown as { closeAllConnections?: () => void } | null)?.closeAllConnections?.() } catch { /* already gone */ }
      try { daemonBoot.hookServer?.close() } catch { /* already gone */ }
      try { daemonBoot.localSocket?.closeSync() } catch { /* already gone */ }
    },
    // Synchronous, as all of this is: start-up has not finished, and has nothing to serve meanwhile.
    probeMaster: () => {
      const probe = spawnSync(managedNodePath(), [SCRIPT_PATH, PROBE_COMMAND], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS })
      return probeVerdict(probe.error ?? (probe.status === 0 ? null : new Error(probe.signal ? `signal ${probe.signal}` : `exit ${probe.status}`)), probe.stdout ?? '')
    },
    rollBack: () => restoreUpdate(env.ADAPTER_CLI_DIR),
    startMaster: startMasterHere,
    exit: (code) => process.exit(code),
    log: (message) => console.log(message),
  })
}

/** Set by runForeground once the DSH companions exist; a frame projected before that carries none. */
let activityFrameContextRef: ((s: RegisteredSession) => ActivityFrame | null) | null = null

let dshFrameContextRef: ((s: RegisteredSession) => AgentDshContext | null) | null = null

/** Set by runForeground once models can be asked: what an agent's frame says of its grid. */
let gridAnnotationRef: ((grid: AgentGridTarget) => GridAnnotation | null) | null = null

function projectFrame(s: RegisteredSession, selectedModel: string | null): Promise<AgentFrame> {
  return agentFrame(s, {
    tokenUsage: agentTokenUsage.get(s),
    selectedModel,
    terminalAvailable: registry.terminalAvailable(s.agentId),
    dsh: dshFrameContextRef?.(s) ?? null,
    activity: () => activityFrameContextRef?.(s) ?? null,
    gridAnnotation: (grid) => gridAnnotationRef?.(grid) ?? null,
  })
}

function primaryTerminalLabel(session: RegisteredSession): string {
  const runtime = session.runtimes.find((candidate) => terminalRouteKey(candidate) === session.primaryRuntimeKey)
  return runtime ? terminalRuntimeLabel(runtime) : 'dormant'
}

/** The daemon body: hooks + watcher + process discovery + backend socket. */
async function runForeground(session: AuthSession | null): Promise<void> {
  installTimestampedConsole() // daemon-only: every harness.log line gets a wall-clock timestamp
  const startedAt = Date.now()
  // Set when the restore pass could not run. The reconciler reads it at call time (its deps are built
  // long before this is decided) and keeps rows it would otherwise retire — see `onRemoved`.
  // Restore did not run this boot (every row), or could not look at these rows (core/agents/discovery.ts).
  let restoreFailed = false
  const restoreUnsurveyed = new Set<string>()
  let discoveryReady = false
  let discoveryError: string | null = null
  // How a boot that failed AFTER this server bound turns its own status not-ready: the app reads
  // `discoveryReady: false` as "alive, not ready" and stops respawning over it (`enterSafeMode`).
  daemonBoot.markNotReady = (reason) => { discoveryReady = false; discoveryError = reason }

  // The pid file is claimed further down, the moment the control port is bound — not here, and not
  // by whoever spawned us. See the comment at that claim.

  // Last-resort net: a stray throw in ANY long-lived callback (a malformed JSONL line, a hostile backend
  // frame, a timer) must NEVER take the daemon down — there is no supervisor. Log it and keep running.
  // (Startup errors still fail loudly: they reject the runForeground promise → onError → exit, not these.)
  process.on('unhandledRejection', (reason) => {
    console.error('[fatal-guard] unhandledRejection:', reason instanceof Error ? (reason.stack ?? reason.message) : reason)
  })
  process.on('uncaughtException', (err) => {
    console.error('[fatal-guard] uncaughtException:', err instanceof Error ? (err.stack ?? err.message) : err)
  })

  // ── THE UPDATER GOES FIRST. Everything below this point can throw, hang, or wait on a vendor file,
  // a port, or tmux — and a daemon that never finishes starting is a daemon that can never be fixed:
  // there is no supervisor, and the desktop app only re-runs `harness start` on the same broken bytes.
  // Started here, a published fix lands on its own however badly the rest of the boot goes.
  //
  // `onStaged` is one indirection on purpose: the handoff's teardown does not exist yet and must not move
  // (it tears down two dozen subsystems declared further down). Until it is ready, a staged update is
  // applied by `bootHandoff`, which hands the machine over without finishing start-up.

  // Self-update ONLY manages the INSTALLED copy (`~/.harness/cli/cli.js`). A dev/repo run — `tsx`
  // (`npm run dev`) OR `node dist/cli.js` from the checkout — must NEVER self-update: it would swap
  // the published bundle into ~/.harness/cli and restart, hijacking the version you're developing.
  // Match by inode so symlinks/realpath don't fool it; fall back to a path compare.
  const installedCli = join(env.ADAPTER_CLI_DIR, 'cli.js')
  let isInstalledCopy = SCRIPT_PATH === installedCli
  try { isInstalledCopy = statSync(SCRIPT_PATH).ino === statSync(installedCli).ino } catch { /* keep path compare */ }
  if (isInstalledCopy && !env.ADAPTER_UPDATE_DISABLE) {
    daemonBoot.updater = startSelfUpdater({
      currentVersion: VERSION,
      url: env.ADAPTER_UPDATE_URL,
      key: env.ADAPTER_UPDATE_KEY,
      dir: env.ADAPTER_CLI_DIR,
      intervalMs: env.ADAPTER_UPDATE_CHECK_MS,
      slotSecond: env.ADAPTER_UPDATE_SLOT_SEC,
      // The lock spans the byte swap AND the handoff it triggers, as one critical section: a
      // `harness start` that lands between the two would otherwise stage over our .prev, and one
      // that lands during the handoff would spawn a second daemon.
      withLock: (fn) => withSpawnLock('handoff', fn, {
        onWaiting: (owner) => console.log(`[update] waiting — the daemon is ${describeSpawnLockOwner(owner)}`),
      }),
      onStaged: (v) => daemonBoot.applyStagedUpdate(v),
      limits: { idleMs: env.ADAPTER_UPDATE_IDLE_MS, deadlineMs: env.ADAPTER_UPDATE_DEADLINE_MS, floorBytesPerSecond: DOWNLOAD_LIMITS.floorBytesPerSecond },
      stageWhileJudged: !coreLink.supervised || process.env.HARNESSD_JUDGES_SUPERSEDED === '1',
    })
    const slotted = env.ADAPTER_UPDATE_SLOT_SEC >= 0 && 60_000 % env.ADAPTER_UPDATE_CHECK_MS === 0
    console.log(`[update] self-update on · v${VERSION} · every ${Math.round(env.ADAPTER_UPDATE_CHECK_MS / 1000)}s`
      + (slotted ? ` at :${String(env.ADAPTER_UPDATE_SLOT_SEC % 60).padStart(2, '0')}` : ''))
  } else if (!env.ADAPTER_UPDATE_DISABLE) {
    console.log(`[update] self-update off · running a dev/repo build (v${VERSION}), not the installed copy`)
  }

  // Keep the CLI's recovery updater armed first. hn is an independent, optional download.
  daemonBoot.tuiUpdater = startTuiUpdater({
    currentVersion: VERSION,
    isInstalledCopy,
    disabled: env.ADAPTER_UPDATE_DISABLE,
    intervalMs: env.ADAPTER_UPDATE_CHECK_MS,
    slotSecond: env.ADAPTER_UPDATE_SLOT_SEC,
  })
  // The update handoff (core/updateHandoff.ts): after the updaters, never above them (startupOrder.spec.ts),
  // and ahead of the /api/status handler that reads whether it is under way and of shutdown(), which takes
  // a successor it is judging down with us.
  const updateHandoff = createUpdateHandoff({
    version: VERSION, supervised: coreLink.supervised, exitForUpdate: () => process.exit(CORE_EXIT_UPDATE),
    // A core on its own: the staged bundle's master must answer its probe, as a master asks before it
    // re-executes on one; then a master takes the machine, and judges the update.
    probeMaster: () => probeStagedMaster((done) => execFile(managedNodePath(), [SCRIPT_PATH, PROBE_COMMAND], { encoding: 'utf8' }, (error, stdout) => done(error, stdout))),
    rollBack: () => restoreUpdate(env.ADAPTER_CLI_DIR),
    handOff: () => { startMasterHere(); process.exit(0) },
    log: (line) => console.log(line), error: (line) => console.error(line),
  })

  // Another daemon serves this data folder: leave before reading or writing anything of its — its
  // registry, its viewers, its panes. Just after the updaters, never before them (startupOrder.spec.ts);
  // their first check is a slot away, and a daemon that leaves here is gone long before it.
  await refuseServedDataFolder(localSocketPath(env.ADAPTER_DATA_DIR, env.PORT))

  // harnessd's master saw this core crash again and again: start nothing that could do it again. The
  // updaters above keep running, so a published fix still lands (`enterSafeMode`).
  if (process.env.HARNESSD_SAFE_MODE) throw new SafeModeRequest(process.env.HARNESSD_SAFE_MODE)

  const savedApis = new ApiConnections(env.ADAPTER_DATA_DIR)
  // Before any agent is probed: one already running on a saved API's model reports that model.
  rememberSavedApis(savedApis)
  const prepareApiTools = (cwd: string | null | undefined, engine: string): void => {
    if (!cwd) return
    try { prepareApiInstructions(savedApis, cwd, engine) }
    catch { console.warn('[apis] Tool instructions could not be added. Saved connections remain available through harness api.') }
  }

  registry.load()
  // Persisted locators are hints until this process has observed their terminal root and PID/start marker.
  // Mark them dormant before the backend socket can publish anything; the first authoritative reconcile
  // reactivates matching process agents without changing their public identity or session binding.
  await registry.transaction(() => {
    for (const session of registry.list()) registry.setActive(session.agentId, false)
  })
  // Unset means AUTO: watch every backend usable on this machine, which is tmux and only tmux (see
  // config/terminalConfig.ts). `parseTerminalBackends` drops a retired `herdr` still named in someone's
  // environment rather than refusing to boot on it.
  const backendsExplicit = env.TERMINAL_BACKENDS !== undefined
  const terminalConfig = {
    backends: env.TERMINAL_BACKENDS ?? ALL_TERMINAL_BACKENDS,
  }
  // Before ANY tmux call: a daemon that came up outside a terminal (the usual shape after a reboot)
  // has a minimal PATH, and every `execFile('tmux', …)` below would ENOENT. Ask the user's own login
  // shell where tmux is and adopt that directory, the same way the engine launch already consults it.
  // Both of these are independent login-shell spawns with nothing dependent on the other's
  // result — started together here so their wall-clock cost overlaps instead of adding up.
  // `loginShellEnvPromise` is awaited later, near the existing `[env]` log line.
  const tmuxPathPromise = terminalConfig.backends.includes('tmux') ? ensureTmuxOnPath() : null
  const loginShellEnvPromise = warmLoginShellEnvironment()
  // Missing tmux is a STATE, not a reason to refuse to start. The daemon already models a machine
  // without it — `tmuxBackend` is null whenever the config omits tmux, every caller tests it, and the
  // create/restart/resume paths answer `TMUX_UNAVAILABLE` — so it can still serve its status, the
  // local socket, the backend link and its updater, and say what is missing. Refusing instead left a
  // machine whose PATH lost tmux with a daemon that could not start and therefore could not be fixed.
  let tmuxUnavailable: string | null = null
  if (tmuxPathPromise) {
    const tmuxPath = await tmuxPathPromise
    if (tmuxPath.state === 'absent') {
      tmuxUnavailable = tmuxPath.reason
      console.error(`[tmux] unavailable: ${tmuxPath.reason} · install tmux and verify \`tmux -V\`,`
        + ' then restart — agents cannot be created or restored until then')
    } else if (tmuxPath.state === 'adopted') {
      console.log(`[tmux] not on the daemon PATH · adopted ${tmuxPath.path} · ${tmuxPath.from}`)
    }
  }
  // The desktop's pane colours, for tmux's `window-style` (lib/hostTheme.ts): the last ones the app
  // sent, or its stock dark palette until it says otherwise. Read through a closure so a change
  // reaches sessions created after it without rebuilding the backend.
  let hostTheme: HostTheme = loadHostTheme() ?? DEFAULT_HOST_THEME
  const tmuxBackend = terminalConfig.backends.includes('tmux') && !tmuxUnavailable ? new TmuxBackend(() => hostTheme) : null
  const terminalBackends = tmuxBackend ? [tmuxBackend] : []
  const terminals = new TerminalBackendCoordinator(
    terminalBackends,
    terminalConfig.backends,
  )
  console.log(`[terminal] enabled backends: ${terminalConfig.backends.join(', ')}`)
  if (tmuxBackend) {
    // Before the first inventory: sessions a pre-prefix build named `<engine>-<ts>` are renamed to
    // `harness-<engine>-<ts>` so discovery's whitelist sees the registry's own panes again.
    const ownedPanes = new Map(registry.list().flatMap((session) => session.runtimes
      .filter((runtime) => runtime.backend === 'tmux')
      .map((runtime) => [runtime.paneId, session.engine] as const)))
    for (const adopted of await adoptLegacyHarnessSessions(ownedPanes)) {
      console.log(`[terminal] renamed tmux session ${adopted.from} → ${adopted.to} (pane ${adopted.paneId}) · named by a build before the harness- prefix`)
    }
    const tmuxStartup = await tmuxBackend.inventory()
    console.log(tmuxStartup.state === 'available'
      ? '[terminal] tmux: available'
      : `[terminal] tmux: ${tmuxStartup.state} (${tmuxStartup.reason})`)
  }
  const sqliteWarning = sqlitePreflightMessage()
  if (sqliteWarning) console.warn(sqliteWarning)
  // The user's shell environment is captured at startup, not on the first recap — a slow profile
  // (nvm, conda, …) then stalls nothing live. Started above alongside the tmux PATH probe, and LOGGED
  // when it lands, never waited on: nothing before the control port binds needs it (lib/loginShellEnv
  // caches the capture; engine one-shots read it through `loginShellEnvironment()`), and a second
  // login shell held the port — and with it the app's "Starting local service…" — for as long as the
  // slower of the two shells took. See lib/loginShellEnv.ts: this is what lets a recap reach a
  // credential the user exports from their rc file, which a launchd/systemd-parented daemon never read.
  {
    const t0 = Date.now()
    void loginShellEnvPromise.then((captured) => {
      const count = Object.keys(captured).length
      console.log(count
        ? `[env] read ${count} variables from the login shell in ${Date.now() - t0}ms (engine one-shots only)`
        : '[env] could not read a login shell environment — engine one-shots use the daemon environment only')
    })
  }

  // Reading and writing panes through control leases (core/terminals/control.ts).
  const terminalControl = createTerminalControl({ resolve: (target) => registry.resolve(target), terminals })
  const pinnedControls = terminalControl.pinnedControls
  const invalidateTerminalControl = terminalControl.invalidateTerminalControl
  const captureTerminal = terminalControl.captureTerminal
  const submitTerminal = terminalControl.submitTerminal
  const typeTerminal = terminalControl.typeTerminal
  const keyTerminal = terminalControl.keyTerminal
  const validateTerminal = terminalControl.validateTerminal
  // Persisted records are not trusted blindly. The process reconciler below adopts a matching live
  // runtime, replaces it immediately when PID/start-marker changed, and requires two successful misses
  // before removing it. Probe errors leave the registry untouched.
  // The voice router needs to know which engines the machine actually runs: a router warmed for an
  // engine no agent uses is a worker nobody asked for.
  const syncRecapPool = (): void => {
    setVoiceRouterSessions(registry.active())
  }
  syncRecapPool()
  const runtimeProfiles = new RuntimeProfileManager()
  // An agent's Model/Effort choices, or every live agent's: what `models_list` answers (services/models.ts)
  // and the dial's picker reads, so neither can show a catalog the machine would not honour.
  const runtimeModels = (agentId?: string): Promise<RuntimeModelOption[]> => {
    if (!agentId) return runtimeProfiles.modelsForSessions(registry.list())
    const session = registry.resolve(agentId)
    return session ? runtimeProfiles.modelsForSession(session) : Promise.resolve([])
  }
  // NB: hooks are installed AFTER the hook server binds (below), with the port it actually got — the
  // server may fall back to a free port if env.PORT is taken, and the hooks must point at the real one.

  // Telling the app and the dial about agents (core/agents/events.ts). The socket is read when each
  // frame goes out: until it exists, frames are dropped, and start-up announces every agent again.
  const agentEvents = createAgentEvents({
    sink: () => backendRef,
    terminalAvailable: (agentId) => registry.terminalAvailable(agentId),
    resolve: (target) => registry.resolve(target),
    stopped: (agentId) => stoppedAgents.get(agentId),
    project: (s) => projectFrame(s, runtimeProfiles.selectedModel(s)),
  })
  const syncSession = agentEvents.syncSession
  const announceRename = agentEvents.announceRename
  agentTokenUsage.onChanged = agentEvents.onTokenUsageChanged
  const announceSession = agentEvents.announceSession

  // Conversations on this machine that Harness did not start, found where each engine keeps them so
  // Cmd-P can find them and open one here; and which sessions a process has open right now. Harness's
  // own byproducts (recaps run in its data folder) are never among them.
  const externalEngines = externalProviders()
  const externalSessions = new ExternalSessions({ providers: externalEngines, excluded: [env.ADAPTER_DATA_DIR], log: (line) => console.warn(line) })
  const openSessions = new OpenSessions({ providers: externalEngines, log: (line) => console.warn(line) })
  // The core's one session manager: the backend link, the gateway's dials and the fleet's lane all take
  // their tokens from it, so a refresh in flight is shared rather than raced.
  const auth = new AuthSessionManager(backendHttpBase())
  // The core's side of the boundary its services stand on, and the ports it reaches them through (core/api.ts).
  // Delivered turns (core/deliveries.ts): text a feature writes into an agent under a delivery id of its
  // own, and what becomes of each, told back to whoever made it, in this process or in its own.
  // A read-only view of agents' terminals for an experiment's viewers, told to its process (core/terminalWatch.ts).
  const terminalWatch = createTerminalWatch({ terminals, resolve: (id) => registry.resolve(id), watchers: new Set(Object.keys(EXPERIMENTS)),
    tell: (service, viewer, output) => serviceLinksRef?.notify(service, { type: 'service_event', payload: { kind: 'watch', viewer, output } }) ?? false })
  const deliveries = createDeliveries({
    submit: (agentId, text, deliveryId) => backendRef?.onMessage?.(agentId, text, deliveryId),
    cancel: (deliveryId) => backendRef?.onCancelOrchestratorMessage?.(deliveryId) ?? false,
    tell: (service, event) => { serviceLinksRef?.notify(service, { type: 'service_event', payload: { kind: 'delivery', event } }, { untilDelivered: true }) },
    // The experiments: the orchestrator's turns, and those of the experiments after it.
    deliverers: new Set(Object.keys(EXPERIMENTS)),
  })
  const coreApi = createCoreApi({
    // Agents' terminals: a literal-argv launch, and a read-only view for Share's observers (core/terminalWatch.ts).
    terminals: { ...createTerminalOpener({ tmuxBackend, registry, announceSession, blocksFolder: (cwd) => !!backendRef?.purgeAgentService?.blocksFolder(cwd) }), watch: terminalWatch.watch },
    dataDir: env.ADAPTER_DATA_DIR,
    registry,
    stoppedAgents,
    databaseHistory,
    externalSessions,
    openSessions,
    syncSession,
    runtimeModels,
    viewerChanged: (agentId) => {
      backendRef?.viewerForwarder.refresh(agentId)
      backendRef?.interactiveViewers.refresh(agentId)
    },
    gridNamed: (name) => backendRef?.setHarnessGridName(name),
    gridModelsChanged: () => { void backendRef?.pushGridModels() },
    privateGridName: async () => backendRef?.gridName() ?? null,
    machineName: () => backendRef?.machineName() ?? null,
    // An experiment's account-wide settings (Tab collaboration's tab channels), signed in by this core.
    backend: (method, path, body) => proxyBackend(method, path, body),
    onNotice: (listener) => experimentHooks.onNotice(listener),
    dshInstallStatus: (status) => backendRef?.send({ type: 'dsh_install_status', payload: status }),
    // The backend mints and remembers the account's grid name; this CLI holds neither the account's
    // email nor its id. An older backend (no route) answers nothing, which the grid reconcile treats as
    // "no grid yet". Bounded so a stalled control-plane connection cannot hold the attempt open.
    mintGridName: async () => {
      const { headers } = await controlPlaneAuth()
      return (await postJson<{ gridName?: string }>('/api/grid/name', {}, headers, AbortSignal.timeout(GRID_MINT_TIMEOUT_MS))).gridName ?? null
    },
    accessToken: (options) => auth.accessToken(options),
    // The fleet's lane's sessions are the gateway's, which holds this machine's E2EE identity; it starts
    // below, before the fleet that seals through it.
    lane: laneOf(() => gatewayOps.lane),
    // What a device or another machine asks of an agent here: the SAME handlers the backend socket
    // drives, called directly — the slash-command adaptation and the turn and question plumbing live there.
    runtimeProfile: (session) => runtimeProfiles.selectedModel(session),
    setRuntime: (agentId, model, effort) => {
      const s = registry.resolve(agentId)
      if (!s || !model) return
      void runtimeController.setProfile(s.sessionId || agentId, `runtime-v1:${s.sessionId || agentId}:${s.engine}:${model}@${effort || 'auto'}`)
    },
    // The window's `agent_create` for an experiment's agents (core/experimentQueries.ts).
    create: (request) => createForExperiment(backendRef?.onCreateAgent ?? null, request),
    dsh: (session) => backendRef?.dshFrameProvider?.(session) ?? null,
    windows: (frame) => backendRef?.sendLocal(frame),
    daemon: { command: daemonCommand(), port: env.PORT, machineId: () => backendRef?.machineId ?? '', autonomousEnv: session?.autonomousEnv ?? env.AUTONOMOUS_ENV },
    // Share: its observers' frames to the relay, and its welcomes signed by the gateway, which holds the identity.
    observer: (connId, type, payload) => backendRef?.sendObserver(connId, type, payload) ?? false,
    observerKey: { publicKey: () => gatewayOps.observerKey.publicKey(), signWelcome: (...args) => gatewayOps.observerKey.signWelcome(...args) },
    // The same path the window's `agent_fork` takes.
    fork: async (agentId) => {
      if (!backendRef?.onForkAgent) return { ok: false, error: 'UNSUPPORTED' }
      const result = await backendRef.onForkAgent({ agentId, name: null, prompt: null })
      return result.ok ? { ok: true, agentId: result.session.agentId } : { ok: false, error: result.error, detail: result.detail }
    },
    turns: {
      send: (agentId, text) => backendRef?.onMessage?.(agentId, text),
      stop: (agentId) => backendRef?.onCancel?.(agentId),
      recent: (agentId, n) => mirror.recent(registry.resolve(agentId)?.sessionId || agentId, n),
      asks: (agentId) => mirror.recentAsks(registry.resolve(agentId)?.sessionId || agentId),
      ...deliveries.turns,
    },
    questions: {
      // The device's own object, verbatim: rebuilt as `{ [requestId]: optionId }` it was keyed by the
      // REQUEST id, not the question key `asking.answer` expects, and named a question that does not exist.
      answer: (agentId, requestId, answers) => { void asking.answer({ agentId, requestId, answers }) },
      answerReviewed: async (answer) => (await questions.answer({ agentId: answer.agentId, requestId: answer.requestId,
        answers: answer.answers, expectedQuestions: answer.questions, selectedLabels: answer.selections, freeTextKeys: answer.freeTextKeys })).ok,
    },
  })
  const ports = emptyPorts()
  // Each service starts and is called through the host, so one that fails is logged and left off and
  // the core carries on without it (core/serviceHost.ts).
  const serviceHost = createServiceHost(ports, { faults: testFaults(process.env.HARNESSD_TEST_FAULTS) })
  // The DSH companions: each harness agent's viewer and verdict watch (services/viewers.ts), started below.
  dshFrameContextRef = (s) => ports.viewers?.frameContext(s) ?? null
  // Models (services/models.ts), started below: what an agent's frame says of its grid, from memory.
  gridAnnotationRef = (grid) => (ports.models ?? MODELS_OFF).annotation(grid)
  const attachDsh = (s: RegisteredSession): void => ports.viewers?.attach(s)
  const detachDsh = (agentId: string): void => ports.viewers?.detach(agentId)

  // The folders agents work in: branch names and unused worktrees (services/workspaces.ts), started below.
  const syncTerminalTitles = async (): Promise<void> => {
    ports.workspaces?.nameBranches()
    const titles = await terminals.titles()
    // The machine's name now, beside every name it has had: a title that is one of them is refused.
    machineNames.observe()
    if (titles.size === 0) return
    for (const session of registry.list()) {
      // Codex's own thread name when it has one; otherwise what the engine put on its terminal.
      const title = engineSessionTitle(session, terminals.titleFor(session, titles))
      if (!title) continue
      const before = projectDisplayName(session)
      // Fall back to the agent id: a terminal that became an engine harness (e.g. opencode typed
      // into a New Terminal) has no engine session id — nothing fired a session-start hook — but its
      // pane title is still readable and should still rename the harness.
      const updated = registry.updateTitle(session.sessionId || session.agentId, title)
      if (!updated) continue
      const after = projectDisplayName(updated)
      if (after !== before) {
        syncSession(updated)
        announceRename(updated)
      }
    }
  }
  let deviceStoreRef: ReturnType<typeof createDeviceStore> | undefined
  let autonomousDeviceService: AutonomousDeviceService | undefined
  let devicePartsBuilt = false
  let appFormWindow: { machineId: string; connId: string } | undefined
  let appVoiceFocus: { machineId: string; agentId: string; connId: string } | undefined
  let backendRef: BackendSocket | undefined
  /** Assigned below, once the grid reconcile exists. A backend (re)connect is the signal that the
   *  control plane is reachable again, which is precisely what an earlier attempt may have lacked. */
  let fullReconcile: (announceDevice?: boolean) => Promise<void> = async () => {}

  // The account's machine id when this computer is signed in; its own durable computer id when it is
  // not. Both are just "the id this daemon serves under" to everything downstream — the local
  // websocket binds clients to it, the app selects by it — and the backend binds a machine to the
  // computer id at login, so a sign-in ADOPTS this machine rather than minting a second one.
  const autonomousEnv = session?.autonomousEnv ?? env.AUTONOMOUS_ENV
  const backend = new BackendSocket(session?.machineId ?? computerId(), (connected) => {
    if (!connected) return
    const sessions = registry.advertised()
    console.log(`[cli] connected · ${sessions.length} agent(s) registered`)
    void fullReconcile(true).catch((err) => {
      console.error('[runtime-profile] connect reconcile failed:', err instanceof Error ? err.message : err)
    })
  })
  backendRef = backend
  // Nothing is answered until start-up is done (see the end of this function).
  backend.holdRequests()
  // The services harnessd's master runs in their own processes (harnessd/services.ts, `HARNESSD_SERVICES`):
  // only under a master, which is what gives this core the token they connect with. Their requests are
  // routed to them, and answered SERVICE_UNAVAILABLE while they are down (core/serviceLinks.ts).
  const serviceToken = process.env.HARNESSD_SUPERVISED === '1' ? process.env.HARNESSD_SERVICE_TOKEN : undefined
  const outOfProcess = servicesTheMasterRuns(process.env, KNOWN_SERVICES)
  // The services' own code, for those that run in this process (services/inline.ts): loaded only then, so
  // one in its own process, as each is by default, is never loaded here.
  const inline = KNOWN_SERVICES.some((name) => !outOfProcess.has(name)) ? await import('../services/inline.js') : null
  // The relay and its E2EE (gateway/): the backend link, the sessions and the keys, which every remote
  // client's frames go through, held at the same gate. In its own process by default (core/gatewayLink.ts),
  // or here (gateway/start.ts); the socket hears it through `fromGateway` and speaks to it in the clear.
  const account = (): GatewayAccount => ({ machineId: readAuthSession()?.machineId ?? null, signIn: signInOf(readAuthSession()?.signInEpoch) })
  let serviceLinksRef: ServiceLinks | null = null
  const gatewayLink = outOfProcess.has('gateway') ? createGatewayLink({
    events: backend.fromGateway,
    notify: (frame) => serviceLinksRef?.notify('gateway', frame) ?? false,
    notifyBinary: (bytes) => serviceLinksRef?.notifyBinary('gateway', bytes) ?? false,
    buffered: () => serviceLinksRef?.buffered('gateway') ?? 0,
    call: (type, payload, waitMs) => serviceLinksRef?.call('gateway', type, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
    start: () => ({ machineId: backend.machineId, computerId: computerId(), autonomousEnv, signedIn: !!session?.machineId, account: account() }),
    tokens: auth, backend: (method, path) => proxyBackend(method, path),
  }) : null
  const gateway = gatewayLink ?? inline!.startGateway({
    events: backend.fromGateway, machineId: backend.machineId, computerId: computerId(), autonomousEnv,
    signedIn: !!session?.machineId, tokens: auth, backend: (method, path) => proxyBackend(method, path), account: account(),
  })
  backend.useGateway(gateway.port)
  const gatewayOps = gateway.ops
  daemonBoot.openRequests = () => backend.openRequests()
  const teams: TeamsPort = {
    prepare: (...args) => ports.teams?.prepare(...args) ?? (() => {}),
    started: (...args) => ports.teams?.started(...args),
    raw: (...args) => ports.teams?.raw(...args),
    forget: (agentId) => ports.teams?.forget(agentId),
    canWrite: (deliveryId) => ports.teams?.canWrite(deliveryId) ?? false,
  }
  backend.viewerTargetProvider = (agentId) => ports.viewers?.forwardingUrl(agentId) ?? null

  // The harnesses the release bundles (the Model Manager, Devices, the Harness Monitor), before restore
  // relaunches an agent on one. Here and not in the Store's process: its lean bundle would carry a second
  // copy of their files (571 KB more cli.js) and the viewers' process held 12 MiB more at idle (measured
  // 2026-10-06), while cli.js, which the core runs, carries them anyway.
  ensureBundledCoreHarnesses()

  /**
   * Is ANY device surface watching this machine?
   *
   * Two answers, both real: a device connected through the backend (`hasCommander`), and the dial on the
   * USB cable, which reaches this daemon directly over serial and is invisible to the socket that counts
   * the others.
   *
   * This gates the whole device mirror — the "Working…" card and the LLM recap. Reading it as
   * backend-only meant a dial plugged into a machine with no WiFi device saw a turn start in its tmux
   * pane and then nothing at all: the daemon skipped GENERATING the cards, so there was nothing to send.
   */
  // A PLUGGED-IN DIAL IS ALWAYS WATCHING THIS COMPUTER. It used to be gated on the dial having this
  // machine selected, because the carousel held one machine's agents at a time; it now holds every
  // machine's at once, so this computer's tiles are on screen whichever machine the wheel last landed on
  // and skipping the recap here would leave them permanently blank.
  /** Agents with a tile open in the desktop window right now. Empty when no window is attached. */
  const cleanupTabs = new OpenTabProtection({
    machineId: () => backend.machineId,
    sessions: () => registry.list(),
    readDesk: () => proxyBackend('GET', '/api/desk'),
  })
  let openPaneAgents = new Set<string>()
  /** Whether the window those tiles belong to is actually in front. See onAppPanes. */
  let appWindowForeground = true
  /**
   * Is this agent already in front of somebody at this desk?
   *
   * Both halves are needed and neither alone is enough: a tile on the tab says WHERE it is, the window
   * being in front says whether anyone can see it. The dial used to be told the first half only, so it
   * stayed quiet about a turn that finished while the window sat behind a browser — which is the one
   * case a notification exists for — and the window, which checks both (`_visibleOnTab`), spoke up.
   * Two screens, two answers, from one tab.
   */
  const alreadyOnScreen = (agentId: string): boolean =>
    appWindowForeground && openPaneAgents.has(agentId)
  const cableWatchingLocal = (): boolean => cableRef?.isConnected === true

  const deviceIsWatching = (): boolean => backend.hasCommander() || cableWatchingLocal() || backend.autonomousDeviceConnected()
  /** Anyone who can DRAW a question: a device, a cabled dial, or a desktop window on this computer. */
  const someoneCanAnswer = (): boolean => deviceIsWatching() || backend.hasLocalClient()
  const terminalStreams = new TerminalStreamManager({
    terminals,
    resolveAgent: (agentId) => registry.resolve(agentId),
    sendTarget: (connId, type, payload) => backend.sendTerminalTo(connId, type, payload),
    sendBinaryTarget: (connId, frame) => backend.sendTerminalBinaryTo(connId, frame),
    isLoopback: isLocalClientId,
    // For a client that did not introduce itself on `terminal_open` (an older build). A loopback
    // window can only be this computer's desktop; a paired peer is named by its pairing label unless
    // that label is one of the placeholders pairing hands out — those name nothing.
    describeClient: (connId) => {
      if (isLocalClientId(connId)) return { kind: 'desktop', name: terminalHintMachineName() }
      const client = backend.remoteClient(connId)
      const label = client?.label
      if (!label || GENERIC_PAIR_LABELS.has(label)) return null
      return { kind: client.role === 'device' ? 'device' : 'web', name: label }
    },
    streamingAvailable: tmuxBackend != null,
    onScopedInput: (id, bytes, tabId, pasted) => teams.raw(id, bytes, tabId, pasted),
    diagnostic: (event, fields) => console.log(`[terminal-stream] ${event}`, fields),
    // The keystroke prewarm (grid-reads-without-waking issue 03): typing into a pane whose agent runs on
    // a sleeping grid starts that grid while the person types. Here, in the daemon's own input path, so
    // an older desktop and typing from a phone get it too; an agent on its own login has no `grid`.
    onInput: (agentId) => {
      const grid = registry.resolve(agentId)?.grid
      if (grid) ports.models?.prewarm(grid)
    },
  })
  backend.setTerminalStreamManager(terminalStreams)
  // What a harness's pane runs and where, and the desktop's pane colours (core/terminals/requests.ts). A
  // theme is applied only for a frame, well after `agentReconciler` below exists (connect() comes last).
  const terminalRequests = createTerminalRequests({
    resolve: (id) => registry.resolve(id),
    paneInfo: (pane) => tmuxPaneInfo(pane),
    applyTheme: (theme) => {
      if (theme.background === hostTheme.background && theme.foreground === hostTheme.foreground) return
      hostTheme = theme
      saveHostTheme(theme)
      console.log(`[theme] panes now bg=${theme.background} fg=${theme.foreground}`)
      // Existing sessions pick it up on the next scan (TmuxBackend.inventory restyles); nudge one now.
      void agentReconciler.trigger()
    },
  })
  backend.terminalInfoProvider = terminalRequests.terminalInfo
  backend.themeProvider = terminalRequests.themeSet

  // Each session's engine state, in one table (core/transcripts/normalizers.ts).
  const normalizers = createSessionNormalizers()
  const cursorNormalizers = normalizers.cursorNormalizers
  const agyNormalizers = normalizers.agyNormalizers
  const commandcodeNormalizers = normalizers.commandcodeNormalizers
  const sessionTurnState = normalizers.sessionTurnState
  const sessionTurnOpen = normalizers.sessionTurnOpen
  const watcher = new Watcher()
  // Whether a turn is really working, beyond its transcript (core/turns/activity.ts).
  const activity = createTurnActivity({
    terminals,
    bySession: (sessionId) => registry.bySession(sessionId),
    sessionTurnOpen,
    drain: (sessionId) => watcher.pollSession(sessionId),
  })
  const codexActivity = activity.codexActivity
  const runtimeActivity = activity.runtimeActivity
  const turnActivity = activity.turnActivity
  activityFrameContextRef = activity.activityFrame
  backend.activityFrameProvider = activityFrameContextRef

  // The event funnel (core/turns/funnel.ts). Hook registration can race the rest of daemon
  // initialization immediately after the localhost server binds: events wait until it is armed below.
  const funnel = createEventFunnel({
    clients: backend,
    // Declared further down: read when a turn aborts, never now.
    agentIdFor: (sessionId) => agentIdFor(sessionId),
  })
  const emitSessionEvents = funnel.emit
  const announceTurnAborted = funnel.announceTurnAborted
  const cursorDiscovery = new CursorTranscriptDiscovery(cursorDataDir(), (sessionId, transcriptPath) => {
    const existing = registry.bySession(sessionId)
    if (!existing || existing.engine !== 'cursor' || existing.transcriptPath === transcriptPath) return
    const result = registry.register({
      engine: 'cursor',
      sessionId,
      transcriptPath,
      cwd: existing.cwd ?? undefined,
      source: existing.source ?? undefined,
      runtimes: existing.runtimes,
      primaryRuntimeKey: existing.primaryRuntimeKey,
      title: existing.title ?? undefined,
      model: existing.model ?? undefined,
      cliVersion: existing.cliVersion ?? undefined,
      processIdentity: existing.processIdentity ?? undefined,
      hookEvent: 'TranscriptDiscovered',
    })
    if (!result) return
    void attachSession(result.entry, false, true).then((attached) => {
      if (!attached) return
      syncRecapPool()
      syncSession(result.entry)
    }).catch((err) => {
      console.error('[cursor-discovery] attach failed:', err instanceof Error ? err.message : err)
    })
  })

  // Where an engine's writing becomes live again after a resume or a daemon restart, read by the attach
  // that follows (core/transcripts/relaunch.ts).
  const relaunchMarks = createRelaunchMarks()
  // Following a session: its history read into its engine's normalizer, then its tail
  // (core/transcripts/attach.ts).
  const attach = createAttach({
    terminalGone: terminalControl.terminalGone,
    normalizers,
    watcher,
    cursorDiscovery,
    device: () => autonomousDeviceService,
    runtimeProfiles,
    captureTerminal,
    emit: (sessionId, events, opts) => emitSessionEvents(sessionId, events, opts),
    announceTurnAborted,
    // Built further down: read when an attach starts watching a pane, never now.
    questionWatcher: { start: (sessionId) => questionWatcher.start(sessionId) },
    terminalLabel: primaryTerminalLabel,
    dbs: { opencode: OPENCODE_DB, kilo: KILO_DB, devin: DEVIN_DB },
    devinHome: env.DEVIN_HOME,
    hermesDb: (s) => hermesDbForSession(s),
    concurrency: ATTACH_CONCURRENCY,
    relaunchMarks,
  })
  const attaches = attach.attaches
  const attachSession = attach.attachSession
  const neverFoldedHistory = attach.neverFoldedHistory
  const replayedFirstTurn = attach.replayedFirstTurn
  // A conversation's history, a page at a time, and how long it is (core/transcripts/history.ts).
  const history = createHistory({ resolve: (id) => registry.resolve(id), stopped: () => stoppedAgents.list(),
    pages: new TranscriptPager(), dbs: { opencode: OPENCODE_DB, kilo: KILO_DB, devin: DEVIN_DB },
    hermesDb: (s) => hermesDbForSession(s) })
  backend.historyProvider = history.sessionGet
  backend.sessionsProvider = history.sessionsList
  // Everything the core writes into a pane, and the device's pane lock (core/input.ts).
  const inputs = createInput({
    resolve: (id) => registry.resolve(id),
    byAgent: (agentId) => registry.byAgent(agentId),
    terminal: terminalControl,
    teams: {
      prepare: (id, text, tabId, deliveryId) => teams.prepare(id, text, tabId, deliveryId),
      delivery: (event) => {
        deliveries.settled(event)
      },
      canWrite: (deliveryId) => teams.canWrite(deliveryId),
    },
    device: () => autonomousDeviceService,
    clients: backend,
    // Declared further down: read when an error is reported, never now.
    agentIdFor: (sessionId) => agentIdFor(sessionId),
    commandcode: (sessionId) => commandcodeNormalizers.get(sessionId),
    // Reassigned further down (the funnel): always the current one.
    emit: (sessionId, events) => emitSessionEvents(sessionId, events),
  })
  const input = inputs.input
  const deviceInput = inputs.deviceInput

  // agy's turn closed from its pane when its final Stop never comes (core/turns/agyBackstop.ts).
  const agyBackstop = createAgyBackstop({
    agyNormalizers,
    bySession: (sessionId) => registry.bySession(sessionId),
    captureTerminal,
    drain: (sessionId) => watcher.pollSession(sessionId),
    emit: (sessionId, events) => emitSessionEvents(sessionId, events),
  })
  const clearAgyIdleWatch = agyBackstop.clearAgyIdleWatch
  const armAgyIdleWatch = agyBackstop.armAgyIdleWatch

  const acquireTerminalControl = inputs.acquireTerminalControl
  // Questions an agent asks the person: shown on the dial and the window, answered from anywhere
  // (core/questions.ts).
  const asking = createQuestions({
    resolve: (id) => registry.resolve(id),
    terminal: terminalControl,
    acquireTerminalControl,
    clients: backend,
    // Declared further down: read when a question is shown, never now.
    agentIdFor: (sessionId) => agentIdFor(sessionId),
    sessionTurnOpen,
    someoneCanAnswer,
    deviceInput,
  })
  const questions = asking.questions
  backend.questionProvider = asking.questionResponse
  const openQuestions = asking.openQuestions
  // The agents on this machine (core/agents/list.ts), in the socket's frames, with its monitor readings.
  backend.agentsProvider = createAgentList({
    registry, stoppedAgents, monitorActivityProvider: asking.monitorActivity, monitorCompletions: backend.monitorCompletions,
    toProject: (s) => backend.toProject(s), toStoppedProject: (s) => backend.toStoppedProject(s),
    // The monitor's readings, through its port (services/monitor.ts): none while it is off.
    harnessResourcesReader: () => (ports.monitor ?? MONITOR_OFF).resources(), harnessStorageReader: (agents, invalidate) => (ports.monitor ?? MONITOR_OFF).storage(agents, invalidate),
  }).agentsList
  const agentNotifications = asking.agentNotifications
  const questionWatcher = asking.questionWatcher


  // The turn's last text, for its recap, whatever the engine (core/transcripts/lastTurn.ts).
  const readLastTurn = createLastTurnReader({
    bySession: (sessionId) => registry.bySession(sessionId),
    dbs: { opencode: OPENCODE_DB, kilo: KILO_DB, devin: DEVIN_DB },
    hermesDb: (s) => hermesDbForSession(s),
  })
  // Recaps: turn cards on the dial and the window, notifications on the phone (core/turns/recaps.ts).
  const recaps = createRecaps({
    notifications: agentNotifications,
    turnActivity,
    clients: backend,
    deviceIsWatching,
    cableWatchingLocal,
    bySession: (sessionId) => registry.bySession(sessionId),
    resolve: (id) => registry.resolve(id),
    stopped: (agentId) => stoppedAgents.get(agentId),
    orchestratorRoleOf: (agentId) => ports.orchestrator?.roleOf(agentId) ?? null,
    readLastTurn,
    dataDir: env.ADAPTER_DATA_DIR,
    recapForce: env.RECAP_FORCE,
    recapWithoutDevice: () => env.RECAP_WITHOUT_DEVICE,
  })
  const isSubagentSession = recaps.isSubagentSession
  const mirror = recaps.mirror
  // Recaps are STORED under the engine session id — that is what lets `--resume` bring the last recap
  // back under a brand-new agent — but they are ASKED FOR by agent id, which is the only id the device
  // and the voice router know. Resolve across the two, or every tile restores empty.
  backend.agentRecentProvider = recaps.agentRecent

  // "Change agent": the desktop asks for the structured handoff file (lib/agentHandoff.ts) before it
  // closes the old engine; the new one is then told to read it.
  // Built ONCE: its discovery keeps "one search per agent" across requests.
  const handoffDeps = handoffProviderDeps({
    registry,
    stopped: {
      get: (id) => stoppedAgents.get(id),
      // Every saved record, readable or not (the store's own `list()` skips an unreadable one), so ownership fails closed.
      ids: () => stoppedAgents.ids(),
    },
    mirror,
    databaseHistory,
    findLiveSession,
    claudeProcessSession,
    isRecentlyDeleted,
    findResumedTranscript,
    validTranscriptPath,
  })
  backend.handoffRequestProvider = createHandoffRequest({ prepare: (req) => prepareAgentHandoff(handoffDeps, req) })

  // The requests each service that can run in its own process answers, as core/api.ts declares them.
  const requestsOf: Record<string, readonly string[]> = {
    search: SEARCH_REQUESTS, store: STORE_REQUESTS, usage: USAGE_REQUESTS, monitor: MONITOR_REQUESTS, projects: PROJECTS_REQUESTS, models: MODELS_REQUESTS,
    ...Object.fromEntries(Object.entries(EXPERIMENTS).map(([name, experiment]) => [name, experiment.requests])),
  }
  // The experiments (core/api.ts `EXPERIMENTS`): each may act on the core through the hooks an experiment has.
  const experiments = new Set(Object.keys(EXPERIMENTS))
  // What the core keeps of the orchestrator in its own process: each agent's role, and which frames are its
  // Directors' (core/orchestratorLink.ts).
  const orchestratorLink = createOrchestratorLink((frame) => serviceLinks.notify('orchestrator', frame))
  // What the core keeps of the viewers in their own process, for the frames it builds (core/viewersLink.ts).
  const viewersLink = createViewersLink(coreApi, (frame, opts) => serviceLinks.notify('viewers', frame, opts))
  // How the core tells workspaces in their own process what to do, and answers them (core/workspacesLink.ts).
  const workspacesLink = createWorkspacesLink(coreApi, (frame) => serviceLinks.notify('workspaces', frame), forgetAgentProject)
  // Tab collaboration and teams, an experiment: the prompt scopes and the teams beside them, both in its process
  // or both in this one (core/teamsLink.ts), which keeps the scopes' changes from the moment it is on.
  const teamsOut = teamsOutOfProcess(outOfProcess)
  const teamsLink = createTeamsLink({ notify: (frame) => serviceLinks.notify('teams', frame), off: true })
  // An experiment asked for, and the account's notices for those that hear them (core/experiments.ts).
  const experimentHooks = createExperimentHooks({ want: (service) => coreLink.want(service), notify: (service, frame) => serviceLinks.notify(service, frame),
    outOfProcess, experiments, onWant: { collaboration: () => teamsLink.on() } })
  backend.onAccountNotice = (notice) => experimentHooks.notice(notice)
  // What the Store in its own process tells the core: an install's progress, and that what is installed changed (core/storeLink.ts).
  const storeLink = createStoreLink(coreApi, invalidateInstalledDsh)
  // What the core keeps of models in its own process for frames and keystrokes, and how it asks it the rest (core/modelsLink.ts).
  const modelsLink = createModelsLink(coreApi, (type, payload) => serviceLinks.call('models', type, payload), (frame) => serviceLinks.notify('models', frame))
  const serviceLinks = createServiceLinks({
    token: serviceToken,
    owned: Object.fromEntries([...outOfProcess].map((name) => [name, requestsOf[name] ?? []])),
    waits: LONG_ANSWERS,
    // An experiment's process runs only once it is on: a request for one that is off asks the master for it.
    onDemand: experiments,
    want: (service) => experimentHooks.want(service),
    answer: async (service, query, payload) => deliveries.answer(service, query, payload)
      ?? await answerExperimentQuery(coreApi, experiments, service, query, payload)
      ?? await terminalWatch.answer(service, query, payload)
      ?? (service === 'orchestrator' ? orchestratorLink.answer(query, payload) : null)
      ?? (service === 'viewers' ? viewersLink.answer(query, payload)
      : service === 'workspaces' ? workspacesLink.answer(query, payload)
      : service === 'store' ? storeLink.answer(query, payload)
      : service === 'models' ? modelsLink.answer(query, payload)
      : service === 'teams' || service === 'collaboration' ? teamsLink.answer(query, payload)
      : service === 'gateway' && gatewayLink ? gatewayLink.answer(query, payload) : answerAgentQuery(coreApi, query)),
    // The gateway's own traffic: its remote clients and what they sent, and its comings and goings.
    notice: (service, payload) => { if (service === 'gateway') gatewayLink?.notice(payload) },
    binary: (service, bytes) => { if (service === 'gateway') gatewayLink?.binary(bytes) },
    connected: (service) => {
      if (service === 'gateway') gatewayLink?.connected()
      if (service === 'teams') teamsLink.on()
    },
    disconnected: (service) => {
      if (service === 'gateway') gatewayLink?.disconnected()
      void terminalWatch.gone(service)
    },
  })
  serviceLinksRef = serviceLinks
  // A request a service declared goes to it: in its own process, or in this one (core/serviceHost.ts).
  backend.serviceRouter = (type, payload, asker, reply) => (teamsOut && teamsLink.route(type, payload, asker, reply))
    || serviceLinks.route(type, payload, asker, reply) || serviceHost.route(type, payload, asker, reply)
  // Session search (services/search.ts): in this process, or in its own (services/searchProcess.ts),
  // where the core tells it what changed. A purge's forgetting waits for it if it is down.
  if (outOfProcess.has('search')) {
    ports.search = {
      touch: (sessionId) => { serviceLinks.notify('search', { type: 'service_event', payload: { kind: 'touch', sessionId } }) },
      deleteHistory: (sessionId) => { serviceLinks.notify('search', { type: 'service_event', payload: { kind: 'deleteHistory', sessionId } }, { untilDelivered: true }) },
      session: () => undefined,
      stop: () => {},
    }
  } else {
    serviceHost.start('search', inline!.startSearch, coreApi, SEARCH_FALLBACKS, SEARCH_REQUESTS)
  }
  // What the core calls search through: guarded, so it answers its fallbacks once search is switched off.
  const sessionSearch = ports.search
  // The DSH viewers: in this process, or in its own (services/viewersProcess.ts), told of each agent.
  if (outOfProcess.has('viewers')) ports.viewers = viewersLink.port
  else serviceHost.start('viewers', inline!.startViewers, coreApi, VIEWERS_FALLBACKS)
  // Workspaces: in this process, or in the edge host (services/workspacesProcess.ts), told what to do and when.
  if (outOfProcess.has('workspaces')) ports.workspaces = workspacesLink.port
  else serviceHost.start('workspaces', inline!.startWorkspaces, coreApi, WORKSPACES_FALLBACKS)
  // The orchestrator, an experiment (services/orchestrator.ts): in this process, or in its own once it is on,
  // as the core sees it there (core/orchestratorLink.ts). It reads its Directors' turns from the frames sent.
  if (outOfProcess.has('orchestrator')) ports.orchestrator = orchestratorLink.port
  else serviceHost.start('orchestrator', inline!.startOrchestrator, coreApi, ORCHESTRATOR_FALLBACKS, ORCHESTRATOR_REQUESTS)
  backend.onFrameSent = (frame) => ports.orchestrator?.frame(frame)
  // Share (services/sharing.ts): in this process, or in its own once it is on (core/sharingLink.ts). Its
  // observers' frames reach it as the relay hands them over.
  if (outOfProcess.has('sharing')) ports.sharing = createSharingLink({ call: (type, payload) => serviceLinks.call('sharing', type, payload), notify: (frame) => serviceLinks.notify('sharing', frame) })
  else serviceHost.start('sharing', inline!.startSharing, coreApi, SHARING_FALLBACKS, SHARE_REQUESTS)
  backend.observers = { receive: (connId, type, payload) => ports.sharing?.observer(connId, type, payload), closeAll: () => ports.sharing?.linkDown() }
  // Tab collaboration and teams (services/collaboration.ts): in their own process, or in this one behind the
  // service host's guard (a fault there costs no message its write), the prompt scopes the service's own.
  if (teamsOut) ports.teams = teamsLink.scopes
  else serviceHost.start('teams', inline!.startTeamsInCore, coreApi, TEAMS_FALLBACKS, TEAMS_REQUESTS)
  // The harnesses installed here, and installing, updating and removing one (services/store.ts): in this
  // process, or beside the viewers in theirs (services/storeProcess.ts).
  if (!outOfProcess.has('store')) serviceHost.serve('store', inline!.startStore, coreApi, STORE_REQUESTS)
  // This machine's Claude and Codex rate limits, read with its own credentials (services/usage.ts): in this
  // process, or in the edge host (services/usageProcess.ts).
  if (!outOfProcess.has('usage')) serviceHost.serve('usage', inline!.startUsage, coreApi, USAGE_REQUESTS)
  // This machine's and each agent's resources, for the Monitor and the list's readings (services/monitor.ts):
  // in this process, or in the edge host (services/monitorProcess.ts), asked through its port (core/monitorLink.ts).
  if (outOfProcess.has('monitor')) ports.monitor = createMonitorLink((type, payload) => serviceLinks.call('monitor', type, payload))
  else serviceHost.start('monitor', inline!.startMonitor, coreApi, MONITOR_FALLBACKS, MONITOR_REQUESTS)
  // An agent's branch and pull request, a project's repository and preview, a folder's subfolders and a
  // media file from an agent's project (services/projects.ts): in this process, or in the edge host.
  if (!outOfProcess.has('projects')) serviceHost.serve('projects', inline!.startProjects, coreApi, PROJECTS_REQUESTS)
  serviceHost.serve('shell', startShell, coreApi, SHELL_REQUESTS)
  // Models: grid access and its pin, the model pictures on agents' frames, the keystroke prewarm, where an
  // agent on a grid model sends its inference, and the models requests the apps send (services/models.ts):
  // in this process, or in its own (services/modelsProcess.ts), reached through core/modelsLink.ts.
  if (outOfProcess.has('models')) ports.models = modelsLink.port
  else serviceHost.start('models', inline!.startModels, coreApi, MODELS_FALLBACKS, MODELS_REQUESTS)
  // What the socket asks of models: read on each use, so a models service switched off answers its fallbacks.
  backend.models = () => ports.models ?? MODELS_OFF

  const runtimeController = new RuntimeProfileController({
    manager: runtimeProfiles,
    getSession: (id) => registry.resolve(id),
    validateRuntime: validateTerminal,
    capture: captureTerminal,
    sendText: submitTerminal,
    sendLiteral: typeTerminal,
    sendKey: keyTerminal,
    acquireInput: acquireTerminalControl,
  })
  /**
   * Engine session id → the agent that owns it. The event stream speaks in ENGINE session ids while
   * anything the user addresses (input queue, control lock, every outbound frame) belongs to the AGENT,
   * which outlives the session it is currently bound to.
   */
  const agentIdFor = (sessionId: string): string => registry.bySession(sessionId)?.agentId ?? sessionId


  backend.runtimeProfileProvider = (session) => runtimeProfiles.selectedModel(session)
  backend.dshFrameProvider = (s) => ports.viewers?.frameContext(s) ?? null
  // `harness remote` names the tile it was typed in by its tmux pane; the registry knows whose it is.
  backend.onTerminalHandoff = (tmuxPane) => registry.advertised()
    .find((session) => session.tmuxPane === tmuxPane
      || session.runtimes.some((runtime) => runtime.backend === 'tmux' && runtime.paneId === tmuxPane))?.agentId ?? null
  // A rename, a model and effort, or an app opening an agent (core/agents/update.ts).
  backend.agentUpdateProvider = createAgentUpdate({
    registry, clients: backend, toProject: (s) => backend.toProject(s), closeAgentService: () => backend.closeAgentService,
    onAgentRename: (session, name) => { void terminals.setTitle(session, name) },
    onRuntimeProfileUpdate: (sessionId, selectedModel) => runtimeController.setProfile(sessionId, selectedModel),
  }).agentUpdate
  runtimeProfiles.onChanged = (sessionId) => {
    const session = registry.resolve(sessionId)
    if (session) syncSession(session)
  }

  // Turn heartbeats (core/turns/heartbeats.ts).
  const turnBeats = createHeartbeats({
    bySession: (sessionId) => registry.bySession(sessionId),
    sessionTurnOpen,
    agentIdFor,
    runtimeActivity,
    turnActivity,
    mirror,
    clients: backend,
  })
  const heartbeats = turnBeats.heartbeats
  const turnStartedAt = turnBeats.turnStartedAt
  const stopHeartbeat = turnBeats.stopHeartbeat
  const startHeartbeat = turnBeats.startHeartbeat

  // Everything the funnel feeds exists now: install it, and deliver what waited.
  funnel.arm({
    bySession: (sessionId) => registry.bySession(sessionId),
    tokenUsage: agentTokenUsage,
    agentIdFor,
    turnActivity,
    isSubagentSession,
    clients: backend,
    search: sessionSearch,
    turnStartedAt,
    input,
    teams,
    deviceInput,
    device: () => autonomousDeviceService,
    startHeartbeat,
    questionWatcher,
    mirror,
  })
  // Cursor's Task hooks and the sub-agents they start (core/engines/cursorTasks.ts).
  const cursorTasks = createCursorTaskHooks({ emitSessionEvents, watcher, registry, cursorNormalizers })
  const cursorSubagents = cursorTasks.cursorSubagents
  const cursorTaskHooks = cursorTasks.cursorTaskHooks
  const onCursorTaskStart = cursorTasks.onCursorTaskStart

  // Release a session's binding, or remove a process-owned agent everywhere (core/agents/forget.ts).
  const forgetSession = createForgetSession({
    registry,
    stoppedAgents,
    syncRecapPool,
    normalizers,
    turnStartedAt,
    neverFoldedHistory,
    replayedFirstTurn,
    clearAgyIdleWatch,
    cursorDiscovery,
    cursorSubagents,
    runtimeProfiles,
    watcher,
    stopHeartbeat,
    teams,
    input,
    deviceInput,
    detachDsh,
    mirror,
    clients: backend,
    dataDir: env.ADAPTER_DATA_DIR,
  })

  const retainExitedSession = createRetainExitedSession({
    stoppedAgents,
    registry,
    send: frame => backend.send(frame),
    publishStoppedAgent: saved => backend.publishStoppedAgent(saved),
    // A terminal is never the dial's business, and `syncSession` forces that for it anyway.
    announceSession: session => announceSession(session, { device: false }),
    invalidateTerminalControl,
    forgetInput: agentId => { teams.forget(agentId); input.forget(agentId); deviceInput.forget(agentId) },
    detachDsh,
    syncRecapPool,
    warn: (message, error) => console.warn(message, error),
  })
  const keepAbandonedConversation = createKeepAbandonedConversation({ stoppedAgents, publishStoppedAgent: (saved) => backend.publishStoppedAgent(saved) })



  // Binding a session to its agent, and a running process to its session (core/agents/bind.ts).
  const binding = createBinding({
    registry,
    mirror,
    forgetSession,
    clients: backend,
    attachSession,
    announceSession,
    stoppedAgents,
    syncRecapPool,
    teams,
    input,
    deviceInput,
    homes: { copilot: env.COPILOT_HOME, grok: env.GROK_HOME, agy: env.AGY_HOME },
  })
  const pendingForkInherit = binding.pendingForkInherit
  const handleRegistered = binding.handleRegistered
  const bindObservedAgent = binding.bindObservedAgent

  // What the reconciler's scans mean for the registry (core/agents/discovery.ts).
  const discovery = createDiscoveryHandlers({
    registry,
    attachDsh,
    forgetSession,
    announceSession,
    bindObservedAgent,
    syncRecapPool,
    attachSession,
    invalidateTerminalControl,
    teams,
    input,
    deviceInput,
    questionWatcher,
    stopHeartbeat,
    retainExitedSession,
    stoppedAgents,
    restoreDegraded: (agentId) => restoreFailed || restoreUnsurveyed.has(agentId),
  })
  // HARNESSD_TEST_SLOW_PROBE_MS holds each discovery probe for up to that long, at random, before it is
  // applied: some scans land at once and some straddle an agent's start, as on a loaded machine. The
  // end-to-end suite uses it to put a scan across an engine's start on purpose (e2e/core.e2e.ts).
  const slowProbeMs = Number(process.env.HARNESSD_TEST_SLOW_PROBE_MS) || 0
  const agentReconciler = new TerminalAgentReconciler({
    // The hook server starts before restore. Its early SessionStart hints must not run a full
    // discovery scan over rows whose panes have not been recreated yet (and archive those rows).
    deferUntilStart: true,
    current: () => registry.list(),
    backends: terminalBackends,
    backendOrder: terminalConfig.backends,
    transaction: (apply) => registry.transaction(apply, { holdSavesMs: RECONCILE_PASS_DEADLINE_MS }),
    ...(slowProbeMs > 0 ? {
      probe: async (hints: Parameters<typeof probeTerminalAgents>[3]) => {
        const probe = await probeTerminalAgents(terminalBackends, terminalConfig.backends, process.pid, hints)
        await new Promise((resolve) => setTimeout(resolve, Math.random() * slowProbeMs))
        return probe
      },
    } : {}),
    ...discovery,
    onProbeStatus: (status) => {
      discoveryReady = status.ready
      discoveryError = status.error
    },
  })

  /** Proxy a control-plane call to backend using THIS daemon's own SSO session — the local caller
   *  (e.g. the desktop app) never needs a bearer token of its own, loopback trust does the
   *  authenticating. Forwards backend's response status/body verbatim, success or error alike, so a
   *  local client's model layer needs zero special-casing versus talking to backend directly. */
  //
  //  A backend that cannot be reached, or does not answer in time, is reported in the SAME shape
  //  (`{success:false, error:{code,message}}`, 502/504) rather than thrown: the hook server runs each
  //  request as a void-discarded async, so a throw here was an unhandledRejection and a local request
  //  that NEVER got a response — the desktop app then sat on its 30s receive timeout and printed a
  //  DioException where "the backend is down" belonged. Same for a backend that accepts the request
  //  and hangs (a Redis presence lookup, say): `fetch` waits forever by default, and the app's
  //  timeout fired first. The bound is shorter than that timeout on purpose, so the daemon is the one
  //  that answers, with a sentence.
  async function proxyBackend(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const failure = (status: number, code: string, message: string): { status: number; body: Record<string, unknown> } =>
      ({ status, body: { success: false, error: { code, message } } })
    let accessToken: string
    try {
      accessToken = await auth.accessToken()
    } catch (err) {
      // No session, or one the SSO service will never renew, is the caller's 401 — the answer the
      // backend itself would give — not a backend fault; a refresh the service could not serve right
      // now is. Telling them apart is what lets a local client say "sign in again" only when true.
      const signedOut = err instanceof AuthSessionError && err.code !== 'UNAVAILABLE'
      return failure(signedOut ? 401 : 502, signedOut ? 'NOT_SIGNED_IN' : 'AUTH_UNAVAILABLE', err instanceof Error ? err.message : String(err))
    }
    const latest = readAuthSession()
    let res: Response
    try {
      res = await fetch(`${backendHttpBase()}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${accessToken}`,
          'x-autonomous-env': latest?.autonomousEnv ?? env.AUTONOMOUS_ENV,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(PROXY_BACKEND_TIMEOUT_MS),
      })
    } catch (err) {
      const e = err as Error & { cause?: { message?: string } }
      if (e.name === 'TimeoutError' || e.name === 'AbortError') {
        return failure(504, 'BACKEND_TIMEOUT', `The Harness backend did not answer ${method} ${path} within ${PROXY_BACKEND_TIMEOUT_MS / 1000}s. Try again in a moment.`)
      }
      // undici wraps the socket error as `TypeError: fetch failed` with the real one in `cause`.
      const why = e.cause?.message ?? e.message
      return failure(502, 'BACKEND_UNREACHABLE', `Could not reach the Harness backend (${why}). Check the connection and try again.`)
    }
    const json = await res.json().catch(() => ({})) as Record<string, unknown>
    const result = { status: res.status, body: json }
    return result
  }

  /**
   * The machine list a signed-out daemon answers with: this computer, alone.
   *
   * Null when there is a session — then the backend's own list is the answer, and this must not shadow
   * it. `authMode: 'remote'` is what a computer-backed machine is once it has an account, said now so
   * nothing downstream has to special-case a guest row.
   */
  function guestMachinesBody(): Record<string, unknown> | null {
    if (readAuthSession()) return null
    const id = computerId()
    return {
      success: true,
      data: {
        machines: [{
          machineId: id,
          computerId: id,
          name: terminalHintMachineName(),
          hostname: hostname(),
          status: 'online',
          authMode: 'remote',
        }],
        stale: false,
        guest: true,
      },
    }
  }

  const machineListCache = new MachineListCache(
    () => proxyBackend('GET', '/api/machines'),
    computerId,
    (line) => console.log(`[cable] ${line}`),
    undefined,
    // A machine row is per (user, computer): the one local fact that distinguishes two ACCOUNTS here.
    // Read fresh each time — a re-login swaps it under a daemon that never restarted.
    () => readAuthSession()?.machineId ?? null,
  )
  // Which of the owner's other computers have been reading offline — a label on the models only they
  // serve on a sleeping grid, never a removal (grid-reads-without-waking issue 03).
  machineListCache.listen((body) => ports.models?.machines(body, computerId()))
  // The trust group swaps rosters only with the members the backend last said were online (gateway/start.ts).
  machineListCache.listen(() => {
    const { machines, source } = machineListCache.list()
    gatewayOps.reachable(source !== 'backend' ? null : machines.filter((m) => m.state !== 'offline').map((m) => m.machineId))
  })

  /**
   * `GET /api/machines` for local clients, answered from the last known-good list when the backend leg
   * is down.
   *
   * The daemon already keeps that list: it re-reads it every 60s for the dial's wheel and persists it to
   * `machines.json`, with the explicit policy that an outage keeps the rows and stops claiming they are
   * live. The desktop app was the one consumer that got none of that — a bare pass-through handed it the
   * 502 and it had nothing to draw, so a ten-second network blip emptied the machine list and left every
   * pane spinning. Stale rows are not wrong rows; the marker below says which they are.
   */
  async function machinesListWithFallback(): Promise<{ status: number; body: Record<string, unknown> }> {
    // ⚠️ SIGNED OUT, THE LIST IS THIS COMPUTER — never the backend's 401.
    //
    // 401 is the one status the desktop app reads as "the session ended": it tears its connections
    // down and puts a sign-in wall in front of agents that were running fine a moment ago. Nothing
    // here needs the backend to say what this computer is. The row is the shape the backend would
    // send, keyed by the durable computer id this daemon is already serving under, so the app
    // classifies it exactly as it will after a sign-in — local by computerId — with no guest-only
    // branch for anyone to forget.
    const guest = guestMachinesBody()
    if (guest) {
      // Into the same cache the dial's wheel reads, so the two surfaces cannot disagree about a
      // machine list one of them was handed directly.
      machineListCache.adopt(guest)
      return { status: 200, body: guest }
    }
    const res = await proxyBackend('GET', '/api/machines')
    if (res.status === 200) {
      // Feed the cache the answer we already have rather than making it fetch the same thing again.
      machineListCache.adopt(res.body)
      return res
    }
    // A real end of session is the caller's answer, not an outage: never serve a list from behind it.
    if (res.status === 401 || res.status === 403) return res
    const cached = machineListCache.lastResponse()
    if (!cached) return res
    return { status: 200, body: withStaleMarker(cached.body, cached.fetchedAt) }
  }


  // Local dashboard (GET /api/status): adapter health + computer fingerprint + local pairings. It
  // deliberately does NOT expose chat/transcripts — those live in the cloud web (WEB_URL/commander). The
  // fingerprint and the pairings are the gateway's, asked for each time (bounded: core/gatewayLink.ts).
  const statusBody = async (relay: GatewayStatus): Promise<Record<string, unknown>> => ({
      machineId: backend.machineId,
      computerId: computerId(),
      // Whether this daemon booted with an account. Read LIVE, not from the boot session: a login or
      // logout restarts the daemon, and the window between the file changing and the restart landing
      // is exactly when the app asks — the answer it needs is the file's.
      signedIn: readAuthSession() !== null,
      version: VERSION,
      localWs: {
        path: LOCAL_WS_PATH,
        protocolVersion: LOCAL_WS_PROTOCOL_VERSION,
        terminalProtocolVersion: TERMINAL_BINARY_VERSION,
        e2ee: false,
      },
      // The same REST and local WS, over the daemon's Unix socket (lib/localSocket.ts). Null where
      // none could be opened; clients then stay on this port.
      localSocket: daemonBoot.localSocket?.path ?? null,
      backendUrl: env.BACKEND_WS_URL,
      autonomousEnv,
      dataDir: env.ADAPTER_DATA_DIR,
      authDir: AUTH_DIR,
      webUrl: env.WEB_URL,
      connected: backend.isConnected(),
      deviceTransportConnected: backend.hasCommander(),
      deviceE2eeConnected: backend.deviceE2eeConnected(),
      uptimeSec: Math.round((Date.now() - startedAt) / 1000),
      // The daemon as everything outside knows it: the pid file's pid, which `harness stop` signals
      // and the desktop app judges the owner of. Under a master that is the master's. A core's pid
      // changes with every restart, and macOS counts a core as its master's, so an app judging the
      // core would read a daemon started from tmux or ssh as "owned by node" and restart it on sight.
      pid: coreLink.masterPid ?? process.pid,
      corePid: process.pid,
      startedAt,
      // The master keeping this core running, when one is: how often it has restarted it, and why the
      // last one ended. Null for a core run on its own.
      harnessd: coreLink.supervised ? { masterPid: coreLink.masterPid, ...coreLink.status() } : null,
      // True for the few hundred ms between an update being staged and this server closing for the
      // handoff. Informational: nothing should build readiness on a field the server stops serving.
      restarting: updateHandoff.restarting(),
      discoveryReady,
      discoveryError: discoveryError ?? (tmuxUnavailable ? `tmux unavailable: ${tmuxUnavailable}` : null),
      // Present only when start-up failed and this daemon is holding the machine open for its
      // updater. Clients key on `discoveryReady`; this says WHY, in one word, for a person reading it.
      ...(daemonBoot.safeMode ? { safeMode: true } : {}),
      // Agents whose history is being read right now, and how many wait their turn. Normally empty or
      // gone in a second; one that stays here names the store that is slow, which no other field does.
      attaching: attaches.attaching(),
      attachQueue: attaches.queued(),
      fingerprint: relay.fingerprint,
      config: {
        watching: `${terminalConfig.backends.join(' + ')} terminals across all supported engines`,
        terminalBackends: terminalConfig.backends,
        terminalSelection: backendsExplicit ? 'configured' : 'auto',
        terminalTargets: [
          ...(tmuxBackend ? [{ backend: 'tmux', instance: 'default', state: 'configured' }] : []),
        ],
        dormantAgents: registry.list().filter((session) => !session.active).length,
        dataDir: tildify(env.ADAPTER_DATA_DIR),
        port: daemonPort(),
      },
      sessions: await Promise.all(registry.advertised().map(async (s) => ({
        id: s.agentId,
        sessionId: s.sessionId,
        name: projectDisplayName(s),
        engine: s.engine,
        cwd: tildify(s.cwd ?? ''),
        tmuxPane: s.tmuxPane || null,
        terminal: { available: registry.terminalAvailable(s.agentId), primary: s.primaryRuntimeKey, runtimes: s.runtimes },
        // When the conversation last moved, as in every agent frame — not the row's `touchedAt`.
        updatedAt: await lastActivityAt(s),
      }))),
      pairs: relay.pairs,
      pending: relay.pending,
    })

  const turnHooks = createTurnHooks({
    resolve: (id) => registry.resolve(id),
    normalizers,
    emit: (sessionId, events) => emitSessionEvents(sessionId, events),
    drain: (sessionId) => watcher.pollSession(sessionId),
    onCursorTaskStart,
    cursorTaskHooks,
    cursorSubagents,
    announceTurnAborted,
    armAgyIdleWatch,
    clearAgyIdleWatch,
    mirror,
    dataDir: env.ADAPTER_DATA_DIR,
  })
  // Which agent a hook belongs to, and what a SessionEnd means (core/engines/hooks.ts).
  const engineHooks = createEngineHooks({ tmuxBackend, agentReconciler, registry })
  const { server: hookServer, port: hookPort, localSocket } = await startHookServer(daemonPort(), {
    onCommandBar: commandBarService,
    onAutonomousDeviceRequest: async (method, target, body) => {
      // Until the pieces below are built; after, a piece that could not be is refused by the requests
      // that need it, and the rest (list, status, revoke) answer from the pairings.
      if (!devicePartsBuilt) return { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'Autonomous device service is starting' } } }
      // The Wi-Fi device's pairings and direct links are the gateway's (gateway/start.ts); its receipts the
      // device service's, here.
      const viaGateway = async (request: Parameters<GatewayOps['wifi']>[0]): Promise<Record<string, unknown>> => {
        const answer = await gatewayOps.wifi(request)
        if ('refused' in answer) throw Object.assign(new Error(answer.refused.message), { code: answer.refused.code })
        return answer.result
      }
      return autonomousDeviceLocalRequest({
        discover: () => viaGateway({ op: 'discover' }),
        pairStart: ({ code, device }) => viaGateway({ op: 'pair', code, device }),
        pairStatus: () => viaGateway({ op: 'pairStatus' }),
        list: () => viaGateway({ op: 'list' }),
        status: async () => ({ transport: 'direct', connected: backend.directAutonomousDeviceSessions() > 0,
          paired: ((await viaGateway({ op: 'list' })).devices as unknown[]).length, sessions: backend.directAutonomousDeviceSessions(), proto: 1 }),
        revoke: ({ id }) => viaGateway({ op: 'revoke', id }),
        receipt: target => ({ receipt: runningDevicePart(autonomousDeviceService, 'Wi-Fi device service').receipt(target.deviceId, target.idempotencyKey) }),
      }, method, target, body)
    },
    resolveHookAgent: engineHooks.resolveHookAgent,
    onRegistered: handleRegistered,
    onPromptSubmitted: (id, text) => teams.started(id, text, 'hook', registry.byAgent(id)?.engine),
    onSessionEnd: engineHooks.onSessionEnd,
    // What the engines' own hooks say about a turn (core/turns/turnHooks.ts).
    onTurnStart: turnHooks.onTurnStart,
    onToolStart: turnHooks.onToolStart,
    onTurnStop: turnHooks.onTurnStop,
    // `harness pair`, `unpair`, `remote-password`, `link connect`, `group` and `devices`: the keys are the
    // gateway's, and so are these answers (gateway/start.ts).
    onPair: (code) => gatewayOps.pair(code),
    onListPairs: () => gatewayOps.listPairs(),
    onRevoke: (id) => gatewayOps.revoke(id),
    onRevokeAll: () => gatewayOps.revokeAll(),
    onSetRemotePassword: (password) => gatewayOps.setRemotePassword(password),
    onClearRemotePassword: () => gatewayOps.clearRemotePassword(),
    onRemotePasswordStatus: () => gatewayOps.remotePasswordStatus(),
    onTrustLinkedPeer: (peer) => gatewayOps.trustLinkedPeer(peer),
    onGroupList: () => gatewayOps.groupList(),
    onGroupSync: () => gatewayOps.groupSync(),
    onGroupRemove: (selector) => gatewayOps.groupRemove(selector),
    onDevicesList: () => gatewayOps.devicesList(),
    onDevicesRemove: (pub) => gatewayOps.devicesRemove(pub),
    onDevicesHistory: () => gatewayOps.devicesHistory(),
    onDevicesDismiss: (body) => gatewayOps.devicesDismiss(body),
    onDevicesRebaseline: (confirm, head) => gatewayOps.devicesRebaseline(confirm, head),
    onStatus: async () => statusBody(await gatewayOps.status()),
    onLogs: () => {
      try { return readFileSync(LOG_FILE, 'utf-8').split('\n').slice(-120).join('\n') } catch { return '' }
    },
    onStop: () => { setTimeout(() => process.kill(process.pid, 'SIGTERM'), 50) }, // let the 200 flush first
    onMachinesList: () => machinesListWithFallback(),
    onMachineRename: (machineId, name) => proxyBackend('PATCH', `/api/machines/${encodeURIComponent(machineId)}`, { name }),
    onMachineDelete: (machineId) => proxyBackend('DELETE', `/api/machines/${encodeURIComponent(machineId)}`),
    onAuthMe: () => proxyBackend('GET', '/api/auth/me'),
    onAuthHandoff: () => proxyBackend('POST', '/api/auth/handoff', {}),
    // Signed out there is nothing shared WITH this computer and nobody to ask: a share is made on the
    // account. Answered as an empty list rather than proxied into the backend's 401, which is the one
    // status the desktop app reads as "your session ended" — and a guest has no session to end.
    onSharedHarnesses: () => readAuthSession()
      ? proxyBackend('GET', '/api/harness-shares')
      : Promise.resolve({ status: 200, body: { success: true, data: { machines: [] } } }),
    // The account's desk — see backend routes/desk.ts. The window edits its tabs through the ops
    // route and hears about everyone else's edits as `desk_changed` (backendSocket.ts).
    onDeskRead: () => proxyBackend('GET', '/api/desk'),
    onDeskOps: (body) => proxyBackend('POST', '/api/desk/ops', body),
    onExperimentalRead: () => proxyBackend('GET', '/api/experimental-settings'),
    onExperimentalWrite: (body) => proxyBackend('PATCH', '/api/experimental-settings', body),
    onStore: (method, path, body) => proxyBackend(method, path, body),
  }, { socketPath: localSocketPath(env.ADAPTER_DATA_DIR, env.PORT), allowPortFallback: true })
  try { saveDaemonPort(env.ADAPTER_DATA_DIR, env.PORT, hookPort) } catch (error) {
    await localSocket?.close()
    hookServer.close()
    throw error
  }
  publishHookRoute(env.ADAPTER_DATA_DIR, hookPort)
  // Claim the pid file for OURSELVES, and only now that the control port is bound. It used to be
  // written by whoever spawned us — so a parent that died mid-handover left a daemon nothing could
  // manage — and then, for a while, by us at the top of this function, before the bind — so a child
  // that LOST the port to a sibling still left a file naming itself, a corpse, over the winner. A
  // process that is running AND holds the port is the only honest author of its own pid; that claim
  // is also the signal `harness start` and the update handoff wait on to know the bind succeeded.
  // Under harnessd the master claims it, for itself, when this core says it is bound.
  if (coreLink.supervised) {
    coreLink.bound(hookPort)
    coreLink.startHeartbeat()
    // The experiments with saved state are on: their processes are asked for now, the master heeding a
    // bound core alone (core/experiments.ts). The others wait for their first request.
    wakeExperiments({ dataDir: env.ADAPTER_DATA_DIR, experiments: EXPERIMENTS, outOfProcess, want: (service) => experimentHooks.want(service) })
  } else {
    try { writeFileSync(PID_FILE, String(process.pid) + '\n') } catch { /* best effort */ }
  }
  // The one thing a handoff that happens before start-up finishes has to release: the port has no
  // fallback, so a successor that cannot bind it is a daemon that does not come up (see bootHandoff).
  daemonBoot.hookServer = hookServer
  daemonBoot.localSocket = localSocket
  console.log(`[cli] daemon pid ${process.pid} · v${VERSION}${process.env.ADAPTER_UPDATED_TO ? ' · updated' : ''} · listening on 127.0.0.1:${hookPort}`)
  // The device key log records which sign-in this machine is under: a session from before sign-in epochs
  // gets one first, adopted so it never starts the log over, and the gateway registers with it then.
  if (session?.machineId) void ensureSignInEpoch().catch(() => null).then(() => gatewayOps.account(account()))
  // The dial, the window bridges and the WiFi device answer for themselves. A throw in any of them is
  // logged — at most once a minute each, with a count of the rest (core/turns/funnel.ts) — and goes no
  // further: the local socket closes a connection whose frame handler throws, so a device fault left
  // unguarded here would disconnect the desktop, again on every pane change.
  const devices = outsideConsumers({ prefix: 'devices', faults: testFaults(process.env.HARNESSD_TEST_FAULTS) })

  // Spoken tasks go to the WINDOW to be routed, not to the copy of the router in this process.
  //
  // Built here because both ends need it: the local socket hands it the window's replies, and the cable
  // host (built much further down) asks through it. See cable/windowRoute.ts for the two-phase wait and
  // why "no window" and "a person is still choosing" must not be the same answer.
  const windowRouter = createWindowRouter({
    hasWindow: () => backend.hasLocalClient(),
    send: (voiceId, text, cmd) => {
      // sendLocal, never send: this asks the window in front of the dial to open a palette. Fanning it
      // out to the web audience would pop one open on a computer nobody is sitting at.
      backend.sendLocal({ type: 'voice_route_request', payload: { voiceId, text, ...(cmd ? { cmd } : {}) } })
      console.log(`[route] voice → the window · ${Buffer.byteLength(text, 'utf8')} bytes${cmd ? ` · /${cmd}` : ''}`)
    },
    log: (line) => console.log(`[cable] ${line}`),
  })

  const windowSelection: WindowSelection = new WindowSelection({
    focus: () => appVoiceFocus,
    send: (connId, payload) => localWsServer.sendToWindow(connId, { type: 'dial_selection', payload }),
  })
  const windowForm = new WindowForm({
    focus: () => appFormWindow,
    send: (connId, payload) => localWsServer.sendToWindow(connId, { type: 'dial_form', payload }),
    log: (line) => console.log(`[cable] ${line}`),
  })
  const windowVisit = new WindowVisit({
    focus: () => appVoiceFocus,
    send: (connId, payload) => localWsServer.sendToWindow(connId, { type: 'dial_visit', payload }),
  })
  const localWsServer = attachLocalWsServer(hookServer, {
    localSocketServer: localSocket?.server ?? null,
    services: serviceLinks,
    onSelectionReply: (connId, machineId, payload) => devices('window', () => windowSelection.reply(connId, machineId, payload)),
    onVisitReply: (connId, machineId, payload) => devices('window', () => windowVisit.reply(connId, machineId, payload)),
    onFormReply: (connId, machineId, payload) => devices('window', () => windowForm.reply(connId, machineId, payload)),
    onAppDisconnect: (machineId, connId) => {
      if (appFormWindow?.connId === connId) appFormWindow = undefined
      if (appVoiceFocus?.connId === connId) appVoiceFocus = undefined
      devices('window', () => windowForm.disconnected(connId))
      devices('window', () => windowSelection.focusChanged())
      devices('devices', () => autonomousDeviceService?.appFocus(machineId, null, connId))
    },
    // The window and the dial are one desk: opening an agent in the app brings the dial to it, switching
    // the dial's machine first when the app moved to another one.
    onDevicePrepareOpened: (operationId, agentId) => devices('devices', () => deviceStoreRef?.acknowledgeReveal(operationId, agentId)),
    onAppFocusState: (machineId, agentId, connId, expectedRevision) => {
      // A delayed automatic selection cannot replace a newer explicit user choice. A device service
      // that cannot say which choice is newest is one with no choice to protect: refused, as without one.
      let focusRevision: unknown
      devices('devices', () => { focusRevision = autonomousDeviceService?.focusSnapshot().focusRevision })
      if (expectedRevision && focusRevision !== expectedRevision) return false
      appFormWindow = { machineId, connId }
      if (agentId === null) {
        if (appVoiceFocus?.connId === connId) appVoiceFocus = undefined
      } else appVoiceFocus = { machineId, agentId, connId }
      devices('window', () => windowSelection.focusChanged())
      devices('devices', () => autonomousDeviceService?.appFocus(machineId, agentId, connId))
    },
    onAppFocus: (machineId, agentId) => devices('dial', () => { void cableRef?.followApp(machineId, agentId) }),
    // Everything the window still has unread. Held rather than acted on: the dial is handed it when a
    // cable attaches, which is the one moment its own drawer is known to be empty.
    onAppUnread: (items) => devices('dial', () => { cableHostRef?.setUnread(items); void cableRef?.replaceNotifications(items) }),
    // The window looked at a harness, so the dial's drawer row for it is stale.
    // The dial's own tap already reaches the window (`agent.open`); this is the
    // return leg, and the pair is what keeps the badge and the pill equal.
    onAgentSeen: (agentId, readToken) => devices('dial', () => { void cableRef?.agentSeen(agentId, readToken) }),
    // Agents the window has a tile for. A finished turn on one of these is
    // already in front of the person, so the dial updates its tile in silence
    // rather than beeping about something being looked at.
    //
    // An OPEN tile counts as seen, deliberately — not a focused one. With four
    // tiles on a grid all four are on screen, and asking which one the eye is
    // on is a question the window cannot answer honestly anyway.
    // The window's swarms. Relayed to the dial as its own list — the dial names the one on screen above
    // the agent and offers the rest — and, through setSwarms, what makes the desk strict: a present
    // window with an empty swarm is an empty carousel, not the whole machine.
    onAppSwarms: (swarms) => {
      appSwarmsLatest = swarms
      devices('dial', () => {
        cableHostRef?.setSwarms(swarms)
        void cableRef?.syncSwarms()
        void cableRef?.syncAgents()
      })
    },
    onAppTabAgents: (connection, ids) => cleanupTabs.updateWindow(connection, ids),
    onAppPanes: (agentIds, foreground) => {
      // ORDER matters here, not just membership. The dial's carousel is built
      // around these — tiles first, in tile order — so the thumb walks the same
      // grid the eyes are on. `openPaneAgents` below only ever asks "is this
      // one on screen", which is why it can stay a set.
      //
      // THE RING IS A FUNCTION OF THIS LIST, so a change here is a new ring and has to be pushed at once.
      // Leaving it to the next tick opened a one-second window with a real failure in it: clicking a rail
      // agent that has NO tile yet changes the desk and then immediately follows with the focus, and a
      // focus for an agent the dial's CURRENT ring does not walk is dropped on the device — it has no
      // column to centre on. The window moved, the dial did not, and nothing anywhere said why.
      const deskChanged = agentIds.length !== appPaneAgents.length
        || agentIds.some((id, at) => id !== appPaneAgents[at])
      appPaneAgents = agentIds
      // A tile behind a browser is not a tile anybody is looking at. The roster
      // does not change when the window loses focus, so without this the dial
      // went quiet about work nobody could see — the one case the notification
      // is for — while the window, which does check, spoke up. `openPaneAgents`
      // below is what `quiet` is read from, so emptying it is how both screens
      // come to the same answer.
      appWindowForeground = foreground
      devices('dial', () => cableHostRef?.setDesk(agentIds))
      const next = new Set(agentIds)
      // Logged on CHANGE only. It fires on every pane add, close and reconnect,
      // and it is the one place the whole feature is observable from — without
      // it, "the dial went quiet" and "the roster never arrived" look identical.
      const changed = next.size !== openPaneAgents.size || [...next].some((id) => !openPaneAgents.has(id))
      openPaneAgents = next
      if (changed) console.log(`[cable] window tiles: ${next.size ? [...next].map(sid).join(' ') : '(none)'}`)
      // Ordered, not set-wise: two tiles swapping places is the same set and a different ring.
      if (deskChanged) devices('dial', () => { void cableRef?.syncAgents() })
    },
    // ⌘K in the window: a typed task, and which agent it belongs to, on any of the owner's machines. The
    // fleet's to answer (services/fleet.ts routeTask), so it answers with the dial absent or off.
    onRouteTask: backend.ownerCommands.onRouteTask = async (text) => ports.fleet
      ? ports.fleet.routeTask(text)
      : { agentId: '', machineId: '', name: '', confidence: 0, reason: 'no agent list yet', candidates: [], weighed: 0, machines: 0, via: '' },
    // A window that connects after the dial did has missed the `dial_status` that announced it.
    dialStatus: () => {
      let status: ReturnType<DaemonCableHost['currentDialStatus']> | undefined
      devices('dial', () => { status = cableHostRef?.currentDialStatus() })
      return status ?? { attached: false }
    },
    /*
     * A window changing a device's settings. Addressed by the fleet's id, so a second robot on the same
     * desk is not dragged along — every other cable command broadcasts on purpose (they all show the
     * same desktop), but a preference belongs to the glass it was set on.
     *
     * Nothing is answered here. The device replies to its own `settings.set` with the values it now
     * holds, and that reaches the window as an ordinary `dial_status`.
     */
    onDialSettings: (id, patch) => devices('dial', () => {
      void cableRef?.setSettings(id, patch as Parameters<NonNullable<typeof cableRef>['setSettings']>[1])
        .then(result => {
          if (!result.ok) console.log(`[cable] settings for ${id || 'no device'}: ${result.error}`)
        })
    }),
    openQuestions: () => [...openQuestions.values()],
    // Committed. Sent through the fleet's router — the dial's own dispatch — and NOT straight into
    // backend.onMessage.
    //
    // That distinction is the whole of remote support: onMessage resolves the id against THIS computer's
    // registry, so a remote agent lands as "This harness is no longer available" — an error about an agent
    // that is alive and answering on another machine. sendTurn is the fork that already knows the
    // difference (local → the same door the web and the hooks use, remote → the fleet), and it is the
    // one the dial uses for every voice turn.
    onRouteSend: backend.ownerCommands.onRouteSend = (agentId, text) => {
      const sent = ports.fleet?.routeSend(agentId, text) ?? { ok: false as const, machine: '', reason: 'no agent list yet' }
      console.log(`[route] ⌘K → ${sid(agentId)} · bytes=${Buffer.byteLength(text, 'utf8')}`
        + (sent.ok ? '' : ` · REFUSED: ${sent.reason}${sent.machine ? ` (${sent.machine})` : ''}`))
      return sent
    },
    onVoiceRouteReply: (voiceId, reply) => devices('window', () => windowRouter.reply(voiceId, reply)),
    machineId: backend.machineId,
    backend,
    relayPool: gateway.windowRelay,
    autonomousEnv: readAuthSession()?.autonomousEnv ?? env.AUTONOMOUS_ENV,
    // A window from before it introduced itself still gets named on the far side's "took control"
    // banner: the relay knows it is this machine's desktop. Same source as `describeClient` above.
    // Cut to the wire's limit here rather than let the far daemon drop the whole claim over a long name.
    localClient: () => ({ kind: 'desktop', name: terminalHintMachineName().slice(0, 64), machineId: backend.machineId }),
  })
  // Every engine's hooks, pointed at the port the local server actually bound (core/engines/hooks.ts).
  if (!env.DISABLE_HOOK_INSTALL) installEngineHooks(hookPort, { only: env.HOOK_INSTALL_ENGINES, loginShell: loginShellEnvPromise })
  gatewayOps.dashboardPort(hookPort) // surfaced to the web (e2e_status) so it can link here to approve
  console.log(`[cli] local dashboard → http://127.0.0.1:${hookPort}`)

  // Each transcript line, through its engine's normalizer, into the funnel (core/transcripts/ingest.ts).
  const ingest = createIngest({
    has: (sessionId) => registry.has(sessionId),
    bySession: (sessionId) => registry.bySession(sessionId),
    tokenUsage: agentTokenUsage,
    device: () => autonomousDeviceService,
    runtimeProfiles,
    normalizers,
    announceTurnAborted,
    emit: (sessionId, events, opts) => emitSessionEvents(sessionId, events, opts),
    attachSession: (session, reset) => attachSession(session, reset),
  })
  ingest.wireWatcher(watcher)
  // Nothing re-attaches the registry's agents here. Every one of them is dormant from the moment the
  // registry loads (see the `setActive(false)` transaction at the top of this function), and the first
  // reconcile pass is what reactivates each one it finds a live process for — and attaches it, in the
  // background and a few at a time (`onObserved` above, `attaches` below). Readiness never waits on an
  // agent's history being read: one slow store used to hold the app out of every agent on the machine.
  /**
   * What the launch builder needs to know about THIS machine, read at launch time.
   *
   * The one fact is whether an administrator pinned Hermes settings in `/etc/hermes`: Hermes's web
   * tools ride a managed-scope overlay that REPLACES that directory rather than adding to it, and the
   * builder drops the overlay on such a machine (the agent launches on the grid without web tools,
   * and the app says so). Read here rather than in the contract because it is a fact about the
   * machine: a `build()` that stats the filesystem answers differently on two of them, and its spec
   * would follow. What is DONE with the fact lives in the builder, so create, retarget and restore
   * cannot disagree about it.
   *
   * The other is which OpenCode is installed: v2's TUI exits 1 on v1's `-m` / `--agent`. Cached per
   * installed file (`engines/opencode/version.ts`), so this costs a `stat` after the first read.
   */
  const gridLaunchMachine = (): GridLaunchMachine => ({
    hermesSystemManaged: existsSync(HERMES_SYSTEM_MANAGED_DIR),
    opencodeMajor: opencodeMajorVersion(),
  })

  /**
   * What a relaunch of `session` must be given, beyond the engine's argv, to come back where it was —
   * on its grid (the registry kept the launch, key included) or under its Codex profile. Restore and
   * restart read the row; retarget passes the override the desktop just sent. The config directory is
   * keyed on the agent, so relaunching the same agent rewrites one directory instead of leaving a trail.
   */
  const launchOverridesDeps: LaunchOverridesDeps = {
    machine: gridLaunchMachine,
    writeGridConfigDir,
    tmuxSupportsSessionEnv,
    installCodexHooks: (codexHome) => { if (!env.DISABLE_HOOK_INSTALL) installCodexHooks(hookPort, codexHome) },
    dshLaunch: (id, workspace, engine, runtimeKey) => {
      const installed = installedDsh(id)
      if (!installed) {
        console.warn(`[dsh] ${id} is not installed on this machine · cannot restore its harness context`)
        return null
      }
      return prepareHarnessLaunch(installed, workspace, engine, runtimeKey, { privateGrid: backend.gridName() }, null)
    },
  }
  // What a relaunch needs to bring a pane back (core/agents/launch.ts). Declared before the restore
  // pass below, which calls these for every pane it rebuilds.
  const launchHelpers = createLaunchHelpers({
    prepareApiTools,
    savedApis,
    launchOverridesDeps,
    setGridLaunch: (agentId, launch) => registry.setGridLaunch(agentId, launch),
    setTail: (sessionId, offset) => watcher.setTail(sessionId, offset),
  })
  const relaunchOverrides = launchHelpers.relaunchOverrides
  const refreshGridWebSearch = launchHelpers.refreshGridWebSearch
  const downgradedPermission = launchHelpers.downgradedPermission
  const prepareSessionResume = launchHelpers.prepareSessionResume

  // Rows that drifted out of their project folder while `register` still took the hook's cwd on
  // every prompt are put back BEFORE anything relaunches them: restore below `cd`s into `entry.cwd`,
  // and what it archives on the way is copied from the row. See cwdRepair.ts.
  // Best effort: an archive directory that cannot be listed, or a row that cannot be rewritten, is a
  // line in the log, never a daemon that does not come up.
  try {
    const repaired = await repairClaudeCwd({ registry, stoppedAgents, log: (message) => console.log(message) })
    if (repaired.registry || repaired.archived) console.log(`[repair] cwd · ${repaired.registry} live · ${repaired.archived} saved`)
  } catch (error) {
    console.warn(`[repair] cwd repair skipped · ${error instanceof Error ? error.message : error}`)
  }
  watcher.start()
  await cursorDiscovery.start()
  // What a restored agent's engine writes from here on is live: the first attach of each folds its
  // conversation only up to this byte (core/transcripts/relaunch.ts). The request gate opens before
  // those attaches run, and a message answered in between was filed as history.
  for (const entry of registry.list()) {
    if (!entry.sessionId || !entry.transcriptPath || watcher.tails(entry.sessionId, entry.transcriptPath)) continue
    const offset = transcriptSize(entry.transcriptPath)
    if (offset !== null) relaunchMarks.note(entry.sessionId, offset)
  }
  // Panes that died while the daemon was down (a reboot takes the whole tmux server with it) are
  // rebuilt BEFORE the first reconcile pass: it would otherwise count them absent, and a second
  // pass five seconds later would drop the agents for good. Pane creation is awaited so the first
  // announce already shows every restored agent with a terminal; binding their engine processes
  // continues in the background, the same way `agent_create` does it.
  for (const entry of registry.list()) {
    const saved = isTerminalEngine(entry.engine) ? stoppedAgents.get(entry.agentId) : null
    if (saved && !isTerminalEngine(saved.engine)) retainExitedSession(entry, true)
  }
  if (tmuxBackend) {
   // Best effort, like the cwd repair above it: panes that cannot be rebuilt cost this boot its
   // tiles, not the daemon. `restoreDegraded` then stops discovery retiring the rows whose panes
   // restore never got to, so the next daemon can put them back.
   try {
    const backend = tmuxBackend
    const summary = await restoreAgents({
      retainStopped: retainExitedSession,
      keepAbandoned: keepAbandonedConversation,
      registry,
      engineStarted: (sessionId) => relaunchMarks.engineStarted(sessionId),
      // "Alive" means the pane still runs THIS row's engine — not merely that tmux knows the id.
      // A new tmux server hands out `%N` from zero again, so a stale id can name someone's shell;
      // and a pane that outlived the daemon in a session discovery no longer lists still has its
      // engine, which a second pane resuming the same session would collide with.
      ...tmuxSurvey(() => listTmuxPanes(), lookupPaneEngineProcess),
      buildLaunch: async (entry, opts) => {
        // A folder that went away with the reboot (an unmounted volume, a workspace deleted while the
        // daemon was down) is a named failure on the tile, not a pane that prints an error and exits.
        const missing = workspaceMissing(entry.cwd)
        if (missing) return { error: missing.error, detail: missing.detail }
        // Mirrors `agent_create`: the same grid env/argv (and the same vendor variables cleared), or
        // the same Codex profile with its hooks installed; the install check runs inside the pane's
        // own shell.
        const built = await relaunchOverrides(entry)
        if (!built.ok) return { error: built.error, detail: built.detail }
        if (opts.resumeSessionId) {
          try { prepareSessionResume(entry) } catch (error) {
            return { error: 'RESUME_PREPARATION_FAILED', detail: error instanceof Error ? error.message : String(error) }
          }
        }
        // Before the pane comes up rather than after: restore has no later hook per agent, and a
        // pane that fails to come up is reported failed by the frame regardless of this field.
        refreshGridWebSearch(entry.agentId, built.overrides)
        const { env: launchEnv, extraArgs, clearEnv } = built.overrides
        // The engine may have been downgraded while the daemon was down. Coming back in Ask beats
        // coming back as a pane of help text, and beats not coming back at all.
        const permission = await downgradedPermission(entry, entry.bypassPermission === true, 'restore')
        const argv = buildEngineLaunchArgv(entry.engine, {
          ...opts,
          bypassPermission: permission.bypassPermission === true,
          ...(permission.permissionMode ? { permissionMode: permission.permissionMode } : {}),
          installIfMissing: enginePathOverride(entry.engine) ? undefined : engineInstallRecipe(entry.engine),
          ...(entry.cwd ? { cwd: entry.cwd } : {}),
          ...(extraArgs.length ? { extraArgs } : {}),
          ...(clearEnv.length ? { clearEnv } : {}),
          ...(launchEnv.HARNESS_DSH ? { harnessNode: true } : {}),
        })
        return { argv, ...(Object.keys(launchEnv).length ? { env: launchEnv } : {}) }
      },
      createPane: async (entry, launch) => {
        const created = await backend.create({
          cwd: homedir(),
          label: buildHarnessSessionLabel(entry.engine),
          command: launch.argv,
          ...(launch.env ? { env: launch.env } : {}),
        })
        return created.state === 'succeeded'
          ? { ok: true, runtime: created.runtime }
          : { ok: false, reason: created.reason }
      },
      respawn: async (runtime, launch) => {
        const result = await backend.respawn(runtime, {
          command: launch.argv,
          cwd: homedir(),
          ...(launch.env ? { env: launch.env } : {}),
        })
        return result.state === 'succeeded' ? { ok: true } : { ok: false, reason: result.reason }
      },
      probeProcess: (runtime, engine) => resolvePaneEngineProcess(runtime.paneId, engine),
      paneState: (runtime) => tmuxPaneState(runtime.paneId),
      clearRemainOnExit: (runtime) => clearPaneRemainOnExit(runtime.paneId),
      holdRoute: (key, ms) => agentReconciler.holdRoute(key, ms),
      releaseRoute: (key) => agentReconciler.releaseRoute(key),
      triggerHint: async (runtime, engine) => { await agentReconciler.triggerHint(runtime, engine) },
      log: (message) => console.log(message),
    })
    // A row restore could not look at keeps its pane for discovery to judge, but not to retire this boot.
    for (const agentId of summary.unsurveyed) restoreUnsurveyed.add(agentId)
    if (summary.restored.length || summary.failed.length || registry.rebootedSinceLastRun) {
      console.log(`[restore] restored ${summary.restored.length} · skipped ${summary.skipped.length} · failed ${summary.failed.length}`
        + (registry.rebootedSinceLastRun ? ' · after reboot' : ''))
    }
   } catch (error) {
    restoreFailed = true
    console.warn(`[restore] skipped · ${error instanceof Error ? error.message : error}`
      + ' · agents keep their rows and come back on the next start')
   }
  }
  // Every DSH agent the registry kept gets its viewer and verdict watch back — restored or not, an
  // agent whose pane is still up is still that harness.
  for (const session of registry.list()) if (session.dsh) attachDsh(session)
  await agentReconciler.start(env.TERMINAL_RECONCILE_INTERVAL_MS ?? env.TMUX_REAP_INTERVAL_MS)
  // A file lock and a JSON parse, neither of which is worth the daemon: an unreadable queue means no
  // pending Cursor tasks this boot, not no daemon.
  const pendingCursorTasks = await loadCursorPendingTasks(env.ADAPTER_DATA_DIR).catch((error) => {
    console.warn(`[cursor] pending tasks skipped · ${error instanceof Error ? error.message : error}`)
    return []
  })
  for (const task of pendingCursorTasks) {
    onCursorTaskStart(task.sessionId, task.toolUseId, task.input)
  }

  // Reconciliation is deliberately full: drain every transcript to EOF, inspect each live pane, then
  // publish every session even when Model/Effort did not change. Reconnect runs the same path, while
  // JSONL watcher events still provide immediate local-to-web updates between these safety passes.
  let reconcileInFlight: Promise<void> | null = null
  let reconcileNeedsDeviceAnnouncement = false
  fullReconcile = (announceDevice = false): Promise<void> => {
    reconcileNeedsDeviceAnnouncement ||= announceDevice
    if (reconcileInFlight) return reconcileInFlight
    reconcileInFlight = (async () => {
      await runtimeProfiles.withoutChangeEvents(async () => {
        await Promise.all(registry.advertised().map((session) => runtimeProfiles.ingestConfig(session, true)))
        await watcher.pollAll()
        await Promise.all(registry.advertised().map(async (session) => {
          const capture = await captureTerminal(session.agentId, 120)
          if (capture) runtimeProfiles.ingestPane(session, capture, true)
        }))
      })
      await syncTerminalTitles()
      const includeDevice = reconcileNeedsDeviceAnnouncement
      reconcileNeedsDeviceAnnouncement = false
      for (const session of registry.advertised()) {
        if (includeDevice) announceSession(session)
        else syncSession(session)
      }
    })().finally(() => { reconcileInFlight = null })
    return reconcileInFlight
  }
  // Command Code keeps its reasoning level in a config FILE — nothing in the transcript, the pane or the
  // session header announces a change — so without a tick of its own the chip showed a level up to five
  // minutes stale, and never caught an effort the user changed in the CLI. Costs a small JSON read per
  // Command Code session; ingestConfig only emits a change event when the value actually moved.
  const COMMANDCODE_CONFIG_POLL_MS = 10_000
  setInterval(() => {
    for (const session of registry.list()) {
      if (session.engine !== 'commandcode') continue
      void runtimeProfiles.ingestConfig(session).catch(() => undefined)
    }
  }, COMMANDCODE_CONFIG_POLL_MS)

  // Some engines announce a model change nowhere: no transcript row, no config file, no hook — the new
  // model is simply drawn into the pane footer. The 5-minute reconcile was the only reader, so switching
  // model in the terminal took up to five minutes to reach the device.
  //
  //   devin  — the footer is the ONLY source; nothing else ever reports the model.
  //   cursor — the transcript carries the model but never the reasoning level, and the level only exists
  //            in the footer. Without this poll a Cursor session picks up its effort once at attach and
  //            then never again.
  //
  // Read just the footer, and only while such a session exists. NOT silent: a real change has to push to
  // the device, which is the whole point.
  // agy joins these three: its model/effort exist only in the hook payload and the pane footer, never
  // in the transcript, so the chip goes stale without a poll.
  // opencode and its fork kilo belong here for the same stated reason and were simply missing: neither
  // writes its model anywhere but the composer footer, so between reconciles their chips said nothing
  // at all rather than going stale.
  const PANE_POLLED_ENGINES = new Set(['devin', 'cursor', 'grok', 'agy', 'opencode', 'kilo'])
  const PANE_POLL_MS = 15_000
  setInterval(() => {
    for (const session of registry.list()) {
      if (!PANE_POLLED_ENGINES.has(session.engine)) continue
      void captureTerminal(session.agentId, 60)
        .then((capture) => { if (capture) runtimeProfiles.ingestPane(session, capture) })
        .catch(() => undefined)
    }
  }, PANE_POLL_MS)

  const RUNTIME_RECONCILE_MS = 5 * 60_000
  const runtimeReconcileTimer = setInterval(() => {
    void fullReconcile().catch((err) => {
      console.error('[runtime-profile] periodic reconcile failed:', err instanceof Error ? err.message : err)
    })
  }, RUNTIME_RECONCILE_MS)
  const PANE_TITLE_SYNC_MS = 5_000
  const paneTitleSyncTimer = setInterval(() => {
    void syncTerminalTitles().catch((err) => {
      console.error('[terminal-title] sync failed:', err instanceof Error ? err.message : err)
    })
  }, PANE_TITLE_SYNC_MS)

  // A device joined mid-turn (count rise or join generation; no adapter heartbeat) → replay live state.
  backend.onCommanderJoin = () => { mirror.replayAll(); questionWatcher.reset() } // re-announce an open question
  backend.onCommanderPresenceChanged = (connected) => {
    // Warm the voice-router worker while a device is connected.
    setVoiceRouterDeviceConnected(connected)
  }

  // Cancelling a turn (core/turns/cancel.ts).
  const cancelAgent = createCancel({
    resolve: (id) => registry.resolve(id),
    normalizers,
    cursorSubagents,
    input,
    device: () => autonomousDeviceService,
    stopHeartbeat,
    questionWatcher,
    mirror,
    turnActivity,
    turnStartedAt,
    agentIdFor,
    clients: backend,
  })
  backend.onCancel = id => { void cancelAgent(id) }
  backend.cancelProvider = createCancelRequest((id) => { void cancelAgent(id) })

  /**
   * Web requested a new agent (`agent_create`): spawn a fresh tmux session running the chosen engine in
   * the chosen folder, then hand it to the SAME discovery path organic sessions go through
   * (`agentReconciler.triggerHint` → `onDiscovered` → registry + `announceSession`) rather than
   * duplicating registration here.
   *
   * The freshly-exec'd engine process may not be visible to `ps` the instant tmux returns, so one probe
   * pass can miss it — retry `triggerHint` a few times with backoff before giving up.
   */

  // Watching a pane create or fork just opened until its engine is up, or why not (core/agents/newPane.ts).
  const watchNewPane = createPaneWatcher({
    registry,
    announceSession,
    triggerHint: async (runtime, engine) => { await agentReconciler.triggerHint(runtime, engine) },
    captureTerminal,
    retainExitedSession,
  })

  // Opening a conversation Harness did not start, and taking it over from a terminal (core/agents/adopt.ts).
  const adoption = createAdoption({
    bySession: (sessionId) => registry.bySession(sessionId),
    byAgent: (agentId) => registry.byAgent(agentId),
    stoppedAgents,
    externalSessions,
    openSessions,
    search: sessionSearch,
  })
  const adoptableSession = adoption.adoptableSession
  const takeOverWhenIdle = adoption.takeOverWhenIdle
  const heldBy = adoption.heldBy

  // Creating an agent (core/agents/create.ts).
  backend.onCreateAgent = createAgentCreator({
    tmuxBackend,
    registry,
    adoptableSession,
    heldBy,
    takeOverWhenIdle,
    watchNewPane,
    announceSession,
    attachDsh,
    prepareApiTools,
    hookPort,
    hooksDisabled: env.DISABLE_HOOK_INSTALL,
    gridLaunchMachine,
    terminalHintMachineName,
    blocksFolder: (cwd) => backend.purgeAgentService?.blocksFolder(cwd),
    gridSetup: () => {
      const models = ports.models
      return models ? (request) => models.ensure(request) : null
    },
    // The backend's word, else what the models service works out (services/models.ts).
    privateGridName: async () => backend.gridName() ?? await (ports.models ?? MODELS_OFF).privateGridName(),
  })

  // Forking an agent (core/agents/fork.ts).
  backend.onForkAgent = createAgentForker({
    tmuxBackend,
    registry,
    mirror,
    pendingForkInherit,
    watchNewPane,
    announceSession,
    attachDsh,
    prepareApiTools,
    relaunchOverrides,
    gridName: () => backend.gridName(),
  })

  // Swapping a pane's engine process, for restart and retarget (core/agents/swap.ts).
  const paneSwap = createPaneSwap({
    byAgent: (agentId) => registry.byAgent(agentId),
    tmuxBackend,
    prepareSessionResume,
    keepAbandonedConversation,
  })
  const restartJobs = paneSwap.restartJobs
  // A message sent while an engine is being replaced waits for the new one instead of being refused.
  terminals.whileChanging((agentId) => restartJobs.busy(agentId))
  const sameRestartTarget = paneSwap.sameRestartTarget
  const paneSwapDeps = paneSwap.paneSwapDeps
  const liveBypassPermission = paneSwap.liveBypassPermission

  // Moving a running agent onto a grid, or back to its own login (core/agents/retarget.ts).
  backend.onRetargetAgent = createAgentRetargeter({
    purgeBusy: (agentId) => backend.purgeAgentService?.busy(agentId),
    tmuxBackend,
    registry,
    runtimeProfiles,
    launchOverridesDeps,
    captureTerminal,
    acquireTerminalControl,
    relaunchOverrides,
    downgradedPermission,
    agentReconciler,
    restartJobs,
    paneSwapDeps,
    liveBypassPermission,
    announceSession,
    opencodeDb: OPENCODE_DB,
  })

  // Stopping, purging and resuming an agent (core/agents/lifecycle.ts).
  const lifecycle = createAgentLifecycle({
    registry,
    stoppedAgents,
    restartJobs,
    tmuxBackend,
    agentReconciler,
    forgetSession,
    markDeleted,
    clearDeleted,
    sessionCheckpoints,
    mirror,
    sessionSearch,
    send: (frame) => backend.send(frame),
    pinnedControls,
    retainExitedSession,
    announceSession,
    relaunchOverrides,
    prepareSessionResume,
    refreshGridWebSearch,
    attachDsh,
    attachSession: (session) => attachSession(session),
    relaunchMarks,
  })
  const stopJobs = lifecycle.stopJobs
  binding.whileChanging((agentId) => restartJobs.busy(agentId) || stopJobs.has(agentId))
  const stopAgent = lifecycle.stopAgent
  backend.stopProvider = createStopRequest({ byAgent: (id) => registry.byAgent(id), stop: stopAgent })
  backend.purgeAgentService = lifecycle.purgeAgentService
  backend.purgeProvider = createPurgeRequest({ purgeAgentService: () => lifecycle.purgeAgentService, invalidateStorage: () => { void (ports.monitor ?? MONITOR_OFF).storage([], true) } })
  // Closing agents no window shows, and the cleanup preview (core/agents/close.ts).
  const closing = createAgentClosing({
    registry,
    cleanupTabs,
    watcher,
    captureTerminal,
    sessionTurnState,
    openQuestions,
    terminals,
    sessionCheckpoints,
    stopAgent,
    announceSession,
  })
  backend.closeAgentService = closing.closeAgentService
  backend.closeAgentService.start()
  const closeRequests = createCloseRequests({ cleanupPreview: closing.cleanupPreview, closeAgentService: () => closing.closeAgentService })
  backend.cleanupPreviewProvider = closeRequests.preview
  backend.closeProvider = closeRequests.close

  // Restarting an agent in its own pane (core/agents/restart.ts).
  const restartAgent = createAgentRestarter({
    restartJobs,
    registry,
    purgeBusy: (agentId) => backend.purgeAgentService?.busy(agentId),
    stopJobs,
    pinnedControls,
    tmuxBackend,
    sameRestartTarget,
    agentReconciler,
    terminalHintMachineName,
    announceSession,
    relaunchOverrides,
    downgradedPermission,
    refreshGridWebSearch,
    liveBypassPermission,
    paneSwapDeps,
  })
  // The requests that start an agent's process, and the receipts of those asked with a creationId
  // (core/agents/launches.ts). The orchestrator and the cable create and fork through the socket's slots.
  const launches = createLaunchRequests({
    receipts: new AgentCreationReceipts(join(env.ADAPTER_DATA_DIR, 'agent-creations')),
    createAgent: () => backend.onCreateAgent, forkAgent: () => backend.onForkAgent,
    resumeAgent: () => lifecycle.resumeAgent, restartAgent: () => restartAgent,
    byAgent: (id) => registry.byAgent(id), toProject: (s) => backend.toProject(s),
    modelTarget: (selection) => (ports.models ?? MODELS_OFF).launchTarget(selection),
  })
  backend.createProvider = launches.create
  backend.createStatusProvider = launches.createStatus
  backend.restartProvider = launches.relaunch
  backend.forkProvider = launches.fork

  const submitAgent = inputs.submitAgent
  backend.onMessage = (id, content, deliveryId, tabId) => submitAgent(id, content, deliveryId, tabId)
  backend.messageProvider = inputs.messageRequest
  backend.onCancelOrchestratorMessage = id => input.cancelDelivery(id)
  deliveries.ready() // The input is wired: what was delivered meanwhile (a teams' queue resuming) is written now.

  // Keep the log file under its cap. This daemon writes it through an inherited stdout fd, so a size
  // check on a timer is the only place that can see it grow — `prepareLogFile` at spawn time alone
  // would let a long-lived, chatty daemon run unbounded between restarts.
  // A core run by harnessd leaves this to its master, which outlives it (harnessd/master.ts).
  const logTrimTimer = coreLink.supervised ? undefined : setInterval(() => {
    if (trimLogFile(LOG_FILE)) console.log(`[log] ${tildify(LOG_FILE)} hit its size cap — dropped the oldest half`)
  }, LOG_CHECK_INTERVAL_MS)
  logTrimTimer?.unref?.() // never hold the event loop open for log upkeep

  // Signed out, the backend is not dialed at all. The socket would only meet a missing session and back
  // off forever, one log line at a time; a sign-in RESTARTS this process with the session in hand
  // (`restartDaemonForIdentity`), so nothing here has to watch for one arriving.
  if (session) {
    backend.connect()
    console.log(`[cli] dialing ${env.BACKEND_WS_URL}/api/adapter-ws · watching registered sessions for ${ENGINES.length} engines`)
  } else {
    backend.serveThisComputerOnly()
    console.log(`[cli] not signed in — serving this computer only · watching registered sessions for ${ENGINES.length} engines`)
  }

  // ── self-update: a staged bundle restarts the daemon IMMEDIATELY (core/updateHandoff.ts, and
  // handOffToMaster for a core run on its own). The handler stops being `bootHandoff` HERE, and not a
  // line earlier: everything the teardown releases exists by now. A straight-line assignment, never a
  // wait: if the body never reaches this line the handler stays `bootHandoff`, and the fix still lands.
  daemonBoot.applyStagedUpdate = (v) => updateHandoff.restartForUpdate(v, [
    ['the registry', () => registry.flush()], ['the updaters', () => { daemonBoot.updater?.stop(); daemonBoot.tuiUpdater?.stop() }],
    ['the reconciler', () => agentReconciler.stop()],
    ['the timers', () => { clearInterval(logTrimTimer); clearInterval(runtimeReconcileTimer); clearInterval(paneTitleSyncTimer) }],
    ['the question watchers', () => questionWatcher.stopAll()],
    ['the turn heartbeats', () => { for (const t of heartbeats.values()) clearInterval(t); heartbeats.clear() }],
    ['the Cursor sub-agents', () => cursorSubagents.stop()], ['the normalizers', () => normalizers.stopPollers()],
    ['Cursor discovery', () => cursorDiscovery.stop()], ['the transcript watcher', () => watcher.stop()],
    // The FIXED hook port, released before the successor binds it (no fallback → EADDRINUSE otherwise).
    // Process-owned agents stay in the persisted registry and are revalidated by its first discovery passes.
    ['the hook connections', () => (hookServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()],
    ['Share', () => ports.sharing?.stop()],
    ['the local websocket', () => localWsServer.close()], ['the hook server', () => hookServer.close()],
    ['the local socket', () => localSocket?.close()], ['Codex activity', () => codexActivity.close()],
    ['the voice router', () => shutdownVoiceRouter()],
    // The successor starts its own viewers for the agents it restores; ours must not hold the ports.
    ['the viewers', () => ports.viewers?.stop()], ['the gateway', () => gateway.stop()],
    // A graceful close releases the backend's one-machine claim, given a moment before the reclaim.
    ['the backend', () => backend.stop()], ['a grace', () => new Promise((r) => setTimeout(r, 1000))],
  ])

  /** Stopping for good — removed from the account, or connected from elsewhere: tell harnessd's master,
   *  which restarts any other exit (harnessd/protocol.ts). */
  const forGood = (reason: string): boolean => reason === 'revoked' || reason === 'busy'
  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n[cli] ${signal} — shutting down`)
    // Mid-handoff everything below is already being torn down, and nothing has been started yet: leave
    // — a second teardown of closed servers is noise.
    if (updateHandoff.restarting()) {
      try { if (readPid() === process.pid) rmSync(PID_FILE, { force: true }) } catch { /* ignore */ }
      process.exit(0)
    }
    // Release the serial port first. It is exclusive, and a daemon that exits still holding it makes
    // esptool fail in a way that reads exactly like dead hardware.
    void cableRef?.stop()
    ports.fleet?.stop()
    daemonBoot.updater?.stop()
    daemonBoot.tuiUpdater?.stop()
    agentReconciler.stop()
    clearInterval(logTrimTimer)
    clearInterval(runtimeReconcileTimer)
    clearInterval(paneTitleSyncTimer)
    questionWatcher.stopAll()
    for (const t of heartbeats.values()) clearInterval(t)
    heartbeats.clear()
    cursorSubagents.stop()
    normalizers.stopPollers()
    await cursorDiscovery.stop()
    await watcher.stop()
    await ports.sharing?.stop()
    // The data folder's socket first: a successor waiting for this core to leave (lib/localSocket.ts) can
    // start as soon as it is gone, whatever the clients below take to close.
    await localSocket?.close()
    await localWsServer.close()
    hookServer.close()
    codexActivity.close()
    shutdownVoiceRouter()
    await ports.viewers?.stop()
    await gateway.stop()
    await backend.stop()
    try { if (readPid() === process.pid) rmSync(PID_FILE, { force: true }) } catch { /* ignore */ }
    process.exit(coreLink.supervised && forGood(signal) ? CORE_EXIT_STOP : 0)
  }
  process.on('SIGINT', () => void shutdown('SIGINT'))
  process.on('SIGTERM', () => void shutdown('SIGTERM'))
  // A core whose master is gone stops, so nothing is left holding the port for a master that is not
  // there to restart it.
  coreLink.onMasterGone(() => void shutdown('the harnessd master is gone'))
  process.on('exit', () => { shutdownVoiceRouter() })

  // A machine revocation or invalid SSO refresh ends this adapter session permanently.
  backend.onRevoked = () => {
    console.log('[cli] this computer was removed from the machine — clearing credentials and stopping')
    clearAuthSession()
    // The web-tools cache lives exactly as long as the sign-in. `harness logout` and `reset` stop
    // the daemon outright; this is the one sign-out the daemon learns of from inside.
    ports.models?.signedOut()
    void shutdown('revoked')
  }

  // Mirror the machine's display name to disk so `harness status` (a separate process) can print it.
  backend.onMachineMeta = (name) => {
    try {
      if (name) writeFileSync(MACHINE_NAME_FILE, name + '\n')
      else rmSync(MACHINE_NAME_FILE, { force: true })
    } catch { /* best effort */ }
  }

  // This machine is already connected from ANOTHER machine (HTTP 409). The credential is valid — it's
  // just in use elsewhere — so KEEP the token and stop (no retry loop, no token prompt). The
  // '[backend] machine busy' marker is what the detached parent's waitForReady() greps for.
  backend.onBusy = () => {
    console.log('[backend] machine busy — this machine is already connected from another computer; stopping')
    void shutdown('busy')
  }

  // ── the owner's OTHER machines (services/fleet.ts) ──────────────────────────────────────────────────
  //
  // The machine list kept fresh, the lane to the other machines, and the router ⌘K, the window's voice
  // route and the dial send every turn through. The list is the same cache the local `/api/machines`
  // handler answers from (built up near `proxyBackend`), so the dial's wheel and the desktop's list
  // cannot disagree — and neither can go stale while the other is fresh.
  serviceHost.start('fleet', (core, started) => {
    startFleet(core, started, {
      machines: machineListCache, guestMachines: guestMachinesBody, computerId, machineId: () => backend.machineId,
      machineName: dialMachineName, desk: () => appPaneAgents,
      autonomousEnv: readAuthSession()?.autonomousEnv ?? env.AUTONOMOUS_ENV,
    })
  }, coreApi, FLEET_FALLBACKS)

  // ── the dial on the USB cable ────────────────────────────────────────────────────────────────────
  //
  // A second device surface, served entirely over a wire the user physically owns: no backend, no
  // pairing, no E2EE, no credential on the device. Everything it can ask for is answered by the machinery
  // above — the same registry, the same delivery path, the same router — because a second implementation
  // of any of those is a second set of bugs.
  //
  // Deliberately not fatal and not blocking: an unplugged cable is this daemon's ordinary state.
  let devicesStatusRevision = 0
  const cableHost = new DaemonCableHost({
    activityText: async (agentId) => {
      const session = registry.resolve(agentId)
      if (!session || (session.engine !== 'claude' && session.engine !== 'codex')) return null
      const screen = await terminals.capture(session, { mode: 'visible', ansi: false })
      return terminalActivity(session.engine, screen.state === 'succeeded' ? screen.value : null)
    },
    machineName: dialMachineName,
    machineId: () => backend.machineId,
    computerId: () => computerId(),
    signedIn: () => readAuthSession() !== null,
    // The core's own doors for a local agent (core/api.ts). The fleet's router reaches them the same way;
    // the dial uses these only when it routes by itself, with the fleet service off.
    sendTurn: coreApi.turns.send,
    stopTurn: coreApi.turns.stop,
    answer: coreApi.questions.answer,
    answerReviewed: coreApi.questions.answerReviewed,
    recent: coreApi.turns.recent,
    recentAsks: coreApi.turns.asks,
    runtimeProfile: coreApi.agents.runtimeProfile,
    updateAgent: coreApi.agents.setRuntime,
    listModels: coreApi.agents.runtimeModels,
    // Both of these are LOCAL-ONLY on purpose (backend.sendLocal, not backend.send): they describe a hand
    // at this desk, not a change in what the machine is doing, and the cloud web audience may be sitting
    // at another computer entirely.
    // A notification tap, which asks for a tile of its OWN — see CableHost.openAgent. `reason` rides
    // along only when the dial gave one ('question'): the window then brings the agent forward rather
    // than opening a tab, and an older window that does not know the field opens one as before.
    opened: (machineId, agentId, reason) =>
      backend.sendLocal({ type: 'dial_open', payload: { machineId, agentId, ...(reason ? { reason } : {}) } }),
    notificationRead: (machineId, agentId, readToken) =>
      backend.sendLocal({ type: 'dial_notification_read', payload: { machineId, agentId, readToken } }),
    forked: (machineId, agentId, sourceAgentId) => backend.sendLocal({ type: 'dial_forked', payload: { machineId, agentId, sourceAgentId } }),
    // The dial's Fork: the same path the window's `agent_fork` takes, then `forked` above lands on it.
    forkAgent: coreApi.agents.fork,
    // No `edge`. It used to ride along for an agent the window had no tile for, naming which end of the
    // desk to replace; the carousel now only walks tiles that exist, so every focus is about one of them.
    focused: (machineId, agentId) =>
      backend.sendLocal({ type: 'dial_focus', payload: { machineId, agentId } }),
    // The dial's swarm pick. Local-only like the two above: a tab is a thing THIS window has.
    swarmSelected: (swarmId) => backend.sendLocal({ type: 'dial_swarm', payload: { swarmId } }),
    scrolled: (phase, dy, velocity) => backend.sendLocal({ type: 'dial_scroll', payload: { phase, dy, velocity } }),
    // Gestures remain local. Device inventory/settings also reach the owner's
    // other machines through the encrypted device-management event.
    dialStatus: (status) => {
      devicesStatusRevision++
      backend.sendLocal({ type: 'dial_status', payload: status })
      backend.send({ type: 'harness_devices_changed', payload: { status, revision: devicesStatusRevision } })
    },
    // Words spoken on the overview belong to whichever agent the window's palette picks.
    routeInWindow: (text, cmd) => windowRouter.ask(text, cmd),
    selectPassage: command => windowSelection.command(command),
    clearSelection: () => windowSelection.cancel(),
    visit: command => windowVisit.command(command),
    clearVisit: () => windowVisit.cancel(),
    form: command => windowForm.command(command),
    clearForm: () => windowForm.clear(),
    log: (line) => console.log(`[cable] ${line}`),
    // Which machine an agent is on, and getting there: the fleet's router, through its port (D1).
    fleet: () => ports.fleet,
  })
  cableHostRef = cableHost
  backend.harnessDevices = {
    status: () => cableHost.currentDialStatus(),
    revision: () => devicesStatusRevision,
    set: async (id, patch) => cableRef
      ? cableRef.setSettings(id, patch)
      : { ok: false, error: 'Device service unavailable' },
  }
  // Anything the window said while this was still being built.
  cableHost.setDesk(appPaneAgents)
  cableHost.setSwarms(appSwarmsLatest)
  // The dial's log now lives with the app's, one file a day — see dialLog.ts. The old unbounded
  // `cli/data/dial.log` is cut down to a pointer, for anyone with a bookmark.
  const legacyDialLog = join(env.ADAPTER_DATA_DIR, 'dial.log')
  if (existsSync(legacyDialLog)) {
    try { writeFileSync(legacyDialLog, `moved to ${join(env.HARNESS_LOGS_DIR, 'dial-YYYYMMDD.log')}\n`) } catch { /* best effort */ }
  }
  const cable = new CableFleet(CableSession, cableHost, env.HARNESS_LOGS_DIR, DialLog,
    { serials: process.env.HARNESS_DIAL_SERIALS?.split(',').map(s => s.trim()).filter(Boolean),
      verdicts: new DialVerdicts(join(env.ADAPTER_DATA_DIR, 'dial-ports.json')), ...testDialDiscovery(process.env.HARNESSD_TEST_DIAL_PORT) })
  cableRef = cable

  const deviceStore = createDeviceStore({ dataDir: env.ADAPTER_DATA_DIR, machineId: backend.machineId,
    create: input => backend.onCreateAgent!(input),
    reveal: (operationId, agentId) => { backend.sendFirstLocal({ type: 'device_prepare_open', payload: { operationId, machineId: backend.machineId, agentId } }) },
  })
  deviceStoreRef = deviceStore
  deviceStore.startUiDelivery()
  autonomousDeviceService = startDevicePart('Wi-Fi device service', () => new AutonomousDeviceService({
    store: deviceStore,
    resultJournal: new DeviceResultJournal(join(env.ADAPTER_DATA_DIR, 'device-results.json')),
    inputConsumed: (id, text) => deviceInput.onTurnStarted(id, text),
    machineId: backend.machineId,
    requestAppFocus: (agentId, expiresAt, focusRevision) => backend.sendFirstLocal({
      type: 'device_focus', payload: { machineId: backend.machineId, agentId, expiresAt, focusRevision },
    }),
    // The dial's own carousel tick, borrowed: ring order and wrap from the cable host, `dial_focus` to
    // the window, `app_focus` back. Without a window the forward is a no-op, so say so up front.
    stepFocus: (direction, currentAgentId) => backend.hasLocalClient() ? cableHost.stepFocus(direction, currentAgentId) : Promise.resolve('no_app'),
    // The dial's touchpad stroke, borrowed the same way: `dial_scroll` to the window's focused terminal.
    scroll: (phase, dy, velocity) => { if (!backend.hasLocalClient()) return false; cableHost.scrolled(phase, dy, velocity); return true },
    agents: () => {
      const evidence = new Map(deviceStoreAgents(backend.machineId).map(a => [a.agentId, a]))
      return registry.advertised().map(s => ({ agentId: s.agentId, name: projectDisplayName(s), engine: s.engine,
        packageId: evidence.get(s.agentId)?.packageId ?? null, workspace: evidence.get(s.agentId)?.workspace ?? s.cwd,
        runtime: evidence.get(s.agentId)?.runtime ?? 'unavailable',
        state: turnStartedAt.has(s.sessionId) ? 'running' : 'idle' }))
    },
    submit: (id, text, deliveryId) => {
      const session = registry.resolve(id)
      deviceInput.submit(session?.agentId ?? id, adaptSlashCommand(text, session?.engine ?? 'claude'), deliveryId)
    },
    cancelDelivery: id => deviceInput.cancelDelivery(id),
    stop: id => cancelAgent(id, true),
    answer: async (agentId, requestId, answers) => (await questions.answer({ agentId, requestId, answers, allowPermissions: false })).ok,
    recent: (id, n) => mirror.recent(registry.byAgent(id)?.sessionId ?? id, n),
    fullText: id => mirror.lastFullText(registry.byAgent(id)?.sessionId ?? id),
    emit: (frame, deviceId) => backend.emitAutonomousDeviceEvent(frame, deviceId),
  }))
  if (appVoiceFocus) autonomousDeviceService?.appFocus(appVoiceFocus.machineId, appVoiceFocus.agentId, appVoiceFocus.connId)
  // The device's requests reach the service through its relay in the socket; its sessions and its direct
  // links are the gateway's, which starts the links only with the service up: a device it connected would
  // be answered by nothing.
  if (autonomousDeviceService) {
    backend.setAutonomousDeviceService(autonomousDeviceService, (identity) => gatewayOps.revokeIdentity(identity))
    gatewayOps.wifiService(true)
  }
  devicePartsBuilt = true

  // Worktrees Harness made that no live or stopped harness uses and nothing would miss
  // (services/workspaces.ts): a few minutes after start, once restored agents are back in the
  // registry, then twice a day. Only the end-to-end harness shortens the first wait.
  setTimeout(() => ports.workspaces?.sweepUnused(), Number(process.env.HARNESSD_TEST_SWEEP_AFTER_MS) || 5 * 60_000).unref()
  setInterval(() => ports.workspaces?.sweepUnused(), 12 * 3600_000).unref()


  // Every card bound for the WiFi device goes down the cable too, translated once. Teeing beats emitting
  // again at each call site: a new event kind reaches the dial the day it reaches the socket.
  // The tee runs before the frame is queued for the WiFi device (BackendSocket.sendCommander): a dial
  // fault here must cost neither that frame nor whoever is sending it.
  backend.onOutboundCommander = (frame) => devices('dial', () => {
    autonomousDeviceService?.commander(frame as Record<string, unknown>)
    // THIS COMPUTER'S cards, by definition — and every one of them belongs to a tile that is on the
    // carousel, because the carousel now spans machines. The old guard dropped them whenever the wheel
    // was pointed elsewhere, which would now silence this machine's own agents.
    const close = cableQuestionCloseFor(frame as { type?: string; agentId?: string; payload?: { requestId?: string } })
    if (close) { void cable.questionClose(close.agentId, close.requestId); return }
    const question = cableQuestionFor

(frame as { type?: string; agentId?: string; payload?: { requestId?: string; questions?: unknown } })
    if (question) { void cable.question(question.agentId, question.requestId, question.questions); return }
    const event = cableEventFor(frame as { type?: string; agentId?: string; payload?: { kind?: string; text?: string; recap?: string } })
    // Logged at the fork, not at the send: this is the one place that can answer "did the daemon even
    // decide to tell the dial", which is a different question from "did the wire carry it" and was the
    // question nobody could answer when the tile stayed idle through a whole turn.
    if (env.LOG_FRAMES && frame?.type === 'commander_event') {
      console.log(`[cable] tee ${(frame as { payload?: { kind?: string } }).payload?.kind ?? '?'} → ${event ? 'sent' : 'ignored'}`)
    }
    if (!event) return
    if (event.kind === 'processing') void cable.turnStarted(event.agentId, event.text)
    else if (event.kind === 'done') void cable.turnDone(event.agentId)
    else if (event.kind === 'summary') {
      // Quiet when the window already has this agent on screen; silent when the
      // turn was a sub-agent's. The tile still updates — the recap is what it
      // draws — only the beep and the drawer entry are withheld.
      void cable.summary(event.agentId, event.recap || event.text, event.text, alreadyOnScreen(event.agentId), event.subagent)
    }
    else void cable.turnError(event.agentId, event.text)
  })

  // A remote machine's cards reach the dial through the SAME four calls the local tee uses, so a new
  // event kind lands on both surfaces the day it lands on either.
  // The fleet has already noted which machine the agent is on (services/fleet.ts), so a question from it
  // can be named and, tapped, opened.
  ports.fleet?.onEvent((event) => {
    // A `state` event is about the WHEEL, not about a turn — live machine presence, which matters
    // whichever machine is selected. Filtering it with the guard below would freeze the dots the moment
    // the dial came back to this computer, which is where it sits most of the time.
    if (event.kind === 'state') { void cable.syncMachines(); return }
    // No selection guard. Every machine's agents are on the carousel at once, so a card from a machine
    // the wheel is not pointed at still belongs to a tile the user can see — and dropping it is what a
    // tile that never leaves "Working…" looks like from the outside.

    if (event.kind === 'questionClosed') { void cable.questionClose(event.agentId, event.requestId); return }
    if (event.kind === 'question') { void cable.question(event.agentId, event.requestId, event.questions); return }
    if (event.kind === 'processing') void cable.turnStarted(event.agentId, event.text)
    else if (event.kind === 'done') void cable.turnDone(event.agentId)
    else if (event.kind === 'summary') {
      // Quiet when the window already has this agent on screen; silent when the
      // turn was a sub-agent's (decided on its own machine). The tile still
      // updates — the recap is what it draws — only the beep and the drawer
      // entry are withheld.
      void cable.summary(event.agentId, event.recap || event.text, event.text, alreadyOnScreen(event.agentId), event.subagent === true)
    }
    else void cable.turnError(event.agentId, event.text)
  })

  if (env.CABLE_DISABLE) console.log('[cable] disabled (CABLE_DISABLE=true) — the serial port is left alone')
  else cable.start()
  // Last: every handler is wired and the restored agents are confirmed, so requests that arrived while
  // starting — a client reconnecting the moment the port answered, the backend's first frames — are
  // answered now, in order, by the handlers meant to answer them (see BackendSocket.openRequests).
  // Only the end-to-end harness sets this: a start-up that hangs after binding, for the master's deadline.
  if (process.env.HARNESSD_TEST_HOLD_READY === '1') await new Promise<never>(() => {})
  backend.openRequests()
  daemonBoot.openRequests = null
  coreLink.ready()
  console.log('[cli] ready')
}

/**
 * The daemon's start-up threw. STAY UP anyway, running nothing but the updater.
 *
 * Exiting here is what made one bad build unrecoverable: nothing supervises this process, the desktop
 * app answers a dead port by running `harness start` again — the same bytes, about once a minute, for
 * ever — and the updater that could have fixed it lives most of the way down a body that never
 * finished. The updater is started in the prologue now (see `runForeground`), so by the time this
 * runs it is already polling; all this has to do is keep the process alive long enough for a
 * published fix to land, and tell everyone what state the machine is in.
 *
 * Three ways it earns its keep, in order: the bound control port answers `discoveryReady: false`, so
 * the app reads the machine as not-ready instead of dead and STOPS respawning; the pid file stays
 * ours, so `harness start` is a cheap no-op rather than a zombie factory; and the marker file lets
 * `harness status` say what happened. `harness stop` still works throughout — it kills by pid.
 */
const enterSafeMode = (err: unknown): void => {
  const disposition = safeModeDisposition(err, { selfPid: process.pid, masterPid: coreLink.masterPid, readPid, isAlive })
  if (!disposition.stay) {
    console.error(`[safe-mode] not staying up — ${disposition.reason}`)
    // Under harnessd, said for good: any other exit, the master restarts, and a core that another daemon
    // keeps from running was restarted for as long as its master lived (e2e/twodaemons.e2e.ts). Except
    // what stands in the way is leaving too: then the master starts this core again.
    onError(err, coreLink.supervised && !disposition.retry ? CORE_EXIT_STOP : 1)
  }
  const detail = err instanceof Error ? (err.stack ?? err.message) : String(err)
  console.error('Failed to start adapter:', err)
  console.error(`[safe-mode] staying up on v${VERSION} with the updater only — a published fix will be`
    + ' applied on its own. Nothing else on this machine works until then.')
  writeSafeModeMarker(env.ADAPTER_DATA_DIR, { pid: process.pid, version: VERSION, at: Date.now(), error: detail })
  daemonBoot.safeMode = disposition.reason
  daemonBoot.markNotReady?.(disposition.reason)
  // Requests queued behind a start-up that will not finish are answered now, by whatever is wired.
  daemonBoot.openRequests?.()

  const leave = (why: string, code: number): never => {
    clearSafeModeMarker(env.ADAPTER_DATA_DIR)
    removePidFileIf(process.pid)
    console.log(`[safe-mode] ${why}`)
    process.exit(code)
  }
  process.on('SIGINT', () => leave('SIGINT — leaving safe mode', 0))
  process.on('SIGTERM', () => leave('SIGTERM — leaving safe mode', 0))
  // Up, though not ready: the master must neither give up waiting for a bind nor take it for hung,
  // or the updater that can fix this build would never get its chance. It hears why, and rolls back an
  // update whose first core ends up here.
  coreLink.bound(daemonPort())
  coreLink.ready(disposition.reason)
  coreLink.startHeartbeat()
  coreLink.onMasterGone(() => leave('the harnessd master is gone — leaving safe mode', 0))

  // The bound control port is a ref'd handle and holds the loop on its own. Without one — the bind
  // itself was what failed, or we never got that far — take the port for the status alone, so the app
  // still reads not-ready rather than down. A port we cannot take at all leaves only a ticking clock.
  if (!daemonBoot.hookServer) {
    const port = daemonPort()
    const hosts = loopbackHosts(port)
    const status = createServer((req, res) => {
      if (!isLoopbackRequest(req, hosts)) { res.writeHead(403).end(); return }
      const body = safeModeStatusBody({
        version: VERSION, pid: process.pid, startedAt: Date.now(),
        computerId: computerId(), error: disposition.reason,
      })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(body))
    })
    status.on('error', (e) => {
      console.error(`[safe-mode] could not serve status on ${port}: ${e instanceof Error ? e.message : e}`)
      // A ref'd timer, unlike the updater's: something has to hold the event loop open.
      setInterval(() => console.log(`[safe-mode] still waiting for a fixed build · v${VERSION}`), 10 * 60_000)
    })
    status.listen(port, '127.0.0.1')
  }

  // Bounded on purpose. A cause that has since cleared — tmux not yet on PATH after a reboot, a lock
  // file, a port held for a moment — would otherwise leave the machine wedged in a state nobody
  // respawns over, because not-ready is exactly what stops the app trying again.
  // Counted in AWAKE time: a plain timer spent a closed lid on this clock and exited the daemon on the
  // first loop turn after the wake, taking every local terminal with it (see lib/sleepAware.ts).
  if (env.ADAPTER_SAFE_MODE_MS > 0) {
    awakeTimeout(() => leave(`no fix arrived within ${Math.round(env.ADAPTER_SAFE_MODE_MS / 60_000)}m — letting a clean start try`, 1),
      env.ADAPTER_SAFE_MODE_MS)
  }
}

/** `harness __run`: the core, as harnessd's master (or `harness start` without one) spawns it. */
export function runCore(scriptPath: string): void {
  SCRIPT_PATH = scriptPath
  // Inert unless the end-to-end suite asks for its event loop to be held (core/stall.ts).
  startStalls(testFaults(process.env.HARNESSD_TEST_FAULTS))
  // NOT `onError`: a daemon that dies here can never be updated. See `enterSafeMode`.
  runForeground(readAuthSession()).catch(enterSafeMode)
}

/** `harness start -f` with `HARNESS_NO_MASTER=1`, and a start under tsx: the core alone, in the process of the command that asked for it. */
export function runCoreInForeground(session: AuthSession | null, scriptPath: string): Promise<void> {
  SCRIPT_PATH = scriptPath
  return runForeground(session)
}
