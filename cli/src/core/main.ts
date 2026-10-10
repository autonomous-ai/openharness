import { createGridAssignments } from './agents/gridAssignments.js'
import { createQuestionControls } from './engines/questionControls.js'
import { masterRunsEngineQuestionControl } from '../harnessd/services.js'
import { createModelControls } from './engines/modelControls.js'
import { masterRunsEngineModelControl } from '../harnessd/services.js'
import { createScreens } from './engines/screens.js'
import { createScreenTransport } from './engines/screenTransport.js'
import { inProcessScreen, preloadEngine } from '../engines/inProcess.js'
import { opencodeMajorVersion } from '../engines/launchControl.js'
import { masterRunsEngineScreen } from '../harnessd/services.js'
import { createSubmissions } from './engines/submissions.js'
import { createNativeControls } from './engines/nativeControls.js'
import { createEngineLinks } from './engines/engineLinks.js'
import { engineLaunches } from '../engines/launches.js'
import { masterRunsEngineNativeControl } from '../harnessd/services.js'
import { submissionPolicy } from '../engines/submissionPolicies.js'
import { createSubmissionTransport } from './engines/submissionTransport.js'
import { masterRunsEngineSubmission } from '../harnessd/services.js'
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
import { readFileSync, writeFileSync, openSync, existsSync, rmSync, statSync } from 'fs'
import { readFile } from 'node:fs/promises'
import { join } from 'path'
import { execFile, spawn } from 'child_process'
import { createServer, type Server } from 'http'
import { homedir, hostname } from 'os'
import { env } from '../config/env.js'
import { VERSION } from '../version.js'
import { sqlitePreflightMessage } from '../lib/sqliteAvailability.js'
import { warmLoginShellEnvironment } from '../lib/loginShellEnv.js'
import type { AppSwarms } from '../cable/cableSession.js'
import type { UnreadNotification } from '../lib/notificationRead.js'
import { registry, projectDisplayName, validTranscriptPath, type RegisteredSession } from '../lib/registry.js'
import { engineSessionTitle } from '../lib/sessionTitle.js'
import { machineNames } from '../lib/machineNames.js'
import { engineHooks as engineHookFacets } from '../engines/hooks.js'
import type { LiveFor } from '../engines/facets/live.js'
import { DAEMON_LOG_FILE, PID_FILE, daemonPort, isAlive, readPid, LEGACY_LOG_FILE, MACHINE_NAME_FILE, tildify, computerId, thisDeviceLabel } from '../lib/daemonState.js'
import { clearSafeModeMarker, safeModeDisposition, safeModeStatusBody, SafeModeRequest, writeSafeModeMarker } from '../lib/daemonSafeMode.js'
import { awakeTimeout } from '../lib/sleepAware.js'
import { removePidFileIf, onError } from '../lib/daemonLaunch.js'
import { ensureTmuxOnPath } from '../lib/tmuxOnPath.js'
import { AUTH_DIR, AuthSessionManager, clearAuthSession, ensureSignInEpoch, readAuthSession, signInOf, type AuthSession } from '../lib/authSession.js'
import { ENGINES, enginePathOverride } from '../lib/engineBin.js'
import { isTerminalEngine, type AgentEngine } from '../engines/types.js'
import { engineInstallRecipe } from '../lib/engineInstall.js'
import { buildEngineLaunchArgv, supportsFirstPrompt } from '../lib/engineLaunch.js'
import { workspaceMissing } from '../lib/workspaceCheck.js'
import { HERMES_SYSTEM_MANAGED_DIR, type GridLaunchMachine } from '../lib/gridLaunchWire.js'
import { writeGridConfigDir } from '../lib/gridConfigDir.js'
import { tmuxSupportsSessionEnv } from '../lib/tmuxVersion.js'
import { clearDeleted, isRecentlyDeleted, markDeleted } from '../lib/deletedSessions.js'
import { findLiveSession, findResumedTranscript } from '../lib/sessionRepair.js'
import { processSessionOf } from '../engines/sessionStores.js'
import { handoffProviderDeps } from '../lib/handoffDiscovery.js'
import { TmuxBackend } from '../lib/tmuxBackend.js'
import { DEFAULT_HOST_THEME, loadHostTheme, saveHostTheme, type HostTheme } from '../lib/hostTheme.js'
import { restoreAgents, tmuxSurvey, type RestoreAgentsDeps, type RestoreSummary } from '../lib/restoreAgents.js'
import { createRetainExitedSession } from '../lib/retainExitedSession.js'
import { createKeepAbandonedConversation } from '../lib/keepAbandonedConversation.js'
import { OpenTabProtection } from '../lib/openTabProtection.js'
import { sessionCheckpoints } from '../lib/sessionCheckpoint.js'
import { repairProjectCwds } from '../lib/cwdRepair.js'
import { stoppedAgents } from '../lib/stoppedAgents.js'
import { externalSessionAnswer, externalUnavailable } from '../lib/externalSessionWire.js'
import { externalResumePending } from '../lib/externalResume.js'
import { type LaunchOverridesDeps } from '../lib/launchOverrides.js'
import { buildHarnessSessionLabel } from '../lib/harnessSessionLabel.js'
import { adoptLegacyHarnessSessions, listTmuxPanes } from '../lib/tmuxAgentDiscovery.js'
import { installedDsh, invalidateInstalledDsh } from '../dsh/installed.js'
import { dshThrough } from './agents/dshThrough.js'
import { ApiConnectionMetadata } from '../lib/apiConnectionMetadata.js'
import { prepareApiInstructions } from '../lib/apiInstructions.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { AgentGridTarget, GridAnnotation } from '../lib/gridAnnotation.js'
import { sessionCodexHome } from '../lib/engineHomes.js'
import { argvTokens, clearPaneRemainOnExit, lookupPaneEngineProcess, processRows, resolvePaneEngineProcess, tmuxPaneInfo, tmuxPaneState } from '../lib/tmux.js'
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
import { createTerminalSessions } from './terminals/sessions.js'
import { checkPidRuntime } from '../lib/deleteAgentFallback.js'
import { SHELL_REQUESTS } from '../lib/shellProtocol.js'
import { answerShellQuery } from './shellQueries.js'
import { createTerminalControl } from './terminals/control.js'
import { createTerminalRequests } from './terminals/requests.js'
import { createAgentEvents } from './agents/events.js'
import { createSessionNormalizers } from './transcripts/normalizers.js'
import { createInput } from './input.js'
import { createQuestions } from './questions.js'
import { createTurnActivity } from './turns/activity.js'
import { createLastTurnReader } from './transcripts/lastTurn.js'
import { createEngineReaders } from './engines/readers.js'
import { createLiveTransport } from './engines/liveTransport.js'
import { createLiveWatcher } from './engines/liveWatcher.js'
import { readerEngine, READER_SERVICES } from '../engines/worker/protocol.js'
import { createRecaps } from './turns/recaps.js'
import { createUpdateHandoff, handOverOnceReleased, probeStagedMaster, type TeardownStep } from './updateHandoff.js'
import { needsUpdaterBeside, startUpdaterBeside } from './updaterBeside.js'
import { createHeartbeats } from './turns/heartbeats.js'
import { createEventFunnel } from './turns/funnel.js'
import { createAgyBackstop } from './turns/agyBackstop.js'
import { createIngest } from './transcripts/ingest.js'
import { createTurnHooks } from './turns/turnHooks.js'
import { createAttach } from './transcripts/attach.js'
import { createHistory } from './transcripts/history.js'
import { createRelaunchMarks, transcriptSize } from './transcripts/relaunch.js'
import { createForgetSession } from './agents/forget.js'
import { createBinding } from './agents/bind.js'
import { createDiscoveryHandlers } from './agents/discovery.js'
import { createLaunchHelpers, gridLaunchThrough } from './agents/launch.js'
import { createLaunchAuthority } from './agents/launchAuthority.js'
import { AgentRestartCoordinator } from '../lib/restartAgent.js'
import { createPaneOperations } from './agents/paneOperations.js'
import { createRestoreLaunch } from './agents/restoreLaunch.js'
import { createHeldLaunches, heldPaneArgv } from './agents/heldLaunches.js'
import { createCancel, createCancelRequest } from './turns/cancel.js'
import { createPaneWatcher } from './agents/newPane.js'
import { createExternalResumes } from './agents/externalResume.js'
import { createExternalPreflight } from './agents/externalPreflight.js'
import { createAgentCreator } from './agents/create.js'
import { createAgentForker } from './agents/fork.js'
import { createPaneSwap } from './agents/swap.js'
import { createAgentRetargeter } from './agents/retarget.js'
import { createAgentRestarter } from './agents/restart.js'
import { createAgentLifecycle, createPurgeRequest, createStopRequest } from './agents/lifecycle.js'
import { createAgentClosing, createCloseRequests } from './agents/close.js'
import { answerConversationQuery, conversationReads } from './conversationQueries.js'
import { createLaunchRequests } from './agents/launches.js'
import { createAgentList } from './agents/list.js'
import { createAgentUpdate } from './agents/update.js'
import { createEngineHooks, installEngineHooks, installOpencodePluginBeforeSpawn } from './engines/hooks.js'
import { createCursorDiscovery } from './engines/cursorDiscovery.js'
import { createCursorTaskHooks, loadPendingCursorTasks } from './engines/cursorTasks.js'
import { databaseHistory, hermesDb } from './transcripts/databaseHistory.js'
import { CONNECTORS_REQUESTS, MEMORY_REQUESTS, ROUTER_REQUESTS, createCoreApi, DEVICES_FALLBACKS, DEVICES_REQUESTS, emptyPorts, HANDOFF_REQUESTS, EXPERIMENTS, LONG_ANSWERS, MODELS_FALLBACKS, MODELS_OFF, MODELS_REQUESTS, MONITOR_FALLBACKS, MONITOR_OFF, MONITOR_REQUESTS, ORCHESTRATOR_FALLBACKS, ORCHESTRATOR_REQUESTS, SHARE_REQUESTS, SHARING_FALLBACKS, PROJECTS_REQUESTS, SEARCH_FALLBACKS, SEARCH_REQUESTS, STORE_FALLBACKS, STORE_OFF, STORE_REQUESTS, TEAMS_FALLBACKS, TEAMS_REQUESTS, USAGE_FALLBACKS, USAGE_REQUESTS, VIEWERS_FALLBACKS, WIFI_FALLBACKS, WINDOW_NAMES_REQUESTS, WORKSPACES_FALLBACKS, type GatewayAccount, type GatewayOps, type GatewayStatus, type RouteAnswer, type TeamsPort, type WindowFocus } from './api.js'
import { createServiceHost, testFaults } from './serviceHost.js'
import { startStalls } from './stall.js'
import { createServiceLinks, type ServiceLinks } from './serviceLinks.js'
import { createViewerStreams } from './viewerStreams.js'
import { createViewersLink } from './viewersLink.js'
import { createWorkspacesLink } from './workspacesLink.js'
import { createMonitorLink } from './monitorLink.js'
import { createStoreLink } from './storeLink.js'
import { createModelsLink } from './modelsLink.js'
import { createRecapsLink } from './recapsLink.js'
import { RECAPS_FALLBACKS, TERMINALS_OFF } from './api.js'
import { answerAgentQuery } from './agentQueries.js'
import { createDeliveries } from './deliveries.js'
import { createTerminalWatch } from './terminalWatch.js'
import { createSharingLink } from './sharingLink.js'
import { createExperimentHooks, wakeExperiments } from './experiments.js'
import { answerExperimentQuery, createForExperiment } from './experimentQueries.js'
import { createOrchestratorLink } from './orchestratorLink.js'
import { daemonCommand } from '../lib/daemonCommand.js'
import { KNOWN_SERVICES, masterRunsEngineRuntime, masterRunsLiveEngines, servicesTheMasterRuns } from '../harnessd/services.js'
import { createTeamsLink, teamsOutOfProcess } from './teamsLink.js'
import { createDevicesLink } from './devicesLink.js'
import { CORE_EXIT_STOP, CORE_EXIT_UPDATE, PROBE_COMMAND } from '../harnessd/protocol.js'
import { localSocketPath, refuseServedDataFolder, type LocalSocketServer } from '../lib/localSocket.js'
import { saveDaemonPort } from '../lib/daemonEndpoint.js'
import { publishHookRoute } from '../lib/hookRoutes.js'
import { BackendSocket, isLocalClientId } from '../backendSocket.js'
import { createGatewayLink, laneOf } from './gatewayLink.js'
import { createWifiCore, WIFI_START_MS } from './wifi.js'
import { createDevicesWake, DEVICES_ON_DEMAND } from './devicesWake.js'
import { wakeModels } from './modelsWake.js'
import { wakeGateway } from './gatewayWake.js'
import { createWifiLink } from './wifiLink.js'
import { wifiDoors } from './wifiAgents.js'
import { autonomousDeviceLocalRequest } from '../lib/deviceManagementHttp.js'
import { attachLocalWsServer, LOCAL_WS_PATH, LOCAL_WS_PROTOCOL_VERSION } from '../localWsServer.js'
import { TERMINAL_BINARY_VERSION } from '../lib/terminalBinary.js'
import { isLoopbackRequest, loopbackHosts } from '../lib/loopbackRequest.js'
import { isInstalledCopy } from '../lib/installedCopy.js'
import { managedNodePath } from '../lib/nodeRuntime.js'
import { type ActivityFrame } from '../lib/turnActivity.js'
import { cursorDataDir } from '../engines/cursor/contract.js'
import { TranscriptPager } from '../lib/transcriptPages.js'
import { AgentCreationReceipts } from '../lib/agentCreationReceipt.js'
import { agentFrame, lastActivityAt, type AgentFrame } from '../lib/agentFrame.js'
import { forgetAgentProject } from '../lib/agentProject.js'
import { createUsageLink } from './usageLink.js'
import type { UsageSnapshots } from './usageLink.js'
import type { AgentUsageTarget } from '../lib/agentUsageWire.js'
import { RuntimeProfileState, type RuntimeModelOption } from '../lib/runtimeProfileState.js'
import { createRuntimeProfiles } from './engines/runtimeProfiles.js'
import { createRuntimeTransport } from './engines/runtimeTransport.js'
import { RuntimeProfileController } from '../lib/runtimeControl.js'
import { installTimestampedConsole, sid, prepareLogFile, trimLogFile, LOG_CHECK_INTERVAL_MS } from '../lib/log.js'
import { backendHttpBase } from '../lib/controlPlane.js'

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
 *
 * Kept by the core, too, because the devices can restart where the windows do not: in a process of
 * their own (step 9), a devices process that starts again is told the desk, the tabs, what is unread
 * and which window has the person's attention, as they stand (services/devices.ts).
 */
