// Everything the cable session needs from the rest of the daemon, in one place.
//
// The session owns the protocol and nothing else; this owns the answers. Keeping them apart is what lets
// the protocol be tested against a fake host — the alternative is a suite that needs tmux, a microphone
// and a network to prove that `hello` gets a `welcome`.
//
// Nothing here is new machinery. The agent list is the registry the web and the backend socket already
// read, the router is the one the backend already calls for remote machines, and the turn events arrive
// as the very `commander_event` cards the WiFi device receives — teed at the socket rather than emitted
// again here, so the two device surfaces cannot drift.
//
// Which machine an agent is on, and every turn, stop and answer sent to it, is the fleet's router
// (services/fleetRouter.ts), shared with ⌘K and the window's voice route. This host asks it through the
// core's port (`wiring.fleet`), never holding it (step D1): a dial in a process of its own asks the same
// port across the service link. It keeps a router of its own for this computer alone, and uses it
// whenever the fleet cannot answer — off, or its call failed — as the dial did before the fleet was a
// service. Its tests give it a bare fleet to route over by itself.
import { join } from 'node:path'
import { notificationReadToken, type UnreadNotification } from '../lib/notificationRead.js'

import type { RegisteredSession } from '../lib/registry.js'
import { fetchRelease, loadImage, otaKeyForBoard, shouldOffer } from './fwPush.js'
import { routeVoiceTask, type RouterAgent, type RouterContinuity } from '../lib/voiceRouter.js'
import { env } from '../config/env.js'
import { FleetRouter } from '../services/fleetRouter.js'
import type { ForkResult } from '../core/api.js'
import type { FleetRouting } from '../services/fleet.js'
import { ServiceUnavailableError } from '../core/serviceHost.js'

import type { AppSwarms, CableAgent, CableHost, CableMachine, CableMachineSource, CableSwarm, CableTile, DialStatus, OpenReason, RouteDecision } from './cableSession.js'
import type { WindowRoute } from './windowRoute.js'
import type { SelectionCommand, SelectionResult } from './windowSelection.js'
import type { VisitCommand, VisitResult } from './windowVisit.js'
import type { FormCommand, FormResult } from './windowForm.js'
import type { MachineFleet } from './machineFleet.js'
import type { ReviewedAnswer, AnswerReceipt } from './questionInbox.js'

/** One completed turn's recap, as the mirror keeps them. */

export interface RecentTurn {
  recap?: string
  text?: string
  /** What the USER asked on that turn. The topic lives here; the recap holds the answer. */
  ask?: string
}

export interface CableHostWiring {
  /** The live agents the apps are shown, and the name they show for each: the router this host keeps for
   *  this computer reads them (the core's `agents.advertised` and `agents.displayName`). */
  sessions: () => RegisteredSession[]
  displayName: (session: RegisteredSession) => string
  /** Exact live terminal footer for a local agent; absent when no footer is visible. */
  activityText?: (agentId: string) => Promise<string | null>
  /** The person's own last questions to a LOCAL agent, newest first. */
  recentAsks: (agentId: string) => string[] | Promise<string[]>
  /** Read the agents again before a list is built from them (see FleetLocal.refresh). */
  refresh?: () => Promise<void>
  machineName: () => string
  /** This computer's machineId, or '' when the daemon has never resolved one (signed out). */
  machineId: () => string
  /** A stable id for this computer, used to name the local row when there is no machineId yet. */
  computerId: () => string
  /** Whether this computer holds an account. False → the dial serves THIS computer alone: the cloud
   *  lane (the other machines, and voice) is what an account buys, and it is not dialled without one. */
  signedIn?: () => boolean
  /** The account's sign-in, for the transcriber: the core's (`account.accessToken`), never one of this
   *  host's own. Absent, voice says to sign in. */
  accessToken?: (opts?: { force?: boolean; failedToken?: string }) => Promise<string>
  /** The account's environment, which the transcriber checks the upload against. */
  environment?: () => string
  /** A dial is on the wire on this computer, or none is any more: the core streams the turn cards and
   *  makes the recaps for it, as for a device watching through the backend. */
  watching?: (on: boolean) => void
  /** Deliver text into an agent. The SAME path the web and the WiFi device use — see cli.ts. */
  sendTurn: (agentId: string, text: string) => void
  stopTurn: (agentId: string) => void
  answer: (agentId: string, requestId: string, answers: Record<string, string>) => void
  answerReviewed?: (answer: ReviewedAnswer) => Promise<boolean>
  /** Recaps of an agent's last `n` completed turns — for routing, and for redrawing a reattached dial. */
  recent: (agentId: string, n: number) => RecentTurn[] | Promise<RecentTurn[]>
  /** The opaque runtime-v1 profile, which is where the dial's Model/Effort chips come from. */
  runtimeProfile?: (session: RegisteredSession) => string | null
  updateAgent?: (agentId: string, model?: string, effort?: string) => void
  /** The runtime catalog, from the same provider the web and the WiFi device read. */
  listModels?: (agentId: string) => Promise<Array<{ id: string }>>
  /** The dial moved to another agent — the desktop window should show that agent on its own machine. */
  focused?: (machineId: string, agentId: string) => void
  /**
   * A notification was tapped: the window gives that agent a tile of its own. With `reason`
   * `'question'` it was a question screen instead, and the window only brings the agent forward.
   */
  opened?: (machineId: string, agentId: string, reason?: OpenReason) => void
  notificationRead?: (machineId: string, agentId: string, readToken: string) => void
  /** A fork the dial asked for is open: the window puts it beside its source and focuses it. */
  forked?: (machineId: string, agentId: string, sourceAgentId: string) => void
  /** The dial asked for a fork of a LOCAL agent — see lib/forkAgent.ts. Resolves to the new agent's id. */
  forkAgent?: (agentId: string) => Promise<{ ok: true; agentId: string } | { ok: false; error: string; detail?: string }>
  /** The dial picked a swarm: the window switches to it. */
  swarmSelected?: (swarmId: string) => void
  /** A finger on the dial's glass, in pieces, while it is down. */
  scrolled?: (phase: 'down' | 'move' | 'up', dy: number, velocity: number) => void
  /** The dial came, went, or started taking an update — see CableSession's onDialStatus. */
  dialStatus?: (status: DialStatus) => void
  /** Offer a spoken task to the desktop window's palette. Omitted when there is no window plumbing. */
  routeInWindow?: (text: string, cmd?: string) => Promise<WindowRoute>
  selectPassage?: (command: SelectionCommand) => Promise<SelectionResult>
  clearSelection?: () => void
  visit?: (command: VisitCommand) => Promise<VisitResult>
  clearVisit?: () => void
  form?: (command: FormCommand) => Promise<FormResult>
  clearForm?: () => void
  log: (line: string) => void
  /**
   * Which machine an agent is on, and getting a turn, a stop or an answer there: the fleet service's
   * routing, through the core's port (core/api.ts `FleetRouting`). Read at every call, and null while the
   * fleet is off. Absent, this host routes by itself.
   */
  fleet?: () => FleetRouting | null
}

