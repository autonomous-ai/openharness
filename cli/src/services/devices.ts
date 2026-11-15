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
import { join } from 'node:path'
import { env } from '../config/env.js'
import { DEVICES_FALLBACKS, DEVICES_REQUESTS, type CoreApi, type CorePorts, type DeviceHookPort, type DevicesPort, type RouteAnswer, type SendResult, type ServiceRequests, type WindowFocus } from '../core/api.js'
import { CableFleet, testDialDiscovery, type CableFleetOptions } from '../cable/cableFleet.js'
import { isLocalOnly } from '../lib/cardUpdate.js'
import { TurnStats, type TurnStatsFields } from '../cable/turnStats.js'
import { cableEventFor, cableStepFor, cableQuestionCloseFor, cableQuestionFor, DaemonCableHost } from '../cable/cableHost.js'
import { CableSession, SHOWN_ONLY_PREFIX, type FollowCause } from '../cable/cableSession.js'
import { Inbox } from '../cable/hosts/inbox.js'
import { LAST_ANSWER_DEADLINE_MS, LAST_ANSWER_MAX_BYTES, readLastAnswer } from '../cable/hosts/lastAnswer.js'
import { askedLine, hostDisplayName, observedAgentId, ObservedSource, type ObservedActions, type ObservedDeps, type PromptSource } from '../cable/hosts/observed.js'
import { createOpenActions } from '../cable/hosts/open.js'
import { createOrcaActions, orcaDeps, type OrcaDeps } from '../cable/hosts/orca.js'
import { HostRegistry } from '../cable/hosts/registry.js'
import { learnApps } from '../cable/hosts/scannedApp.js'
import { readTty, type Tab } from '../cable/hosts/tabs.js'
import type { HostAgent, HostAgentState } from '../cable/hosts/types.js'
import { PetStore } from '../cable/pets/store.js'
import { DialLog } from '../cable/dialLog.js'
import { DialVerdicts } from '../cable/dialPortVerdicts.js'
import { WindowForm } from '../cable/windowForm.js'
import { createWindowRouter } from '../cable/windowRoute.js'
import { WindowSelection } from '../cable/windowSelection.js'
import { WindowVisit } from '../cable/windowVisit.js'
import { MachineListCache } from '../device/machineList.js'
import { claudeProjectsRoots, codexHomeRoots } from '../lib/engineHomes.js'
import { harnessDevicesRequest } from '../lib/harnessDevices.js'
import { OpenSessions, SessionRows } from '../lib/sessionSearch/external.js'
import { externalProviders } from '../lib/sessionSearch/externals/index.js'
import { fileStamp, listProcesses, processAlive } from '../lib/sessionSearch/externals/support.js'
import { setVoiceRouterDeviceConnected, setVoiceRouterSessions, shutdownVoiceRouter } from '../lib/voiceRouter.js'
import { createTally, createTierDecider, type Tier, type TierDecision, type TierInput } from '../lib/notifyTier.js'
import { createPartGuard } from './devicesGuard.js'
import { attachHandler, frontHandler, tabHandler, tabsStream, type DevicesListener, type ListenerHandler, type ListenerStreamHandler } from './devicesListener.js'
import { FLEET_FALLBACKS, startFleet, type Fleet } from './fleet.js'

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
  /** Called with a function this part runs whenever its link to the core drops: the calls that core held have failed. */
  onCoreGone?: (run: () => void) => void
  /** An agent's conversation token totals, read fresh (not the 15 s cache); null when unknown or remote.
   *  Defaults to the core's `usageFresh`. */
  readUsage?: (agentId: string) => Promise<{ input?: number; cached?: number; output?: number } | null>
  /** For this service's tests: the dial's session, and how dials are found and opened. */
  Session?: ConstructorParameters<typeof CableFleet>[0]
  cable?: Partial<CableFleetOptions>
  /** For this service's tests: how `orca`, and the commands a tap runs to open an app (cable/hosts/open.ts), are found and
   *  run. */
  orca?: OrcaDeps
  /** Opens the devices' own listener with these handlers (services/devicesListener.ts). Given by the devices process
   *  alone: inside the core's process (`HARNESSD_SERVICES=none`, Harness OS) there is none, so the core's process opens
   *  no socket for the devices, and the dial follows no app in front there. */
  listen?: (handlers: Readonly<Record<string, ListenerHandler | ListenerStreamHandler>>, log: (line: string) => void) => Promise<DevicesListener | null>
  /** For this service's tests: how an agent's tty is read; `ps` by default (cable/hosts/tabs.ts). */
  tty?: (pid: number) => Promise<string | undefined>
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
  tab: { moved: '[device] tab · moved', 'no-tile': '[device] tab · no-tile' },
}
/** A tab app reports back each tab the dial selects: a report within this long of a select of its tty is that select's
 *  echo. Every select of that long is kept, as a fast swipe's late report for a tab it passed must not pull the dial back,
 *  and at most ECHO_KEPT of them. */
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
 *  the session it shows within about a second. */
