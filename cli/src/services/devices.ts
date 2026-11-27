/**
 * The devices: the dials on this computer's USB ports, the window bridges they speak through, the fleet's
 * router every turn goes through (⌘K's too), the voice router, and the Devices tab
 * (docs/design/2026-10-06-core-boundary-next.md, "Devices — its own process", step 9).
 *
 * They reach the core only through `CoreApi` and the core reaches them only through `ports.devices`
 * (core/api.ts `DevicesPort`), so that they can run in a process of their own: the serial ports are
 * hardware, a dial speaks whatever its firmware says, and one device failing must cost the devices, never
 * a session. Inside, each part answers for itself (services/devicesGuard.ts): a dial throwing on every
 * frame costs ⌘K nothing, and a fleet that cannot start costs the dial nothing.
 *
 * Where the core used to wire all this inside `runForeground` (before step 9) it now hands over what the
 * windows on this computer say, as it hears it, and every card it sends the devices; the window's desk,
 * tabs, unread rows and focus it keeps, and says again whenever the devices start.
 *
 * The Wi-Fi device is a service of its own beside these (services/wifi.ts), in the same process, on a link
 * of its own: it rides the gateway's sessions, and borrows the dial's walk and stroke through the core.
 */
import { randomUUID } from 'node:crypto'
import { existsSync, statSync, writeFileSync, type Stats } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, relative } from 'node:path'
import { env } from '../config/env.js'
import { cursorDataDir } from '../engines/cursor/contract.js'
import { DEVICES_FALLBACKS, DEVICES_REQUESTS, type CoreApi, type CorePorts, type DeviceHookPort, type DevicesPort, type RouteAnswer, type SendResult, type ServiceRequests, type WindowFocus } from '../core/api.js'
import { CableFleet, testDialDiscovery, type CableFleetOptions } from '../cable/cableFleet.js'
import { isLocalOnly } from '../lib/cardUpdate.js'
import { TurnStats, type TurnStatsFields } from '../cable/turnStats.js'
import { cableEventFor, cableStepFor, cableQuestionCloseFor, cableQuestionFor, DaemonCableHost, type CableHostWiring } from '../cable/cableHost.js'
import { CableSession, SHOWN_ONLY_PREFIX, type DialStatus, type FollowCause } from '../cable/cableSession.js'
import { createDialUsage, type DialAgent, type DialUsage } from '../cable/dialUsage.js'
import { DialUsageFile } from '../cable/dialUsageFile.js'
import type { HostAdapter, Pane } from '../cable/hosts/adapter.js'
import { chatGptPlaces, claudeStoreRoots } from '../cable/hosts/appPlaces.js'
import { AppWake } from '../cable/hosts/appWake.js'
import { createClaudeAppAdapter } from '../cable/hosts/claudeApp.js'
import { ClaudeAppSource, type ClaudeAppSourceDeps } from '../cable/hosts/claudeAppSource.js'
import { ClaudeAppStore } from '../cable/hosts/claudeAppStore.js'
import { MANAGED_SETTINGS, readFullscreen } from '../cable/hosts/claudeRenderer.js'
import { cmuxClientDeps, cmuxPaneKey, cmuxStoreDir, cmuxStores, createCmuxClient, type CmuxClient } from '../cable/hosts/cmuxCli.js'
import { createCmuxAppAdapter } from '../cable/hosts/cmuxApp.js'
import { CMUX_EVENTS, cmuxLogFiles, createCmuxFocus, type CmuxFront, type CmuxLogFiles } from '../cable/hosts/cmuxFocus.js'
import { CmuxSource } from '../cable/hosts/cmuxSource.js'
import { createCursorFolderAdapter, isFolder } from '../cable/hosts/cursorFolder.js'
import { watchNearest } from '../cable/hosts/folderWatch.js'
import { FOCUS_FAILS_MAX, startFocusPoll, type FocusPoll } from '../cable/hosts/focusPoll.js'
import { createCodexAppAdapter } from '../cable/hosts/codexApp.js'
import { CodexAppSource, type CodexAppSourceDeps } from '../cable/hosts/codexAppSource.js'
import { CodexAppThreads } from '../cable/hosts/codexAppThreads.js'
import { APP_BUNDLES, APP_IDS, UNKNOWN_APP } from '../cable/hosts/hostDetect.js'
import { APP_PACKAGE, codexQueueDeps, createCodexQueue, type CodexQueueDeps } from '../cable/hosts/codexQueue.js'
import { servedLookup } from '../cable/hosts/codexServed.js'
import { createHcClient, hcClientDeps, hcSocketPath, type HcClient } from '../cable/hosts/hcClient.js'
import { HcSource } from '../cable/hosts/hcSource.js'
import { createHerdrAdapter, herdrPaneParts } from '../cable/hosts/herdr.js'
import { createHerdrAppAdapter } from '../cable/hosts/herdrApp.js'
import { createHerdrClient, herdrClientDeps, herdrMarkerServer, herdrPaneKey, herdrShellOf, type HerdrClient } from '../cable/hosts/herdrClient.js'
import { createHerdrNested, createHerdrOuter, procSockets, ttyAtime, type HerdrWindowsDeps } from '../cable/hosts/herdrOuter.js'
import { HerdrSource } from '../cable/hosts/herdrSource.js'
import { createKittyAdapter, createKittyTabAdapter, kittyFinder } from '../cable/hosts/kitty.js'
import { Inbox } from '../cable/hosts/inbox.js'
import { LAST_ANSWER_DEADLINE_MS, LAST_ANSWER_MAX_BYTES, readLastAnswer, type AnswerEngine } from '../cable/hosts/lastAnswer.js'
import { deriveAnswerCard } from '../lib/deviceRecap.js'
import { systemLinuxRaise, type LinuxRaise } from '../cable/hosts/linuxRaise.js'
import { createWindowsRaise, harnessDesktopLauncher, type WindowsRaise } from '../cable/hosts/windowsRaise.js'
import { askedLine, CONTINUE_MAX_MS, CONTINUE_QUIET_MS, countWord, hostDisplayName, observedAgentId, ObservedSource, type ObservedActions, type ObservedDeps, type PromptSource } from '../cable/hosts/observed.js'
import { observedPlaces } from '../cable/hosts/observedPlaces.js'
import { createOpenActions } from '../cable/hosts/open.js'
import { createOpencodeClient, opencodeClientDeps, opencodeMessageId, type OpencodeClient } from '../cable/hosts/opencodeClient.js'
import { OpencodeSource } from '../cable/hosts/opencodeSource.js'
import { createOrcaAdapter, createOrcaReads, orcaDeps, orcaHandle, type OrcaFocusWatch, type OrcaReadDeps, type OrcaReads, type OrcaTerminal } from '../cable/hosts/orca.js'
import { createOrcaChatAdapter, ORCA_CHAT_ADAPTER } from '../cable/hosts/orcaChat.js'
import { ORCA_CHAT_TIMEOUT_MS, OrcaChatSource } from '../cable/hosts/orcaChatSource.js'
import { firstOuter, type NestedLookup } from '../cable/hosts/outer.js'
import { readRecord } from '../cable/hosts/record.js'
import { HostRegistry, type HostEntry } from '../cable/hosts/registry.js'
import { appRoots, learnApps, readBundleId, readMadeBy, readProcessNames, readPtyOwner, readTtyName, readWindowsProcesses, readWindowsPtyOwner, scanLearnsApps } from '../cable/hosts/scannedApp.js'
import { createScrollLines } from '../cable/hosts/scrollLines.js'
import { pagesOf } from '../cable/hosts/select.js'
import { createTabsAdapter, isTabApp, readTabTty, runPs, type Tab, type TabApp, type TabTty } from '../cable/hosts/tabs.js'
import { readTabProcess, readTtyReaders, tabsTyping, type TabProcess } from '../cable/hosts/tabsType.js'
import { createTmuxAdapter, createTmuxNested, createTmuxOuter, tmuxPaneParts } from '../cable/hosts/tmux.js'
import type { HostAgent, HostAgentState } from '../cable/hosts/types.js'
import { watchSocket } from '../cable/hosts/unixSocket.js'
import { clientPid, createVscodeAdapter, createVscodeClientAdapter, termPid } from '../cable/hosts/vscode.js'
import { readForeground, readProcessParents, vscodeStreams, type VscodeTerminal, type VscodeTerminalsDeps } from '../cable/hosts/vscodeTerminals.js'
import { createWeztermAdapter, createWeztermTabAdapter } from '../cable/hosts/wezterm.js'
import { createRexAdapter, createRexReads, rexBlocksRunning, rexFinder, rexPaneIds, rexPaneParts, type RexReads } from '../cable/hosts/rex.js'
import { createZellijAdapter, createZellijOuter, zellijFinder } from '../cable/hosts/zellij.js'
import { createEngineTally } from '../cable/engineTally.js'
import { createVscodeExtensionSetup } from '../cable/vscodeExtensionSetup.js'
import { NoticeFile, NOTICES_FILE } from '../cable/noticeFile.js'
import { listedAgent, noticeKeys, Notices, type NoticeCaller, type NoticeOutcome } from '../cable/notices.js'
import { NOTIFY_MODE_FILE, NotifyModeStore, type NotifyMode } from '../cable/notifyMode.js'
import { PetStore } from '../cable/pets/store.js'
import { DialLog } from '../cable/dialLog.js'
import { DialVerdicts, greetedAsDial } from '../cable/dialPortVerdicts.js'
import { createDialSetup } from '../cable/dialSetup.js'
import { carriedClaudePlugin, claudeFound, type ClaudePluginSource, type ClaudeRun } from '../devices/claudePlugin.js'
import { codexFound } from '../devices/codexPlugin.js'
import { claudePluginState, installedSkills } from '../devices/dialSkill.js'
import { readOrcaConnected, readRemoved, readSetup, SETUP_COUNTS } from '../devices/dialSkillFiles.js'
import { createOrcaHomesCache, orcaBinary, orcaHomesDeps, readOrcaHomes, type OrcaHomesCache } from '../devices/orcaHomes.js'
import { orcaPluginRun, type OrcaPluginRun } from '../devices/orcaPlugin.js'
import { createOrcaPluginSetup, orcaPluginParts } from '../cable/orcaPluginSetup.js'
import { harnessPath } from '../config/harnessHome.js'
import { cursorFolderCli, editorCli, vscodeExtensionDeps, type VscodeExtensionDeps } from '../devices/vscodeExtension.js'
import { WindowForm } from '../cable/windowForm.js'
import { createWindowRouter } from '../cable/windowRoute.js'
import { WindowSelection } from '../cable/windowSelection.js'
import { WindowVisit } from '../cable/windowVisit.js'
import { MachineListCache } from '../device/machineList.js'
import { trustedCodexHomes } from '../lib/codexProfiles.js'
import type { NoticeAsk, NoticeCard, NoticeKind, NoticeResult } from '../lib/dialNotice.js'
import { DIAL_USAGE_FILE } from '../lib/dialUsageContract.js'
import { claudeProjectsRoots, codexHomeRoots, movedEngineHomes } from '../lib/engineHomes.js'
import { harnessDevicesRequest } from '../lib/harnessDevices.js'
import { codeOrLength, errorKind } from '../lib/log.js'
import { pidAlive } from '../lib/processProof.js'
import { ptyHostBinary } from '../lib/ptyHost/launch.js'
import { OpenSessions, SessionRows } from '../lib/sessionSearch/external.js'
import { externalProviders } from '../lib/sessionSearch/externals/index.js'
import { fileStamp, listProcesses, processAlive } from '../lib/sessionSearch/externals/support.js'
import { setVoiceRouterDeviceConnected, setVoiceRouterSessions, shutdownVoiceRouter } from '../lib/voiceRouter.js'
import { storePackageFolder, storePackageLook } from '../lib/windows/storePackage.js'
import { createTally, createTierDecider, type Tier, type TierDecision, type TierInput } from '../lib/notifyTier.js'
import { tmuxFinder } from '../lib/binaryFinder.js'
import { VERSION } from '../version.js'
import { createPartGuard } from './devicesGuard.js'
import { attachHandler, dialStream, frontHandler, noticeDoneHandler, noticeHandler, noticeListHandler, notifyHandler, nudgeHandler, orcaFrontHandler, tabHandler, tabsStream, threadHandler, type DevicesListener, type ListenerHandler, type ListenerStreamHandler, type NoticeWho, type NudgeAsk } from './devicesListener.js'
import { FLEET_FALLBACKS, FLEET_UNAVAILABLE, startFleet, type Fleet } from './fleet.js'
import { TURN_UNANSWERED } from './fleetRouter.js'

export { DEVICES_REQUESTS }

/** What the devices need that is not the core's to give. */
export interface DevicesDeps {
  /** Where each dial keeps its log, one file a day (cable/dialLog.ts). */
  logsDir: string
  /** Where custom pets are kept; `<HARNESS_DEVICES_DIR>/pets` when unset. */
  petsDir?: string
  /** The dials to look at, by serial number (`HARNESS_DIAL_SERIALS`); every one when empty. */
  dialSerials?: string[]
  /** The end-to-end suite's dial, a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`). */
  testDialPort?: string
  /** Leave the serial ports alone altogether (`CABLE_DISABLE`). */
  cableDisabled?: boolean
  /** `HARNESSD_TEST_FAULTS`: parts to fail, for the end-to-end suite. */
  faults?: ReadonlySet<string>
  log?: (line: string) => void
  /** How loudly a finished turn tells the devices. Defaults to the fixed rules (lib/notifyTier.ts). */
  decideTier?: (input: TierInput) => Promise<TierDecision>
  /** A monotonic clock in ms (default `performance.now`), for the reply throttle: a wall-clock step must not stall or burst it. */
  now?: () => number
  /** How the voice router's worker is stopped when the process exits: an engine process of its own. */
  onExit?: (run: () => void) => void
  /** Read this computer's agents again before a list is built from them: in their own process the devices
   *  keep a copy, asked of the core as the dial's tick or ⌘K needs it (services/devicesProcess.ts). */
  refresh?: () => Promise<void>
  /** Whether a view of the core's agents has landed in that copy: before one it is empty, which is not the core saying
   *  Harness runs no Claude agent. Absent inside the core's process, whose agents are its own and always known. */
  agentsRead?: () => boolean
  /** Called with a function this part runs whenever its link to the core drops: the calls that core held have failed. */
  onCoreGone?: (run: () => void) => void
  /** An agent's conversation token totals, read fresh (not the 15 s cache); null when unknown or remote.
   *  Defaults to the core's `usageFresh`. */
  readUsage?: (agentId: string) => Promise<{ input?: number; cached?: number; output?: number } | null>
  /** For this service's tests: the dial's session, and how dials are found and opened. */
  Session?: ConstructorParameters<typeof CableFleet>[0]
  cable?: Partial<CableFleetOptions>
  /** For this service's tests: how `orca`, and the commands a tap runs to open an app (cable/hosts/open.ts), are found and
   *  run, how Orca's focus watch is spawned, and how the binary is stat'd for the probe's cache (cable/hosts/orca.ts). */
  orca?: OrcaReadDeps
  /** For this service's tests: Orca's focus and order reads (cable/hosts/orca.ts); built on `orca` when unset. */
  orcaReads?: OrcaReads
  /** For this service's tests: Rex's layout and focus reads (cable/hosts/rex.ts); built on the found `rex` when unset. */
  rexReads?: RexReads
  /** For this service's tests: where `rex` is (cable/hosts/rex.ts rexFinder, this computer's when unset). */
  rex?: ReturnType<typeof rexFinder>
  /** For this service's tests: how `codex` is found and run, what it runs under, and the read of the login shell that
   *  both take (cable/hosts/codexQueue.ts). */
  codex?: Omit<CodexQueueDeps, 'cwd'>
  /** For this service's tests: herdr's socket (cable/hosts/herdrClient.ts). */
  herdr?: HerdrClient
  /** For this service's tests: Herdr Core's socket (cable/hosts/hcClient.ts). */
  hc?: HcClient
  /** For this service's tests: cmux's own command line (cable/hosts/cmuxCli.ts). */
  cmux?: CmuxClient
  /** For this service's tests: cmux's event log by descriptor (cable/hosts/cmuxFocus.ts); the file, read-only, by default. */
  cmuxEvents?: CmuxLogFiles
  /** For this service's tests: opencode's service (cable/hosts/opencodeClient.ts). */
  opencode?: OpencodeClient
  /** For this service's tests: the reader of the Claude app's store (cable/hosts/claudeAppStore.ts). */
  claudeAppStore?: ClaudeAppSourceDeps['store']
  /** For this service's tests: the reader of the ChatGPT app's threads (cable/hosts/codexAppThreads.ts). */
  codexAppThreads?: CodexAppSourceDeps['threads']
  /** For this service's tests: the watch on the Claude app's store and the ChatGPT app's Codex home; `watchNearest`
   *  (cable/hosts/folderWatch.ts) by default. */
  watchStore?: (folders: readonly string[], changed: (file?: string) => void) => () => void
  /** For this service's tests: the transcriber of a dial's speech, handed to the dial's host in place of the backend's. */
  transcribe?: CableHostWiring['transcribe']
  /** For this service's tests: an app bundle's id from its Info.plist; `readBundleId` (cable/hosts/scannedApp.ts) by
   *  default. */
  bundleId?: (app: string) => Promise<string | undefined>
  /** For this service's tests: the folder of a Store package on Windows; `storePackageFolder`
   *  (lib/windows/storePackage.ts) by default. */
  storePackageFolder?: (name: string) => Promise<string | null>
  /** Opens the devices' own listener with these handlers (services/devicesListener.ts). Given by the devices process,
   *  and on Windows inside the core's too, where every service runs, until Windows services run in their own process
   *  (services/inline.ts). Elsewhere inside the core's process (`HARNESSD_SERVICES=none`, Harness OS) there is none, so
   *  the core's process opens no socket for the devices, and the dial follows no app in front there. */
  listen?: (handlers: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>>, log: (line: string) => void) => Promise<DevicesListener | null>
  /** For this service's tests: how an agent's tty and its process's start are read; `ps` by default
   *  (cable/hosts/tabs.ts). */
  tty?: (pid: number) => Promise<TabTty | undefined>
  /** For this service's tests: how a tab's process is read before the dial's words go to it, its tty, groups and start;
   *  `ps` by default (cable/hosts/tabsType.ts readTabProcess). */
  tabProcess?: (pid: number) => Promise<TabProcess | undefined>
  /** For this service's tests: the processes reading a tab's tty as their stdin; `lsof` by default
   *  (cable/hosts/tabsType.ts readTtyReaders). */
  ttyReaders?: (tty: string) => Promise<readonly number[] | undefined>
  /** For this service's tests: the process table VS Code's terminals are matched by; `ps` by default
   *  (cable/hosts/vscodeTerminals.ts). */
  processParents?: VscodeTerminalsDeps['processes']
  /** For this service's tests: whether a Claude Code session's settings draw it fullscreen; its settings files by default
   *  (cable/hosts/claudeRenderer.ts readFullscreen). */
  claudeFullscreen?: VscodeTerminalsDeps['fullscreen']
  /** For this service's tests: Claude Code's managed settings file, which outranks a session's own; this platform's by
   *  default (cable/hosts/claudeRenderer.ts MANAGED_SETTINGS). */
  claudeManagedSettings?: string
  /** For this service's tests: how an agent's process group and its VS Code terminal's foreground group, through that
   *  terminal's shell, are read; `ps` by default (cable/hosts/vscodeTerminals.ts readForeground). */
  processGroups?: VscodeTerminalsDeps['foreground']
  /** For this service's tests: how Claude Code is found for a Claude Code home; the daemon's own lookup by default
   *  (devices/claudePlugin.ts claudeFound). */
  claude?: (home: string, shell: boolean) => Promise<ClaudeRun | null>
  /** For this service's tests: how Codex is found for a Codex home; the daemon's own lookup by default
   *  (devices/codexPlugin.ts codexFound). */
  codexFound?: (home: string, shell: boolean) => Promise<ClaudeRun | null>
  /** For this service's tests: Claude Code's marketplace folder and what cli.js carries for it;
   *  `harnessPath('claude-marketplace', homedir())` and this build's when unset (devices/claudePlugin.ts). */
  claudePlugin?: ClaudePluginSource
  /** For this service's tests: Orca's account homes (devices/orcaHomes.ts); read with this computer's `orca` when unset. */
  orcaHomes?: OrcaHomesCache
  /** For this service's tests: how VS Code and Harness's extension in it are found and `code` is run; the real ones by
   *  default (devices/vscodeExtension.ts). */
  vscodeExtension?: VscodeExtensionDeps
  /** For this service's tests: how Cursor and Harness's extension in it are found and `cursor` is run; the real ones by
   *  default. */
  cursorExtension?: VscodeExtensionDeps
  /** For this service's tests: Orca's CLI, the plugin's files and its folder; this computer's `orca` and
   *  `harnessPath('orca-plugin', homedir())` when unset (devices/orcaPlugin.ts). */
  orcaPlugin?: OrcaPluginRun & { folder: string }
  /** For this service's tests: how a tap brings an agent's window forward on Linux; this login's desktop when unset
   *  (cable/hosts/linuxRaise.ts systemLinuxRaise). */
  raise?: LinuxRaise
  /** For this service's tests: how a tap brings an app forward on Windows; `harness-pty`'s raise when unset
   *  (cable/hosts/windowsRaise.ts). */
  windowsRaise?: WindowsRaise
}

/** ⌘K's answer while the fleet is not running: it never started, so there is no list to weigh. */
const NO_AGENT_LIST = 'no agent list yet'
/** The sentences ⌘K's send is refused with here, all fixed: its log line says one as it is, anything else by its length. */
const SEND_REFUSALS: ReadonlySet<string> = new Set([NO_AGENT_LIST, FLEET_UNAVAILABLE, TURN_UNANSWERED])
const unrouted = (reason: string): RouteAnswer => ({ agentId: '', machineId: '', name: '', confidence: 0, reason, candidates: [], weighed: 0, machines: 0, via: '' })
const sid = (id: string): string => id.slice(0, 8)
/** A card for the dial, and the machine it came from when another machine sent it (services/fleet.ts). */
type DialEvent = NonNullable<ReturnType<typeof cableEventFor>> & { machineId?: string }
/** What a dial made of a local follow, by its cause, or the settle's that asked it as an attach: the outcome only, never
 *  the app or the agent. */
const FOLLOWED: Record<FollowCause | 'settle', Record<'moved' | 'no-tile', string>> = {
  prompt: { moved: '[device] prompt · moved', 'no-tile': '[device] prompt · skipped · no tile' },
  attach: { moved: '[device] attach · moved', 'no-tile': '[device] attach · skipped · no tile' },
  settle: { moved: '[device] settle · moved', 'no-tile': '[device] settle · skipped · no tile' },
  tab: { moved: '[device] tab · moved', 'no-tile': '[device] tab · skipped · no tile' },
  focus: { moved: '[device] focus · moved', 'no-tile': '[device] focus · skipped · no tile' },
  thread: { moved: '[device] thread · moved', 'no-tile': '[device] thread · skipped · no tile' },
  vscode: { moved: '[device] vscode · moved', 'no-tile': '[device] vscode · skipped · no tile' },
  pane: { moved: '[device] pane · moved', 'no-tile': '[device] pane · skipped · no tile' },
}
/** A tab app reports back each tab the dial selects, and Orca each pane it switches to: a report within this long of the
 *  dial's move there is that move's echo. Every move of that long is kept, as a fast swipe's late report for a place it
 *  passed must not pull the dial back, and at most ECHO_KEPT of them. */
const TAB_ECHO_MS = 2_000
const ECHO_KEPT = 8
/** How Orca's plugin names a worktree that has an identity (docs/plans/2026-11-23-dial-orca-chats-design.md, decided 5):
 *  its key follows, which Orca's worktree list maps to the worktree's id (orcaChatSource.ts worktreeFor). */
const ORCA_IDENTITY = 'identity:'

// The agents outside a pane: how often their processes are checked, the turns no hook moves are looked at, and, while a dial
// is attached, the open sessions are scanned (docs/specs/2026-11-13-device-without-the-app.md, "ObservedSource").
const OBSERVED_TICK_MS = 30_000
const TURN_CHECK_MS = 3_000
const OPEN_SCAN_MS = 60_000
/** Under the round dial's 25 s fuse (firmware ui_prune_stale_busy): it forgets a turn it hears nothing of for that long,
 *  and only `turn.started` renews it. An agent outside a pane sends no step to renew it with. */
const REMIND_MS = 20_000
/** The observed source drops an ended session 10 s after its end, by the wall clock (observed.ts); looked at a beat later,
 *  as a timer can fire a little before the wall clock says it is due. */
const ENDED_MS = 10_500
/** A look at the processes this long after a Claude Code's held poll lost its client or a session ended, once the dying
 *  process has left the process table. */
const GONE_MS = 1_000
/** How long the cable waits for the devices' listener to open: it opens in a few milliseconds. */
const LISTENER_WAIT_MS = 1_000
/** How long after the dial's own continue link to a Claude app session an attach is that link's echo: the app attaches
 *  the session it shows within about a second. Also how long any move of the dial sets the Claude app's settle aside. */
const ATTACH_ECHO_MS = 2_000
/** How many agents whose last turn failed are remembered for Needs you's list: a bound on what a busy fleet leaves. */
const FAILED_KEPT = 64
/** herdr's panes with no session whose shell is asked or known at once (placeInHerdr): a bound on what one herdr costs. */
const HERDR_SHELLS_MAX = 16
/** The person is with an agent whose own prompt, or a Harness agent's turn, began at most this long ago: the usage counts'
 *  own edge (docs/plans/2026-11-26-needs-you-right-design.md, Part 2). */
const PRESENT_MS = 120_000
/** The outside agents whose person's last prompt is kept: a bound on the ids hooks name, as a session a Harness agent
 *  holds is on no outside row and never goes as it leaves. */
const PROMPTED_MAX = 64

/** Whether [path] is a file: false when nothing is there, it is a folder, or on any error. */
function isFile(path: string): boolean {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

/** The socket at [path], for kitty's: null when none is there, it is no socket, or on any error. */
function socketStat(path: string): Stats | null {
  try {
    const stat = statSync(path)
    return stat.isSocket() ? stat : null
  } catch {
    return null
  }
}

/** The uid owning the socket at [path]. */
function socketOwner(path: string): number | null {
  return socketStat(path)?.uid ?? null
}

/** The identity of the socket at [path] (`<dev>:<ino>`): a kitty started again there listens on a new one. */
function socketId(path: string): string | null {
  const stat = socketStat(path)
  return stat === null ? null : `${stat.dev}:${stat.ino}`
}

/** Orca's account homes on this computer, read with its own `orca` (devices/orcaHomes.ts). */
function orcaHomesCache(now: () => number, log: (line: string) => void): OrcaHomesCache {
  const system = orcaHomesDeps()
  return createOrcaHomesCache({ read: () => readOrcaHomes(system), now, log })
}

/** This computer's agents outside a pane, read with ⌘P's readers (services/externalSessions.ts) in the daemon's own homes
 *  and Orca's account homes, and how the dial's voice and tap reach them. */
function observedSource(
  dataDir: string, platform: NodeJS.Platform, log: (line: string) => void, orcaHomes: Pick<OrcaHomesCache, 'get'>,
  actions: ObservedActions, tty: ObservedDeps['tty'], scanned: ObservedDeps['scanned'], herdrTerminal: ObservedDeps['herdrTerminal'],
  outer: ObservedDeps['outer'], ptyOwnerOf: ObservedDeps['ptyOwner'], nesting: Pick<ObservedDeps, 'table' | 'madeBy' | 'nested'>,
): ObservedSource {
  // Worked out at each read: a home the person moved is adopted while the daemon runs, and Orca's follow its last read.
  const places = observedPlaces({
    claudeRoots: () => claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR),
    codexRoots: () => codexHomeRoots(env.CODEX_HOME),
    orca: () => orcaHomes.get(),
  })
  const providers = externalProviders(undefined, places)
  // Each engine's own folders, which its transcripts are read in.
  const answerRoots: Record<AnswerEngine, () => string[]> = {
    claude: () => places.claude.roots(),
    codex: () => places.codex.roots().map((home) => join(home, 'sessions')),
    cursor: () => [join(cursorDataDir(), 'projects')],
  }
  return new ObservedSource({
    now: Date.now,
    platform,
    processes: listProcesses,
    alive: processAlive,
    openSessions: new OpenSessions({ providers, log }),
    sessionRows: new SessionRows({ providers, excluded: [dataDir], log }),
    excluded: [dataDir],
    // Asked for the engines lastAnswer.ts reads alone (observed.ts), and read only inside their own folders: a hook can
    // name any path.
    lastAnswer: (engine, path) => readLastAnswer(engine, path, {
      roots: answerRoots[engine](), maxBytes: LAST_ANSWER_MAX_BYTES, deadlineMs: LAST_ANSWER_DEADLINE_MS,
    }),
    fileStamp,
    log,
    actions,
    apps: learnApps,
    ptyOwner: ptyOwnerOf,
    // Asked for Claude Code's sessions alone (observed.ts), and read only inside its own records folders.
    record: (owner) => readRecord(owner, { records: places.claude.records() }),
    // A hook's transcript path names the home whose settings a voice start reads only when its projects folder is one of
    // these (observed.ts). By name, not places.claude.roots(): Orca links an account's `projects` to another home's, and
    // the scan's list keeps one name of each real folder, which would drop that account.
    claudeRoots: () => [...claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR), ...orcaHomes.get().claude.map((home) => join(home, 'projects'))],
    tty,
    scanned,
    herdrTerminal,
    served: servedLookup(platform),
    outer,
    ...nesting,
  })
}