/** Whether an id is the router's placeholder for a machine with no id yet (`cable:` and the computer id;
 *  see services/fleetRouter.ts) rather than a machine the backend has heard of. */
function isPlaceholder(id: string): boolean {
  return id.startsWith('cable:')
}

export class DaemonCableHost implements CableHost {
  /**
   * This host's own router: over the bare fleet it is given (its tests), or over none, for this computer
   * alone. Asked whenever the fleet service cannot answer — see route.
   */
  private readonly local: FleetRouter

  /**
   * The machine whose agents are on the dial right now. Defaults to — and falls back to — the local one:
   * it is the only machine that is certainly reachable, so it is the honest thing to land on.
   *
   * Held in memory only. The dial deliberately does not remember a selection across its own reboot (a
   * restored id is meaningless until you know whose computer the cable is in), and this side does not
   * remember across a daemon restart either — that is when the registry reloads anyway.
   */
  private selected = ''

  /**
   * `fleet` is a bare lane to the other machines for this host's own router — its tests give it one. A
   * daemon gives none: its dial reaches the fleet service's router through the core (`wiring.fleet`).
   * With neither, the wheel is the local row and nothing else.
   */
  constructor(private readonly wiring: CableHostWiring, fleet?: MachineFleet) {
    this.local = new FleetRouter({
      ...wiring,
      // The same set `agents_list` answers the apps with — see the router's localAgents.
      sessions: () => wiring.sessions(),
      displayName: (session) => wiring.displayName(session),
      desk: () => this.desk,
    }, fleet)
  }

  /**
   * Ask the fleet service's router through the core's port, or this host's own when the fleet is off or
   * its call came back unavailable (a failing port's fallback, core/api.ts FLEET_FALLBACKS). Either way the
   * answer is a router's, refusals included: the dial never reads a made-up answer as the fleet's.
   */
  private viaFleet<T>(ask: (routing: FleetRouting) => T): T {
    const fleet = this.wiring.fleet?.()
    if (!fleet) return ask(this.local)
    const unavailable = (error: unknown): T => {
      if (error instanceof ServiceUnavailableError) return ask(this.local)
      throw error
    }
    let answer: T
    try {
      answer = ask(fleet)
    } catch (error) {
      return unavailable(error)
    }
    return answer instanceof Promise ? answer.catch(unavailable) as T : answer
  }

  /** The identity of the computer at the other end of the cable. */
  localMachine(): { id: string; name: string } {
    return { id: this.localId(), name: this.wiring.machineName() }
  }

  private localId(): string {
    return this.local.localId()
  }

  /** Whether the dial is looking at THIS computer. Everything forks on this one question. */
  isLocalSelected(): boolean {
    return this.selectedMachine() === this.localId()
  }

  selectedMachine(): string {
    return this.selected || this.localId()
  }

  /** The local row, then the fleet's — the router's list, which ⌘K reads too. */
  listMachines(): Promise<{ machines: CableMachine[]; source: CableMachineSource }> {
    return this.viaFleet((r) => r.listMachines())
  }

