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
import { fetchRelease, loadImage, shouldOffer, type FirmwareRelease } from './fwPush.js'
import { routeVoiceTask, type RouterAgent, type RouterContinuity } from '../lib/voiceRouter.js'
import { env } from '../config/env.js'
import { FleetRouter } from '../services/fleetRouter.js'
import type { ForkResult } from '../core/api.js'
import type { FleetRouting } from '../services/fleet.js'
import { ServiceUnavailableError } from '../core/serviceHost.js'

import { PLAYER_STATES, type PlayerSession } from './playerLibrary.js'
import type { ActivitySnapshot, AppSwarms, CableAgent, CableHost, CableMachine, CableMachineSource, CableSwarm, CableTile, DialAgent, DialStatus, FollowCause, OpenReason, RouteDecision, SendOutcome } from './cableSession.js'
import type { WindowRoute } from './windowRoute.js'
import type { SelectionCommand, SelectionResult } from './windowSelection.js'
import type { VisitCommand, VisitResult } from './windowVisit.js'
import type { FormCommand, FormResult } from './windowForm.js'
import type { PetStore } from './pets/store.js'
import { LANE_SESSION_OVER, LANE_TOKEN_UNAVAILABLE, type MachineFleet } from './machineFleet.js'
import type { ReviewedAnswer, AnswerReceipt } from './questionInbox.js'
import { isTier, type Tier } from '../lib/notifyTier.js'
import { HarnessSource } from './hosts/harness.js'
import { AppFilter, type AppCounts } from './hosts/appFilter.js'
import { appDisplayName, hostDisplayName } from './hosts/hostDetect.js'
import type { HostEntry, HostRegistry } from './hosts/registry.js'
import { APP_LIMIT, AppRings, DialRing, pageOf, type RingRank } from './hosts/select.js'
import { FRONT_NONE } from './hosts/frontApp.js'
import { capsLetters, type AppList, type AppPick, type DialView, type HostAgent, type PaneSwitch, type SwitchCause, type ViewCause } from './hosts/types.js'

/** Which of an app's agents its ring lists while that app is shown and settled in front (Orca's worktree on screen). */
export interface RingScope {
  inScope(agentId: string): boolean
}

/** One completed turn's recap, as the mirror keeps them. */

export interface RecentTurn {
  recap?: string
  text?: string
  /** What the USER asked on that turn. The topic lives here; the recap holds the answer. */
  ask?: string
  /** The turn's whole answer when the mirror still holds it: what a `recap: 'long-v1'` device reads. */
  fullText?: string
}

export interface CableHostWiring {
  /** The live agents the apps are shown, and the name they show for each: the router this host keeps for
   *  this computer reads them (the core's `agents.advertised` and `agents.displayName`). */
  sessions: () => RegisteredSession[]
  displayName: (session: RegisteredSession) => string
  /** Exact live terminal footer for a local agent; absent when no footer is visible. */
  activityText?: (agentId: string) => Promise<string | null>
  /** `activityText` plus the footer's timer and the assistant's latest paragraph. */
  activitySnapshot?: (agentId: string) => Promise<ActivitySnapshot | null>
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
  /** What came of a swipe that rested on an agent of another app, or was superseded before it rested: for its count. */
  swiped?: (outcome: PaneSwitch | 'superseded') => void
  /** A hand turned a dial to an agent, of any app or none, as it turned: a settle of the app in front then follows
   *  nothing the dial has left. */
  turned?: () => void
  /** What came of a local follow, by its cause: the dial moved to its agent, or its list had no tile for it. */
  localFollowed?: (cause: FollowCause, outcome: 'moved' | 'no-tile') => void
  /** The agent the dial that moved last shows, or null once that dial shows none: Orca's Harness Device plugin. */
  dialShows?: (agent: DialAgent | null) => void
  /**
   * A notification was tapped: the window gives that agent a tile of its own. With `reason`
   * `'question'` it was a question screen instead, and the window only brings the agent forward.
   */
  opened?: (machineId: string, agentId: string, reason?: OpenReason) => void
  /** A person's tap opens an agent (an open with no reason), told as it is taken, before the open and whatever becomes
   *  of it: the notice desk ends that agent's notice. Never a question screen that came up by itself. */
  tapped?: (agentId: string) => void
  /** Who sent a notice, for an agent no list holds: `describe` asks it last, after the outside agents and the fleet. */
  noticeFrom?: (agentId: string) => { name: string; engine: string; machine: string } | undefined
  /** The questions only the devices ask (an agent's notice, a prompt it waits on), as drawer rows: the dial keeps a
   *  question as a row of the drawer that what is unread replaces whole. */
  noticeRows?: () => UnreadNotification[]
  /** Brings Harness Desktop forward, starting it when it is not running: a tap on one of this computer's agents with no
   *  window. False when it could not. Absent where a tap cannot start it (off macOS): its agents then take no tap. */
  launchDesktop?: () => Promise<boolean>
  /** No window came for a waiting open in HARNESS_OPEN_WAIT_MS: the open has ended. */
  desktopTimedOut?: () => void
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
  appFocus?: CableHost['appFocus']
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
  /** The custom pets kept on this computer; the dial's session reads the mapping and packs from it. */
  pets?: () => PetStore | null
  /** The app a dial that says `appFilter` shows changed from one app to another, and why: its dials are told at once. */
  appSwitched?: (cause: SwitchCause) => void
  /** An app stayed in front for FRONT_SETTLE_MS, with or without a window, after any switch it caused: the Claude app's
   *  session and a tab report waiting on that app are followed then. */
  appSettled?: (app: string) => void
  /** A dial sent a pick from its list of apps, whatever came of it: the picker's measure. A notice's pick is none. */
  appPicked?: () => void
  /** A pick on the dial switched the shown app, or with a window turned the view to Harness's tab: the devices bring
   *  that app to the front. Never for a notice, nor for Harness with no window. */
  appBrought?: (app: string) => void
  /** The view was set, and why: told on each change and on each window opening, never an app. */
  appView?: (view: DialView, cause: ViewCause) => void
  /** Runs `run` once after `ms` and returns its cancel: the settle of the app in front, and the end of a waiting open
   *  (HARNESS_OPEN_WAIT_MS). The devices always give theirs, which their stop cancels; absent (a test's host), an
   *  unref'd setTimeout. */
  appTimer?: (ms: number, run: () => void) => () => void
  /** In [0, 1): the draw between apps tied for the most agents. Absent, Math.random. */
  appRandom?: () => number
}

