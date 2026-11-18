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
import { existsSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { createOwnerCommands } from './ownerCommands.js'
import { env } from '../config/env.js'
import { DEVICES_FALLBACKS, DEVICES_REQUESTS, type CoreApi, type CorePorts, type DeviceHookPort, type DevicesPort, type RouteAnswer, type SendResult, type ServiceRequests, type WindowFocus } from '../core/api.js'
import { CableFleet, testDialDiscovery, type CableFleetOptions } from '../cable/cableFleet.js'
import { isLocalOnly } from '../lib/cardUpdate.js'
import { TurnStats, type TurnStatsFields } from '../cable/turnStats.js'
import { cableEventFor, cableStepFor, cableQuestionCloseFor, cableQuestionFor, DaemonCableHost } from '../cable/cableHost.js'
import { CableSession, SHOWN_ONLY_PREFIX, type DialStatus, type FollowCause } from '../cable/cableSession.js'
import type { HostAdapter, Pane } from '../cable/hosts/adapter.js'
import { createClaudeAppAdapter } from '../cable/hosts/claudeApp.js'
import { cmuxClientDeps, cmuxStoreDir, cmuxStores, createCmuxClient, type CmuxClient } from '../cable/hosts/cmuxCli.js'
import { createCmuxAppAdapter } from '../cable/hosts/cmuxApp.js'
import { CmuxSource } from '../cable/hosts/cmuxSource.js'
import { watchNearest } from '../cable/hosts/folderWatch.js'
import { createCodexAppAdapter } from '../cable/hosts/codexApp.js'
import { codexQueueDeps, createCodexQueue, type CodexQueueDeps } from '../cable/hosts/codexQueue.js'
import { createHcClient, hcClientDeps, hcPaneKey, hcSocketPath, type HcClient } from '../cable/hosts/hcClient.js'
import { HcSource } from '../cable/hosts/hcSource.js'
import { createHerdrAdapter } from '../cable/hosts/herdr.js'
import { createHerdrAppAdapter } from '../cable/hosts/herdrApp.js'
import { createHerdrClient, herdrClientDeps, type HerdrClient } from '../cable/hosts/herdrClient.js'
import { HerdrSource } from '../cable/hosts/herdrSource.js'
import { Inbox } from '../cable/hosts/inbox.js'
import { LAST_ANSWER_DEADLINE_MS, LAST_ANSWER_MAX_BYTES, readLastAnswer } from '../cable/hosts/lastAnswer.js'
import { askedLine, countWord, hostDisplayName, observedAgentId, ObservedSource, type ObservedActions, type ObservedDeps, type PromptSource } from '../cable/hosts/observed.js'
import { observedPlaces } from '../cable/hosts/observedPlaces.js'
import { createOpenActions } from '../cable/hosts/open.js'
import { createOpencodeClient, opencodeClientDeps, opencodeMessageId, type OpencodeClient } from '../cable/hosts/opencodeClient.js'
import { OpencodeSource } from '../cable/hosts/opencodeSource.js'
import { createOrcaAdapter, createOrcaReads, orcaDeps, type OrcaFocusWatch, type OrcaReadDeps, type OrcaReads, type OrcaTerminal } from '../cable/hosts/orca.js'
import { readRecordName } from '../cable/hosts/recordName.js'
import { HostRegistry, type HostEntry } from '../cable/hosts/registry.js'
import { learnApps, readProcessNames } from '../cable/hosts/scannedApp.js'
import { createScrollLines } from '../cable/hosts/scrollLines.js'
import { createTabsAdapter, readTty, type Tab } from '../cable/hosts/tabs.js'
import { createTmuxAdapter } from '../cable/hosts/tmux.js'
import type { HostAgent, HostAgentState } from '../cable/hosts/types.js'
import { watchSocket } from '../cable/hosts/unixSocket.js'
import { createVscodeAdapter, termPid } from '../cable/hosts/vscode.js'
import { readProcessParents, vscodeStreams, type VscodeTerminal, type VscodeTerminalsDeps } from '../cable/hosts/vscodeTerminals.js'
import { createWeztermAdapter } from '../cable/hosts/wezterm.js'
import { createEngineTally } from '../cable/engineTally.js'
import { createVscodeExtensionSetup } from '../cable/vscodeExtensionSetup.js'
import { Notices, type NoticeCaller } from '../cable/notices.js'
import { NOTIFY_MODE_FILE, NotifyModeStore, type NotifyMode } from '../cable/notifyMode.js'
import { PetStore } from '../cable/pets/store.js'
import { DialLog } from '../cable/dialLog.js'
import { DialVerdicts } from '../cable/dialPortVerdicts.js'
import { createDialSetup } from '../cable/dialSetup.js'
import { claudeFound, type ClaudeRun } from '../devices/claudePlugin.js'
import { readRemoved, SETUP_COUNTS } from '../devices/dialSkillFiles.js'
import { createOrcaHomesCache, orcaHomesDeps, readOrcaHomes, type OrcaHomesCache } from '../devices/orcaHomes.js'
import { vscodeExtensionDeps, type VscodeExtensionDeps } from '../devices/vscodeExtension.js'
import { WindowForm } from '../cable/windowForm.js'
import { createWindowRouter } from '../cable/windowRoute.js'
import { WindowSelection } from '../cable/windowSelection.js'
import { WindowVisit } from '../cable/windowVisit.js'
import { MachineListCache } from '../device/machineList.js'
import type { NoticeAsk, NoticeResult } from '../lib/dialNotice.js'
import { claudeProjectsRoots, codexHomeRoots, movedEngineHomes } from '../lib/engineHomes.js'
import { harnessDevicesRequest } from '../lib/harnessDevices.js'
import { pidAlive } from '../lib/processProof.js'
import { OpenSessions, SessionRows } from '../lib/sessionSearch/external.js'
import { externalProviders } from '../lib/sessionSearch/externals/index.js'
import { fileStamp, listProcesses, processAlive } from '../lib/sessionSearch/externals/support.js'
import { setVoiceRouterDeviceConnected, setVoiceRouterSessions, shutdownVoiceRouter } from '../lib/voiceRouter.js'
import { createTally, createTierDecider, type Tier, type TierDecision, type TierInput } from '../lib/notifyTier.js'
import { VERSION } from '../version.js'
import { createPartGuard } from './devicesGuard.js'
import { attachHandler, dialStream, frontHandler, noticeHandler, notifyHandler, tabHandler, tabsStream, type DevicesListener, type ListenerHandler, type ListenerStreamHandler } from './devicesListener.js'
import { FLEET_FALLBACKS, startFleet, type Fleet } from './fleet.js'

export { DEVICES_REQUESTS }

/** What the devices need that is not the core's to give. */
export interface DevicesDeps {
  /** Direct gestures for the Wi-Fi component in this worker; no core callback or socket hop. */
  onDesk?: (desk: import('./deviceDesk.js').DeviceDesk) => void
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
  /** Called with a function this part runs whenever its link to the core drops: the calls that core held have failed. */
  onCoreGone?: (run: () => void) => void
  /** Old cores' private route calls, retained only in this service process until 2026-12-16. */
  onLegacyCommands?: (handlers: ServiceRequests) => void
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
  /** For this service's tests: how `codex` is found and run (cable/hosts/codexQueue.ts). */
  codex?: Pick<CodexQueueDeps, 'run' | 'binary' | 'platform'>
  /** For this service's tests: herdr's socket (cable/hosts/herdrClient.ts). */
  herdr?: HerdrClient
  /** For this service's tests: Herdr Core's socket (cable/hosts/hcClient.ts). */
  hc?: HcClient
  /** For this service's tests: cmux's own command line (cable/hosts/cmuxCli.ts). */
  cmux?: CmuxClient
  /** For this service's tests: opencode's service (cable/hosts/opencodeClient.ts). */
  opencode?: OpencodeClient
  /** Opens the devices' own listener with these handlers (services/devicesListener.ts). Given by the devices process
   *  alone: inside the core's process (`HARNESSD_SERVICES=none`, Harness OS) there is none, so the core's process opens
   *  no socket for the devices, and the dial follows no app in front there. */
  listen?: (handlers: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>>, log: (line: string) => void) => Promise<DevicesListener | null>
  /** For this service's tests: how an agent's tty is read; `ps` by default (cable/hosts/tabs.ts). */
  tty?: (pid: number) => Promise<string | undefined>
  /** For this service's tests: the process table VS Code's terminals are matched by; `ps` by default
   *  (cable/hosts/vscodeTerminals.ts). */
  processParents?: VscodeTerminalsDeps['processes']
  /** For this service's tests: how Claude Code is found for a Claude Code home; the daemon's own lookup by default
   *  (devices/claudePlugin.ts claudeFound). */
  claude?: (home: string, shell: boolean) => Promise<ClaudeRun | null>
  /** For this service's tests: Orca's account homes (devices/orcaHomes.ts); read with this computer's `orca` when unset. */
  orcaHomes?: OrcaHomesCache
  /** For this service's tests: how VS Code and Harness's extension in it are found and `code` is run; the real ones by
   *  default (devices/vscodeExtension.ts). */
  vscodeExtension?: VscodeExtensionDeps
}

/** ⌘K's answer while the fleet is not running: it never started, so there is no list to weigh. */
const NO_AGENT_LIST = 'no agent list yet'
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
}
/** A tab app reports back each tab the dial selects, and Orca each pane it switches to: a report within this long of the
 *  dial's move there is that move's echo. Every move of that long is kept, as a fast swipe's late report for a place it
 *  passed must not pull the dial back, and at most ECHO_KEPT of them. */