  async selectMachine(machineId: string): Promise<{ ok: true } | { ok: false; code: string; message: string }> {
    if (machineId === this.localId()) {
      this.selected = machineId
      // Let go of the REMOTE machine after a linger, keeping the socket — then announce where the dial
      // actually is. `activeMachineId` on the account is then true for this machine too, instead of
      // silently going stale on whatever was selected last.
      this.viaFleet((r) => r.release())
      void this.announceSelection()
      return { ok: true }
    }
    if (!this.viaFleet((r) => r.hasLane())) {
      return { ok: false, code: 'UNAVAILABLE', message: 'Sign in on this computer to reach other machines' }
    }
    const selected = await this.viaFleet((r) => r.select(machineId))
    if (!selected.ok) return selected
    this.selected = machineId
    return { ok: true }
  }

  /**
   * The dial is on the wire again.
   *
   * If it left looking at another machine, the cloud lane has to be back UP before the state push that
   * follows — that push calls listAgents(), which for a remote machine is an RPC over exactly this lane.
   * Awaiting it here would block the greeting, so it is fired and the push retries on the next tick if
   * it loses the race; a failure marks the machine unreachable rather than pretending it has no agents.
   */
  onDialAttached(): void {
    this.wiring.watching?.(true)
    if (!this.viaFleet((r) => r.hasLane())) return
    // Signed out there is no lane to open: the socket is authenticated, so dialling it would fail once
    // per plug-in and log a failure for something nobody asked for. The dial still works — it is on the
    // cable, and everything it shows on this computer is served in-process.
    if (this.wiring.signedIn?.() === false) {
      this.wiring.log('cable: dial on the wire — this computer only (not signed in)')
      return
    }
    this.wiring.log('cable: dial on the wire — opening the cloud lane')
    void (async () => {
      // The socket first, and unconditionally: it is what makes the machine wheel's dots live, and it is
      // held for as long as the dial is plugged in whether or not anything is selected.
      const online = await this.viaFleet((r) => r.online())
      if (!online.ok) throw new Error(online.message)
      await this.announceSelection()
    })().catch((err) => this.wiring.log(`cable: could not open the lane (${(err as Error).message})`))
  }

  /**
   * Tell the backend which machine the dial is on.
   *
   * Sent for the LOCAL machine too. It costs one frame and it is the only thing that makes
   * `DeviceBinding.activeMachineId` true rather than "whatever was selected last" — which is what the web
   * and the mobile app read to say where a dial is.
   *
   * Skipped only for the placeholder id, which is not a machineId and means nothing to the backend.
   */
  private async announceSelection(): Promise<void> {
    if (!this.viaFleet((r) => r.hasLane())) return
    const machineId = this.selectedMachine()
    if (isPlaceholder(machineId)) return
    const selected = await this.viaFleet((r) => r.select(machineId))
    // Never fatal. The local machine in particular must stay usable with no backend at all — it is the
    // one machine the cable can vouch for on its own.
    if (!selected.ok) this.wiring.log(`cable: could not announce ${machineId} (${selected.message})`)
  }

  /**
   * The dial is gone — cable pulled, or the far end stopped answering.
   *
   * Drop the lane NOW rather than lingering. The daemon holds it on the dial's behalf and nothing else in
   * this process uses it, so keeping it open leaves the account showing a device attached to a machine
   * while the dial sits unplugged in a drawer — and every card that machine produces would be relayed to
   * a screen that is not there.
   */
  onDialGone(): void {
    this.wiring.watching?.(false)
    this.wiring.clearSelection?.()
    this.wiring.clearVisit?.()
    this.wiring.clearForm?.()
    this.viaFleet((r) => r.release(true))
  }

  /**
   * The last status the session reported, kept so a window that connects AFTER the dial was plugged
   * in can be told at once. Without this the row would say "no device" until the next unplug.
   */
  private dialStatusNow: DialStatus = { attached: false }

  onDialStatus(status: DialStatus): void {
    this.dialStatusNow = status
    this.wiring.dialStatus?.(status)
  }

  currentDialStatus(): DialStatus {
    return this.dialStatusNow
  }

  selectPassage(command: SelectionCommand): Promise<SelectionResult> {
    return this.wiring.selectPassage?.(command) ?? Promise.resolve({ ok: false, error: 'Update Harness to select text.' })
  }

  machineName(): string {
    return this.wiring.machineName()
  }

  appName(): string {
    return 'harness'
  }

  voiceLang(): string {
    // A PROPOSAL, not a decision. The dial keeps its own choice in NVS and states it on every capture —
    // the person holding it may well speak something other than this laptop is set to.
    const locale = process.env.LANG ?? ''
    return locale.startsWith('vi') ? 'vi' : 'en'
  }

  /**
   * The window's tiles on its active tab, in tile order. This IS the dial's list — see listAgents. A
   * router this host builds for itself reads it to hold a tile whose machine dropped out; the fleet
   * service's router reads the window's own report of it.
   */
  private desk: string[] = []

  /** Last logged shape of the tab's list, so the line prints on change only. */
  private deskShape = ''

  /**
   * The window changed which agents have a tile, or what order they are in.
   *
   * Order is the payload, not just membership: the dial walks the same grid the
   * eyes are on, so the tiles come first in the carousel and in their own order.
   */
  setDesk(agentIds: string[]): void {
    this.desk = [...agentIds]
  }

  /** The window's swarms, or null once it has gone — see setSwarms. */
  private swarms: AppSwarms | null = null

