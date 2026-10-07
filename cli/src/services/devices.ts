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
import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { env } from '../config/env.js'
import { DEVICES_REQUESTS, type CoreApi, type CorePorts, type DevicesPort, type RouteAnswer, type SendResult, type ServiceRequests, type WindowFocus } from '../core/api.js'
import { CableFleet, testDialDiscovery, type CableFleetOptions } from '../cable/cableFleet.js'
import { cableEventFor, cableQuestionCloseFor, cableQuestionFor, DaemonCableHost } from '../cable/cableHost.js'
import { CableSession } from '../cable/cableSession.js'
import { DialLog } from '../cable/dialLog.js'
import { DialVerdicts } from '../cable/dialPortVerdicts.js'
import { WindowForm } from '../cable/windowForm.js'
import { createWindowRouter } from '../cable/windowRoute.js'
import { WindowSelection } from '../cable/windowSelection.js'
import { WindowVisit } from '../cable/windowVisit.js'
import { MachineListCache } from '../device/machineList.js'
import { harnessDevicesRequest } from '../lib/harnessDevices.js'
import { setVoiceRouterDeviceConnected, setVoiceRouterSessions, shutdownVoiceRouter } from '../lib/voiceRouter.js'
import { createPartGuard } from './devicesGuard.js'
import { FLEET_FALLBACKS, startFleet, type Fleet } from './fleet.js'

export { DEVICES_REQUESTS }

/** What the devices need that is not the core's to give. */
export interface DevicesDeps {
  /** Where each dial keeps its log, one file a day (cable/dialLog.ts). */
  logsDir: string
  /** The dials to look at, by serial number (`HARNESS_DIAL_SERIALS`); every one when empty. */
  dialSerials?: string[]
  /** The end-to-end suite's dial, a pseudo-terminal (`HARNESSD_TEST_DIAL_PORT`). */
  testDialPort?: string
  /** Leave the serial ports alone altogether (`CABLE_DISABLE`). */
  cableDisabled?: boolean
  /** `HARNESSD_TEST_FAULTS`: parts to fail, for the end-to-end suite. */
  faults?: ReadonlySet<string>
  log?: (line: string) => void
  /** How the voice router's worker is stopped when the process exits: an engine process of its own. */
  onExit?: (run: () => void) => void
  /** Read this computer's agents again before a list is built from them: in their own process the devices
   *  keep a copy, asked of the core as the dial's tick or ⌘K needs it (services/devicesProcess.ts). */
  refresh?: () => Promise<void>
  /** For this service's tests: the dial's session, and how dials are found and opened. */
  Session?: ConstructorParameters<typeof CableFleet>[0]
  cable?: Partial<CableFleetOptions>
}

/** ⌘K's answer while the fleet is not running: it never started, so there is no list to weigh. */
const NO_AGENT_LIST = 'no agent list yet'
const unrouted = (reason: string): RouteAnswer => ({ agentId: '', machineId: '', name: '', confidence: 0, reason, candidates: [], weighed: 0, machines: 0, via: '' })
const sid = (id: string): string => id.slice(0, 8)