/** The settle of the app in front when no timer is wired (a test's host): never what keeps the process up. */
function unrefAfter(ms: number, run: () => void): () => void {
  const timer = setTimeout(run, ms)
  timer.unref()
  return () => clearTimeout(timer)
}

/**
 * How long a tap on a Harness agent waits for Desktop's window after starting it: room for a cold start, the sign-in
 * check and the window's first connect. Not measured on Diego's Mac, which this work does not touch.
 */
export const HARNESS_OPEN_WAIT_MS = 30_000

/** Whether these counts give the app any agent. */
const has = (counts: ReadonlyMap<string, number>, app: string): boolean => (counts.get(app) ?? 0) > 0

/** Whether an id is the router's placeholder for a machine with no id yet (`cable:` and the computer id;
 *  see services/fleetRouter.ts) rather than a machine the backend has heard of. */
function isPlaceholder(id: string): boolean {
  return id.startsWith('cable:')
}

/** How long a keepalive may be answered from the last manifest read — see firmwareFor. */
const RELEASE_KEEP_MS = 30 * 60_000
/**
 * The wait before trying the plug-in's lane again, doubling to the cap: the same backoff as the lane's own reconnect
 * (deviceLink.ts reconnectLater). Diego, 11-01: a first open lost to a refresh that failed in a network blip was
 * never tried again, and the wheel had no other Mac until the dial was replugged.
 */
const LANE_RETRY_MS = 1_000
const LANE_RETRY_MAX_MS = 30_000

/** How a pick of a machine ended: `code` is the daemon's, `message` is shown to a person (CableHost.selectMachine). */
type MachinePick = { ok: true } | { ok: false; code: string; message: string }

/** A pick on its way; `replaced` when it took over from another still running. */
interface PendingPick { machineId: string; replaced: boolean; done: Promise<MachinePick> }