  /**
   * The window described its swarms (or, with null, went away).
   *
   * Null is what tells the dial the window is SHUT: an empty desk with a window behind it is an empty
   * tab, an empty desk with none is a closed app, and the two draw different screens — see listAgents.
   */
  setSwarms(swarms: AppSwarms | null): void {
    this.swarms = swarms
  }

  /** What the window still has unread, newest first. Empty until a window says otherwise. */
  private unread: UnreadNotification[] = []

  setUnread(items: UnreadNotification[]): void {
    this.unread = items
  }

  listUnread(): UnreadNotification[] {
    return this.unread
  }

  readNotification(agentId: string, readToken: string): void {
    if (!notificationReadToken(readToken)) return
    const item = this.unread.find(n => n.agentId === agentId && n.readToken === readToken)
    if (!item?.machineId) return
    // Keep it until the window confirms through app_unread. Retrying is safe;
    // the window checks the same identity again, even across remote machines.
    this.wiring.notificationRead?.(item.machineId, agentId, readToken)
  }

  listSwarms(): { selected: string; swarms: CableSwarm[]; tiles: CableTile[] } {
    const app = this.swarms
    if (!app) return { selected: '', swarms: [], tiles: [] }
    return {
      selected: app.active,
      swarms: app.swarms.map((s) => ({ id: s.id, name: s.name, agents: s.agentIds.length, panes: s.panes })),
      tiles: app.tiles,
    }
  }

  selectSwarm(swarmId: string): void {
    if (!swarmId || !this.swarms?.swarms.some((s) => s.id === swarmId)) {
      this.wiring.log(`cable: ignored select for unknown swarm ${swarmId || '(empty)'}`)
      return
    }
    this.wiring.log(`cable: swarm → ${swarmId}`)
    this.wiring.swarmSelected?.(swarmId)
  }

  /**
   * THE DIAL HOLDS THE ACTIVE TAB'S PANES AND NOTHING ELSE.
   *
   * It used to get every agent on every machine — the window's tiles first as the ring, the rest tagged
   * "off-ring, still sent" for the overview count and the pull-down switcher. That is what let a
   * reconnect refill 78 agents into a screen that shows one: ten seconds under one display lock, the task
   * watchdog, a reboot (PR #79 painted it once; this stops sending it). The count now travels as a number
   * (`agentTotal`), the switcher is gone, and a notification for an agent the dial does not hold carries
   * its own name.
   *
   * Three answers, and each is a state the dial draws:
   *   - no window (`swarms === null`)      → `[]`; the dial shows "Run OpenHarness on your computer".
   *   - a window with an empty tab         → `[]`; the dial shows "Nothing on this tab".
   *   - a window with panes                → those agents, in tile order; a tile whose machine dropped out
   *                                          is held from the router's `knownAgents` (see listAgentsFlat).
   */
  async listAgents(): Promise<CableAgent[]> {
    return (await this.listAgentSnapshot()).agents
  }

  async listAgentSnapshot(): Promise<{ agents: CableAgent[]; tab: string; total: number }> {
    const flat = await this.listAgentsFlat()
    const byId = new Map(flat.map((a) => [a.id, a]))
    // app_panes and app_swarms are separate messages. Never label the new panes
    // with the previous tab (or vice versa) between those two arrivals. The
    // swarm announcement already contains membership in the same tile order.
    const app = this.swarms
    const tab = app?.active ?? ''
    const ids = app?.swarms.find(s => s.id === tab)?.agentIds ?? []
    const out = ids.map(id => byId.get(id)).filter((a): a is CableAgent => !!a)
    // One line per CHANGE. The failure this catches is silent by nature: tiles whose ids this daemon does
    // not know drop out of the list, which looks exactly like the window never having opened them.
    const shape = app === null
      ? '(no window)'
      : out.length ? out.map((a) => a.id.slice(0, 4)).join(' ') : '(empty tab)'
    if (shape !== this.deskShape) {
      this.deskShape = shape
      this.wiring.log(`cable: tab ${shape} · ${flat.length} in all`)
    }
    return { agents: out, tab, total: this.viaFleet((r) => r.agentTotal()) }
  }

  /** How many agents the account has across every machine — the overview's number, sent beside the
   *  tab's list rather than as 70 rows the dial would hold for a digit. See the router's agentTotal. */
  agentTotal(): number {
    return this.viaFleet((r) => r.agentTotal())
  }

  /** The active tab's id, or '' with no window. Travels on `agents.end` so the dial can tell an empty
   *  tab from a shut window — the two draw different screens. */
  activeSwarm(): string {
    return this.swarms?.active ?? ''
  }

  /**
   * Name, engine and machine of an agent this daemon has ever listed — for a `summary` or `question`
   * about one the dial no longer holds. See the router's describe.
   */
  describe(agentId: string): { name: string; engine: string; machine: string } | undefined {
    return this.viaFleet((r) => r.describe(agentId))
  }

  async activityText(agentId: string): Promise<string | null> {
    if (!this.viaFleet((r) => r.isLocalAgent(agentId))) return null
    return await this.wiring.activityText?.(agentId) ?? null
  }