export function startDevices(core: CoreApi, ports: CorePorts, deps: DevicesDeps): ServiceRequests {
  const log = deps.log ?? ((line: string) => console.log(line))
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
  const cableHost = new DaemonCableHost({
    sessions: () => core.agents.advertised(),
    refresh: deps.refresh,
    displayName: (session) => core.agents.displayName(session),
    activityText: (agentId) => core.agents.activityText(agentId),
    machineName: () => core.machine.name(),
    machineId: () => core.machine.id(),
    computerId: () => core.machine.computerId(),
    signedIn: () => core.account.signedIn(),
    accessToken: (opts) => core.account.accessToken(opts),
    environment: () => core.account.environment(),
    watching: (on) => core.clients.dialWatching(on),
    // The core's own doors for a local agent. The fleet's router reaches them the same way; the dial uses
    // these only when it routes by itself, with the fleet off.
    sendTurn: (agentId, text) => core.turns.send(agentId, text),
    stopTurn: (agentId) => core.turns.stop(agentId),
    answer: (agentId, requestId, answers) => core.questions.answer(agentId, requestId, answers),
    answerReviewed: (answer) => core.questions.answerReviewed(answer),
    recent: (agentId, n) => core.turns.recent(agentId, n),
    recentAsks: (agentId) => core.turns.asks(agentId),
    runtimeProfile: (session) => core.agents.runtimeProfile(session),
    updateAgent: (agentId, model, effort) => core.agents.setRuntime(agentId, model, effort),
    listModels: (agentId) => core.agents.runtimeModels(agentId),
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
  })
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

  /** One card for the dial, in its four calls. A remote machine's and this computer's are the same calls,
   *  so a new kind of card lands on both the day it lands on either. */
  const toDial = (event: NonNullable<ReturnType<typeof cableEventFor>>): void => {
    if (event.kind === 'processing') void cable.turnStarted(event.agentId, event.text)
    else if (event.kind === 'done') void cable.turnDone(event.agentId)
    // Quiet when the window already has this agent on screen; silent when the turn was a sub-agent's. The
    // tile still updates — the recap is what it draws — only the beep and the drawer entry are withheld.
    else if (event.kind === 'summary') void cable.summary(event.agentId, event.recap || event.text, event.text, alreadyOnScreen(event.agentId), event.subagent)
    else void cable.turnError(event.agentId, event.text)
  }

  // A remote machine's cards reach the dial through the same calls. The fleet has already noted which
  // machine the agent is on (services/fleet.ts), so a question from it can be named and, tapped, opened.
  fleet?.onEvent((event) => part.call('dial', () => {
    // A `state` event is about the WHEEL, not about a turn — live machine presence, which matters whichever
    // machine is selected. No selection guard on the rest: every machine's agents are on the carousel at
    // once, and dropping a card from one the wheel is not pointed at is what a tile that never leaves
    // "Working…" looks like from the outside.
    if (event.kind === 'state') { void cable.syncMachines(); return }
    if (event.kind === 'questionClosed') { void cable.questionClose(event.agentId, event.requestId); return }
    if (event.kind === 'question') { void cable.question(event.agentId, event.requestId, event.questions); return }
    toDial({ ...event, subagent: event.subagent === true })
  }))

  if (deps.cableDisabled) log('[cable] disabled (CABLE_DISABLE=true) — the serial port is left alone')
  else cable.start()
  ;(deps.onExit ?? ((run) => { process.once('exit', run) }))(() => shutdownVoiceRouter())

  const port: DevicesPort = {
    // Every card bound for the Wi-Fi devices goes down the cable too, translated once: a new kind of card
    // reaches the dial the day it reaches the backend's devices.
    card: (frame) => part.call('dial', () => {
      const close = cableQuestionCloseFor(frame as Parameters<typeof cableQuestionCloseFor>[0])
      if (close) { void cable.questionClose(close.agentId, close.requestId); return }
      const question = cableQuestionFor(frame as Parameters<typeof cableQuestionFor>[0])
      if (question) { void cable.question(question.agentId, question.requestId, question.questions); return }
      const event = cableEventFor(frame as Parameters<typeof cableEventFor>[0])
      // Logged at the fork, not at the send: this answers "did the daemon even decide to tell the dial",
      // a different question from "did the wire carry it", and the one nobody could answer when a tile
      // stayed idle through a whole turn.
      if (env.LOG_FRAMES && frame.type === 'commander_event') {
        log(`[cable] tee ${(frame as { payload?: { kind?: string } }).payload?.kind ?? '?'} → ${event ? 'sent' : 'ignored'}`)
      }
      if (event) toDial(event)
    }),
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
      cableHost.setSwarms(swarms)
      void cable.syncSwarms()
      void cable.syncAgents()
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
      part.call('window', () => windowSelection.focusChanged())
    },
    windowReply: (kind, connId, machineId, payload) => part.call('window', () =>
      (kind === 'form' ? windowForm : kind === 'visit' ? windowVisit : windowSelection).reply(connId, machineId, payload)),
    voiceReply: (voiceId, reply) => part.call('window', () => windowRouter.reply(voiceId, reply)),
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
    // The serial ports first: a port left held makes esptool fail in a way that reads like dead hardware.
    stop: async () => {
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
  }
  const answer = (type: string) => (payload: Record<string, unknown>, asker: { owner: boolean }) =>
    asker.owner ? harnessDevicesRequest(tab, type, payload) : { error: 'OWNER_REQUIRED' }
  return { harness_devices_list: answer('harness_devices_list'), harness_device_settings: answer('harness_device_settings') }
}