const TAB_ECHO_MS = 2_000
const ECHO_KEPT = 8

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
/** How long the cable waits for the devices' listener to open: it opens in a few milliseconds. */
const LISTENER_WAIT_MS = 1_000
/** How long after the dial's own continue link to a Claude app session an attach is that link's echo: the app attaches
 *  the session it shows within about a second. Also how long any move of the dial sets the Claude app's settle aside. */
const ATTACH_ECHO_MS = 2_000

/** Orca's account homes on this computer, read with its own `orca` (devices/orcaHomes.ts). */
function orcaHomesCache(now: () => number, log: (line: string) => void): OrcaHomesCache {
  const system = orcaHomesDeps()
  return createOrcaHomesCache({ read: () => readOrcaHomes(system), now, platform: system.platform, log })
}

/** This computer's agents outside a pane, read with ⌘P's readers (services/externalSessions.ts) in the daemon's own homes
 *  and Orca's account homes, and how the dial's voice and tap reach them. */
function observedSource(
  dataDir: string, log: (line: string) => void, orcaHomes: Pick<OrcaHomesCache, 'get'>, actions: ObservedActions,
  tty: ObservedDeps['tty'], scanned: ObservedDeps['scanned'], herdrTerminal: ObservedDeps['herdrTerminal'],
): ObservedSource {
  // Worked out at each read: a home the person moved is adopted while the daemon runs, and Orca's follow its last read.
  const places = observedPlaces({
    claudeRoots: () => claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR),
    codexRoots: () => codexHomeRoots(env.CODEX_HOME),
    orca: () => orcaHomes.get(),
  })
  const providers = externalProviders(undefined, places)
  return new ObservedSource({
    now: Date.now,
    processes: listProcesses,
    alive: processAlive,
    openSessions: new OpenSessions({ providers, log }),
    sessionRows: new SessionRows({ providers, excluded: [dataDir], log }),
    excluded: [dataDir],
    // Asked for Claude Code's and Codex's alone (observed.ts), and read only inside their own folders: a hook can name any path.
    lastAnswer: (engine, path) => readLastAnswer(engine as 'claude' | 'codex', path, {
      roots: engine === 'claude' ? places.claude.roots() : places.codex.roots().map((home) => join(home, 'sessions')),
      maxBytes: LAST_ANSWER_MAX_BYTES, deadlineMs: LAST_ANSWER_DEADLINE_MS,
    }),
    fileStamp,
    log,
    actions,
    apps: learnApps,
    // Asked for Claude Code's sessions alone (observed.ts), and read only inside its own records folders.
    recordName: (owner) => readRecordName(owner, { records: places.claude.records() }),
    tty,
    scanned,
    herdrTerminal,
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
  // a listener that failed to open, Windows) the menu must not offer a setting no click can change.
  const notifyMode = new NotifyModeStore(join(core.dataDir, NOTIFY_MODE_FILE))
  let listenerOpen = false
  const sayStatus = (status: DialStatus): void => core.clients.sendLocal({ type: 'dial_status',
    payload: { ...status, ...(listenerOpen ? { notify: notifyMode.get() } : {}) } })

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
  const fleet: Fleet | null = part.start('fleet', () => startFleet(core, { machines, desk: () => desk, refresh: deps.refresh }).fleet, FLEET_FALLBACKS)

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
  const inbox = new Inbox({ now: monotonic, after: timerIn('inbox') })
  const apps = deps.orca ?? orcaDeps()
  /** Where herdr's socket is, from the daemon's own environment: the client reads it, and the herdr source watches for it. */
  const herdrAt = herdrClientDeps()
  const herdrClient = deps.herdr ?? createHerdrClient(herdrAt)
  const herdrAdapter = createHerdrAdapter({ ...apps, client: herdrClient })
  /** `HARNESS_OPEN_BIN`: the end-to-end tests' fake `open`, run for each `open -b` (cable/hosts/open.ts). */
  const openBin = process.env.HARNESS_OPEN_BIN
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
    reports: (address) => hcSource?.reports(address) === true })
  const hcPane = (address: string): Pane => ({ adapter: herdrApp.id, id: address })
  const cmuxClient = deps.cmux ?? createCmuxClient({ ...cmuxClientDeps(), platform: apps.platform })
  /** cmux is installed, as the last attach found it: only then are a hooked agent's words offered to it. */
  let cmuxFound = false
  const cmuxApp = createCmuxAppAdapter({ ...apps, client: cmuxClient, bin: openBin, found: () => cmuxFound,
    inFront: () => cableHost.latestFront() === 'cmux', kindAt: (surface) => cmuxSource?.kindAt(surface) })
  const cmuxPane = (pane: string): Pane => ({ adapter: cmuxApp.id, id: pane })
  const claude = createClaudeAppAdapter({ ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'claude' })
  // Harness's own Codex home, whose config `codex queue` loads; run from the home folder, so no project's .codex/ is read.
  const codexQueue = createCodexQueue({ ...(deps.codex ?? codexQueueDeps()), home: env.CODEX_HOME, cwd: homedir() })
  // The stream a watch holds open on the devices' listener: a rest or a tap on an agent in Terminal, iTerm2 or Ghostty
  // asks it to select that agent's tab (docs/specs/2026-11-15-dial-terminal-follow.md). Only macOS's apps select a tab
  // by its tty: elsewhere no agent's is read, and none has a tab.
  const tabs = tabsStream()
  // The stream Orca's Harness Device plugin holds open: whether a dial is attached and the agent it shows
  // (docs/specs/2026-11-16-orca-device-plugin.md). A part of its own, so a throw on its path is never the dial's. Its
  // count's timer stops with the devices.
  const dial = dialStream({ log, after: timerIn('dialStream') })
  // The streams Harness's own VS Code extension holds open, one a window, and the terminal each VS Code agent runs in
  // (docs/plans/2026-11-17-dial-vscode-extension-design.md). An adapter's capabilities are read at each look, so a
  // terminal found or lost tells the dials to look again.
  const vscode = vscodeStreams({
    processes: deps.processParents ?? readProcessParents,
    changed: () => part.call('dial', () => cable.syncAgents()),
    now: monotonic,
    after: timerIn('vscode'),
    log,
  })
  const ttyOf = apps.platform === 'darwin' ? deps.tty ?? readTty : undefined
  /** Where the dial moved an app lately, a rest's and a tap's alike, each as it started: the echoes an app's report is
   *  checked against, each excusing one. */
  const dialMovesTo = () => {
    let kept: Array<{ id: string; at: number }> = []
    return {
      note(id: string): void {
        const at = monotonic()
        kept = [...kept.filter((sent) => at - sent.at < TAB_ECHO_MS), { id, at }].slice(-ECHO_KEPT)
      },
      /** Whether a report of `id` made at `at` is an echo. The app runs the moves in order, so one before it will see no
       *  echo now (replaced while it waited, or its place already shown): it goes too. */
      echo(id: string, at: number): boolean {
        const found = kept.findIndex((sent) => sent.id === id && at - sent.at < TAB_ECHO_MS)
        if (found >= 0) kept = kept.slice(found + 1)
        return found >= 0
      },
      clear(): void { kept = [] },
    }
  }
  /** The ttys the dial selected lately. */
  const selects = dialMovesTo()
  /** The Orca panes the dial switched to lately. */
  const orcaSwitches = dialMovesTo()
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
  /** herdr's adapter as the dial's verbs reach it: a tap on an agent herdr lists (below) is the dial's own move too. */
  const herdrNoted = noting(herdrAdapter)
  /** Herdr's adapter as the dial's verbs reach it: a tap or a rest on an agent hc lists (below) is the dial's own move. */
  const herdrAppNoted = noting(herdrApp)
  /** cmux's adapter as the dial's verbs reach it: a tap or a rest on an agent cmux lists (below) is the dial's own move. */
  const cmuxAppNoted = noting(cmuxApp)
  /** Each Orca terminal's worktree, by handle, from the latest layout read that landed (below): a rest's or a tap's
   *  switch activates it first. */
  let orcaWorktrees: ReadonlyMap<string, string> = new Map()
  /** The apps an outside agent runs in, in the order its panes are kept: each verb of the dial takes the first that can.
   *  The nearest host first: a multiplexer keeps the environment it started in, so in a tmux pane WezTerm's and Orca's
   *  values name the terminal the tmux server began in, and herdr inside tmux carries tmux's pane. Herdr and cmux come
   *  after tmux, as a tmux inside their terminal is the nearer host, and before the terminals: each tells its programs
   *  they run in Ghostty, whose tabs hold none of them. */
  const tmux = noting(createTmuxAdapter({ run: apps.run, processes: readProcessNames, log }))
  const orca = createOrcaAdapter(apps, { worktreeOf: (handle) => orcaWorktrees.get(handle), log, switching: (handle) => orcaSwitches.note(handle) })
  const adapters: readonly HostAdapter[] = [herdrNoted, tmux, herdrAppNoted, cmuxAppNoted, ...[
    createWeztermAdapter(apps),
    // A rest's or a tap's switch: Orca's focus line for that pane, a moment later, is the dial's own echo.
    { ...orca,
      show: (pane: Pane, agentId: string) => { orcaSwitches.note(pane.id); return orca.show(pane, agentId) },
      focus: (pane: Pane) => { orcaSwitches.note(pane.id); return orca.focus(pane) } },
    // A rest's continue link: the app's attach that follows is the dial's own echo.
    { ...claude, show: (pane: Pane, agentId: string) => { noteLink(agentId); return claude.show(pane, agentId) } },
    // No echo to guard: the Codex app sends no attach for the follow to take as a person's.
    createCodexAppAdapter({ ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'codex', log }),
    // No echo to guard: VS Code sends no attach for the follow to take as a person's.
    createVscodeAdapter({ ...apps, bin: openBin, inFront: () => cableHost.latestFront() === 'vscode', terminals: vscode }),
    createTabsAdapter({
      isOpen: () => tabs.isOpen(),
      select: (tab, raise) => {
        if (!tabs.select(tab, raise)) return false
        selects.note(tab.tty)
        return true
      },
    }),
  ].map(noting)]
  const opener = createOpenActions({ run: apps.run, platform: apps.platform, adapters, log, bin: openBin,
    // herdr's ring is Herdr.app's window's while it holds an agent there: one hc lists, or a hooked agent with a pane
    // of Herdr's (herdrApp.ts paneOf). herdr 0.8.0's agents have none. Only this process's own lists are read, which
    // the pick read a moment before: it never throws, and a pick's bring has no catch.
    herdrApp: () => !!hcSource?.list().length
      || !!observed?.list().some(({ paneKeys }) => paneKeys?.some((key) => key.startsWith(hcPaneKey('')))) })
  const bring = opener.bring
  /** The route or the refusal of the dial's words, and why a queue failed: never the words, the session, the terminal or a
   *  path. */
  const voiced = (what: string): void => log(`[device] voice · ${what}`)
  /** The Claude Code and Codex homes Orca's accounts run in, which Harness has not adopted: the open scan and the dial
   *  skill reach them too (docs/plans/2026-11-17-new-user-onboarding-design.md, "C. Orca homes"). */
  const orcaHomes = deps.orcaHomes ?? orcaHomesCache(monotonic, log)
  // The dial skill in each home an engine's sessions use and Claude Code's plugin, set up once a dial has attached on this
  // computer (cable/dialSetup.ts), in the devices' own process alone: inside the core's (`HARNESSD_SERVICES=none`) there
  // is no listener, so a skill would name a `harness device notify` that cannot ring. A part of its own, so a throw in a
  // person's home is never the dial's.
  const skill = deps.listen ? createDialSetup({
    dataDir: core.dataDir,
    platform: apps.platform,
    uid: process.getuid?.() ?? -1,
    claudeHome: dirname(env.CLAUDE_PROJECTS_DIR),
    codexHome: env.CODEX_HOME,
    // Read at each start pass: the adopted homes, and Orca's as its last read gave them.
    adopted: () => {
      const moved = movedEngineHomes()
      const orca = orcaHomes.get()
      return { claude: [...moved.claude, ...orca.claude], codex: [...moved.codex, ...orca.codex] }
    },
    removed: () => readRemoved(core.dataDir),
    now: monotonic,
    count: createEngineTally('[device] dial setup', ['claude', 'codex'], SETUP_COUNTS, log),
    log,
    claude: deps.claude ?? claudeFound,
    orcaClaude: () => ({ homes: orcaHomes.get().claude, answered: orcaHomes.answered() }),
    version: VERSION,
  }) : null
  /** The dial setup's start pass, after a read of Orca's homes: the first, and each that changes them. A read that lands
   *  once the devices stopped starts none. */
  const skillPass = (): void => {
    if (skill && !stopped) part.call('skill', () => skill.started())
  }
  // Harness's VS Code extension, set up once a computer through the dial setup's record (cable/vscodeExtensionSetup.ts),
  // in the devices' own process alone, as the dial setup: inside the core's the core would run VS Code's `code`. A part
  // of its own, so a throw in VS Code's files is never the dial's. `HARNESS_VSCODE_BIN`: the end-to-end tests' VS Code,
  // so a daemon under test finds none of this computer's own (devices/vscodeExtension.ts).
  const vscodeCount = createEngineTally('[device] vscode extension', ['vscode'], SETUP_COUNTS, log)
  const vscodeSetup = skill ? createVscodeExtensionSetup({
    vscode: deps.vscodeExtension ?? vscodeExtensionDeps(process.env.HARNESS_VSCODE_BIN),
    removed: () => readRemoved(core.dataDir),
    recorded: () => skill.vscode(),
    record: (version) => skill.recordVscode(version),
    after: timerIn('vscodeExtension'),
    count: (kind, reason) => vscodeCount('vscode', kind, reason),
  }) : null
  const observed = env.HARNESS_DEVICE_OBSERVED ? observedSource(core.dataDir, log, orcaHomes, {
    adapters,
    modReady: (sessionId) => inbox.ready(sessionId),
    toMod: (sessionId, text) => inbox.deliver(sessionId, text),
    canOpen: opener.can,
    // Noted before `open -b`, which can take a while, and for an app with no pane of its own. A tap on a Claude app agent
    // runs the continue link a rest runs: its attach is the dial's own echo too.
    open: (agentId, target) => {
      noteMove()
      if (target.pane?.adapter === claude.id && opener.can(target)) noteLink(agentId)
      return opener.open(agentId, target)
    },
    codexQueue,
    codexHome: env.CODEX_HOME,
    count: (what) => voiced(countWord(what)),
  }, ttyOf, skill ? (owners) => part.call('skill', () => skill.scanned(owners.values())) : undefined,
  // Only where a hook's address is taken: following another hc session, Herdr's adapter gives its terminals no pane, so
  // a session paired there would be listed twice on Herdr's page.
  hookIds ? (pid): string | undefined => hcSource?.terminalOf(pid) : undefined) : null
  // Orca is asked only for the parts that use its homes, the first time as the devices start: the start pass waits for
  // that read (at most its 5 s), so an Orca home gets the skill with the default one.
  if (skill || observed) void orcaHomes.refresh().then(() => {
    skillPass()
    // After the dial setup's start pass, which reads the record VS Code's goes by (dialHomeSetup.ts vscode()).
    if (vscodeSetup && !stopped) part.call('vscodeExtension', () => vscodeSetup.pass())
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
   *  It runs only while a dial is attached, as the open scan does, behind the observed agents' switch, and never on
   *  Windows, where herdr's socket is a named pipe (herdrSource.ts). */
  const herdr = observed ? new HerdrSource({
    client: herdrClient,
    watch: (changed) => watchSocket(herdrAt, changed),
    prompt: herdrAdapter.prompt,
    // The command a hooked agent's tap runs (Q6): the dial's move is noted as every tap's is. Only a shown pane is true:
    // herdr's adapter never refuses one, though the noted copy is typed as any adapter's.
    focus: async (paneId) => (await herdrNoted.focus({ adapter: herdrAdapter.id, id: paneId })) === true,
    after: timerIn('herdr'),
    now: Date.now,
    monotonic,
    uuid: randomUUID,
    platform: apps.platform,
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
  /** The terminal the dial's scroll goes to: the shown agent's, while VS Code is in front (the rule a swipe uses) and a
   *  window holds it (docs/plans/2026-11-17-dial-vscode-extension-design.md, §4). */
  const scrollTerminal = (): VscodeTerminal | undefined => {
    const agentId = cableHost.latestFront() === 'vscode' ? cableHost.shownAgentId() : undefined
    const pid = agentId === undefined ? undefined : termPid(observed?.paneOf(agentId, 'vscode') ?? '')
    return pid === undefined ? undefined : vscode.terminalOf(pid)
  }
  /** The route the stroke on the glass took at its `down`, kept to its `up`: Harness's windows are never left holding a
   *  drag whose `up` went to VS Code. A `move` or an `up` with no `down` before it chooses then. */
  let stroke: { terminal: VscodeTerminal; lines: ReturnType<typeof createScrollLines> } | 'windows' | undefined
  const routeScroll = (phase: 'down' | 'move' | 'up', dy: number, velocity: number): void => {
    let route = stroke
    if (phase === 'down' || !route) {
      const terminal = scrollTerminal()
      route = terminal ? { terminal, lines: createScrollLines() } : 'windows'
    }
    stroke = phase === 'up' ? undefined : route
    if (route === 'windows') core.clients.sendLocal({ type: 'dial_scroll', payload: { phase, dy, velocity } })
    // Whole lines, and an up's velocity is not played: the scroll stops where the finger stops. A window that went takes
    // nothing more of the stroke, which never turns to Harness's windows midway.
    else vscode.scroll(route.terminal, route.lines.take(phase, dy))
  }

  const cableHost = new DaemonCableHost({
    // The cloud harnesses too, where the core offers them: tiles on the desk the dial walks like any other.
    sessions: () => [...core.agents.advertised(), ...core.agents.cloud?.() ?? []],
    refresh: deps.refresh,
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
    watching: (on) => {
      core.clients.dialWatching(on)
      // Before the scan the attach starts, so that scan finds the dial recorded; and before VS Code's pass, which reads it.
      if (on && skill) part.call('skill', () => skill.attached())
      if (on && vscodeSetup) part.call('vscodeExtension', () => vscodeSetup.pass())
      dialAttached(on)
      part.call('dialStream', () => dial.attached(on))
    },
    dialShows: (agent) => part.call('dialStream', () => dial.shows(agent)),
    // The core's own doors for a local agent. The fleet's router reaches them the same way; the dial uses
    // these only when it routes by itself, with the fleet off. An agent outside a pane never reaches them: the host shuts
    // each to it, the fleet's way too (cableHost.ts `outside`).
    sendTurn: (agentId, text) => core.turns.send(agentId, text),
    stopTurn: (agentId) => core.turns.stop(agentId),
    answer: (agentId, requestId, answers) => core.questions.answer(agentId, requestId, answers),
    answerReviewed: (answer) => core.questions.answerReviewed(answer),
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
    // A person's tap on an agent, a notice's "In <app>" among them, brings them to it: its notice goes. Opening the alert to
    // read it does not.
    tapped: (agentId) => endNotice(agentId),
    noticeFrom: (agentId) => notices.from(agentId),
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
    turned: noteMove,
    localFollowed: (cause, outcome) => log(FOLLOWED[cause === 'attach' ? attachAsk : cause][outcome]),
    swarmSelected: (swarmId) => core.clients.sendLocal({ type: 'dial_swarm', payload: { swarmId } }),
    // Guarded as a notice into the dial is: a throw on the scroll path (a window's stream) is logged, never the session's.
    scrolled: (phase, dy, velocity) => part.call('dial', () => routeScroll(phase, dy, velocity)),
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
    // (docs/specs/2026-11-15-dial-claude-app-follow.md), and any app's judges the tab report waiting on it. Each guarded on
    // its own: the filter drops what this answers, so a follow that rejects would go unseen, and one that throws would
    // cost the other its settle.
    appSettled: (app) => {
      if (app === 'claude') part.call('dial', claudeSettled)
      if (app === 'orca' && observed) part.call('orca', () => orcaSettled(observed))
      part.call('dial', () => tabSettled(app))
    },
    appPicked: () => log('[device] app filter: picker'),
    // A pick on the dial brings its app to the front, on macOS only (docs/plans/2026-11-16-dial-pick-brings-app-design.md).
    // A measure: the outcome, never the app; a pick with nothing to bring, or replaced by a later one, ran nothing.
    appBrought: bring && ((app) => {
      void bring(app).then((outcome) => { if (outcome) log(`[device] app filter: bring · ${outcome}`) })
    }),
    // A tap on a Harness agent with no window starts Desktop, on macOS only (docs/specs/2026-11-15-device-wave1-checks.md,
    // F2).
    launchDesktop: opener.desktop,
    // A measure: the app's name only.
    desktopTimedOut: () => log('[device] open · harness · no window'),
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
  const registry = new HostRegistry([cableHost.harness, observed, herdr, hcSource, cmuxSource, opencode].filter((source) => source !== null))
  cableHost.setRegistry(registry)
  // The dial's log lives with the app's, one file a day (dialLog.ts). The old unbounded `dial.log` in the
  // data folder is cut down to a pointer, for anyone with a bookmark.
  const legacyDialLog = join(core.dataDir, 'dial.log')
  if (existsSync(legacyDialLog)) {
    try { writeFileSync(legacyDialLog, `moved to ${join(deps.logsDir, 'dial-YYYYMMDD.log')}\n`) } catch { /* best effort */ }
  }
  const cable = new CableFleet(deps.Session ?? CableSession, cableHost, deps.logsDir, DialLog, {
    serials: deps.dialSerials,
    verdicts: new DialVerdicts(join(core.dataDir, 'dial-ports.json')),
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
  /** When each agent's turn began (the first `processing`), for the summary's duration. */
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

  /** One card for the dial, in its four calls. A remote machine's and this computer's are the same calls,
   *  so a new kind of card lands on both the day it lands on either. [notice]: its agent's notice was pending as the
   *  card came (toDial). */
  const dispatch = (event: DialEvent, notice: boolean): void | Promise<void> => {
    if (event.kind !== 'processing') latestUpdate.delete(event.agentId)
    if (event.kind === 'processing') {
      if (event.update) latestUpdate.set(event.agentId, event.update)
      else latestUpdate.delete(event.agentId)
      if (!began.has(event.agentId)) began.set(event.agentId, Date.now())
      void cable.turnStarted(event.agentId, event.text, event.update)
    } else if (event.kind === 'done') {
      const fields = stats.take(event.agentId)
      const at = began.get(event.agentId)
      began.delete(event.agentId)
      ended.set(event.agentId, { durationS: at === undefined ? null : Math.round((Date.now() - at) / 1000),
        stats: { testsPassed: fields.testsPassed, testsFailed: fields.testsFailed, commits: fields.commits } })
      const start = starts.get(event.agentId)
      starts.delete(event.agentId)
      const finish = (tokens: Pick<TurnStatsFields, 'tokensIn' | 'tokensOut'>): void => {
        const all = { ...fields, ...tokens }
        if (Object.keys(all).length) void cable.turnStats(event.agentId, all)
        void cable.turnDone(event.agentId)
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
      if (onScreen || event.subagent) { noted('silent', event.subagent ? 'subagent' : 'onScreen'); void cable.summary(agentId, recap, event.text, 'silent', event.fullText, event.subagent); return }
      // No device attached (or the serial side disabled): nobody to tell, so the recap never leaves the machine.
      if (!cable.isConnected) { ended.delete(agentId); void cable.summary(agentId, recap, event.text, 'silent', event.fullText, false); return }
      const turn = ended.get(agentId) // a sub-agent's summary leaves the main turn's numbers alone
      ended.delete(agentId)
      // Its notice rang for this turn: the dial keeps one drawer row an agent, so a summary that rang or listed would
      // replace the notice's line. A failed turn still rings (docs/plans/2026-11-17-dial-one-ring-per-turn-design.md).
      if (event.failed !== true && notice) { noted('silent', 'notice'); void cable.summary(agentId, recap, event.text, 'silent', event.fullText, false); return }
      const who = cableHost.describe(agentId)
      const needsYou = notifyMode.get() === 'you'
      // Decided once already, by the recaps (services/recaps.ts) or another machine, for the phone as well: the dial
      // follows it and nobody is asked again, but Needs you is this computer's, so an ordinary turn's alert is lowered
      // here. A card without one (a cloud agent's, a recaps from before) is decided here.
      if (event.tier) {
        const lowered = needsYou && event.tier === 'alert' && event.failed !== true
        if (lowered) tally('list', 'rule:needs-you', 'needs-you', 0)
        else tally(event.tier, 'recaps', 'decided upstream', 0)
        void cable.summary(agentId, recap, event.text, lowered ? 'list' : event.tier, event.fullText, false)
        return
      }
      // Returned, so the agent's next card waits behind this one (inOrder): a late recap must not follow turn.started.
      return tierOf({ engine: who?.engine ?? '', recap, durationS: turn?.durationS ?? null,
        stats: turn?.stats ?? {}, subagent: false, onScreen: false, failed: event.failed === true, needsYou })
        .then((d) => d.tier, () => 'list' as const)
        .then((tier) => { void cable.summary(agentId, recap, event.text, tier, event.fullText, false) })
    }
    else {
      began.delete(event.agentId); ended.delete(event.agentId)
      stats.take(event.agentId) // a failed turn's sums must not leak into the next turn
      starts.delete(event.agentId)
      tally('alert', 'rule:failed', 'turn.error', 0)
      void cable.turnError(event.agentId, event.text)
    }
  }
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
    // The last streamed text goes out before the turn's end, in the same per-agent order.
    if (event.kind !== 'processing') endReplies(event.agentId, true)
    // Read as the card comes, not as its turn in the queue does: a summary can wait up to 2 s behind its turn's done
    // (TOKENS_WAIT_MS), and the next turn's start, a message sent while the agent worked, ends the notice meanwhile.
    const notice = event.kind === 'summary' && notices.pending(event.agentId)
    inOrder(event.agentId, () => dispatch(event, notice))
  }

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
    toDial({ ...event, subagent: event.subagent === true })
  }))

  // An agent outside a pane reaches the dial through the same calls, as its state changes. What the dial was told of each
  // is kept, so that a change is told once.
  const told = new Map<string, { state: HostAgentState; line: string | null; answer?: string }>()
  const busyState = (state: HostAgentState): boolean => state === 'working' || state === 'needs-you'
  const busy = ({ agent }: HostEntry): boolean => busyState(agent.state)
  /** Its turn, with the waiting line: the session's activity read right after it (`activityText` above) repeats the line. */
  const started = (entry: HostEntry): DialEvent => ({ kind: 'processing', agentId: entry.agent.id, text: waiting(entry) ?? '', recap: '', subagent: false })
  /** A window is open (its tabs, not null). */
  let windowOpen = false
  /** The dials hold the window's tab, as before there were agents outside a pane, and hear nothing of them: on the tab, or
   *  on an app's ring that no connected dial shows (an older dial or Harness Pro alone holds the tab). What they do is still
   *  noted, so that only a later change is told once the gate opens. */
  const heldOnTab = (): boolean => windowOpen && (cableHost.holdsTab() || !cable.wantsApps())
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
  /** Asks what waits and closes what no longer does (or what a window's tab covers): before a line, which it takes the place of. */
  const showWaits = (): void => {
    const want = new Map<string, HostEntry>()
    if (!heldOnTab()) {
      for (const entry of outsideEntries()) if (entry.source === observed && observed.waitingOn(entry.agent.id) !== undefined) want.set(entry.agent.id, entry)
    }
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
  // `harness device notify`: the agent's own one line for the person, a card every dial pins until that agent's next turn
  // starts, a tap opens it in its app, or it leaves (cable/notices.ts). It takes its own path to the dials, never `tell` or
  // `showWaits`: it is the agent asking for the person, so it rings with a window open on its tab too, which holds an
  // outside agent's turns (heldOnTab), and `showWaits` closes any question `shown` does not hold
  // (docs/plans/2026-11-16-dial-agent-notify-design.md, "Which agents it covers").
  /** Whose notice it is, read from what the devices hold, with no wait: the listener gives a connection 2 s. */
  const noticeCaller = ({ engine, sessionId, folder }: NoticeAsk): NoticeCaller => {
    const who = { name: folder ?? 'An agent', machine: core.machine.name() }
    if (!engine || !sessionId) return { agentId: observedAgentId('notify', folder ?? ''), host: '', who: { ...who, engine: '' } }
    // A Harness agent first, by the session the core bound to it: an outside source lists its session too until the
    // dial's list is read again.
    const own = core.agents.advertised().find((session) => session.engine === engine && session.sessionId === sessionId)
    if (own) return { agentId: own.agentId, host: 'harness' }
    const entry = outsideEntries().find(({ agent }) => agent.engine === engine && agent.sessionId === sessionId)
    if (entry) return { agentId: entry.agent.id, host: entry.agent.host }
    return { agentId: observedAgentId(engine, sessionId), host: '', who: { ...who, engine } }
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
    count: createEngineTally('[device] notify', ['claude', 'codex', 'agent'], ['shown', 'no dial', 'limited'], log),
  })
  /** That agent's next turn started, a tap opened it, or it left: its card goes. */
  const endNotice = (agentId: string): void => part.call('notices', () => notices.ended(agentId))
  /** Another question of that agent closed: its notice, covered or held back by it, is asked again. */
  const reaskNotice = (agentId: string): void => part.call('notices', () => notices.reask(agentId))

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
    showWaits()
    const entries = outsideEntries()
    const ids = new Set(entries.map((entry) => entry.agent.id))
    const fresh = new Map<string, DialEvent[]>()
    for (const id of told.keys()) {
      if (ids.has(id)) continue
      told.delete(id)
      endNotice(id)
    }
    for (const entry of entries) {
      const { agent } = entry
      const was = told.get(agent.id)
      const card = { agentId: agent.id, text: '', recap: '', subagent: false }
      // A wait whose line changed is told again.
      const line = waiting(entry)
      if (was?.state === agent.state && was.line === line) {
        // The answer is read after the turn ends (observed.ts), so its summary follows the done. One still the last
        // turn's (this turn's was not found) is not said again.
        if (agent.state === 'done' && agent.lastAnswer && agent.lastAnswer !== was.answer) {
          was.answer = agent.lastAnswer
          tellOf(agent.id, { ...card, kind: 'summary', text: agent.lastAnswer, recap: agent.lastAnswer, fullText: agent.lastAnswer })
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
      if (entry.source !== observed && busy(entry) && !(was && busyState(was.state))) endNotice(agent.id)
      // An agent a listing names for the first time ended no turn the dial saw: herdr says done of any turn that ended in a
      // pane it has not focused, and lists it again at each plug-in, reconnect and unfold. An observed one is first heard
      // by its hook, which may be the turn's end.
      const ended = was !== undefined || entry.source === observed
      if (busy(entry)) tellOf(agent.id, started(entry))
      else if (ended && agent.state === 'done') tellOf(agent.id, { ...card, kind: 'done' })
      else if (ended && agent.state === 'error') tellOf(agent.id, { ...card, kind: 'error' })
    }
    if (fresh.size) part.call('dial', () => check(fresh))
  }
  observed?.onChange(() => part.call('dial', outsideTurn))
  herdr?.onChange(() => part.call('dial', outsideTurn))
  // Before the dial's look, which then sees each session the scan found in the terminal it runs in.
  hcSource?.onChange(() => part.call('observed', () => observed!.placeHerdr()))
  hcSource?.onChange(() => part.call('dial', outsideTurn))
  cmuxSource?.onChange(() => part.call('dial', outsideTurn))
  opencode?.onChange(() => part.call('dial', outsideTurn))
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
  const dropEnded = (source: ObservedSource, agentId: string): void => {
    if (!outside(agentId)) return
    clearTimeout(endings.get(agentId))
    const timer = setTimeout(() => { endings.delete(agentId); part.call('observed', () => source.tick()) }, ENDED_MS)
    timer.unref()
    endings.set(agentId, timer)
  }
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
  /** The agents on Orca's ring: the merged list's, as the dials list them. */
  const orcaAgents = (): HostAgent[] => registry.entries().filter(({ agent }) => agent.app === 'orca').map(({ agent }) => agent)
  const orcaIds = (): string[] => orcaAgents().map(({ id }) => id)
  /**
   * The Orca terminal of each agent on Orca's ring with no Orca pane, by elimination (the design's decided 7): one the
   * attach scan found has none until its first hook, and an idle one sends none, while Orca's list names no terminal's
   * process or tty. The terminal Orca saw that agent's engine start in, in its folder, that no agent with an Orca pane
   * holds, when it is the only one such and the agent the only one with none there; anything else places nobody. For its
   * order, its tab's name, and the terminal a rest or a tap switches to: never its pane, so no words reach it and no focus
   * line finds it.
   */
  const placeInOrca = (source: ObservedSource, terminals: readonly OrcaTerminal[]): Map<string, string> => {
    // By folder and engine: the agent's, and the terminal's worktree and the agent Orca saw there, compared as they are.
    const add = (to: Map<string, string[]>, folder: string, engine: string, value: string): void => {
      const at = JSON.stringify([folder, engine])
      to.set(at, [...to.get(at) ?? [], value])
    }
    const held = new Set<string>()
    const unplaced = new Map<string, string[]>()
    for (const { id, cwd, engine } of orcaAgents()) {
      const pane = source.paneOf(id, 'orca')
      if (pane !== undefined) held.add(pane)
      else if (cwd !== undefined) add(unplaced, cwd, engine, id)
    }
    const free = new Map<string, string[]>()
    for (const { handle, worktreePath, agentIdentity } of terminals) if (!held.has(handle)) add(free, worktreePath, agentIdentity, handle)
    const placed = new Map<string, string>()
    for (const [at, ids] of unplaced) {
      const handles = free.get(at)
      if (ids.length === 1 && handles?.length === 1) placed.set(ids[0], handles[0])
    }
    return placed
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
      const placed = placeInOrca(source, listed.terminals)
      const rank = new Map<string, number>()
      for (const id of orcaIds()) {
        // An agent in a multiplexer inside Orca has no Orca pane, and one Orca did not lay out has no place: both come
        // after the ranked (select.ts), unless placed by elimination.
        const handle = source.paneOf(id, 'orca') ?? placed.get(id)
        const at = handle === undefined ? undefined : place.get(handle)
        if (at !== undefined) rank.set(id, at)
      }
      // Nothing is pushed: the dials read the reordered ring on their next list, as any change of it.
      cableHost.setRank('orca', rank)
      // The same read names Orca's agents by their tabs (the design's section 4). After the rank: the rename's change
      // lists the ring already in tab order.
      source.setPaneNames('orca', new Map(listed.tabs.flatMap(({ handle, title, renamed }) =>
        title === undefined ? [] : [[handle, { title, renamed: renamed === true }]])), placed)
    }).finally(() => {
      ordering = false
      if (!orcaRing.again) return
      orcaRing.again = false
      part.call('orca', () => readOrcaOrder(source))
    })
  }
  /** Asks for a read when Orca's ring has other members, or a member another Orca pane, than at the last check: one the
   *  attach scan found learns its pane at its first hook, and a session resumed in another Orca terminal keeps its id. With
   *  none, the last order is kept. */
  const orcaMembers = (source: ObservedSource): Promise<void> | undefined => {
    if (!dialOn) return
    const members = new Set(orcaIds().map((id) => `${id} ${source.paneOf(id, 'orca') ?? ''}`))
    const was = orcaRing.members
    orcaRing.members = members
    if (members.size === 0 || (was?.size === members.size && [...was].every((id) => members.has(id)))) return
    if (ordering) { orcaRing.again = true; return }
    return readOrcaOrder(source)
  }
  if (observed) observed.onChange(() => part.call('orca', () => orcaMembers(observed)))
  // Each change tells VS Code's windows which agents run in one of its terminals, by their panes: only theirs may cost a
  // read of the process table. A part of its own, so a throw there is never the dial's.
  if (observed) observed.onChange(() => part.call('vscode', () => vscode.agents(observed.list().flatMap(({ id }) => {
    const pid = termPid(observed.paneOf(id, 'vscode') ?? '')
    return pid === undefined ? [] : [pid]
  }))))

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

  /** The scan, the reminders, herdr's and Herdr Core's sockets, and opencode's service, for an attached dial alone. */
  let attached: ReturnType<typeof setInterval>[] = []
  const dialAttached = (on: boolean): void => {
    dialOn = on
    for (const timer of attached) clearInterval(timer)
    attached = []
    // The first dial coming, or the last going, can turn the gate (heldOnTab) when it says appFilter: what waits is asked,
    // or closed, again. Closed as the last goes, an older dial that comes next is not asked it. A second dial coming or
    // going does not reach here: the fleet tells `watching` for the first and the last alone.
    if (!on) part.call('dial', showWaits)
    // Its questions were in its RAM: each notice still pending is asked again, under its id, whatever source is on.
    // With the last gone, a Harness agent's next turn goes unheard, so its card ends now.
    part.call('notices', () => on ? notices.attached() : notices.detached())
    if (!observed || !herdr || !opencode) return
    // Only with herdr installed, read at each attach, as a tap needs it (herdr.ts): with none, no folder is watched
    // (~/.config, or the home folder, recursive on macOS) for a socket that never comes.
    part.call('herdr', () => on && apps.onPath('herdr') ? herdr.start() : herdr.stop())
    // Only with Herdr installed, read at each attach as herdr's is: with none, no folder is watched for hc's socket.
    if (hcSource) part.call('herdr-app', () => on && herdrApp.binary() ? hcSource.start() : hcSource.stop())
    // Only with cmux installed, read at each attach as Herdr's is: with none, no folder is watched for its stores, and a
    // hooked agent's words are not offered to it.
    if (cmuxSource) part.call('cmux', () => {
      cmuxFound = on && cmuxClient.binary() !== null
      return cmuxFound ? cmuxSource.start() : cmuxSource.stop()
    })
    part.call('opencode', () => on ? opencode.start() : opencode.stop())
    if (!on) {
      // The next attach checks Orca's ring afresh, and a read under way lands on nothing.
      orcaRing = { again: false }
      part.call('orca', dropFocus)
      return
    }
    // Agents already running when the dial came are listed now, idle until their next hook event.
    part.call('observed', () => scanOpen(observed))
    part.call('orca', () => orcaMembers(observed))
    // A dial plugged in while Orca is already in front: a front told again starts no settle, so none would come until the
    // person left Orca and came back.
    part.call('orca', () => cableHost.settledApp() === 'orca' ? orcaSettled(observed) : undefined)
    // Its questions were in its RAM: the ones still waiting are asked again, under their ids.
    part.call('dial', () => { for (const [agentId, question] of shown) ask(agentId, question) })
    part.call('dial', showWaits)
    part.call('dial', remind)
    attached = [
      every(OPEN_SCAN_MS, () => scanOpen(observed)),
      // A person can take minutes to come to an agent that waits on them.
      every(REMIND_MS, remind),
    ]
  }

  // ── the mod's polls ────────────────────────────────────────────────────────────────────────────────
  //
  // Guarded as the fleet is: a part that throws, or did not start, answers as with no dial, so the mod waits a minute. One
  // switched off ends what it holds: the `gone` that would have ended a poll is swallowed from then on.
  const { inboxPoll, inboxGone } = DEVICES_FALLBACKS
  const inboxCalls = part.start('inbox', (): Pick<DeviceHookPort, 'inboxPoll' | 'inboxGone'> & { stop(): void } => ({
    inboxPoll: ({ pollId, sessionId }) => inbox.poll(pollId, sessionId),
    inboxGone: (pollId) => inbox.gone(pollId),
    stop: () => inbox.closeAll(),
  }), { inboxPoll, inboxGone, stop: undefined })
  /** Every poll held for the core's calls: that core went, or the devices stop. */
  const endHookCalls = (): void => { part.call('inbox', () => inbox.closeAll()) }
  /** The watch's change of the Notifications setting: kept, then said at once with the dial's status, which is how the
   *  watch's line, and the menu's check, follow it. No revision: the dial itself did not change. */
  const setNotify = (mode: NotifyMode): { mode: NotifyMode } | { error: string } => {
    const failed = notifyMode.set(mode)
    if (failed !== undefined) {
      log(`[device] notifications · not saved · ${failed}`)
      return { error: 'WRITE_FAILED' }
    }
    sayStatus(cableHost.currentDialStatus())
    log(`[device] notifications · ${mode}`)
    return { mode }
  }
  // The core's calls failed to none when its link dropped: a transcript for a poll nobody holds would wait for nothing.
  deps.onCoreGone?.(endHookCalls)

  // `harness hardware watch` tells the devices' own listener which app is in front, and the dial follows it once it
  // settles, with no window or with one in the apps view (cable/hosts/appFilter.ts), the harness-device mod tells it the
  // session the Claude app shows, and `harness device notify` an agent's notice: the core never hears any of them. Another
  // message type is another key here. A rejection's text is not logged: it can hold the socket's path, and a path the
  // account's name.
  const listening = deps.listen?.({
    front: frontHandler((app) => part.call('dial', () => cableHost.front(app))),
    attach: attachHandler((sessionId) => part.call('dial', () => claudeAttached(sessionId))),
    tab: tabHandler((tab) => part.call('dial', () => tabReported(tab))),
    tabs: tabs.handler,
    dial: dial.handler,
    notify: notifyHandler((mode) => {
      let answer: { mode: NotifyMode } | { error: string } = { error: 'FAILED' }
      part.call('dial', () => { answer = setNotify(mode) })
      return answer
    }),
    notice: noticeHandler((ask) => {
      let result: NoticeResult = 'no dial'
      part.call('notices', () => { result = notices.notify(ask) })
      return result
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
    .catch((): null => { log('[devices] listener not opened · failed'); return null })

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

  /** A card bound for the devices, translated once for the cable. */
  const toCable = (frame: Record<string, unknown>): void => {
    // A question, its close and a turn's card each also move the agent on the dial's list with no window (hosts/harness.ts).
    const close = cableQuestionCloseFor(frame as Parameters<typeof cableQuestionCloseFor>[0])
    if (close) {
      cableHost.harness.noteCard(close.agentId, 'question.close')
      inOrder(close.agentId, () => { void cable.questionClose(close.agentId, close.requestId) })
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
    if (question) { questionsOpen.set(question.agentId, question.requestId); cableHost.harness.noteCard(question.agentId, 'question'); tally('alert', 'rule:question', 'question', 0); inOrder(question.agentId, () => { void cable.question(question.agentId, question.requestId, question.questions) }); return }
    // A shell result is only the stats' input: the dial is told the sums when the turn ends.
    const ran = frame as { type?: string; agentId?: string; payload?: { kind?: string; id?: string; command?: string; isError?: boolean; outputTail?: string } }
    if (ran.payload?.kind === 'reply_text' && ran.agentId) {
      const update = (ran.payload as { update?: unknown }).update
      if (typeof update === 'string' && update) { latestUpdate.set(ran.agentId, update); replyText(ran.agentId, update) }
      return
    }
    if (ran.payload?.kind === 'turn_started' && ran.agentId) {
      endNotice(ran.agentId)
      // A question its last turn left open is stale: it must not hold a notice of this turn back.
      questionsOpen.delete(ran.agentId)
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
    if (gone.type === 'agent_deleted' && typeof gone.payload?.agentId === 'string') { latestUpdate.delete(gone.payload.agentId); began.delete(gone.payload.agentId); ended.delete(gone.payload.agentId); endReplies(gone.payload.agentId, false); endNotice(gone.payload.agentId); questionsOpen.delete(gone.payload.agentId) }
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
    // No dial linked: nothing to turn or count. The turn still used up a dial's prompt, in `ingest`.
    if (!cable.isConnected) return
    if (source === 'relayed') { log('[device] prompt · skipped · relayed'); return }
    if (source === 'dial') { log('[device] prompt · skipped · dial prompt'); return }
    const front = cableHost.settledApp()
    if (front === undefined || outside(agentId)?.agent.app !== front) { log('[device] prompt · skipped · not in front'); return }
    // Focus reaches an agent with an Orca pane; one in a multiplexer inside Orca has none, and its prompt still moves the
    // dial.
    if (focusWatch && observed?.paneOf(agentId, 'orca') !== undefined) { log('[device] prompt · skipped · focus followed'); return }
    return cable.followLocal(agentId, 'prompt')
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
    const report = { ...tab, at: monotonic(), moves: dialMoves }
    if (cableHost.settledApp() === tab.app) return followTab(report)
    tabReport = report
  }
  const tabSettled = (app: string): Promise<void> | undefined => {
    if (!tabReport) return
    if (tabReport.app === app) return followTab(tabReport)
    tabReport = undefined
    if (cable.isConnected) log('[device] tab · skipped · not in front')
  }
  // ⌘K in the window: a typed task, and which agent it belongs to, on any of the owner's machines.
  const routeTask = async (text: string): Promise<RouteAnswer> => fleet ? fleet.routeTask(text) : unrouted(NO_AGENT_LIST)
  // Committed, through the fleet's router — the dial's own dispatch — so a remote agent is reached on its
  // own machine instead of being looked for in this computer's registry.
  const routeSend = async (agentId: string, text: string): Promise<SendResult> => {
    const sent = fleet?.routeSend(agentId, text) ?? { ok: false as const, machine: '', reason: NO_AGENT_LIST }
    log(`[route] ⌘K → ${sid(agentId)} · bytes=${Buffer.byteLength(text, 'utf8')}`
      + (sent.ok ? '' : ` · REFUSED: ${sent.reason}${sent.machine ? ` (${sent.machine})` : ''}`))
    return sent
  }

  const port: DevicesPort = {
    // A paneless session's hook event, as the core checked it: taken, and dropped here while the observed source is
    // switched off.
    observed: (event) => {
      part.call('observed', () => {
        // With the source switched off too: a notice no list held is under its session's id.
        if (event.event === 'turn-start') endNotice(observedAgentId(event.engine, event.sessionId))
        if (!observed) return
        const source = observed.ingest(event)
        if (event.event === 'session-end') {
          const agentId = observedAgentId(event.engine, event.sessionId)
          dropEnded(observed, agentId)
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
      .then((result) => { if (!result.ok) log(`[cable] settings for ${id || 'no device'}: ${result.error}`) })),
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
    // The Wi-Fi device borrows the dial's walk along the desk and its stroke, until it is one of the devices.
    stepFocus: (direction, currentAgentId) => cableHost.stepFocus(direction, currentAgentId, () => !stopped),
    scroll: (phase, dy, velocity) => cableHost.scrolled(phase, dy, velocity),
    // The voice router warms a worker on an engine the machine runs, while a device is watching.
    engines: (engines) => setVoiceRouterSessions(engines.map((engine) => ({ engine }))),
    commanders: (connected) => setVoiceRouterDeviceConnected(connected),
    // The mod's poll, as the core checked and bounded it (core/deviceHookCalls.ts).
    inboxPoll: async (poll) => (inboxCalls ? inboxCalls.inboxPoll(poll) : { off: true }),
    inboxGone: (pollId) => inboxCalls?.inboxGone(pollId),
    // The serial ports first: a port left held makes esptool fail in a way that reads like dead hardware.
    stop: async () => {
      // A cable still waiting on the listener never starts.
      stopped = true
      // The listener before anything, once it has opened: no front reaches a stopped cable or sets a timer after the
      // timers below are cleared.
      await (await listening)?.close()
      for (const agentId of [...replies.keys()]) endReplies(agentId, false)   // no timer may fire into a stopped cable
      for (const timer of timers) clearInterval(timer)
      for (const timer of endings.values()) clearTimeout(timer)
      for (const timer of pending) clearTimeout(timer)
      tabReport = undefined
      selects.clear()
      endHookCalls()
      dialAttached(false)
      await cable.stop()
      fleet?.stop()
      shutdownVoiceRouter()
    },
  }
  ports.devices = port
  deps.onDesk?.({
    stepFocus: (direction, currentAgentId, current) => cableHost.stepFocus(direction, currentAgentId, () => !stopped && current()),
    scroll: (phase, dy, velocity, current) => { if (!stopped && current()) cableHost.scrolled(phase, dy, velocity) },
  })

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
  const ownerCommand = createOwnerCommands({ task: routeTask, send: routeSend, log })
  deps.onLegacyCommands?.({
    routeTask: async ({ text }) => ({ ...await routeTask(typeof text === 'string' ? text : '') }),
    routeSend: ({ agentId, text }) => routeSend(typeof agentId === 'string' ? agentId : '', typeof text === 'string' ? text : ''),
  })
  const windowFrame = async (payload: Record<string, unknown>, asker: { local?: boolean; owner: boolean }): Promise<Record<string, unknown>> => {
    if (!asker.local || !asker.owner) return { error: 'LOCAL_ONLY' }
    const frame = (payload.payload && typeof payload.payload === 'object' ? payload.payload : {}) as Record<string, unknown>
    const said = (field: string): string => (typeof frame[field] === 'string' ? frame[field] as string : '')
    if (payload.frame === 'route_task') {
      const task = said('text').trim()
      return { ...(task ? await routeTask(task) : unrouted('empty task')) }
    }
    if (payload.frame === 'route_send') {
      const sent = said('agentId') && said('text') ? await routeSend(said('agentId'), said('text')) : { ok: false as const, machine: '', reason: 'nothing to send' }
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
    devices_ws: (payload, asker, closed) => asker.rpcRoute === true
      ? ownerCommand(typeof payload.frame === 'string' ? payload.frame : '',
        payload.payload && typeof payload.payload === 'object' && !Array.isArray(payload.payload) ? payload.payload as Record<string, unknown> : {}, asker, closed)
      : windowFrame(payload, asker),
  }
}