/** A pick's end that says no about that machine and nothing about the lane (deviceFleet.ts select and codeFor). */
const REFUSALS = new Set(['NEEDS_LINK', 'UNKNOWN_MACHINE', 'NOT_YOURS', 'BILLING'])

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
   * The newest pick still on its way to a remote machine, until it settles. Only it may move `selected`: a pick waiting on
   * a slow machine lands up to 15 s later, by when the person may be elsewhere (Diego, 11-02). Which pick it is, not
   * just which machine: going away and back to one machine looks the same by name, and the first landing says nothing of
   * the last. The announce on plug-in names it rather than `selected`: announcing the older machine would replace the newer
   * choice at the lane (deviceLink.ts select).
   */
  private pending: PendingPick | null = null

  /** Counts plug-ins: a lane open that lands after an unplug or a replug belongs to an older one and does nothing. */
  private plugIn = 0
  /** The next try at the lane for this plug-in, after an open that failed; cleared by an unplug or a replug. */
  private laneRetry: NodeJS.Timeout | null = null
  private laneTries = 0

  /** The last good manifest read per OTA key, for keepalives — see firmwareFor. */
  private readonly releases = new Map<string, { release: FirmwareRelease; at: number }>()

  /**
   * `fleet` is a bare lane to the other machines for this host's own router — its tests give it one. A
   * daemon gives none: its dial reaches the fleet service's router through the core (`wiring.fleet`).
   * With neither, the wheel is the local row and nothing else.
   */
  constructor(private readonly wiring: CableHostWiring, fleet?: MachineFleet) {
    this.harness = new HarnessSource(Date.now, wiring.launchDesktop !== undefined)
    this.local = new FleetRouter({
      ...wiring,
      // The same set `agents_list` answers the apps with — see the router's localAgents.
      sessions: () => wiring.sessions(),
      displayName: (session) => wiring.displayName(session),
      desk: () => this.desk,
    }, fleet)
    this.filter = new AppFilter({
      after: wiring.appTimer ?? unrefAfter,
      random: wiring.appRandom ?? Math.random,
      // The registry's agents at each call, not the rings' last update: only a read of the machine list updates the
      // rings, so a settle with the dials on a window's tab or unplugged, or a pick just after an app's last agent ended,
      // would count the past. Harness's own agents still count as that read left them: the list read feeds their source
      // (machineSnapshot).
      counts: () => this.counts(),
      switched: (cause) => wiring.appSwitched?.(cause),
      settled: (app) => {
        this.viewOnSettle(app)
        wiring.appSettled?.(app)
      },
    })
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

  /** The machine the newest pick is still on its way to, or '' when none is. */
  pendingPick(): string {
    return this.pending?.machineId ?? ''
  }

  async selectMachine(machineId: string): Promise<MachinePick> {
    if (machineId === this.localId()) {
      this.selected = machineId
      this.pending = null
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
    // A second pick of the machine already on its way shares its one answer, as the lane's select does. Each caller may be
    // the only one left to tell the dial: an app follow's answer is dropped once a newer focus arrives (reviews of #2504).
    if (this.pending?.machineId === machineId) return this.pending.done
    // Set before the select starts, so a fleet call that fails at once still finds it and clears it.
    const entry: PendingPick = { machineId, replaced: this.pending !== null, done: null as unknown as Promise<MachinePick> }
    this.pending = entry
    entry.done = this.pickMachine(entry)
    return entry.done
  }

  private async pickMachine(entry: PendingPick): Promise<MachinePick> {
    const { machineId } = entry
    let selected: Awaited<ReturnType<FleetRouting['select']>>
    let newest = false
    try {
      selected = await this.viaFleet((r) => r.select(machineId))
    } finally {
      newest = this.pending === entry
      if (newest) this.pending = null
    }
    if (!newest) {
      // Replaced, however it ended: a machine the person left failing late is no news to them. A newer pick of this same
      // machine (away and back) speaks for this one too: the dial waits on that machine, and an error would end its wait.
      if (this.pending?.machineId === machineId) return this.pending.done
      if (this.selected === machineId) return { ok: true }
      return { ok: false, code: 'SUPERSEDED', message: 'Another machine was chosen' }
    }
    if (!selected.ok) {
      // The lane may still be where the pick this one replaced took it: the fleet refuses an unlinked machine before asking
      // the lane, so the dial stayed here while the backend and any reconnect stayed on the machine the person left (reviews
      // of #2504). Said again now, as picking this machine again would not: it is already selected. Only for a refusal, and
      // only with a pick replaced: that one was still running, so the lane is up. Any other failure may be the lane's end (a
      // revoke, a 4403, an unplug), and telling it anything would dial straight back past what it decided.
      if (entry.replaced && REFUSALS.has(selected.code)) {
        void this.announceSelection().catch((err) => this.wiring.log(`cable: could not announce (${(err as Error).message})`))
      }
      return selected
    }
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
    this.stopLaneRetry()
    this.laneTries = 0
    this.openLane(++this.plugIn, 'cable: dial on the wire — opening the cloud lane')
  }

  private openLane(plugIn: number, line: string): void {
    if (!this.viaFleet((r) => r.hasLane())) return
    // Signed out there is no lane to open: the socket is authenticated, so dialling it would fail once
    // per plug-in and log a failure for something nobody asked for. The dial still works — it is on the
    // cable, and everything it shows on this computer is served in-process. A retry stops here too.
    if (this.wiring.signedIn?.() === false) {
      this.wiring.log('cable: dial on the wire — this computer only (not signed in)')
      return
    }
    this.wiring.log(line)
    void (async () => {
      // The socket first, and unconditionally: it is what makes the machine wheel's dots live, and it is
      // held for as long as the dial is plugged in whether or not anything is selected.
      let online: { ok: true } | { ok: false; message: string; code?: string }
      try {
        online = await this.viaFleet((r) => r.online())
      } catch (err) {
        online = { ok: false, message: (err as Error).message }
      }
      if (!online.ok) {
        // A session that is over is not tried again: each try would be a refused refresh and two log lines every 30 s
        // until someone signs in (security review 2 on #2483). The next sign-in and plug-in open it.
        if (online.code === LANE_SESSION_OVER) {
          this.wiring.log(`cable: could not open the lane (${online.message}) — other machines are unavailable until the next sign-in`)
          return
        }
        this.wiring.log(`cable: could not open the lane (${online.message})`)
        // Only a token that could not be read is tried again from here: it left the lane no socket, so nothing else
        // would (deviceLink.ts readToken). A socket that failed is the lane's own reconnect's, and trying it here too
        // ran two backoffs against a backend that is down (security review 2 on #2483).
        if (online.code === LANE_TOKEN_UNAVAILABLE) this.retryLane(plugIn)
        return
      }
      // Unplugged or replugged while it opened: the newer plug-in announces for itself, and an unplugged dial is
      // nowhere to announce.
      if (plugIn !== this.plugIn) return
      this.laneTries = 0
      await this.announceSelection()
    })().catch((err) => this.wiring.log(`cable: could not open the lane (${(err as Error).message})`))
  }

  private retryLane(plugIn: number): void {
    if (plugIn !== this.plugIn) return
    this.stopLaneRetry()
    const delay = Math.min(LANE_RETRY_MAX_MS, LANE_RETRY_MS * 2 ** Math.min(this.laneTries++, 5))
    this.laneRetry = setTimeout(() => {
      this.laneRetry = null
      if (plugIn === this.plugIn) this.openLane(plugIn, 'cable: trying the cloud lane again')
    }, delay)
  }

  private stopLaneRetry(): void {
    if (this.laneRetry) { clearTimeout(this.laneRetry); this.laneRetry = null }
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
    const machineId = this.pendingPick() || this.selectedMachine()
    if (isPlaceholder(machineId)) return
    const selected = await this.viaFleet((r) => r.select(machineId))
    // Never fatal. The local machine in particular must stay usable with no backend at all — it is the
    // one machine the cable can vouch for on its own. Replaced by a newer select is not a failure: that
    // one tells the backend where the dial is.
    if (!selected.ok && selected.code !== 'SUPERSEDED') this.wiring.log(`cable: could not announce ${machineId} (${selected.message})`)
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
    this.plugIn++
    this.stopLaneRetry()
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

  pets(): PetStore | null {
    return this.wiring.pets?.() ?? null
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

  /** The window's focused agent. None for a dial on an app's ring: its words go to the agent on its face, as with no
   *  window. */
  appFocus(opts: { apps?: boolean } = {}): { machineId: string; agentId: string } | undefined {
    // The dial holds no tab of the open window: it is on an app's ring.
    if (this.windowOf(opts) !== this.swarms) return undefined
    return this.wiring.appFocus?.()
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
    const opened = this.swarms === null && swarms !== null
    this.swarms = swarms
    if (swarms === null) {
      // A closed window has no view, and the next one starts from the rule, not from a pick made on this one.
      this.view = undefined
      this.pickedOver = undefined
      return
    }
    if (opened) {
      const front = this.otherFront()
      this.setView(front !== undefined && has(this.counts().all, front) ? 'apps' : 'tabs', 'window')
    }
    const waiting = this.waiting
    if (!waiting) return
    // The window a tap started is here: it is handed the tap, as a window that was open would have been.
    this.endWaiting()
    this.wiring.log(`cable: open ${waiting.machineId}/${waiting.agentId} (notification)`)
    this.wiring.opened?.(waiting.machineId, waiting.agentId)
  }

  /**
   * What the dials that say `appFilter` hold while a window is open: its active tab, or the shown app's ring. Undefined
   * with no window. In memory only, as the filter: the next settle sets it again after a restart.
   */
  private view: DialView | undefined
  /** The app settled in front when Harness was picked on the dial: it settling again, or getting agents, leaves the tab
   *  held, as a pick holds the filter. Another app settling ends it. */
  private pickedOver: string | undefined

  /** A window is open and the dials that say `appFilter` hold its tab. */
  holdsTab(): boolean {
    return this.view === 'tabs'
  }

  private setView(view: DialView, cause: ViewCause): void {
    if (view === this.view) return
    this.view = view
    this.wiring.appView?.(view, cause)
  }

  /** The app settled in front when it is a listed app other than Harness: the only one the view may turn to. */
  private otherFront(): string | undefined {
    const app = this.filter.settledApp()
    return app === undefined || app === 'harness' || app === FRONT_NONE ? undefined : app
  }

  /** An app stayed in front with a window open: Harness brings the tab back, another app with agents its ring. */
  private viewOnSettle(app: string): void {
    // The same app settling again leaves a pick of Harness holding, as AppFilter.settle leaves a pick.
    if (this.swarms === null || app === this.pickedOver) return
    this.pickedOver = undefined
    if (app === 'harness') this.setView('tabs', 'front')
    else if (has(this.counts().all, app)) this.setView('apps', 'front')
  }

  /** The window whose tab a dial holds: none with no window, and none for a dial that says `appFilter` on an app's ring. */
  private windowOf(opts: { apps?: boolean }): AppSwarms | null {
    return opts.apps && this.view === 'apps' ? null : this.swarms
  }

  /**
   * On the tab, at a read by a dial that says `appFilter`, where the filter's own D1 is: the app in front getting known
   * agents turns the view to its ring. Decided on the agents the tab read listed, so the read takes one registry read.
   */
  private viewOnTab(listed: HostAgent[]): void {
    const front = this.otherFront()
    if (front !== undefined && front !== this.pickedOver && has(this.rings.counts(listed).known, front)) this.setView('apps', 'front')
  }

  /**
   * On a ring, at the read that built it, where the filter's own `empty` is: the shown app left as Harness or none turns
   * the view back to the tab. Whether it did.
   */
  private viewOnRing(shown: string): boolean {
    if (this.view !== 'apps' || (shown !== '' && shown !== 'harness')) return false
    this.setView('tabs', 'empty')
    // Harness shown while the app in front has known agents is a pick of Harness made before the window opened: it holds
    // as one made with the window open, or the next read's D1 would turn the view straight back.
    const front = this.otherFront()
    if (front !== undefined && has(this.counts().known, front)) this.pickedOver = front
    return true
  }

  /** This computer's Harness agents, fed from the list this host reads; the devices put it in their registry. */
  readonly harness: HarnessSource

  /** A tap on a Harness agent that started Desktop, until its window comes (setSwarms), and its timer's cancel. One at
   *  a time: the last tap on any agent wins (openAgent). In memory only. */
  private waiting: { machineId: string; agentId: string; cancel: () => void } | null = null

  private endWaiting(): void {
    this.waiting?.cancel()
    this.waiting = null
  }

  /** Every agent on this computer, by source; null when the devices have none. Read for the machine list, and on the
   *  window's tab only for a dial that says `appFilter` (its list of apps). */
  private registry: HostRegistry | null = null
  /** The machine list's ring: one for this host, so every dial here swipes through the same agents in the same order.
   *  In memory only: a restart of the devices process builds it again from the registry. */
  private readonly ring = new DialRing()
  /** For a dial that says `appFilter`: one ring per app, and which app is shown. One of each for this host, so every such
   *  dial here shows the same app and a pick on one turns them all. In memory only, as the ring. */
  private readonly rings = new AppRings()
  /** Each app's own order, by app id, for its ring alone; the single ring takes none. In memory only, as the rings. */
  private readonly ranks = new Map<string, RingRank>()
  /** Each app's scope and the ring of its own it lists in, apart from the app's ring so dropping the scope gives that
   *  ring back as it was. In memory only, as the ranks. */
  private readonly scopes = new Map<string, { scope: RingScope; ring: DialRing }>()
  private readonly filter: AppFilter

  /** Its changes reach the dial on the session's next tick, which reads the list every second. */
  setRegistry(registry: HostRegistry | null): void {
    this.registry = registry
  }

  /** That app's own order, for its ring alone. It reaches the dial on the session's next list, as any ring change. */
  setRank(app: string, rank: RingRank): void {
    this.ranks.set(app, rank)
  }

  /** That app's ring lists only the agents in scope while the app is shown and settled in front; undefined lists them
   *  all again. A new scope object is a new set of agents, so it starts a ring of its own; the same one keeps its ring.
   *  It reaches the dial on the session's next list, as a rank does. */
  setScope(app: string, scope: RingScope | undefined): void {
    if (!scope) this.scopes.delete(app)
    else if (this.scopes.get(app)?.scope !== scope) this.scopes.set(app, { scope, ring: new DialRing() })
  }

  /** An agent of the machine list and the source that holds it. A dial on a window's tab may do everything with its
   *  agents, so the registry is not asked. */
  private onMachine(agentId: string, opts: { apps?: boolean }): HostEntry | undefined {
    return this.windowOf(opts) === null ? this.registry?.entries().find((e) => e.agent.id === agentId) : undefined
  }

  /** An agent of another app or terminal, heard on this computer, or undefined. Nothing of it may reach the core: the
   *  fleet's router takes an id it does not know for a local agent and asks the core's doors, so each route here that
   *  names an agent answers for it first. Asked with a window too: the dial may still hold it from the machine list. */
  private outside(agentId: string): HostAgent | undefined {
    return this.registry?.outside(agentId)
  }

  /** The machine list's copy, with the source a tap, a swipe or words act through. */
  private outsideEntry(agentId: string): HostEntry | undefined {
    const held = this.registry?.entries().find((e) => e.agent.id === agentId)
    if (!held || held.source.id === 'harness') return undefined
    // The Harness source learns which session each Harness agent runs only when a machine list is read, which a dial on a
    // window's tab never does: a session moved into a Harness pane since then is a Harness agent's, asked of the core now.
    const session = held.agent.sessionId
    return session && this.wiring.sessions().some((s) => s.sessionId === session) ? undefined : held
  }

  capsOf(agentId: string, opts: { apps?: boolean } = {}): string | undefined {
    const on = this.onMachine(agentId, opts)
    return on && capsLetters(on.source.capabilities(on.agent))
  }

  hostOf(agentId: string, opts: { apps?: boolean } = {}): string | undefined {
    return this.onMachine(agentId, opts)?.agent.host
  }

  appOf(agentId: string, opts: { apps?: boolean } = {}): string | undefined {
    return this.onMachine(agentId, opts)?.agent.app
  }

  /** A pick from the dial's list of apps. With a window, on the tab another app with agents turns the dial to its ring;
   *  on an app's ring Harness is the window's tab, and any other app the filter's pick. */
  pickApp(app: string, cause: 'pick' | 'notice' = 'pick'): AppPick {
    if (cause === 'pick') this.wiring.appPicked?.()
    const answer = this.answerPick(app, cause)
    // A notice brings its own app with its open. Harness with no window is only its ring: no Desktop to bring.
    if (cause === 'pick' && (answer === 'tabs' || (answer === 'switched' && app !== 'harness'))) this.wiring.appBrought?.(app)
    return answer
  }

  private answerPick(app: string, cause: 'pick' | 'notice'): AppPick {
    if (this.swarms === null) return this.filter.pick(app, cause)
    if (this.view === 'tabs') {
      // A notice's pick on the tab is not the dial's switch. The filter holds the app even when it already shows it, or
      // the next read's D1 would show Harness again and turn the view straight back to the tab.
      if (cause !== 'pick' || app === 'harness' || !this.filter.hold(app)) return 'ignored'
      // Picked off the tab: the app Harness was picked over no longer holds the tab when it gets agents in front.
      this.pickedOver = undefined
      this.setView('apps', 'pick')
      return 'switched'
    }
    if (app !== 'harness') return this.filter.pick(app, cause)
    this.pickedOver = this.filter.settledApp()
    this.setView('tabs', 'pick')
    return 'tabs'
  }

  /** The app the person brought to the front. Followed with a window open too: it sets the view, and the app shown on
   *  an app's ring. */
  front(app: string): void {
    this.filter.front(app)
  }

  /** The app that settled in front, with or without a window. Not the shown app: the person may have picked another. */
  settledApp(): string | undefined {
    return this.filter.settledApp()
  }

  /** The app last reported in front, before it settles, with or without a window. */
  latestFront(): string | undefined {
    return this.filter.latestFront()
  }

  localFollowed(cause: FollowCause, outcome: 'moved' | 'no-tile'): void {
    this.wiring.localFollowed?.(cause, outcome)
  }

  /** The dial that reported last and what it shows. One report for all dials: a none from another dial is dropped, so
   *  unplugging one of two does not blank the agent the other shows. */
  private shown: { dial: object; agent: DialAgent; agentId: string | null } | null = null

  dialShows(dial: object, agent: DialAgent | null, agentId: string | null): void {
    if (agent) this.shown = { dial, agent, agentId }
    else if (this.shown?.dial === dial) this.shown = null
    else return
    // The id stays here: the `dial` stream writes a name and an app only.
    this.wiring.dialShows?.(agent)
  }

  /** The id of the agent the dial that moved last shows; none once that dial shows none. */
  shownAgentId(): string | undefined {
    return this.shown?.agentId ?? undefined
  }

  markSeen(agentId: string, opts: { apps?: boolean } = {}): void {
    this.onMachine(agentId, opts)?.source.markSeen?.(agentId)
  }

  /** What the window still has unread, newest first. Empty until a window says otherwise. */
  private unread: UnreadNotification[] = []

  setUnread(items: UnreadNotification[]): void {
    this.unread = items
  }

  /** What is unread, the devices' own questions first: a drawer carries one row an agent, the first the dial is sent. */
  listUnread(): UnreadNotification[] {
    const asked = this.wiring.noticeRows?.() ?? []
    const agents = new Set(asked.map((row) => row.agentId))
    return [...asked, ...this.unread.filter((row) => !agents.has(row.agentId))]
  }

  readNotification(agentId: string, readToken: string): void {
    if (!notificationReadToken(readToken)) return
    const item = this.unread.find(n => n.agentId === agentId && n.readToken === readToken)
    if (!item?.machineId) return
    // Keep it until the window confirms through app_unread. Retrying is safe;
    // the window checks the same identity again, even across remote machines.
    this.wiring.notificationRead?.(item.machineId, agentId, readToken)
  }

  listSwarms(opts: { apps?: boolean } = {}): { selected: string; swarms: CableSwarm[]; tiles: CableTile[] } {
    const app = this.windowOf(opts)
    if (!app) return { selected: '', swarms: [], tiles: [] }
    return {
      selected: app.active,
      swarms: app.swarms.map((s) => ({ id: s.id, name: s.name, agents: s.agentIds.length, agentIds: s.agentIds, panes: s.panes })),
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
   * Four answers, and each is a state the dial draws:
   *   - no window, and the devices have a registry → this computer's agents (Harness and any other app or
   *                                          terminal) with `host`, `caps` and `view: 'machine'`, in a fixed
   *                                          ring of at most sixteen where an agent keeps its place whatever its
   *                                          state does (hosts/select.ts); `total` is every agent here. Asked
   *                                          with `apps` (a dial that says `appFilter`), the shown app's ring
   *                                          instead, `total` its agents, and `apps`, the list it picks from. The
   *                                          same for such a dial with a window open while the view is `apps`.
   *                                          `apps` holds at most sixteen, the shown one among them (APP_LIMIT).
   *   - no window and no registry          → `[]`; the dial shows "Run OpenHarness on your computer".
   *   - a window with an empty tab         → `[]`; the dial shows "Nothing on this tab".
   *   - a window with panes                → those agents, in tile order; a tile whose machine dropped out
   *                                          is held from the router's `knownAgents` (see listAgentsFlat).
   * A dial that says `appFilter` is also sent, on the tab, the other apps it can switch to (see tabApps).
   */
  async listAgents(): Promise<CableAgent[]> {
    return (await this.listAgentSnapshot()).agents
  }

  async listAgentSnapshot(opts: { apps?: boolean } = {}): Promise<{ agents: CableAgent[]; tab: string; total: number; view?: 'machine'; apps?: AppList }> {
    // One registry read serves a tab read: the view's rule and the tab's list of apps.
    const listed = opts.apps && this.view === 'tabs' ? this.agentsNow() : undefined
    if (listed) this.viewOnTab(listed)
    const flat = await this.listAgentsFlat()
    const byId = new Map(flat.map((a) => [a.id, a]))
    const registry = this.registry
    if (this.windowOf(opts) === null && registry) {
      const machine = await this.machineSnapshot(registry, flat, byId, opts.apps === true)
      // A ring left as Harness or none, with a window open, is the window's tab.
      if (!this.viewOnRing(machine.apps?.shown ?? '')) return machine
    }
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
    const total = this.viaFleet((r) => r.agentTotal())
    // A read that turned the view from a ring to the tab reads the registry once more.
    if (opts.apps && this.view === 'tabs') return { agents: out, tab, total, apps: this.tabApps(listed ?? this.agentsNow()) }
    return { agents: out, tab, total }
  }

  /** The machine list: the registry's agents, bounded by the ring (the 78-agent reconnect above is not repeated); with
   *  `apps`, by the shown app's ring. */
  private async machineSnapshot(registry: HostRegistry, flat: CableAgent[], byId: Map<string, CableAgent>, apps: boolean): Promise<{ agents: CableAgent[]; tab: string; total: number; view: 'machine'; apps?: AppList }> {
    const local = this.localMachine()
    // The engine session bound to each agent, so one that moved into a Harness pane is not listed again as observed.
    const bound = new Map(this.wiring.sessions().map((s) => [s.agentId, s.sessionId]))
    this.harness.update(flat.map((a) => bound.get(a.id) ? { ...a, sessionId: bound.get(a.id) } : a), local.id,
      await this.viaFleet((r) => r.activityTimes()))
    const waiting = this.waiting
    if (waiting && !this.harness.list().some((a) => a.id === waiting.agentId)) this.endWaiting()
    // Read once: each read merges every source's whole list.
    const entries = registry.entries()
    const sourceOf = new Map(entries.map((e) => [e.agent, e.source]))
    const listed = entries.map((e) => e.agent)
    const list = apps ? this.appList(listed) : undefined
    const { rows, total } = list ? this.appRing(listed, list.shown) : this.ring.select(listed)
    const agents = rows.map((a): CableAgent => {
      // A Harness agent keeps the row the window would show (its chips too); another app's is drawn from what was heard.
      const row = byId.get(a.id) ?? { id: a.id, name: a.name, engine: a.engine, machineId: local.id, machine: local.name }
      // Every row is one of the entries.
      return { ...row, host: a.host, caps: capsLetters(sourceOf.get(a)!.capabilities(a)) }
    })
    return { agents, tab: '', total, view: 'machine', ...(list ? { apps: list } : {}) }
  }

  /** Each app's agents in the registry now: the filter and the view decide on these, never on the last read's. */
  private counts(): AppCounts {
    return this.rings.counts(this.agentsNow())
  }

  /** Every agent in the registry now, read once: each read merges every source's whole list. */
  private agentsNow(): HostAgent[] {
    return this.registry?.entries().map((e) => e.agent) ?? []
  }

  /** The shown app's ring, or its scope's while that app is settled in front: a scope is what that app has on screen,
   *  which means nothing while the person looks at another app. */
  private appRing(agents: HostAgent[], app: string): { rows: HostAgent[]; total: number } {
    const scoped = this.filter.settledApp() === app ? this.scopes.get(app) : undefined
    if (!scoped) return this.rings.ring(app)
    return scoped.ring.select(agents.filter((a) => pageOf(a) === app && scoped.scope.inScope(a.id)), this.ranks.get(app))
  }

  /** The apps of the machine list, in the order they appeared, and the one shown over these agents. */
  private appList(agents: HostAgent[]): AppList {
    this.rings.update(agents, this.ranks)
    const shown = this.filter.shown() ?? ''
    const all = this.rings.apps()
    // The firmware keeps the first APP_LIMIT rows and drops the rest, which could be the shown app: past the bound, the
    // last row gives the shown app its place, so the rows before it never move.
    const at = all.findIndex((a) => a.id === shown)
    const rows = at < APP_LIMIT ? all.slice(0, APP_LIMIT) : [...all.slice(0, APP_LIMIT - 1), all[at]]
    return {
      shown,
      apps: rows.map((a) => ({ id: a.id, name: appDisplayName(a.id), count: a.count, waiting: a.waiting })),
    }
  }

  /** The apps the window's tab can switch to: every app with agents but Harness, which the tab already is, in the order
   *  they appeared, as the machine view's list. It never asks `filter.shown()`, which can switch the filter and push
   *  every dial from a read that shows no app. */
  private tabApps(agents: HostAgent[]): AppList {
    this.rings.update(agents, this.ranks)
    const rows = this.rings.apps().filter((a) => a.id !== 'harness').slice(0, APP_LIMIT)
    return { shown: 'harness', apps: rows.map((a) => ({ id: a.id, name: appDisplayName(a.id), count: a.count, waiting: a.waiting })) }
  }

  /** How many agents the account has across every machine — the overview's number, sent beside the
   *  tab's list rather than as 70 rows the dial would hold for a digit. See the router's agentTotal. */
  agentTotal(): number {
    return this.viaFleet((r) => r.agentTotal())
  }

  /** The active tab's id, or '' with no window and for a dial on an app's ring. Travels on `agents.end` so the dial can
   *  tell an empty tab from a shut window — the two draw different screens. */
  activeSwarm(opts: { apps?: boolean } = {}): string {
    return this.windowOf(opts)?.active ?? ''
  }

  /**
   * Name, engine and machine of an agent this daemon has ever listed — for a `summary` or `question`
   * about one the dial no longer holds. See the router's describe. An agent outside Harness is only in the
   * registry, never in the router, and it runs on this computer.
   */
  describe(agentId: string): { name: string; engine: string; machine: string } | undefined {
    const outside = this.outside(agentId)
    if (outside) return { name: outside.name, engine: outside.engine, machine: this.wiring.machineName() }
    return this.viaFleet((r) => r.describe(agentId)) ?? this.wiring.noticeFrom?.(agentId)
  }

  async activityText(agentId: string): Promise<string | null> {
    if (!this.outside(agentId) && !this.viaFleet((r) => r.isLocalAgent(agentId))) return null
    if (this.wiring.activityText) return await this.wiring.activityText(agentId) ?? null
    return (await this.wiring.activitySnapshot?.(agentId))?.text ?? null
  }

  async activitySnapshot(agentId: string): Promise<ActivitySnapshot | null> {
    if (!this.outside(agentId) && !this.viaFleet((r) => r.isLocalAgent(agentId))) return null
    if (this.wiring.activitySnapshot) return await this.wiring.activitySnapshot(agentId)
    const text = await this.wiring.activityText?.(agentId)
    return text ? { text } : null
  }

  /**
   * Every agent the router knows, as the library pages it. The desktop's closed sessions and per-session
   * status are not ported (cable.md, open point 1): each is `idle`. A local agent's age is its last activity, which
   * the Pro's Recent list is ordered by; another machine's is unknown.
   */
  async playerLibrary(): Promise<PlayerSession[]> {
    const [agents, times] = await Promise.all([this.listAgentsFlat(), this.viaFleet((r) => r.activityTimes())])
    return agents.map((a) => ({ id: a.id, name: a.name, engine: a.engine ?? '', machineId: a.machineId ?? '',
      status: PLAYER_STATES[5], lastActivityAt: times?.get(a.id) ?? null }))
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

  openAgent(agentId: string, reason?: OpenReason): void | Promise<void | { ok: false; error: string }> {
    // The last tap wins, whatever agent it is on: a tap still waiting for Desktop's window would open its agent over the
    // app this one brings forward. A question screen that came up by itself is no tap.
    if (!reason) {
      this.endWaiting()
      this.wiring.tapped?.(agentId)
    }
    const outside = this.outsideEntry(agentId)
    if (outside) {
      // Only a person's tap switches the other app: a question screen that came up by itself never does.
      if (reason) return
      return (outside.source.focus?.(outside.agent) ?? Promise.resolve(false))
        .then((opened) => opened ? undefined : { ok: false as const, error: `${hostDisplayName(outside.agent.host)} did not open it.` })
    }
    const machineId = this.machineOf(agentId)
    if (!machineId) {
      // Same rule as focus: an agent id without its machine is not routable, and guessing is how a
      // remote move used to land on a local agent.
      this.wiring.log(`cable: ignored open for unknown agent ${agentId}`)
      return
    }
    // With no window nothing could open a tap on one of this computer's agents: Desktop is started, and its window is
    // handed the tap once it comes. A question screen that came up by itself never starts it.
    if (this.swarms === null && !reason && this.wiring.launchDesktop && machineId === this.localId()) {
      return this.startDesktop(machineId, agentId, this.wiring.launchDesktop)
    }
    this.wiring.log(`cable: open ${machineId}/${agentId} (${reason ?? 'notification'})`)
    this.wiring.opened?.(machineId, agentId, reason)
  }

  /** The tap waits from now, before Desktop is asked: a window that connects while it is still being started finds it. */
  private async startDesktop(machineId: string, agentId: string, launch: () => Promise<boolean>): Promise<void | { ok: false; error: string }> {
    const tap = {
      machineId, agentId,
      cancel: (this.wiring.appTimer ?? unrefAfter)(HARNESS_OPEN_WAIT_MS, () => {
        this.waiting = null
        this.wiring.desktopTimedOut?.()
      }),
    }
    this.waiting = tap
    if (await launch().catch(() => false)) return
    // `open -b` failed or ran out its time: only a tap still waiting failed. A window that came meanwhile has the open,
    // and a later tap answers for itself.
    if (this.waiting !== tap) return
    this.endWaiting()
    return { ok: false, error: `${hostDisplayName('harness')} did not open it.` }
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

  /** Whether this daemon's last list held that agent — see CableHost.knows. An agent outside Harness is the registry's,
   *  never the router's: without it, followApp's log line would say the dial has no tile for it. */
  knows(agentId: string): boolean {
    return this.outside(agentId) !== undefined || this.viaFleet((r) => r.knows(agentId))
  }

  /**
   * Deliver a turn, and SAY whether it could be — through the router, on the agent's own machine, with
   * the refusal for a machine whose last request did not come back. See the router's sendTurn.
   */
  sendTurn(agentId: string, text: string): SendOutcome | Promise<SendOutcome> {
    // A Promise only when another app's source delivers the words, which it answers once they are typed or refused.
    // Whatever the view when they are delivered: words spoken on an app's ring still reach their agent after Harness
    // settles in front, as a tap (focus) and a swipe (swipeEnded) do.
    const on = this.outsideEntry(agentId)
    if (on?.source.send) {
      return on.source.send(on.agent, text).then((sent) => sent.ok ? sent : { ok: false, machine: '', reason: sent.reason, message: sent.reason })
    }
    if (this.outside(agentId)) return { ok: false, machine: this.wiring.machineName(), reason: 'it runs outside Harness' }
    return this.viaFleet((r) => r.sendTurn(agentId, text))
  }

  /** Who the last delivered turn went to, and how long ago — by any of the router's callers. */
  lastRouted(): RouterContinuity | undefined {
    return this.viaFleet((r) => r.lastRouted())
  }

  stopTurn(agentId: string): void {
    if (!this.outside(agentId)) this.viaFleet((r) => r.stopTurn(agentId))
  }

  canSpeakQuestion(agentId: string): boolean {
    return !this.outside(agentId) && this.viaFleet((r) => r.canSpeakQuestion(agentId))
  }

  answerReviewed(answer: ReviewedAnswer): Promise<AnswerReceipt> {
    if (this.outside(answer.agentId)) return Promise.resolve({ ok: false, error: 'Use the terminal to answer this question.' })
    return this.viaFleet((r) => r.answerReviewed(answer))
  }

  answer(agentId: string, requestId: string, answers: Record<string, string>): void {
    if (!this.outside(agentId)) this.viaFleet((r) => r.answer(agentId, requestId, answers))
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
    // Not for an agent of another app: the dial sends focus on every swipe, and only a tap brings that app forward.
    // A swipe that rests on it shows its pane inside the app (swipeEnded); here it is only seen.
    const outside = this.outsideEntry(agentId)
    if (outside) { outside.source.markSeen?.(agentId); return }
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

  /** Whether a swipe that rests on the agent shows its pane: only one of another app, in a pane that app can show. */
  swipeSwitches(agentId: string): boolean {
    const outside = this.outsideEntry(agentId)
    return outside?.source.hasPane?.(outside.agent) ?? false
  }

  turned(): void {
    this.wiring.turned?.()
  }

  /** A swipe that rested shows the agent's pane, and its app stays where it is; one superseded runs nothing. */
  swipeEnded(agentId: string, how: 'rest' | 'superseded'): void {
    if (how === 'superseded') { this.wiring.swiped?.('superseded'); return }
    // The agent may have gone, or left its pane, since the dial turned to it.
    const outside = this.outsideEntry(agentId)
    const shown = outside?.source.showPane?.(outside.agent) ?? Promise.resolve<PaneSwitch>('failed')
    void shown.catch((): PaneSwitch => 'failed').then((outcome) => this.wiring.swiped?.(outcome))
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
    if (!this.outside(agentId)) this.viaFleet((r) => r.updateAgent(agentId, model, effort))
  }

  /** The last few turns, newest first, in the shape the dial's tile draws — from the agent's own machine. An agent
   *  outside Harness has only the end of its last turn, as heard here: the card it was sent live. */
  recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string; ask: string; fullText?: string }>> {
    const outside = this.outside(agentId)
    if (outside) {
      const answer = outside.lastAnswer
      return Promise.resolve(answer ? [{ recap: answer, text: answer, ask: '', fullText: answer }] : [])
    }
    return this.viaFleet((r) => r.recentSummaries(agentId))
  }

  /** The person's own last questions to an agent, newest first — what the router ranks on. */
  recentAsks(agentId: string): Promise<string[]> {
    return this.outside(agentId) ? Promise.resolve([]) : this.viaFleet((r) => r.recentAsks(agentId))
  }

  listModels(agentId: string): Promise<string[]> {
    return this.outside(agentId) ? Promise.resolve([]) : this.viaFleet((r) => r.listModels(agentId))
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
  async firmwareFor(runningVersion: string, key: string, keepalive = false): Promise<{ version: string; image: Buffer; sha256: string } | null> {
    if (env.CABLE_FW_DISABLE) return null
    // A plugged-in dial greets every fifteen seconds, and each greeting read the manifest from GCS: 240 GETs
    // an hour per device, with the pets' sync waiting behind each one (2026-10-29). A keepalive is answered
    // from the last good read for half an hour, so a new image reaches a dial already plugged in within that;
    // a new dial, image or connection reads at once. A failed read is not kept, so the next greeting retries.
    const kept = this.releases.get(key)
    let release = keepalive && kept && Date.now() - kept.at < RELEASE_KEEP_MS ? kept.release : null
    if (!release) {
      release = await fetchRelease(env.CABLE_FW_MANIFEST_URL, key)
      if (release) this.releases.set(key, { release, at: Date.now() })
      else this.releases.delete(key)
    }
    if (!release || !shouldOffer(runningVersion, release.version)) return null
    const image = await loadImage(release, join(env.ADAPTER_DATA_DIR, 'firmware'), key)
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
    //
    // Never an agent outside Harness, whatever the caller passed: the backend is sent each candidate's id and name, and
    // nothing of such an agent leaves this computer.
    const candidates: RouterAgent[] = await Promise.all(agents.filter((a) => !this.outside(a.id)).map(async (a) => ({
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
 * A tool card as one short step line ("Read · cableSession.ts") for a `steps-v1` device's working screen, or null.
 *
 * The working screen otherwise has only the assistant's prose to show, and a turn that is all tool calls
 * has none. A path argument keeps its last segment.
 */
export function cableStepFor(
  frame: { type?: string; agentId?: string; payload?: { kind?: string; text?: string; recap?: string } },
): { agentId: string; step: string } | null {
  if (frame.type !== 'commander_event' || !frame.agentId || frame.payload?.kind !== 'tool') return null
  const tool = (frame.payload.text ?? '').trim()
  if (!tool) return null
  let arg = (frame.payload.recap ?? '').replace(/[\r\n\t]+/g, ' ').trim()
  if (/^[~.]?\/\S+$/.test(arg)) arg = arg.replace(/\/+$/, '').split('/').at(-1) ?? arg
  const step = arg ? `${tool} \u00b7 ${arg}` : tool
  return { agentId: frame.agentId, step: [...step].slice(0, 120).join('') }
}

/**
 * Translate one device-bound `commander_event` into the cable's vocabulary.
 *
 * Returns null for cards the dial has no use for. The kinds are the WiFi device's own, unchanged: a new
 * kind reaches the cable the day it reaches the socket.
 */
export function cableEventFor(
  frame: { type?: string; agentId?: string; payload?: { kind?: string; text?: string; recap?: string; subagent?: unknown; restored?: unknown; update?: unknown; fullText?: unknown; failed?: unknown; tier?: unknown } },
): { kind: 'processing' | 'done' | 'summary' | 'error'; agentId: string; text: string; recap: string; subagent: boolean; update?: string; fullText?: string; failed?: boolean; tier?: Tier } | null {
  if (frame.type !== 'commander_event' || !frame.agentId) return null
  const kind = frame.payload?.kind
  if (kind !== 'processing' && kind !== 'done' && kind !== 'summary' && kind !== 'error') return null
  // `subagent`: a sub-agent's turn end — the tile redraws, nobody is told (CommanderMirrorOpts.isSubagent). A
  // `restored` recap (a turn that ended unseen, CommanderMirror.catchUp) is drawn the same way: history, not news.
  const silent = frame.payload?.subagent === true || frame.payload?.restored === true
  const update = frame.payload?.update
  const fullText = frame.payload?.fullText
  // `tier`: how loudly the turn tells, decided once by the recaps (services/recaps.ts) for every screen.
  const tier = frame.payload?.tier
  return { kind, agentId: frame.agentId, text: frame.payload?.text ?? '', recap: frame.payload?.recap ?? '', subagent: silent,
    ...(kind === 'processing' && typeof update === 'string' ? { update } : {}),
    ...(kind === 'summary' && frame.payload?.failed === true ? { failed: true } : {}),
    ...(kind === 'summary' && typeof fullText === 'string' && fullText ? { fullText } : {}),
    ...(kind === 'summary' && isTier(tier) ? { tier } : {}) }
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