let appSwarmsLatest: AppSwarms | null = null
/** What the window still has unread, kept for the same reason. */
let appUnreadLatest: UnreadNotification[] = []

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
 * The master's updater (services/updaterProcess.ts) can stage a build at any moment, and the master then
 * asks this core to hand over (`harnessd:update`), which `runForeground`'s prologue listens for before
 * anything that can throw or hang: a daemon that cannot finish booting must still leave for its fix. That
 * request therefore has to mean something LONG before `restartForUpdate` exists — hence the indirection:
 * `applyStagedUpdate` is `bootHandoff` until the body has built everything `restartForUpdate` tears down,
 * and is swapped for it at that one line.
 */
/** This process's channel to a harnessd master, when one started it (see harnessd/coreLink.ts).
 *  Inert otherwise: a daemon run on its own claims its pid file, and gets no updates. */
const coreLink = connectToMaster()
/** When the devices' process starts: once there is a device, a dial's port, a Wi-Fi device or a request for one
 *  (core/devicesWake.ts). Asked of the master through the channel above. */
const devicesWake = createDevicesWake({ want: (service) => coreLink.want(service), dataDir: env.ADAPTER_DATA_DIR, cableDisabled: env.CABLE_DISABLE, testDialPort: process.env.HARNESSD_TEST_DIAL_PORT })

const daemonBoot: {
  /** Stops the updater this core runs beside itself under a master too old to run it (core/updaterBeside.ts). */
  updaterBeside: (() => void) | null
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
} = { updaterBeside: null, hookServer: null, localSocket: null, markNotReady: null, safeMode: null, handingOff: false, applyStagedUpdate: bootHandoff, openRequests: null }

/**
 * Hand the machine to a newer build without finishing start-up: the master asked (its updater staged one),
 * and starts the new bundle the moment this exits, and judges it.
 *
 * SYNCHRONOUS END TO END, and that is the whole safety argument: never awaiting means the half-built
 * `runForeground` body cannot interleave between the port closing and the exit, so it can never reach the
 * code that would bind the port the successor is about to take. Only a master asks; a core without one
 * gets no updates.
 */
function bootHandoff(version: string): void {
  if (daemonBoot.handingOff) return
  daemonBoot.handingOff = true
  console.log(`[update] ${VERSION} → ${version} staged during start-up — handing back to harnessd`)
  try { daemonBoot.hookServer?.close() } catch { /* already gone */ }
  try { daemonBoot.localSocket?.closeSync() } catch { /* already gone */ }
  process.exit(CORE_EXIT_UPDATE)
}

/** Set by runForeground once the DSH companions exist; a frame projected before that carries none. */
let activityFrameContextRef: ((s: RegisteredSession) => ActivityFrame | null) | null = null

let dshFrameContextRef: ((s: RegisteredSession) => AgentDshContext | null) | null = null

/** Aggregate snapshots only; populated after the optional usage port is composed. */
let usagePortRef: UsageSnapshots | null = null

/** Set by runForeground once models can be asked: what an agent's frame says of its grid. */
let gridAnnotationRef: ((grid: AgentGridTarget) => GridAnnotation | null) | null = null