  /** A card arrived from a machine for an agent — see the router's noteAgent. */
  noteAgent(machineId: string, agentId: string): void {
    this.viaFleet((r) => r.noteAgent(machineId, agentId))
  }

  /**
   * EVERY agent in LIST order — this computer first, then each machine in wheel order. The router's flat
   * list, the one ⌘K weighs a typed task against; `listAgents()` is the DIAL's view of the same snapshot,
   * re-cut around the tiles the window has open.
   */
  listAgentsFlat(): Promise<CableAgent[]> {
    return this.viaFleet((r) => r.listAgentsFlat())
  }

  /** Which machine an agent lives on, or '' — never a guess. See the router's machineOf. */
  private machineOf(agentId: string): string {
    return this.viaFleet((r) => r.machineOf(agentId))
  }

  openAgent(agentId: string, reason?: OpenReason): void {
    const machineId = this.machineOf(agentId)
    if (!machineId) {
      // Same rule as focus: an agent id without its machine is not routable, and guessing is how a
      // remote move used to land on a local agent.
      this.wiring.log(`cable: ignored open for unknown agent ${agentId}`)
      return
    }
    this.wiring.log(`cable: open ${machineId}/${agentId} (${reason ?? 'notification'})`)
    this.wiring.opened?.(machineId, agentId, reason)
  }

  form(command: FormCommand): Promise<FormResult> {
    return this.wiring.form?.(command) ?? Promise.resolve({ ok: false, active: false, error: 'Update Harness for New Harness.' })
  }

  visit(command: VisitCommand): Promise<VisitResult> {
    const machineId = command.agentId ? this.machineOf(command.agentId) : undefined
    if ((command.op === 'open' || command.op === 'latest') && !machineId) return Promise.resolve({ ok: false, active: false, error: 'That harness is no longer available.' })
    return this.wiring.visit?.({ ...command, machineId }) ??
      Promise.resolve({ ok: false, active: false, error: 'Update Harness to visit an alert.' })
  }

  /**
   * Fork an agent from the dial: the same `agent_fork` the window sends, on the agent's own machine, and
   * then an `open` for the new agent so the window gives it a tile — the fork's whole point on the dial
   * is "this one, again, beside it", and the person's hand is on the dial, not the mouse.
   */
  forkAgent(agentId: string): Promise<ForkResult> {
    // On the agent's own machine, through the router, which notes the new agent there. A fork it
    // actually asked for is said, and opened in the window.
    return this.viaFleet((r) => r.forkAgent(agentId)).then(({ result, machineId, asked }) => {
      if (!asked) return result
      if (result.ok) {
        this.wiring.log(`cable: fork ${machineId}/${agentId} → ${result.agentId}`)
        if (this.wiring.forked) this.wiring.forked(machineId, result.agentId, agentId)
        else this.wiring.opened?.(machineId, result.agentId)
      } else {
        this.wiring.log(`cable: fork ${machineId}/${agentId} refused (${result.error}${result.detail ? `: ${result.detail}` : ''})`)
      }
      return result
    })
  }

  /** Whether this daemon's last list held that agent — see CableHost.knows. */
  knows(agentId: string): boolean {
    return this.viaFleet((r) => r.knows(agentId))
  }

  /**
   * Deliver a turn, and SAY whether it could be — through the router, on the agent's own machine, with
   * the refusal for a machine whose last request did not come back. See the router's sendTurn.
   */
  sendTurn(agentId: string, text: string): { ok: true } | { ok: false; machine: string; reason: string } {
    return this.viaFleet((r) => r.sendTurn(agentId, text))
  }

  /** Who the last delivered turn went to, and how long ago — by any of the router's callers. */
  lastRouted(): RouterContinuity | undefined {
    return this.viaFleet((r) => r.lastRouted())
  }

  stopTurn(agentId: string): void {
    this.viaFleet((r) => r.stopTurn(agentId))
  }

  canSpeakQuestion(agentId: string): boolean {
    return this.viaFleet((r) => r.canSpeakQuestion(agentId))
  }

  answerReviewed(answer: ReviewedAnswer): Promise<AnswerReceipt> {
    return this.viaFleet((r) => r.answerReviewed(answer))
  }

  answer(agentId: string, requestId: string, answers: Record<string, string>): void {
    this.viaFleet((r) => r.answer(agentId, requestId, answers))
  }


  focus(agentId: string): void {
    // A statement about where the user is looking, and the desktop window follows it: turning the dial to
    // an agent switches the terminal on screen to the same one. The daemon still has no window of its own
    // — it forwards, and the app decides what following means for it.
    // FORWARDED FOR EVERY AGENT, including one running on another computer. That used to be refused on
    // the grounds that there was no window here to move — which stopped being true when the desktop app
    // grew panes for remote machines. The hand is still at THIS desk; the pane it wants in front of it
    // may simply belong to a machine somewhere else, and the app is the side that decides what it can do
    // about an agent it does not have.
    const machineId = this.machineOf(agentId)
    if (!machineId) {
      // An agent id without its machine is not routable. Guessing the selected or local machine is how a
      // remote dial move used to yank the desktop back to a local agent.
      this.wiring.log(`cable: ignored focus for unknown agent ${agentId}`)
      return
    }
    // No edge to name any more: the carousel only walks agents the window already has a tile for, so a
    // focus arriving from the dial is always about a tile that exists. Which tile to REPLACE was the
    // only question the old arcs answered, and there is nothing left to replace.
    this.wiring.log(`cable: focus ${machineId}/${agentId}`)
    this.wiring.focused?.(machineId, agentId)
  }