const ATTACH_ECHO_MS = 2_000

/** This computer's agents outside a pane, read with ⌘P's readers (services/externalSessions.ts), and how the dial's voice
 *  and tap reach them. */
function observedSource(dataDir: string, log: (line: string) => void, actions: ObservedActions, tty: ObservedDeps['tty']): ObservedSource {
  const providers = externalProviders()
  return new ObservedSource({
    now: Date.now,
    processes: listProcesses,
    alive: processAlive,
    openSessions: new OpenSessions({ providers, log }),
    sessionRows: new SessionRows({ providers, excluded: [dataDir], log }),
    excluded: [dataDir],
    // Asked for Claude Code's and Codex's alone (observed.ts), and read only inside their own folders: a hook can name any path.
    lastAnswer: (engine, path) => readLastAnswer(engine as 'claude' | 'codex', path, {
      roots: engine === 'claude' ? claudeProjectsRoots(env.CLAUDE_PROJECTS_DIR) : codexHomeRoots(env.CODEX_HOME).map((home) => join(home, 'sessions')),
      maxBytes: LAST_ANSWER_MAX_BYTES, deadlineMs: LAST_ANSWER_DEADLINE_MS,
    }),
    fileStamp,
    log,
    actions,
    apps: learnApps,
    tty,
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
  // The dial's voice reaches them through their mod's long poll (Claude Code's), idle or working, or typed into their Orca
  // terminal when idle, and a tap brings its app forward, on its own pane where the app has a way in that asks for no new permission
  // (docs/specs/2026-11-13-device-claude-orca.md).
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
  const orca = createOrcaActions(apps)
  const opener = createOpenActions({ ...apps, orcaSwitch: (handle) => orca.switchTo(handle).then((done) => done === 'ok'), log })
  // The stream a watch holds open on the devices' listener: a rest or a tap on an agent in Terminal, iTerm2 or Ghostty
  // asks it to select that agent's tab (docs/specs/2026-11-15-dial-terminal-follow.md). Only macOS's apps select a tab
  // by its tty: elsewhere no agent's is read, and none has a tab.
  const tabs = tabsStream()
  const ttyOf = apps.platform === 'darwin' ? deps.tty ?? readTty : undefined
  /** The ttys the dial selected lately, a rest's and a tap's alike: the echoes a tab report is checked against, each
   *  excusing one. */
  let selects: Array<{ tty: string; at: number }> = []
  /** Every select written, counted: a report that waits for the settle is set aside once the dial wrote one since. */
  let written = 0
  const selected = (tty: string): void => {
    const at = monotonic()
    written++
    selects = [...selects.filter((sent) => at - sent.at < TAB_ECHO_MS), { tty, at }].slice(-ECHO_KEPT)
  }
  const observed = env.HARNESS_DEVICE_OBSERVED ? observedSource(core.dataDir, log, {
    modReady: (sessionId) => inbox.ready(sessionId),
    toMod: (sessionId, text) => inbox.deliver(sessionId, text),
    orcaSend: orca.send,
    orcaSwitch: orca.switchTo,
    canOpen: opener.can,
    // A tap on a Claude app agent runs the continue link a rest runs: its attach is the dial's own echo too.
    open: (agentId, target) => {
      if (target.pane?.app === 'claude' && opener.can(target)) noteLink(agentId)
      return opener.open(agentId, target)
    },
    claudeInFront: () => cableHost.latestFront() === 'claude',
    claudeShow: (agentId, session) => {
      noteLink(agentId)
      return opener.claudeShow(agentId, session)
    },
    tabsOpen: () => tabs.isOpen(),
    tabSelect: (app, tty, raise) => {
      if (!tabs.select({ app, tty }, raise)) return 'failed'
      selected(tty)
      return 'ok'
    },
    // The route or the refusal only: never the words, the session or the terminal.
    count: (what) => log(`[device] voice · ${what}`),
  }, ttyOf) : null
  /** One of them, by the id the dial holds: what the dial asks of it is answered here, never by a door of the core. */
  const outside = (agentId: string): HostAgent | undefined => observed?.list().find((agent) => agent.id === agentId)
  /** Its line while it waits on the person, where a harness agent shows its terminal's footer: what its permission prompt
   *  asks once its hook said, and the app it is answered in. The dial never answers it. */
  const waiting = (agent: HostAgent): string | null => {
    if (agent.state !== 'needs-you') return null
    const host = hostDisplayName(agent.host)
    const asks = observed?.waitingOn(agent.id)
    return asks ? askedLine(asks, host) : `Waiting for you · ${host}`
  }

  const cableHost = new DaemonCableHost({
    // The cloud harnesses too, where the core offers them: tiles on the desk the dial walks like any other.
    sessions: () => [...core.agents.advertised(), ...core.agents.cloud?.() ?? []],
    refresh: deps.refresh,
    displayName: (session) => core.agents.displayName(session),
    appFocus: () => focus.voice ?? undefined,
    activityText: async (agentId) => {
      const agent = outside(agentId)
      return agent ? waiting(agent) : core.agents.activityText(agentId)
    },
    // The footer and its timer from the core; the agent's own latest sentence from the cards already seen here.
    activitySnapshot: async (agentId) => {
      const agent = outside(agentId)
      if (agent) { const text = waiting(agent); return text ? { text } : null }
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
      dialAttached(on)
    },
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
    notificationRead: (machineId, agentId, readToken) =>
      core.clients.sendLocal({ type: 'dial_notification_read', payload: { machineId, agentId, readToken } }),
    forked: (machineId, agentId, sourceAgentId) => core.clients.sendLocal({ type: 'dial_forked', payload: { machineId, agentId, sourceAgentId } }),
    // The dial's Fork: the same path the window's `agent_fork` takes, then `forked` above lands on it.
    forkAgent: (agentId) => core.agents.fork(agentId),
    focused: (machineId, agentId) => core.clients.sendLocal({ type: 'dial_focus', payload: { machineId, agentId } }),
    // The outcome only: never the agent, its session or its terminal.
    swiped: (outcome) => log(`[device] swipe · ${outcome}`),
    localFollowed: (cause, outcome) => log(FOLLOWED[cause === 'attach' ? attachAsk : cause][outcome]),
    swarmSelected: (swarmId) => core.clients.sendLocal({ type: 'dial_swarm', payload: { swarmId } }),
    scrolled: (phase, dy, velocity) => core.clients.sendLocal({ type: 'dial_scroll', payload: { phase, dy, velocity } }),
    // Gestures stay at this desk. The device inventory and its settings also reach the owner's other
    // machines, through the encrypted device-management event.
    dialStatus: (status) => {
      revision++
      core.clients.sendLocal({ type: 'dial_status', payload: status as unknown as Record<string, unknown> })
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
      part.call('dial', () => tabSettled(app))
    },
    appPicked: () => log('[device] app filter: picker'),
    // The settle of the app in front: a filter that throws costs the devices nothing, and the devices stopping cancels it.
    appTimer: timerIn('dial'),
  })
  // What the dial lists with no window: this computer's harness agents, and the ones outside a pane unless switched off.
  cableHost.setRegistry(new HostRegistry(observed ? [cableHost.harness, observed] : [cableHost.harness]))
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
   *  so a new kind of card lands on both the day it lands on either. */
  const dispatch = (event: DialEvent): void | Promise<void> => {
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
      const noted = (tier: Tier, rule: string): void => tally(cableHost.describe(agentId)?.name ?? '', tier, `rule:${rule}`, rule, 0)
      if (onScreen || event.subagent) { noted('silent', event.subagent ? 'subagent' : 'onScreen'); void cable.summary(agentId, recap, event.text, 'silent', event.fullText, event.subagent); return }
      // No device attached (or the serial side disabled): nobody to tell, so the recap never leaves the machine.
      if (!cable.isConnected) { ended.delete(agentId); void cable.summary(agentId, recap, event.text, 'silent', event.fullText, false); return }
      const turn = ended.get(agentId) // a sub-agent's summary leaves the main turn's numbers alone
      ended.delete(agentId)
      const who = cableHost.describe(agentId)
      // Decided once already, by the recaps (services/recaps.ts), for the phone as well: the dial follows it and
      // nobody is asked again. A card without one (a cloud agent's, a recaps from before) is decided here.
      if (event.tier) {
        tally(who?.name ?? '', event.tier, 'recaps', 'decided upstream', 0)
        void cable.summary(agentId, recap, event.text, event.tier, event.fullText, false)
        return
      }
      // Returned, so the agent's next card waits behind this one (inOrder): a late recap must not follow turn.started.
      return tierOf({ agent: who?.name ?? '', engine: who?.engine ?? '', recap, durationS: turn?.durationS ?? null,
        stats: turn?.stats ?? {}, subagent: false, onScreen: false, failed: event.failed === true })
        .then((d) => d.tier, () => 'list' as const)
        .then((tier) => { void cable.summary(agentId, recap, event.text, tier, event.fullText, false) })
    }
    else {
      began.delete(event.agentId); ended.delete(event.agentId)
      stats.take(event.agentId) // a failed turn's sums must not leak into the next turn
      starts.delete(event.agentId)
      tally(cableHost.describe(event.agentId)?.name ?? '', 'alert', 'rule:failed', 'turn.error', 0)
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
    inOrder(event.agentId, () => dispatch(event))
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
    if (event.kind === 'question') { tally(cableHost.describe(event.agentId)?.name ?? '', 'alert', 'rule:question', 'question', 0); inOrder(event.agentId, () => { void cable.question(event.agentId, event.requestId, event.questions) }); return }
    toDial({ ...event, subagent: event.subagent === true })
  }))

  // An agent outside a pane reaches the dial through the same calls, as its state changes. What the dial was told of each
  // is kept, so that a change is told once.
  const told = new Map<string, { state: HostAgentState; line: string | null; answer?: string }>()
  const busy = (agent: HostAgent): boolean => agent.state === 'working' || agent.state === 'needs-you'
  /** Its turn, with the waiting line: the session's activity read right after it (`activityText` above) repeats the line. */
  const started = (agent: HostAgent): DialEvent => ({ kind: 'processing', agentId: agent.id, text: waiting(agent) ?? '', recap: '', subagent: false })
  /** A window is open (its tabs, not null): the dial shows the tab, as before there were agents outside a pane, and hears
   *  nothing of them. What they do is still noted, so that only a later change is told once the window closes. */
  let windowOpen = false
  const tell = (event: DialEvent): void => { if (!windowOpen) toDial(event) }
  /**
   * The prompt an agent waits on, once its hook said what it asks, is also a question for the dial, which the dial only
   * shows (cableSession.ts SHOWN_ONLY_PREFIX): the round dial draws a line on its working face, a question on its asking
   * one. One option, as a question needs one, and none to speak. By agent, so that each is closed by its own id.
   */
  const shown = new Map<string, { id: string; line: string; questions: unknown }>()
  const ask = (agentId: string, question: { id: string; line: string; questions: unknown }): void => {
    shown.set(agentId, question)
    inOrder(agentId, () => { void cable.question(agentId, question.id, question.questions) })
  }
  /** Asks what waits and closes what no longer does (or what a window covers): before a line, which it takes the place of. */
  const showWaits = (): void => {
    const want = new Map<string, HostAgent>()
    if (!windowOpen) for (const agent of observed?.list() ?? []) if (observed?.waitingOn(agent.id) !== undefined) want.set(agent.id, agent)
    for (const [agentId, question] of shown) {
      const agent = want.get(agentId)
      if (agent && waiting(agent) === question.line) continue
      shown.delete(agentId)
      inOrder(agentId, () => { void cable.questionClose(agentId, question.id) })
    }
    for (const [agentId, agent] of want) {
      const line = waiting(agent)
      if (shown.has(agentId) || !line) continue
      ask(agentId, { id: `${SHOWN_ONLY_PREFIX}${randomUUID()}`, line,
        questions: [{ key: 'prompt', q: line, options: [`In ${hostDisplayName(agent.host)}`] }] })
    }
  }
  observed?.onChange(() => part.call('dial', () => {
    showWaits()
    const agents = observed.list()
    const ids = new Set(agents.map((agent) => agent.id))
    for (const id of told.keys()) if (!ids.has(id)) told.delete(id)
    for (const agent of agents) {
      const was = told.get(agent.id)
      const card = { agentId: agent.id, text: '', recap: '', subagent: false }
      // A wait whose line changed is told again.
      const line = waiting(agent)
      if (was?.state === agent.state && was.line === line) {
        // The answer is read after the turn ends (observed.ts), so its summary follows the done. One still the last
        // turn's (this turn's was not found) is not said again.
        if (agent.state === 'done' && agent.lastAnswer && agent.lastAnswer !== was.answer) {
          was.answer = agent.lastAnswer
          tell({ ...card, kind: 'summary', text: agent.lastAnswer, recap: agent.lastAnswer, fullText: agent.lastAnswer })
        }
        continue
      }
      told.set(agent.id, { state: agent.state, line, answer: agent.lastAnswer })
      if (busy(agent)) tell(started(agent))
      else if (agent.state === 'done') tell({ ...card, kind: 'done' })
      else if (agent.state === 'error') tell({ ...card, kind: 'error' })
    }
  }))
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
   *  turned to, has heard nothing of it yet. Both lists a dial can hold: the one ring, and the shown app's for a dial that
   *  says appFilter, read only while one is connected: that read can switch the app, which no older dial shows. */
  const remind = async (): Promise<void> => {
    const mid = (observed?.list() ?? []).filter(busy)
    if (!mid.length || windowOpen) return
    const apps = cable.wantsApps() ? [cableHost.listAgentSnapshot({ apps: true })] : []
    const lists = await Promise.all([cableHost.listAgentSnapshot(), ...apps])
    const listed = new Set(lists.flatMap((list) => list.agents.map((agent) => agent.id)))
    for (const agent of mid) if (listed.has(agent.id)) tell(started(agent))
  }
  /** The scan and the reminders, for an attached dial alone. */
  let attached: ReturnType<typeof setInterval>[] = []
  const dialAttached = (on: boolean): void => {
    for (const timer of attached) clearInterval(timer)
    attached = []
    if (!on || !observed) return
    // Agents already running when the dial came are listed now, idle until their next hook event.
    part.call('observed', () => observed.scanOpen())
    // Its questions were in its RAM: the ones still waiting are asked again, under their ids.
    part.call('dial', () => { for (const [agentId, question] of shown) ask(agentId, question) })
    part.call('dial', remind)
    attached = [
      every(OPEN_SCAN_MS, () => observed.scanOpen()),
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
  // The core's calls failed to none when its link dropped: a transcript for a poll nobody holds would wait for nothing.
  deps.onCoreGone?.(endHookCalls)

  // `harness hardware watch` tells the devices' own listener which app is in front, and the dial with no window follows it
  // once it settles (cable/hosts/appFilter.ts), and the harness-device mod tells it the session the Claude app shows: the
  // core never hears either. Another message type is another key here. A rejection's text is not logged: it can hold the
  // socket's path, and a path the account's name.
  const listening = deps.listen?.({
    front: frontHandler((app) => part.call('dial', () => cableHost.front(app))),
    attach: attachHandler((sessionId) => part.call('dial', () => claudeAttached(sessionId))),
    tab: tabHandler((tab) => part.call('dial', () => tabReported(tab))),
    tabs: tabs.handler,
  }, log)
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
    if (close) { cableHost.harness.noteCard(close.agentId, 'question.close'); inOrder(close.agentId, () => { void cable.questionClose(close.agentId, close.requestId) }); return }
    const question = cableQuestionFor(frame as Parameters<typeof cableQuestionFor>[0])
    if (question) { cableHost.harness.noteCard(question.agentId, 'question'); tally(cableHost.describe(question.agentId)?.name ?? '', 'alert', 'rule:question', 'question', 0); inOrder(question.agentId, () => { void cable.question(question.agentId, question.requestId, question.questions) }); return }
    // A shell result is only the stats' input: the dial is told the sums when the turn ends.
    const ran = frame as { type?: string; agentId?: string; payload?: { kind?: string; id?: string; command?: string; isError?: boolean; outputTail?: string } }
    if (ran.payload?.kind === 'reply_text' && ran.agentId) {
      const update = (ran.payload as { update?: unknown }).update
      if (typeof update === 'string' && update) { latestUpdate.set(ran.agentId, update); replyText(ran.agentId, update) }
      return
    }
    if (ran.payload?.kind === 'turn_started' && ran.agentId) {
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
    if (gone.type === 'agent_deleted' && typeof gone.payload?.agentId === 'string') { latestUpdate.delete(gone.payload.agentId); began.delete(gone.payload.agentId); ended.delete(gone.payload.agentId); endReplies(gone.payload.agentId, false) }
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
    if (front === undefined || outside(agentId)?.app !== front) { log('[device] prompt · skipped · not in front'); return }
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
  /** Whether a link of the dial's own, to that agent or to any when none is named, is younger than ATTACH_ECHO_MS. Compared
   *  each time: an older one stays in the map until the next link. */
  const linkedByDial = (agentId?: string): boolean => {
    const at = monotonic()
    return [...dialLinks].some(([id, linked]) => (agentId === undefined || id === agentId) && at - linked < ATTACH_ECHO_MS)
  }
  const claudeAttached = (sessionId: string): Promise<void> | undefined => {
    const agentId = observedAgentId('claude', sessionId)
    const listed = outside(agentId)?.app === 'claude'
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
    if (outside(claudeAgent)?.app !== 'claude') { claudeAgent = undefined; return }
    // Any link, to another agent too: a swipe that rests as the app comes in front shows that one, and the settle must not
    // turn the dial back. Its attach, a moment later, is kept and skipped as its own echo.
    if (linkedByDial()) { log('[device] settle · skipped · echo'); return }
    attachAsk = 'settle'
    return cable.followLocal(claudeAgent, 'attach')
  }
  /**
   * A tab selected in Terminal, iTerm2 or Ghostty turns the dials to its agent as a person's prompt does, once its app has
   * settled in front (docs/specs/2026-11-15-dial-terminal-follow.md, "2. Selecting a tab moves the dial"): Harness Device
   * reports as the app comes to the front, before it settles. The latest report waits for that settle, and another app
   * settling drops it. Each line is an outcome, never the app, the tty or the agent.
   */
  /** A tab report, when it came and how many selects the dial had written by then. */
  type TabReport = Tab & { at: number; written: number }
  let tabReport: TabReport | undefined
  /** Uses up the report: with no dial linked nothing is followed or counted, as with a prompt. */
  const followTab = (report: TabReport): Promise<void> | undefined => {
    tabReport = undefined
    if (!cable.isConnected) return
    const { app, tty, at } = report
    // The dial selected a tab while the report waited for the settle: it names one the dial has left, and the app's
    // report of the tab selected is still to come.
    if (report.written !== written) { log('[device] tab · echo'); return }
    // By when the report came, not when its app settled: the wait for the settle must not age the dial's own select. It
    // excuses this report only: the person selecting that tab again soon after moves the dial. The app runs selects and
    // reports tabs in order, so a select before it will see no echo now (Harness Device replaced it while it waited, or
    // its tab was already shown): it goes too.
    const echo = selects.findIndex((sent) => sent.tty === tty && at - sent.at < TAB_ECHO_MS)
    if (echo >= 0) { selects = selects.slice(echo + 1); log('[device] tab · echo'); return }
    const agent = observed?.byTab(app, tty)
    if (!agent) { log('[device] tab · no-agent'); return }
    return cable.followLocal(agent.id, 'tab')
  }
  const tabReported = (tab: Tab): Promise<void> | undefined => {
    const report = { ...tab, at: monotonic(), written }
    if (cableHost.settledApp() === tab.app) return followTab(report)
    tabReport = report
  }
  const tabSettled = (app: string): Promise<void> | undefined => {
    if (!tabReport) return
    if (tabReport.app === app) return followTab(tabReport)
    tabReport = undefined
    if (cable.isConnected) log('[device] tab · not-in-front')
  }
  const port: DevicesPort = {
    // A paneless session's hook event, as the core checked it: taken, and dropped here while the observed source is
    // switched off.
    observed: (event) => {
      part.call('observed', () => {
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
      const closed = windowOpen && swarms === null
      windowOpen = swarms !== null
      cableHost.setSwarms(swarms)
      void cable.syncSwarms()
      void cable.syncAgents()
      // An open window closes the questions of the agents outside it, as it covers their lines; closed, they are asked again.
      showWaits()
      if (closed) part.call('dial', remind)
    }),
    // Held rather than acted on: the dial is handed it when it attaches, the one moment its drawer is known
    // to be empty.
    unread: (items) => part.call('dial', () => {
      cableHost.setUnread(items)
      void cable.replaceNotifications(items)
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
    // ⌘K in the window: a typed task, and which agent it belongs to, on any of the owner's machines.
    routeTask: async (text) => fleet ? fleet.routeTask(text) : unrouted(NO_AGENT_LIST),
    // Committed, through the fleet's router — the dial's own dispatch — so a remote agent is reached on its
    // own machine instead of being looked for in this computer's registry.
    routeSend: async (agentId, text): Promise<SendResult> => {
      const sent = fleet?.routeSend(agentId, text) ?? { ok: false as const, machine: '', reason: NO_AGENT_LIST }
      log(`[route] ⌘K → ${sid(agentId)} · bytes=${Buffer.byteLength(text, 'utf8')}`
        + (sent.ok ? '' : ` · REFUSED: ${sent.reason}${sent.machine ? ` (${sent.machine})` : ''}`))
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
      selects = []
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