function projectFrame(s: RegisteredSession, selectedModel: string | null): Promise<AgentFrame> {
  return agentFrame(s, {
    tokenUsage: usagePortRef?.get(s) ?? null,
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

  // ── THE MASTER'S UPDATE IS HEARD FIRST. Everything below this point can throw, hang, or wait on a vendor
  // file, a port, or tmux — and a daemon that never finishes starting must still leave for its fix. The
  // updater is the master's, in a process of its own (services/updaterProcess.ts): the core never
  // downloads a build. When it stages one, the master asks this core to hand over, and the request is
  // listened for here, before anything that can fail.
  //
  // `applyStagedUpdate` is one indirection on purpose: the handoff's teardown does not exist yet and must not
  // move (it tears down two dozen subsystems declared further down). Until it is ready, a staged update is
  // applied by `bootHandoff`, which hands the machine over without finishing start-up.
  coreLink.onUpdate((version) => { void daemonBoot.applyStagedUpdate(version) })
  // Agents held until the service their launch asks is ready, and the passes that launch them
  // (core/agents/heldLaunches.ts): the boot's restore of only those agents, set where tmux is there to restore into.
  const restorePanes = createPaneOperations()
  const restartJobs = new AgentRestartCoordinator()
  const forgetRestartRevision = (agentId: string): void => restartJobs.forget(agentId)
  const restoreRevision = (agentId: string): number => restartJobs.revision(agentId)
  let externalResumes: ReturnType<typeof createExternalResumes> | null = null
  let searchGeneration = 0
  let restoreCancelled = (_agentId: string): boolean => false
  let launchCancelled = (_agentId: string): boolean => false
  let restoreOnly: ((only: ReadonlySet<string>) => Promise<RestoreSummary>) | null = null
  const heldLaunches = createHeldLaunches({
    registry,
    restore: (only) => restoreOnly?.(only) ?? Promise.resolve({ restored: [], skipped: [], failed: [], held: [], unsurveyed: [] }),
    log: (line) => console.log(line),
  })
  wakeGateway({ outOfProcess: servicesTheMasterRuns(process.env, KNOWN_SERVICES), signedIn: !!session, dataDir: env.ADAPTER_DATA_DIR, want: (service) => coreLink.want(service) })
  // …or, under a master too old to run the updater, from the updater this core runs beside itself
  // (core/updaterBeside.ts), in a process of its own: the core downloads no build either way.
  if (needsUpdaterBeside(process.env, coreLink.supervised, isInstalledCopy(SCRIPT_PATH, env.ADAPTER_CLI_DIR), env.ADAPTER_UPDATE_DISABLE)) {
    daemonBoot.updaterBeside = startUpdaterBeside({
      spawn: () => {
        const updater = spawn(managedNodePath(), [SCRIPT_PATH, '__service', 'updater'], {
          env: { ...process.env, HARNESSD_SERVICE: 'updater', HARNESSD_UPDATER_BESIDE_CORE: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        })
        updater.on('error', (e) => console.error('[update] the updater could not start:', e instanceof Error ? e.message : e))
        return { onMessage: (listener) => { updater.on('message', listener) }, onExit: (listener) => { updater.on('exit', listener) }, kill: () => { updater.kill() } }
      },
      staged: (version) => { void daemonBoot.applyStagedUpdate(version) },
      log: (line) => console.log(line),
    })
  }
  // The update handoff (core/updateHandoff.ts): after the update is listened for, never above it
  // (startupOrder.spec.ts), and ahead of the /api/status handler that reads whether it is under way.
  const updateHandoff = createUpdateHandoff({
    version: VERSION, supervised: coreLink.supervised, exitForUpdate: () => process.exit(CORE_EXIT_UPDATE),
    // A core on its own that an older release started: its master must answer its probe, as a master asks
    // before it re-executes on a bundle; then the master takes the machine, and runs the updater.
    probeMaster: () => probeStagedMaster((done) => execFile(managedNodePath(), [SCRIPT_PATH, PROBE_COMMAND], { encoding: 'utf8' }, (error, stdout) => done(error, stdout))),
    handOff: () => { startMasterHere(); process.exit(0) },
    log: (line) => console.log(line), error: (line) => console.error(line),
  })

  // Another daemon serves this data folder: leave before reading or writing anything of its — its
  // registry, its viewers, its panes. Just after the update is listened for, never before it
  // (startupOrder.spec.ts).
  await refuseServedDataFolder(localSocketPath(env.ADAPTER_DATA_DIR, env.PORT))

  // harnessd's master saw this core crash again and again: start nothing that could do it again. The
  // master's updater runs on, and a published fix still lands (`enterSafeMode`).
  if (process.env.HARNESSD_SAFE_MODE) throw new SafeModeRequest(process.env.HARNESSD_SAFE_MODE)

  const savedApis = new ApiConnectionMetadata(env.ADAPTER_DATA_DIR)
  // Instructions read metadata locally; a models outage must not change a workspace's tool instructions.
  const prepareApiTools = (cwd: string | null | undefined, engine: string): void => {
    if (!cwd) return
    try { prepareApiInstructions(savedApis, cwd, engine) }
    catch { console.warn('[apis] Tool instructions could not be added. Saved connections remain available through harness api.') }
  }

  // What a session of another engine reads starts loading as the session enters, from disk or later
  // (engines/inProcess.ts).
  registry.onEnter = preloadEngine
  registry.load()
  // Bindings can finish before full teardown exists, or during its awaits. Cover every owned exit,
  // including a staged update received during startup, without touching a different daemon's table.
  process.on('exit', () => registry.flush({ exiting: true }))
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
  // local socket and the backend link, leave for an update, and say what is missing. Refusing instead left a
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
  restoreCancelled = (agentId) => pinnedControls.has(agentId)
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
  // engine no agent uses is a worker nobody asked for. It is the devices' (services/devices.ts), which are
  // told again as they start.
  const syncRecapPool = (): void => {
    ports.devices?.engines(registry.active().map((session) => session.engine))
  }
  const outOfProcess = servicesTheMasterRuns(process.env, KNOWN_SERVICES)
  const liveHosted = masterRunsLiveEngines(process.env, process.ppid)
  const runtimeHosted = liveHosted && masterRunsEngineRuntime(process.env, process.ppid)
  // An older master's explicit capability report selects compatibility. A failed worker never does.
  const isolatedLive = (engine: string): boolean => liveHosted
    && readerEngine(engine) && outOfProcess.has(READER_SERVICES[engine])
  const questionControlHosted = masterRunsEngineQuestionControl(process.env, process.ppid)
  const isolatedQuestionControl = (engine: string): boolean => questionControlHosted && isolatedLive(engine)
  const modelControlHosted = masterRunsEngineModelControl(process.env, process.ppid)
  const isolatedModelControl = (engine: string): boolean => modelControlHosted && isolatedLive(engine)
  const screenHosted = masterRunsEngineScreen(process.env, process.ppid)
  const isolatedScreen = (engine: string): boolean => screenHosted && isolatedLive(engine)
  const submissionHosted = masterRunsEngineSubmission(process.env, process.ppid)
  const nativeControlHosted = masterRunsEngineNativeControl(process.env, process.ppid)
  const isolatedNativeControl = (engine: string): boolean => nativeControlHosted && isolatedLive(engine)
  const isolatedSubmission = (engine: string): boolean => submissionHosted && isolatedLive(engine)
  const isolatedRuntime = (engine: string): boolean => runtimeHosted && isolatedLive(engine)
  const inline = KNOWN_SERVICES.some((name) => !outOfProcess.has(name)) || !runtimeHosted || !screenHosted || !modelControlHosted || !questionControlHosted || !submissionHosted || !nativeControlHosted
    ? await import('../services/inline.js') : null
  let serviceLinksRef: ServiceLinks | null = null
  const runtimeTransport = createRuntimeTransport({
    call: (service, type, payload, waitMs) => serviceLinksRef?.call(service, type, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
  })
  const screenTransport = createScreenTransport({
    call: (service, type, payload, waitMs) => serviceLinksRef?.call(service, type, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
  })
  const screens = createScreens({ handles: isolatedScreen, transport: screenTransport, resolve: id => registry.resolve(id),
    inline: (engine, capture) => readerEngine(engine) ? capture === null ? undefined : inline?.screenFor(engine).inspect(capture) : inProcessScreen(engine, capture) })
  const submissionTransport = createSubmissionTransport({
    call: (service, type, payload, waitMs) => serviceLinksRef?.call(service, type, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
  })
  const submissions = createSubmissions({ policy: submissionPolicy, handles: isolatedSubmission, transport: submissionTransport, resolve: id => registry.resolve(id),
    inline: engine => inline?.submissionFor(engine) })
  // Codex's shared app-server, spoken to from its worker: core identifies the conversation and decides.
  const nativeControls = createNativeControls({
    call: (service, type, payload, waitMs) => serviceLinksRef?.call(service, type, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
    servers: Object.fromEntries(Object.entries(engineLaunches).flatMap(([name, launch]) => 'sharedServer' in launch && launch.sharedServer ? [[name, launch.sharedServer]] : [])),
    handles: isolatedNativeControl, inline: engine => isolatedNativeControl(engine) ? undefined : inline?.nativeControlFor(engine),
    rows: processRows, home: session => sessionCodexHome(session), argv: argvTokens, readFile: path => readFile(path, 'utf8'),
  })
  // Which engine workers are linked now: a close's read refused by a restart waits here for the new link.
  const engineLinks = createEngineLinks()
  const runtimeProfiles = createRuntimeProfiles({
    local: new RuntimeProfileState(engine => isolatedRuntime(engine) ? undefined : inline?.runtimeFor(engine), id => registry.resolve(id)),
    handles: isolatedRuntime,
    resolve: id => registry.resolve(id), transport: runtimeTransport })
  const questionControls = createQuestionControls({
    handles: isolatedQuestionControl, inline: engine => inline?.questionControlFor(engine), resolve: id => registry.resolve(id),
    call: (service, method, payload, waitMs) => serviceLinksRef?.call(service, method, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
    text: (target, text, allowed) => submitTerminal(target, text, { allowed }), key: keyTerminal,
  })
  const modelControls = createModelControls({
    handles: isolatedModelControl, inline: engine => inline?.modelControlFor(engine), resolve: id => registry.resolve(id),
    call: (service, method, payload, waitMs) => serviceLinksRef?.call(service, method, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
    catalog: session => runtimeProfiles.codexCatalog(session), capture: captureTerminal,
    text: (target, text, allowed) => submitTerminal(target, text, { allowed }), key: keyTerminal,
    waitForModel: (id, ms) => runtimeProfiles.waitForModel(id, ms), waitForProfile: (id, ms) => runtimeProfiles.waitForProfile(id, ms),
    confirmEffort: (id, effort) => runtimeProfiles.confirmEffort(id, effort),
  })
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
  const announceSession = agentEvents.announceSession

  // Conversations on this machine that Harness did not start, found where each engine keeps them so
  // Cmd-P can find them and open one here; and which sessions a process has open right now. Harness's
  // own byproducts (recaps run in its data folder) are never among them.

  // The core's one session manager: the backend link, the gateway's dials, the fleet's lane and the dial's
  // transcriber all take their tokens from it, so a refresh in flight is shared rather than raced.
  const auth = new AuthSessionManager(backendHttpBase())
  /** Whether a dial on this computer is watching it, as the devices last said (`clients.dialWatching`). */
  let dialWatching = false
  /** The last `dial_status` the devices sent the windows: a window that connects afterwards is told it. */
  let lastDialStatus: Record<string, unknown> = { attached: false }
  /** The local socket, once it exists: the window bridges ask one window through it. */
  let localWsServerRef: { sendToWindow(connId: string, frame: { type: string; payload: Record<string, unknown> }): boolean } | null = null
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
  const ports = emptyPorts()
  // The Wi-Fi device's service runs with the dials (services/wifi.ts); what the core reads in line of it
  // (who is watching, which transcripts and streams it follows, the focus revision) and the check on every
  // answer it sends a device are here (core/wifi.ts). Its doors are the calls it made when it ran here.
  const machineIdNow = (): string => backendRef?.machineId ?? ''
  const wifiCore = createWifiCore({
    port: () => ports.wifi,
    gateway: {
      device: (connId, type, payload) => backendRef?.deviceFrame(connId, type, payload),
      deviceClient: (connId, identity) => backendRef?.deviceClient(connId, identity),
      revokeIdentity: (identity) => gatewayOps.revokeIdentity(identity),
    },
    remoteClient: (connId) => backendRef?.remoteClient(connId) ?? null,
    fullText: (agentId) => mirror.lastFullText(registry.byAgent(agentId)?.sessionId ?? agentId),
    joined: () => backendRef?.onCommanderJoin?.(),
    // Its direct links are the gateway's, started only once it serves: a device they connected to a service
    // that could not be built would be answered by nothing.
    ready: () => gatewayOps.wifiService(true),
    want: () => devicesWake.ask('wifi', 'a Wi-Fi device'),
    doors: wifiDoors({
      registry, machineId: machineIdNow, displayName: projectDisplayName, running: (sessionId) => turnStartedAt.has(sessionId),
      socket: () => backendRef ?? null, deviceInput: () => deviceInput, answer: (request) => questions.answer(request),
      stop: (agentId) => cancelAgent(agentId, true), devices: () => ports.devices,
    }),
  })
  const coreApi = createCoreApi({
    // Agents' terminals: a literal-argv launch, and a read-only view for Share's observers (core/terminalWatch.ts).
    terminals: { ...TERMINALS_OFF, ...createTerminalOpener({ tmuxBackend, registry, announceSession, blocksFolder: (cwd) => !!backendRef?.purgeAgentService?.blocksFolder(cwd) }), watch: terminalWatch.watch },
    dataDir: env.ADAPTER_DATA_DIR,
    registry,
    stoppedAgents,
    databaseHistory,
    syncSession,
    runtimeModels,
    viewerChanged: () => {}, // nothing in the core forwards to a viewer: the viewers follow their own (services/viewers.ts)
    viewerFrame: (connId, type, payload) => backendRef?.sendViewerFrame(connId, type, payload) ?? false,
    gridNamed: (name) => backendRef?.setHarnessGridName(name),
    gridModelsChanged: () => { void backendRef?.pushGridModels() },
    privateGridName: async () => backendRef?.gridName() ?? null,
    machineName: () => backendRef?.machineName() ?? null,
    // An experiment's account-wide settings (Tab collaboration's tab channels), signed in by this core.
    backend: (method, path, body) => proxyBackend(method, path, body),
    onNotice: (listener) => experimentHooks.onNotice(listener),
    dshInstallStatus: (status) => backendRef?.send({ type: 'dsh_install_status', payload: status }),
    // The recaps' cards and recaps (services/recaps.ts) down the doors they took from here, and a turn's final answer.
    turnCard: (frame) => backendRef?.sendCommander(frame), turnSummary: (frame) => backendRef?.send(frame), lastTurn: (sessionId) => readLastTurn(sessionId),
    // The backend mints and remembers the account's grid name; this CLI holds neither the account's
    // email nor its id. An older backend (no route) answers nothing, which the grid reconcile treats as
    // "no grid yet". Bounded so a stalled control-plane connection cannot hold the attempt open.
    mintGridName: () => gatewayOps.mintGridName(),
    accessToken: (options) => auth.accessToken(options),
    // The fleet's lane's sessions are the gateway's, which holds this machine's E2EE identity; it starts
    // below, before the devices whose fleet seals through it.
    lane: laneOf(() => gatewayOps.lane),
    signedIn: () => readAuthSession() !== null,
    environment: () => readAuthSession()?.autonomousEnv ?? env.AUTONOMOUS_ENV,
    // Built further down, with the account proxies: read when the devices ask, never now.
    machines: () => gatewayOps.machines(),
    machine: {
      id: () => backendRef?.machineId ?? '',
      computerId: () => computerId(),
      name: () => dialMachineName(),
    },
    // The dial's working card: what a Claude Code or Codex pane's footer says, read here so the pane never
    // leaves the core.
    activityText: async (agentId) => {
      const session = registry.resolve(agentId)
      if (!session || (session.engine !== 'claude' && session.engine !== 'codex')) return null
      const screen = await terminals.capture(session, { mode: 'visible', ansi: false })
      return (await screens.read(session, screen.state === 'succeeded' ? screen.value : null))?.activity?.label ?? null
    },
    // The devices' frames for the windows on this computer, never the cloud (createCoreApi checks their types).
    sendLocal: (frame) => {
      if (frame.type === 'dial_status') lastDialStatus = frame.payload
      backendRef?.sendLocal(frame)
    },
    sendToWindow: (connId, frame) => localWsServerRef?.sendToWindow(connId, frame) ?? false,
    hasWindow: () => backendRef?.hasLocalClient() ?? false,
    devicesChanged: (payload) => backendRef?.send({ type: 'harness_devices_changed', payload }),
    wifi: wifiCore.api,
    dialWatching: (watching) => {
      const attached = watching && !dialWatching
      dialWatching = watching
      // A dial attaching is shown what is still being asked and what is still working, as a device joining
      // through the backend is (onCommanderJoin): one whose devices' process restarted comes back to tiles
      // mid-turn, and to a question nobody has answered yet.
      // The working tiles are the recaps' to say: asked, and sent to the dial when they answer.
      if (attached) for (const frame of openQuestions.values()) ports.devices?.card(frame)
      if (attached) void mirror.liveCards().then((cards) => { for (const frame of cards) ports.devices?.card(frame) })
    },
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
      recent: async (agentId, n) => mirror.recent(registry.resolve(agentId)?.sessionId || agentId, n),
      asks: async (agentId) => mirror.recentAsks(registry.resolve(agentId)?.sessionId || agentId),
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
  const liveFor: LiveFor = (engine) => isolatedLive(engine) ? undefined : inline?.liveFor(engine)
  // The relay and its E2EE (gateway/): the backend link, the sessions and the keys, which every remote
  // client's frames go through, held at the same gate. In its own process by default (core/gatewayLink.ts),
  // or here (gateway/start.ts); the socket hears it through `fromGateway` and speaks to it in the clear.
  Object.assign(coreApi.terminals, createTerminalSessions({ agents: coreApi.agents, paneState: tmuxPaneState, processState: checkPidRuntime }))
  const account = (s = readAuthSession()): GatewayAccount => ({ machineId: s?.machineId ?? null, signIn: signInOf(s?.signInEpoch, s?.signInAcct), autonomousEnv: s?.autonomousEnv ?? env.AUTONOMOUS_ENV })
  const engineReaders = createEngineReaders({ isolated: outOfProcess, inline: inline?.engineTranscriptFor,
    call: (service, type, payload, waitMs) => serviceLinksRef?.call(service, type, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }) })
  const liveTransport = createLiveTransport({
    call: (service, type, payload, waitMs) => serviceLinksRef?.call(service, type, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
  })
  const gatewayLink = outOfProcess.has('gateway') ? createGatewayLink({
    events: backend.fromGateway,
    notify: (frame) => serviceLinksRef?.notify('gateway', frame) ?? false,
    notifyBinary: (bytes) => serviceLinksRef?.notifyBinary('gateway', bytes) ?? false,
    buffered: () => serviceLinksRef?.buffered('gateway') ?? 0,
    call: (type, payload, waitMs) => serviceLinksRef?.call('gateway', type, payload, waitMs) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
    start: () => ({ machineId: backend.machineId, computerId: computerId(), autonomousEnv, signedIn: !!session?.machineId, account: account(), machineName: terminalHintMachineName(), hostname: hostname() }),
    tokens: auth, backend: (method, path) => proxyBackend(method, path), want: () => coreLink.want('gateway'),
    machines: ({ body }) => ports.models?.machines(body, computerId()),
  }) : null
  const gateway = gatewayLink ?? inline!.startGateway({
    events: backend.fromGateway, machineId: backend.machineId, computerId: computerId(), autonomousEnv,
    signedIn: !!session?.machineId, tokens: auth, account: account(), machineName: terminalHintMachineName(), hostname: hostname(),
    machines: ({ body }) => ports.models?.machines(body, computerId()),
  })
  backend.useGateway(gateway.port)
  backend.useWifi(wifiCore.fromGateway)
  const gatewayOps = gateway.ops
  daemonBoot.openRequests = () => backend.openRequests()
  const teams: TeamsPort = {
    prepare: (...args) => ports.teams?.prepare(...args) ?? (() => {}),
    started: (...args) => ports.teams?.started(...args),
    raw: (...args) => ports.teams?.raw(...args),
    forget: (agentId) => ports.teams?.forget(agentId),
    canWrite: (deliveryId) => ports.teams?.canWrite(deliveryId) ?? false,
  }
  // This machine's viewers, served to a client over its connection by the viewers (core/viewerStreams.ts).
  backend.viewerStreams = createViewerStreams(() => ports.viewers, (connId, type, payload) => backend.sendViewerFrame(connId, type, payload))

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
  /** A dial plugged into this computer, as the devices said last (`clients.dialWatching`): kept here so
   *  the cards are made for it in line, without asking the devices, which may be in another process. */
  const cableWatchingLocal = (): boolean => dialWatching

  const deviceIsWatching = (): boolean => backend.hasCommander() || cableWatchingLocal() || wifiCore.connected()
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
  const { watcher, live: engineLive } = createLiveWatcher(new Watcher(), {
    handles: isolatedLive,
    transport: liveTransport,
    bySession: (id) => registry.bySession(id),
    prepareFrames: (session, frames) => runtimeProfiles.prepareFrames(session, frames),
    frame: (session, frame) => ingest.acceptFrame(session.sessionId, session.engine, frame, runtimeProfiles.handles(session.engine)),
    reattach: (session) => attachSession(session, true),
    hold: (session, reason) => attach.holdInterpretation(session, reason),
  })
  // Whether a turn is really working, beyond its transcript (core/turns/activity.ts).
  const activity = createTurnActivity({
    readScreen: screens.read,
    terminals,
    bySession: (sessionId) => registry.bySession(sessionId),
    sessionTurnOpen,
    drain: (sessionId) => watcher.pollSession(sessionId),
    nativeActivity: (session) => nativeControls.activity(session),
  })
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
  const cursorDiscovery = createCursorDiscovery(cursorDataDir(), (sessionId, transcriptPath) => {
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
    // The file is authoritative now. Publishing its binding must not wait for an optional reader.
    syncRecapPool()
    syncSession(result.entry)
    void attachSession(result.entry, false, true).catch((err) => {
      console.error('[cursor-discovery] attach failed:', err instanceof Error ? err.message : err)
    })
  })

  // Where an engine's writing becomes live again after a resume or a daemon restart, read by the attach
  // that follows (core/transcripts/relaunch.ts).
  const relaunchMarks = createRelaunchMarks()
  // Following a session: its history read into its engine's normalizer, then its tail
  // (core/transcripts/attach.ts).
  const attach = createAttach({
    setInterpretationHold: registry.setInterpretationHold.bind(registry),
    announceSession,
    liveFor,
    resolve: id => registry.resolve(id),
    remoteLive: engineLive,
    terminalGone: terminalControl.terminalGone,
    normalizers,
    watcher,
    cursorDiscovery,
    device: () => wifiCore.feed,
    runtimeProfiles,
    captureTerminal,
    emit: (sessionId, events, opts) => emitSessionEvents(sessionId, events, opts),
    announceTurnAborted,
    // Built further down: read when an attach starts watching a pane, never now.
    questionWatcher: { start: (sessionId) => questionWatcher.start(sessionId) },
    terminalLabel: primaryTerminalLabel,
    dbs: { opencode: OPENCODE_DB, kilo: KILO_DB, devin: DEVIN_DB },
    devinHome: env.DEVIN_HOME,
    hermesDb,
    concurrency: ATTACH_CONCURRENCY,
    relaunchMarks,
    // Built further down: told when an attach finds its last turn already over, never now.
    settled: (sessionId) => mirror.settled(sessionId),
  })
  const attaches = attach.attaches
  const attachSession = attach.attachSession
  const neverFoldedHistory = attach.neverFoldedHistory
  const replayedFirstTurn = attach.replayedFirstTurn
  // A conversation's history, a page at a time, and how long it is (core/transcripts/history.ts).
  const history = createHistory({ readerFor: engineReaders.forEngine, resolve: (id) => registry.resolve(id), stopped: () => stoppedAgents.list(),
    pages: new TranscriptPager(), dbs: { opencode: OPENCODE_DB, kilo: KILO_DB, devin: DEVIN_DB },
    hermesDb })
  backend.historyProvider = history.sessionGet
  backend.sessionsProvider = history.sessionsList
  // Everything the core writes into a pane, and the device's pane lock (core/input.ts).
  const inputs = createInput({
    readScreen: screens.read,
    submission: submissions,
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
    device: () => wifiCore.feed,
    clients: backend,
    // Declared further down: read when an error is reported, never now.
    agentIdFor: (sessionId) => agentIdFor(sessionId),
    commandcode: (sessionId) => commandcodeNormalizers.get(sessionId),
    // Reassigned further down (the funnel): always the current one.
    emit: (sessionId, events) => emitSessionEvents(sessionId, events),
    // Declared further down: read as a prompt is typed, never now.
    promptTyped: (session, capture, screen) => { if (session.sessionId) questionWatcher.notePrompt(session.sessionId, capture, screen.question) },
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
    questionControlFor: questionControls.forSession,
    readQuestion: screens.question,
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
  const questionWatcher = asking.questionWatcher


  // The turn's last text, for its recap, whatever the engine (core/transcripts/lastTurn.ts).
  const readLastTurn = createLastTurnReader({
    readerFor: engineReaders.forEngine,
    bySession: (sessionId) => registry.bySession(sessionId),
    dbs: { opencode: OPENCODE_DB, kilo: KILO_DB, devin: DEVIN_DB },
    hermesDb,
  })
  // Recaps: turn cards, notifications, cut by the recaps (services/recaps.ts) from the lifecycle the core tells (core/turns/recaps.ts).
  const recaps = createRecaps({
    port: () => ports.recaps, turnActivity, clients: backend, deviceIsWatching, cableWatchingLocal, sessionTurnOpen,
    bySession: (sessionId) => registry.bySession(sessionId), resolve: (id) => registry.resolve(id), live: () => registry.list(),
    stopped: (agentId) => stoppedAgents.get(agentId),
    orchestratorRoleOf: (agentId) => ports.orchestrator?.roleOf(agentId) ?? null,
  })
  asking.hearQuestions(recaps.question) // a turn waiting on the person is not announced as done
  const isSubagentSession = recaps.isSubagentSession
  const mirror = recaps.mirror
  // Recaps are STORED under the engine session id — that is what lets `--resume` bring the last recap
  // back under a brand-new agent — but they are ASKED FOR by agent id, which is the only id the device
  // and the voice router know. Resolve across the two, or every tile restores empty.
  backend.agentRecentProvider = recaps.agentRecent

  // Quiet-machine QA: the edge host renders Change agent's handoff from these conversation reads.
  // Build discovery once to keep "one search per agent" across requests.
  coreApi.conversations = conversationReads(handoffProviderDeps({
    registry,
    stopped: {
      get: (id) => stoppedAgents.get(id),
      // Every saved record, readable or not (the store's own `list()` skips an unreadable one), so ownership fails closed.
      ids: () => stoppedAgents.ids(),
    },
    mirror,
    databaseHistory,
    findLiveSession,
    processSession: processSessionOf,
    isRecentlyDeleted,
    findResumedTranscript,
    validTranscriptPath,
  }))

  // The requests each service that can run in its own process answers, as core/api.ts declares them.
  const requestsOf: Record<string, readonly string[]> = {
    search: SEARCH_REQUESTS, store: STORE_REQUESTS, usage: USAGE_REQUESTS, monitor: MONITOR_REQUESTS, projects: PROJECTS_REQUESTS, models: MODELS_REQUESTS, handoff: HANDOFF_REQUESTS, connectors: CONNECTORS_REQUESTS,
    devices: DEVICES_REQUESTS, windowNames: WINDOW_NAMES_REQUESTS, shell: SHELL_REQUESTS,
    ...Object.fromEntries(Object.entries(EXPERIMENTS).map(([name, experiment]) => [name, experiment.requests])),
  }
  // The experiments (core/api.ts `EXPERIMENTS`): each may act on the core through the hooks an experiment has.
  const experiments = new Set(Object.keys(EXPERIMENTS))
  // What the core keeps of the orchestrator in its own process: each agent's role, and which frames are its
  // Directors' (core/orchestratorLink.ts).
  const orchestratorLink = createOrchestratorLink((frame) => serviceLinks.notify('orchestrator', frame))
  // What the core keeps of the viewers in their own process, for the frames it builds (core/viewersLink.ts).
  const viewersLink = createViewersLink(coreApi, (frame, opts) => serviceLinks.notify('viewers', frame, opts),
    { call: (type, payload, waitMs) => serviceLinks.call('viewers', type, payload, waitMs), buffered: () => serviceLinks.buffered('viewers') })
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
  const storeLink = createStoreLink(coreApi, invalidateInstalledDsh, (type, payload) => serviceLinks.call('store', type, payload))
  storeLink.onReady(() => { void heldLaunches.restoreHeld('store') })
  // What the core keeps of models in its own process for frames and keystrokes, and how it asks it the rest (core/modelsLink.ts).
  const modelsLink = createModelsLink(coreApi, (type, payload) => serviceLinks.call('models', type, payload), (frame) => serviceLinks.notify('models', frame))
  // The devices in their own process (core/devicesLink.ts): told what the windows say, asked ⌘K, and told it
  // all again whenever they connect, from what the core keeps.
  const devicesLink = createDevicesLink({
    core: coreApi,
    notify: (frame) => serviceLinks.notify('devices', frame),
    call: (type, payload, waitMs) => serviceLinks.call('devices', type, payload, waitMs),
    state: () => ({ desk: appPaneAgents, foreground: appWindowForeground, swarms: appSwarmsLatest, unread: appUnreadLatest,
      focus: windowFocus(), engines: registry.active().map((agent) => agent.engine), commanders: backend.hasCommander() }),
  })
  // The Wi-Fi device in the devices' process (core/wifiLink.ts): its sessions' requests and what the agents do,
  // in order; on each connection, what the core holds for it (core/wifi.ts).
  const wifiLink = createWifiLink({
    core: coreApi,
    notify: (frame) => serviceLinks.notify('wifi', frame),
    call: (type, payload, waitMs) => serviceLinks.call('wifi', type, payload, waitMs),
  })
  // Its port from the start: its process connects as soon as the socket answers, before the rest of the
  // core is wired, and is resumed through this port then (core/wifi.ts `started`).
  if (outOfProcess.has('wifi')) ports.wifi = wifiLink.port
  // What the core tells the recaps in their own process, and reads back from what they said (core/recapsLink.ts).
  const recapsLink = createRecapsLink({ notify: (frame, opts) => serviceLinks.notify('recaps', frame, opts), buffered: () => serviceLinks.buffered('recaps'),
    call: (type, payload) => serviceLinks.call('recaps', type, payload), clients: coreApi.clients, lastTurn: coreApi.transcripts.lastTurn })
  const usageLink = createUsageLink({ call: payload => ports.usage?.read(payload.target as AgentUsageTarget) ?? Promise.resolve({}), changed: agentEvents.onTokenUsageChanged })
  const serviceLinks = createServiceLinks({
    token: serviceToken,
    owned: Object.fromEntries([...outOfProcess].map((name) => [name, requestsOf[name] ?? []])),
    waits: LONG_ANSWERS,
    // An experiment's process runs once on, the devices' once there is one, models' and the gateway's once needed: a request asks.
    // Shell is in the always-running edge host, but its first request can beat that host's connection.
    // Hold it through the same bounded startup gate; after any disconnect, fail promptly as before.
    onDemand: new Set([...experiments, ...DEVICES_ON_DEMAND, ...Object.values(READER_SERVICES), 'models', 'gateway', 'shell']),
    want: (service) => experimentHooks.want(service),
    // The gateway's first: its `backend` reads (the device key log) were refused below as NOT_AN_EXPERIMENT.
    answer: async (service, query, payload) => await questionControls.answer(service, query, payload) ?? await modelControls.answer(service, query, payload) ?? await nativeControls.answer(service, query, payload) ?? engineReaders.answer(service) ?? (service === 'gateway' && gatewayLink ? gatewayLink.answer(query, payload) : null) ?? deliveries.answer(service, query, payload)
      ?? await answerExperimentQuery(coreApi, experiments, service, query, payload)
      ?? await terminalWatch.answer(service, query, payload)
      ?? (service === 'orchestrator' ? orchestratorLink.answer(query, payload) : null)
      ?? (service === 'viewers' ? viewersLink.answer(query, payload)
      : service === 'workspaces' ? workspacesLink.answer(query, payload)
      : service === 'store' ? storeLink.answer(query, payload)
      : service === 'models' ? modelsLink.answer(query, payload)
      : service === 'teams' || service === 'collaboration' ? teamsLink.answer(query, payload)
      : service === 'devices' ? devicesLink.answer(query, payload)
      : service === 'wifi' ? wifiLink.answer(query, payload)
      : service === 'handoff' ? answerConversationQuery(coreApi, query, payload)
      : service === 'shell' ? answerShellQuery(coreApi, query, payload)
      : service === 'recaps' ? recapsLink.answer(query, payload) : answerAgentQuery(coreApi, query, payload)),
    // The gateway's own traffic: its remote clients and what they sent, and its comings and goings; and what
    // the devices tell the core (a turn, a frame for the windows, a dial on the wire); a viewer stream's answers.
    notice: (service, payload) => { if (service === 'gateway') gatewayLink?.notice(payload); else if (service === 'devices') devicesLink.notice(payload); else if (service === 'wifi') wifiLink.notice(payload); else if (service === 'viewers') viewersLink.notice(payload); else if (service === 'recaps') recapsLink.notice(payload) },
    binary: (service, bytes) => { if (service === 'gateway') gatewayLink?.binary(bytes) },
    connected: (service) => {
      engineReaders.connected(service)
      liveTransport.connected(service)
      runtimeTransport.connected(service)
      screenTransport.connected(service)
      submissionTransport.connected(service)
      nativeControls.connected(service)
      engineLinks.connected(service)
      modelControls.connected(service)
      questionControls.connected(service)
      if (service === 'search') { searchGeneration++; externalResumes?.wake() }
      if (service === 'usage') usageLink.connected()
      if (service === 'gateway') gatewayLink?.connected()
      if (service === 'teams') teamsLink.on()
      if (service === 'devices') devicesLink.connected()
      if (service === 'wifi') wifiCore.started(appVoiceFocus ?? null)
      devicesWake.connected(service)
      // A service up again (or up at last): the agents held for it are launched (core/agents/heldLaunches.ts).
      void heldLaunches.restoreHeld(service)
    },
    disconnected: (service) => {
      if (service === 'search') searchGeneration++
      if (service === 'usage') usageLink.disconnected()
      engineReaders.disconnected(service)
      liveTransport.disconnected(service)
      runtimeTransport.disconnected(service)
      screenTransport.disconnected(service)
      submissionTransport.disconnected(service)
      nativeControls.disconnected(service)
      engineLinks.disconnected(service)
      modelControls.disconnected(service)
      questionControls.disconnected(service)
      if (service === 'gateway') gatewayLink?.disconnected()
      if (service === 'devices') devicesLink.disconnected()
      if (service === 'wifi') wifiCore.stopped()
      if (service === 'recaps') recapsLink.disconnected()
      void terminalWatch.gone(service)
    },
  })
  serviceLinksRef = serviceLinks
  // A request a service declared goes to it: in its own process, or in this one (core/serviceHost.ts).
  backend.serviceRouter = (type, payload, asker, reply) => (teamsOut && teamsLink.route(type, payload, asker, reply))
    || serviceLinks.route(type, payload, asker, reply) || serviceHost.route(type, payload, asker, reply)
  // The connection that asked closed: the services abort what it asked, wherever they run.
  backend.onConnectionClosed = (connId) => { serviceLinks.closeConnection(connId); serviceHost.closeConnection(connId) }
  // Session search (services/search.ts): in this process, or in its own (services/searchProcess.ts),
  // where the core tells it what changed. A purge's forgetting waits for it if it is down.
  if (outOfProcess.has('search')) {
    ports.search = {
      inspect: async request => externalSessionAnswer(await serviceLinks.call('search', 'external_inspect', { ...request }, 4_000), request),
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
  if (outOfProcess.has('store')) ports.store = storeLink.port
  else serviceHost.start('store', (core, installedPorts) => inline!.startStoreInCore(core, installedPorts, () => { void heldLaunches.restoreHeld('store') }), coreApi, STORE_FALLBACKS, STORE_REQUESTS)
  // This machine's Claude and Codex rate limits, read with its own credentials (services/usage.ts): in this
  // process, or in the edge host (services/usageProcess.ts).
  if (outOfProcess.has('usage')) ports.usage = { read: target => serviceLinks.call('usage', 'agentUsage', { target }), stop: () => {} }
  else serviceHost.start('usage', inline!.startUsageInCore, coreApi, USAGE_FALLBACKS, USAGE_REQUESTS)
  usagePortRef = usageLink.port
  backend.tokenUsageProvider = target => usageLink.port.get(target)
  coreApi.usage = target => usageLink.readSnapshot(target, coreApi.agents.all())

  // This machine's and each agent's resources, for the Monitor and the list's readings (services/monitor.ts):
  // in this process, or in the edge host (services/monitorProcess.ts), asked through its port (core/monitorLink.ts).
  if (outOfProcess.has('monitor')) ports.monitor = createMonitorLink((type, payload) => serviceLinks.call('monitor', type, payload))
  else serviceHost.start('monitor', inline!.startMonitor, coreApi, MONITOR_FALLBACKS, MONITOR_REQUESTS)
  // An agent's branch and pull request, a project's repository and preview, a folder's subfolders and a
  // media file from an agent's project (services/projects.ts), and a window's name (services/windowNames.ts):
  // in this process, or in the edge host.
  if (!outOfProcess.has('projects')) serviceHost.serve('projects', inline!.startProjects, coreApi, PROJECTS_REQUESTS)
  if (!outOfProcess.has('windowNames')) serviceHost.serve('windowNames', inline!.startWindowNames, coreApi, WINDOW_NAMES_REQUESTS)
  if (!outOfProcess.has('memory')) serviceHost.serve('memory', inline!.startMemory, coreApi, MEMORY_REQUESTS)
  if (!outOfProcess.has('router')) serviceHost.serve('router', inline!.startRouter, coreApi, ROUTER_REQUESTS)
  if (!outOfProcess.has('handoff')) serviceHost.serve('handoff', inline!.startHandoff, coreApi, HANDOFF_REQUESTS)
  // Connected services' MCP bridge and the Connectors screen (services/connectors.ts): here, or in the edge host.
  if (!outOfProcess.has('connectors')) serviceHost.serve('connectors', inline!.startConnectors, coreApi, CONNECTORS_REQUESTS)
  // The recaps: in this process, or in the edge host (services/recapsProcess.ts), told each turn's lifecycle.
  if (outOfProcess.has('recaps')) ports.recaps = recapsLink.port; else serviceHost.start('recaps', inline!.startRecaps, coreApi, RECAPS_FALLBACKS)
  if (!outOfProcess.has('shell')) serviceHost.serve('shell', inline!.startShell, coreApi, SHELL_REQUESTS)
  // Models: grid access and its pin, the model pictures on agents' frames, the keystroke prewarm, where an
  // agent on a grid model sends its inference, and the models requests the apps send (services/models.ts):
  // in this process, or in its own (services/modelsProcess.ts), reached through core/modelsLink.ts.
  if (outOfProcess.has('models')) ports.models = modelsLink.port
  else serviceHost.start('models', inline!.startModels, coreApi, MODELS_FALLBACKS, MODELS_REQUESTS)
  // What the socket asks of models: read on each use, so a models service switched off answers its fallbacks.
  backend.models = () => ports.models ?? MODELS_OFF

  const runtimeController = new RuntimeProfileController({
    modelControlFor: modelControls.forSession,
    readScreen: screens.read,
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
    tokenUsage: { changed: target => usageLink.port.changed(target) },
    agentIdFor,
    turnActivity,
    isSubagentSession,
    clients: backend,
    search: sessionSearch,
    turnStartedAt,
    input,
    teams,
    deviceInput,
    submission: submissions,
    device: () => wifiCore.feed,
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
    forgetAttach: attach.forget,
    onRemoved: (agentId) => forgetRestartRevision(agentId),
    relaunchMarks,
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
    forgetRelaunch: relaunchMarks.forget,
    stoppedAgents,
    registry,
    send: frame => backend.send(frame),
    publishStoppedAgent: saved => backend.publishStoppedAgent(saved),
    // A terminal is never the dial's business, and `syncSession` forces that for it anyway.
    announceSession: session => announceSession(session, { device: false }),
    invalidateTerminalControl,
    forgetInput: agentId => { forgetRestartRevision(agentId); teams.forget(agentId); input.forget(agentId); deviceInput.forget(agentId) },
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
  binding.whileChanging((agentId) => restorePanes.busy(agentId))
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
  const gridAssignments = createGridAssignments({ models: () => ports.models ?? MODELS_OFF, registry,
    revision: (id) => restartJobs.revision(id), announce: announceSession })
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
    onReconciled: gridAssignments.observe,
    onProbeStatus: (status) => {
      discoveryReady = status.ready
      discoveryError = status.error
    },
  })

  // Account HTTP and the persistent machine cache belong to the gateway. The core routes the request
  // and keeps only state reported by that service, so a backend outage cannot stall an agent's loop.
  function proxyBackend(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    return gatewayOps.backend(method, path, body)
  }

  // The daemon's status (GET /api/status, read by `harness status`, the desktop's discovery and scripts):
  // health, the computer's fingerprint and its local pairings. It deliberately does NOT expose chat or
  // transcripts. The fingerprint and the pairings are the gateway's, asked for each time (bounded:
  // core/gatewayLink.ts).
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
      // Present only when start-up failed and this daemon is holding the machine open until a fix
      // arrives. Clients key on `discoveryReady`; this says WHY, in one word, for a person reading it.
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
    holdStop: attach.holdStop,
    afterStop: attach.afterStop,
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
  const engineHooks = createEngineHooks({ tmuxBackend, agentReconciler, registry, panePending: restorePanes.pending, syncSession })
  const { server: hookServer, port: hookPort, localSocket } = await startHookServer(daemonPort(), {
    onAutonomousDeviceRequest: async (method, target, body) => {
      // Until the pieces below are built; after, a piece that could not be is refused by the requests
      // that need it, and the rest (list, status, revoke) answer from the pairings.
      if (!devicePartsBuilt) return { status: 503, body: { error: { code: 'UNAVAILABLE', message: 'Autonomous device service is starting' } } }
      // The Wi-Fi device's pairings and direct links are the gateway's (gateway/start.ts); its receipts its
      // service's, with the dials (services/wifi.ts).
      const viaGateway = async (request: Parameters<GatewayOps['wifi']>[0]): Promise<Record<string, unknown>> => {
        const answer = await gatewayOps.wifi(request)
        if ('refused' in answer) throw Object.assign(new Error(answer.refused.message), { code: answer.refused.code })
        return answer.result
      }
      return autonomousDeviceLocalRequest({
        discover: async () => { await wifiCore.serving(WIFI_START_MS); return viaGateway({ op: 'discover' }) },
        pairStart: async ({ code, device }) => { await wifiCore.serving(WIFI_START_MS); return viaGateway({ op: 'pair', code, device }) },
        pairStatus: () => viaGateway({ op: 'pairStatus' }),
        list: () => viaGateway({ op: 'list' }),
        status: async () => ({ transport: 'direct', connected: wifiCore.directSessions() > 0,
          paired: ((await viaGateway({ op: 'list' })).devices as unknown[]).length, sessions: wifiCore.directSessions(), proto: 1 }),
        revoke: ({ id }) => viaGateway({ op: 'revoke', id }),
        receipt: async (target) => {
          const answer = await (ports.wifi?.receipt(target.deviceId, target.idempotencyKey) ?? { unavailable: true as const })
          if ('unavailable' in answer) throw Object.assign(new Error('The Wi-Fi device service is not running on this computer. See the daemon\'s log.'), { code: 'UNAVAILABLE' })
          return { receipt: answer.receipt }
        },
      }, method, target, body)
    },
    resolveHookAgent: engineHooks.resolveHookAgent,
    hookAdmissionBlocked: id => launchCancelled(id),
    onAdmissionHeld: engineHooks.onAdmissionHeld,
    onAdmissionStop: attach.holdAdmissionStop,
    captureAdmissionStop: attach.captureAdmissionStop,
    onRegistered: handleRegistered,
    onPromptSubmitted: (id, text) => teams.started(id, text, 'hook', registry.byAgent(id)?.engine),
    onSessionEnd: engineHooks.onSessionEnd,
    // What the engines' own hooks say about a turn (core/turns/turnHooks.ts).
    onTurnStart: turnHooks.onTurnStart,
    onToolStart: turnHooks.onToolStart,
    onTurnStop: turnHooks.onTurnStop,
    onPromptHook: turnHooks.onPromptHook,
    stopHookDelayMs: Number(process.env.HARNESSD_TEST_STOP_HOOK_DELAY_MS) || 0,
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
    onMachinesList: () => gatewayOps.machines(true),
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
    devicesWake.start(outOfProcess)
    wakeModels({ outOfProcess, dataDir: env.ADAPTER_DATA_DIR, runtimeDir: env.ADAPTER_RUNTIME_DIR, want: (service) => coreLink.want(service) })
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
  // The dial, the window bridges and the Wi-Fi device are the devices' (services/devices.ts, services/wifi.ts),
  // behind their ports, guarded there: the local socket closes a connection whose frame handler throws, so a
  // device fault reaching here would disconnect the desktop, again on every pane change.
  /** Which window has the person's attention, as the devices are told it. */
  const windowFocus = (): WindowFocus => ({ voice: appVoiceFocus ?? null, form: appFormWindow ?? null })
  /** ⌘K's answer with no devices to route through. */
  const unrouted = (reason: string): RouteAnswer => ({ agentId: '', machineId: '', name: '', confidence: 0, reason, candidates: [], weighed: 0, machines: 0, via: '' })
  const DEVICES_OFF = 'the devices service is unavailable'

  const localWsServer = attachLocalWsServer(hookServer, {
    localSocketServer: localSocket?.server ?? null,
    services: serviceLinks,
    // A window's answer to a bridge's ask, and its comings and goings: the window bridges are the devices'.
    onSelectionReply: (connId, machineId, payload) => ports.devices?.windowReply('selection', connId, machineId, payload),
    onVisitReply: (connId, machineId, payload) => ports.devices?.windowReply('visit', connId, machineId, payload),
    onFormReply: (connId, machineId, payload) => ports.devices?.windowReply('form', connId, machineId, payload),
    onAppDisconnect: (machineId, connId) => {
      if (appFormWindow?.connId === connId) appFormWindow = undefined
      if (appVoiceFocus?.connId === connId) appVoiceFocus = undefined
      ports.devices?.windowFocus(windowFocus())
      ports.devices?.windowGone(connId)
      void ports.wifi?.appFocus(machineId, null, connId)
    },
    // The window and the dial are one desk: opening an agent in the app brings the dial to it, switching
    // the dial's machine first when the app moved to another one.
    onDevicePrepareOpened: (operationId, agentId) => ports.wifi?.revealed(operationId, agentId),
    onAppFocusState: (machineId, agentId, connId, expectedRevision) => {
      // A delayed automatic selection cannot replace a newer explicit user choice. A device service
      // that cannot say which choice is newest is one with no choice to protect: refused, as without one.
      if (expectedRevision && wifiCore.focusRevision() !== expectedRevision) return false
      appFormWindow = { machineId, connId }
      if (agentId === null) {
        if (appVoiceFocus?.connId === connId) appVoiceFocus = undefined
      } else appVoiceFocus = { machineId, agentId, connId }
      ports.devices?.windowFocus(windowFocus())
      void ports.wifi?.appFocus(machineId, agentId, connId)
    },
    onAppFocus: (machineId, agentId) => ports.devices?.appFocus(machineId, agentId),
    // Everything the window still has unread. Held rather than acted on: the dial is handed it when a
    // cable attaches, which is the one moment its own drawer is known to be empty.
    onAppUnread: (items) => {
      appUnreadLatest = items
      ports.devices?.unread(items)
    },
    // The window looked at a harness, so the dial's drawer row for it is stale.
    // The dial's own tap already reaches the window (`agent.open`); this is the
    // return leg, and the pair is what keeps the badge and the pill equal.
    onAgentSeen: (agentId, readToken) => ports.devices?.seen(agentId, readToken),
    // The window's swarms. Relayed to the dial as its own list — the dial names the one on screen above
    // the agent and offers the rest — and, through setSwarms, what makes the desk strict: a present
    // window with an empty swarm is an empty carousel, not the whole machine.
    onAppSwarms: (swarms) => {
      appSwarmsLatest = swarms
      ports.devices?.swarms(swarms)
    },
    onAppTabAgents: (connection, ids) => cleanupTabs.updateWindow(connection, ids),
    // Agents the window has a tile for, in tile order: the dial's ring (services/devices.ts). A finished turn
    // on one of these is already in front of the person, so the dial updates its tile in silence rather
    // than beeping about something being looked at. An OPEN tile counts as seen, deliberately — not a
    // focused one: with four tiles on a grid all four are on screen.
    onAppPanes: (agentIds, foreground) => {
      appPaneAgents = agentIds
      // A tile behind a browser is not a tile anybody is looking at: the roster does not change when the
      // window loses focus, so without this the dial went quiet about work nobody could see.
      appWindowForeground = foreground
      ports.devices?.desk(agentIds, foreground)
      const next = new Set(agentIds)
      // Logged on CHANGE only. It fires on every pane add, close and reconnect,
      // and it is the one place the whole feature is observable from — without
      // it, "the dial went quiet" and "the roster never arrived" look identical.
      const changed = next.size !== openPaneAgents.size || [...next].some((id) => !openPaneAgents.has(id))
      openPaneAgents = next
      if (changed) console.log(`[cable] window tiles: ${next.size ? [...next].map(sid).join(' ') : '(none)'}`)
    },
    // ⌘K in the window: a typed task, and which agent it belongs to, on any of the owner's machines. The
    // fleet's to answer, beside the dial in the devices (services/fleet.ts routeTask), so it answers with
    // the dial absent or off.
    onRouteTask: backend.ownerCommands.onRouteTask = async (text) => ports.devices ? ports.devices.routeTask(text) : unrouted(DEVICES_OFF),
    // A window that connects after the dial did has missed the `dial_status` that announced it: the last one
    // the devices sent, kept here.
    dialStatus: () => lastDialStatus,
    /*
     * A window changing a device's settings. Addressed by the fleet's id, so a second robot on the same
     * desk is not dragged along — every other cable command broadcasts on purpose (they all show the
     * same desktop), but a preference belongs to the glass it was set on.
     *
     * Nothing is answered here. The device replies to its own `settings.set` with the values it now
     * holds, and that reaches the window as an ordinary `dial_status`.
     */
    onDialSettings: (id, patch) => ports.devices?.settings(id, patch),
    openQuestions: () => [...openQuestions.values()],
    // Committed. Sent through the fleet's router — the dial's own dispatch — and NOT straight into
    // backend.onMessage: that resolves the id against THIS computer's registry, so a remote agent would land
    // as "This harness is no longer available", an error about an agent alive on another machine.
    onRouteSend: backend.ownerCommands.onRouteSend = async (agentId, text) =>
      ports.devices ? ports.devices.routeSend(agentId, text) : { ok: false, machine: '', reason: DEVICES_OFF },
    onVoiceRouteReply: (voiceId, reply) => ports.devices?.voiceReply(voiceId, reply),
    machineId: backend.machineId,
    backend,
    relayPool: gateway.windowRelay,
    autonomousEnv: readAuthSession()?.autonomousEnv ?? env.AUTONOMOUS_ENV,
    // A window from before it introduced itself still gets named on the far side's "took control"
    // banner: the relay knows it is this machine's desktop. Same source as `describeClient` above.
    // Cut to the wire's limit here rather than let the far daemon drop the whole claim over a long name.
    localClient: () => ({ kind: 'desktop', name: terminalHintMachineName().slice(0, 64), machineId: backend.machineId }),
  })
  localWsServerRef = localWsServer
  // Every engine's hooks, pointed at the port the local server actually bound (core/engines/hooks.ts).
  const installedHooks = env.DISABLE_HOOK_INSTALL ? undefined
    : await installEngineHooks(hookPort, { only: env.HOOK_INSTALL_ENGINES, loginShell: loginShellEnvPromise })

  // Each transcript line, through its engine's normalizer, into the funnel (core/transcripts/ingest.ts).
  const ingest = createIngest({
    liveFor,
    has: (sessionId) => registry.has(sessionId),
    bySession: (sessionId) => registry.bySession(sessionId),
    tokenUsage: { changed: target => usageLink.port.changed(target) },
    device: () => wifiCore.feed,
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
   * installed file (`engines/opencode/version.ts`), so this costs a `stat` after the first read. Read for an
   * OpenCode launch alone, by OpenCode's own code: every launch of OpenCode loads it before asking, and is refused
   * without it (core/agents/create.ts, lib/launchOverrides.ts).
   */
  const gridLaunchMachine = (engine: AgentEngine): GridLaunchMachine => ({
    hermesSystemManaged: existsSync(HERMES_SYSTEM_MANAGED_DIR),
    opencodeMajor: engine === 'opencode' ? opencodeMajorVersion() : null,
  })

  /**
   * What a relaunch of `session` must be given, beyond the engine's argv, to come back where it was —
   * on its grid (the registry kept the launch, key included) or under its Codex profile. Restore and
   * restart read the row; retarget passes the override the desktop just sent. The config directory is
   * keyed on the agent, so relaunching the same agent rewrites one directory instead of leaving a trail.
   */
  // Grid and saved-API launches are built by the models service (core/agents/launch.ts `gridLaunchThrough`): a
  // launch on one while models is down is refused, and one on the engine's own login never asks it.
  const gridLaunch = gridLaunchThrough(() => ports.models ?? MODELS_OFF)
  const dshLaunch = dshThrough({ store: () => ports.store ?? STORE_OFF,
    nameOf: id => installedDsh(id)?.manifest.name, account: () => ({ privateGrid: backend.gridName() }) })
  const launchOverridesDeps: LaunchOverridesDeps = {
    machine: gridLaunchMachine,
    gridLaunch,
    writeGridConfigDir,
    tmuxSupportsSessionEnv,
    installCodexHooks: (codexHome) => { if (!env.DISABLE_HOOK_INSTALL) engineHookFacets.codex.installIn(hookPort, codexHome) },
    dshLaunch: dshLaunch.relaunch,
  }
  // What a relaunch needs to bring a pane back (core/agents/launch.ts). Declared before the restore
  // pass below, which calls these for every pane it rebuilds.
  const launchHelpers = createLaunchHelpers({
    authority: createLaunchAuthority({ byAgent: id => registry.byAgent(id), revision: restoreRevision, cancelled: id => launchCancelled(id) }),
    prepareApiTools,
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
    const repaired = await repairProjectCwds({ registry, stoppedAgents, log: (message) => console.log(message) })
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
  // Later passes over held agents (core/agents/heldLaunches.ts) wait for this one.
  await heldLaunches.boot(async () => {
  if (tmuxBackend) {
   // Best effort, like the cwd repair above it: panes that cannot be rebuilt cost this boot its
   // tiles, not the daemon. `restoreDegraded` then stops discovery retiring the rows whose panes
   // restore never got to, so the next daemon can put them back.
   try {
    const backend = tmuxBackend
    const restoreDeps: RestoreAgentsDeps = {
      cancelled: (agentId) => restoreCancelled(agentId),
      revision: (agentId) => restoreRevision(agentId),
      paneOperation: restorePanes.run,
      paneAllocations: restorePanes.runMany,
      paneBusy: restorePanes.busy,
      retainStopped: retainExitedSession,
      keepAbandoned: keepAbandonedConversation,
      registry,
      engineStarted: (sessionId) => relaunchMarks.engineStarted(sessionId),
      // "Alive" means the pane still runs THIS row's engine — not merely that tmux knows the id.
      // A new tmux server hands out `%N` from zero again, so a stale id can name someone's shell;
      // and a pane that outlived the daemon in a session discovery no longer lists still has its
      // engine, which a second pane resuming the same session would collide with.
      survey: () => tmuxSurvey(() => listTmuxPanes(), lookupPaneEngineProcess),
      waitingPane: (runtime, token) => backend.isHeld(runtime, token),
      liveProcess: (entry, runtime) => tmuxSurvey(() => listTmuxPanes(), lookupPaneEngineProcess).liveProcess(entry, runtime),
      buildLaunch: createRestoreLaunch({
        workspaceMissing, relaunchOverrides, prepareSessionResume, refreshGridWebSearch,
        downgradedPermission: (entry) => downgradedPermission(entry, entry.bypassPermission === true, 'restore'),
        launch: (entry, opts, overrides, permission) => {
          const { env: launchEnv, extraArgs, clearEnv } = overrides
          const argv = buildEngineLaunchArgv(entry.engine, {
            ...opts,
            ...(entry.externalResume?.continue && entry.externalResume.signal === 'sent' && !entry.externalResume.dispatched && supportsFirstPrompt(entry.engine) ? { firstPrompt: 'continue' } : {}),
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
      }),
      createPane: async (entry, launch, control) => {
        const created = await backend.create({
          cwd: homedir(),
          label: buildHarnessSessionLabel(entry.engine),
          command: launch.argv,
          ...control,
          ...(launch.env ? { env: launch.env } : {}),
        })
        return created.state === 'succeeded'
          ? { ok: true, runtime: created.runtime }
          : { ok: false, reason: created.reason }
      },
      respawn: async (runtime, launch, control) => {
        const result = await backend.respawn(runtime, {
          command: launch.argv,
          ...control,
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
      // A grid's or a saved API's launch asks models: not before the core is ready (core/agents/heldLaunches.ts).
      needs: (entry) => [...(externalResumePending(entry.externalResume) ? ['search'] : []), ...(entry.gridLaunch ? ['models'] : []), ...(entry.dsh ? ['store'] : [])],
      waitingLaunch: (entry, held) => ({ argv: heldPaneArgv(held.detail, entry.externalResume?.token) }),
      killPane: async (runtime) => { await backend.kill(runtime) },
    }
    // Later passes launch the held agents, into the panes they wait in, outside this pass's transaction.
    restoreOnly = (only) => restoreAgents({ ...restoreDeps, only })
    const summary = await restoreAgents({ ...restoreDeps, defer: true })
    // A row restore could not look at keeps its pane for discovery to judge, but not to retire this boot.
    for (const agentId of summary.unsurveyed) restoreUnsurveyed.add(agentId)
    if (summary.restored.length || summary.failed.length || summary.held.length || registry.rebootedSinceLastRun) {
      console.log(`[restore] restored ${summary.restored.length} · skipped ${summary.skipped.length} · failed ${summary.failed.length}`
        + (summary.held.length ? ` · held ${summary.held.length} until the core is ready` : '')
        + (registry.rebootedSinceLastRun ? ' · after reboot' : ''))
    }
   } catch (error) {
    restoreFailed = true
    console.warn(`[restore] skipped · ${error instanceof Error ? error.message : error}`
      + ' · agents keep their rows and come back on the next start')
   }
  }
  })
  // Every DSH agent the registry kept gets its viewer and verdict watch back — restored or not, an
  // agent whose pane is still up is still that harness.
  for (const session of registry.list()) if (session.dsh) attachDsh(session)
  await agentReconciler.start(env.TERMINAL_RECONCILE_INTERVAL_MS ?? env.TMUX_REAP_INTERVAL_MS)
  // A file lock and a JSON parse, neither of which is worth the daemon: an unreadable queue means no
  // pending Cursor tasks this boot, not no daemon.
  const pendingCursorTasks = await loadPendingCursorTasks(env.ADAPTER_DATA_DIR).catch((error) => {
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
        await Promise.all(registry.advertised().map(session => runtimeProfiles.capturePane(session, captureTerminal, 120, true)))
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
      void runtimeProfiles.capturePane(session, captureTerminal, 60).catch(() => undefined)
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
    // Warm the voice-router worker while a device is connected (services/devices.ts).
    ports.devices?.commanders(connected)
  }

  // Cancelling a turn (core/turns/cancel.ts).
  const cancelAgent = createCancel({
    beforeCancel: attach.beforeCancel,
    resolve: (id) => registry.resolve(id),
    normalizers,
    cursorSubagents,
    input,
    device: () => wifiCore.feed,
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
  externalResumes = createExternalResumes({
    registry, tmux: tmuxBackend, stopped: () => stoppedAgents.list(), cancelled: id => restoreCancelled(id),
    generation: () => searchGeneration,
    waiting: row => tmuxBackend?.isHeld({ backend: 'tmux', paneId: row.tmuxPane }, row.externalResume!.token).then(value => value === true) ?? Promise.resolve(false),
    inspect: request => ports.search?.inspect(request) ?? Promise.resolve(externalUnavailable()),
    preflight: createExternalPreflight({ blocksFolder: cwd => backend.purgeAgentService?.blocksFolder(cwd),
      hookPort, hooksDisabled: env.DISABLE_HOOK_INSTALL, installOpencodePlugin: installOpencodePluginBeforeSpawn }),
    announce: announceSession, launch: () => { void heldLaunches.restoreHeld('search') },
    forget: id => forgetSession(id, { force: true }),
  })

  // Creating an agent (core/agents/create.ts).
  backend.onCreateAgent = createAgentCreator({
    dshLaunch,
    tmuxBackend,
    registry,
    externalResume: externalResumes.create,
    watchNewPane,
    announceSession,
    attachDsh,
    prepareApiTools,
    hookPort,
    hooksDisabled: env.DISABLE_HOOK_INSTALL,
    installOpencodePlugin: installOpencodePluginBeforeSpawn,
    gridLaunchMachine,
    buildGridLaunch: gridLaunch,
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
    dshLaunch,
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
    restartJobs,
    byAgent: (agentId) => registry.byAgent(agentId),
    tmuxBackend,
    prepareSessionResume,
    keepAbandonedConversation,
  })
  // A message sent while an engine is being replaced waits for the new one instead of being refused.
  terminals.whileChanging((agentId) => restorePanes.busy(agentId) || restartJobs.busy(agentId))
  const sameRestartTarget = paneSwap.sameRestartTarget
  const paneSwapDeps = paneSwap.paneSwapDeps
  const liveBypassPermission = paneSwap.liveBypassPermission

  // Moving a running agent onto a grid, or back to its own login (core/agents/retarget.ts).
  backend.onRetargetAgent = createAgentRetargeter({
    readScreen: screens.read,
    purgeBusy: (agentId) => restorePanes.busy(agentId) || backend.purgeAgentService?.busy(agentId),
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
    refreshGridAssignment: gridAssignments.refresh,
    announceSession,
    opencodeDb: OPENCODE_DB,
  })

  // Stopping, purging and resuming an agent (core/agents/lifecycle.ts).
  const lifecycle = createAgentLifecycle({
    settlePane: restorePanes.settle,
    cancelExternal: externalResumes.cancel,
    registry,
    stoppedAgents,
    restartJobs,
    tmuxBackend,
    agentReconciler,
    forgetSession,
    markDeleted,
    clearDeleted,
    stopNative: (session, current, confirmUnused) => nativeControls.stop(session, current, confirmUnused),
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
  launchCancelled = id => stopJobs.has(id)
  restoreCancelled = (agentId) => stopJobs.has(agentId) || pinnedControls.has(agentId) || (restartJobs.operation(agentId) !== undefined && restartJobs.operation(agentId) !== 'restart')
  binding.whileChanging((agentId) => restorePanes.busy(agentId) || restartJobs.busy(agentId) || stopJobs.has(agentId))
  const stopAgent = lifecycle.stopAgent
  backend.stopProvider = createStopRequest({ byAgent: (id) => registry.byAgent(id), stop: stopAgent })
  backend.purgeAgentService = lifecycle.purgeAgentService
  backend.purgeProvider = createPurgeRequest({ purgeAgentService: () => lifecycle.purgeAgentService, invalidateStorage: () => { void (ports.monitor ?? MONITOR_OFF).storage([], true) } })
  // Closing agents no window shows, and the cleanup preview (core/agents/close.ts).
  const closing = createAgentClosing({
    readScreen: screens.read,
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
    engineReady: (engine, ms) => engineLinks.ready(engine, ms),
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
    purgeBusy: (agentId) => restorePanes.busy(agentId) || backend.purgeAgentService?.busy(agentId),
    stopJobs,
    pinnedControls,
    tmuxBackend,
    sameRestartTarget,
    agentReconciler,
    terminalHintMachineName,
    refreshGridAssignment: gridAssignments.refresh,
    announceSession,
    relaunchOverrides,
    downgradedPermission,
    refreshGridWebSearch,
    liveBypassPermission,
    paneSwapDeps,
    restartHeld: (agentId) => heldLaunches.restartHeld(agentId),
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

  // ── self-update: a staged bundle restarts the daemon IMMEDIATELY (core/updateHandoff.ts). The handler
  // stops being `bootHandoff` HERE, and not a line earlier: everything the teardown releases exists by now.
  // A straight-line assignment, never a wait: if the body never reaches this line the handler stays
  // `bootHandoff`, and the fix still lands.
  const updateTeardown = (): TeardownStep[] => { installedHooks?.close(); externalResumes?.stop(); return [
    ['the registry', () => registry.flush({ exiting: true })], ['the updater', () => daemonBoot.updaterBeside?.()],
    ['the reconciler', () => agentReconciler.stop()],
    ['the timers', () => { clearInterval(logTrimTimer); clearInterval(runtimeReconcileTimer); clearInterval(paneTitleSyncTimer) }],
    ['the question watchers', () => questionWatcher.stopAll()],
    ['the turn heartbeats', () => { for (const t of heartbeats.values()) clearInterval(t); heartbeats.clear() }],
    ['the Cursor sub-agents', () => cursorSubagents.stop()], ['the normalizers', () => normalizers.stopPollers()],
    ['Cursor discovery', () => cursorDiscovery.stop()], ['the runtime profiles', () => runtimeProfiles.stop()], ['the transcript watcher', () => watcher.stop()],
    // The FIXED hook port, released before the successor binds it (no fallback → EADDRINUSE otherwise).
    // Process-owned agents stay in the persisted registry and are revalidated by its first discovery passes.
    ['the hook connections', () => (hookServer as unknown as { closeAllConnections?: () => void }).closeAllConnections?.()],
    ['Share', () => ports.sharing?.stop()],
    ['the local websocket', () => localWsServer.close()], ['the hook server', () => hookServer.close()],
    ['the local socket', () => localSocket?.close()], ['Codex activity', () => nativeControls.close()],
    // The serial ports, the lane and the voice router's worker: a port held through the handoff makes the
    // next daemon's dial, and esptool, fail as if the hardware had died.
    ['the devices', () => ports.devices?.stop()],
    // The successor starts its own viewers for the agents it restores; ours must not hold the ports.
    ['external adoption', () => externalResumes?.stop()],
    ['usage observations', () => { usageLink.port.stop(); ports.usage?.stop() }],
    ['the viewers', () => ports.viewers?.stop()], ['the gateway', () => gateway.stop()],
    // A graceful close releases the backend's one-machine claim, given a moment before the reclaim.
    ['the backend', () => backend.stop()], ['a grace', () => new Promise((r) => setTimeout(r, 1000))],
  ] }
  daemonBoot.applyStagedUpdate = (v) => updateHandoff.restartForUpdate(v, updateTeardown())
  // A core an older release's own handoff started (it spawned this `cli.js __run` and judged it) has no
  // master, and so no updater: it would run this build until its next start. Once that release has gone,
  // it hands the machine to a master on this build (core/updateHandoff.ts). Not a core HARNESS_NO_MASTER=1
  // asked for, and not a dev or repo run.
  if (!coreLink.supervised && process.env.ADAPTER_UPDATED_TO && process.env.HARNESS_NO_MASTER !== '1' && isInstalledCopy(SCRIPT_PATH, env.ADAPTER_CLI_DIR)) {
    handOverOnceReleased({ startedBy: process.ppid, parent: () => process.ppid, alive: isAlive, handOver: () => { void updateHandoff.handOver(updateTeardown()) } })
  }

  /** Stopping for good — removed from the account, or connected from elsewhere: tell harnessd's master,
   *  which restarts any other exit (harnessd/protocol.ts). */
  const forGood = (reason: string): boolean => reason === 'revoked' || reason === 'busy'
  const shutdown = async (signal: string): Promise<void> => {
    installedHooks?.close()
    externalResumes?.stop()
    console.log(`\n[cli] ${signal} — shutting down`)
    // A slow teardown may exhaust the master's grace. Persist already acknowledged bindings first.
    registry.flush({ exiting: true })
    // Mid-handoff everything below is already being torn down, and nothing has been started yet: leave
    // — a second teardown of closed servers is noise.
    if (updateHandoff.restarting()) {
      try { if (readPid() === process.pid) rmSync(PID_FILE, { force: true }) } catch { /* ignore */ }
      process.exit(0)
    }
    // Release the serial port first. It is exclusive, and a daemon that exits still holding it makes
    // esptool fail in a way that reads exactly like dead hardware.
    void ports.devices?.stop()
    daemonBoot.updaterBeside?.()
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
    runtimeProfiles.stop()
    await ports.sharing?.stop()
    // The data folder's socket first: a successor waiting for this core to leave (lib/localSocket.ts) can
    // start as soon as it is gone, whatever the clients below take to close.
    await localSocket?.close()
    await localWsServer.close()
    hookServer.close()
    nativeControls.close()
    externalResumes?.stop()
    usageLink.port.stop(); ports.usage?.stop()
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

  // ── the devices (services/devices.ts) ──────────────────────────────────────────────────────────────
  //
  // The dials on USB, the window bridges they speak through, the fleet's router every turn goes through
  // (⌘K's too) with the lane to the owner's other machines, the voice router and the Devices tab. Behind
  // their port: a device that fails costs the devices, never a session. Deliberately not fatal and not
  // blocking: an unplugged cable is this daemon's ordinary state.
  // In their own process they are told everything the windows said as they connect (core/devicesLink.ts):
  // said here too, it reached a dial still opening its port, before its greeting.
  if (outOfProcess.has('devices')) ports.devices = devicesLink.port
  else {
    serviceHost.start('devices', (core, started) => inline!.startDevices(core, started, {
      logsDir: env.HARNESS_LOGS_DIR, testDialPort: process.env.HARNESSD_TEST_DIAL_PORT,
      dialSerials: process.env.HARNESS_DIAL_SERIALS?.split(',').map((serial) => serial.trim()).filter(Boolean),
      cableDisabled: env.CABLE_DISABLE, faults: testFaults(process.env.HARNESSD_TEST_FAULTS),
    }), coreApi, DEVICES_FALLBACKS, DEVICES_REQUESTS)
    // Everything the windows said while the devices were being built, and what the machine runs.
    if (ports.devices) devicesLink.started(ports.devices)
  }

  // The Wi-Fi device (services/wifi.ts), with the dials: in their process by default (core/wifiLink.ts,
  // resumed there as its link connects), or here.
  if (!outOfProcess.has('wifi')) {
    serviceHost.start('wifi', inline!.startWifi, coreApi, WIFI_FALLBACKS)
    if (ports.wifi) wifiCore.started(appVoiceFocus ?? null)
  }
  devicePartsBuilt = true

  // Worktrees Harness made that no live or stopped harness uses and nothing would miss
  // (services/workspaces.ts): a few minutes after start, once restored agents are back in the
  // registry, then twice a day. Only the end-to-end harness shortens the first wait.
  setTimeout(() => ports.workspaces?.sweepUnused(), Number(process.env.HARNESSD_TEST_SWEEP_AFTER_MS) || 5 * 60_000).unref()
  setInterval(() => ports.workspaces?.sweepUnused(), 12 * 3600_000).unref()


  // Every card bound for the Wi-Fi device goes to the devices too: the dial is told what the Wi-Fi device is,
  // in the same order, so the two device surfaces cannot drift. Teeing beats emitting again at each call
  // site: a new kind of card reaches the dial the day it reaches the socket. The tee runs before the frame
  // is queued for the Wi-Fi device (BackendSocket.sendCommander): a device fault here must cost neither
  // that frame nor whoever is sending it, which the guards and the devices' port see to.
  backend.onOutboundCommander = (frame) => {
    wifiCore.card(frame as Record<string, unknown>)
    ports.devices?.card(frame as Record<string, unknown>)
  }

  // Last: every handler is wired and the restored agents are confirmed, so requests that arrived while
  // starting — a client reconnecting the moment the port answered, the backend's first frames — are
  // answered now, in order, by the handlers meant to answer them (see BackendSocket.openRequests).
  // Only the end-to-end harness sets this: a start-up that hangs after binding, for the master's deadline.
  if (process.env.HARNESSD_TEST_HOLD_READY === '1') await new Promise<never>(() => {})
  backend.openRequests()
  daemonBoot.openRequests = null
  coreLink.ready()
  console.log('[cli] ready')
  // Ready first, never after a service: the agents the boot held for one are launched now, in the background.
  void heldLaunches.restoreHeld()
  externalResumes.open()
}

/**
 * The daemon's start-up threw. STAY UP anyway, waiting for a fix.
 *
 * Exiting here is what made one bad build unrecoverable: the desktop app answers a dead port by running
 * `harness start` again — the same bytes, about once a minute, for ever. The updater is the master's, in a
 * process of its own (services/updaterProcess.ts), and the request to hand over for its fix is listened for
 * in the prologue (see `runForeground`); all this has to do is keep the process alive long enough for a
 * published fix to land, and tell everyone what state the machine is in. A core with no master gets no fix
 * here: its safe mode runs out (`ADAPTER_SAFE_MODE_MS`) and a clean start tries again.
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
  console.error(`[safe-mode] staying up on v${VERSION} — a published fix will be applied on its own.`
    + ' Nothing else on this machine works until then.')
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
  // Up, though not ready: the master must neither give up waiting for a bind nor take it for hung, or the
  // fix its updater stages would find no core to hand over. It hears why, and rolls back an
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
      // A ref'd timer: something has to hold the event loop open.
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