  /**
   * One tick of the carousel, for a device that has no ring of its own: the paired Autonomous device
   * asks for "next"/"previous" and this picks the neighbour the USB dial's thumb would land on — the same
   * walk (`listAgents()`, the tab in tile order), the same wrap at either end, and the same `focus()`
   * forward to the app. With no current agent on the tab the walk starts at its first (next) or last
   * (previous) tile.
   */
  async stepFocus(direction: 'next' | 'previous', currentAgentId?: string): Promise<{ machineId: string; agentId: string } | 'no_agents'> {
    const walk = (await this.listAgents()).map((a) => a.id)
    if (walk.length === 0) return 'no_agents'
    const at = currentAgentId ? walk.indexOf(currentAgentId) : -1
    const agentId = at < 0
      ? walk[direction === 'next' ? 0 : walk.length - 1]
      : walk[(at + (direction === 'next' ? 1 : walk.length - 1)) % walk.length]
    this.focus(agentId)
    return { machineId: this.machineOf(agentId), agentId }
  }

  scrolled(phase: 'down' | 'move' | 'up', dy: number, velocity: number): void {
    // THE ENDS ARE LOGGED, THE MIDDLE IS NOT. A stroke is a `down`, a dozen `move`s and an `up`, several
    // times a second: logging the middle buries every other line in the file. But the failure this
    // protocol is most exposed to is a stroke that never CLOSES — the far side then holds a drag forever
    // and its list stops answering the mouse — and that failure is invisible without a matching pair to
    // look for. Two lines per swipe buys the one thing worth seeing.
    if (phase !== 'move') {

      this.wiring.log(phase === 'down' ? 'cable: scroll ↓' : `cable: scroll ↑ (v=${velocity})`)
    }
    this.wiring.scrolled?.(phase, dy, velocity)
  }

  updateAgent(agentId: string, model?: string, effort?: string): void {
    this.viaFleet((r) => r.updateAgent(agentId, model, effort))
  }