export function startDevices(core: CoreApi, ports: CorePorts, deps: DevicesDeps): ServiceRequests {
  const log = deps.log ?? ((line: string) => console.log(line))
  const monotonic = deps.now ?? (() => performance.now())
  const tally = createTally((line) => log(`[cable] ${line}`))
  const tierOf = deps.decideTier ?? createTierDecider({
    tally,
    log,
  })
  const part = createPartGuard({ log, faults: deps.faults })
  // The Notifications setting (docs/plans/2026-11-16-dial-agent-notify-design.md) is this computer's, not the dial's: the
  // windows and the watch hear it with every dial status, and the owner's other machines and the Devices tab never do.
  // Only once the devices' own listener opened, the one door a change comes in by: with none (services inside the core,
  // off Windows, or a listener that failed to open) the menu must not offer a setting no click can change.
  const notifyMode = new NotifyModeStore(join(core.dataDir, NOTIFY_MODE_FILE))
  let listenerOpen = false
  const sayStatus = (status: DialStatus): void => core.clients.sendLocal({ type: 'dial_status',
    payload: { ...status, ...(listenerOpen ? { notify: notifyMode.get() } : {}) } })
  // The agents whose last turn failed: in Needs you, the only finished turns the dial's list keeps (newsKept). In memory
  // alone, so a turn that failed before the devices restarted is not kept; the oldest goes first past FAILED_KEPT.
  const failedLast = new Set<string>()
  const noteTurn = (agentId: string, failed: boolean): void => {
    failedLast.delete(agentId)
    if (!failed) return
    failedLast.add(agentId)
    if (failedLast.size > FAILED_KEPT) failedLast.delete(failedLast.values().next().value!)
  }

  // What the windows on this computer last said: the desk the dial walks and whether it is in front, and
  // which window has the person's attention for a spoken selection, a visit or a form.
  let desk: string[] = []
  let foreground = true
  let onScreen = new Set<string>()
  let focus: WindowFocus = { voice: null, form: null }
  /**
   * Is this agent already in front of somebody at this desk?
   *
   * Both halves are needed and neither alone is enough: a tile on the tab says WHERE it is, the window
   * being in front says whether anyone can see it. The dial used to be told the first half only, so it
   * stayed quiet about a turn that finished while the window sat behind a browser — which is the one
   * case a notification exists for — and the window, which checks both (`_visibleOnTab`), spoke up.
   */
  const alreadyOnScreen = (agentId: string): boolean => foreground && onScreen.has(agentId)

  // ── the fleet: the owner's other machines, and the router every turn goes through ────────────────────
  //
  // The devices' own copy of the machine list, read through the core, which keeps the list the windows and
  // the trust group read; this copy writes no file of its own, so `machines.json` has one writer.
  const machines = new MachineListCache(() => core.account.machines(), () => core.machine.computerId(),
    (line) => log(`[cable] ${line}`), core.dataDir, () => null, false)
  // Each read of the core's agents, as a list is built (once a second with a dial attached), lets a restored notice
  // waiting for a Harness agent find it (`lookHarness`): a dial can attach before the first read. Inside the core's
  // process the agents are read directly, with no refresh, and the look runs all the same: on Windows the devices there
  // have their listener (services/inline.ts), so a notice is made and restored there too.
  // The same read starts the dial's first-agent clock once a Harness agent runs on this computer, as just read: the cable
  // host's total is the account's, every machine's, from the list before. Only a coming is said here: the agents outside a
  // pane are read at each attach and each change of theirs.
  // And it says again that a dial is connected today: a dial's hello can come before the core's first view says signed
  // in, which leaves its attach uncounted. A flag set once a day, so a read every second changes nothing.
  const refresh = (): Promise<void> => (deps.refresh?.() ?? Promise.resolve()).then(() => {
    lookHarness()
    if (core.agents.advertised().length > 0) count((usage) => usage.agentsPresent(true))
    if (dialOn) part.call('dialUsage', () => usageFile.add('dial_connected_installation_days'))
  })
  const fleet: Fleet | null = part.start('fleet', () => startFleet(core, { machines, desk: () => desk, refresh }).fleet, FLEET_FALLBACKS)

  // ── the window bridges ─────────────────────────────────────────────────────────────────────────────
  //
  // Spoken tasks go to the WINDOW to be routed, not to the copy of the router in this process. See
  // cable/windowRoute.ts for the two-phase wait and why "no window" and "a person is still choosing" must
  // not be the same answer.
  const windowRouter = createWindowRouter({
    hasWindow: () => core.clients.hasWindow(),
    send: (voiceId, text, cmd) => {
      // To the windows on this computer, never the cloud: this asks the window in front of the dial to
      // open a palette, and fanning it out would pop one open on a computer nobody is sitting at.
      core.clients.sendLocal({ type: 'voice_route_request', payload: { voiceId, text, ...(cmd ? { cmd } : {}) } })
      log(`[route] voice → the window · ${Buffer.byteLength(text, 'utf8')} bytes${cmd ? ` · /${cmd}` : ''}`)
    },
    log: (line) => log(`[cable] ${line}`),
  })
  const windowSelection = new WindowSelection({
    focus: () => focus.voice ?? undefined,
    send: (connId, payload) => core.clients.sendToWindow(connId, { type: 'dial_selection', payload }),
  })
  const windowForm = new WindowForm({
    focus: () => focus.form ?? undefined,
    send: (connId, payload) => core.clients.sendToWindow(connId, { type: 'dial_form', payload }),
    log: (line) => log(`[cable] ${line}`),
  })
  const windowVisit = new WindowVisit({
    focus: () => focus.voice ?? undefined,
    send: (connId, payload) => core.clients.sendToWindow(connId, { type: 'dial_visit', payload }),
  })

  // ── the dial on the USB cable ──────────────────────────────────────────────────────────────────────
  //
  // A device surface served entirely over a wire the user physically owns: no backend, no pairing, no
  // E2EE, no credential on the device. Everything it can ask for is answered by the core through its API —
  // the same registry, the same delivery path — and by the fleet's router, because a second
  // implementation of any of those is a second set of bugs.
  let revision = 0
  // Built before the cable starts: a dial's first hello may read the mapping.
  const pets = new PetStore(deps.petsDir ?? join(env.HARNESS_DEVICES_DIR, 'pets'))
  // The assistant's latest paragraph per agent, as the processing cards carry it; gone when the turn ends.
  const latestUpdate = new Map<string, string>()
  // ── the agents outside a pane ──────────────────────────────────────────────────────────────────────
  //
  // Claude Code in Orca, Codex in Ghostty: their hooks reach here through the core, which keeps nothing of them, and their
  // open sessions are read here. Nothing of them leaves this computer: the core, a window and the gateway hear none of it
  // (docs/specs/2026-11-13-device-without-the-app.md). `HARNESS_DEVICE_OBSERVED=off` is the kill switch.
  //
  // The dial's voice reaches them through their mod's long poll (Claude Code's) or Codex's own queue, idle or working, or
  // typed into their Orca terminal when idle, and a tap brings its app forward, on its own pane where the app has a way in
  // that asks for no new permission (docs/specs/2026-11-13-device-claude-orca.md, docs/specs/2026-11-15-device-codex.md).
  /** The part timers still to fire: the devices stopping cancels them, as a part with no stop of its own cannot. */
  const pending = new Set<ReturnType<typeof setTimeout>>()
  /** A timer of one part, its run guarded as a notice into that part is, and never what keeps the process up. */
  const timerIn = (name: string) => (ms: number, run: () => void): (() => void) => {
    const timer = setTimeout(() => { pending.delete(timer); part.call(name, run) }, ms)
    timer.unref()
    pending.add(timer)
    return () => { pending.delete(timer); clearTimeout(timer) }
  }
  // The dial's usage counts (docs/plans/2026-11-23-dial-usage-counts-design.md): fixed names in a file of the devices'
  // own, which the gateway reads, so no count goes through the core. Signed-in computers only.
  const wallClock = (): number => Date.now()
  const dialPorts = join(core.dataDir, 'dial-ports.json')
  const usageFile = new DialUsageFile({
    file: join(core.dataDir, DIAL_USAGE_FILE),
    now: wallClock,
    after: timerIn('dialUsage'),
    signedIn: () => core.account.signedIn(),
    // The setup's mark is written since CLI 0.6.79; a board's greeting has been kept since 0.4.54.
    hadDial: () => readSetup(core.dataDir).dial || greetedAsDial(dialPorts),
    log,
  })
  /** Where the dial would place an agent with no window: its first page for one outside a pane (`pagesOf`: its terminal
   *  app's for one nested in tmux or herdr, the multiplexer's when it has no app), Harness for the rest. Read from the
   *  registry itself, as the cable host answers none while a window holds the dial on its tab: [entries] when the
   *  caller merged it already. */
  const usageAgent = (agentId: string, entries: HostEntry[] = registry.entries()): DialAgent | undefined => {
    const who = cableHost.describe(agentId)
    if (!who) return undefined
    const row = entries.find((e) => e.agent.id === agentId)?.agent
    return { engine: who.engine, host: row?.host ?? 'harness', page: row ? pagesOf(row)[0] : 'harness', held: observed?.heldOnly(agentId) ?? false }
  }
  /** Whether a voice's words wait for the agent's turn to end: its row at work or waiting on the person (a Harness agent's
   *  from its cards), or another machine's turn running. Called only at a voice's end, which a dial's frame brings once
   *  this start has returned: `remoteTurns`, `registry` and `busyState` are made below. */
  const usageWorking = (agentId: string): boolean => remoteTurns.has(agentId)
    || registry.entries().some(({ agent }) => agent.id === agentId && busyState(agent.state))
  /** Whether the agent's own app is known and another known app is in front: its row's app (Harness's agents' is
   *  `harness`, as the front is while Harness Desktop is), not the unknown app nor one the scan has still to tell. No row
   *  (another machine's agent) or no front is not away. Called only at a ring or a turn's end, once this start has
   *  returned: `registry` is made below. */
  const usageAway = (agentId: string): boolean => {
    const front = cableHost.latestFront()
    const row = registry.entries().find(({ agent }) => agent.id === agentId)?.agent
    return front !== undefined && row !== undefined && !row.appPending && row.app !== UNKNOWN_APP && row.app !== front
  }
  /** Claude Code's default home, the devices' own: the renderer's, the dial setup's and the voice refusal's. */
  const claudeHome = dirname(env.CLAUDE_PROJECTS_DIR)
  /** The engines' default homes, the dial setup's own: the dial skill is looked for where the setup writes it. */
  const skillHomes = { claude: claudeHome, codex: env.CODEX_HOME }
  const dialUsage = createDialUsage({ sink: usageFile, now: wallClock, after: timerIn('dialUsage'), describe: usageAgent,
    working: usageWorking, away: usageAway, log, skills: () => installedSkills(core.dataDir, skillHomes) })
  /** A count is the devices' own part: one that throws never reaches the dial. */
  const count = (run: (usage: DialUsage) => void): void => part.call('dialUsage', () => run(dialUsage))
  /** A Harness agent's question, as the dial's wait on the person: by its request, as an agent can hold two. */
  const questionWait = (agentId: string, requestId: string): string => `question:${agentId}:${requestId}`
  /** A row with a process behind it: an ended session or a row of an app's store runs nothing. */
  const running = (agent: HostAgent): boolean => !agent.ended && !agent.resting
  /** Whether an agent outside a pane runs for the dial to show, read from the registry now: the first-agent clock starts
   *  at the attach or once one does. A Harness agent's coming is the refresh's to say. */
  const outsideRunning = (entries: HostEntry[] = outsideEntries()): boolean => entries.some(({ agent }) => running(agent))
  const inbox = new Inbox({ now: monotonic, after: timerIn('inbox') })
  const apps = deps.orca ?? orcaDeps()
  /** Where herdr's socket is, from the daemon's own environment: the client reads it, and the herdr source watches for it. */
  const herdrAt = herdrClientDeps()
  const herdrClient = deps.herdr ?? createHerdrClient(herdrAt)
  const herdrAdapter = createHerdrAdapter({ ...apps, client: herdrClient, front: () => cableHost.latestFront(), log })
  /** `HARNESS_OPEN_BIN`: the end-to-end tests' fake `open`, run for each `open -b` (cable/hosts/open.ts). */
  const openBin = process.env.HARNESS_OPEN_BIN
  /** Where the ChatGPT app is looked for. `HARNESS_APPLICATIONS_DIR`, an absolute path alone, stands in for
   *  /Applications or /usr/lib: those are the computer's whatever the home, so the end-to-end harness points it inside
   *  the daemon's root, as it does `HARNESS_CODEX_APP_BIN` (cable/hosts/codexQueue.ts). On Windows it is the one place,
   *  and with none the app's Store package is asked for. */
  const chatGptApps = chatGptPlaces(apps.platform, process.env.HARNESS_APPLICATIONS_DIR, homedir())
  /** The ChatGPT app's Store package on Windows: one answer, which the install check and the queue's codex share. */
  const chatGptPackage = storePackageLook(APP_PACKAGE, deps.storePackageFolder ?? storePackageFolder, monotonic)
  /** Where Herdr Core's socket is, from the daemon's own environment: the client reads it, and the hc source watches for
   *  it. */
  const hcAt = hcClientDeps()
  const hcClient = deps.hc ?? createHcClient(hcAt)
  /** Where opencode's service.json is, from the daemon's own environment: the client reads it, and the opencode source
   *  watches its folder. */
  const opencodeAt = opencodeClientDeps()
  const opencodeClient = deps.opencode ?? createOpencodeClient(opencodeAt)
  /** The devices follow the default hc session, the one whose addresses the hook sends (notify.mjs): its socket is
   *  where the daemon's own environment, with no session or socket named, puts it. */
  const hookIds = hcAt.socketPath === hcSocketPath({ ...process.env, HC_SESSION: undefined, HC_SOCKET: undefined }, hcAt.home)
  const herdrApp = createHerdrAppAdapter({ ...apps, client: hcClient, log, bin: openBin, hookIds,
    inFront: () => cableHost.latestFront() === 'herdr', shows: (address) => hcSource?.shows(address) === true,
    tabOf: (address) => hcSource?.tabOf(address), kindOf: (address) => hcSource?.kindOf(address),
    statusOf: (address) => hcSource?.statusOf(address), reports: (address) => hcSource?.reports(address) === true })
  const hcPane = (address: string): Pane => ({ adapter: herdrApp.id, id: address })
  const cmuxClient = deps.cmux ?? createCmuxClient({ ...cmuxClientDeps(), platform: apps.platform })
  /** cmux is installed, as the last attach found it: only then are a hooked agent's words offered to it. */
  let cmuxFound = false
  /** The looks for the ChatGPT app, one each attach and detach: a look that lands after a newer one began starts nothing. */
  let codexAppLooks = 0
  const cmuxApp = createCmuxAppAdapter({ ...apps, client: cmuxClient, bin: openBin, found: () => cmuxFound,
    inFront: () => cableHost.latestFront() === 'cmux', kindAt: (surface) => cmuxSource?.kindAt(surface) })
  const cmuxPane = (pane: string): Pane => ({ adapter: cmuxApp.id, id: pane })
  // Cursor as found here: its folder window's tap (below) and its extension's setup run the same `cursor`.
  const cursorExtension = deps.cursorExtension ?? vscodeExtensionDeps('cursor', process.env.HARNESS_CURSOR_BIN)
  // Linux's way to bring a window forward, where macOS runs `open -b` (docs/plans/2026-11-19-dial-linux-design.md § 2).
  const raise = deps.raise ?? (apps.platform === 'linux' ? systemLinuxRaise(apps, log) : undefined)
  // Windows', by the app's bundle as on macOS (docs/plans/2026-11-19-dial-windows-design.md, part C). A measure: what
  // Windows answered each raise, never the app.
  const raiseCount = createEngineTally('[device] raise', ['window'], ['raised', 'refused', 'none'], log)
  const windows = deps.windowsRaise ?? (apps.platform === 'win32' ? createWindowsRaise({ binary: ptyHostBinary, run: apps.run,
    cursorCli: () => editorCli(cursorExtension), desktopLauncher: harnessDesktopLauncher, count: (outcome) => raiseCount('window', outcome) }) : undefined)
  const claude = createClaudeAppAdapter({ ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'claude', windows })
  const claudePane = (localId: string): Pane => ({ adapter: claude.id, id: localId })
  // Run from the home folder, so no project's .codex/ is read; each send names the Codex home whose config it loads.
  const codexQueue = createCodexQueue({ ...(deps.codex ?? codexQueueDeps(chatGptPackage)), cwd: homedir() })
  // The stream a watch holds open on the devices' listener: a rest or a tap on an agent in Terminal, iTerm2 or Ghostty
  // asks it to select that agent's tab (docs/specs/2026-11-15-dial-terminal-follow.md). Only macOS's apps select a tab
  // by its tty: elsewhere no agent's is read, and none has a tab. The dial's words go on it too, for Harness Device to
  // write into a Ghostty tab (docs/plans/2026-11-25-dial-voice-codex-terminals-design.md); its timers stop
  // with the devices.
  const tabs = tabsStream({ after: timerIn('tabs') })
  // The stream Orca's Harness Device plugin holds open: whether a dial is attached and the agent it shows
  // (docs/specs/2026-11-16-orca-device-plugin.md). A part of its own, so a throw on its path is never the dial's. Its
  // count's timer stops with the devices.
  const dial = dialStream({ log, after: timerIn('dialStream'), ended: () => part.call('orca', () => orcaFronted(null)) })
  // The streams Harness's own VS Code extension holds open, one a window, and the terminal each VS Code agent runs in
  // (docs/plans/2026-11-17-dial-vscode-extension-design.md). An adapter's capabilities are read at each look, so a
  // terminal found or lost tells the dials to look again. Cursor's windows hold the same stream, with no word of which
  // editor they are: a window reports shells by pid, and an agent's pid is placed in one editor alone by its hook's bundle
  // id (vscode.ts paneOf), so each editor's adapter finds only its own agents' terminals in the one pool.
  const renderer = {
    defaultHome: claudeHome, managed: deps.claudeManagedSettings ?? MANAGED_SETTINGS[apps.platform],
  }
  /** Whether Claude Code's settings draw a session fullscreen: VS Code's terminals and Rex's blocks page it alike. */
  const claudeFullscreen = deps.claudeFullscreen ?? ((cwd: string, transcriptPath: string | undefined) => readFullscreen(cwd, transcriptPath, renderer))
  const vscode = vscodeStreams({
    processes: deps.processParents ?? readProcessParents,
    fullscreen: claudeFullscreen,
    foreground: deps.processGroups ?? readForeground,
    changed: () => part.call('dial', () => cable.syncAgents()),
    focused: (pid, terminal, at, regained) => part.call('dial', () => editorFocused(pid, terminal, at, regained)),
    platform: apps.platform,
    now: monotonic,
    after: timerIn('vscode'),
    log,
  })
  const ttyOf = apps.platform === 'darwin' ? deps.tty ?? readTabTty : undefined
  /** Whether [app] reports its selected tab here: a tab app, where the devices read ttys (macOS). */
  const reportsTabs = (app: string): app is TabApp => ttyOf !== undefined && isTabApp(app)
  /** The tab each tab app reported selected last: set by every tab report, and an app's dropped when another app, or
   *  none, settles in front. The devices are told no app's quit, and Harness Device reports the tab again each time the
   *  app comes back (docs/plans/2026-11-24-dial-tmux-pane-focus-follow-design.md, "The front client"). */
  const lastTabs = new Map<TabApp, string>()
  /** Whether the agent's tab (its multiplexer client's) is the one [app] reported selected last, where it reports tabs:
   *  with none reported yet, the person may be on a plain tab of it. In Orca, whose watch tells the terminal in front:
   *  the agent's client is still Orca's told client, and the agent still placed at that terminal, as the person's focus
   *  and the agent's client can each move while tmux is read (docs/plans/2026-11-27-orca-tmux-follow-focus-design.md
   *  §3). */
  const onTabInFront = (source: ObservedSource, app: string, agentId: string): boolean => {
    if (app === 'orca') {
      const told = orcaClient()
      return told !== undefined && source.tabTty(agentId) === told && orcaTmux.agents.get(agentId) === focusWatch?.pane
    }
    if (!reportsTabs(app)) return true
    const tab = lastTabs.get(app)
    return tab !== undefined && tab === source.tabTty(agentId)
  }
  /** The tab of the multiplexer client in the terminal VS Code or Cursor focused last, by that editor, none when the
   *  client names no tab or that terminal is an agent's own: tmux's pane poll reads that client there as a tab app's
   *  reported tab (docs/plans/2026-11-26-dial-mux-host-pages-design.md §7). A focus on any other terminal drops it, as
   *  another app's settle, or none's, does: one at most, as one window has the focus. */
  const editorClients = new Map<string, string | undefined>()
  /** Of the multiplexer clients on [ttys] in [app], those the person may look at: where the app tells which, the one it
   *  told last (the tab a tab app reported selected, none before it reports one; the client in the terminal VS Code or
   *  Cursor focused, none for an agent's own terminal; Orca's told client, none before its watch tells a terminal with
   *  one); elsewhere, and in an editor that told none (no Harness extension, or no terminal focused since it settled),
   *  every one, as before §7, which only adds to it: tmuxFocused follows the one of them tmux lists, none of two. */
  const toldClients = (app: string, ttys: readonly string[]): readonly string[] => {
    if (app === 'orca') return ttys.filter((tty) => tty === orcaClient())
    if (reportsTabs(app)) return ttys.filter((tty) => tty === lastTabs.get(app))
    if (editorClients.has(app)) return ttys.filter((tty) => tty === editorClients.get(app))
    return ttys
  }
  /** Where the dial moved an app lately, a rest's and a tap's alike, each as it started: the echoes an app's report is
   *  checked against, each excusing one. */
  const dialMovesTo = () => {
    let kept: Array<{ id: string; at: number }> = []
    return {
      /** Notes a move as it starts. What it gives dates that note from the move's end instead, while no echo took it: a
       *  slow app shows the move only then, past TAB_ECHO_MS of its start. */
      note(id: string): () => void {
        const sent = { id, at: monotonic() }
        kept = [...kept.filter((other) => sent.at - other.at < TAB_ECHO_MS), sent].slice(-ECHO_KEPT)
        return () => { sent.at = monotonic() }
      },
      /** Whether a report of `id` made at `at` is an echo. The app runs the moves in order, so one before it will see no
       *  echo now (replaced while it waited, or its place already shown): it goes too. */
      echo(id: string, at: number): boolean {
        const found = kept.findIndex((sent) => sent.id === id && at - sent.at < TAB_ECHO_MS)
        if (found >= 0) kept = kept.slice(found + 1)
        return found >= 0
      },
      /** Whether a move made within TAB_ECHO_MS before `at` is not yet seen: the app can still report what it had. */
      unseen(at: number): boolean { return kept.some((sent) => at - sent.at < TAB_ECHO_MS) },
      clear(): void { kept = [] },
    }
  }
  /** The ttys the dial selected lately. */
  const selects = dialMovesTo()
  /** The Orca panes the dial switched to lately. */
  const orcaSwitches = dialMovesTo()
  /** The WezTerm panes and kitty windows the dial focused lately (a tap): a read naming one is its echo. */
  const paneTaps = dialMovesTo()
  /** The dial's own moves, each as it starts: a hand's turn to any agent, a tap, and the pane a rest or a tap's raise
   *  switches. How many, and when the latest started: a settle is set aside by one made within it. */
  let dialMoves = 0
  let dialMovedAt: number | undefined
  const noteMove = (): void => {
    dialMoves++
    dialMovedAt = monotonic()
  }
  /** That adapter, its `show` and its `focus` noting the dial's move as they start: busy or failed, the dial is on that
   *  agent all the same. A hand's turn and a tap are noted as they are made (`turned`, `open`), but a rest switches the
   *  pane 400 ms after its turn, and a tab is raised only once `open -b` brought its app: the app's report of the tab it
   *  had can come between. */
  const noting = (adapter: HostAdapter): HostAdapter => {
    const { show, focus } = adapter
    const noted: HostAdapter = { ...adapter, focus: (pane) => { noteMove(); return focus(pane) } }
    // One with no `show` gets none: the source reads whether it has one (observed.ts rest).
    return show ? { ...noted, show: (pane, agentId) => { noteMove(); return show(pane, agentId) } } : noted
  }
  /** The herdr panes the dial focused lately (a rest, a tap), by herdr's key of each: herdr's event naming one is its
   *  echo. A keeper of their own, not paneTaps: herdr's event is pushed, and no poll's stop or start may drop these. */
  const herdrFocuses = dialMovesTo()
  /** herdr's adapter as the dial's verbs reach it: a tap on an agent herdr lists (below) is the dial's own move too, and a
   *  rest's or a tap's `herdr agent focus` has herdr tell that pane took the focus a moment later, after a slow command's
   *  end too. */
  const herdrNoted = noting({ ...herdrAdapter,
    focus: (pane: Pane) => { const ended = herdrFocuses.note(herdrAdapter.paneKey(pane)); return herdrAdapter.focus(pane).finally(ended) },
    show: (pane: Pane, agentId: string) => {
      const ended = herdrFocuses.note(herdrAdapter.paneKey(pane))
      return herdrAdapter.show!(pane, agentId).finally(ended)
    } })
  /** Herdr's adapter as the dial's verbs reach it: a tap or a rest on an agent hc lists (below) is the dial's own move. */
  const herdrAppNoted = noting(herdrApp)
  /** The cmux surfaces the dial moved to lately (a rest, a tap), by cmux's key of each: cmux's log naming one focused is
   *  its echo. A keeper of their own, not paneTaps: cmux's log is pushed, and no poll's stop or start may drop these. */
  const cmuxFocuses = dialMovesTo()
  /** cmux's adapter as the dial's verbs reach it: a tap or a rest on an agent cmux lists (below) is the dial's own move,
   *  and cmux's link has cmux log that surface's focus a moment later, after a slow link's end too. */
  const cmuxAppNoted = noting({ ...cmuxApp,
    focus: (pane: Pane) => { const ended = cmuxFocuses.note(cmuxApp.paneKey(pane)); return cmuxApp.focus(pane).finally(ended) },
    show: (pane: Pane, agentId: string) => {
      const ended = cmuxFocuses.note(cmuxApp.paneKey(pane))
      return cmuxApp.show(pane, agentId).finally(ended)
    } })
  /** The Claude app's adapter as the dial's verbs reach it, a hooked agent's and a store row's alike: a rest's continue
   *  link is the dial's own move, and the app's attach that follows is its echo. */
  const claudeNoted = noting({ ...claude, show: (pane, agentId) => { noteLink(agentId); return claude.show(pane, agentId) } })
  const codexApp = createCodexAppAdapter({ ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'codex', log, windows })
  /** The ChatGPT app threads the dial opened lately, by id. */
  const codexSwitches = dialMovesTo()
  /** The ChatGPT app's adapter as the dial's verbs reach it: a rest or a tap opens the thread's link, and the app's
   *  window then shows that thread's title, whose report is the dial's own echo. */
  const codexNoted = noting({ ...codexApp,
    show: (pane, agentId) => { codexSwitches.note(pane.id); return codexApp.show(pane, agentId) },
    focus: (pane) => { codexSwitches.note(pane.id); return codexApp.focus(pane) } })
  const codexPane = (threadId: string): Pane => ({ adapter: codexApp.id, id: threadId })
  /** The VS Code and Cursor terminals the dial showed lately, by window and shell. */
  const vscodeShows = dialMovesTo()
  /** VS Code's and Cursor's windows as the dial's verbs reach them: a rest's or a tap's show focuses that terminal, and
   *  its window's report of it is the dial's own echo. */
  const vscodeNoted: typeof vscode = { ...vscode, show: (terminal, tap) => {
    vscodeShows.note(`${terminal.window} ${terminal.shell}`)
    return vscode.show(terminal, tap)
  } }
  /** Each Orca terminal's worktree, by handle, from the latest layout read that landed (below): a rest's or a tap's
   *  switch activates it first. */
  let orcaWorktrees: ReadonlyMap<string, string> = new Map()
  /** The apps an outside agent runs in, in the order its panes are kept: each verb of the dial takes the first that can.
   *  The nearest host first: a multiplexer keeps the environment it started in, so in a tmux pane WezTerm's and Orca's
   *  values name the terminal the tmux server began in, and herdr inside tmux carries tmux's pane. Herdr and cmux come
   *  after tmux, as a tmux inside their terminal is the nearer host, and before the terminals: each tells its programs
   *  they run in Ghostty, whose tabs hold none of them. Zellij is a multiplexer as tmux is, and kitty a terminal as
   *  WezTerm is. */
  // One lookup of tmux and one of zellij, each for the tap, the words and the client lookup (the outer lookups, below).
  const tmuxAt = tmuxFinder()
  const zellijAt = zellijFinder()
  // Kept as built, as kitty and WezTerm are: the focus poll reads its clients (below).
  const tmux = createTmuxAdapter({ run: apps.run, tmux: tmuxAt, processes: readProcessNames, log, front: () => cableHost.latestFront(), platform: apps.platform })
  // One lookup of kitty, for its windows and for the tab holding a multiplexer's client.
  const kittyDeps = { run: apps.run, kitty: kittyFinder(), platform: apps.platform, log, uid: process.getuid?.() ?? -1, socketOwner,
    now: monotonic, socketId }
  const orca = createOrcaAdapter(apps, { worktreeOf: (handle) => orcaWorktrees.get(handle), log, switching: (handle) => orcaSwitches.note(handle) })
  // Kept as built: the focus poll reads them (below).
  const kitty = createKittyAdapter(kittyDeps)
  const wezterm = createWeztermAdapter(apps)
  /** An Orca chat, by its Orca session id: a rest or a tap brings its worktree up, by the worktree id the chat source's
   *  latest read gave (docs/plans/2026-11-23-dial-orca-chats-design.md, decided 7). After Orca's terminals: an agent in an
   *  Orca terminal names its Orca session too, and is that terminal's (orcaChat.ts orcaChatId). A chat's pane comes from
   *  the observed source or the chat source, which are built together below. */
  const orcaChat = createOrcaChatAdapter({ ...apps, worktreeOf: (orcaId) => orcaChats!.worktreeOf(orcaId), log })
  // One lookup of Rex's `rex`, for the tap, the rest, the words, the ring's order and the focus poll (below).
  const rexAt = deps.rex ?? rexFinder()
  // Claude Code's fullscreen read as VS Code's terminals read it, so a stroke on a Rex agent pages it the same way.
  const rex = createRexAdapter({ run: apps.run, rex: rexAt, platform: apps.platform, uid: process.getuid?.() ?? -1,
    front: () => cableHost.latestFront(), log, now: monotonic, fullscreen: claudeFullscreen })
  const rexReads = deps.rexReads ?? createRexReads({ run: apps.run, rex: rexAt })
  const adapters: readonly HostAdapter[] = [herdrNoted, noting(createZellijAdapter({ run: apps.run, zellij: zellijAt, platform: apps.platform })),
    // A rest's or a tap's move of tmux's pane is the dial's own: the poll's read that sees it, a moment after it ends, is
    // its echo.
    noting({ ...tmux,
      focus: (pane: Pane) => { const ended = paneTaps.note(pane.id); return tmux.focus(pane).finally(ended) },
      show: (pane: Pane, agentId: string) => { const ended = paneTaps.note(pane.id); return tmux.show!(pane, agentId).finally(ended) } }),
    // Rex after the multiplexers, which are the nearer host when started in a Rex block, and before the terminals: one
    // started in a Rex block keeps its REX_BLOCK (docs/specs/2026-11-25-dial-rex.md). A rest's or a tap's block focus is
    // the dial's own: the focus poll's read that sees it is its echo, as tmux's.
    noting({ ...rex,
      focus: (pane: Pane) => { const ended = paneTaps.note(pane.id); return rex.focus(pane).finally(ended) },
      show: (pane: Pane, agentId: string) => { const ended = paneTaps.note(pane.id); return rex.show(pane, agentId).finally(ended) } }),
    herdrAppNoted, cmuxAppNoted, ...[
    // A tap's focus is the dial's own move: the poll's read that sees it, a moment after it ends, is its echo.
    { ...kitty, focus: (pane: Pane) => { const ended = paneTaps.note(pane.id); return kitty.focus(pane).finally(ended) } },
    { ...wezterm, focus: (pane: Pane) => { const ended = paneTaps.note(pane.id); return wezterm.focus(pane).finally(ended) } },
    // A rest's or a tap's switch: Orca's focus line for that pane, a moment later, is the dial's own echo.
    { ...orca,
      show: (pane: Pane, agentId: string) => { orcaSwitches.note(orcaHandle(pane.id)); return orca.show(pane, agentId) },
      focus: (pane: Pane) => { orcaSwitches.note(orcaHandle(pane.id)); return orca.focus(pane) } },
    orcaChat,
  ].map(noting), claudeNoted, codexNoted, ...[
    createVscodeAdapter('vscode', { ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'vscode', terminals: vscodeNoted, raise: raise && ((window) => raise.raise(window)), windows }),
    createVscodeAdapter('cursor', { ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'cursor', terminals: vscodeNoted, raise: raise && ((window) => raise.raise(window)), windows }),
    // The VS Code and Cursor terminal holding a multiplexer's client, as the kitty and WezTerm tabs below.
    createVscodeClientAdapter('vscode', { inFront: () => cableHost.latestFront() === 'vscode', terminals: vscodeNoted }),
    createVscodeClientAdapter('cursor', { inFront: () => cableHost.latestFront() === 'cursor', terminals: vscodeNoted }),
    // After Cursor's terminals and tabs: whatever agent in Cursor they do not reach opens its folder's window.
    createCursorFolderAdapter({ run: apps.run, platform: apps.platform, bin: openBin, isFolder, cli: () => cursorFolderCli(cursorExtension), windows }),
    // The WezTerm pane and the kitty window holding a multiplexer's client, as the tabs adapter's tab of Terminal,
    // iTerm2 and Ghostty.
    createWeztermTabAdapter({ ...apps, front: () => cableHost.latestFront() }),
    createKittyTabAdapter({ ...kittyDeps, front: () => cableHost.latestFront(), processes: readProcessNames, tty: readTtyName }),
    { ...createTabsAdapter({
      isOpen: () => tabs.isOpen(),
      select: (tab, raise) => {
        if (!tabs.select(tab, raise)) return false
        selects.note(tab.tty)
        return true
      },
    }), ...tabsTyping({
      line: () => tabs.line(),
      // Asked only in the observed source's own send, so the source is there: the source is built after its adapters.
      shared: (app, tty, pid) => observed!.othersOnTty(app, tty, pid),
      // Asked only for a pane with a proof, which only macOS's ttys give.
      process: deps.tabProcess ?? readTabProcess,
      readers: deps.ttyReaders ?? readTtyReaders,
      // Only pid and ppid are read, but the check lets words into a tty: /bin/ps, never one from the PATH.
      processes: () => readProcessNames((_ps, args, bounds) => runPs([...args], bounds)),
      after: timerIn('tabs'),
    }) },
  ].map(noting)]
  const opener = createOpenActions({ run: apps.run, platform: apps.platform, adapters, log, bin: openBin, raise, windows,
    windowOf: (agentId) => observed?.windowOf(agentId),
    // The app a pick, rest or tap brings from tmux's or herdr's page settles a second later: told first, that settle
    // keeps the page (docs/plans/2026-11-26-dial-mux-host-pages-design.md §6).
    bringing: () => cableHost.dialBrings() })
  const bring = opener.bring
  /** The route or the refusal of the dial's words, and why a queue failed: never the words, the session, the terminal or a
   *  path. */
  const voiced = (what: string): void => log(`[device] voice · ${what}`)
  /** The Claude Code and Codex homes Orca's accounts run in, which Harness has not adopted: the open scan and the dial
   *  skill reach them too (docs/plans/2026-11-17-new-user-onboarding-design.md, "C. Orca homes"). */
  const orcaHomes = deps.orcaHomes ?? orcaHomesCache(monotonic, log)
  // The dial skill in each home an engine's sessions use and the plugins of Claude Code and Codex, set up once a dial has
  // attached on this computer (cable/dialSetup.ts), wherever the devices have their listener: their own process, and on
  // Windows the core's, until Windows services run in their own process (services/inline.ts). Elsewhere inside the
  // core's (`HARNESSD_SERVICES=none`) there is none, so a skill would name a `harness device notify` that cannot ring. A
  // part of its own, so a throw in a person's home is never the dial's, nor the core's; each `claude` and `codex` it runs
  // has its time (devices/claudePlugin.ts, devices/codexPlugin.ts).
  const skill = deps.listen ? createDialSetup({
    dataDir: core.dataDir,
    platform: apps.platform,
    uid: process.getuid?.() ?? -1,
    claudeHome: skillHomes.claude,
    codexHome: skillHomes.codex,
    // Read at each start pass: the adopted homes, and Orca's as its last read gave them.
    adopted: () => {
      const moved = movedEngineHomes()
      const orca = orcaHomes.get()
      return { claude: [...moved.claude, ...orca.claude], codex: [...moved.codex, ...orca.codex] }
    },
    removed: () => readRemoved(core.dataDir),
    // Cloud harnesses are in this view too, and match nothing: their engines are their own (fo, devin-cloud,
    // cursor-cloud).
    claudeAgents: () => deps.agentsRead?.() === false ? 'unknown'
      : core.agents.advertised().some(({ engine }) => engine === 'claude') ? 'listed' : 'none',
    now: monotonic,
    count: createEngineTally('[device] dial setup', ['claude', 'codex'], SETUP_COUNTS, log),
    log,
    claude: deps.claude ?? claudeFound,
    codex: deps.codexFound ?? codexFound,
    orcaClaude: () => ({ homes: orcaHomes.get().claude, answered: orcaHomes.answered() }),
    claudePlugin: deps.claudePlugin ?? { folder: harnessPath('claude-marketplace', homedir()), files: carriedClaudePlugin },
    version: VERSION,
  }) : null
  /** The dial setup's start pass, after a read of Orca's homes: the first, and each that changes them. A read that lands
   *  once the devices stopped starts none. */
  const skillPass = (): void => {
    if (skill && !stopped) part.call('skill', () => skillPassed(skill.started()))
  }
  /** A setup pass settled, done or failed: the dial skill is looked for as that pass left the homes. */
  const skillPassed = (pass: Promise<void>): Promise<void> => pass.finally(() => count((usage) => usage.setupPassed()))
  // Harness's VS Code extension, set up once a computer in VS Code and once in Cursor through the dial setup's record
  // (cable/vscodeExtensionSetup.ts), where the dial setup runs: on Windows the core's process runs the editor's `code`
  // or `cursor` then, each run in its time (devices/vscodeExtension.ts VSCODE_RUN_MS). Each editor's setup a part of
  // its own, so a throw in one editor's files is never the dial's, and a fault or a failed pass's hour in one never
  // holds the other. `HARNESS_VSCODE_BIN` and `HARNESS_CURSOR_BIN`: the end-to-end tests' VS Code and Cursor, so a
  // daemon under test finds none of this computer's own (devices/vscodeExtension.ts).
  const extensionCount = createEngineTally('[device] vscode extension', ['vscode', 'cursor'], SETUP_COUNTS, log)
  const vscodeSetup = skill ? createVscodeExtensionSetup({
    vscode: deps.vscodeExtension ?? vscodeExtensionDeps('vscode', process.env.HARNESS_VSCODE_BIN),
    removed: () => readRemoved(core.dataDir),
    recorded: () => skill.vscode(),
    record: (version) => skill.recordVscode(version),
    after: timerIn('vscodeExtension'),
    count: (kind, reason) => extensionCount('vscode', kind, reason),
  }) : null
  const cursorSetup = skill ? createVscodeExtensionSetup({
    vscode: cursorExtension,
    removed: () => readRemoved(core.dataDir),
    recorded: () => skill.cursor(),
    record: (version) => skill.recordCursor(version),
    after: timerIn('cursorExtension'),
    count: (kind, reason) => extensionCount('cursor', kind, reason),
  }) : null
  // Harness Device's plugin for Orca, set up once a dial has attached here (cable/orcaPluginSetup.ts), where the
  // editors' is: where there is no listener there is none for the plugin to talk to. Each `orca` it runs has its time
  // (devices/orcaPlugin.ts). A part of its own, so a throw in Orca's CLI is never the dial's. `err` says nothing: a
  // folder not written is counted `folder`, and its error's code is never logged. `HARNESS_ORCA_APP_BIN`: the
  // end-to-end tests' Orca (devices/orcaHomes.ts).
  const orcaCount = createEngineTally('[device] orca plugin', ['orca'], SETUP_COUNTS, log)
  const orcaSetup = skill ? createOrcaPluginSetup({
    ...orcaPluginParts({ ...(deps.orcaPlugin ?? { ...orcaPluginRun(), folder: harnessPath('orca-plugin', homedir()) }), dataDir: core.dataDir, err: () => {} }),
    removed: () => readRemoved(core.dataDir),
    connected: () => readOrcaConnected(core.dataDir),
    recorded: () => skill.orca(),
    record: (version) => skill.recordOrca(version),
    recordHeld: (version) => skill.recordOrcaHeld(version),
    after: timerIn('orcaPlugin'),
    count: (kind, reason) => orcaCount('orca', kind, reason),
  }) : null
  /** What the lookups of an agent nested in the person's herdr, tmux or Zellij read: the table, the apps and their bundle
   *  ids. */
  const outerDeps = { run: apps.run, processes: readProcessNames, log, now: monotonic, platform: apps.platform,
    roots: appRoots(homedir()), bundleId: readBundleId }
  /** What herdr's client lookup reads on Windows, which has no `ps` and no ttys: the PTY host's table the maker is read
   *  from, cut to four columns, and the server herdr's marker names, checked against that same table. */
  const herdrWindows: HerdrWindowsDeps | undefined = apps.platform === 'win32' ? {
    processes: () => readWindowsProcesses(listProcesses),
    server: (rows) => herdrMarkerServer(herdrAt.socketPath, rows),
  } : undefined
  /** How the open scan places a session it found in a pane of the person's tmux or herdr, before its first hook: Diego's
   *  idle agents in tmux inside iTerm2 sat on Other's page after the devices started again (2026-11-22). None where the
   *  scan learns no app (Windows has no `ps`): there it lists them as before. */
  const nesting = (): Pick<ObservedDeps, 'table' | 'madeBy' | 'nested'> => {
    if (!scanLearnsApps(apps.platform)) return {}
    // Each host with a lookup by process, and that lookup: the maker's read names only these, so each found has one.
    const lookups: Record<string, NestedLookup> = {
      tmux: createTmuxNested({ ...outerDeps, tmux: tmuxAt }),
      herdr: createHerdrNested({ ...outerDeps, atime: ttyAtime, tty: readTtyName, onPath: apps.onPath, sockets: procSockets }),
    }
    return {
      table: readProcessNames,
      madeBy: (pids, rows) => readMadeBy(pids, rows, readTtyName, Object.keys(lookups)),
      nested: (found, opts) => lookups[found.host](found, opts),
    }
  }
  const observed = env.HARNESS_DEVICE_OBSERVED ? observedSource(core.dataDir, apps.platform, log, orcaHomes, {
    adapters,
    // A session the Claude app's wake still waits for is its mod's too: its copy is listed at its SessionStart, before its
    // mod's first poll, and a voice start then is no "Restart" (observed.ts voiceRefusal); its words wait for the wake's.
    modReady: (sessionId) => inbox.ready(sessionId) || appWake!.waitsFor(sessionId),
    // Words for a session the Claude app's wake still waits for would take its first poll ahead of the wake's: they are
    // words not taken yet (cable/hosts/appWake.ts waitsFor). The wake is built whenever this source is.
    toMod: (sessionId, text) => appWake!.waitsFor(sessionId) ? Promise.resolve('busy' as const) : inbox.deliver(sessionId, text),
    canOpen: opener.can,
    // Noted before `open -b`, which can take a while, and for an app with no pane of its own. A tap on a Claude app agent
    // runs the continue link a rest runs: its attach is the dial's own echo too.
    open: (agentId, target) => {
      noteMove()
      if (target.pane?.adapter === claude.id && opener.can(agentId, target)) noteLink(agentId)
      // A chat Orca's last read did not list (a new chat, or a read that failed) has no worktree to bring up, so its
      // pane is no tap's and Orca comes forward alone (orcaChat.ts): said in fixed words, never its id (Review Focus 5).
      if (!target.pane && observed!.paneOf(agentId, ORCA_CHAT_ADAPTER) !== undefined) log('[device] orca chat · no worktree')
      return opener.open(agentId, target)
    },
    // Words for a ChatGPT thread the wake still opens would be queued ahead of the wake's: they are words not taken yet,
    // as `codex queue` says while it queues the wake's (cable/hosts/appWake.ts waitsFor).
    codexQueue: {
      can: (isApp) => codexQueue.can(isApp),
      send: (threadId, text, isApp, home) =>
        appWake!.waitsFor(threadId) ? Promise.resolve({ outcome: 'busy' as const }) : codexQueue.send(threadId, text, isApp, home),
    },
    // Harness's own records alone: its CODEX_HOME and the homes it adopted, held 1 s, and the profiles the
    // person linked. Orca's Codex homes stay out: Orca's own route types into its terminals.
    codexHomes: trustedCodexHomes(() => codexHomeRoots(env.CODEX_HOME), monotonic),
    claudeHome,
    claudePluginState,
    count: (what) => voiced(countWord(what)),
  }, ttyOf, skill ? (owners) => part.call('skill', () => skill.scanned(owners.values())) : undefined,
  // Only where a hook's address is taken: following another hc session, Herdr's adapter gives its terminals no pane, so
  // a session paired there would be listed twice on Herdr's page.
  hookIds ? (pid): string | undefined => hcSource?.terminalOf(pid) : undefined,
  // An agent in a pane of the person's herdr, tmux or Zellij is seen in the app holding the client that shows it, the
  // app a tap brings forward: on that app's page, and on herdr's or tmux's too (select.ts pagesOf, Diego 2026-11-26).
  // Each lookup answers nothing at once for an agent in none of its panes, and places only one on a terminal its host
  // made, so at most one names an app. herdr's first: with its client in a
  // terminal with no page, a process is kept for the raise when neither other names an app: on Linux the client's own,
  // whose raise finds the window above it; on Windows the terminal's, which owns that window.
  firstOuter(createHerdrOuter({ ...outerDeps, atime: ttyAtime, tty: readTtyName, onPath: apps.onPath, sockets: procSockets,
    windows: herdrWindows }),
    firstOuter(createTmuxOuter({ ...outerDeps, tmux: tmuxAt, tty: readTtyName }),
      createZellijOuter({ ...outerDeps, zellij: zellijAt, tty: readTtyName }))),
  // Windows has no `ps` and no ttys: the PTY host's process table, which the open scan reads too, gives the maker as the
  // first parent past the shells; its read that failed gives no rows, which readWindowsPtyOwner turns into a rejection.
  apps.platform === 'win32' ? (pid) => readWindowsPtyOwner(pid, listProcesses)
    : async (pid) => readPtyOwner(pid, await readProcessNames(), readTtyName), nesting()) : null
  // Orca is asked only for the parts that use its homes, the first time as the devices start: the start pass waits for
  // that read (at most its 5 s), so an Orca home gets the skill with the default one.
  if (skill || observed) void orcaHomes.refresh().then(() => {
    skillPass()
    // After the dial setup's start pass, which reads the record each editor's goes by (dialHomeSetup.ts vscode(),
    // cursor()).
    if (vscodeSetup && !stopped) part.call('vscodeExtension', () => vscodeSetup.pass())
    if (cursorSetup && !stopped) part.call('cursorExtension', () => cursorSetup.pass())
    if (orcaSetup && !stopped) part.call('orcaPlugin', () => orcaSetup.pass())
  })
  /** An open scan, once Orca's homes are read again where the last read is old (at most its 5 s): a session in an account
   *  added since is found by this scan. */
  const scanOpen = async (source: ObservedSource): Promise<void> => {
    if (await orcaHomes.refresh()) skillPass()
    // The dial went, or the devices began to stop, while Orca was read (up to its 5 s): the scan is an attached dial's alone.
    if (stopped || !dialOn) return
    await source.scanOpen()
  }
  /** herdr's agents, hook or no hook, listed and followed over herdr's own socket (docs/specs/2026-11-16-device-herdr.md).
   *  It runs only while a dial is attached, as the open scan does, behind the observed agents' switch, on every platform:
   *  on Windows over herdr's named pipe (herdrClient.ts). */
  const herdr = observed ? new HerdrSource({
    client: herdrClient,
    watch: (changed) => watchSocket(herdrAt, changed),
    prompt: herdrAdapter.prompt,
    held: (paneKey, asker) => observed.holds(paneKey, asker),
    // The command a hooked agent's tap runs (Q6): the dial's move is noted as every tap's is. Only a shown pane is true:
    // herdr's adapter never refuses one, though the noted copy is typed as any adapter's.
    focus: async (paneId) => (await herdrNoted.focus({ adapter: herdrAdapter.id, id: paneId })) === true,
    // The pane herdr says took its focus moves the dial on the page shown (herdrFocused, below).
    onFocus: (paneId) => part.call('herdr', () => herdrFocused(observed, paneId)),
    after: timerIn('herdr'),
    now: Date.now,
    monotonic,
    uuid: randomUUID,
    log,
    count: voiced,
  }) : null
  /** Herdr's agents, hook or no hook, listed and followed over Herdr Core's socket
   *  (docs/plans/2026-11-16-herdr-app-design.md). It runs only while a dial is attached, behind the observed agents'
   *  switch, on macOS alone, where Herdr's window is tried, and only with Herdr installed (dialAttached). */
  const hcSource = observed && apps.platform === 'darwin' ? new HcSource({
    client: hcClient,
    watch: (changed) => watchSocket(hcAt, changed),
    prompt: herdrApp.prompt,
    // Through the opener, as a hooked agent's tap: one bring runs at a time, and a pick waiting is dropped. Noted before
    // it, as the observed source's tap is.
    focus: (address, agentId) => {
      noteMove()
      return opener.open(agentId, { pane: hcPane(address) })
    },
    canShow: (address) => herdrApp.canShow(hcPane(address)),
    // The noted copy keeps the show Herdr's adapter has.
    show: (address, agentId) => herdrAppNoted.show!(hcPane(address), agentId),
    after: timerIn('herdr-app'),
    now: Date.now,
    monotonic,
    uuid: randomUUID,
    log,
    count: voiced,
  }) : null
  /** cmux's stores' folder, ~/.cmuxterm in the daemon's own home: the one cmux reads for the client's runs, which carry
   *  that home and no CMUX_* variable. */
  const cmuxStoresAt = cmuxStoreDir(homedir())
  /** cmux's agents, hook or no hook, listed from cmux's own stores when one changes
   *  (docs/plans/2026-11-17-dial-cmux-design.md). It runs only while a dial is attached, behind the observed agents'
   *  switch, on macOS alone, where cmux runs, and only with cmux installed (dialAttached). */
  const cmuxSource = observed && apps.platform === 'darwin' ? new CmuxSource({
    client: cmuxClient,
    // watchSocket holds the folder of the path it is given: a name in ~/.cmuxterm, none of cmux's, makes it hold that
    // folder, else its parent until it appears.
    watch: (changed) => watchSocket({ socketPath: join(cmuxStoresAt, 'stores'), home: homedir() }, changed),
    events: () => part.call('cmux', () => cmuxRead(false)),
    folder: () => existsSync(cmuxStoresAt),
    stores: () => cmuxStores(cmuxStoresAt),
    alive: pidAlive,
    after: timerIn('cmux'),
    prompt: cmuxApp.prompt,
    // Through the opener, as a hooked agent's tap: one bring runs at a time, and a pick waiting is dropped. Noted before
    // it, as the observed source's tap is.
    focus: (pane, agentId) => {
      noteMove()
      return opener.open(agentId, { pane: cmuxPane(pane) })
    },
    canShow: (pane) => cmuxApp.canShow(cmuxPane(pane)),
    // The noted copy keeps the show cmux's adapter has.
    show: (pane, agentId) => cmuxAppNoted.show!(cmuxPane(pane), agentId),
    now: Date.now,
    monotonic,
    uuid: randomUUID,
    log,
    count: voiced,
  }) : null
  /** cmux's front workspace and the surface focused in it, from cmux's event log in its stores' folder
   *  (docs/plans/2026-11-25-dial-cmux-focus-follow-design.md), where cmux's source runs: read only as cmuxRead says. */
  const cmuxFocus = cmuxSource ? createCmuxFocus({ files: deps.cmuxEvents ?? cmuxLogFiles(), path: join(cmuxStoresAt, CMUX_EVENTS), monotonic, log }) : null
  /** opencode's sessions, listed and followed over its local server (docs/plans/2026-11-17-dial-opencode-design.md). It
   *  runs only while a dial is attached, behind the observed agents' switch, on every platform. It looks for no `opencode`
   *  on PATH: the desktop app runs the service with no CLI installed. */
  const opencodeFolder = dirname(opencodeAt.servicePath)
  const opencodeState = dirname(opencodeFolder)
  // The folder of service.json, else the state folder above it, and none higher: on macOS a watch on ~/.local or the home
  // folder would wake the devices on every write below it. So no state folder that is the home folder or a disk's root,
  // as XDG_STATE_HOME can make it.
  const opencodeFolders = opencodeState === homedir() || opencodeState === dirname(opencodeState) ? [opencodeFolder] : [opencodeFolder, opencodeState]
  const opencode = observed ? new OpencodeSource({
    client: opencodeClient,
    // Set at each attach, so a folder made since is held.
    watch: (changed) => watchNearest(opencodeFolders, changed),
    after: timerIn('opencode'),
    now: Date.now,
    monotonic,
    uuid: randomUUID,
    messageId: opencodeMessageId,
    log,
    count: voiced,
  }) : null
  /** The Claude app's stores, in the person's home: the app's own folders, not a Harness path. */
  const claudeAppRoots = claudeStoreRoots(apps.platform, process.env, homedir())
  /** One for the whole devices process and both apps, every dial's words for a resting Claude app session or ChatGPT app
   *  thread, one at a time, behind the observed agents' switch (docs/plans/2026-11-21-dial-claude-app-wake-send-design.md,
   *  docs/plans/2026-11-23-dial-chatgpt-voice-resting-design.md). */
  const appWake: AppWake | null = observed ? new AppWake({
    // A tap's link and its notes, without the opener's fallback, which brings the app on whatever session it shows. The
    // raw adapter: the noted one would note the move twice.
    open: async (localId, agentId) => {
      noteMove()
      noteLink(agentId)
      return (await claude.focus(claudePane(localId))) === true
    },
    // The observed source runs its listeners unguarded, and the inbox says nothing of one that throws: the wake's go
    // through the part guard, which says what failed.
    observed: {
      list: () => observed.list(),
      send: (agent, text) => observed.send(agent, text),
      onChange: (listener) => observed.onChange(() => part.call('claude-app', listener)),
    },
    onPoll: (listener) => inbox.onPoll((sessionId) => part.call('claude-app', () => listener(sessionId))),
    // Its own part: the timer bounds a ChatGPT thread's wake as well as a Claude app session's.
    after: timerIn('app-wake'),
    // The link alone, never the adapter's forward, which brings the app on whatever thread it shows. The noted adapter
    // notes the dial's own switch, so the title the app then shows is its echo.
    openThread: (threadId, agentId) => codexNoted.show!(codexPane(threadId), agentId),
    queue: codexQueue,
    // The ChatGPT app's threads run in its own home, which its source offers voice for only when it is this one.
    codexHome: env.CODEX_HOME,
    monotonic,
    log,
    count: voiced,
  }) : null
  /** The Claude app's Code sessions, with or without a process, listed from its stores when a file of them changes, in
   *  the store's order, newest first (docs/plans/2026-11-19-dial-claude-app-sessions-design.md). It runs only while a
   *  dial is attached, behind the observed agents' switch, on macOS, Windows and Linux, where the app runs
   *  (docs/plans/2026-11-20-dial-app-sessions-win-linux-design.md). A session with a process is the observed source's
   *  copy, which holds its row while it runs (registry.ts). */
  const claudeAppSource = appWake ? new ClaudeAppSource({
    store: deps.claudeAppStore ?? new ClaudeAppStore(claudeAppRoots.map(({ root }) => root)),
    roots: claudeAppRoots,
    watch: deps.watchStore ?? watchNearest,
    after: timerIn('claude-app'),
    // Through the opener, as a hooked agent's tap: noted before it, and its attach the link's echo.
    focus: (localId, agentId) => {
      noteMove()
      noteLink(agentId)
      return opener.open(agentId, { bundle: APP_BUNDLES.claude, pane: claudePane(localId) })
    },
    canShow: (localId) => claude.canShow(claudePane(localId)),
    // The noted copy keeps the show the Claude app's adapter has.
    show: (localId, agentId) => claudeNoted.show!(claudePane(localId), agentId),
    canLink: (localId) => claude.canLink(claudePane(localId)),
    wake: appWake,
    rank: (rank) => cableHost.setRank('claude', rank),
    monotonic,
    log,
  }) : null
  /** The ChatGPT app's own Codex home, in the person's home: the app's, not the `CODEX_HOME` Harness runs Codex under. */
  const codexAppHome = join(homedir(), '.codex')
  /** Whether Harness's `CODEX_HOME` is that folder. `codex queue` runs under `CODEX_HOME` (cable/hosts/codexQueue.ts):
   *  under another home every queue to an app thread answers thread not found, so its row offers no voice it cannot
   *  give. The path's text, as a live thread's rollout is checked (observed.ts queueable): `relative` resolves both, so
   *  a trailing separator or a `..` is the same folder, and on Windows it ignores case. */
  const codexHomeIsApps = relative(env.CODEX_HOME, codexAppHome) === ''
  /** The ChatGPT app's Codex threads, with or without a process, listed from its metadata when a file of it changes, in
   *  its sidebar's order (docs/plans/2026-11-19-dial-chatgpt-ring-and-follow-design.md). It runs only while a dial is
   *  attached, behind the observed agents' switch, on macOS, Windows and Linux, and only with the ChatGPT app installed
   *  (dialAttached). A thread with a process is the observed source's copy, which holds its row while it runs
   *  (registry.ts). */
  const codexAppSource = appWake ? new CodexAppSource({
    threads: deps.codexAppThreads ?? new CodexAppThreads(codexAppHome),
    watch: (changed) => (deps.watchStore ?? watchNearest)([codexAppHome], changed),
    after: timerIn('codex-app'),
    // Through the opener, as a hooked agent's tap. The noted adapter notes the dial's move, once.
    focus: (threadId, agentId) => opener.open(agentId, { bundle: APP_BUNDLES.codex, pane: codexPane(threadId) }),
    canShow: (threadId) => codexApp.canShow(codexPane(threadId)),
    // The noted copy keeps the show the ChatGPT app's adapter has.
    show: (threadId, agentId) => codexNoted.show!(codexPane(threadId), agentId),
    canLink: (threadId) => codexApp.canLink(codexPane(threadId)),
    // The thread is the app's: its own CLI, else the `codex` a launch would run.
    canQueue: () => codexQueue.can(true),
    inAppHome: codexHomeIsApps,
    wake: appWake,
    rank: (rank) => cableHost.setRank('codex', rank),
    monotonic,
    log,
  }) : null
  /** Orca's chats, with or without a process, read from `orca agent list` (cable/hosts/orcaChatSource.ts,
   *  docs/plans/2026-11-23-dial-orca-chats-design.md): Orca runs a chat itself, on no terminal, so no layout of Orca's and
   *  no hook before its first names it. Behind the observed agents' switch, as a hooked chat is that source's copy; read
   *  only on the pushes below while a dial is attached, never on a timer (decided 3). */
  const orcaChats: OrcaChatSource | null = observed ? new OrcaChatSource({
    binary: () => orcaBinary(apps),
    run: apps.run,
    mtime: apps.mtime,
    heard: () => observed.orcaSessions(),
    // Through the opener with the chat's pane, as a hooked chat's tap: the chat adapter brings its worktree up, then Orca
    // comes forward (decided 7), one way for both copies. Every chat the source lists has its worktree and its Orca id.
    // Noted before it, as the other sources' taps are.
    focus: (agentId) => {
      noteMove()
      return opener.open(agentId, { bundle: APP_BUNDLES.orca, pane: { adapter: ORCA_CHAT_ADAPTER, id: orcaChats!.placed().get(agentId)! } })
    },
    // A rest through the same adapter, which brings the worktree up and leaves Orca where it is. Noted as the adapters'
    // shows are.
    show: (agentId) => {
      noteMove()
      return orcaChat.show({ adapter: ORCA_CHAT_ADAPTER, id: orcaChats!.placed().get(agentId)! }, agentId)
    },
    log,
    now: monotonic,
  }) : null
  const bundleId = deps.bundleId ?? readBundleId
  /** Whether the ChatGPT app is installed: on macOS the first of its places whose bundle has the app's id; on Windows
   *  with no place its Store package; elsewhere the first of its places that is a file. */
  const chatGptInstalled = async (): Promise<boolean> => {
    if (apps.platform === 'darwin') {
      for (const app of chatGptApps) if (await bundleId(app) === APP_BUNDLES.codex) return true
      return false
    }
    if (apps.platform === 'win32' && chatGptApps.length === 0) return (await chatGptPackage.ask()) !== null
    return chatGptApps.some(isFile)
  }
  /** The ones the dial lists, each with its source: the merged list's, not each source's own, as a copy a stronger source
   *  also holds (a Harness agent's session, a hooked agent's pane) is that one's row and must get no second card. */
  const outsideEntries = (): HostEntry[] => registry.entries().filter((entry) => entry.source !== cableHost.harness)
  /** One of them, by the id the dial holds: what the dial asks of it is answered here, never by a door of the core. */
  const outside = (agentId: string): HostEntry | undefined => outsideEntries().find((entry) => entry.agent.id === agentId)
  /** Its line while it waits on the person, where a harness agent shows its terminal's footer: what its permission prompt
   *  asks once its hook said, and the app it is answered in. The dial never answers it. */
  const waiting = ({ agent, source }: HostEntry): string | null => {
    if (agent.state !== 'needs-you') return null
    const host = hostDisplayName(agent.host)
    // Only the observed source hears a hook say what the prompt asks.
    const asks = source === observed && observed.waitingOn(agent.id)
    return asks ? askedLine(asks, host) : `Waiting for you · ${host}`
  }
  /** The line of an id an outside source holds: its wait while the dial lists it, nothing while a stronger source's copy
   *  takes its row. Undefined for any other id, which is the core's to answer. */
  const outsideLine = (agentId: string): string | null | undefined => {
    if (!registry.outside(agentId)) return undefined
    const entry = outside(agentId)
    return entry ? waiting(entry) : null
  }
  /** A window is open (its tabs, not null). */
  let windowOpen = false
  /** The dials hold the window's tab, as before there were agents outside a pane, and hear nothing of them: on the tab, or
   *  on an app's ring that no connected dial shows (an older dial or Harness Pro alone holds the tab). What they do is still
   *  noted, so that only a later change is told once the gate opens. */
  const heldOnTab = (): boolean => windowOpen && (cableHost.holdsTab() || !cable.wantsApps())
  interface ScrollTarget { adapter: HostAdapter; pane: Pane }
  /** What a stroke did while its route was asked, in a fixed size. */
  interface Held { down: boolean; dy: number; velocity: number; up?: number }
  /** Why a stroke no pane and no window takes was skipped, in fixed words: the line that says so names no agent. */
  type Skipped = 'no agent' | 'no pane' | 'cannot scroll' | 'stopping' | 'not on screen'
  /** A stroke dropped said nothing, so a person's "the dial did not scroll" left no trace (eval V13): once per stroke, at
   *  a hand's pace. */
  const skipped = (reason: Skipped): void => { log(`[device] scroll · skipped · ${reason}`) }
  /** Where the dial's scroll goes: the shown agent's pane in the first adapter that can scroll it now
   *  (docs/plans/2026-11-17-dial-herdr-scroll-design.md, §4). A hooked agent's panes first: its copy wins the registry's
   *  dedupe, so the dial holds its id. Then the terminal of one the hc source alone lists, whose row's id the dial holds.
   *  With none, why. */
  const scrollTarget = (): ScrollTarget | Skipped => {
    const agentId = cableHost.shownAgentId()
    if (agentId === undefined) return 'no agent'
    const targets = adapters.flatMap((adapter): ScrollTarget[] => {
      // Rex's also the block its layout placed the agent at by its process (an agent the scan found, with no hook since):
      // that block runs it, which a page key checks again (rex.ts pageKeys). A held block's id is refused by canScroll.
      const id = adapter.scroll && (observed?.paneOf(agentId, adapter.id) ?? (adapter.id === rex.id ? observed?.shownAt(agentId, rex.id) : undefined))
      return id ? [{ adapter, pane: { adapter: adapter.id, id } }] : []
    })
    const address = hcSource?.paneOf(agentId)
    if (address !== undefined) targets.push({ adapter: herdrAppNoted, pane: hcPane(address) })
    if (targets.length === 0) return 'no pane'
    return targets.find(({ adapter, pane }) => adapter.canScroll?.(pane)) ?? 'cannot scroll'
  }
  /** A stroke that goes to its app's pane, line by line. `page`: its guard said the program there takes its own page
   *  keys, so its lines carry them too. */
  type ToPane = ScrollTarget & { lines: ReturnType<typeof createScrollLines>; page: boolean }
  /** Where a stroke no app's pane takes goes. Harness's windows only while the dial holds the window's tab or shows a
   *  Harness agent: they do not show another app's agent, and Desktop raises its window on a stroke's `down`, so a stroke
   *  there on another app's agent brought Harness forward over that app
   *  (docs/plans/2026-11-18-dial-pick-focus-back-design.md). */
  type OffPane = 'windows' | 'nowhere'
  const offPane = (): OffPane => {
    const shown = cableHost.shownAgentId()
    return heldOnTab() || (shown !== undefined && !cableHost.isOutside(shown)) ? 'windows' : 'nowhere'
  }
  /** The route the stroke on the glass took at its `down`, kept to its `up`: Harness's windows are never left holding a
   *  drag whose `up` went elsewhere. A `move` or an `up` with no `down` before it chooses then. While its app is asked
   *  whether the pane is on screen, or whether Claude Code there takes its page keys, the stroke is held: only the
   *  window knows which terminal it shows, and Herdr's answer took 0.04 s; the page guard answers within 500 ms.
   *  `otherwise` is where it goes if its pane is not on screen, read at its `down` as the rest of its route. */
  let stroke:
    | ToPane
    | { deciding: ScrollTarget; held: Held; otherwise: OffPane }
    | OffPane
    | undefined
  const toWindows = (phase: 'down' | 'move' | 'up', dy: number, velocity: number): void =>
    core.clients.sendLocal({ type: 'dial_scroll', payload: { phase, dy, velocity } })
  /** Lines to the stroke's pane. A page stroke reads its agent again first: once it waits on the person a key could
   *  land in the prompt, so the rest of the stroke is lines alone. */
  /** The live agent at a stroke's pane: its own, or, in Rex, the agent its layout placed at that block by its process
   *  (scrollTarget), which no hook has named yet. */
  const strokeAgent = ({ adapter, pane }: ScrollTarget): HostAgent | undefined => observed?.byPane(adapter.id, pane.id)
    ?? (adapter.id === rex.id ? observed?.list().find(({ id }) => observed.shownAt(id, rex.id) === pane.id) : undefined)
  const toPane = (route: ToPane, phase: 'down' | 'move' | 'up', dy: number): void => {
    if (route.page && strokeAgent(route)?.state === 'needs-you') route.page = false
    route.adapter.scroll!(route.pane, route.lines.take(phase, dy), route.page)
  }
  /** What a stroke on that target waits on at its down: Herdr's whether its pane is on screen (its lines, or off screen:
   *  the stroke's `otherwise`), or whether the shown Claude Code takes its page keys (page, or lines). None when the
   *  stroke is lines at once: any other engine, or a guard that refused with nothing read. A refused guard is the pane's
   *  lines, never the windows: the person looks at that terminal, and its line scroll is what moved it before. */
  const routeOf = ({ adapter, pane }: ScrollTarget): Promise<'page' | 'lines' | 'offScreen'> | undefined => {
    if (adapter.onScreen) return adapter.onScreen(pane).then((visible) => (visible ? 'lines' : 'offScreen'))
    const agent = strokeAgent({ adapter, pane })
    if (agent?.engine !== 'claude') return undefined
    const keys = adapter.pageKeys?.(pane, {
      asking: agent.state === 'needs-you', cwd: observed?.startedIn(agent.id), transcriptPath: observed?.transcriptOf(agent.id),
    })
    return keys ? keys.then((page) => (page ? 'page' : 'lines')) : undefined
  }
  /** The app's answer, page, lines or off screen (the stroke's `otherwise`), for the stroke that asked it alone: one left
   *  behind by a newer stroke, or one that lands once the devices began to stop (the dial still sends while the stop
   *  awaits its listener), is dropped, so nothing of that stroke is sent anywhere. A stroke already decided keeps its
   *  route through the stop: a window that heard its down hears its up. */
  const decided = (asked: { deciding: ScrollTarget; held: Held; otherwise: OffPane }, to: 'page' | 'lines' | 'offScreen'): void => {
    if (stroke !== asked) return
    if (stopped) {
      skipped('stopping')
      return
    }
    const { deciding: { adapter, pane }, held } = asked
    if (to !== 'offScreen') {
      // The travel held meanwhile goes as lines at once; what follows goes line by line.
      const route = { adapter, pane, lines: createScrollLines(), page: to === 'page' }
      stroke = held.up === undefined ? route : undefined
      toPane(route, 'move', held.dy)
      return
    }
    stroke = held.up === undefined ? asked.otherwise : undefined
    if (asked.otherwise === 'nowhere') {
      skipped('not on screen')
      return
    }
    // A hand's pace, and no address: once per stroke whose pane was not on screen.
    log(`[device] scroll · ${adapter.id} · not on screen`)
    if (held.down) toWindows('down', 0, 0)
    if (held.dy !== 0) toWindows('move', held.dy, held.velocity)
    if (held.up !== undefined) toWindows('up', 0, held.up)
  }
  const routeScroll = (phase: 'down' | 'move' | 'up', dy: number, velocity: number): void | Promise<void> => {
    let route = stroke
    let answer: Promise<void> | undefined
    // A held up ended its stroke too: a frame after it begins a new one, and the older answer is stale.
    if (phase === 'down' || !route || (typeof route === 'object' && 'held' in route && route.held.up !== undefined)) {
      // An older stroke held for its page guard is its pane's lines whatever the answer (routeOf): what it held goes out
      // now, with no page, as the answer it waited on is left behind. One held for Herdr's on screen may be off screen.
      if (typeof route === 'object' && 'held' in route && !route.deciding.adapter.onScreen && !stopped) {
        toPane({ ...route.deciding, lines: createScrollLines(), page: false }, 'move', route.held.dy)
      }
      // Once the devices began to stop, no app is asked or run: a stroke then takes no pane.
      const target = stopped ? 'stopping' : scrollTarget()
      const to = typeof target === 'object' ? routeOf(target) : undefined
      if (typeof target !== 'object') {
        route = stroke = offPane()
        // The frame that chose the route: the stroke's later frames say nothing more.
        if (route === 'nowhere') skipped(target)
      } else if (to) {
        const asked = { deciding: target, held: { down: false, dy: 0, velocity: 0 }, otherwise: offPane() }
        route = stroke = asked
        answer = to.then((answered) => decided(asked, answered))
      } else route = stroke = { ...target, lines: createScrollLines(), page: false }
    }
    if (typeof route === 'object' && 'held' in route) {
      route.held.dy += dy
      if (phase === 'down') route.held.down = true
      if (phase === 'move') route.held.velocity = velocity
      if (phase === 'up') route.held.up = velocity
      // The answer's chain, so a throw on its path is the part's too.
      return answer
    }
    if (phase === 'up') stroke = undefined
    if (route === 'windows') toWindows(phase, dy, velocity)
    // Whole lines, and an up's velocity is not played: the scroll stops where the finger stops. An app that went takes
    // nothing more of the stroke, which never turns to Harness's windows midway, and none once the devices began to stop.
    else if (route !== 'nowhere' && !stopped) toPane(route, phase, dy)
  }

  const cableHost = new DaemonCableHost({
    // The cloud harnesses too, where the core offers them: tiles on the desk the dial walks like any other.
    sessions: () => [...core.agents.advertised(), ...core.agents.cloud?.() ?? []],
    scanLearnsApps: scanLearnsApps(apps.platform),
    refresh,
    displayName: (session) => core.agents.displayName(session),
    appFocus: () => focus.voice ?? undefined,
    activityText: async (agentId) => {
      const line = outsideLine(agentId)
      return line === undefined ? core.agents.activityText(agentId) : line
    },
    // The footer and its timer from the core; the agent's own latest sentence from the cards already seen here.
    activitySnapshot: async (agentId) => {
      const line = outsideLine(agentId)
      if (line !== undefined) return line ? { text: line } : null
      const reading = core.agents.activitySnapshot
        ? await core.agents.activitySnapshot(agentId)
        : await core.agents.activityText(agentId).then((text) => text ? { text } : null)
      const action = latestUpdate.get(agentId)
      return reading && action ? { ...reading, action } : reading
    },
    machineName: () => core.machine.name(),
    machineId: () => core.machine.id(),
    computerId: () => core.machine.computerId(),
    signedIn: () => core.account.signedIn(),
    accessToken: (opts) => core.account.accessToken(opts),
    environment: () => core.account.environment(),
    transcribe: deps.transcribe,
    watching: (on) => {
      core.clients.dialWatching(on)
      // Before the scan the attach starts, so that scan finds the dial recorded; and before each editor's pass, which
      // reads it.
      if (on && skill) part.call('skill', () => skillPassed(skill.attached()))
      if (on && vscodeSetup) part.call('vscodeExtension', () => vscodeSetup.pass())
      if (on && cursorSetup) part.call('cursorExtension', () => cursorSetup.pass())
      if (on && orcaSetup) part.call('orcaPlugin', () => orcaSetup.pass())
      const reads = dialAttached(on)
      part.call('dialStream', () => dial.attached(on))
      // Whether an agent outside a pane runs first: an attach with one starts the first-agent clock at once, and a Harness
      // agent starts it at the list's read that follows (refresh).
      count((usage) => {
        usage.agentsPresent(outsideRunning())
        usage.attached(on)
      })
      return reads
    },
    dialShows: (agent) => {
      part.call('dialStream', () => dial.shows(agent))
      count((usage) => usage.shown(cableHost.shownAgentId() ?? null))
    },
    // The core's own doors for a local agent. The fleet's router reaches them the same way; the dial uses
    // these only when it routes by itself, with the fleet off. An agent outside a pane never reaches them: the host shuts
    // each to it, the fleet's way too (cableHost.ts `outside`).
    sendTurn: (agentId, text) => core.turns.send(agentId, text),
    stopTurn: (agentId) => core.turns.stop(agentId),
    answer: (agentId, requestId, answers) => core.questions.answer(agentId, requestId, answers),
    answerReviewed: (answer) => core.questions.answerReviewed(answer),
    // Told by the host for each answer on the dial, the fleet's route too, which never reaches the doors above.
    answered: (agentId, requestId) => count((usage) => {
      usage.used()
      usage.answeredOnDial(questionWait(agentId, requestId))
    }),
    recent: (agentId, n) => core.turns.recent(agentId, n),
    recentAsks: (agentId) => core.turns.asks(agentId),
    runtimeProfile: (session) => core.agents.runtimeProfile(session),
    updateAgent: (agentId, model, effort) => core.agents.setRuntime(agentId, model, effort),
    listModels: async (agentId) => core.agents.runtimeModels(agentId),
    // Each of these is for the windows on this computer alone: they describe a hand at this desk, not a
    // change in what the machine is doing, and the cloud web audience may be sitting at another computer.
    // A notification tap asks for a tile of its OWN (see CableHost.openAgent). `reason` rides along only
    // when the dial gave one ('question'): the window then brings the agent forward rather than opening a
    // tab, and an older window that does not know the field opens one as before.
    opened: (machineId, agentId, reason) =>
      core.clients.sendLocal({ type: 'dial_open', payload: { machineId, agentId, ...(reason ? { reason } : {}) } }),
    // A person's tap on an agent, a notice's "In <app>" among them, is use of the dial, and the person answering on the dial
    // what that agent waits on: the card the dial shows of it. That card stays on the dial's face of that agent until the
    // agent closes it.
    tapped: (agentId) => count((usage) => {
      usage.used()
      usage.tapped(agentId)
      const card = notices.shown(agentId)
      if (card) usage.waitEnded(noticeWait(agentId, card), 'answered')
    }),
    noticeFrom: (agentId) => notices.from(agentId),
    newsKept: (agentId) => notifyMode.get() !== 'you' || failedLast.has(agentId),
    // A caller no list holds has no face on the dial to ask on, and with no session its next turn is never heard: kept,
    // its card would stay pinned until the devices restart. The tap is that card's end, as its leaving would be. Only a
    // card its notice found no list for (`who`): a router that has read no list yet, as while the fleet is unavailable,
    // finds no machine for a Harness agent either, whose card waits for its agent to close it.
    tappedUnlisted: (agentId) => part.call('notices', () => notices.tapped(agentId)),
    // The notices and the waits are questions only the devices ask: what is unread replaces the dial's whole drawer,
    // which holds them too.
    noticeRows: () => {
      const machineId = core.machine.id()
      return [...notices.rows(machineId),
        ...[...shown].map(([agentId, { line }]) => ({ agentId, machineId, question: true, text: line }))]
    },
    notificationRead: (machineId, agentId, readToken) =>
      core.clients.sendLocal({ type: 'dial_notification_read', payload: { machineId, agentId, readToken } }),
    forked: (machineId, agentId, sourceAgentId) => core.clients.sendLocal({ type: 'dial_forked', payload: { machineId, agentId, sourceAgentId } }),
    // The dial's Fork: the same path the window's `agent_fork` takes, then `forked` above lands on it.
    forkAgent: (agentId) => core.agents.fork(agentId),
    focused: (machineId, agentId) => core.clients.sendLocal({ type: 'dial_focus', payload: { machineId, agentId } }),
    // The outcome only: never the agent, its session or its terminal.
    swiped: (outcome) => log(`[device] swipe · ${outcome}`),
    // A hand's turn alone: the session drops a greet's own focus and a landing's echo before this.
    turned: () => {
      noteMove()
      count((usage) => usage.used())
    },
    localFollowed: (cause, outcome) => {
      // The latest follow is the person's latest move: a chat's prompt still waiting for Orca's list is older.
      if (cause !== 'prompt') chatPrompt = undefined
      log(FOLLOWED[cause === 'attach' ? attachAsk : cause][outcome])
    },
    swarmSelected: (swarmId) => core.clients.sendLocal({ type: 'dial_swarm', payload: { swarmId } }),
    // Guarded as a notice into the dial is: a throw on the scroll path (a window's stream) is logged, never the session's.
    scrolled: (phase, dy, velocity) => {
      // A stroke is use once, at its start: its moves come many a second.
      if (phase === 'down') count((usage) => usage.used())
      part.call('dial', () => routeScroll(phase, dy, velocity))
    },
    // Gestures stay at this desk. The device inventory and its settings also reach the owner's other
    // machines, through the encrypted device-management event.
    dialStatus: (status) => {
      revision++
      sayStatus(status)
      core.clients.devicesChanged({ status, revision })
    },
    // Words spoken on the overview belong to whichever agent the window's palette picks.
    routeInWindow: (text, cmd) => windowRouter.ask(text, cmd),
    selectPassage: (command) => windowSelection.command(command),
    clearSelection: () => windowSelection.cancel(),
    visit: (command) => windowVisit.command(command),
    clearVisit: () => windowVisit.cancel(),
    form: (command) => windowForm.command(command),
    clearForm: () => windowForm.clear(),
    log: (line) => log(`[cable] ${line}`),
    // Which machine an agent is on, and getting there: the fleet's router, guarded. Null when it never
    // started; a member that fails answers "unavailable", and the host routes this computer by itself.
    fleet: () => fleet,
    pets: () => pets,
    // The app a dial that says appFilter shows (cable/hosts/appFilter.ts). Each line is a measure, read from the log as the
    // notify tally is: a cause, never the app or an agent.
    appSwitched: (cause) => {
      log(`[device] app filter: switched · ${cause}`)
      // After the list read that found it (an app emptying is found inside one), never from within it: the new ring goes
      // to every dial, and its agents mid-turn, which the dial has heard nothing of, are told again.
      queueMicrotask(() => {
        part.call('dial', () => cable.syncAgents())
        part.call('dial', remind)
      })
    },
    // The settle of the app in front: the Claude app's turns the dial to the session it last attached
    // (docs/specs/2026-11-15-dial-claude-app-follow.md), and any app's judges the tab report waiting on it. Each
    // guarded on its own: the filter drops what this answers, so a follow that rejects would go unseen, and one that throws
    // would cost the other its settle.
    appSettled: (app) => {
      if (app === 'claude') part.call('dial', claudeSettled)
      if (app === 'orca' && observed) part.call('orca', () => orcaSettled(observed))
      // Orca in front is where its chats matter, and where the person may just have made one (decided 3).
      if (app === 'orca' && orcaChats) part.call('orca-chat', () => readChats(orcaChats))
      // Orca is often not running at the start or the attach: its coming to the front is the pass's next chance.
      if (app === 'orca' && orcaSetup) part.call('orcaPlugin', () => orcaSetup.pass())
      // Behind another app cmux's log was not read: the read as cmux comes forward catches up.
      if (app === 'cmux') part.call('cmux', () => cmuxRead(true))
      part.call('dial', () => tabSettled(app))
      part.call('dial', () => threadSettled(app))
      part.call('dial', () => editorSettled(app))
      // Before the poll reads it: the person coming back to an app is on whichever tab its next report names, or
      // terminal its next focus does.
      part.call('dial', () => {
        for (const tabApp of lastTabs.keys()) if (tabApp !== app) lastTabs.delete(tabApp)
        for (const editor of editorClients.keys()) if (editor !== app) editorClients.delete(editor)
      })
      part.call('pane', () => {
        paneFocusFailing = false
        placeFails.clear()
        checkPaneFocus()
      })
    },
    appPicked: () => {
      count((usage) => usage.used())
      log('[device] app filter: picker')
    },
    // A pick that leaves the dial's ring as it was says why in fixed words (PM, 2026-11-20): the answer only, never the app.
    appPickKept: (answer) => log(`[device] app filter: pick · ${answer}`),
    // A pick on the dial brings its app to the front, on macOS and, through their raise, on Linux and Windows
    // (docs/plans/2026-11-16-dial-pick-brings-app-design.md).
    // A measure: the outcome, never the app; a pick with nothing to bring, or replaced by a later one, ran nothing.
    appBrought: bring && ((app) => {
      void bring(app).then((outcome) => { if (outcome) log(`[device] app filter: bring · ${outcome}`) })
    }),
    // A pick of tmux's or herdr's page brings the landed agent's app: the same measure, with `none` when no agent there
    // has one (docs/plans/2026-11-26-dial-mux-host-pages-design.md, Measures).
    appPickBrought: (outcome) => log(`[device] app filter: bring · ${outcome}`),
    appDialFront: () => log('[device] app filter: front · dial'),
    // A tap on a Harness agent with no window starts Desktop, on macOS and, through its launcher, on Windows
    // (docs/specs/2026-11-15-device-wave1-checks.md, F2).
    launchDesktop: opener.desktop,
    // A measure: the app's name only.
    desktopTimedOut: () => log('[device] open · harness · no window'),
    voiceEnded: (end) => count((usage) => usage.voiceEnded(end)),
    openEnded: (agentId, end) => count((usage) => usage.opened(agentId, end)),
    // With a window open, the tab or the shown app's ring: a measure as `switched` is, a view and a cause, never an app.
    // After the list read that can turn it, as a switch: every dial gets its tabs and list at once, the outside agents'
    // questions are asked or closed by the gate, and on a ring its agents mid-turn are told again.
    appView: (view, cause) => {
      log(`[device] app filter: view ${view} · ${cause}`)
      queueMicrotask(() => {
        part.call('dial', () => cable.viewChanged())
        part.call('dial', showWaits)
        if (view === 'apps') part.call('dial', remind)
      })
    },
    // The settle of the app in front: a filter that throws costs the devices nothing, and the devices stopping cancels it.
    appTimer: timerIn('dial'),
  })
  // What the dial lists with no window, or with one in the apps view: this computer's harness agents, and the ones outside
  // a pane unless switched off.
  const registry = new HostRegistry([cableHost.harness, observed, herdr, hcSource, cmuxSource, opencode, claudeAppSource, codexAppSource, orcaChats].filter((source) => source !== null))
  cableHost.setRegistry(registry)
  // The dial's log lives with the app's, one file a day (dialLog.ts). The old unbounded `dial.log` in the
  // data folder is cut down to a pointer, for anyone with a bookmark.
  const legacyDialLog = join(core.dataDir, 'dial.log')
  if (existsSync(legacyDialLog)) {
    try { writeFileSync(legacyDialLog, `moved to ${join(deps.logsDir, 'dial-YYYYMMDD.log')}\n`) } catch { /* best effort */ }
  }
  const cable = new CableFleet(deps.Session ?? CableSession, cableHost, deps.logsDir, DialLog, {
    serials: deps.dialSerials,
    verdicts: new DialVerdicts(dialPorts),
    faults: deps.faults,
    ...testDialDiscovery(deps.testDialPort),
    ...deps.cable,
  })

  /** What the turn's shell results add up to (tests, commits), told to the dial just before the turn ends. */
  const stats = new TurnStats()

  const readUsage = deps.readUsage ?? (async (agentId: string) => {
    const usage = await core.usageFresh?.(agentId)
    return usage ? { input: usage.inputTokens, cached: usage.cachedTokens, output: usage.outputTokens } : null
  })
  type Reading = { input?: number; cached?: number; output?: number } | null
  /** Each agent's reading from when its turn started, until the turn ends. */
  const starts = new Map<string, Promise<Reading>>()
  /** When each agent's turn began (the first `processing`), for the summary's duration and whether the person is with it. */
  const began = new Map<string, number>()
  /** The turn that just ended, kept for the `summary` that follows its `done`. */
  const ended = new Map<string, { durationS: number | null; stats: TierInput['stats'] }>()
  const TOKENS_WAIT_MS = 2000
  const MAX_TOKENS = 50_000_000
  const settle = (p: Promise<Reading>): Promise<Reading> => p.catch(() => null)
  /** Input without cache reads (the usage cache's inputTokens includes them; cache creation stays, it is new
   *  input). Unknown when cached is, so an inflated number is never shown. */
  const fresh = (r: Reading): number | undefined =>
    typeof r?.input === 'number' && typeof r.cached === 'number' ? r.input - r.cached : undefined
  const diff = (a: number | undefined, b: number | undefined): number | undefined =>
    typeof a === 'number' && typeof b === 'number' && b - a >= 0 && b - a <= MAX_TOKENS ? b - a : undefined
  /** The tokens this turn used: the end reading minus the start one, or nothing when either is missing, the
   *  difference is out of range, or the fresh read takes over 2 s (the turn's end never waits longer). */
  const turnTokens = async (agentId: string, start: Promise<Reading>): Promise<Pick<TurnStatsFields, 'tokensIn' | 'tokensOut'>> => {
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const [from, to] = await Promise.race([
        Promise.all([settle(start), settle(readUsage(agentId))]),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), TOKENS_WAIT_MS) }),
      ]) ?? [null, null]
      const tokensIn = diff(fresh(from), fresh(to)), tokensOut = diff(from?.output, to?.output)
      return { ...(tokensIn === undefined ? {} : { tokensIn }), ...(tokensOut === undefined ? {} : { tokensOut }) }
    } finally { clearTimeout(timer) }
  }

  // ── whether the person is with an agent (docs/plans/2026-11-26-needs-you-right-design.md, Part 2) ────────────
  //
  // Read from what the devices already hold, with no wait. Anything unknown is not present, and rings as before.
  /** Each outside agent's last prompt by the person, or by the dial for them, on the monotonic clock, oldest first. */
  const prompted = new Map<string, number>()
  /** At most PRESENT_MS before [now], and not after it: a wall clock set back since reads not present. */
  const recent = (at: number | undefined, now: number): boolean => at !== undefined && at <= now && now - at <= PRESENT_MS
  /** The person prompted it lately, its own app is known and is the one in front, and the dial that moved last shows it:
   *  of five agents in one app, only the one the person is on. */
  const outsidePresent = ({ agent }: HostEntry): boolean => recent(prompted.get(agent.id), monotonic())
    && !agent.appPending && agent.app !== UNKNOWN_APP && cableHost.latestFront() === agent.app
    && cableHost.shownAgentId() === agent.id
  /** Its turn began lately and its tile is on the window in front: who started that turn only the core knows. Not from a
   *  yes to its stop until its continuation ends (Part 5, nudgeHolds). [at]: that turn's start, the one under way's unless
   *  given (presentAtStop). */
  const harnessPresent = (agentId: string, at = began.get(agentId)): boolean =>
    !nudgeHolds(agentId) && recent(at, Date.now()) && alreadyOnScreen(agentId)
  /** Whether the person is with that agent now. An id no outside row holds takes the Harness rule, so a caller no list
   *  holds, with no turn and no tile, never is. */
  const present = (agentId: string): boolean => {
    const entry = outside(agentId)
    return entry ? outsidePresent(entry) : harnessPresent(agentId)
  }

  // ── whether an agent rang the dial in this turn (docs/plans/2026-11-26-needs-you-right-design.md, Part 5) ─────────────
  //
  // A turn that ends on a question gets a second look only when its agent rang no notice in it. The turn starts at its
  // mark: a Harness agent's first card of a turn, as who started that turn only the core knows (dispatch), and an outside
  // agent's prompt by the person or the dial (port.observed). Neither `began` nor `prompted` can say it: an outside
  // agent's `began` starts again at another session's message, and `prompted` is deleted by one. Nor can a pending card:
  // it may be left from an earlier turn.
  /** At most this many agents, the oldest out first: one id each, no time and no text. */
  const RANG_MAX = 64
  /** The agents that ran `harness device notify` since their turn's mark. */
  const rangThisTurn = new Set<string>()
  /** It rang, whatever the notice desk answered: shown, limited or no dial. */
  const noteRang = (agentId: string): void => {
    rangThisTurn.delete(agentId)
    rangThisTurn.add(agentId)
    if (rangThisTurn.size > RANG_MAX) rangThisTurn.delete(rangThisTurn.values().next().value as string)
  }
  /** Its turn's mark, or it left (session-end, agent_deleted): what it rang before is not this turn's. */
  const clearRang = (agentId: string): void => { rangThisTurn.delete(agentId) }

  // ── once an agent (docs/plans/2026-11-26-needs-you-right-design.md, Part 5) ─────────────────────────────────────────────
  //
  // A yes holds that agent's next one back until the person's next prompt to it (an outside agent's prompt by the person
  // or the dial, never a relayed one), it leaves, or NUDGE_ONCE_MS: an engine or version that does not set
  // `stop_hook_active` on the continuation is still stopped once. A Harness agent reads as away from the yes until its
  // continuation ends: `began` alone cannot tell, as the continuation's first card starts a new one, and who started a
  // Harness agent's turn only the core knows. Its continuation's cards are told by phase: `asked` at the yes, `continuing`
  // from its next card, `over` at that one's end, when the once rule alone still holds. The phase is bounded as the
  // outside hold is (observed.ts holdOn): a block the engine never took (its hook killed at its timeout) starts no
  // continuation, so `asked` is over with no card CONTINUE_QUIET_MS after the yes, or after a done heard since (Codex ends
  // its turn after its Stop hook), and no continuation lasts past CONTINUE_MAX_MS from the yes. Whether the person is with
  // a Harness agent at its stop is read from its turn under way, or from the one just ended: Claude Code's reader ends the
  // turn at end_turn, before its Stop hook runs, and the report comes after that done (lastBegan).
  /** At most this many agents, the oldest out first. */
  const NUDGED_MAX = 64
  /** How long a yes holds the next one back with no prompt of the person's. */
  const NUDGE_ONCE_MS = 600_000
  /** The agents said yes to: when (monotonic), how far a Harness agent's continuation has come, when it was last heard of
   *  while asked (its yes, or a done since), the engine said yes to, and whether that yes may still count a notice rung as
   *  its ring (rangInContinuation). */
  const nudgedAgents = new Map<string, { at: number; phase: 'asked' | 'continuing' | 'over'; heard: number; engine: NudgeAsk['engine']; counts: boolean }>()
  /** Its yes while the once rule holds, its phase as far as its bounds let it come. */
  const nudgeOf = (agentId: string) => {
    const entry = nudgedAgents.get(agentId)
    const now = monotonic()
    if (!entry || now - entry.at >= NUDGE_ONCE_MS) return undefined
    if (now - entry.at >= CONTINUE_MAX_MS || (entry.phase === 'asked' && now - entry.heard >= CONTINUE_QUIET_MS)) entry.phase = 'over'
    return entry
  }
  const noteNudged = (agentId: string, engine: NudgeAsk['engine']): void => {
    nudgedAgents.delete(agentId)
    const at = monotonic()
    nudgedAgents.set(agentId, { at, phase: 'asked', heard: at, engine, counts: true })
    if (nudgedAgents.size > NUDGED_MAX) nudgedAgents.delete(nudgedAgents.keys().next().value as string)
  }
  /** The person's next prompt to it, or it left: its next ask may get a yes. */
  const clearNudged = (agentId: string): void => { nudgedAgents.delete(agentId) }
  /** From a yes until its Harness continuation ends: the person reads as away. */
  const nudgeHolds = (agentId: string): boolean => {
    const phase = nudgeOf(agentId)?.phase
    return phase === 'asked' || phase === 'continuing'
  }
  /** A Harness agent's card after its yes: its continuation is under way. An outside agent's is held by its source. */
  const nudgeContinues = (agentId: string): void => {
    const entry = nudgeOf(agentId)
    if (entry?.phase === 'asked' && !outside(agentId)) entry.phase = 'continuing'
  }
  /** Its continuation's end: the person reads as before from here. Still asked, it is the stop's own done: the
   *  continuation's first card may still come. */
  const nudgeOver = (agentId: string): void => {
    const entry = nudgeOf(agentId)
    if (entry?.phase === 'continuing') entry.phase = 'over'
    else if (entry?.phase === 'asked') entry.heard = monotonic()
  }
  /** A Harness agent's notice rang: the engine of its yes, the first time only, while that yes's continuation lasts. */
  const rangInContinuation = (agentId: string): NudgeAsk['engine'] | undefined => {
    const entry = nudgeOf(agentId)
    if (!entry?.counts || !nudgeHolds(agentId)) return undefined
    entry.counts = false
    return entry.engine
  }
  /** The start of each Harness agent's turn that ended, from its done until its next turn's first card or it leaves. */
  const lastBegan = new Map<string, number>()
  const noteEnded = (agentId: string, at: number): void => {
    lastBegan.delete(agentId)
    lastBegan.set(agentId, at)
    if (lastBegan.size > NUDGED_MAX) lastBegan.delete(lastBegan.keys().next().value as string)
  }
  /** Whether the person is with the agent that stopped. */
  const presentAtStop = (agentId: string): boolean => {
    const entry = outside(agentId)
    return entry ? outsidePresent(entry) : harnessPresent(agentId, began.get(agentId) ?? lastBegan.get(agentId))
  }

  /** The agents whose done decided a rouse that waits for the turn's tokens: one whose next turn starts meanwhile, the
   *  person's answer most likely, is not roused, and its card stays quiet for that turn's end. Each goes as its done
   *  finishes or its next turn starts, so it holds at most the agents whose done waits. */
  const rousing = new Set<string>()
  /** A finished turn the dial rang or listed, for the value counts: a silent one told the person nothing. */
  const announced = (agentId: string, tier: Tier): void => {
    if (tier !== 'silent') count((usage) => usage.turnAnnounced(agentId))
  }
  /** One card for the dial, in its four calls. A remote machine's and this computer's are the same calls,
   *  so a new kind of card lands on both the day it lands on either. [notice]: its agent held a card as the card came
   *  (toDial). */
  const dispatch = (event: DialEvent, notice: boolean): void | Promise<void> => {
    if (event.kind !== 'processing') latestUpdate.delete(event.agentId)
    // A turn starting or ending says whether its agent's last one failed; a sub-agent's or a restored card is not its turn.
    if (event.kind !== 'done' && !event.subagent) noteTurn(event.agentId, event.kind === 'error' || event.failed === true)
    if (event.kind === 'processing') {
      if (event.update) latestUpdate.set(event.agentId, event.update)
      else latestUpdate.delete(event.agentId)
      if (!began.has(event.agentId)) {
        began.set(event.agentId, Date.now())
        lastBegan.delete(event.agentId)
        // A Harness agent's turn mark: an outside agent's is its prompt by the person or the dial.
        if (!outside(event.agentId)) clearRang(event.agentId)
      }
      // Any card, not only a turn's first: a Codex continuation goes on in the turn its blocked stop left open.
      nudgeContinues(event.agentId)
      void cable.turnStarted(event.agentId, event.text, event.update)
    } else if (event.kind === 'done') {
      const fields = stats.take(event.agentId)
      const at = began.get(event.agentId)
      // Read while the turn's start is kept, which a Harness agent's presence reads. A sub-agent's or a given-up turn's
      // end is not its agent's, and a failed turn rang as one.
      const rouse = !event.subagent && !failedLast.has(event.agentId) && notices.quiet(event.agentId) && !present(event.agentId)
      if (rouse) rousing.add(event.agentId)
      if (!event.subagent) nudgeOver(event.agentId)
      // Its Stop hook's report comes after this done (presentAtStop).
      if (at !== undefined && !outside(event.agentId)) noteEnded(event.agentId, at)
      began.delete(event.agentId)
      ended.set(event.agentId, { durationS: at === undefined ? null : Math.round((Date.now() - at) / 1000),
        stats: { testsPassed: fields.testsPassed, testsFailed: fields.testsFailed, commits: fields.commits } })
      const start = starts.get(event.agentId)
      starts.delete(event.agentId)
      const finish = (tokens: Pick<TurnStatsFields, 'tokensIn' | 'tokensOut'>): void => {
        const all = { ...fields, ...tokens }
        if (Object.keys(all).length) void cable.turnStats(event.agentId, all)
        void cable.turnDone(event.agentId)
        // After the done, which may wait for its tokens: a card closed meanwhile is not asked, nor one whose agent's next
        // turn started meanwhile.
        if (rouse && rousing.delete(event.agentId)) rouseNotice(event.agentId)
      }
      if (!start || !cable.wantsStats()) return finish({})
      return turnTokens(event.agentId, start).then(finish)
    }
    // On screen or a sub-agent's: silent, nobody is asked. Otherwise the tier decides how loudly the dial tells. The
    // tile still updates either way — the recap is what it draws.
    else if (event.kind === 'summary') {
      const { agentId } = event
      const recap = event.recap || event.text
      const onScreen = alreadyOnScreen(agentId)
      const noted = (tier: Tier, rule: string): void => tally(tier, `rule:${rule}`, rule, 0)
      if (onScreen || event.subagent) { noted('silent', event.subagent ? event.notNews ?? 'subagent' : 'onScreen'); void cable.summary(agentId, recap, event.text, 'silent', event.fullText, event.subagent); return }
      // No device attached (or the serial side disabled): nobody to tell, so the recap never leaves the machine.
      if (!cable.isConnected) { ended.delete(agentId); void cable.summary(agentId, recap, event.text, 'silent', event.fullText, false); return }
      const turn = ended.get(agentId) // a sub-agent's summary leaves the main turn's numbers alone
      ended.delete(agentId)
      // Its agent holds a card: the dial keeps one drawer row an agent, so a summary that rang or listed would replace the
      // card's line. A failed turn still rings (docs/plans/2026-11-17-dial-one-ring-per-turn-design.md).
      if (event.failed !== true && notice) { noted('silent', 'notice'); void cable.summary(agentId, recap, event.text, 'silent', event.fullText, false); return }
      // The person watched an outside agent end: its tile alone, in Needs you too. A Harness agent's keeps `onScreen`.
      const row = outside(agentId)
      if (event.failed !== true && row && outsidePresent(row)) { noted('silent', 'present'); void cable.summary(agentId, recap, event.text, 'silent', event.fullText, false); return }
      const who = cableHost.describe(agentId)
      const needsYou = notifyMode.get() === 'you'
      // Needs you: an ordinary finished turn draws its tile alone, with no drawer row, however its tier was decided.
      const tileOnly = needsYou && event.failed !== true
      // Decided once already, by the recaps (services/recaps.ts) or another machine, for the phone as well: the dial
      // follows it and nobody is asked again, but Needs you is this computer's, so an ordinary turn is lowered here. A
      // card without one (a cloud agent's, a recaps from before) is decided here.
      if (event.tier) {
        const lowered = tileOnly && event.tier !== 'silent'
        if (lowered) tally('silent', 'rule:needs-you', 'needs-you', 0)
        else tally(event.tier, 'recaps', 'decided upstream', 0)
        const tier = lowered ? 'silent' : event.tier
        announced(agentId, tier)
        void cable.summary(agentId, recap, event.text, tier, event.fullText, false).then(() => cardBack(agentId, tier))
        return
      }
      // Returned, so the agent's next card waits behind this one (inOrder): a late recap must not follow turn.started.
      return tierOf({ engine: who?.engine ?? '', recap, durationS: turn?.durationS ?? null,
        stats: turn?.stats ?? {}, subagent: false, onScreen: false, failed: event.failed === true, needsYou })
        .then((d) => d.tier, (): Tier => (tileOnly ? 'silent' : 'list'))
        .then((tier) => {
          announced(agentId, tier)
          void cable.summary(agentId, recap, event.text, tier, event.fullText, false).then(() => cardBack(agentId, tier))
        })
    }
    else {
      began.delete(event.agentId); ended.delete(event.agentId)
      stats.take(event.agentId) // a failed turn's sums must not leak into the next turn
      starts.delete(event.agentId)
      tally('alert', 'rule:failed', 'turn.error', 0)
      count((usage) => usage.turnAnnounced(event.agentId))
      void cable.turnError(event.agentId, event.text).then(() => cardBack(event.agentId, 'alert'))
    }
  }
  /** A failed turn rings whatever card its agent holds (rule 8), and its recap or error took that agent's drawer row: the
   *  dial keeps one an agent. The card stays on the dial, so its row goes back over it, after the frame that took it. */
  const cardBack = (agentId: string, tier: Tier): void => part.call('notices', () => {
    if (tier !== 'silent' && notices.pending(agentId)) redrawNotices([agentId])
  })
  /**
   * The reply as it streams: a `steps-v1` device shows the agent's latest paragraph, but a text delta arrives every
   * few tokens and the link is lossy. So at most one send per 750 ms per agent, a trailing send of the last text
   * when the window closes, and a flush when the turn ends. Each send is the whole paragraph (clipped by the
   * session), so a lost one is replaced by the next, and the state is one slot per agent: nothing piles up.
   */
  const REPLY_EVERY_MS = 750
  const replies = new Map<string, { sentAt: number; pending: string | null; timer: ReturnType<typeof setTimeout> | null }>()
  const sendReply = (agentId: string, text: string): void => {
    const slot = replies.get(agentId) ?? { sentAt: 0, pending: null, timer: null }
    replies.set(agentId, slot)
    slot.sentAt = monotonic(); slot.pending = null
    inOrder(agentId, () => { void cable.turnReply(agentId, text) })
  }
  const replyText = (agentId: string, text: string): void => {
    const slot = replies.get(agentId)
    const wait = slot ? slot.sentAt + REPLY_EVERY_MS - monotonic() : 0
    if (!slot || wait <= 0) { sendReply(agentId, text); return }
    slot.pending = text
    if (!slot.timer) {
      slot.timer = setTimeout(() => {
        slot.timer = null
        sendReply(agentId, slot.pending as string) // the timer is cleared whenever pending is, so it is set here
      }, wait)
      slot.timer.unref()
    }
  }
  /** The turn ends or restarts, or the agent goes: send what is waiting (when asked to) and forget the window. */
  const endReplies = (agentId: string, flush: boolean): void => {
    const slot = replies.get(agentId)
    if (!slot) return
    if (slot.timer) clearTimeout(slot.timer)
    if (flush && slot.pending !== null) inOrder(agentId, () => { void cable.turnReply(agentId, slot.pending as string) })
    replies.delete(agentId)
  }
  /** A card for an agent whose delayed `done` is still being sent waits behind it, so the dial sees them in order. */
  const queued = new Map<string, Promise<void>>()
  /** Every per-agent send goes through here, so a question or a step of the next turn never overtakes a delayed done. */
  const inOrder = (agentId: string, run: () => void | Promise<void>): void => {
    const behind = queued.get(agentId)
    const next = behind ? behind.then(run, run) : run()
    if (!next) return
    const tail = next.then(undefined, () => {}) // a throwing send must not break the agent's queue for good
    queued.set(agentId, tail)
    void tail.then(() => { if (queued.get(agentId) === tail) queued.delete(agentId) })
  }
  const toDial = (event: DialEvent): void => {
    // As it comes, not in its agent's order, which holds it behind a done waiting for its tokens.
    if (event.kind === 'processing') rousing.delete(event.agentId)
    // The last streamed text goes out before the turn's end, in the same per-agent order.
    if (event.kind !== 'processing') endReplies(event.agentId, true)
    // Read as the card comes, not as its turn in the queue does: a summary can wait up to 2 s behind its turn's done
    // (TOKENS_WAIT_MS), and the agent may close its card meanwhile. The card may be from an earlier turn: a turn start no
    // longer closes a waiting card, so each turn end stays silent until its agent closes it or it goes at 24 hours
    // (docs/plans/2026-11-27-dial-notice-cards-agent-closes-design.md, rule 8).
    const notice = event.kind === 'summary' && notices.pending(event.agentId)
    // So is the end it may announce: a turn started while the card waits is the agent's next, and spends it.
    if (event.kind === 'summary' || event.kind === 'error') count((usage) => usage.turnEnded(event.agentId))
    inOrder(event.agentId, () => dispatch(event, notice))
  }

  /** Another machine's agents whose turn runs, from its first `processing` card to its end: no `turn_started` card comes
   *  from there, so that first card is the turn's start a voice to it waits for. */
  const remoteTurns = new Set<string>()
  // A remote machine's cards reach the dial through the same calls. The fleet has already noted which
  // machine the agent is on (services/fleet.ts), so a question from it can be named and, tapped, opened.
  fleet?.onEvent((event) => part.call('dial', () => {
    // A `state` event is about the WHEEL, not about a turn — live machine presence, which matters whichever
    // machine is selected. No selection guard on the rest: every machine's agents are on the carousel at
    // once, and dropping a card from one the wheel is not pointed at is what a tile that never leaves
    // "Working…" looks like from the outside.
    if (event.kind === 'state') { void cable.syncMachines(); return }
    if (event.kind === 'questionClosed') { inOrder(event.agentId, () => { void cable.questionClose(event.agentId, event.requestId) }); return }
    if (event.kind === 'question') { tally('alert', 'rule:question', 'question', 0); inOrder(event.agentId, () => { void cable.question(event.agentId, event.requestId, event.questions) }); return }
    if (event.kind === 'processing' && !remoteTurns.has(event.agentId)) {
      remoteTurns.add(event.agentId)
      count((usage) => usage.turnStarted(event.agentId))
    } else if (event.kind === 'done' || event.kind === 'error') remoteTurns.delete(event.agentId)
    toDial({ ...event, subagent: event.subagent === true })
  }))

  // An agent outside a pane reaches the dial through the same calls, as its state changes. What the dial was told of each
  // is kept, so that a change is told once.
  const told = new Map<string, { state: HostAgentState; line: string | null; answer?: string }>()
  const busyState = (state: HostAgentState): boolean => state === 'working' || state === 'needs-you'
  const busy = ({ agent }: HostEntry): boolean => busyState(agent.state)
  /** Its turn, with the waiting line: the session's activity read right after it (`activityText` above) repeats the line. */
  const started = (entry: HostEntry): DialEvent => ({ kind: 'processing', agentId: entry.agent.id, text: waiting(entry) ?? '', recap: '', subagent: false })
  const tell = (event: DialEvent): void => { if (!heldOnTab()) toDial(event) }
  /**
   * The prompt an agent waits on, once its hook said what it asks, is also a question for the dial, which the dial only
   * shows (cableSession.ts SHOWN_ONLY_PREFIX): the round dial draws a line on its working face, a question on its asking
   * one. One option, as a question needs one, and none to speak. By agent, so that each is closed by its own id.
   */
  const shown = new Map<string, { id: string; line: string; questions: unknown }>()
  /** Each Harness agent's question open on the dials, by its id: its notice waits behind it (cable/notices.ts). */
  const questionsOpen = new Map<string, string>()
  const ask = (agentId: string, question: { id: string; line: string; questions: unknown }): void => {
    shown.set(agentId, question)
    inOrder(agentId, () => { void cable.question(agentId, question.id, question.questions) })
  }
  /** The outside agents whose hook says they wait on the person, as the dial's waits count them: by the hook, not by the
   *  question shown, which a window's tab covers and a new prompt asks again, the person still to answer. */
  const outsideWaits = new Set<string>()
  const countOutsideWaits = (entries: HostEntry[], waits: ReadonlySet<string>): void => {
    for (const agentId of outsideWaits) {
      if (waits.has(agentId)) continue
      outsideWaits.delete(agentId)
      const listed = entries.some(({ agent }) => agent.id === agentId && running(agent))
      count((usage) => usage.waitEnded(`outside:${agentId}`, listed ? 'answered' : 'gone'))
    }
    for (const agentId of waits) {
      if (outsideWaits.has(agentId)) continue
      outsideWaits.add(agentId)
      count((usage) => usage.waitOpened(`outside:${agentId}`, agentId))
    }
  }
  /** Asks what waits and closes what no longer does (or what a window's tab covers): before a line, which it takes the place of.
   *  [entries]: the outside list when the caller merged it already. */
  const showWaits = (entries: HostEntry[] = outsideEntries()): void => {
    const waits = entries.filter((entry) => entry.source === observed && observed.waitingOn(entry.agent.id) !== undefined)
    countOutsideWaits(entries, new Set(waits.map(({ agent }) => agent.id)))
    const want = new Map(heldOnTab() ? [] : waits.map((entry) => [entry.agent.id, entry]))
    const closed: string[] = []
    for (const [agentId, question] of shown) {
      const entry = want.get(agentId)
      if (entry && waiting(entry) === question.line) continue
      shown.delete(agentId)
      closed.push(agentId)
      inOrder(agentId, () => { void cable.questionClose(agentId, question.id) })
    }
    for (const [agentId, entry] of want) {
      const line = waiting(entry)
      if (shown.has(agentId) || !line) continue
      ask(agentId, { id: `${SHOWN_ONLY_PREFIX}${randomUUID()}`, line,
        questions: [{ key: 'prompt', q: line, options: [`In ${hostDisplayName(entry.agent.host)}`] }] })
    }
    // After the asks: a wait whose line changed is asked again, and still holds its agent's notice back.
    for (const agentId of closed) reaskNotice(agentId)
  }

  // ── an agent's notice ──────────────────────────────────────────────────────────────────────────────
  //
  // `harness device notify`: the agent's own one line for the person, a card every dial pins until that agent closes it,
  // leaves, or the card is 24 hours old; a proceeding or plain one also goes at the person's next prompt to it, or a
  // Harness agent's next turn (cable/notices.ts `prompted`). A tap that opens it in its app keeps it, so the dial's face of that agent
  // still asks; a tap on a caller no list holds opens nothing and ends it. It takes its own path to the dials, never
  // `tell` or `showWaits`: it is the agent asking for the person, so it rings with a window open on its tab too, which
  // holds an outside agent's turns (heldOnTab), and `showWaits` closes any question `shown` does not hold
  // (docs/plans/2026-11-16-dial-agent-notify-design.md, "Which agents it covers").
  /** Whose notice it is, read from what the devices hold, with no wait: the listener gives a connection 2 s. */
  const noticeCaller = ({ engine, sessionId, folder }: NoticeAsk): NoticeCaller => {
    const who = { name: folder ?? 'An agent', machine: core.machine.name() }
    if (!engine || !sessionId) return { agentId: observedAgentId('notify', folder ?? ''), keys: [], host: '', who: { ...who, engine: '' } }
    // A Harness agent first, by the session the core bound to it: an outside source lists its session too until the
    // dial's list is read again.
    const own = core.agents.advertised().find((session) => session.engine === engine && session.sessionId === sessionId)
    if (own) return { agentId: own.agentId, keys: noticeKeys(own), host: 'harness' }
    const entry = outsideEntries().find(({ agent }) => agent.engine === engine && agent.sessionId === sessionId)
    if (entry) return { agentId: entry.agent.id, keys: noticeKeys(entry.agent), host: entry.agent.host }
    return { agentId: observedAgentId(engine, sessionId), keys: [], host: '', who: { ...who, engine } }
  }
  /** The agent a session's notice and nudge are kept under, so its marks are cleared under the same id: a Harness agent or
   *  another source's row may hold the session under an id of its own. */
  const callerOf = (engine: NudgeAsk['engine'], sessionId: string): string => noticeCaller({ text: '', engine, sessionId }).agentId
  /** A card's wait on the person: a waiting card's own, as up to five stay open at once. The other card keeps its
   *  agent's key: a newer one replaces it (rule 2), and the count reads one wait for it, which a proceeding card answers
   *  and a plain one keeps. */
  const noticeWait = (agentId: string, card: { id: string; kind: NoticeKind }): string =>
    card.kind === 'waiting' ? `notice:${agentId}:${card.id}` : `notice:${agentId}`
  const noticeTally = createEngineTally('[device] notify', ['claude', 'codex', 'agent'], ['shown', 'no dial', 'limited'], log)
  const noticeFile = new NoticeFile({ file: join(core.dataDir, NOTICES_FILE), cards: () => notices.stored(), after: timerIn('notices'), log })
  /** Those agents' notice rows changed with no question frame to carry them: the dial's drawer is replaced. Behind every
   *  send those agents' order holds, their holds among them: a close that came after would drop the row. */
  const redrawNotices = (agentIds: readonly string[]): void => {
    const replace = (): void => { void cable.replaceNotifications(cableHost.listUnread()) }
    const behind = agentIds.flatMap((agentId) => queued.get(agentId) ?? [])
    if (behind.length === 0) replace()
    else void Promise.all(behind).then(() => part.call('notices', replace))
  }
  // Typed, or its type would be read from itself: the cable host's wiring reads it, and it reads the cable built on that host.
  const notices: Notices = new Notices({
    connected: () => cable.isConnected,
    resolve: noticeCaller,
    held: (agentId) => questionsOpen.has(agentId) || shown.has(agentId),
    // In its agent's order, as every card is: a card must not overtake a done still being sent.
    ask: (agentId, id, questions) => inOrder(agentId, () => { void cable.question(agentId, id, questions) }),
    close: (agentId, id) => inOrder(agentId, () => { void cable.questionClose(agentId, id) }),
    uuid: randomUUID,
    now: monotonic,
    clock: Date.now,
    changed: () => noticeFile.changed(),
    present,
    // The log's tally stays beside the usage counts: the end-to-end checks read its line, whose last word says a card was
    // held quiet.
    count: (engine, result, kind, quiet) => {
      noticeTally(engine, result, quiet ? `${kind} · present` : kind)
      count((usage) => usage.noticed(engine, result, kind))
    },
    restored: noticeFile.load(),
    log,
    redraw: redrawNotices,
    // In its agent's order, as an ask is.
    hold: (agentId, id, questions) => inOrder(agentId, () => { void cable.hold(agentId, id, questions) }),
    after: timerIn('notices'),
    // Its wait ends as it goes: answered only when its agent closed it, the one sure sign the person answered, or when the
    // person's own prompt, or a Harness agent's next turn, closed an other card. A card replaced leaves its wait to the
    // card that took its key (noticeShown).
    closed: (agentId, card, end) => {
      if (end === 'replaced') return
      const key = noticeWait(agentId, card)
      const answered = end === 'done' || end === 'prompted'
      count((usage) => {
        usage.waitEnded(key, answered ? 'answered' : 'gone')
        usage.noticeEnded(key, answered)
      })
    },
  })
  /** That agent left: its cards go, and with them their waits on the person, with no answer (closed). Only its leaving:
   *  Harness cannot tell from a turn's start whether the person answered (2026-11-27: another agent's message started the
   *  turn, and the card went unseen), so the agent closes its own. */
  const endNotice = (agentId: string): void => part.call('notices', () => notices.ended(agentId))
  /** A card shown is a wait on the person when it rang, unless its agent says it proceeds (Decision 8): the waits count
   *  the dial's rings, so a card held quiet or queued behind another opens none. A proceeding card that takes the place of
   *  the agent's other card answers that one's wait: the person most likely acted. */
  const noticeShown = (ask: NoticeAsk, card: NonNullable<NoticeOutcome['card']>): void => count((usage) => {
    const { agentId, host } = noticeCaller(ask)
    const key = noticeWait(agentId, card)
    usage.noticeShown(key, card.quiet)
    // A ring after a yes, once a yes (Part 5's counts): an outside agent's while the hold its yes started lasts; a Harness
    // agent's while its continuation runs, till that one's done, as the devices hold no stop of its: its reader continues
    // the turn (rangInContinuation). A card that rang no dial, held quiet or queued behind its agent's waiting card, is
    // none.
    const rang = !card.rang ? undefined : host === 'harness' ? rangInContinuation(agentId) : observed?.rangInHold(agentId)
    if (rang) usage.nudgeRang(rang)
    if (card.kind === 'proceeding') usage.waitEnded(key, 'answered')
    else if (card.rang) usage.waitOpened(key, agentId)
  })
  /** Its turn ended with the person gone: its quiet card is asked (cable/notices.ts `rouse`), counted, and from then a
   *  wait on the person as a rung notice is, unless it proceeds (docs/plans/2026-11-26-needs-you-right-design.md, Part 2b). */
  const rouseNotice = (agentId: string): void => part.call('notices', () => {
    const card = notices.rouse(agentId)
    if (!card) return
    count((usage) => {
      usage.noticeRoused()
      if (card.kind !== 'proceeding') usage.waitOpened(noticeWait(agentId, card), agentId)
    })
  })
  /** The caller's cards, oldest first, for `harness device notify --list`: found as its notice finds it, so it names its
   *  own alone. */
  const noticeList = (who: NoticeWho): NoticeCard[] => {
    let cards: NoticeCard[] = []
    part.call('notices', () => {
      // By the wall clock a card was shown by: one ahead of a clock set back is new, never an age the command drops.
      const now = Date.now()
      cards = notices.list(noticeCaller({ text: '', ...who }))
        .map(({ id, at, kind, line }) => ({ id, ageS: Math.max(0, Math.floor((now - at) / 1000)), kind, line }))
    })
    return cards
  }
  /** The caller closes its card by its id, or all of them, for `harness device notify --done`: how many went. Another
   *  agent's id, or one no card has, closes nothing. */
  const noticeDone = (who: NoticeWho, id: string): number => {
    let closed = 0
    part.call('notices', () => { closed = notices.done(noticeCaller({ text: '', ...who }), id) })
    return closed
  }
  /** Another question of that agent closed: its notice, covered or held back by it, is asked again. */
  const reaskNotice = (agentId: string): void => part.call('notices', () => notices.reask(agentId))

  // ── a second look when a turn stops (docs/plans/2026-11-26-needs-you-right-design.md, Part 5) ───────────────────────
  //
  // `harness device claude stop` and `codex stop` report each stop of a session whose dial skill is on, and whether its
  // answer's tail asks the person something. An ask gets a yes only when the spec's four conditions hold: a dial attached,
  // the skill on, no notice rung in this turn, the person not with the agent. The skill being on is the hook's to read,
  // as only it knows its session's home (decision 4). A report that does not ask only releases the stop the observed
  // source holds for it: every stop sends one, so its end need not wait out the grace (decision 18). An agent said yes to
  // is not stopped again until the once rule ends (nudgedAgents).
  const nudgeTally = createEngineTally('[device] nudge', ['claude', 'codex'], ['yes', 'no ask', 'no dial', 'notice', 'present', 'nudged'], log)
  /** Whether the agent that stopped gets a second look. A no lets the observed source tell its stop; a yes holds its
   *  turn's end while the agent goes on. */
  const nudged = ({ engine, sessionId, ask }: NudgeAsk): boolean => {
    const stopped = observedAgentId(engine, sessionId)
    if (!ask) {
      nudgeTally(engine, 'no ask')
      observed?.stopReported(stopped, false)
      return false
    }
    const agentId = callerOf(engine, sessionId)
    const answer = !cable.isConnected ? 'no dial' : rangThisTurn.has(agentId) ? 'notice' : presentAtStop(agentId) ? 'present'
      : nudgeOf(agentId) ? 'nudged' : 'yes'
    nudgeTally(engine, answer)
    if (answer === 'yes') {
      noteNudged(agentId, engine)
      count((usage) => usage.nudgeYes(engine))
    }
    observed?.stopReported(stopped, answer === 'yes')
    return answer === 'yes'
  }
  /** The outside sources' lists as they are now: a restored notice waiting for one of their agents finds it. */
  const lookOutside = (entries: HostEntry[]): void => part.call('notices', () =>
    notices.look(false, () => entries.map(({ agent }) => listedAgent(agent.id, agent))))
  /** The core's agents as last read: a restored notice waiting for a Harness agent finds it. */
  const lookHarness = (): void => part.call('notices', () =>
    notices.look(true, () => core.agents.advertised().map((session) => listedAgent(session.agentId, session))))

  /** The ids on the dial's lists, built now, which reads the core's agents again. Both lists a dial can hold: the one
   *  ring, and the shown app's for a dial that says appFilter, read only while one is connected: that read can switch the
   *  app, which no older dial shows. */
  const listedIds = async (): Promise<Set<string>> => {
    const apps = cable.wantsApps() ? [cableHost.listAgentSnapshot({ apps: true })] : []
    const lists = await Promise.all([cableHost.listAgentSnapshot(), ...apps])
    return new Set(lists.flatMap((list) => list.agents.map((agent) => agent.id)))
  }
  /** opencode's sessions first listed and not yet found on the dial's lists, each with the cards held for it. opencode
   *  lists a session Harness started before the devices' copy of the core's agents, read again only at a list build,
   *  holds the session Harness bound to it: that build gives the row to Harness, whose own cards are the turn's. */
  const checking = new Map<string, DialEvent[]>()
  const tellOf = (agentId: string, event: DialEvent): void => {
    const held = checking.get(agentId)
    if (held) held.push(event)
    else tell(event)
  }
  /** Builds the dial's lists, then tells the cards held for those of `batch` they hold. One listed again meanwhile is in
   *  a later batch too, whose check tells what it held since. A build that fails tells none and holds them no longer:
   *  held for good, each later card of theirs would be. */
  const check = async (batch: Map<string, DialEvent[]>): Promise<void> => {
    try {
      const listed = await listedIds()
      for (const [agentId, held] of batch) if (listed.has(agentId)) for (const event of held) tell(event)
    } finally {
      for (const agentId of batch.keys()) checking.delete(agentId)
    }
  }

  /** What changed among them, told: run whenever a source of theirs says its list changed. */
  const outsideTurn = (): void => {
    const entries = outsideEntries()
    showWaits(entries)
    // Before `told` is read: an agent listed for the first time takes its restored notice here, under the id the notice
    // was kept by.
    lookOutside(entries)
    const ids = new Set(entries.map((entry) => entry.agent.id))
    const fresh = new Map<string, DialEvent[]>()
    for (const id of told.keys()) {
      if (ids.has(id)) continue
      told.delete(id)
      prompted.delete(id)
      endNotice(id)
    }
    for (const entry of entries) {
      const { agent } = entry
      const was = told.get(agent.id)
      // A resting row (the Claude app's store) says nothing and keeps the record of the copy before it: the app resumes a
      // session moments after it ended its process, and the hooked copy's done, told once, is not told again.
      if (agent.resting && was) continue
      const card = { agentId: agent.id, text: '', recap: '', subagent: false }
      // A wait whose line changed is told again.
      const line = waiting(entry)
      if (was?.state === agent.state && was.line === line) {
        // The answer is read after the turn ends (observed.ts), so its summary follows the done. One still the last
        // turn's (this turn's was not found) is not said again.
        if (agent.state === 'done' && agent.lastAnswer && agent.lastAnswer !== was.answer) {
          was.answer = agent.lastAnswer
          // Cut as a Harness agent's turn is: markdown gone from the headline and the text under it.
          const cut = deriveAnswerCard(agent.lastAnswer)
          if (cut) tellOf(agent.id, { ...card, kind: 'summary', ...cut })
        }
        continue
      }
      told.set(agent.id, { state: agent.state, line, answer: agent.lastAnswer })
      if (!was && entry.source === opencode) {
        const held: DialEvent[] = []
        fresh.set(agent.id, held)
        checking.set(agent.id, held)
      }
      // Only an observed agent has a hook to say its turn started (port.observed): another's going busy is its next turn.
      if (entry.source !== observed && busy(entry) && !(was && busyState(was.state))) count((usage) => usage.turnStarted(agent.id))
      // An agent a listing names for the first time ended no turn the dial saw: herdr says done of any turn that ended in a
      // pane it has not focused, and lists it again at each plug-in, reconnect and unfold. An observed one is first heard
      // by its hook, which may be the turn's end.
      const ended = was !== undefined || entry.source === observed
      if (busy(entry)) tellOf(agent.id, started(entry))
      else if (ended && agent.state === 'done') tellOf(agent.id, { ...card, kind: 'done' })
      else if (ended && agent.state === 'error') tellOf(agent.id, { ...card, kind: 'error' })
    }
    if (fresh.size) part.call('dial', () => check(fresh))
    count((usage) => usage.agentsPresent(outsideRunning(entries)))
  }
  // ── Orca's chats ───────────────────────────────────────────────────────────────────────────────────
  //
  // Read on pushes alone, while a dial is attached (docs/plans/2026-11-23-dial-orca-chats-design.md, decided 3): its
  // attach, Orca's settle in front, a new worktree from the plugin and a hook of a chat the source does not list, the
  // moments a chat can appear or matter. Orca tells no change of its own, and a poll would run `orca` all day for a list
  // that changes when the person works in Orca.
  /** The Orca ids of hooked chats a read was asked for since the dial came, kept to those the observed source still names:
   *  each asks once, so a chat Orca's list leaves out (a read that failed, an Orca too old to list chats) costs no
   *  `orca agent list` at every hook of every agent. */
  let chatsAsked: ReadonlySet<string> = new Set()
  /** A read, only while a dial is attached: with none, nothing is read or kept. Orca's worktree list comes with it while
   *  the worktree the plugin names is not in the map: a detach empties the map, and the same worktree still on screen at
   *  the next attach is no new worktree to ask for it (a dial plugged back in held that worktree's terminals alone,
   *  2026-11-25). */
  const readChats = (chats: OrcaChatSource): void => {
    if (!dialOn) return
    chats.read({ worktrees: orcaWorkspace !== undefined && worktreeOnScreen(chats, orcaWorkspace) === undefined })
  }
  /** A hook that names a listed chat's session folds its row into the hooked copy now, before the dial's look, so the dial
   *  never gets the chat twice; one that names a chat the source does not list asks for a read. A chat is a hooked agent
   *  with a chat's pane: an agent in an Orca terminal names its Orca session too, and Orca lists it as a terminal. */
  const heardChats = (source: ObservedSource, chats: OrcaChatSource): void => {
    chats.refold()
    if (!dialOn) return
    const heard = [...source.orcaSessions()].flatMap(([orcaId, { engine, sessionId }]) =>
      source.paneOf(observedAgentId(engine, sessionId), ORCA_CHAT_ADAPTER) === orcaId ? [orcaId] : [])
    const asked = chatsAsked
    chatsAsked = new Set(heard.filter((orcaId) => asked.has(orcaId) || chats.worktreeOf(orcaId) === undefined))
    if (heard.some((orcaId) => !asked.has(orcaId) && chats.worktreeOf(orcaId) === undefined)) readChats(chats)
  }
  if (observed && orcaChats) observed.onChange(() => part.call('orca-chat', () => heardChats(observed, orcaChats)))
  observed?.onChange(() => part.call('dial', outsideTurn))
  herdr?.onChange(() => part.call('dial', outsideTurn))
  // Before the dial's look, which then sees each session the scan found in the terminal it runs in.
  hcSource?.onChange(() => part.call('observed', () => observed!.placeHerdr()))
  hcSource?.onChange(() => part.call('dial', outsideTurn))
  cmuxSource?.onChange(() => part.call('dial', outsideTurn))
  opencode?.onChange(() => part.call('dial', outsideTurn))
  claudeAppSource?.onChange(() => part.call('dial', outsideTurn))
  // Before the dial's look, so a hooked copy of a listed thread is named as the app names it; setPaneNames tells only a
  // change. No thread is placed at the app's pane: a terminal thread's tap stays its terminal's.
  codexAppSource?.onChange(() => part.call('codex-app', () => observed!.setPaneNames('codex', codexAppSource.paneNames(), new Map())))
  codexAppSource?.onChange(() => part.call('dial', outsideTurn))
  // Before the dial's look, so a hooked copy of a listed chat is named as Orca names it; setPaneNames tells only a change.
  orcaChats?.onChange(() => part.call('orca-chat', () => observed!.setPaneNames(ORCA_CHAT_ADAPTER, orcaChats.paneNames(), orcaChats.placed())))
  // The chats' places in Orca's ring follow Orca's list (rankOrca, below).
  orcaChats?.onChange(() => part.call('orca', () => rankOrca(orcaChats)))
  orcaChats?.onChange(() => part.call('dial', outsideTurn))
  // After the dial's look, so its ring holds the chat it turns to.
  orcaChats?.onChange(() => part.call('dial', () => chatListed(orcaChats)))
  /** One of the observed source's timers, each run guarded as a notice is: one that throws is logged and the next runs. */
  const every = (ms: number, run: () => unknown): ReturnType<typeof setInterval> => {
    const timer = setInterval(() => part.call('observed', run), ms)
    timer.unref()
    return timer
  }
  const timers = observed ? [every(OBSERVED_TICK_MS, () => observed.tick()), every(TURN_CHECK_MS, () => observed.checkWorking())] : []
  /** A look at the processes for each session that ended, once it is old enough to go: the 30 s one leaves it listed for
   *  up to 40 s. One per listed session (fifty at most), a later end of it putting its look off. */
  const endings = new Map<string, ReturnType<typeof setTimeout>>()
  /** A look at the processes for each Claude Code whose held poll lost its client, and for each session that ended: a
   *  closed pane or a removed worktree sends no session-end hook, and its row waited for the 30 s look (the dial eval's
   *  Orca O14/O15); a closed terminal's ended session waited for the endings' 10 s (VS Code V2). A poll a newer one
   *  replaced, and a session ended in a process that runs on (a /clear), is looked at too, and its look finds the
   *  process running and changes nothing: one read of the process table. Apart from the endings, so these quick looks
   *  never put off a session's own ended look. */
  const leavings = new Map<string, ReturnType<typeof setTimeout>>()
  const lookLater = (looks: Map<string, ReturnType<typeof setTimeout>>, ms: number, source: ObservedSource, agentId: string): void => {
    if (!outside(agentId)) return
    clearTimeout(looks.get(agentId))
    const timer = setTimeout(() => { looks.delete(agentId); part.call('observed', () => source.tick()) }, ms)
    timer.unref()
    looks.set(agentId, timer)
  }
  const dropEnded = (source: ObservedSource, agentId: string): void => lookLater(endings, ENDED_MS, source, agentId)
  /** Each observed agent mid-turn that a dial lists (sixteen at most of the fifty in each list), told again: the dial forgets
   *  a turn it hears nothing of for 25 s, and one that just came, whose window just closed, or whose app the dial was just
   *  turned to, has heard nothing of it yet. */
  const remind = async (): Promise<void> => {
    const mid = outsideEntries().filter(busy)
    if (!mid.length || heldOnTab()) return
    const listed = await listedIds()
    for (const entry of mid) if (listed.has(entry.agent.id)) tell(started(entry))
  }

  // ── Orca's ring in Orca's tab order ────────────────────────────────────────────────────────────────
  //
  // Read from Orca's layouts (`orca terminal list --include-visual-layouts`) each time an agent enters or leaves Orca's
  // ring while a dial is attached, one read at a time (docs/plans/2026-11-16-dial-orca-focus-order-design.md, decided 2).
  // Never polled: a tab dragged with no agent coming or going waits for the next change, as a poll would run Orca's CLI
  // every few seconds for as long as a dial is attached, for a drag that seldom comes. A part of its own: a throw on its
  // path costs the dial nothing.
  const orcaReads = deps.orcaReads ?? createOrcaReads(apps)
  /** Whether a dial is attached: the fleet tells `watching` for the first and the last alone. */
  let dialOn = false
  /** Orca's ring as the attached dial has it: its members with their Orca panes at the last check, and whether a change
   *  during the read under way asks for one more. A new one at each detach, so a read from before it lands on nothing. */
  let orcaRing: { members?: ReadonlySet<string>; again: boolean } = { again: false }
  /** A read runs: Orca's CLI is asked one at a time, across a detach too. */
  let ordering = false
  /** The agents on Orca's ring in its terminals: the merged list's, as the dials list them. Not its chats, the chat
   *  source's rows and the hooked copies with a chat's pane: a chat has no terminal, so it takes no tab's place, rank or
   *  name, asks no read of Orca's layouts as it comes and goes, and is no candidate for a terminal by elimination, where
   *  a chat in an agent's folder left that agent unplaced. */
  const orcaAgents = (source: ObservedSource): HostAgent[] => registry.entries().map(({ agent }) => agent).filter(({ id, app }) =>
    app === 'orca' && !orcaChats!.placed().has(id) && source.paneOf(id, ORCA_CHAT_ADAPTER) === undefined)
  const orcaIds = (source: ObservedSource): string[] => orcaAgents(source).map(({ id }) => id)
  /**
   * The Orca terminal of each agent on Orca's ring with no Orca pane, by elimination (the design's decided 7): one the
   * attach scan found has none until its first hook, and an idle one sends none, while Orca's list names no terminal's
   * process or tty. The terminal Orca saw that agent's engine start in, in its folder, that no agent with an Orca pane
   * holds, when it is the only one such and the agent the only one with none there; anything else places nobody. For its
   * order, its tab's name, and the terminal a rest or a tap switches to: never its pane, so no words reach it and no focus
   * line finds it.
   * Agents under tmux are placed by their client (docs/plans/2026-11-27-orca-tmux-follow-focus-design.md §1): two panes
   * of one engine under one tmux in one Orca tab are two candidates for its terminal, which the rule above leaves both
   * unplaced, so off the ring of the worktree on screen. When every candidate of that only terminal runs under tmux on one
   * client, the client is placed there, and with it every agent of that client in that folder, whatever its engine. A
   * candidate with no client or another one, or a client two terminals would take, places nobody: the dial never guesses
   * a session (decision 2). The clients placed, by handle, are returned beside the agents.
   */
  const placeInOrca = (source: ObservedSource, terminals: readonly OrcaTerminal[]): { placed: Map<string, string>; clients: Map<string, string> } => {
    const add = <T>(to: Map<string, T[]>, key: string, value: T): void => { to.set(key, [...to.get(key) ?? [], value]) }
    // By folder and engine: the agent's, and the terminal's worktree and the agent Orca saw there, compared as they are.
    const at = (folder: string, engine: string): string => JSON.stringify([folder, engine])
    const held = new Set<string>()
    /** Each agent with no Orca pane, by folder and engine, with the tty of its tmux client when it runs under tmux. */
    const unplaced = new Map<string, Array<{ id: string; client?: string }>>()
    /** The agents with no Orca pane under each tmux client, by its tty. */
    const onClient = new Map<string, Array<{ id: string; cwd: string }>>()
    for (const { id, cwd, engine, nest } of orcaAgents(source)) {
      const pane = source.paneOf(id, 'orca')
      if (pane !== undefined) held.add(pane)
      else if (cwd !== undefined) {
        const client = nest === 'tmux' ? source.tabTty(id) : undefined
        add(unplaced, at(cwd, engine), { id, client })
        if (client !== undefined) add(onClient, client, { id, cwd })
      }
    }
    const free = new Map<string, OrcaTerminal[]>()
    for (const terminal of terminals) if (!held.has(terminal.handle)) add(free, at(terminal.worktreePath, terminal.agentIdentity), terminal)
    const placed = new Map<string, string>()
    /** The terminals each client would be placed at. */
    const wanted = new Map<string, OrcaTerminal[]>()
    for (const [key, agents] of unplaced) {
      const terminal = free.get(key)
      if (terminal?.length !== 1) continue
      const ttys = new Set(agents.map(({ client }) => client))
      const [client] = ttys
      if (agents.length === 1 && client === undefined) placed.set(agents[0].id, terminal[0].handle)
      else if (ttys.size === 1 && client !== undefined) add(wanted, client, terminal[0])
    }
    const clients = new Map<string, string>()
    for (const [client, [terminal, ...more]] of wanted) {
      if (more.length) continue
      clients.set(terminal.handle, client)
      for (const { id, cwd } of onClient.get(client)!) if (cwd === terminal.worktreePath) placed.set(id, terminal.handle)
    }
    return { placed, clients }
  }
  /** Orca's terminal agents at their tab places, from the last order read that landed, and how many tabs it held. */
  let orcaTabRank: { rank: ReadonlyMap<string, number>; places: number } = { rank: new Map(), places: 0 }
  /** From the last order read that landed: the tmux client placed at each Orca terminal, by handle, and each agent placed
   *  there by that client (agent id → handle). Orca's told client and the tmux pane poll read it (the spec's §2 and §3). */
  let orcaTmux: { clients: ReadonlyMap<string, string>; agents: ReadonlyMap<string, string> } = { clients: new Map(), agents: new Map() }
  /** Orca's rank: its terminals at their tab places, then its chats in Orca's list's order, each after every tab
   *  (decided 6): Orca tells no order of its chat tabs, and a chat has no place among the terminals'. A new rank each
   *  time, which the ring is put in order by (select.ts). Nothing is pushed: the dials read the reordered ring on their
   *  next list, as any change of it. */
  const rankOrca = (chats: OrcaChatSource): void => {
    const rank = new Map(orcaTabRank.rank)
    for (const [at, id] of chats.order().entries()) rank.set(id, orcaTabRank.places + at)
    cableHost.setRank('orca', rank)
  }
  const readOrcaOrder = (source: ObservedSource): Promise<void> => {
    // Marked once asked: an ask that throws leaves the next change free to ask again.
    const read = orcaReads.orcaTabs()
    ordering = true
    const ring = orcaRing
    return read.then((listed) => {
      if (ring !== orcaRing) return
      if (listed === null) { log('[device] orca order · failed'); return }
      log('[device] orca order · read')
      orcaWorktrees = listed.worktrees
      const place = new Map(listed.tabs.map(({ handle }, at) => [handle, at]))
      const { placed, clients } = placeInOrca(source, listed.terminals)
      const rank = new Map<string, number>()
      for (const id of orcaIds(source)) {
        // An agent in a multiplexer inside Orca has no Orca pane, and one Orca did not lay out has no place: both come
        // after the ranked (select.ts), unless placed by elimination.
        const handle = source.paneOf(id, 'orca') ?? placed.get(id)
        const at = handle === undefined ? undefined : place.get(handle)
        if (at !== undefined) rank.set(id, at)
      }
      orcaTabRank = { rank, places: listed.tabs.length }
      rankOrca(orcaChats!)
      // Before the names: their change can start the tmux pane poll, which reads it (the spec's §3).
      orcaTmux = { clients, agents: new Map([...placed].filter(([, handle]) => clients.has(handle))) }
      // A terminal two or more agents are placed at names none of them: each keeps its session's name, else its folder's,
      // so one tab's name is not given to several rows (the spec's §1, decision 3).
      const once = new Set<string>()
      const shared = new Set<string>()
      for (const handle of placed.values()) (once.has(handle) ? shared : once).add(handle)
      // The same read names Orca's agents by their tabs (the design's section 4). After the rank: the rename's change
      // lists the ring already in tab order.
      source.setPaneNames('orca', new Map(listed.tabs.flatMap(({ handle, title, renamed }) =>
        title === undefined || shared.has(handle) ? [] : [[handle, { title, renamed: renamed === true }]])), placed)
      // The names change nothing when a client lands for an agent elimination had placed at that terminal before its
      // lookup landed, so no change starts the poll: it is checked here too (the spec's §3).
      part.call('pane', checkPaneFocus)
    }).finally(() => {
      ordering = false
      if (!orcaRing.again) return
      orcaRing.again = false
      part.call('orca', () => readOrcaOrder(source))
    })
  }
  /** Asks for a read when Orca's ring has other members, or a member another Orca pane or tmux client, than at the last
   *  check: one the attach scan found learns its pane at its first hook, a session resumed in another Orca terminal keeps
   *  its id, and tmux's lookup of a client can land after the read its agent's start asked for, while an agent under tmux
   *  is placed by its client (placeInOrca). With none, the last order is kept. */
  const orcaMembers = (source: ObservedSource): Promise<void> | undefined => {
    if (!dialOn) return
    const members = new Set(orcaIds(source).map((id) => `${id} ${source.paneOf(id, 'orca') ?? ''} ${source.tabTty(id) ?? ''}`))
    const was = orcaRing.members
    orcaRing.members = members
    if (members.size === 0 || (was?.size === members.size && [...was].every((id) => members.has(id)))) return
    if (ordering) { orcaRing.again = true; return }
    return readOrcaOrder(source)
  }
  if (observed) observed.onChange(() => part.call('orca', () => orcaMembers(observed)))

  // ── Rex's ring: its order, its names, and the blocks of the agents the scan found ─────────────────────────
  //
  // Read from Rex (createRexReads `layout`) each time an agent enters or leaves Rex's page, or one's Rex pane changes,
  // while a dial is attached, one read at a time, as Orca's (docs/specs/2026-11-25-dial-rex.md, section 5). The ring then
  // goes as Rex's sidebar does, session by session, tab by tab, block by block, and each agent is named by the title its
  // block's program set, which the app names the pane and the tab by. An agent the scan found has no hook yet to name its
  // block: the block whose foreground process is that agent's is its place, matched by pid, for its order, its name and
  // the block a rest or a tap focuses (never its words: observed.ts shownOnly). Never polled: a tab dragged with no agent
  // coming or going waits for the next change.
  /** Rex's ring as the attached dial has it, as orcaRing. */
  let rexRing: { members?: ReadonlySet<string>; again: boolean } = { again: false }
  let rexOrdering = false
  /** The agents on Rex's page: an agent in tmux inside a Rex block is on it too (select.ts pagesOf). */
  const rexAgents = (): HostAgent[] => registry.entries().filter(({ agent }) => pagesOf(agent).includes('rex')).map(({ agent }) => agent)
  const readRexOrder = (source: ObservedSource): Promise<void> => {
    const read = rexReads.layout()
    rexOrdering = true
    const ring = rexRing
    return read.then((panes) => {
      if (ring !== rexRing) return
      if (panes === null) { log('[device] rex order · failed'); return }
      log('[device] rex order · read')
      const at = new Map(panes.map((pane, index) => [`${pane.session}/${pane.block}`, index]))
      const placed = new Map<string, string>()
      const rank = new Map<string, number>()
      for (const { id } of rexAgents()) {
        // Its own block, as its hook named it. Never the block an earlier read placed it at (shownAt): placed once and
        // read back as its own, it would be placed no more, and the next read would place it again, without end.
        const own = source.paneOf(id, rex.id)
        let parts = own === undefined ? undefined : rexPaneParts(own)
        if (!parts) {
          // Found by the scan, or no hook yet: the block running its process, when exactly one is, at every read.
          const running = rexBlocksRunning(panes, source.windowOf(id)?.pid)
          if (running.length === 1) {
            const [{ session, block, pid }] = running
            placed.set(id, rexPaneIds(session, block, pid)[0])
            parts = { session, block, held: false }
          }
        }
        // A held block (a multiplexer in it) keeps the agent's place in Rex's order: its process is not the block's.
        const held = parts ? undefined : source.shownAt(id, rex.id)
        parts ??= held === undefined ? undefined : rexPaneParts(held)
        const index = parts && at.get(`${parts.session}/${parts.block}`)
        if (index !== undefined) rank.set(id, index)
      }
      cableHost.setRank('rex', rank)
      // Every id a block's agent may hold there, its own and the held one, names it by the block's title.
      source.setPaneNames('rex', new Map(panes.flatMap(({ session, block, pid, title }) => (title === undefined ? []
        : rexPaneIds(session, block, pid).map((id) => [id, { title, renamed: false }] as const)))), placed)
    }).finally(() => {
      rexOrdering = false
      if (!rexRing.again) return
      rexRing.again = false
      part.call('rex', () => readRexOrder(source))
    })
  }
  /** Asks for a read when Rex's page has other members, or a member another Rex pane, than at the last check. */
  const rexMembers = (source: ObservedSource): Promise<void> | undefined => {
    // macOS alone, where the Rex app runs: a Linux or Windows pane says TERM_PROGRAM=rex too, with no `rex` to read.
    if (!dialOn || apps.platform !== 'darwin') return
    const members = new Set(rexAgents().map(({ id }) => `${id} ${source.shownAt(id, rex.id) ?? ''}`))
    const was = rexRing.members
    rexRing.members = members
    if (members.size === 0 || (was?.size === members.size && [...was].every((id) => members.has(id)))) return
    if (rexOrdering) { rexRing.again = true; return }
    return readRexOrder(source)
  }
  if (observed) observed.onChange(() => part.call('rex', () => rexMembers(observed)))
  // Each change tells VS Code's and Cursor's windows which agents run in one of their terminals, by their panes, and the
  // multiplexer clients they hold: only theirs may cost a read of the process table. An agent has at most one of each,
  // so the list stays within twice the source's bound. A part of its own, so a throw there is never the dial's.
  if (observed) observed.onChange(() => part.call('vscode', () => vscode.agents(observed.list().flatMap(({ id }) =>
    (['vscode', 'cursor'] as const).flatMap((editor) => [termPid(observed.paneOf(id, editor) ?? ''),
      clientPid(observed.paneOf(id, `${editor}-tab`) ?? '')].filter((pid) => pid !== undefined))))))

  /**
   * The open scan's copy of a session cmux lists, placed at that row's cmux pane
   * (docs/plans/2026-11-17-dial-cmux-design.md, decided 7): it wins the fold over cmux's row by its session id, and has no
   * hook to name its pane until that session's next turn, so a tap and a rest would open nothing after each restart. Only
   * an agent with no cmux pane of its own. A place opens and shows, never takes words (observed.ts shownOnly). cmux names
   * no pane: no names.
   */
  let placedInCmux = false
  const placeInCmux = (source: ObservedSource, listing: CmuxSource): void => {
    const rows = listing.list()
    // Each observed change lands here, cmux running or not: with no row and no place to drop, there is nothing to tell.
    if (rows.length === 0 && !placedInCmux) return
    const placed = new Map<string, string>()
    for (const { id, engine, sessionId } of rows) {
      if (sessionId === undefined) continue
      const agentId = observedAgentId(engine, sessionId)
      // A row it lists has its pane.
      if (source.paneOf(agentId, 'cmux') === undefined) placed.set(agentId, listing.paneAt(id)!)
    }
    source.setPaneNames('cmux', new Map(), placed)
    placedInCmux = placed.size > 0
  }
  // After each change of either: setPaneNames tells only a change, so the two never loop. The source stopping drops its
  // rows, and with them every place.
  if (observed && cmuxSource) {
    const place = (): void => part.call('cmux', () => placeInCmux(observed, cmuxSource))
    observed.onChange(place)
    cmuxSource.onChange(place)
  }

  /**
   * The open scan's copy of a session herdr lists with its session id, placed at that row's herdr pane: Diego's idle
   * agents in herdr in an iTerm2 tab (2026-11-22) had no hook to name their pane after the devices started again, so a
   * rest reached the tab alone. Only an agent with no herdr pane of its own. The place carries the app the agent is on,
   * as a rest needs it (herdr.ts canShow); while that app is not known, the bare pane, which a tap still focuses. A place
   * opens and shows, never takes words (observed.ts shownOnly).
   *
   * A row with no session (no `herdr integration install claude`) is the scan's agent's when herdr's shell of that pane
   * is one of the agent's parents: placed there too, its key folds that row into the scan's copy, one row, not two until
   * its first hook (known gap 1 of PR #4578).
   */
  let placedInHerdr = false
  /** herdr's shell of the pane of each row with no session asked, none while asked or once the ask failed: each row is
   *  asked once while listed, at most HERDR_SHELLS_MAX at a time. By the source's row, not its pane: a herdr that starts
   *  again numbers its panes afresh, and its source lists each as a new row (herdrSource.ts). */
  const herdrShells = new Map<string, number | undefined>()
  const placeInHerdr = (source: ObservedSource, listing: HerdrSource): void => {
    const rows = listing.list()
    // Each observed change lands here, herdr running or not: with no row and no place to drop, there is nothing to tell.
    if (rows.length === 0 && !placedInHerdr) return
    const placed = new Map<string, string>()
    const place = (agentId: string, pane: string) => {
      const app = source.windowOf(agentId)?.app
      placed.set(agentId, app !== undefined && app !== UNKNOWN_APP && APP_IDS.includes(app) ? `${pane}:${app}` : pane)
    }
    const bare: { row: string; pane: string }[] = []
    for (const { id, engine, sessionId } of rows) {
      // A row it lists has its pane.
      const pane = listing.paneAt(id)!
      if (sessionId === undefined) {
        bare.push({ row: id, pane })
        continue
      }
      const agentId = observedAgentId(engine, sessionId)
      if (source.paneOf(agentId, 'herdr') === undefined) place(agentId, pane)
    }
    for (const row of herdrShells.keys()) if (!bare.some((at) => at.row === row)) herdrShells.delete(row)
    const unplaced = source.foundNested('herdr')
      .filter(({ agentId }) => !placed.has(agentId) && source.paneOf(agentId, 'herdr') === undefined)
    let waiting = false
    for (const { agentId, parents } of unplaced) {
      const at = bare.find(({ row }) => {
        const shell = herdrShells.get(row)
        return shell !== undefined && parents.includes(shell)
      })
      if (at === undefined) waiting = true
      else place(agentId, at.pane)
    }
    // Asked only while such an agent waits for its pane.
    if (waiting) {
      for (const { row, pane } of bare.filter((at) => !herdrShells.has(at.row)).slice(0, HERDR_SHELLS_MAX - herdrShells.size)) {
        herdrShells.set(row, undefined)
        void herdrShellOf(herdrClient, pane).then((answer) => {
          // Its kind only: a pane or a process would say where someone works.
          if (!answer.ok) return log(`[device] herdr shell · not read · ${answer.fault}`)
          herdrShells.set(row, answer.shell)
          part.call('herdr', () => placeInHerdr(source, listing))
        })
      }
    }
    source.setPaneNames('herdr', new Map(), placed)
    placedInHerdr = placed.size > 0
  }
  // As cmux's: after each change of either, and herdr's source stopping drops its rows, and with them every place. None
  // where the scan learns no app (Windows): there herdr's rows are as before.
  if (observed && herdr && scanLearnsApps(apps.platform)) {
    const place = (): void => part.call('herdr', () => placeInHerdr(observed, herdr))
    observed.onChange(place)
    herdr.onChange(place)
  }

  // ── the worktree on Orca's screen ──────────────────────────────────────────────────────────────────
  //
  // Orca's Harness Device plugin tells the terminals of the worktree on Orca's screen while it holds the dial stream, and
  // while Orca is settled in front, Orca's ring for a dial that says appFilter is the agents in them
  // (docs/plans/2026-11-18-dial-orca-tab-scope-design.md), and that worktree's chats, by the workspace id the plugin
  // names it by (docs/plans/2026-11-23-dial-orca-chats-design.md, decided 5). In memory only, and dropped as the plugin's
  // stream ends: stale handles never scope the ring. Each change is one line with a count, never a handle or the
  // workspace. The message and the stream's end come in inside the orca part: Node reports a throw in an abort listener
  // as an uncaught exception.
  /** The handles of the worktree on Orca's screen; undefined while none is told. */
  let orcaFront: ReadonlySet<string> | undefined
  /** That worktree as Orca names it, the plugin's workspace id; undefined while none is told, and from an older plugin,
   *  whose ring holds no chat (Review Focus 4). */
  let orcaWorkspace: string | undefined
  /** The worktree id the plugin's workspace names: an `identity:<key>` through Orca's worktree list, none until a read
   *  gave it; any other is the worktree's own id, which a chat's `worktreeId` holds as it is. Asked at each look: a
   *  worktree read that lands later fills the map, while the scope keeps the latest workspace (Review Focus 3). */
  const worktreeOnScreen = (chats: OrcaChatSource, workspace: string): string | undefined =>
    workspace.startsWith(ORCA_IDENTITY) ? chats.worktreeFor(workspace) : workspace
  /** Whether that agent is a chat of the worktree the plugin names: none with the observed agents switched off. */
  const chatOnScreen = (agentId: string, workspace: string): boolean => {
    if (!orcaChats) return false
    const worktreeId = orcaChats.worktreeOfAgent(agentId)
    return worktreeId !== undefined && worktreeId === worktreeOnScreen(orcaChats, workspace)
  }
  /** The plugin's terminals, null for none, and its workspace. The same handles in another order change nothing. */
  const orcaFronted = (terminals: readonly string[] | null, workspace?: string | null): void => {
    const kept = orcaFront
    const front = terminals === null ? undefined : new Set(terminals)
    const named = workspace ?? undefined
    const same = front && kept ? front.size === kept.size && [...front].every((handle) => kept.has(handle)) : front === kept
    if (same && named === orcaWorkspace) return
    const moved = named !== undefined && named !== orcaWorkspace
    orcaFront = front
    orcaWorkspace = named
    log(terminals === null ? '[device] orca front · cleared' : `[device] orca front · set · ${terminals.length} terminals`)
    // Read when the dials list, never kept: an agent that starts in one of those terminals joins at the next list, and
    // one resumed elsewhere leaves. Its terminal is the one a rest and a tap read (observed.ts placeIn): its own Orca
    // pane, else where the last order read placed it, else the terminal that holds it. Without the held one, an agent
    // placement could not find left the ring, and a prompt typed into it was skipped as no tile (2026-11-21). A chat has
    // no terminal: it is in scope by its worktree, as the latest read of Orca's list gave it.
    cableHost.setScope('orca', front && { inScope: (agentId) => {
      const pane = observed?.shownAt(agentId, 'orca')
      return (pane !== undefined && front.has(orcaHandle(pane))) || (named !== undefined && chatOnScreen(agentId, named))
    } })
    // Another worktree on screen is a push (decided 3): its chats, with Orca's worktree list when its identity is not in
    // the map yet, as the worktree may be new since.
    if (moved && orcaChats) readChats(orcaChats)
  }

  // ── the pane focused in Orca ───────────────────────────────────────────────────────────────────────
  //
  // Where Orca's CLI has `watch-focus`, the dials turn to the agent in the pane the person focuses in Orca: a prompt they
  // submitted there was the only sign of it (#4311, docs/plans/2026-11-16-dial-orca-focus-order-design.md). One watch,
  // started as Orca settles in front with a dial attached and kept until no dial is; one that ends starts again only at
  // Orca's next settle, so nothing runs while Orca is closed. While it runs a prompt in an Orca pane moves nothing
  // (decided 4): the focus already moved the dial, and a prompt Orca types for an orchestrator must not pull it. Each line
  // is an outcome, never the pane or the agent.
  /** The watch while one runs: the latest pane it told (null for none in focus), kept for Orca's next settle, and whether
   *  its first line is still to come. That one is the focus as Orca settled, followed as the settle. */
  let focusWatch: { running: OrcaFocusWatch; pane?: string | null; first: boolean } | undefined
  /** Orca's told client: the tmux client placed at the terminal the watch told last (orcaTmux.clients); none before a
   *  line, for any other terminal, and once the watch ends or the dial goes, as each drops the watch. Orca reports no tabs
   *  to the tmux pane poll, so its watch tells it which client is in front, as VS Code's terminal focus does
   *  (docs/plans/2026-11-27-orca-tmux-follow-focus-design.md §2). Worked out from the watch and the last placement at
   *  each read, so a focus line, Orca's settle and a placement landing after the line each tell it at once. */
  const orcaClient = (): string | undefined => focusWatch?.pane ? orcaTmux.clients.get(focusWatch.pane) : undefined
  /** Orca's CLI is asked whether it watches focus: a settle meanwhile asks nothing more, so at most one watch starts. */
  let probing = false
  /** Turns the dials to the agent in a pane Orca says has focus; `settle` for the focus as Orca settled. With no dial
   *  linked nothing is followed or counted, as with a prompt. */
  const followFocus = (source: ObservedSource, pane: string, settle: boolean): Promise<void> | undefined => {
    if (!cable.isConnected) return
    // A turn of the dial as Orca comes forward puts it where the person wants it: Orca's focus as it settles must not turn
    // it back, as the Claude app's settle must not.
    if (settle && dialMovedAt !== undefined && monotonic() - dialMovedAt < ATTACH_ECHO_MS) { log('[device] focus · skipped · echo'); return }
    if (orcaSwitches.echo(pane, monotonic())) { log('[device] focus · skipped · echo'); return }
    const agent = source.byPane('orca', pane)
    if (!agent) { log('[device] focus · skipped · unknown agent'); return }
    return cable.followLocal(agent.id, 'focus')
  }
  const focusLine = (source: ObservedSource, watch: NonNullable<typeof focusWatch>, pane: string | null): Promise<void> | undefined => {
    // A line of a watch stopped with its dial, already on its way.
    if (watch !== focusWatch) return
    const settle = watch.first
    watch.first = false
    watch.pane = pane
    // A terminal with a placed client moves the dial through the tmux pane poll alone, which reads that client
    // (orcaClient). Its next read is a change, also after the person was away from that tab for less than one read; and
    // the watch's first line is the focus as Orca settled, whose read must not turn back a dial turned as Orca came
    // forward (#4311): the poll's own first answer came before the line, with no client told.
    if (orcaClient() !== undefined && paneFocus?.app === 'orca') {
      paneFocus.last = new Map(paneFocus.last).set(tmux.id, null)
      if (settle) paneFocus.first = true
    }
    if (pane === null) return
    if (cableHost.settledApp() !== 'orca') {
      if (cable.isConnected) log('[device] focus · skipped · not in front')
      return
    }
    return followFocus(source, pane, settle)
  }
  const watchFocus = (source: ObservedSource): void => {
    // Told only after this returns: a child's stdout comes on a later turn.
    const running = orcaReads.watchOrcaFocus((pane) => part.call('orca', () => focusLine(source, watch, pane)))
    const watch = { running, first: true }
    focusWatch = watch
    log('[device] orca watch · started')
    // Orca quit, or its CLI failed: nothing starts again until Orca's next settle.
    void running.ended.then(() => part.call('orca', () => {
      if (focusWatch !== watch) return
      focusWatch = undefined
      log('[device] orca watch · ended')
    }))
  }
  /** Orca settled in front, or a dial attached with Orca settled there: the watch's latest pane is followed as the settle,
   *  or, with none running, Orca's CLI is asked whether it can watch. */
  const orcaSettled = (source: ObservedSource): Promise<void> | undefined => {
    if (!dialOn) return
    if (focusWatch) return focusWatch.pane ? followFocus(source, focusWatch.pane, true) : undefined
    if (probing) return
    // Marked once asked: an ask that throws leaves the next settle free to ask again.
    const probe = orcaReads.orcaWatchesFocus()
    probing = true
    return probe.then((watches) => {
      // The dial went while the CLI was read: no watch is left with no dial to stop it.
      if (!dialOn) return
      if (watches) watchFocus(source)
      else log('[device] orca watch · unsupported')
    }).finally(() => { probing = false })
  }
  /** The dial went, or the devices stop: the watch, its pane and the switches its lines were checked against go too. */
  const dropFocus = (): void => {
    orcaSwitches.clear()
    if (!focusWatch) return
    focusWatch.running.stop()
    focusWatch = undefined
    log('[device] orca watch · ended')
  }

  // ── the pane focused in WezTerm, kitty and tmux ────────────────────────────────────────────────────
  //
  // The dials turn to the agent in the WezTerm pane or kitty window the person focuses, as in Orca: a prompt they typed
  // there was the only sign of it (docs/plans/2026-11-23-dial-wezterm-kitty-focus-follow-design.md). Neither app offers a
  // focus event Harness may subscribe to (theirs need the person's `wezterm.lua` or `kitty.conf`), so each read asks the
  // app (focusPoll.ts): one poll at most, only while its app is settled in front, a dial attached and an agent in a pane
  // of its own there, and zero calls otherwise. A poll that stopped itself starts again only at a settle: a WezTerm whose
  // GUI is gone is asked no more while it stays in front. Each line is an outcome or a count, never a pane, a socket or
  // the agent.
  //
  // tmux is one more place of that poll, in whichever app holds the client showing a live agent's session
  // (docs/plans/2026-11-24-dial-tmux-pane-focus-follow-design.md, "tmux: one more place in the pane focus poll"): its own
  // focus event needs a hook or a control client on the person's server, which Harness never adds, so a read lists its
  // clients. The poll is the settled front app's, with the adapters whose places it reads there, and starts again when
  // either changes (from what it found, when only the adapters did). A read asks each adapter at once, and one whose read
  // failed keeps its places' last answer: a tmux that fails, or hangs to its timeout, costs WezTerm's and kitty's follow
  // nothing but that wait, and after FOCUS_FAILS_MAX in a row not even that until the next settle.
  //
  // In Orca, tmux's place reads the client placed at the Orca terminal Orca's watch told last (orcaClient): Orca's tab
  // switch and a tmux pane switch in that tab each change the pane that client shows, which the watch alone cannot see
  // (docs/plans/2026-11-27-orca-tmux-follow-focus-design.md §2 and §3). With no client told, a read runs no tmux: Orca
  // on a plain tab costs nothing.
  /** A pane focused in a place: the adapter whose pane it is, and the agent's pane id there (tmux's in full, `%3:100:iterm`). */
  type FocusedPane = { adapter: string; id: string }
  /** A read's answer: per place with a focus of its own (`wezterm`, each kitty's socket, `tmux`), the agent's pane focused
   *  there or null; and the dial's moves and the time as the read started. */
  type PaneAnswer = { focused: ReadonlyMap<string, FocusedPane | null>; moves: number; at: number }
  /** The poll, the settled front app it runs for, the adapters whose places it reads there, whether its first answer is
   *  still to come, and its last answer. */
  type PaneFocus = { app: string; adapters: readonly string[]; poll: FocusPoll; first: boolean; last?: ReadonlyMap<string, FocusedPane | null> }
  let paneFocus: PaneFocus | undefined
  /** Set as a poll stops itself; cleared at the next settle of any app: only a settle starts it again (spec). */
  let paneFocusFailing = false
  /** Each adapter's failed reads in a row, cleared at the next settle of any app: one at FOCUS_FAILS_MAX is asked no
   *  more till then, as a poll that stopped itself is not started (a tmux that hangs beside WezTerm's good reads would
   *  cost a run to its timeout every read). */
  const placeFails = new Map<string, number>()
  /** The live agents in tmux whose tmux pane, their own or the one the scan placed them at (shownAt: paneOf reads
   *  their own alone), names [app]: the app holding the client that shows its session, on the tab [tty]. One in tmux
   *  inside Orca only when its client placed it at an Orca terminal (orcaTmux): Orca's focus finds no agent in that
   *  terminal, as none has it for its own pane, and its watch tells the poll when that client is in front
   *  (docs/plans/2026-11-27-orca-tmux-follow-focus-design.md §3). Any other there is followed by nothing: which Orca tab
   *  shows it is not known. */
  const tmuxPanes = (source: ObservedSource, app: string): Array<{ agent: HostAgent; full: string; pane: string; tty: string | undefined }> =>
    source.list().flatMap((agent) => {
      const full = source.shownAt(agent.id, tmux.id)
      if (full === undefined || agent.nest !== 'tmux' || (agent.app === 'orca' && !orcaTmux.agents.has(agent.id))) return []
      const parts = tmuxPaneParts({ adapter: tmux.id, id: full })
      return parts?.app === app ? [{ agent, full, pane: parts.id, tty: source.tabTty(agent.id) }] : []
    })
  /** The live agent at that adapter's pane, its own or the one the scan placed it at, when exactly one is: two there (an
   *  ended session not yet seen as ended beside its successor) cannot say which the person looks at. */
  const nestedAt = (source: ObservedSource, adapter: string, id: string): HostAgent | undefined => {
    const at = source.list().filter((agent) => source.shownAt(agent.id, adapter) === id)
    return at.length === 1 ? at[0] : undefined
  }
  /** The adapters whose places the poll reads with [app] settled in front: WezTerm or kitty with an agent's own pane
   *  there, and tmux with a tmuxPanes entry. */
  const focusAdapters = (source: ObservedSource, app: string | undefined): string[] => {
    if (app === undefined) return []
    const own = (app === 'wezterm' || app === 'kitty') && source.list().some(({ id }) => source.paneOf(id, app) !== undefined)
    if (app === rex.id) return rexPanes(source).length ? [rex.id] : []
    return [...own ? [app] : [], ...tmuxPanes(source, app).length ? [tmux.id] : []]
  }
  /** The live agents on Rex's page with a block there, their own or the one Rex's layout placed them at (shownAt), and
   *  that block's session. */
  const rexPanes = (source: ObservedSource): Array<{ agent: HostAgent; id: string; session: string; block: string }> =>
    source.list().filter((agent) => pagesOf(agent).includes('rex')).flatMap((agent) => {
      const id = source.shownAt(agent.id, rex.id) ?? ''
      const parts = rexPaneParts(id)
      return parts && !parts.held ? [{ agent, id, session: parts.session, block: parts.block }] : []
    })
  /**
   * Rex's places, one per session holding an agent's block: the agent's pane at the block focused in the window that
   * session shows, else null; undefined when every session's read failed. The Rex app shows one session at a time, and
   * Rex tells no client which (API revision 8): a session whose focus changed since the last read is the one the person
   * works in, so the poll follows a place that changed (paneAnswered), and a pick of another session in the sidebar alone,
   * which changes no focus, moves nothing (docs/specs/2026-11-25-dial-rex.md).
   */
  const rexFocused = async (source: ObservedSource, signal: AbortSignal): Promise<ReadonlyMap<string, FocusedPane | null> | undefined> => {
    const panes = rexPanes(source)
    const focused = await rexReads.focused([...new Set(panes.map(({ session }) => session))], signal)
    if (focused === undefined) return undefined
    const places = new Map<string, FocusedPane | null>()
    for (const [session, block] of focused) {
      const at = panes.filter((pane) => pane.session === session && pane.block === block)
      places.set(`rex:${session}`, at.length === 1 ? { adapter: rex.id, id: at[0].id } : null)
    }
    return places
  }
  /**
   * tmux's place, with [app] settled in front: the full pane id of the one live agent at the pane its front client shows,
   * on that client's tab, else null; undefined when its clients' listing failed. The front client is the one on the tab
   * [app] reported selected last, where it reports tabs, or in the terminal VS Code or Cursor focused last
   * (toldClients): a tab app that reported none yet has none, as the person may be on a plain tab of it, and its next
   * report names theirs. Elsewhere, and in an editor that told none, it is the one client there showing an agent's
   * session: with two, which the person looks at is not known. The agent's tab must be the client's too: a second tmux
   * server's `%N` repeats, and its client is on another tab. With no agent's tab that could be the front client's, tmux
   * is not asked: the person on a plain iTerm2 tab costs no run every FOCUS_POLL_MS.
   */
  const tmuxFocused = async (source: ObservedSource, app: string): Promise<FocusedPane | null | undefined> => {
    const panes = tmuxPanes(source, app)
    const ttys = toldClients(app, [...new Set(panes.map(({ tty }) => tty).filter((tty) => tty !== undefined))])
    if (!ttys.length) return null
    const clients = await tmux.clientPanes()
    if (clients === undefined) return undefined
    const front = ttys.filter((tty) => clients.has(tty))
    if (front.length !== 1) return null
    const [tty] = front
    const at = panes.filter((entry) => entry.tty === tty && entry.pane === clients.get(tty))
    return at.length === 1 ? { adapter: tmux.id, id: at[0].full } : null
  }
  /** One adapter's places as the read starts; undefined when its read failed. WezTerm and kitty are asked of the panes
   *  the live agents have of their own there: an agent's own pane alone, as a held one shows whatever is in front of it.
   *  WezTerm's one call is under way at a stop already; [signal] ends kitty's read of several there. */
  const readPlaces = async (source: ObservedSource, app: string, adapter: string, last: PaneFocus['last'], signal: AbortSignal):
  Promise<ReadonlyMap<string, FocusedPane | null> | undefined> => {
    if (adapter === tmux.id) {
      const pane = await tmuxFocused(source, app)
      return pane === undefined ? undefined : new Map([[tmux.id, pane]])
    }
    if (adapter === rex.id) return rexFocused(source, signal)
    // Once each: two live agents can share a pane, as an ended session not yet seen as ended beside its successor.
    const panes = [...new Set(source.list().flatMap(({ id }) => source.paneOf(id, adapter) ?? []))]
    if (adapter === wezterm.id) {
      const id = await wezterm.focusedPane()
      if (id === undefined) return undefined
      return new Map([[wezterm.id, id !== null && panes.includes(id) ? { adapter, id } : null]])
    }
    // The windows found focused last asked first, as focus mostly stays where it was: one call a kitty then.
    const lately = new Set([...(last?.values() ?? [])].map((pane) => pane?.id))
    const ordered = [...panes.filter((id) => lately.has(id)), ...panes.filter((id) => !lately.has(id))]
    const focused = await kitty.focusedWindows(ordered.map((id) => ({ adapter: kitty.id, id })), signal)
    return focused && new Map<string, FocusedPane | null>([...focused].map(([place, id]) => [place, id === null ? null : { adapter, id }]))
  }
  /** One read, every adapter's places asked at once but those that failed FOCUS_FAILS_MAX reads in a row (placeFails).
   *  It fails only when every one failed or was not asked; one that failed or was not asked keeps its places' panes of
   *  the last answer, so they change nothing, and its places with none are left out. */
  const readFocus = async (source: ObservedSource, app: string, adapters: readonly string[], signal: AbortSignal): Promise<PaneAnswer | undefined> => {
    const moves = dialMoves
    const at = monotonic()
    // At the poll's first read, which runs within startFocusPoll before `paneFocus` holds its poll: the last answer of
    // the one it replaced for the same app (checkPaneFocus), or none.
    const last = paneFocus?.last
    const read = await Promise.all(adapters.map(async (adapter) => {
      if ((placeFails.get(adapter) ?? 0) >= FOCUS_FAILS_MAX) return undefined
      const places = await readPlaces(source, app, adapter, last, signal)
      // A read under way as its poll stopped is not counted, as the poll counts none (focusPoll.ts): a kitty read cut
      // short by the stop, or a tmux one that ends after the next settle cleared the counts, is no failure of the place.
      if (!signal.aborted) placeFails.set(adapter, places === undefined ? (placeFails.get(adapter) ?? 0) + 1 : 0)
      return places
    }))
    if (read.every((places) => places === undefined)) return undefined
    const focused = new Map<string, FocusedPane | null>()
    adapters.forEach((adapter, n) => {
      for (const [place, pane] of read[n] ?? [...(last ?? [])].filter(([, kept]) => kept?.adapter === adapter)) focused.set(place, pane)
    })
    return { focused, moves, at }
  }
  /** An answer of the poll turns the dials to the agent in the one focused pane whose place changed since the last
   *  answer; for the poll's first, the one focused as its app settled, or as an agent or a dial came with it settled.
   *  Two places each with an agent focused cannot say which the person looks at: two kittys as kitty settles. With no
   *  dial linked nothing is followed or counted, and the answer is not kept: the first stays the first until one is read
   *  linked, so a dial attaching with WezTerm settled still turns to its focused agent. */
  const paneAnswered = (source: ObservedSource, focus: PaneFocus, answer: PaneAnswer): Promise<void> | undefined => {
    if (!cable.isConnected) return
    const { first, last } = focus
    // None is kept before the first, so its every focused agent's pane is one. An unchanged answer moves nothing: a dial
    // turned by hand meanwhile stays where it was turned. A failed read is no answer: the next is compared with the last
    // good one.
    const changed = [...answer.focused].flatMap(([place, pane]) => pane !== null && last?.get(place)?.id !== pane.id ? [pane] : [])
    focus.first = false
    focus.last = answer.focused
    if (changed.length !== 1) return
    const [{ adapter, id }] = changed
    // The app the person went to settles FRONT_SETTLE_MS after the switch, and the poll of the one they left runs till then.
    // In WezTerm or kitty, an agent's own pane focused there is the one in front: tmux's pane changing in another of its
    // panes (a script, the person in another tab) is not.
    if (cableHost.latestFront() !== focus.app
      || (adapter === tmux.id && [...answer.focused.values()].some((pane) => pane !== null && pane.adapter !== tmux.id))) {
      log('[device] pane · skipped · not in front')
      return
    }
    // The first: a turn or a tap as the app came forward put the dial where the person wants it, and the focus as it
    // settles must not turn it back, as Orca's settle must not (#4311), nor the Claude app's. After it: a move of the
    // dial's own while the read ran leaves the pane it names, as for a tab report, and a tap's focus is seen a read later.
    if (first ? dialMovedAt !== undefined && monotonic() - dialMovedAt < ATTACH_ECHO_MS
      : answer.moves !== dialMoves || paneTaps.echo(id, answer.at)) { log('[device] pane · skipped · echo'); return }
    // Gone while the read ran. One in tmux may sit at the pane the scan placed it at, which byPane never reads, and one in
    // Rex at the block Rex's layout placed it at.
    const agent = adapter === tmux.id || adapter === rex.id ? nestedAt(source, adapter, id) : source.byPane(adapter, id)
    if (!agent) { log('[device] pane · skipped · unknown agent'); return }
    // tmux's front client is the tab reported as the read started: the person may have selected another since.
    if (!onTabInFront(source, focus.app, agent.id)) { log('[device] pane · skipped · not in front'); return }
    return cable.followLocal(agent.id, 'pane')
  }
  /** The poll's app left the front, its last agent went, or the dial went: the poll and the dial's taps its answers are
   *  checked against go with it. */
  const dropPaneFocus = (): void => {
    paneTaps.clear()
    paneFocus?.poll.stop()
    paneFocus = undefined
  }
  /** Starts the poll the app settled in front wants, with a dial attached and a place to read there (focusAdapters),
   *  stops one no longer wanted, and starts one again whose places changed. */
  const checkPaneFocus = (): void => {
    if (!observed) return
    const app = cableHost.settledApp()
    const adapters = dialOn && !paneFocusFailing ? focusAdapters(observed, app) : []
    const wanted = adapters.length ? app : undefined
    if (paneFocus?.app === wanted && (paneFocus?.adapters ?? []).join() === adapters.join()) return
    // The same app with other places (an agent in tmux starting in a WezTerm pane): only the poll starts again. Whether
    // its first answer came, its last one of the places still read and the dial's own moves stand, so a place unchanged
    // does not turn back a dial turned by hand since.
    const kept = paneFocus?.app === wanted ? paneFocus : undefined
    if (kept) kept.poll.stop()
    else dropPaneFocus()
    if (wanted === undefined) return
    // Its answers and its own stop run in a part, which logs a throw: the poll swallows one unsaid (focusPoll.ts).
    const polling: PaneFocus = { app: wanted, adapters, first: kept?.first ?? true,
      last: kept?.last && new Map([...kept.last].filter(([, pane]) => pane !== null && adapters.includes(pane.adapter))),
      poll: startFocusPoll<PaneAnswer>({
        read: (signal) => readFocus(observed, wanted, adapters, signal),
        answered: (answer) => part.call('pane', () => paneAnswered(observed, polling, answer)),
        failing: () => part.call('pane', () => {
          paneFocus = undefined
          paneTaps.clear()
          paneFocusFailing = true
        }),
        after: timerIn('pane'),
        log,
      }) }
    paneFocus = polling
  }
  observed?.onChange(() => part.call('pane', checkPaneFocus))

  // ── the pane focused in herdr ──────────────────────────────────────────────────────────────────────
  //
  // herdr tells the pane that takes its focus on a subscription the herdr source holds while a dial is attached
  // (docs/plans/2026-11-24-dial-tmux-pane-focus-follow-design.md, "herdr: the `pane.focused` event"), so its follow needs
  // no poll. herdr has one focus a server, and its event names no client: the app settled in front and its tab say whether
  // the person is looking at it. Each line is an outcome, never the pane, the tab or the agent.
  /** The one live agent at herdr's pane [paneId], a bare id as herdr's focus names it, and the app its place names:
   *  undefined when no agent is at a pane the herdr source's server lists, null when two are or the pane only holds its
   *  agent. Read by herdr's own follow and by the focus of its client's terminal in VS Code or Cursor alike. */
  const herdrAgentAt = (source: ObservedSource, paneId: string): { agent: HostAgent; app?: string } | null | undefined => {
    // Its own pane, or the one herdr's list placed it at (shownAt, as tmux's).
    const at = source.list().flatMap((agent) => {
      const full = source.shownAt(agent.id, herdrAdapter.id)
      const parts = full !== undefined && herdrPaneParts({ adapter: herdrAdapter.id, id: full })
      return parts && parts.id === paneId ? [{ agent, parts }] : []
    })
    // herdr's focus is the server's whose agents the herdr source lists (its own, which tells it): another server's agent,
    // whose pane id repeats one of it, is at no pane listed.
    if (at.length === 0 || !herdr!.list().some(({ paneKeys }) => paneKeys?.includes(herdrPaneKey(paneId)))) return undefined
    // Two there cannot say which one the person looks at; a held pane shows whatever runs in front of its agent.
    return at.length === 1 && !at[0].parts.held ? { agent: at[0].agent, app: at[0].parts.app } : null
  }
  /** The dials turn to the one live agent at the pane herdr says took the focus, as to a tmux pane's. With no dial linked
   *  nothing is followed or said. */
  const herdrFocused = (source: ObservedSource, paneId: string): Promise<void> | undefined => {
    if (!cable.isConnected) return
    // First: the dial's own `herdr agent focus` excuses its event whatever else of it holds, and that one event alone.
    if (herdrFocuses.echo(herdrPaneKey(paneId), monotonic())) { log('[device] herdr focus · skipped · echo'); return }
    const at = herdrAgentAt(source, paneId)
    // A pane with no agent is ordinary use, and says nothing.
    if (at === undefined) return
    // One in herdr inside Orca is left to Orca's own focus, which follows its panes. The nest check skips none it could
    // follow: only herdr's own lookup, which sets the nest, names an app in a herdr place (a Herdr.app terminal has none).
    if (at === null || at.agent.nest !== 'herdr' || at.agent.app === 'orca') {
      log('[device] herdr focus · skipped · unknown agent')
      return
    }
    const { agent, app } = at
    // The app the person went to settles FRONT_SETTLE_MS after the switch. herdr's focus can move while the person is on
    // another tab of that app (a pane closing hands it on, a second client moves it): where the app reports tabs, the
    // agent's must be the one it reported last.
    if (app === undefined || app !== cableHost.settledApp() || app !== cableHost.latestFront() || !onTabInFront(source, app, agent.id)) {
      log('[device] herdr focus · skipped · not in front')
      return
    }
    return cable.followLocal(agent.id, 'pane')
  }

  // ── the surface focused in cmux ──────────────────────────────────────────────────────────────────────
  //
  // cmux appends each move of its focus to its own event log, in the folder the cmux source watches: that watch tells each
  // change of the log, so cmux's focus needs no poll, timer or socket of its own
  // (docs/plans/2026-11-25-dial-cmux-focus-follow-design.md, decided 1-2). The log is read only while a dial is attached,
  // cmux's source runs and cmux is the settled front app: behind another app the person is not looking at cmux, while a
  // working agent's hooks write its log many times a second. A change then is not kept: the read as cmux settles catches
  // up. Each line is an outcome, never the surface, the workspace or the agent.
  /** Bumped at each reset of the reader: a read that lands after one is dropped. */
  let cmuxReads = 0
  /** This attach's first list of cmux's agents. A read waits for it, so the agent at cmux's focus is known: one asked as
   *  cmux settles meanwhile, and the attach's own, are then one settle (cmuxSettle), followed once. */
  let cmuxListing: Promise<unknown> | undefined
  /** The front surface the last read named: a read naming it again moves nothing, so a dial turned by hand is not turned
   *  back by a working agent's lines. */
  let cmuxLast: string | undefined
  /** cmux settled, or a dial came with it settled, and no read has named its front surface since: the next that does is
   *  that settle's, followed even unchanged, as the person came to cmux from another app's agent. */
  let cmuxSettle = false
  /** Reads cmux's log and follows its front; `settle` as cmux settles. Nothing when the log is not read (above), or for a
   *  read that landed after a reset. */
  const cmuxRead = async (settle: boolean): Promise<void> => {
    const at = cmuxReads
    await cmuxListing
    if (at !== cmuxReads || !dialOn || !cmuxFound || cableHost.settledApp() !== 'cmux') return
    if (settle) cmuxSettle = true
    const front = await cmuxFocus!.read()
    if (at === cmuxReads) return cmuxFocused(front)
  }
  /** The one live agent of the merged list at that surface: its own pane's (a hooked copy's, cmux's row's), or the
   *  session cmux's row there names (the open scan's copy, placed there). None, or two, is none: the dial never turns to a
   *  wrong session (PM, 2026-11-25). */
  const cmuxAgentAt = (surface: string): HostAgent | undefined => {
    const key = cmuxPaneKey(surface)
    const rows = cmuxSource!.list().filter(({ paneKeys }) => paneKeys?.includes(key))
    const at = registry.entries().filter(({ agent }) => !agent.ended && (agent.paneKeys?.includes(key)
      || rows.some((row) => row.sessionId !== undefined && row.engine === agent.engine && row.sessionId === agent.sessionId)))
    return at.length === 1 ? at[0].agent : undefined
  }
  /** The dials turn to the agent at the surface cmux's log names focused in its front workspace. With no dial linked
   *  nothing is followed, said or kept, as for the pane poll's answer: a dial linked later still turns to it. */
  const cmuxFocused = (front: CmuxFront): Promise<void> | undefined => {
    if (!cable.isConnected || front.surface === undefined) return
    const settle = cmuxSettle
    const changed = front.surface !== cmuxLast
    cmuxSettle = false
    cmuxLast = front.surface
    if (!settle && !changed) return
    const now = monotonic()
    // A turn of the dial as cmux comes forward puts it where the person wants it, as at Orca's settle. A tap into another
    // workspace has cmux log that workspace's old surface before the tapped one: while a move of the dial's is unseen, no
    // front cmux names is the person's (PM, 2026-11-25).
    if ((settle && dialMovedAt !== undefined && now - dialMovedAt < ATTACH_ECHO_MS)
      || cmuxFocuses.echo(cmuxPaneKey(front.surface), now) || cmuxFocuses.unseen(now)) {
      log('[device] cmux focus · skipped · echo')
      return
    }
    const agent = cmuxAgentAt(front.surface)
    if (!agent) { log('[device] cmux focus · skipped · unknown agent'); return }
    // The app the person went to settles FRONT_SETTLE_MS after the switch, and the read may have run meanwhile.
    if (cableHost.settledApp() !== 'cmux' || cableHost.latestFront() !== 'cmux') {
      log('[device] cmux focus · skipped · not in front')
      return
    }
    return cable.followLocal(agent.id, 'pane')
  }
  /** cmux's source stopped (the dial went, or cmux was not found): what was read of the log is forgotten, a read under way
   *  lands on nothing, and the dial's own cmux moves go with it: cmux's next focus is the person's. */
  const dropCmuxFocus = (): void => {
    cmuxReads++
    cmuxFocus!.reset()
    cmuxLast = undefined
    cmuxSettle = false
    cmuxFocuses.clear()
  }

  /** The scan, the reminders, herdr's and Herdr Core's sockets, opencode's service, the Claude app's store, the ChatGPT
   *  app's metadata and Orca's chats, for an attached dial alone. */
  let attached: ReturnType<typeof setInterval>[] = []
  /** A part's work run as `part.call` runs it, and its end, which a throw or a rejection only ends: what waits on it never
   *  fails. */
  const partEnd = (name: string, run: () => unknown): Promise<unknown> => {
    let work: unknown
    part.call(name, () => (work = run()))
    return Promise.resolve(work).catch(() => {})
  }
  /** Its promise ends once the sources it started (herdr's, Herdr Core's, cmux's, opencode's, the Claude app's and the
   *  ChatGPT app's) have read once: the dial's greeting waits for it (cableSession.ts), as those sources hold no rows until
   *  then. A source not started, or stopped, ends at once. Orca's chats are not waited on: their read runs `orca`, which
   *  may take ORCA_CHAT_TIMEOUT_MS, and its rows come to the dials with the change it tells. */
  const dialAttached = (on: boolean): Promise<void> => {
    dialOn = on
    for (const timer of attached) clearInterval(timer)
    attached = []
    // The first dial coming, or the last going, can turn the gate (heldOnTab) when it says appFilter: what waits is asked,
    // or closed, again. Closed as the last goes, an older dial that comes next is not asked it. A second dial coming or
    // going does not reach here: the fleet tells `watching` for the first and the last alone.
    if (!on) part.call('dial', showWaits)
    // Its questions were in its RAM: each notice still pending is asked again, or held if restored, under its id,
    // whatever source is on.
    // With the last gone, a Harness agent's next turn goes unheard, so its card ends now.
    part.call('notices', () => on ? notices.attached() : notices.detached())
    // With no dial, WezTerm's and kitty's focus is read no more: the devices' stop detaches too.
    part.call('pane', on ? checkPaneFocus : dropPaneFocus)
    if (!observed || !herdr || !opencode || !claudeAppSource || !codexAppSource || !orcaChats) return Promise.resolve()
    // Only with herdr installed, read at each attach, as a tap needs it (herdr.ts): with none, no folder is watched
    // (~/.config, or the home folder, recursive on macOS) for a socket that never comes. herdr's zip on Windows puts it on
    // no PATH, and its folder appears only when it first runs, which may be after the dial came (the VM notes, Final head
    // §6): there the source always runs, its watch on %APPDATA% itself until herdr's folder is there (never recursive),
    // and a tap runs the herdr that wrote the marker (herdrClient.ts binary).
    const herdrInstalled = () => apps.platform === 'win32' || apps.onPath('herdr') !== null
    const herdrRead = partEnd('herdr', () => on && herdrInstalled() ? herdr.start() : herdr.stop())
    // Only with Herdr installed, read at each attach as herdr's is: with none, no folder is watched for hc's socket.
    const hcRead = hcSource ? partEnd('herdr-app', () => on && herdrApp.binary() ? hcSource.start() : hcSource.stop()) : undefined
    // Only with cmux installed, read at each attach as Herdr's is: with none, no folder is watched for its stores, and a
    // hooked agent's words are not offered to it.
    const cmuxListed = cmuxSource ? partEnd('cmux', () => {
      cmuxFound = on && cmuxClient.binary() !== null
      if (!cmuxFound) dropCmuxFocus()
      return cmuxFound ? cmuxSource.start() : cmuxSource.stop()
    }) : undefined
    cmuxListing = cmuxListed
    const opencodeRead = partEnd('opencode', () => on ? opencode.start() : opencode.stop())
    const claudeRead = partEnd('claude-app', () => on ? claudeAppSource.start() : claudeAppSource.stop())
    // Only with the ChatGPT app installed, looked for at each attach as cmux is: a computer with Codex CLI alone gets
    // no ChatGPT page of threads a tap cannot open. A look that lands after the dial went, or after a newer attach's
    // look began, starts nothing.
    const codexRead = partEnd('codex-app', () => {
      const look = ++codexAppLooks
      if (!on) return codexAppSource.stop()
      return chatGptInstalled().then((found) => {
        if (look !== codexAppLooks) return
        return found ? codexAppSource.start() : codexAppSource.stop()
      })
    })
    // Orca's chats are read at each attach, and none is kept with no dial (decided 3). A hooked chat Orca's list left out
    // may ask once again under the next dial.
    part.call('orca-chat', () => {
      chatsAsked = new Set()
      return on ? readChats(orcaChats) : orcaChats.stop()
    })
    const reads = Promise.all([herdrRead, hcRead, cmuxListed, opencodeRead, claudeRead, codexRead]).then(() => {})
    if (!on) {
      // The next attach checks Orca's ring afresh, and a read under way lands on nothing.
      orcaRing = { again: false }
      rexRing = { again: false }
      part.call('orca', dropFocus)
      // The dial's own herdr moves go with it: herdr's next events are the person's.
      herdrFocuses.clear()
      return reads
    }
    // Agents already running when the dial came are listed now, idle until their next hook event.
    part.call('observed', () => scanOpen(observed))
    part.call('orca', () => orcaMembers(observed))
    part.call('rex', () => rexMembers(observed))
    // A dial plugged in while Orca is already in front: a front told again starts no settle, so none would come until the
    // person left Orca and came back.
    part.call('orca', () => cableHost.settledApp() === 'orca' ? orcaSettled(observed) : undefined)
    // The same for cmux: the read its settle makes, once cmux's agents are listed (cmuxRead), so the agent at its focus is
    // known (PM, 2026-11-25).
    part.call('cmux', () => cmuxRead(true))
    // Its questions were in its RAM: the ones still waiting are asked again, under their ids.
    part.call('dial', () => { for (const [agentId, question] of shown) ask(agentId, question) })
    part.call('dial', showWaits)
    part.call('dial', remind)
    attached = [
      every(OPEN_SCAN_MS, () => scanOpen(observed)),
      // A person can take minutes to come to an agent that waits on them.
      every(REMIND_MS, remind),
    ]
    return reads
  }

  // ── the mod's polls ────────────────────────────────────────────────────────────────────────────────
  //
  // Guarded as the fleet is: a part that throws, or did not start, answers off, so the mod waits a minute. One
  // switched off ends what it holds: the `gone` that would have ended a poll is swallowed from then on.
  const { inboxPoll, inboxGone } = DEVICES_FALLBACKS
  const inboxCalls = part.start('inbox', (): Pick<DeviceHookPort, 'inboxPoll' | 'inboxGone'> & { stop(): void } => ({
    inboxPoll: ({ pollId, sessionId }) => inbox.poll(pollId, sessionId),
    inboxGone: (pollId) => {
      const sessionId = inbox.gone(pollId)
      // The observed source's part, as an ending's look is: a list that throws must not switch the voice inbox off.
      if (sessionId !== undefined && observed) {
        part.call('observed', () => lookLater(leavings, GONE_MS, observed, observedAgentId('claude', sessionId)))
      }
    },
    stop: () => inbox.closeAll(),
  }), { inboxPoll, inboxGone, stop: undefined })
  /** Every poll held for the core's calls: that core went, or the devices stop. */
  const endHookCalls = (): void => { part.call('inbox', () => inbox.closeAll()) }
  /** The watch's change of the Notifications setting: kept, then said at once with the dial's status, which is how the
   *  watch's line, and the menu's check, follow it. No revision: the dial itself did not change. */
  const setNotify = (mode: NotifyMode): { mode: NotifyMode } | { error: string } => {
    const changed = mode !== notifyMode.get()
    const failed = notifyMode.set(mode)
    if (failed !== undefined) {
      log(`[device] notifications · not saved · ${failed}`)
      return { error: 'WRITE_FAILED' }
    }
    sayStatus(cableHost.currentDialStatus())
    // Needs you's list holds fewer finished turns than All's: the drawer the dial holds is drawn again for a new mode.
    // The menu's checked item clicked again sends the mode in force, which changes no row.
    if (changed) void cable.replaceNotifications(cableHost.listUnread())
    log(`[device] notifications · ${mode}`)
    return { mode }
  }
  // The core's calls failed to none when its link dropped: a transcript for a poll nobody holds would wait for nothing.
  deps.onCoreGone?.(endHookCalls)

  // `harness hardware watch` tells the devices' own listener which app is in front, and the dial follows it once it
  // settles, with no window or with one in the apps view (cable/hosts/appFilter.ts), the harness-device mod tells it the
  // session the Claude app shows, `harness device notify` an agent's notice, and `harness device claude stop` or `codex
  // stop` a turn's stop: the core never hears any of them. Another message type is another key here. A rejection's text is
  // not logged: it can hold the socket's path, and a path the account's name.
  const listening = deps.listen?.({
    front: frontHandler((app) => part.call('dial', () => cableHost.front(app))),
    attach: attachHandler((sessionId) => part.call('dial', () => claudeAttached(sessionId))),
    tab: tabHandler((tab) => part.call('dial', () => tabReported(tab))),
    thread: threadHandler((title) => part.call('dial', () => threadReported(title))),
    tabs: tabs.handler,
    wrote: tabs.wrote,
    dial: dial.handler,
    orcaFront: orcaFrontHandler(() => dial.isOpen(), (terminals, workspace) => part.call('orca', () => orcaFronted(terminals, workspace))),
    notify: notifyHandler((mode) => {
      let answer: { mode: NotifyMode } | { error: string } = { error: 'FAILED' }
      part.call('dial', () => { answer = setNotify(mode) })
      return answer
    }),
    noticeList: noticeListHandler(noticeList),
    noticeDone: noticeDoneHandler(noticeDone),
    notice: noticeHandler((ask) => {
      let answer: { result: NoticeResult; id?: string } = { result: 'no dial' }
      part.call('notices', () => {
        // Only a session's notice: none other is ever nudged.
        if (ask.engine && ask.sessionId) noteRang(noticeCaller(ask).agentId)
        const { result, card } = notices.notify(ask)
        answer = card ? { result, id: card.id } : { result }
        if (card) noticeShown(ask, card)
      })
      return answer
    }),
    nudge: nudgeHandler((ask) => {
      let yes = false
      part.call('notices', () => { yes = nudged(ask) })
      return yes
    }),
    ...vscode.handlers,
  }, log)
    .then((listener) => {
      listenerOpen = listener !== null
      // The dial does not wait for a listener slow to open (LISTENER_WAIT_MS): a status said meanwhile carried no mode,
      // and the menu would offer no Notifications until the dial's next one.
      if (listenerOpen && revision > 0) sayStatus(cableHost.currentDialStatus())
      return listener
    })
    .catch((error: unknown): null => { log(`[devices] listener not opened · ${errorKind(error)}`); return null })

  let stopped = false
  if (deps.cableDisabled) log('[cable] disabled (CABLE_DISABLE=true) — the serial port is left alone')
  else if (!listening) cable.start()
  else {
    // After the listener has opened, so a dial that attaches finds it open: the watch tells it the app in front once, as
    // the dial attaches. One that has not opened in a second does not keep the dial off.
    let bound: ReturnType<typeof setTimeout> | undefined
    void Promise.race([listening, new Promise((resolve) => { bound = setTimeout(resolve, LISTENER_WAIT_MS).unref() })]).then(() => {
      clearTimeout(bound)
      if (!stopped) cable.start()
    })
  }
  ;(deps.onExit ?? ((run) => { process.once('exit', run) }))(() => shutdownVoiceRouter())

  /** Each Harness agent's questions the dial's waits count, by request: it can hold two, of which `questionsOpen` keeps the
   *  newest alone, and its next turn or its going ends every one. */
  const questionWaits = new Map<string, Set<string>>()
  const questionAsked = (agentId: string, requestId: string): void => {
    questionWaits.set(agentId, (questionWaits.get(agentId) ?? new Set<string>()).add(requestId))
    count((usage) => usage.waitOpened(questionWait(agentId, requestId), agentId))
  }
  /** Its next turn started (`answered`: the person answered where the dial did not see) or it was deleted (`gone`:
   *  answered nowhere). */
  const questionsEnded = (agentId: string, end: 'answered' | 'gone'): void => {
    for (const requestId of questionWaits.get(agentId) ?? []) count((usage) => usage.waitEnded(questionWait(agentId, requestId), end))
    questionWaits.delete(agentId)
  }
  /** A card bound for the devices, translated once for the cable. */
  const toCable = (frame: Record<string, unknown>): void => {
    // A question, its close and a turn's card each also move the agent on the dial's list with no window (hosts/harness.ts).
    const close = cableQuestionCloseFor(frame as Parameters<typeof cableQuestionCloseFor>[0])
    if (close) {
      cableHost.harness.noteCard(close.agentId, 'question.close')
      inOrder(close.agentId, () => { void cable.questionClose(close.agentId, close.requestId) })
      questionWaits.get(close.agentId)?.delete(close.requestId)
      count((usage) => usage.waitEnded(questionWait(close.agentId, close.requestId), 'answered'))
      // As the cable session's inbox does: the close of an older question leaves the newer one open. Only the open
      // question's close lets its notice out: a notice asked again rings the dial again, so a close heard twice, or of
      // a question never held open, asks nothing.
      if (questionsOpen.get(close.agentId) === close.requestId) {
        questionsOpen.delete(close.agentId)
        reaskNotice(close.agentId)
      }
      return
    }
    const question = cableQuestionFor(frame as Parameters<typeof cableQuestionFor>[0])
    if (question) { questionsOpen.set(question.agentId, question.requestId); questionAsked(question.agentId, question.requestId); cableHost.harness.noteCard(question.agentId, 'question'); tally('alert', 'rule:question', 'question', 0); inOrder(question.agentId, () => { void cable.question(question.agentId, question.requestId, question.questions) }); return }
    // A shell result is only the stats' input: the dial is told the sums when the turn ends.
    const ran = frame as { type?: string; agentId?: string; payload?: { kind?: string; id?: string; command?: string; isError?: boolean; outputTail?: string } }
    if (ran.payload?.kind === 'reply_text' && ran.agentId) {
      const update = (ran.payload as { update?: unknown }).update
      if (typeof update === 'string' && update) { latestUpdate.set(ran.agentId, update); replyText(ran.agentId, update) }
      return
    }
    if (ran.payload?.kind === 'turn_started' && ran.agentId) {
      const agentId = ran.agentId
      // Its other card goes, as before 2026-11-27; its waiting cards stay until it closes them. Only the core knows who
      // started the turn, so the other card may go at another session's message (rule 5).
      part.call('notices', () => notices.prompted({ agentId, keys: [] }))
      rousing.delete(agentId)
      count((usage) => usage.turnStarted(agentId))
      // A question its last turn left open is stale: it must not hold a notice of this turn back, and a card it held back
      // is sent now, as at its close.
      questionsEnded(agentId, 'answered')
      if (questionsOpen.delete(agentId)) reaskNotice(agentId)
      endReplies(ran.agentId, false)
      stats.take(ran.agentId)
      if (cable.wantsStats()) starts.set(ran.agentId, settle(readUsage(ran.agentId)))
      return
    }
    if (isLocalOnly(frame) && ran.agentId && ran.payload?.id) {
      stats.toolResult(ran.agentId, ran.payload.command, ran.payload.isError === true, ran.payload.outputTail ?? '')
      return
    }
    // A tool card is a step for a `steps-v1` device and nothing for any other: the session drops it.
    const gone = (frame as { type?: string; payload?: { agentId?: unknown } })
    if (gone.type === 'agent_deleted' && typeof gone.payload?.agentId === 'string') { latestUpdate.delete(gone.payload.agentId); began.delete(gone.payload.agentId); lastBegan.delete(gone.payload.agentId); clearRang(gone.payload.agentId); clearNudged(gone.payload.agentId); ended.delete(gone.payload.agentId); endReplies(gone.payload.agentId, false); endNotice(gone.payload.agentId); questionsEnded(gone.payload.agentId, 'gone'); questionsOpen.delete(gone.payload.agentId) }
    const step = cableStepFor(frame as Parameters<typeof cableStepFor>[0])
    if (step) { inOrder(step.agentId, () => { void cable.turnStep(step.agentId, step.step) }); return }
    const event = cableEventFor(frame as Parameters<typeof cableEventFor>[0])
    // Logged at the fork, not at the send: this answers "did the daemon even decide to tell the dial",
    // a different question from "did the wire carry it", and the one nobody could answer when a tile
    // stayed idle through a whole turn.
    if (env.LOG_FRAMES && frame.type === 'commander_event') {
      log(`[cable] tee ${(frame as { payload?: { kind?: string } }).payload?.kind ?? '?'} → ${event ? 'sent' : 'ignored'}`)
    }
    if (!event) return
    // A silent one (a sub-agent's, a restored recap) is not news of the agent itself.
    if (!event.subagent) cableHost.harness.noteCard(event.agentId, event.kind)
    toDial(event)
  }
  /**
   * A turn's start outside a pane turns the dials to its agent only when a person typed its prompt in the app settled in
   * front (docs/specs/2026-11-14-dial-pane-follow.md). The front, never the app a dial shows: a pick on the dial leaves
   * the front where it is, and a dial whose ring lacks the agent answers no tile itself. Each prompt line is a reason,
   * never the app, the agent or the session; the move's own line, followApp's, names the agent's id as it does for a
   * Harness agent.
   */
  const followPrompt = (agentId: string, source: PromptSource): Promise<void> | undefined => {
    chatPrompt = undefined
    // No dial linked: nothing to turn or count. The turn still used up a dial's prompt, in `ingest`.
    if (!cable.isConnected) return
    if (source === 'relayed') { log('[device] prompt · skipped · relayed'); return }
    if (source === 'dial') { log('[device] prompt · skipped · dial prompt'); return }
    const front = cableHost.settledApp()
    if (front === undefined || outside(agentId)?.agent.app !== front) { log('[device] prompt · skipped · not in front'); return }
    // Focus reaches an agent with an Orca pane; one in a multiplexer inside Orca has none, and its prompt still moves the
    // dial.
    if (focusWatch && observed?.paneOf(agentId, 'orca') !== undefined) { log('[device] prompt · skipped · focus followed'); return }
    if (orcaChats && observed?.paneOf(agentId, ORCA_CHAT_ADAPTER) !== undefined && orcaChats.worktreeOfAgent(agentId) === undefined) {
      chatPrompt = { agentId, source, at: monotonic(), moves: dialMoves }
    }
    return cable.followLocal(agentId, 'prompt')
  }
  /**
   * A new Orca chat's first prompt comes before the read its first hook asked lands, and a scoped ring holds only the
   * chats Orca's list names (chatOnScreen): the dials answer no tile. The prompt is kept, the latest alone, and followed
   * again once Orca's list names its chat, unless the dial moved or followed anything since, or the list came later
   * than a read may take. Dropped at any later prompt.
   */
  let chatPrompt: { agentId: string; source: PromptSource; at: number; moves: number } | undefined
  /** Orca's list changed: a kept chat prompt it names now is followed, once. */
  const chatListed = (chats: OrcaChatSource): Promise<void> | undefined => {
    const kept = chatPrompt
    if (!kept) return
    const late = monotonic() - kept.at > ORCA_CHAT_TIMEOUT_MS
    if (!late && kept.moves === dialMoves && chats.worktreeOfAgent(kept.agentId) === undefined) return
    chatPrompt = undefined
    if (late) { log('[device] prompt · skipped · listed late'); return }
    if (kept.moves !== dialMoves) { log('[device] prompt · skipped · dial moved'); return }
    return followPrompt(kept.agentId, kept.source)
  }
  // ── the session the Claude app shows ───────────────────────────────────────────────────────────────
  //
  // The harness-device mod says which session the app attached, and the dials turn to its agent while the app has settled
  // in front, by a prompt's rules (docs/specs/2026-11-15-dial-claude-app-follow.md). Each line is a reason, never the app,
  // the agent or the session.
  /** The agent of the app's last attach that named a listed Claude app agent, moved to or not: the session on the app's
   *  screen, which the dials turn to once the app settles in front. Gone with its session. */
  let claudeAgent: string | undefined
  /** What the latest 'attach' follow was asked for: an attach, or the app settling in front. FollowCause is shared with
   *  the tab follow and has no settle of its own, so this tells a settle's answer from an attach's; a dial answers only
   *  for its latest ask (cableSession.ts followLocal's generation), so its answer is this ask's. */
  let attachAsk: 'attach' | 'settle' = 'attach'
  /** When the dial's own continue link to each agent started, by the devices' clock: at most one per listed agent. */
  const dialLinks = new Map<string, number>()
  /** A tap's or a rest's link, noted as it starts, as the app's attach can come before `open` exits: that attach is the
   *  dial's own echo, not a session the person chose. Busy or failed, the dial is on that agent all the same. */
  const noteLink = (agentId: string): void => {
    const at = monotonic()
    for (const [id, linked] of dialLinks) if (at - linked >= ATTACH_ECHO_MS) dialLinks.delete(id)
    dialLinks.set(agentId, at)
  }
  /** Whether a link of the dial's own to that agent is younger than ATTACH_ECHO_MS. Compared each time: an older one stays
   *  in the map until the next link. */
  const linkedByDial = (agentId: string): boolean => {
    const linked = dialLinks.get(agentId)
    return linked !== undefined && monotonic() - linked < ATTACH_ECHO_MS
  }
  const claudeAttached = (sessionId: string): Promise<void> | undefined => {
    const agentId = observedAgentId('claude', sessionId)
    const listed = outside(agentId)?.agent.app === 'claude'
    // Kept whatever follows: an echo, or an attach with another app in front, is still the session the app shows.
    if (listed) claudeAgent = agentId
    if (!cable.isConnected) return
    if (!listed) { log('[device] attach · skipped · unknown agent'); return }
    if (linkedByDial(agentId)) { log('[device] attach · skipped · echo'); return }
    if (cableHost.settledApp() !== 'claude') { log('[device] attach · skipped · not in front'); return }
    attachAsk = 'attach'
    return cable.followLocal(agentId, 'attach')
  }
  const claudeSettled = (): Promise<void> | undefined => {
    if (claudeAgent === undefined || !cable.isConnected) return
    // Resumed in another app, or gone with no end: the app no longer shows it.
    if (outside(claudeAgent)?.agent.app !== 'claude') { claudeAgent = undefined; return }
    // Any move of the dial, to another agent, another app's pane or none: a turn as the app comes in front puts the dial on
    // that one, and the settle must not turn the dial back. A link's attach, a moment later, is kept and skipped as its own
    // echo. Within ATTACH_ECHO_MS, not since the attach kept: that can be minutes old after a look away and back.
    if (dialMovedAt !== undefined && monotonic() - dialMovedAt < ATTACH_ECHO_MS) { log('[device] settle · skipped · echo'); return }
    attachAsk = 'settle'
    return cable.followLocal(claudeAgent, 'attach')
  }
  /**
   * A tab selected in Terminal, iTerm2 or Ghostty turns the dials to its agent as a person's prompt does, once its app has
   * settled in front (docs/specs/2026-11-15-dial-terminal-follow.md, "2. Selecting a tab moves the dial"): Harness Device
   * reports as the app comes to the front, before it settles. The latest report waits for that settle, and another app
   * settling drops it. Each line is an outcome, never the app, the tty or the agent.
   */
  /** A tab report, when it came and how many moves the dial had made by then. */
  type TabReport = Tab & { at: number; moves: number }
  let tabReport: TabReport | undefined
  /** Uses up the report: with no dial linked nothing is followed or counted, as with a prompt. */
  const followTab = (report: TabReport): Promise<void> | undefined => {
    tabReport = undefined
    if (!cable.isConnected) return
    const { app, tty, at } = report
    // The dial moved while the report waited for the settle, to a tab, another app's pane or none: it names a tab the dial
    // has left. When that move selected a tab, the app's report of it is still to come.
    if (report.moves !== dialMoves) { log('[device] tab · skipped · echo'); return }
    // By when the report came, not when its app settled: the wait for the settle must not age the dial's own select. It
    // excuses this report only: the person selecting that tab again soon after moves the dial.
    if (selects.echo(tty, at)) { log('[device] tab · skipped · echo'); return }
    const agent = observed?.byTab(app, tty)
    if (!agent) { log('[device] tab · skipped · unknown agent'); return }
    return cable.followLocal(agent.id, 'tab')
  }
  const tabReported = (tab: Tab): Promise<void> | undefined => {
    // Every report, an echo's and one waiting for the settle too: it is the tab the person is on.
    lastTabs.set(tab.app, tab.tty)
    const report = { ...tab, at: monotonic(), moves: dialMoves }
    if (cableHost.settledApp() === tab.app) return followTab(report)
    tabReport = report
  }
  /** After the settle has shown its page and turned the view: the report waiting on that app is judged, once, and its
   *  agent followed on the page shown. One waiting on another app is dropped. */
  const tabSettled = (app: string): Promise<void> | undefined => {
    if (!tabReport) return
    if (tabReport.app === app) return followTab(tabReport)
    tabReport = undefined
    if (cable.isConnected) log('[device] tab · skipped · not in front')
  }
  /**
   * A terminal focused in VS Code or Cursor turns the dials to its agent as a selected tab does, once that editor has
   * settled in front (docs/plans/2026-11-17-dial-vscode-extension-design.md, "PR B, decided now" 3); one holding a tmux
   * or herdr client, to the agent at the pane that client shows
   * (docs/plans/2026-11-26-dial-mux-host-pages-design.md §7). Each line is an outcome, never the editor, the window, the
   * shell or the agent.
   */
  /** A focus report: the agent, its editor and terminal, when its window's state came, whether that window came into
   *  focus on the terminal it had, and how many moves the dial had made by the time it was told. */
  type EditorReport = { agentId: string; app: string; terminal: string; at: number; regained: boolean; moves: number }
  let editorReport: EditorReport | undefined
  /** Uses up the report: with no dial linked nothing is followed or counted, as with a prompt. */
  const followEditor = (report: EditorReport): Promise<void> | undefined => {
    editorReport = undefined
    if (!cable.isConnected) return
    // The dial moved since the state came, while its agent's chain was read or while it waited for the settle, or showed
    // that terminal itself: by when the state came, as a tab's by when its report came. A window that came into focus on
    // the terminal it had within ATTACH_ECHO_MS of the dial's move is that move's echo: a tap on a session in the Claude
    // Code tab or on Cursor's folder brings the editor forward with no terminal shown, as the Claude app's settle has.
    const sinceMove = dialMovedAt === undefined ? Infinity : report.at - dialMovedAt
    if (report.moves !== dialMoves || sinceMove < 0 || (report.regained && sinceMove < ATTACH_ECHO_MS)
      || vscodeShows.echo(report.terminal, report.at)) {
      log('[device] vscode · skipped · echo')
      return
    }
    return cable.followLocal(report.agentId, 'vscode')
  }
  /** Followed once its editor has settled in front; till then it waits for that settle. */
  const editorReported = (report: EditorReport): Promise<void> | undefined => {
    if (cableHost.settledApp() === report.app) return followEditor(report)
    editorReport = report
  }
  /** Bumped at each focus: a client's pane read that lands after a newer focus is dropped, as that one is where the
   *  person is now. */
  let editorFocuses = 0
  /** The one live agent at the pane the herdr client of [agents] shows: at the pane herdr said took its focus last
   *  (herdrSource.ts focusedPane), as herdr's own follow checks it (herdrAgentAt), when it is one of [agents]. */
  const herdrShows = (source: ObservedSource, agents: readonly HostAgent[]): HostAgent | undefined => {
    const focused = herdr!.focusedPane()
    const at = focused === undefined ? undefined : herdrAgentAt(source, focused)
    return at && agents.some(({ id }) => id === at.agent.id) ? at.agent : undefined
  }
  /** The one live agent at the pane tmux's client kept for [app] shows, from one read of its clients (tmuxFocused);
   *  none when not one is, or when a focus newer than [focus] came while it read. */
  const tmuxShows = async (source: ObservedSource, app: string, focus: number): Promise<HostAgent | undefined> => {
    const pane = await tmuxFocused(source, app)
    if (focus !== editorFocuses) return
    if (pane === undefined) {
      log('[device] vscode · skipped · not read')
      return
    }
    // As the running poll's last answer for tmux's place: its next read of the same pane changes nothing, so the focus
    // is followed once, and a hand's turn after it stands.
    if (paneFocus?.app === app) paneFocus.last = new Map(paneFocus.last).set(tmux.id, pane)
    return pane ? nestedAt(source, tmux.id, pane.id) : undefined
  }
  /** The person's latest focus replaces one waiting for the settle, a terminal no agent runs in too, and the client
   *  kept for the last. */
  const editorFocused = async (pid: number | undefined, { window, shell }: VscodeTerminal, at: number, regained: boolean): Promise<void> => {
    editorReport = undefined
    editorClients.clear()
    const focus = ++editorFocuses
    if (!observed || pid === undefined) return
    // As the state came, before any read: a move of the dial while a client's pane is read sets it aside
    // (followEditor).
    const report = { terminal: `${window} ${shell}`, at, regained, moves: dialMoves }
    const agents = observed.list()
    for (const app of ['vscode', 'cursor'] as const) {
      const own = agents.find(({ id }) => observed.paneOf(id, app) === `term:${pid}`)
      if (own) {
        // The editor told a terminal with no client: tmux's pane poll then follows none of its clients (toldClients).
        editorClients.set(app, undefined)
        return editorReported({ ...report, agentId: own.id, app })
      }
      // A multiplexer client's terminal (vscodeTerminals.ts tells its pid): an agent's own parents never hold its
      // shell, the 23/11 known gap. Diego's point 1 named VS Code (docs/plans/2026-11-26-dial-mux-host-pages-design.md
      // §7).
      const held = agents.filter(({ id }) => observed.paneOf(id, `${app}-tab`) === `client:${pid}`)
      if (!held.length) continue
      editorClients.set(app, observed.tabTty(held[0].id))
      // Behind no dial a read is for nothing; the client is kept all the same, for the poll once one links.
      if (!cable.isConnected) return
      // herdr's pane is known at once; tmux's is read, and a newer focus meanwhile wins (tmuxShows).
      const shown = herdrShows(observed, held) ?? await tmuxShows(observed, app, focus)
      if (!shown) return
      return editorReported({ ...report, agentId: shown.id, app })
    }
  }
  const editorSettled = (app: string): Promise<void> | undefined => {
    if (!editorReport) return
    if (editorReport.app === app) return followEditor(editorReport)
    editorReport = undefined
    if (cable.isConnected) log('[device] vscode · skipped · not in front')
  }
  /**
   * A thread opened in the ChatGPT app turns the dials to it as a selected tab does, once the app has settled in front
   * (docs/plans/2026-11-20-dial-chatgpt-follow-ax-design.md, "The devices process"): Harness Device reports the title of
   * the app's window, matched here to Codex's name of one of its threads. Each line is an outcome, never the title, a
   * name or the thread.
   */
  /** A thread report: the title, when it came and how many moves the dial had made by then. Held in memory only. */
  type ThreadReport = { title: string; at: number; moves: number }
  let threadReport: ThreadReport | undefined
  /** Uses up the report: with no dial linked nothing is followed or counted, as with a prompt. The match, which reads
   *  Codex's names of up to 200 threads, runs only for a report neither the dial's move since nor the settle's echo
   *  drops: the dial's own switches are told by the thread it names, so they are checked after it. */
  const followThread = (report: ThreadReport, atSettle: boolean): Promise<void> | undefined => {
    threadReport = undefined
    if (!cable.isConnected) return
    if (report.moves !== dialMoves) { log('[device] thread · skipped · echo'); return }
    // A tap brings the app forward, and its window can still show the thread it had: the settle's echo, as the Claude
    // app's settle has.
    if (atSettle && dialMovedAt !== undefined && monotonic() - dialMovedAt < ATTACH_ECHO_MS) { log('[device] thread · skipped · echo'); return }
    // With the observed agents off there is no source, and no thread to name.
    const match = codexAppSource?.threadNamed(report.title) ?? 'none'
    if (match === 'none') { log('[device] thread · skipped · no match'); return }
    if (match === 'ambiguous') { log('[device] thread · skipped · ambiguous'); return }
    // By when the report came, as a tab's: it excuses this report only. While the dial's own switch is not yet seen,
    // another thread is the window's old title read late: followed, it would take the switch's title for its echo.
    if (codexSwitches.echo(match.threadId, report.at) || codexSwitches.unseen(report.at)) {
      log('[device] thread · skipped · echo')
      return
    }
    return cable.followLocal(observedAgentId('codex', match.threadId), 'thread')
  }
  /** The empty title, no window or one out of rule, names no thread: it drops what waits. */
  const threadReported = (title: string): Promise<void> | undefined => {
    threadReport = undefined
    if (title === '') return
    const report = { title, at: monotonic(), moves: dialMoves }
    if (cableHost.settledApp() === 'codex') return followThread(report, false)
    threadReport = report
  }
  const threadSettled = (app: string): Promise<void> | undefined => {
    if (!threadReport) return
    if (app === 'codex') return followThread(threadReport, true)
    threadReport = undefined
    if (cable.isConnected) log('[device] thread · skipped · not in front')
  }
  const port: DevicesPort = {
    // A paneless session's hook event, as the core checked it: taken, and dropped here while the observed source is
    // switched off.
    observed: (event) => {
      part.call('observed', () => {
        if (!observed) {
          // Its agent is gone (docs/plans/2026-11-27-dial-notice-cards-agent-closes-design.md, rule 5). With the source off
          // no list holds this session: its card is kept under the session's id, and nothing else would end it.
          if (event.event === 'session-end') endNotice(observedAgentId(event.engine, event.sessionId))
          return
        }
        // The id the agent's notices and nudges were kept under (callerOf), read before the source takes the event: an
        // ended session hands its row to another source's live copy of it. Only Claude Code and Codex ring or are nudged.
        const caller = (event.event === 'turn-start' || event.event === 'session-end') && (event.engine === 'claude' || event.engine === 'codex')
          ? callerOf(event.engine, event.sessionId) : undefined
        const source = observed.ingest(event)
        // The person's prompt to it, by the dial too but never another session's message, or its end: what it rang and the
        // yes it had were before this turn.
        if (caller && (source === 'person' || source === 'dial' || event.event === 'session-end')) {
          clearRang(caller)
          clearNudged(caller)
        }
        // The person's own prompt to it, by the dial's words too, never another session's message (2026-11-27): its other
        // card goes, as before; its waiting cards stay until it closes them (rule 5). Found as its notice found it; only
        // Claude Code and Codex ring.
        if ((source === 'person' || source === 'dial') && (event.engine === 'claude' || event.engine === 'codex')) {
          const found = noticeCaller({ text: '', engine: event.engine, sessionId: event.sessionId })
          part.call('notices', () => notices.prompted(found))
        }
        // The interrupt is a hooked agent's alone (Decision 2): a Harness agent's aborted turn ends as a finished one does.
        if (event.event === 'turn-aborted') count((usage) => usage.turnAborted(observedAgentId(event.engine, event.sessionId)))
        if (event.event === 'turn-start') {
          const agentId = observedAgentId(event.engine, event.sessionId)
          // The person's prompt only where the hook can tell: another session's message is not, nor a turn with no prompt
          // event (agy, commandcode).
          const byPerson = source === 'person' || source === 'dial'
          // Any other start drops its time: the turn under way is not the person's. Set after the delete, so the map stays
          // oldest first.
          prompted.delete(agentId)
          if (byPerson) prompted.set(agentId, monotonic())
          if (prompted.size > PROMPTED_MAX) prompted.delete(prompted.keys().next().value as string)
          // Its voice delivered, and once a day where the dial found it: on no list, held, on the Other page or placed. Only
          // a dial on counts where, so with none the registry is not merged for it.
          count((usage) => {
            usage.turnStarted(agentId, byPerson)
            if (!dialOn) return
            const entries = registry.entries()
            // Its own row, or the row of the agent that holds its session: a Harness agent's, which the dial shows for it.
            const listed = entries.some(({ agent }) => running(agent)
              && (agent.id === agentId || (agent.engine === event.engine && agent.sessionId === event.sessionId)))
            const unknown = { engine: event.engine, host: UNKNOWN_APP, page: UNKNOWN_APP, held: false }
            usage.hooked(agentId, { ...unknown, ...usageAgent(agentId, entries), listed, otherApp: observed.otherApp(agentId) })
          })
        }
        if (event.event === 'session-end') {
          const agentId = observedAgentId(event.engine, event.sessionId)
          dropEnded(observed, agentId)
          lookLater(leavings, GONE_MS, observed, agentId)
          // Listed for a while once ended, but on no app's screen: a settle must not turn the dial to it.
          if (agentId === claudeAgent) claudeAgent = undefined
        }
        if (source) part.call('dial', () => followPrompt(observedAgentId(event.engine, event.sessionId), source))
      })
      return true
    },
    // Every card bound for the Wi-Fi devices goes down the cable too, translated once: a new kind of card
    // reaches the dial the day it reaches the backend's devices.
    card: (frame) => part.call('dial', () => toCable(frame)),
    desk: (agentIds, front) => {
      // ORDER matters, not just membership: the dial's carousel is the tiles, in tile order, so the thumb
      // walks the grid the eyes are on, and a change is a new ring, pushed at once. Left to the next tick,
      // a click on an agent with no tile yet (which changes the desk, then focuses) reached the dial before
      // its ring had a column for it, and the dial dropped the focus.
      const changed = agentIds.length !== desk.length || agentIds.some((id, at) => id !== desk[at])
      desk = [...agentIds]
      foreground = front
      onScreen = new Set(agentIds)
      part.call('dial', () => cableHost.setDesk(agentIds))
      if (changed) part.call('dial', () => cable.syncAgents())
    },
    // Null is the window gone: an empty desk with a window behind it is an empty tab, with none a shut app.
    swarms: (swarms) => part.call('dial', () => {
      const held = heldOnTab()
      windowOpen = swarms !== null
      cableHost.setSwarms(swarms)
      void cable.syncSwarms()
      void cable.syncAgents()
      // A window's tab closes the questions of the agents outside it, as it covers their lines; closed, they are asked again.
      showWaits()
      // A window that closes from an app's ring left nothing to tell again: the view turning to that ring told it.
      if (held && !heldOnTab()) part.call('dial', remind)
    }),
    // Held rather than acted on: the dial is handed it when it attaches, the one moment its drawer is known
    // to be empty.
    unread: (items) => part.call('dial', () => {
      cableHost.setUnread(items)
      void cable.replaceNotifications(cableHost.listUnread())
    }),
    appFocus: (machineId, agentId) => part.call('dial', () => cable.followApp(machineId, agentId)),
    // The window looked at a harness: the dial's drawer row for it is stale.
    seen: (agentId, readToken) => part.call('dial', () => cable.agentSeen(agentId, readToken)),
    // Addressed to one device by the fleet's id: a preference belongs to the glass it was set on. Nothing is
    // answered here; the device's own `settings.state` reaches the windows as an ordinary `dial_status`.
    settings: (id, patch) => part.call('dial', () => cable.setSettings(id, patch as Parameters<CableFleet['setSettings']>[1])
      .then((result) => { if (!result.ok) log(`[cable] settings for ${id || 'no device'}: ${codeOrLength(result.error)}`) })),
    windowFocus: (next) => {
      focus = next
      // State replay after a service restart carries windowFocus, without another appFocus event.
      const selected = next.voice
      if (selected) part.call('dial', () => cable.followApp(selected.machineId, selected.agentId))
      part.call('window', () => windowSelection.focusChanged())
    },
    windowReply: (kind, connId, machineId, payload) => part.call('window', () =>
      (kind === 'form' ? windowForm : kind === 'visit' ? windowVisit : windowSelection).reply(connId, machineId, payload)),
    windowGone: (connId) => part.call('window', () => {
      windowForm.disconnected(connId)
      windowSelection.focusChanged()
    }),
    // ⌘K in the window: a typed task, and which agent it belongs to, on any of the owner's machines.
    routeTask: async (text) => fleet ? fleet.routeTask(text) : unrouted(NO_AGENT_LIST),
    // Committed, through the fleet's router — the dial's own dispatch — so a remote agent is reached on its
    // own machine instead of being looked for in this computer's registry.
    routeSend: async (agentId, text): Promise<SendResult> => {
      const sent = fleet?.routeSend(agentId, text) ?? { ok: false as const, machine: '', reason: NO_AGENT_LIST }
      // The refused machine's name stays in the reply: the fleet's router logs that machine by its id.
      log(`[route] ⌘K → ${sid(agentId)} · bytes=${Buffer.byteLength(text, 'utf8')}`
        + (sent.ok ? '' : ` · REFUSED: ${SEND_REFUSALS.has(sent.reason) ? sent.reason : codeOrLength(sent.reason)}`))
      return sent
    },
    // The Wi-Fi device borrows the dial's walk along the desk and its stroke, until it is one of the devices.
    stepFocus: (direction, currentAgentId) => cableHost.stepFocus(direction, currentAgentId),
    scroll: (phase, dy, velocity) => cableHost.scrolled(phase, dy, velocity),
    // The voice router warms a worker on an engine the machine runs, while a device is watching.
    engines: (engines) => setVoiceRouterSessions(engines.map((engine) => ({ engine }))),
    commanders: (connected) => setVoiceRouterDeviceConnected(connected),
    // The mod's poll, as the core checked and bounded it (core/deviceHookCalls.ts).
    inboxPoll: async (poll) => (inboxCalls ? inboxCalls.inboxPoll(poll) : { off: true }),
    inboxGone: (pollId) => inboxCalls?.inboxGone(pollId),
    // The serial ports first: a port left held makes esptool fail in a way that reads like dead hardware.
    stop: async () => {
      // A cable still waiting on the listener never starts, and a stroke's answer landing from here on sends nothing.
      stopped = true
      // A stop is not an ending: the detach below and a listing source's emptied list end cards in memory, and the next
      // start must still find them, so the file takes what was waiting and nothing after.
      part.call('notices', () => noticeFile.close())
      // So too the counts: the stop's own detach and endings are not the person's.
      count((usage) => usage.stop())
      part.call('dialUsage', () => usageFile.close())
      herdrApp.stop()
      // The listener before anything, once it has opened: no front reaches a stopped cable or sets a timer after the
      // timers below are cleared.
      await (await listening)?.close()
      for (const agentId of [...replies.keys()]) endReplies(agentId, false)   // no timer may fire into a stopped cable
      for (const timer of timers) clearInterval(timer)
      for (const timer of [...endings.values(), ...leavings.values()]) clearTimeout(timer)
      for (const timer of pending) clearTimeout(timer)
      tabReport = undefined
      lastTabs.clear()
      editorClients.clear()
      selects.clear()
      threadReport = undefined
      codexSwitches.clear()
      endHookCalls()
      dialAttached(false)
      await cable.stop()
      fleet?.stop()
      shutdownVoiceRouter()
    },
  }
  ports.devices = port

  // The Devices tab: physical devices belong to this machine, and only its owner may manage them.
  const tab = {
    status: () => cableHost.currentDialStatus(),
    revision: () => revision,
    set: (id: string, patch: Parameters<CableFleet['setSettings']>[1]) => cable.setSettings(id, patch),
    pets: () => pets,
    // The first attached dial's state; a changed mapping is sent to every live dial.
    petDial: () => cable.petDial(),
    petsChanged: () => { void cable.petsChanged() },
  }
  const answer = (type: string) => (payload: Record<string, unknown>, asker: { local?: boolean; owner: boolean }) =>
    asker.owner ? harnessDevicesRequest(tab, type, payload) : { error: 'OWNER_REQUIRED' }
  /**
   * A window's frames (core/api.ts `SERVICE_WS_FRAMES`), checked as the local WebSocket checked them before they left the
   * core: ⌘K's pick (an empty task picks no agent), its send (nothing to send without both), and its answer to a spoken
   * task, whose states other than the three are dropped rather than guessed at: an answer this side cannot read must not
   * settle a spoken turn as though it had been understood. A window's only, on this computer.
   */
  const windowFrame = async (payload: Record<string, unknown>, asker: { local?: boolean; owner: boolean }): Promise<Record<string, unknown>> => {
    if (!asker.local || !asker.owner) return { error: 'LOCAL_ONLY' }
    const frame = (payload.payload && typeof payload.payload === 'object' ? payload.payload : {}) as Record<string, unknown>
    const said = (field: string): string => (typeof frame[field] === 'string' ? frame[field] as string : '')
    if (payload.frame === 'route_task') {
      const task = said('text').trim()
      return { ...(task ? await port.routeTask(task) : unrouted('empty task')) }
    }
    if (payload.frame === 'route_send') {
      const sent = said('agentId') && said('text') ? await port.routeSend(said('agentId'), said('text')) : { ok: false as const, machine: '', reason: 'nothing to send' }
      return sent.ok ? { ok: true } : { ok: false, machine: sent.machine, reason: sent.reason }
    }
    if (payload.frame === 'voice_route_reply') {
      const voiceId = said('voiceId'), state = said('state')
      const reply = state === 'taken' ? { t: 'taken' as const } : state === 'sent' ? { t: 'sent' as const, agentId: said('agentId') } : state === 'cancelled' ? { t: 'cancelled' as const } : null
      if (voiceId && reply) part.call('window', () => windowRouter.reply(voiceId, reply))
      return {}
    }
    return { error: 'UNKNOWN_FRAME' }
  }
  // Pets name files on this computer by path, so they are answered to a process here only, never the owner's relayed app.
  const local = (type: string) => (payload: Record<string, unknown>, asker: { local?: boolean; owner: boolean }) =>
    !asker.owner ? { error: 'OWNER_REQUIRED' } : asker.local ? harnessDevicesRequest(tab, type, payload) : { error: 'LOCAL_ONLY' }
  return {
    harness_devices_list: answer('harness_devices_list'), harness_device_settings: answer('harness_device_settings'),
    pet_preview: local('pet_preview'), pet_apply: local('pet_apply'), pet_reset: local('pet_reset'), pet_status: local('pet_status'),
    devices_ws: (payload, asker) => windowFrame(payload, asker),
  }
}
