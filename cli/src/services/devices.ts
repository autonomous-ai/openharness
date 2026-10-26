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
import { DEVICES_REQUESTS, SUPER_TAB_REQUEST_PREFIX, type CoreApi, type CorePorts, type DevicesPort, type RouteAnswer, type SendResult, type ServiceRequests, type WindowFocus } from '../core/api.js'
import { CableFleet, testDialDiscovery, type CableFleetOptions } from '../cable/cableFleet.js'
import { isLocalOnly } from '../lib/cardUpdate.js'
import { TurnStats, type TurnStatsFields } from '../cable/turnStats.js'
import { cableEventFor, cableStepFor, cableQuestionCloseFor, cableQuestionFor, DaemonCableHost } from '../cable/cableHost.js'
import { CableSession } from '../cable/cableSession.js'
import { PetStore } from '../cable/pets/store.js'
import { DialLog } from '../cable/dialLog.js'
import { DialVerdicts } from '../cable/dialPortVerdicts.js'
import { WindowForm } from '../cable/windowForm.js'
import { createWindowRouter } from '../cable/windowRoute.js'
import { WindowSelection } from '../cable/windowSelection.js'
import { WindowVisit } from '../cable/windowVisit.js'
import { MachineListCache } from '../device/machineList.js'
import { harnessDevicesRequest } from '../lib/harnessDevices.js'
import { truncateUtf8 } from '../lib/deviceRecentTrim.js'
import { setVoiceRouterDeviceConnected, setVoiceRouterSessions, shutdownVoiceRouter } from '../lib/voiceRouter.js'
import { createJevDecide } from '../lib/jev/jevClient.js'
import { createTally, createTierDecider, type Tier, type TierDecision, type TierInput } from '../lib/notifyTier.js'
import { createPartGuard } from './devicesGuard.js'
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
  /** How loudly a finished turn tells the devices. Defaults to rules plus Jev (off with `HARNESS_NOTIFY_SMART=0`). */
  decideTier?: (input: TierInput) => Promise<TierDecision>
  /** A monotonic clock in ms (default `performance.now`), for the reply throttle: a wall-clock step must not stall or burst it. */
  now?: () => number
  /** How the voice router's worker is stopped when the process exits: an engine process of its own. */
  onExit?: (run: () => void) => void
  /** Read this computer's agents again before a list is built from them: in their own process the devices
   *  keep a copy, asked of the core as the dial's tick or ⌘K needs it (services/devicesProcess.ts). */
  refresh?: () => Promise<void>
  /** Called with a function this part runs whenever it (re)connects to the core, which has forgotten what the devices
   *  told it (services/devicesProcess.ts): the cards wanted are said again. */
  onCoreConnected?: (run: () => void) => void
  /** An agent's conversation token totals, read fresh (not the 15 s cache); null when unknown or remote.
   *  Defaults to the core's `usageFresh`. */
  readUsage?: (agentId: string) => Promise<{ input?: number; cached?: number; output?: number } | null>
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
  const monotonic = deps.now ?? (() => performance.now())
  const superTabWait = (requestId: unknown): boolean => typeof requestId === 'string' && requestId.startsWith(SUPER_TAB_REQUEST_PREFIX)
  const tally = createTally((line) => log(`[cable] ${line}`))
  const tierOf = deps.decideTier ?? createTierDecider({
    tally,
    jev: process.env.HARNESS_NOTIFY_SMART === '0' ? null : createJevDecide({ backend: (method, path, body) => core.account.backend(method, path, body) }),
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
  // The Swarm cards' requests to the Super Tab service, through the core (core/devicesLink.ts). An error is an answer too.
  const askCards = async (payload: Record<string, unknown>): Promise<Record<string, unknown>> => {
    try { return await core.superTabRequest!(payload) } catch { return { error: 'SERVICE_UNAVAILABLE' } }
  }
  // How many attached devices asked for Swarm cards, and which Swarms the desktop has tabs for (read first). The core keeps
  // whether they are wanted (core/superTabCards.ts); this says it on a change and again when the core connects anew.
  let cardDevices = 0
  let cardInclude: string[] = []
  const tellCards = (): void => { void askCards({ action: 'cardsWanted', on: cardDevices > 0, include: cardDevices > 0 ? cardInclude : [] }) }
  deps.onCoreConnected?.(() => { if (cardDevices > 0) tellCards() })
  const cableHost = new DaemonCableHost({
    // The cloud harnesses too, where the core offers them: tiles on the desk the dial walks like any other.
    sessions: () => [...core.agents.advertised(), ...core.agents.cloud?.() ?? []],
    refresh: deps.refresh,
    displayName: (session) => core.agents.displayName(session),
    appFocus: () => focus.voice ?? undefined,
    activityText: (agentId) => core.agents.activityText(agentId),
    // The footer and its timer from the core; the agent's own latest sentence from the cards already seen here.
    activitySnapshot: async (agentId) => {
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
    watching: (on) => core.clients.dialWatching(on),
    // The core's own doors for a local agent. The fleet's router reaches them the same way; the dial uses
    // these only when it routes by itself, with the fleet off.
    sendTurn: (agentId, text) => core.turns.send(agentId, text),
    stopTurn: (agentId) => core.turns.stop(agentId),
    // A Super Tab wait is shown, never answered here: its id is no pane's, and nothing is typed for it.
    answer: (agentId, requestId, answers) => { if (!superTabWait(requestId)) core.questions.answer(agentId, requestId, answers) },
    answerReviewed: (answer) => superTabWait(answer.requestId) ? Promise.resolve(false) : core.questions.answerReviewed(answer),
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
    swarmCardsWanted: (on) => {
      const before = cardDevices
      cardDevices = Math.max(0, cardDevices + (on ? 1 : -1))
      if ((before === 0) !== (cardDevices === 0)) tellCards()
    },
    // The text is the service's to read and not validated by the core: cut here, on a character, to what the Pro takes.
    swarmCardRecap: async (tabId, leadId) => {
      const r = await askCards({ action: 'cardRecap', tabId, leadId })
      if (r.ok !== true || typeof r.text !== 'string' || typeof r.at !== 'number' || !Number.isInteger(r.at) || r.at < 0 || typeof r.none !== 'boolean') return null
      return { tabId, leadId, text: truncateUtf8(r.text, 1500), at: r.at, none: r.none }
    },
    swarmCardOpen: (session, tabId, leadId) => { void askCards({ action: 'cardOpen', session, tabId, leadId }) },
    // An error (no service, a refused post) is not `said`: the words go to the harness instead, never lost.
    swarmSay: async (harnessId, text) => (await askCards({ action: 'cardSay', harnessId, text })).said === true,
    // The Pro picked a Lead: the window opens that Swarm tab and project. Harmless with no window.
    superTabSelected: (superTabId, projectId) => core.clients.sendLocal({ type: 'dial_super_tab', payload: { superTabId, projectId } }),
    scrolled: (phase, dy, velocity, superTabId) => core.clients.sendLocal({ type: 'dial_scroll', payload: { phase, dy, velocity, ...(superTabId ? { superTabId } : {}) } }),
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
  const dispatch = (event: NonNullable<ReturnType<typeof cableEventFor>>): void | Promise<void> => {
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
    // On screen or a sub-agent's: silent, Jev is not asked. Otherwise the tier decides how loudly the dial tells. The
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
  const toDial = (event: NonNullable<ReturnType<typeof cableEventFor>>): void => {
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

  if (deps.cableDisabled) log('[cable] disabled (CABLE_DISABLE=true) — the serial port is left alone')
  else cable.start()
  ;(deps.onExit ?? ((run) => { process.once('exit', run) }))(() => shutdownVoiceRouter())

  const port: DevicesPort = {
    // Every card bound for the Wi-Fi devices goes down the cable too, translated once: a new kind of card
    // reaches the dial the day it reaches the backend's devices.
    card: (frame) => part.call('dial', () => {
      const close = cableQuestionCloseFor(frame as Parameters<typeof cableQuestionCloseFor>[0])
      if (close) { inOrder(close.agentId, () => { void cable.questionClose(close.agentId, close.requestId) }); return }
      const question = cableQuestionFor(frame as Parameters<typeof cableQuestionFor>[0])
      // A Super Tab member waiting on a person (core/superTabAttention.ts) is an alert as any question is.
      if (question) { tally(cableHost.describe(question.agentId)?.name ?? '', 'alert', question.superTab ? 'rule:super-tab' : 'rule:question', 'question', 0); inOrder(question.agentId, () => { void cable.question(question.agentId, question.requestId, question.questions, question.superTab) }); return }
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
      // The Swarms the window has tabs for are read first; said again to the core only when they change.
      const include = [...new Set((swarms?.swarms ?? []).map((s) => s.superTabId).filter((id): id is string => !!id))].slice(0, 16)
      if (include.join(',') !== cardInclude.join(',')) { cardInclude = include; if (cardDevices > 0) tellCards() }
      void cable.syncSwarms()
      void cable.syncAgents()
      // The Swarm cards link to their desk tab and follow its open project.
      void cable.syncSwarmCards()
    }),
    // The Swarms' cards and a Lead's recap for the Harness Pro: the cable carries them once it speaks the frames.
    swarmCards: (items) => part.call('dial', () => {
      cableHost.setSwarmCards(items)
      void cable.syncSwarmCards()
    }),
    swarmCardRecap: (recap) => part.call('dial', () => { void cable.swarmCardRecap(recap) }),
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
      for (const agentId of [...replies.keys()]) endReplies(agentId, false)   // no timer may fire into a stopped cable
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
  // Pets name files on this computer by path, so they are answered to a process here only, never the owner's relayed app.
  const local = (type: string) => (payload: Record<string, unknown>, asker: { local?: boolean; owner: boolean }) =>
    !asker.owner ? { error: 'OWNER_REQUIRED' } : asker.local ? harnessDevicesRequest(tab, type, payload) : { error: 'LOCAL_ONLY' }
  return {
    harness_devices_list: answer('harness_devices_list'), harness_device_settings: answer('harness_device_settings'),
    pet_preview: local('pet_preview'), pet_apply: local('pet_apply'), pet_reset: local('pet_reset'), pet_status: local('pet_status'),
  }
}