  /** The last few turns, newest first, in the shape the dial's tile draws — from the agent's own machine. */
  recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string; ask: string }>> {
    return this.viaFleet((r) => r.recentSummaries(agentId))
  }

  /** The person's own last questions to an agent, newest first — what the router ranks on. */
  recentAsks(agentId: string): Promise<string[]> {
    return this.viaFleet((r) => r.recentAsks(agentId))
  }

  listModels(agentId: string): Promise<string[]> {
    return this.viaFleet((r) => r.listModels(agentId))
  }

  /**
   * The image to offer, or null for "nothing to do".
   *
   * Null covers four different situations on purpose, because the device reacts to all of them the same
   * way — by carrying on: it is current, it is running a dev build that must not be touched, the manifest
   * is unreachable, or WE DO NOT KNOW WHICH BOARD THIS IS. An update is an opportunity here, never a
   * condition of working.
   *
   * That fourth case is the one with teeth. The manifest has always been per-board, but this call used to
   * take the default key and so always resolved the round dial's entry — harmless while a dial was the
   * only thing that could plug in, and a brick the moment a Pro could: its ESP32-P4 cannot run an
   * ESP32-S3 image, and the cable that would let us put it right is the firmware that just stopped.
   */
  async firmwareFor(runningVersion: string, hw?: string): Promise<{ version: string; image: Buffer; sha256: string } | null> {
    if (env.CABLE_FW_DISABLE) return null
    const key = otaKeyForBoard(hw)
    if (!key) {
      this.log(`cable: not offering firmware — unknown board "${hw}"`)
      return null
    }
    const release = await fetchRelease(env.CABLE_FW_MANIFEST_URL, key)
    if (!release || !shouldOffer(runningVersion, release.version)) return null
    const image = await loadImage(release, join(env.ADAPTER_DATA_DIR, 'firmware'))
    if (!image) return null
    return { version: release.version, image, sha256: release.sha256 }
  }

  /**
   * Which agent the spoken words belong to.
   *
   * The daemon's own router: it scores by name and recent activity, and classifies with an engine CLI the
   * machine is ALREADY running when the score cannot separate the top two. No key, no relay, no network —
   * which is the whole reason voice on the cable does not inherit the hosted path's failure modes.
   */
  /**
   * Give the window first refusal on a spoken task.
   *
   * A pass-through by design: everything interesting — whether a window is even attached, the two-phase
   * wait, the deadlines — belongs to the router in windowRoute.ts, which is testable without a socket.
   * This exists so the session can ask through the same host it asks everything else through.
   */
  async routeInWindow(text: string, cmd?: string): Promise<WindowRoute> {
    if (!this.wiring.routeInWindow) return { t: 'unavailable' }
    try {
      return await this.wiring.routeInWindow(text, cmd)
    } catch (err) {
      // Never let a broken window path swallow a sentence a person spoke: fall back to routing here.
      this.wiring.log(`cable: the window route failed (${(err as Error).message}) — routing here`)
      return { t: 'unavailable' }
    }
  }

  async route(transcript: string, agents: CableAgent[]): Promise<RouteDecision> {
    // Each agent's recaps come from ITS OWN machine — recentSummaries routes by agentId. Scored against
    // the wrong machine's history, a spoken turn is routed by what some other computer's agents were last
    // doing, which is both wrong and completely invisible, because the router always answers with
    // something. The machine name travels too, so two agents with the same name on two computers are
    // distinguishable by the only thing that separates them.
    const candidates: RouterAgent[] = await Promise.all(agents.map(async (a) => ({
      id: a.id,
      name: a.name,
      engine: a.engine,
      machine: a.machine,

      // THE QUESTION, not the answer. A recap summarises what the agent replied — "1945." is a correct
      // recap and a useless routing signal, and the next question about the same conversation matches
      // nothing in it.
      //
      // TWO FIELDS, because two routers read this. The backend is sent `prompts` and is told plainly
      // when an agent has none; the local ladder below it still reads `recentSummary`, where a recap
      // standing in for a missing ask is the best it has. Mixing the two into one field is what let a
      // summary of the agent's own replies reach a prompt that called them the person's questions.
      prompts: await this.recentAsks(a.id),
      recentSummary: (await this.recentSummaries(a.id))
        .map((r) => r.ask || r.recap || r.text || '')
        .filter(Boolean)
        .join(' · '),
    })))
    const decision = await routeVoiceTask(transcript, candidates, undefined, undefined, this.lastRouted())
    return { agentId: decision.agentId, confidence: decision.confidence, reason: decision.reason }
  }

  /**
   * Transcribe one capture.
   *
   * The dial records and the daemon transcribes. The device holds no cloud credential and never talks to
   * one; THIS side has an account — `harness login` leaves a real SSO session behind, and the endpoint is
   * gated by it like every other control-plane call.
   *
   * No shared secret, deliberately. This repository is public, so a key baked into it is a key everybody
   * has; a bearer token is issued per person, expires on its own and can be revoked.
   *
   * The 401 retry is not defensive padding. A token can expire between the moment the user pressed the
   * dial's button and the moment the upload finishes — a long dictation is minutes — and losing a spoken
   * sentence to a clock is the one failure the person cannot work around.
   */
  async transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string> {
    // The text reaches the dial's glass as a toast, so it is addressed to the person holding it, not to
    // a terminal: signing in happens on the computer, and that is the one thing they need to know.
    const accessToken = this.wiring.accessToken
    if (!accessToken || this.wiring.signedIn?.() === false) throw new Error('Sign in on your computer to use voice')
    const autonomousEnv = this.wiring.environment?.() ?? ''

    const url = `${this.backendHttpBase()}${env.CABLE_STT_PATH}?lang=${encodeURIComponent(lang)}`
    // The WAV is built ONCE: it is the same bytes on a retry, and re-encoding megabytes to say the same
    // thing twice is time taken out of a person's turn.
    const boundary = `harness-${Math.random().toString(36).slice(2)}`
    const body = multipart(wav(pcm, sampleRate), 'voice.wav', 'audio/wav', boundary)

    const post = async (token: string) =>
      fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'x-autonomous-env': autonomousEnv,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        body,
      })

    let token = await accessToken()
    let res = await post(token)
    if (res.status === 401) {
      // `failedToken` is what makes this one refresh rather than a loop: the manager only refreshes when
      // the token that failed is still the current one, so two callers racing a stale token do not each
      // burn a refresh.
      await res.body?.cancel()
      token = await accessToken({ force: true, failedToken: token })
      res = await post(token)
    }
    if (!res.ok) {
      const failure = await transcriptionFailure(res)
      // Keep the backend error category and edge request id, never the audio, transcript, token or raw
      // response. A bare 403 previously disappeared into a device toast with no way to diagnose it.
      this.wiring.log(`cable: stt HTTP ${res.status} code=${failure.code} kind=${failure.kind} request=${failure.request}`)
      throw new Error(failure.message)
    }

    const json = (await res.json()) as { success?: boolean; data?: { transcript?: string }; error?: { message?: string } }
    if (!json.success) throw new Error(json.error?.message ?? 'Transcription failed')
    return json.data?.transcript ?? ''
  }

  /** The control plane, derived from the socket URL the daemon already talks to. */
  private backendHttpBase(): string {
    return env.BACKEND_WS_URL.replace(/\/$/, '').replace(/^wss:/, 'https:').replace(/^ws:/, 'http:')
  }

  log(line: string): void {
    this.wiring.log(line)
  }
}

/** Turn known service failures into short device instructions without reflecting response contents. */
async function transcriptionFailure(res: Response): Promise<{ message: string; code: string; kind: string; request: string }> {
  const contentType = res.headers.get('content-type') ?? ''
  const kind = res.headers.get('cf-mitigated') === 'challenge' ? 'challenge'
    : contentType.includes('application/json') ? 'json' : contentType.includes('text/html') ? 'html' : 'other'
  let code = 'unknown'
  if (contentType.includes('application/json')) {
    const body = await res.json().catch(() => null) as { error?: { code?: unknown } } | null
    const candidate = body?.error?.code
    if (typeof candidate === 'string' && [
      'AUTONOMOUS_ENV_MISMATCH', 'AUTONOMOUS_ENV_NOT_ALLOWED', 'UNAUTHORIZED',
      'AUTH_SERVICE_UNAVAILABLE', 'STT_FAILED', 'BAD_REQUEST',
    ].includes(candidate)) code = candidate
  } else {
    await res.body?.cancel()
  }
  const ray = res.headers.get('cf-ray') ?? ''
  const request = /^[a-f0-9]{16}-[A-Z]{3,8}$/.test(ray) ? ray : 'unknown'
  const message = res.status === 401 || code === 'AUTONOMOUS_ENV_MISMATCH' || code === 'AUTONOMOUS_ENV_NOT_ALLOWED'
    ? 'Sign in again on your computer to use voice'
    : res.status === 403 ? 'Voice service rejected upload (403). Try again'
    : res.status === 429 ? 'Voice service busy. Try again shortly'
    : res.status >= 500 ? 'Voice service unavailable. Try again'
    : `Transcription failed (HTTP ${res.status})`
  return { message, code, kind, request }
}

/**
 * Wrap raw 16-bit little-endian mono PCM in a WAV header.
 *
 * A self-describing container rather than raw samples, and the server depends on it: it forwards the file
 * under its own Content-Type with NO encoding or sample-rate hints, precisely so the container can state
 * its own rate. Headerless PCM would be read as if the first 44 bytes were audio.
 */
export function wav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + pcm.length, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16) // fmt chunk size
  header.writeUInt16LE(1, 20) // PCM
  header.writeUInt16LE(1, 22) // mono
  header.writeUInt32LE(sampleRate, 24)
  header.writeUInt32LE(sampleRate * 2, 28) // byte rate: rate * channels * 2
  header.writeUInt16LE(2, 32) // block align
  header.writeUInt16LE(16, 34) // bits per sample
  header.write('data', 36)
  header.writeUInt32LE(pcm.length, 40)
  return Buffer.concat([header, pcm])
}

/**
 * One file as multipart/form-data, in the shape the endpoint's `req.file()` expects.
 *
 * Every newline is CRLF: the format requires it, and a bare \n produces a body some parsers accept and
 * Fastify's does not — surfacing as "Missing audio file" for a request that plainly contains one.
 */
export function multipart(file: Buffer, filename: string, mimeType: string, boundary: string): Buffer {
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
      `Content-Type: ${mimeType}\r\n\r\n`,
    'utf8',
  )
  return Buffer.concat([head, file, Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8')])
}

/**
 * Translate one device-bound `commander_event` into the cable's vocabulary.
 *
 * Returns null for cards the dial has no use for. The kinds are the WiFi device's own, unchanged: a new
 * kind reaches the cable the day it reaches the socket.
 */
export function cableEventFor(
  frame: { type?: string; agentId?: string; payload?: { kind?: string; text?: string; recap?: string; subagent?: unknown } },
): { kind: 'processing' | 'done' | 'summary' | 'error'; agentId: string; text: string; recap: string; subagent: boolean } | null {
  if (frame.type !== 'commander_event' || !frame.agentId) return null
  const kind = frame.payload?.kind
  if (kind !== 'processing' && kind !== 'done' && kind !== 'summary' && kind !== 'error') return null
  // `subagent`: a sub-agent's turn end — the tile redraws, nobody is told (CommanderMirrorOpts.isSubagent).
  return { kind, agentId: frame.agentId, text: frame.payload?.text ?? '', recap: frame.payload?.recap ?? '', subagent: frame.payload?.subagent === true }
}

/**
 * Translate one device-bound `commander_question` into the dial's `question`.
 *
 * A sibling of `cableEventFor` rather than a branch inside it, because the shapes have nothing in common
 * — this one carries a requestId and an option list, not a card. Until this existed the dial's whole
 * question screen was complete, wired and unreachable: nothing on this side ever produced the message.
 */
export function cableQuestionFor(
  frame: { type?: string; agentId?: string; payload?: { requestId?: string; questions?: unknown } },
): { agentId: string; requestId: string; questions: unknown } | null {
  if (frame.type !== 'commander_question' || !frame.agentId) return null
  const requestId = frame.payload?.requestId
  const questions = frame.payload?.questions
  if (typeof requestId !== 'string' || !requestId || !Array.isArray(questions)) return null
  return { agentId: frame.agentId, requestId, questions }
}

/**
 * Translate one device-bound `commander_question_close` into the dial's `question.close`.
 *
 * The other half of `cableQuestionFor`. A question is a TUI dialog in a pane, not a server-side object,
 * so "somebody answered it" reaches this daemon as "the dialog is no longer on the pane" — and every
 * client still drawing it has to be told, or it sits waiting for an answer nobody can give any more.
 */
export function cableQuestionCloseFor(
  frame: { type?: string; agentId?: string; payload?: { requestId?: string } },
): { agentId: string; requestId: string } | null {
  if (frame.type !== 'commander_question_close' || !frame.agentId) return null
  const requestId = frame.payload?.requestId
  if (typeof requestId !== 'string' || !requestId) return null
  return { agentId: frame.agentId, requestId }
}
