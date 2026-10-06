import { readCompanionIdentity, type CompanionIdentity } from './companionProtocol.js'
// The message layer: what the daemon and the dial SAY to each other, on top of the bytes serial.ts moves.
//
// Written twice — here and in devices/harness-device/firmware/main/cable_client.c — with no shared code, because one half
// is TypeScript on a laptop and the other is C on an MCU. The framing underneath agrees by shared vectors;
// this layer agrees by docs/cable-protocol.md and by being small enough to read in one sitting.
//
// THE VOCABULARY IS THE PRODUCT'S: machine → agent → session. The machine is this computer, the agents
// are what the registry holds, and a session is one conversation underneath an agent.
//
// Three rules here were paid for on real hardware and are not style:
//
//   1. ANSWER EVERY `hello`, RE-ATTACH ONLY FOR A DIAL NOT ALREADY GREETED. The dial greets on a cadence
//      because it has no port-open event to wait on. Attaching means "this device knows nothing" and
//      pushes the whole state again; doing that on every greeting re-sends everything every 15 seconds.
//
//   2. PING EVEN WHEN IDLE, AND REOPEN THE PORT ON SILENCE. After the dial reboots, macOS hands back a
//      `/dev/cu.usbmodem*` node with the same name, the same inode and the same device numbers. Writes to
//      the old handle keep succeeding, the read never completes, and nothing raises. Without a heartbeat
//      this daemon would talk to a dead file for as long as anyone watched.
//
//   3. SAY NOTHING WHEN NOTHING CHANGED. That is what keeps the link idle during a long turn, and it is
//      why rule 2 has to exist at all.

import { CableDecoder, CableType, encodeCableFrame } from './cableFrame.js'
import { DialLog } from './dialLog.js'
import { FirmwareTransfer } from './fwPush.js'
import { SerialLink, findDialPort } from './serial.js'
import { PassageCarry, withCarriedPassage, type CarryRead } from './passageCarry.js'
import { VoiceDraft, type DraftPin } from './voiceDraft.js'
import { QuestionInbox, type ReviewedAnswer, type AnswerReceipt, type QuestionSpeech } from './questionInbox.js'
import { notificationReadToken, type UnreadNotification } from '../lib/notificationRead.js'

/** Bumped when the VOCABULARY changes. Separate from the frame version, which is the envelope. */
export const CABLE_PROTO_VERSION = 3   // 3: + question.close (a question answered on another client)

const PING_EVERY_MS = 5_000
/** No bytes of any kind for this long → the handle is dead. Longer than the dial's own 15 s window, so a
 *  single late message cannot trip both sides at once and have each conclude the other left. */
const SILENCE_MS = 20_000
const REOPEN_EVERY_MS = 2_000
// How long one attempt at opening the port may take before it is abandoned.
//
// ⚠️ THIS IS WHAT KEEPS THE `opening` GUARD FROM BECOMING A PERMANENT STALL. That guard exists to stop
// two opens racing (which stranded read loops on one tty and shredded the stream), but a guard released
// only when the attempt finishes is a guard held forever by an attempt that never does. Opening spawns
// `stty` against a device that may have just re-enumerated mid-flash; if that call hangs, the dial is
// gone until the daemon is restarted — no error, no retry, no log line saying why. Observed once: the
// link closed at 14:14 and nothing tried again for twelve minutes.
//
// TWENTY SECONDS, RAISED FROM EIGHT, because eight was under the cost of the thing it was timing.
// Measured on a dial that had just re-enumerated after a flash — the whole reason this budget mentions
// re-enumeration in the first place:
//
//   22:26:28.077  cannot open the dial: open timed out after 8000ms   ← gave up
//   22:26:29.660  dial 28:84:85:90:5F:78 on fw 0.0.58 proto 3         ← opened, 1.58s late
//   22:26:29.661  machines → 3 · agents → 8 (attach)                  ← FULL handshake, succeeded
//   22:26:29.662  closed (abandoned — open timed out)                 ← and thrown away
//
// The open costs about 9.6s there, every time, so the deadline never once let a working link live: the
// cycle repeated on an exact 8-second beat for as long as anyone watched, and the dial sat on "Not
// connected" while the daemon greeted it successfully every eight seconds and hung up on it. That is
// the worst shape a timeout can take — not a slow failure, a discarded success.
//
// The stall this guards against is a `stty` that never returns, which twenty seconds catches as surely
// as eight. What it costs is the wait after a replug, and the honest number for that is the ~10s the
// open actually takes, not the 8 it was being given.
const OPEN_TIMEOUT_MS = 20_000

/** What this dial must call itself. A greeting that does not say exactly this is another product's. */
const CABLE_PRODUCT = 'harness'

// How long a port may deliver BYTES WITHOUT A SINGLE DECODABLE FRAME before it is written off as another
// product's dial.
//
// The magic (cableFrame.ts) makes the sibling product's frames undecodable here, which is the point — but
// it also means a foreign dial looks exactly like a chatty port that says nothing we understand. Left
// alone we would hold that port open forever, and two daemons reading one tty is not a stalemate: each
// takes a share of the other's bytes, so frames arrive interleaved and BOTH links fail. Measured on this
// hardware: five readers on one stream cost 18 of 22 greetings.
//
// Generous on purpose. Our own dial is silent-then-noisy across a reboot — the ROM and the bootloader
// write plain text to this same wire before the application starts framing anything — so a short window
// would evict a dial that was merely booting.
const FOREIGN_AFTER_MS = 12_000

// Most firmware writes one dial may take in an hour. A real release is one; anything repeating is two
// pieces of software disagreeing about who owns the board, and the dial pays for that in erase cycles.
const FW_WRITES_PER_HOUR = 3
/** How often the machine list is re-read. Slower than the agent list because it is an HTTP read, not a
 *  map lookup — and because a machine appearing is not something anyone is waiting on a stopwatch for. */
const MACHINES_POLL_MS = 15_000
/**
 * A programmatic focus write may be followed by the dial reporting the tile it was painting just before
 * that write. Real hardware delivered that stale report 23 ms after the machine switch completed; keep
 * a short transaction open until the commanded tile echoes, without making the dial feel unresponsive.
 */
/**
 * How long a focus COMMANDED by the window keeps the dial's own reports out.
 *
 * Deliberately SHORT, and it was briefly 4s — which broke the thing it was meant to protect. The echo it
 * guards against is gone at the source now: a dial told where to look moves through code, and a move made
 * by code is not reported at all (carousel_goto in ui_screens.c). What a long window does instead is
 * swallow a REAL swipe made in the seconds after any click in the window — the two screens then sit on
 * different agents with nothing to correct them, which is exactly the report that followed.
 *
 * So it stays only as long as a stale echo from an OLDER firmware could take, and every report it drops
 * now says so in the log.
 */
const APP_FOCUS_SETTLE_MS = 750

/**
 * How long after an app-driven switch begins its own repaint can still arrive.
 *
 * The switch itself is NOT the measure, and using it as one is what broke: selecting a remote machine
 * takes seconds — ten, measured — and while `drivingAppFocus` was true every report was discarded, so a
 * swipe made during it vanished and the two screens ended up on different agents.
 *
 * A repaint answers the command almost at once; a hand does not. So the guard lasts as long as the first,
 * not as long as the whole errand.
 */
const APP_SWITCH_REPAINT_MS = 1_000

/** What a `voice.begin` without an `sr` is assumed to be — firmware old enough not to say. */
const DEFAULT_VOICE_RATE = 16_000

/** A voice turn longer than this is a stuck dial, not a person talking. 16 kHz mono 16-bit ≈ 32 KB/s. */
const VOICE_MAX_BYTES = 10 * 60 * 32_000

export interface CableAgent {
  id: string
  name: string
  engine?: string
  model?: string
  effort?: string
  /**
   * The machine this agent lives on, and that machine's name.
   *
   * A tab can hold panes from several machines at once, so an agent that does not say where it lives
   * cannot be driven: the daemon routes each turn, stop and answer by this id, and the dial prints the
   * name under the agent's.
   */
  machineId?: string
  machine?: string
}


/**
 * One row of the dial's machine wheel.
 *
 * `state` is the ONLY liveness word on the wire, deliberately as one tri-value rather than an `online`
 * boolean beside a `known` one: one field cannot contradict itself, two can — and would, the first time a
 * list refresh fails halfway through.
 */
export interface CableMachine {
  id: string
  name: string
  state: 'ready' | 'offline' | 'unknown' | 'needs-link'
  /** Exactly one row carries this: the computer at the other end of the cable. */
  local: boolean
}

/**
 * One of the window's swarms — a named group of agents arranged on one grid. The window owns them
 * entirely (they live in its state file and nowhere else); the daemon relays the list so the dial can
 * name the one on screen and offer the others, and relays a pick straight back.
 */
export interface CableSwarm {
  id: string
  name: string
  /** How many agents it holds — the dial draws the count, never the members. */
  agents: number
  /**
   * How many TILES it holds, of any kind — agents, shells, viewers.
   *
   * Separate from `agents` because the two answer different questions, and the dial needs the second
   * one: a tab holding only a terminal drives no agent, so `agents` is 0 for it exactly as it is for
   * an untouched New Harness tab. Filtering the switcher on `agents` therefore hid a tab that had
   * real content in it, with no way back to it from the dial. Nothing here ever becomes a roster
   * entry — a shell is still never named to the dial.
   */
  panes: number
}

/**
 * ONE TILE OF THE ACTIVE SWARM'S GRID, exactly where the window put it.
 *
 * Unit rectangle in THOUSANDTHS of the grid, so it crosses as integers and a device can scale it to
 * whatever face it has. `agentId` is empty for a tile the device cannot drive — a shell, a viewer —
 * which still holds its place, because a shape with a tile missing is not that shape.
 *
 * Relayed, never computed here. The window is the only side that knows whether this grid came from a
 * preset, from `auto` (whose column count it measures against its own width) or from a hand-dragged
 * resize, and the one rule `pane_preset.dart` asks of everybody is that the shape is described once.
 */
export interface CableTile {
  x1: number
  y1: number
  x2: number
  y2: number
  agentId: string
}

/** The window's swarms as it last described them, or null while no window is connected. */
export interface AppSwarms {
  active: string
  swarms: Array<{ id: string; name: string; agentIds: string[]; panes: number }>
  /** The ACTIVE swarm's grid. Empty from a window that predates the field, or one with no panes. */
  tiles: CableTile[]
}

/** Why the list is as short as it is. The dial renders this, instead of drawing an empty wheel. */
export type CableMachineSource = 'backend' | 'local' | 'signed-out'
/** Why the dial sent an `agent.open`: a tap (absent) or a question screen that came up on its own. */
export type OpenReason = 'question'

export type { WindowRoute } from './windowRoute.js'
import type { WindowRoute } from './windowRoute.js'
import { withSelectedPassage, type SelectionCommand, type SelectionResult } from './windowSelection.js'
import type { VisitCommand, VisitResult } from './windowVisit.js'
import type { FormCommand, FormResult } from './windowForm.js'
import { extendShortRecap } from '../lib/deviceRecap.js'

export interface RouteDecision {
  agentId: string
  confidence: number
  reason: string
}

/**
 * Everything the session needs from the rest of the daemon. An interface rather than a direct import so
 * the protocol can be tested against a fake — the alternative is a suite that needs tmux, a microphone
 * and a network to prove that `hello` gets a `welcome`.
 */
export interface CableHost {
  /** The computer at the other end of the cable — its identity, not "the" machine's. */
  localMachine(): { id: string; name: string }
  /** Every machine the owner has, local row included. Never rejects: `source` explains a short list. */
  listMachines(): Promise<{ machines: CableMachine[]; source: CableMachineSource }>
  /** Which one the agent list currently belongs to. */
  selectedMachine(): string
  /**
   * Switch. Resolves to a discriminated result and NEVER throws — a refusal is data here, the same way
   * `firmwareFor()` returning null is. `code` is the daemon's; `message` is shown to a person verbatim,
   * so the dial needs no table for a set it does not own.
   */
  selectMachine(machineId: string): Promise<{ ok: true } | { ok: false; code: string; message: string }>
  /** The window's swarms and which is on screen. Empty with no window: the dial then draws no swarm line. */
  listSwarms(): { selected: string; swarms: CableSwarm[]; tiles: CableTile[] }
  /** The dial picked a swarm. Relayed to the window, which switches and re-describes its desk. */
  selectSwarm(swarmId: string): void
  appName(): string
  voiceLang(): string
  /** The active tab's agents, in tile order — and nothing else. Empty with no window or an empty tab. */
  listAgents(): Promise<CableAgent[]>
  /** Pane rows and workspace identity from the same desktop announcement. */
  listAgentSnapshot?(): Promise<{ agents: CableAgent[]; tab: string; total: number }>
  /** Every agent across the account — the overview's number. The dial gets the count, never the rows. */
  agentTotal(): number
  /** The active tab's id, or '' with no window: what lets the dial tell an empty tab from a shut app. */
  activeSwarm(): string
  /** Who an agent is, for a card about one the dial does not hold. Undefined for an id never listed. */
  describe(agentId: string): { name: string; engine: string; machine: string } | undefined
  activityText?(agentId: string): Promise<string | null>
  sendTurn(agentId: string, text: string): void | { ok: true } | { ok: false; machine?: string; reason?: string }
  stopTurn(agentId: string): void
  /**
   * The user answered a `question`. `answers` is keyed by the QUESTION keys the daemon itself asked with
   * and travels verbatim — re-deriving it, or keying it by the requestId, is how a rename at either end
   * becomes an answer nobody gave.
   */
  answer(agentId: string, requestId: string, answers: Record<string, string>): void
  answerReviewed?(answer: ReviewedAnswer): Promise<AnswerReceipt>
  canSpeakQuestion?(agentId: string): boolean
  focus(agentId: string): void
  /**
   * "Put this one in front of me" — a NOTIFICATION was tapped.
   *
   * A different verb from [focus], and the difference is the whole point: focus
   * says where the eye is and the window moves a tile to match, while this asks
   * for a tile of its own. A turn that just finished is a new thing to look at,
   * not a replacement for whatever the person was already watching.
   *
   * `reason` is why the dial sent it: absent for a person's tap; `'question'` when a question screen
   * came up on its own — the window then only brings the agent forward if it is already on screen,
   * because a reconnect re-shows every unanswered question and each used to open a tab.
   */
  openAgent(agentId: string, reason?: OpenReason): void
  readNotification?(agentId: string, readToken: string): void
  /** The dial asked for a fork of this agent — a second one with its history, opened in the window. */
  forkAgent(agentId: string): Promise<{ ok: true; agentId: string } | { ok: false; error: string; detail?: string }>
  /**
   * Does this daemon's own agent list hold that id?
   *
   * Only for saying so. A `focus` for an agent the dial has no tile for lands on nothing, and from the
   * outside that is indistinguishable from the dial ignoring the window — which is exactly the report
   * that took a morning to explain. Optional, so a host that cannot answer simply says nothing.
   */
  knows?(agentId: string): boolean
  /** A finger moving on the dial's glass, on its way to whatever window is open on this computer. */
  scrolled(phase: 'down' | 'move' | 'up', dy: number, velocity: number): void
  updateAgent(agentId: string, model?: string, effort?: string): void
  /** PCM is 16-bit mono at `sampleRate`; the daemon owns the credential this needs. */
  transcribe(pcm: Buffer, sampleRate: number, lang: string): Promise<string>
  /** Which agent the words belong to. Scored locally first; only a genuine tie should cost a network call. */
  route(transcript: string, agents: CableAgent[]): Promise<RouteDecision>
  /**
   * Offer the words to the desktop window FIRST, and let its palette decide.
   *
   * The window's ⌘B router is the one that gets looked after — fifteen candidates in rail order, recaps
   * cut to sixty characters, a twenty-second budget, and a picker when it is not sure. [route] is the
   * same idea a version behind, so this is asked first and that is the fallback rather than the default.
   *
   * Optional: a host with no window to ask simply omits it, and voice behaves exactly as it always has.
   */
  routeInWindow?(text: string, cmd?: string): Promise<WindowRoute>
  selectPassage?(command: SelectionCommand): Promise<SelectionResult>
  visit?(command: VisitCommand): Promise<VisitResult>
  form?(command: FormCommand): Promise<FormResult>
  /** The runtime model/effort catalog for one agent, as opaque profile ids the dial groups and shows. */
  listModels(agentId: string): Promise<string[]>
  /** One agent's last turn summaries, newest first — what a reattached dial needs to redraw its tiles. */
  recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string }>>
  /** What the window still has unread, newest first — replayed to a dial that has just attached. */
  listUnread(): UnreadNotification[]
  /**
   * The image to offer a dial running `runningVersion`, or null for "nothing to do" — which covers a
   * dial that is current, a dev build that must not be touched, and an unreachable manifest.
   */
  firmwareFor?(runningVersion: string, hw?: string): Promise<{ version: string; image: Buffer; sha256: string } | null>
  /**
   * A dial greeted us, or the port went away.
   *
   * The daemon holds its cloud lane ON THE DIAL'S BEHALF — nothing else in this process uses it. So with
   * no dial there is nobody to hold it for, and holding it anyway leaves the account showing a device
   * that is attached to a machine while sitting unplugged in a drawer.
   */
  onDialAttached?(): void
  onDialGone?(): void
  /**
   * The port this session opened turned out not to be a Harness dial: it talked in something else, or
   * never said anything at all. Told once, so whoever owns discovery can stop offering the port — a
   * second ESP32 board on the desk is somebody's work in progress, not ours to keep probing.
   * Never called for a device that has been a dial.
   */
  onForeignPort?(path: string, why: string): void
  /**
   * Something this session does threw, or the far end is flooding the port with what no dial sends. Told
   * every time, so whoever owns the session can drop this dial alone, and look at its port again later,
   * rather than let one device's fault reach every other one in the process. A dial is hardware speaking
   * whatever its firmware says: a fault here is expected to happen, and to be this dial's alone.
   */
  onFault?(error: unknown, hostile?: boolean): void
  /**
   * The dial as a window would draw it: there or not, on which firmware, and whether an update is
   * going over the cable right now. Fired on every change and never on a keepalive — the window
   * shows this in its rail, and a rail that redraws four times a minute to say "still here" is a rail
   * nobody can afford. What is NOT here: anything a hand did (that is `focused`/`opened`/`scrolled`).
   */
  onDialStatus?(status: DialStatus): void
  log(line: string): void
}

/**
 * The settings a device owns and an app may change, exactly as they cross the cable.
 *
 * Named booleans rather than the firmware's NVS bitmask: those bit positions are the device's private
 * arrangement, and an app that knew them would have to ship in step with a header it cannot see.
 *
 * `round` is not a preference — it is the face. A square device has no curved title, so the app HIDES
 * that row rather than greying out a control for a setting that does not exist there.
 */
export interface DeviceSettings {
  brightness: number
  character: number
  /** The glass, in pixels across. Informational: a support line reads it, nobody chooses it. */
  face: number
  muted: boolean
  quiet: boolean
  straightTitle: boolean
  focusFace: boolean
  scrollReversed: boolean
  round: boolean
  voiceLang: string
  /** Presence advertises companion.set support. Omitted by older firmware. */
  followCompanion?: boolean
  /** Active transient companion; null means the saved device skin is showing. */
  companion?: string | null
  companionProtocol?: number
  companionDetails?: CompanionIdentity | null
}

/** The fields a `settings.set` may name. Absent means unchanged — see handle_settings_set on the device. */
export type DeviceSettingsPatch = Partial<Omit<DeviceSettings, 'round' | 'face' | 'companion' | 'companionProtocol' | 'companionDetails'>>

/** What a window needs to draw the device row. `updating` names the version on its way over. */
export interface DialStatus {
  attached: boolean
  /**
   * Which device this is, when there is more than one. The fleet's key — the USB serial, or the port
   * path when the descriptor has none. Absent from a session running without a fleet around it.
   */
  id?: string
  /** The device's own address, from `hello.mac`. Survives being moved to another port; `id` may not. */
  mac?: string
  /**
   * What the device holds, as IT last reported — never what this computer last sent. Absent until the
   * first greeting, and from a firmware that does not carry settings at all (the LVGL build).
   */
  settings?: DeviceSettings
  fw?: string
  /** Which of the two dials this is — `cst9217+axp2101`, `cst816s`, … — as the firmware detected itself
   *  at boot (device: board.h). Absent from a firmware that predates the field. Informational. */
  hw?: string
  updating?: string
  /**
   * Every device on this computer, when a fleet is reporting. Present only on the primary status, and
   * the primary is one of these rows — the flat fields above repeat it so a window that predates this
   * still draws something true.
   *
   * It exists because one desk can hold two devices and the settings pane has to name which one it is
   * changing. Before this the fleet picked a row and threw the rest away, and the app drew one robot
   * however many were plugged in.
   */
  devices?: DialStatus[]
}

interface Message {
  t: string
  [key: string]: unknown
}

/**
 * The part of a port this layer uses. An interface rather than the class, so the protocol can be driven
 * by a loopback in tests — proving that `hello` gets a `welcome` should not require a dial on the desk.
 */
export interface CablePort {
  readonly path: string
  readonly isOpen: boolean
  write(bytes: Uint8Array): Promise<void>
  close(why?: string): Promise<void>
}

/** Open the dial's port, or null when it is not there. Both are ordinary answers. */
export type PortOpener = (
  onData: (chunk: Buffer) => void,
  onClosed: (why: string) => void,
) => Promise<CablePort | null>

/** The real one: find the tty by USB id, open it raw. */
export const openDialPort: PortOpener = async (onData, onClosed) => {
  const port = await findDialPort()
  if (!port) return null
  return SerialLink.open(port.path, onData, onClosed)
}

/**
 * Read a device's reported settings, or undefined.
 *
 * Every field must be there and be the right type. A partial object is refused whole rather than
 * filled with defaults: a default is a value this computer invented, and the pane would then show a
 * setting the device does not have — the exact failure `settings.state` exists to prevent.
 */
function readSettings(value: unknown): DeviceSettings | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Record<string, unknown>
  const flags = ['muted', 'quiet', 'straightTitle', 'focusFace', 'scrollReversed', 'round'] as const
  for (const key of flags) if (typeof raw[key] !== 'boolean') return undefined
  if (typeof raw.brightness !== 'number' || !Number.isFinite(raw.brightness)) return undefined
  if (typeof raw.character !== 'number' || !Number.isFinite(raw.character)) return undefined
  if (typeof raw.face !== 'number' || !Number.isFinite(raw.face)) return undefined
  if (typeof raw.voiceLang !== 'string') return undefined
  return {
    brightness: Math.max(0, Math.min(100, Math.round(raw.brightness))),
    character: Math.round(raw.character),
    face: Math.round(raw.face),
    muted: raw.muted as boolean,
    quiet: raw.quiet as boolean,
    straightTitle: raw.straightTitle as boolean,
    focusFace: raw.focusFace as boolean,
    scrollReversed: raw.scrollReversed as boolean,
    round: raw.round as boolean,
    voiceLang: raw.voiceLang,
    ...(raw.companionProtocol === 2 ? {companionProtocol:2, companionDetails:readCompanionIdentity(raw.companionDetails)} : {}),
    ...(typeof raw.followCompanion === 'boolean' &&
        (raw.companion === null || typeof raw.companion === 'string')
      ? { followCompanion: raw.followCompanion, companion: raw.companion as string | null } : {}),
  }
}

export class CableSession {
  private link: CablePort | null = null
  private decoder = new CableDecoder()
  private timer: NodeJS.Timeout | null = null
  private greetedMac: string | null = null
  /** This session has spoken with a real dial at least once. Never reset: a port that has been a dial
   *  can go quiet (a hung firmware, a reboot) without ever becoming somebody else's. */
  private everGreeted = false
  /** The board this device says it is (`hello.hw`). Decides which firmware it may be offered. */
  private greetedHw: string | undefined
  /** What the device last SAID its settings are. Never what this computer last asked for. */
  private greetedSettings: DeviceSettings | undefined
  private greetedFw: string | null = null
  private lastRx = 0
  private stopped = false

  /** What the dial was last told the agent list is. Empty = it has been told nothing. */
  private lastAgentsKey = ''
  /** Bytes and frames seen since this port opened — the evidence for the foreign-dial verdict. */
  private bytesSinceOpen = 0
  private framesSinceOpen = 0
  /** Ports written off as another product's, and when it becomes worth looking again. */
  private foreignPort: string | null = null
  private foreignRetryAt = 0
  /** Which images have already been written to which dial, and when. Survives the port, unlike `offered`. */
  private readonly written = new Set<string>()
  private readonly writeLog = new Map<string, number[]>()
  /**
   * THE agent both screens are meant to be on. One memory, written by whichever side moved last.
   *
   * There were two — where the dial was, and what the window last said — and they drifted apart in the
   * one case that matters most: when the WINDOW follows the DIAL, `followApp` returns early (the dial is
   * already there), so the window's memory was never updated and kept an older agent. Anything that then
   * re-asserted "where the window is" sent that stale agent, the dial jumped back to it, and the window's
   * next report pulled it forward again. Measured on the real dial as a tile going 3 → 4 → 3 → 4.
   *
   * A single field cannot disagree with itself. Both sides write it on a real move, the last write wins,
   * and it is the only thing the daemon ever re-asserts.
   */
  private desiredFocus = ''
  /**
   * App-driven machine/focus changes are one transaction. Without this queue, two quick desktop clicks
   * can interleave their machine lists and let the older click focus last.
   */
  private appFocusTail: Promise<void> = Promise.resolve()
  private appFocusGeneration = 0
  /** When the app-driven switch began — see APP_SWITCH_REPAINT_MS. */
  private drivingSince = 0
  /** While the app is rebuilding the dial's machine/list state, focus reports describe that rebuild. */
  private drivingAppFocus = false
  /** The dial may echo a focus command after its write promise resolves; consume that one echo. */
  private expectedAppFocusEcho = ''
  private expectedAppFocusEchoUntil = 0
  /** The same, for the machine wheel. Both reset together on any new port — see `tryOpen`. */
  private lastMachinesKey = ''
  /** Throttle for the machine list, which costs an HTTP read where the agent list costs a map lookup. */
  private machinesAt = 0
  /** A recap lookup must not replay an older inbox over a newer clear. */
  private notificationReplay?: { seen: Set<string> }
  /**
   * Serialises every STREAMED push (begin / rows / end).
   *
   * ⚠️ NOT a precaution. `onMessage` is fired from the decoder callback and never awaited, so a dial that
   * greets and then asks for both lists has three pushes in flight at once — each awaiting a write
   * between every row. Their frames interleave, and the far end sees `begin, begin, 8 rows, end, end`:
   * it stages one machine list twice over and reports eight machines where the daemon sent four.
   *
   * Measured on hardware 2026-08-25, first plug-in of the proto-2 firmware. The dial's own hash gate does
   * not help here — it faithfully gates a list that was already shredded on the way in.
   */
  private pushChain: Promise<void> = Promise.resolve()

  /** Run `body` after every push already queued, and before any queued later. */
  private queued(body: () => Promise<void>): Promise<void> {
    const next = this.pushChain.then(body)
    // The tail swallows so one failed push cannot strand the ones behind it; the caller still sees it.
    this.pushChain = next.catch(() => {})
    return next
  }

  /** A firmware transfer in flight, and the versions already tried this session. */
  private transfer: FirmwareTransfer | null = null
  /** `<mac>:<version>` already offered on this port. The durable, cross-port guard is `mayOffer`. */
  private offered = new Set<string>()

  /** Voice capture in flight: PCM chunks as they arrive, plus what `voice.begin` said about them. */
  private voice: { agentId?: string; cmd?: string; lang: string; rate: number; chunks: Buffer[]; bytes: number;
    selectionId?: string; selection?: Promise<SelectionResult>;
    carry?: CarryRead;
    question?: { pin?: QuestionSpeech };
    draft?: { pin?: DraftPin };
    search?: { command?: SelectionCommand; pin: Promise<SelectionResult> };
    form?: { command?: FormCommand; pin: Promise<FormResult> } } | null = null
  private voiceSearch?: SelectionCommand
  private voiceForm?: FormCommand
  private voiceCarryId?: string
  private readonly passageCarry = new PassageCarry({
    select: command => this.host.selectPassage?.(command) ??
      Promise.resolve({ ok: false, error: 'Update Harness to carry text.' }),
    name: async id => (await this.host.listAgents()).find(a => a.id === id)?.name ?? 'Harness',
  })
  private readonly voiceDraft = new VoiceDraft()
  private voiceDraftCreation?: { uploadId: string; id: string }
  private readonly questionInbox = new QuestionInbox()
  private voiceGeneration = 0
  private voiceUploadId = ''

  constructor(
    private readonly host: CableHost,
    /** The dial's console, as a file: framed device logs and this side's `cable:` events, one day each. */
    private readonly dialLog: DialLog,
    private readonly openPort: PortOpener = openDialPort,
  ) {}

  /**
   * Every `cable:` event goes two ways: to the daemon's console as before, and into the dial's log with a
   * `[daemon]` prefix — the stuck-dial report is read end to end from ONE file, device lines and what the
   * desk did to it interleaved.
   */
  private log(line: string): void {
    this.host.log(line)
    this.dialLog.daemon(line.replace(/^cable: /, ''))
  }

  get isConnected(): boolean {
    return this.link?.isOpen === true && this.greetedMac !== null
  }

  start(): void {
    this.stopped = false
    this.timer = setInterval(() => this.ticked(), 1_000)
    this.ticked()
  }

  async stop(): Promise<void> {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    await this.link?.close('daemon stopping')
    this.link = null
  }

  /** One tick, its failure this dial's: a rejection left unhandled would end the whole devices process. */
  private ticked(): void {
    void this.tick().catch((error: unknown) => this.fault(error))
  }

  /** This dial's fault, told to whoever owns the session (CableHost.onFault). */
  private fault(error: unknown, hostile = false): void {
    this.log(`cable: ${hostile ? 'flooded' : 'fault'} · ${error instanceof Error ? error.message : String(error)}`)
    this.host.onFault?.(error, hostile)
  }

  // ── port lifecycle ────────────────────────────────────────────────────────────────────────────────

  private reportForeign(path: string, why: string): void {
    if (this.everGreeted) return
    this.host.onForeignPort?.(path, why)
  }

  private async tick(): Promise<void> {
    if (this.stopped) return
    // The firmware beats once a minute; the gap is marked in the dial's own log, where it is read.
    this.dialLog.tick(this.isConnected)
    if (!this.link?.isOpen) {
      await this.tryOpen()
      return
    }
    // BYTES BUT NO FRAMES = SOMEBODY ELSE'S DIAL. Nothing we can read has arrived, and something is
    // plainly talking — which is what the sibling product's panel looks like from here now that the two
    // framings no longer overlap. Holding the port would leave both daemons reading one tty and taking
    // turns stealing each other's bytes, so this side lets go and remembers not to come back for it.
    if (this.link?.isOpen
        && this.framesSinceOpen === 0
        && this.bytesSinceOpen > 0
        && Date.now() - this.openAt > FOREIGN_AFTER_MS) {
      this.foreignPort = this.link.path
      // Long enough not to fight over it, short enough to notice a swap. In practice the other daemon
      // takes the port the moment this one lets go and a tty is exclusive on macOS, so the next probes
      // fail to open rather than steal it back — this interval only decides how soon we would find OUR
      // dial if the user unplugged theirs and plugged ours into the same socket.
      this.foreignRetryAt = Date.now() + 60_000
      this.log(`cable: ${this.link.path} is not a Harness dial (${this.bytesSinceOpen} B, no frames) — releasing it`)
      this.reportForeign(this.link.path, `${this.bytesSinceOpen} B, no frames`)
      await this.link.close('not ours')
      this.link = null
      return
    }
    // Rule 2. The read never fails on a dead handle, so silence is the only symptom there is.
    if (Date.now() - this.lastRx > SILENCE_MS) {
      // Silent since the moment it opened and never a dial: a board with nothing to say to us. Reopening
      // it every few seconds for ever is how a second ESP32 on the desk gets its serial port stolen
      // mid-flash, so say so instead of retrying.
      if (this.framesSinceOpen === 0 && !this.everGreeted) this.reportForeign(this.link.path, 'silent')
      this.log('cable: silent, reopening the port')
      // close() runs onClosed, which is where onDialGone fires — one path for "the dial is not there",
      // whether the cable was pulled or the far end simply stopped answering.
      await this.link.close('silence')
      this.link = null
      return
    }
    // The cadence is the contract: the dial reads a gap as absence, and the tick that watches for that
    // gap runs far more often than the ping that prevents it.
    if (Date.now() - this.lastPing >= PING_EVERY_MS) {
      this.lastPing = Date.now()
      await this.send({ t: 'ping' })
    }

    // "Say nothing when nothing changed" has to be paired with "say something when something did".
    // Without this the list was sent ONCE per session and never corrected — and a daemon that has just
    // restarted greets the dial before its registry has finished loading, so the one thing it ever said
    // was "no agents". The dial removed both tiles and sat empty while the daemon knew about two.
    if (this.greetedMac !== null) {
      // Machines FIRST. The dial paints its Overview eyebrow from the machine list, so an agent list that
      // lands first shows a nameless "Machine" for a frame.
      if (Date.now() - this.machinesAt >= MACHINES_POLL_MS) {
        this.machinesAt = Date.now()
        await this.syncMachines()
      }
      // Swarms BEFORE agents: a swarm switch is a new swarm line and a new ring, and the line naming
      // the tab should not lag the tiles that belong to it.
      await this.syncSwarms()
      await this.syncAgents()
      void this.refreshFocusedActivity()
    }
  }

  private openAt = 0
  private opening = false
  /**
   * The version an OTA is moving TO, or '' when none is in flight.
   *
   * Read by the device row the window draws — see onDialStatus. A dial that is
   * taking an update is neither simply present nor absent, and the row says so.
   */
  private offeringTo = ''

  private lastPing = 0

  /**
   * Open the dial's port, at most ONE attempt at a time.
   *
   * ⚠️ THE `opening` FLAG IS THE FIX FOR A BUG THAT LOOKED LIKE BROKEN HARDWARE. `tick()` is fired by
   * setInterval and never awaited, so runs overlap freely, and opening a port is not instant — it spawns
   * `stty` and waits for it before it opens the descriptor. Under load that outlasts REOPEN_EVERY_MS, the
   * next tick walks straight past the throttle below, and a second open begins while the first is still in
   * flight. Only the last one is stored in `this.link`. The others are orphaned WITH THEIR READ LOOPS
   * STILL RUNNING.
   *
   * That is not a descriptor quietly wasted. Every orphan reads the SAME tty and feeds the SAME decoder,
   * so one byte stream arrives interleaved from several readers: frames are shredded, CRCs fail, and the
   * dial's greetings disappear into the noise.
   *
   * Measured 2026-08-24 — five descriptors open on one port inside one process (`lsof` names them all),
   * the daemon receiving 4 of the dial's 22 greetings in 45s, and a 20-byte ping taking 15 SECONDS to
   * write. That last number is the dial's own silence deadline, so the session died and restarted forever
   * and the screen sat on "0 agents" while this side logged, truthfully, that it had sent two.
   *
   * The dial was never at fault: sniffed directly with the daemon stopped, it emits one clean 71-byte
   * greeting every 2.0s, indefinitely.
   */
  private async tryOpen(): Promise<void> {
    if (this.opening) return
    if (this.foreignPort && Date.now() < this.foreignRetryAt) return
    if (Date.now() - this.openAt < REOPEN_EVERY_MS) return
    this.opening = true
    this.openAt = Date.now()
    let opened: CablePort | null
    try {
      // A late port must not be left running: the attempt we gave up on can still succeed afterwards, and
      // an unowned open port with a live read loop is exactly the stranded reader this guard exists to
      // prevent. So the loser of the race is closed rather than dropped.
      const attempt = this.openPort(
        (chunk) => this.onBytes(chunk),
        (why) => this.onClosed(why),
      )
      let timer: ReturnType<typeof setTimeout> | undefined
      const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`open timed out after ${OPEN_TIMEOUT_MS}ms`)), OPEN_TIMEOUT_MS)
      })
      try {
        opened = await Promise.race([attempt, expiry])
      } catch (err) {
        void attempt.then((late) => late?.close('abandoned — open timed out')).catch(() => {})
        throw err
      } finally {
        clearTimeout(timer)
      }
    } catch (err) {
      // A port that another process holds is the ordinary case, not a fault: esptool, a serial monitor,
      // or a second daemon. Say so and try again on the next tick.
      this.log(`cable: cannot open the dial: ${(err as Error).message}`)
      return
    } finally {
      this.opening = false
    }
    if (!opened) return   // no dial plugged in — this daemon's resting state
    if (this.stopped) { await opened.close('stopped while opening'); return }
    // Nothing reaches this line holding a live port — tick() only calls in when the link is closed — but
    // assigning over one would strand it exactly as above, and the cost of being sure is one branch.
    if (this.link) await this.link.close('replaced')
    // A port that earned the verdict once is presumed foreign until it proves otherwise, but the evidence
    // is gathered fresh every time: a dial that was replaced behind the same path gets a clean hearing.
    if (opened.path !== this.foreignPort) this.foreignPort = null
    this.bytesSinceOpen = 0
    this.framesSinceOpen = 0
    this.link = opened
    // Leftover bytes belong to a session that has ended; carrying them across would put a stale
    // half-frame in front of the first real frame of the new one.
    this.decoder.reset()
    this.greetedMac = null
    this.greetedFw = null
    this.appFocusGeneration += 1
    this.drivingAppFocus = false
    this.expectedAppFocusEcho = ''
    this.expectedAppFocusEchoUntil = 0
    // A new port is a new dial until proven otherwise; tell it everything.
    this.lastAgentsKey = ''
    this.lastMachinesKey = ''
    // INCLUDING which images it has been offered. `offered` holds bare version strings and named no dial,
    // so without this it outlived the session its comment claims it belongs to and became per-DAEMON:
    // offer 0.0.42 to one dial, unplug it, plug in a second still on 0.0.41, and the second is refused
    // because the version — not the board — had already been offered. It sat there on the old image with
    // nothing in the log to say why.
    //
    // Clearing it does NOT reopen the flash loop this guards against. That is `mayOffer`'s job, and it is
    // keyed by MAC and outlives the port precisely so this one does not have to.
    this.offered.clear()
    this.lastRx = Date.now()
    this.log(`cable: open on ${opened.path}`)
  }

  private onClosed(why: string): void {
    this.log(`cable: closed (${why})`)
    this.cancelFormVoice()
    this.cancelSearchVoice()
    this.passageCarry.clear()
    this.voiceDraft.clear()
    this.voiceDraftCreation = undefined
    this.voiceCarryId = undefined
    this.host.onDialGone?.()
    this.activityReads.clear()
    this.activityRefreshAt = 0
    this.activityRefreshAgent = ''
    this.activityLabels.clear()
    // Unplugged, but not forgotten: the mac and the last settings ride along so the app can show the
    // device's rows read-only rather than emptying the pane. The settings are kept on the session too —
    // a device that comes back on the same port should not make the pane blink through empty.
    this.host.onDialStatus?.({
      attached: false,
      ...(this.greetedMac ? { mac: this.greetedMac } : {}),
      ...(this.greetedSettings ? { settings: this.greetedSettings } : {}),
    })
    this.link = null
    this.greetedMac = null
    this.greetedFw = null
    this.appFocusGeneration += 1
    this.expectedAppFocusEcho = ''
    this.expectedAppFocusEchoUntil = 0
    this.lastAgentsKey = ''
    this.lastMachinesKey = ''
    this.voice = null
    this.voiceGeneration++
    // The dial keeps its running image; the half-written slot is erased again by the next accepted offer.
    this.transfer?.finish('interrupted by the port closing')
    this.transfer = null
  }

  // ── inbound ───────────────────────────────────────────────────────────────────────────────────────

  /**
   * What a dial may send in a second before it reads as hostile: a byte stream that is mostly not frames, a
   * flood of frames, or bytes that take the decoder longer than it may spend. A dial sends a few dozen
   * frames a second at most (voice is 16-bit PCM at 16 kHz, about 32 KB/s in frames of up to 8 KB), and its
   * boot noise is a few hundred bytes; the decoder's worst case is a CRC over 8 KB for every eight bytes of
   * a crafted stream, which at USB speed would hold the event loop for seconds at a time.
   */
  static readonly BUDGET = { garbageBytes: 64 * 1024, frames: 2_000, decodeMs: 500 }
  private budget = { since: 0, garbage: 0, frames: 0, ms: 0 }

  private onBytes(chunk: Buffer): void {
    const started = performance.now()
    const discarded = this.decoder.discardedBytes
    let frames = 0
    try {
      this.decode(chunk, () => { frames++ })
    } catch (error) {
      // A throw inside the decoder's callback (the console log's write, the voice buffer) is this dial's
      // fault: thrown out of the port's `data` event it would end the whole devices process.
      this.fault(error)
    }
    const now = Date.now()
    if (now - this.budget.since >= 1_000) this.budget = { since: now, garbage: 0, frames: 0, ms: 0 }
    this.budget.garbage += this.decoder.discardedBytes - discarded
    this.budget.frames += frames
    this.budget.ms += performance.now() - started
    const over = this.budget.garbage > CableSession.BUDGET.garbageBytes ? `${this.budget.garbage} B that are no frames`
      : this.budget.frames > CableSession.BUDGET.frames ? `${this.budget.frames} frames`
      : this.budget.ms > CableSession.BUDGET.decodeMs ? `${Math.round(this.budget.ms)} ms of decoding` : ''
    if (over) {
      this.budget = { since: now, garbage: 0, frames: 0, ms: 0 }
      this.fault(new Error(`${over} in a second, more than a dial sends`), true)
    }
  }

  private decode(chunk: Buffer, counted: () => void): void {
    this.lastRx = Date.now()
    this.bytesSinceOpen += chunk.length
    this.decoder.feed(chunk, (frame) => {
      counted()
      this.framesSinceOpen += 1
      if (frame.type === CableType.Json) {
        let msg: Message
        try {
          msg = JSON.parse(Buffer.from(frame.payload).toString('utf8')) as Message
        } catch {
          return // unreadable payloads are counted by the decoder, never fatal
        }
        // Its failure is this dial's: a rejection left unhandled would end the whole devices process.
        void this.onMessage(msg).catch((error: unknown) => this.fault(error))
        return
      }
      if (frame.type === CableType.Log) {
        // The dial's console. It shares its one USB port with this protocol, so these frames are the only
        // way its log survives at all while the daemon holds the port.
        this.dialLog.device(Buffer.from(frame.payload).toString('utf8'))
        return
      }
      if (frame.type === CableType.Pcm) {
        this.onPcm(Buffer.from(frame.payload))
        return
      }
      // An unknown type is a dial running ahead of this daemon. Visible, never fatal.
      this.log(`cable: unknown frame type 0x${frame.type.toString(16)}`)
    })
  }

  private async onMessage(msg: Message): Promise<void> {
    const str = (key: string): string | undefined =>
      typeof msg[key] === 'string' ? (msg[key] as string) : undefined

    switch (msg.t) {
      case 'hello': {
        // ⚠️ A POSITIVE MATCH, AND ABSENCE MEANS NO. The framing magic already stops the sibling product's
        // dial from ever getting this far, so reaching here with the wrong product means something changed
        // that this code cannot see — a re-unified magic, a fork of this firmware, a third product. The
        // safe reading of "I do not recognise you" is never "you are probably mine".
        //
        // Answered with nothing at all: a `welcome` is what starts a session, and there is no session to
        // have with a dial that is not ours. The port is released on the next tick by the same rule that
        // handles a dial we cannot decode.
        const product = str('product')
        if (product !== CABLE_PRODUCT) {
          if (this.foreignPort !== this.link?.path) {
            this.log(`cable: greeted by a '${product ?? 'nameless'}' dial, not a ${CABLE_PRODUCT} one — releasing the port`)
          }
          this.foreignPort = this.link?.path ?? null
          this.foreignRetryAt = Date.now() + 60_000
          if (this.link) this.reportForeign(this.link.path, `greeted as '${product ?? 'nameless'}'`)
          await this.link?.close('another product')
          this.link = null
          return
        }
        const mac = str('mac') ?? ''
        // Rule 1: every greeting is answered, but only an unfamiliar dial gets the full state.
        await this.send({
          t: 'welcome',
          proto: CABLE_PROTO_VERSION,
          app: this.host.appName(),
          // The CABLED computer's identity — no longer "the one machine". It was the dial's own mac here
          // until proto 2, which was simply wrong: a mac is not a machine id and nothing could select it.
          machine: this.host.localMachine(),
          // Stated up front so the ✓ is correct from the first frame, before any list arrives — which
          // matters after a dial reboot that lands mid-session on a remote selection.
          selected: this.host.selectedMachine(),
          voiceLang: this.host.voiceLang(),
          // Optional controls must be advertised: a new dial can remain useful
          // with an older daemon instead of waiting on commands it ignores.
          features: [
            'voice.draft',
            'agents.refresh',
            ...(this.host.form ? ['form'] : []),
            ...(this.host.selectPassage ? ['selection'] : []),
            ...(this.host.visit ? ['visit'] : []),
            ...(this.host.answerReviewed ? ['question.review'] : []),
            // The desktop will carry this device's preferences. A device that does not see this keeps
            // its own settings screens and never reports.
            'settings',
          ],
        })
        // Log a dial that is new OR that came back running something else. The version half of that test
        // is not decoration: a dial reboots into its new image after an update and greets with the SAME
        // mac, so keying the line on the mac alone suppresses the one line anybody wants after an OTA —
        // "it came back, and on which version". Losing it left a successful 0.0.37 install unverifiable
        // from the log on 2026-08-24.
        const fw = str('fw') ?? '?'
        const hw = str('hw')
        this.greetedHw = hw || undefined
        // Read before the change test below, so a device that only changed a setting still corrects the
        // pane: its fw and mac are the same, and without this the greeting would be treated as a keepalive.
        const settings = readSettings(msg.settings)
        const settingsChanged = JSON.stringify(settings) !== JSON.stringify(this.greetedSettings)
        this.greetedSettings = settings
        if (settingsChanged && mac === this.greetedMac && fw === this.greetedFw) this.report()
        if (mac !== this.greetedMac || fw !== this.greetedFw) {
          const returning = mac === this.greetedMac
          this.greetedMac = mac
          this.everGreeted = true
          this.greetedFw = fw
          this.log(`cable: dial ${mac} ${returning ? 'back ' : ''}on fw ${fw} proto ${msg.proto}${hw ? ` hw ${hw}` : ''}`)
          this.dialLog.greeted()
          this.report({ fw })
          // BEFORE the state push, not after: the push reads the selected machine, and for a remote one
          // that means an RPC over a lane this is what re-opens.
          this.host.onDialAttached?.()
          // Both halves of the test above mean the same thing to this line: a dial with nothing on its
          // screen. A repeat greeting from the same dial on the same image is a keepalive and is skipped,
          // which is the whole reason the branch exists.
          await this.pushAgents()
        }
        // Offered on every greeting, but only ONCE per version per session: accepting makes the dial erase
        // a flash slot before it answers, so a cadence of retries would spend erase cycles on the user's
        // hardware every fifteen seconds, and nothing about the next greeting changes what went wrong.
        await this.maybeOfferFirmware(str('fw') ?? '')
        return
      }
      case 'pong':
        return
      case 'agents.list':
        await this.pushAgents()
        return
      case 'agents.refresh':
        // A workspace receipt needs the roster, not machines, notices and history.
        await this.syncAgents(true)
        return
      case 'machines.list':
        await this.syncMachines(true)
        return
      case 'machine.select':
        await this.selectMachine(str('machineId') ?? '')
        return
      case 'swarms.list':
        await this.syncSwarms(true)
        return
      case 'swarm.select':
        // Not answered here: the window switches, its desk changes, and the new `swarms` and ring
        // pushes are the answer — the same shape as `machine.select`, minus the refusal, because the
        // window never refuses to show a tab it has.
        this.host.selectSwarm(str('swarmId') ?? '')
        return
      case 'models.list': {
        // The one round trip in this protocol: the dial cannot draw a picker until the catalog is in hand,
        // so it waits on this — briefly, and off its own UI task.
        const agentId = str('agentId') ?? ''
        let items: string[] = []
        try {
          items = await this.host.listModels(agentId)
        } catch (err) {
          this.log(`cable: models for ${agentId} failed (${(err as Error).message})`)
        }
        // Answered either way. An empty catalog closes the dial's picker cleanly; silence strands it on a
        // spinner until its own timeout, which reads as a hang rather than "this engine has no choices".
        // Additive correlation: older firmware ignores this and older hosts
        // still identify replies by agentId. Never echo an unbounded value.
        const serial = msg.request
        const request = typeof serial === 'number' && Number.isInteger(serial)
          && serial > 0 && serial <= 0x7fffffff ? serial : undefined
        await this.send({
          t: 'models', agentId, ...(request === undefined ? {} : { request }),
          items: items.map((id) => ({ id })),
        })
        return
      }
      case 'focus':
        if (str('agentId')) {
          const agentId = str('agentId')!
          const now = Date.now()
          const expectationActive = this.expectedAppFocusEcho !== ''
            && now <= this.expectedAppFocusEchoUntil
          if (expectationActive) {
            // Until the commanded tile echoes, every other focus is from the carousel/list repaint that
            // command caused. Do not even update the record: the daemon already commanded the newer truth.
            if (agentId === this.expectedAppFocusEcho) {
              this.expectedAppFocusEcho = ''
              this.expectedAppFocusEchoUntil = 0
            } else {
              // SAID OUT LOUD. A dropped report is a dial and a window on different agents, and dropping
              // it silently is how that state became impossible to explain from the log.
              this.log(`cable: dropped dial focus ${agentId} — waiting for ${this.expectedAppFocusEcho}`)
            }
            return
          }
          if (now > this.expectedAppFocusEchoUntil) {
            this.expectedAppFocusEcho = ''
            this.expectedAppFocusEchoUntil = 0
          }
          // A machine switch re-paints the carousel and may report its OLD tile while the new list is in
          // flight. That one report is not a hand and must not drive the window back.
          //
          // ONLY that one. This used to drop everything for as long as the switch took, and a remote
          // machine's switch takes seconds — measured at ten. Every swipe made in that window vanished,
          // so the dial walked on and the window stayed where it was, with the two screens naming
          // different agents and nothing left to correct them. A dial that reports a move it did not make
          // is fixed at the source now (carousel_goto in the firmware), which leaves only the stale repeat
          // of the tile the dial was already on to guard against.
          if (this.drivingAppFocus && now - this.drivingSince < APP_SWITCH_REPAINT_MS) {
            this.log(`cable: dropped dial focus ${agentId} — repaint from the switch in flight`)
            return
          }
          // Remember where the dial IS, not just that it said so: followApp() compares against this to
          // avoid echoing the dial's own move back at it.
          this.desiredFocus = agentId
          this.host.focus(agentId)
        }
        return
      case 'notif.read': {
        const agentId = str('agentId')
        const token = notificationReadToken(msg.readToken)
        if (agentId && token) this.host.readNotification?.(agentId, token)
        return
      }
      case 'agent.open':
        // Only the one reason the window knows; anything else reads as a tap, the older frame's meaning.
        if (str('agentId')) this.host.openAgent(str('agentId')!, str('reason') === 'question' ? 'question' : undefined)
        return
      case 'agent.fork': {
        // The dial's Fork action. The host opens the new agent in the window itself; the dial only needs
        // to hear a refusal, as a toast, so a press that did nothing is not a press that was lost.
        const id = str('agentId')
        if (!id) return
        void this.host.forkAgent(id).then((result) => {
          if (!result.ok) return this.toast(result.detail ?? result.error)
        }).catch((err) => this.toast((err as Error).message))
        return
      }
      case 'scroll': {
        // Forwarded verbatim, including the reports carrying no travel: the two ends of a stroke are the
        // whole point of the message. A `down` with nothing in it stops a fling still running, and an `up`
        // with nothing in it is a finger that came to rest before it lifted and must not be thrown.
        const phase = str('phase')
        if (phase !== 'down' && phase !== 'move' && phase !== 'up') return
        const dy = typeof msg.dy === 'number' ? msg.dy : 0
        const v = typeof msg.v === 'number' ? msg.v : 0
        this.host.scrolled(phase, dy, v)
        return
      }
      case 'selection': {
        const agentId = str('agentId')
        const op = str('op')
        const requestId = str('requestId')
        if (!agentId || !requestId || requestId.length > 64 || !op || !['begin', 'step', 'extend', 'cancel', 'match', 'lines'].includes(op)) return
        const command: SelectionCommand = { agentId, op: op as SelectionCommand['op'],
          selectionId: str('selectionId'), revision: typeof msg.revision === 'number' ? msg.revision : undefined,
          delta: typeof msg.delta === 'number' ? msg.delta : undefined, extend: typeof msg.extend === 'boolean' ? msg.extend : undefined }
        const link = this.link
        const result = await (this.host.selectPassage?.(command) ?? Promise.resolve({ ok: false as const, error: 'Update Harness to select text.' }))
        if (this.link === link) await this.send({ t: 'selection.state', requestId, ...result })
        return
      }
      case 'carry.prepare': {
        const id = str('carryId') ?? '', requestId = str('requestId')
        if (!requestId || requestId.length > 64) return
        const link = this.link
        const result = await this.passageCarry.prepare(id, { op: 'pin', agentId: str('agentId') ?? '',
          selectionId: str('selectionId'), revision: typeof msg.revision === 'number' ? msg.revision : undefined })
        if (this.link === link) await this.send({ t: 'carry.state', requestId, carryId: id, ...result })
        return
      }
      case 'carry.cancel': {
        const id = str('carryId')
        if (!id) return
        this.passageCarry.clear(id)
        if (this.voiceCarryId === id) {
          this.voiceGeneration++
          this.voice = null
          this.voiceCarryId = undefined
        }
        return
      }
      case 'form': {
        const op = str('op'), formId = str('formId'), requestId = str('requestId')
        if (!formId || !requestId || requestId.length > 64 || !op ||
            !['open', 'state', 'move', 'activate', 'back', 'close'].includes(op)) return
        const link = this.link
        const result = await (this.host.form?.({ op: op as FormCommand['op'], formId,
          ...(msg.surface !== undefined ? { surface: msg.surface as FormCommand['surface'] } : {}),
          revision: typeof msg.revision === 'number' ? msg.revision : undefined,
          delta: typeof msg.delta === 'number' ? msg.delta : undefined }) ??
          Promise.resolve({ ok: false, active: false, error: 'Update Harness for New Harness.' }))
        if (this.link === link) await this.send({ t: 'form.state', requestId, formId, ...result })
        return
      }
      case 'visit': {
        const op = str('op'), visitId = str('visitId'), requestId = str('requestId')
        if (!visitId || !requestId || requestId.length > 64 || !op ||
          !['open', 'latest', 'back', 'cancel'].includes(op)) return
        const link = this.link
        const result = await (this.host.visit?.({ op: op as VisitCommand['op'], visitId, agentId: str('agentId') }) ??
          Promise.resolve({ ok: false, active: false, error: 'Update Harness to visit an alert.' }))
        if (this.link === link) await this.send({ t: 'visit.state', requestId, visitId, ...result })
        return
      }
      case 'turn.send':
        if (str('agentId') && str('text')) this.host.sendTurn(str('agentId')!, str('text')!)
        return
      case 'turn.stop':
        if (str('agentId')) this.host.stopTurn(str('agentId')!)
        return
      case 'draft.command': {
        const id = str('draftId'), requestId = str('requestId'), op = str('op'), revision = msg.revision
        if (!id || !requestId || requestId.length > 64 || !op || !Number.isSafeInteger(revision)) return
        const link = this.link
        const state = await this.voiceDraft.command(id, revision as number, op,
          typeof msg.delta === 'number' ? msg.delta : 0)
        if (this.link === link) await this.send({ t: 'draft.state', requestId, ...state })
        return
      }
      case 'question.read': {
        const agentId = str('agentId'), requestId = str('requestId')
        if (!agentId || !requestId || requestId.length > 64) return
        const state = this.questionInbox.read(agentId)
        if (state.ok && !this.host.canSpeakQuestion?.(agentId))
          state.questions = state.questions.map(q => ({ ...q, canText: false }))
        await this.send({ t: 'question.state', agentId, requestId, ...this.whoIs(agentId), ...state })
        return
      }
      case 'answer.reviewed': {
        const agentId = str('agentId'), token = str('token'), requestId = str('requestId')
        if (!agentId || !token || !requestId || requestId.length > 64) return
        const link = this.link
        const receipt = await this.questionInbox.submit(agentId, token, msg.choices,
          answer => this.host.answerReviewed?.(answer) ?? Promise.resolve({ ok: false,
            error: 'Update Harness to answer this question.' }), msg.drafts)
        if (this.link === link) await this.send({ t: 'answer.receipt', agentId, token, requestId, ...receipt })
        return
      }
      case 'answer': {
        // `answers` is the dial's own object, one entry per question, keyed by the keys WE asked with. It
        // travels verbatim. Until proto 2 this case demanded `{id, optionId}` — a shape the dial has never
        // sent — so every answer from the question screen was silently dropped on the floor.
        const agentId = str('agentId')
        const requestId = str('requestId')
        const answers = msg.answers
        if (agentId && requestId && answers && typeof answers === 'object' && !Array.isArray(answers)) {
          const flat: Record<string, string> = {}
          for (const [k, v] of Object.entries(answers as Record<string, unknown>)) {
            if (typeof v === 'string') flat[k] = v
          }
          this.host.answer(agentId, requestId, flat)
        }
        return
      }
      case 'agent.update':
        if (str('agentId')) this.host.updateAgent(str('agentId')!, str('model'), str('effort'))
        return
      case 'voice.begin': {
        this.cancelFormVoice()
        this.cancelSearchVoice()
        this.voiceDraftCreation = undefined
        this.voiceGeneration++
        this.voiceUploadId = str('uploadId') ?? ''
        this.voiceCarryId = str('carryId')
        // Presence, even malformed, selects this purpose. It can never fall back
        // to task routing or an agent's terminal.
        const formVoice = 'formId' in msg || 'formRevision' in msg
        const searchVoice = 'searchId' in msg || 'searchRevision' in msg
        const draftVoice = 'draftId' in msg || 'draftRevision' in msg || 'draftOp' in msg
        const questionVoice = 'questionToken' in msg || 'questionIndex' in msg
        const carryVoice = 'carryId' in msg
        const carry: CarryRead | undefined = !formVoice && !questionVoice && !draftVoice && !searchVoice && carryVoice
          ? (typeof msg.carryId === 'string' && str('agentId') && !('cmd' in msg) && !('selectionId' in msg)
            ? this.passageCarry.read(msg.carryId)
            : { ok: false, error: 'Choose the carried text and its recipient again.' }) : undefined
        let draft: { pin?: DraftPin } | undefined
        if (draftVoice) {
          const id = str('draftId'), revision = msg.draftRevision
          draft = { pin: id && Number.isSafeInteger(revision) &&
            !formVoice && !questionVoice && !carryVoice && !searchVoice && !('agentId' in msg) && !('cmd' in msg) && !('selectionId' in msg)
            ? this.voiceDraft.pin(id, revision as number, msg.draftOp) : undefined }
        }
        let question: { pin?: QuestionSpeech } | undefined
        if (questionVoice) {
          const agentId = str('agentId'), token = str('questionToken'), index = msg.questionIndex
          const pin = agentId && token && Number.isInteger(index) &&
            !formVoice && !carryVoice && !draftVoice && !searchVoice && !('cmd' in msg) && !('selectionId' in msg)
            ? { agentId, token, index: index as number } : undefined
          question = { pin: pin && this.host.canSpeakQuestion?.(pin.agentId) &&
            this.questionInbox.canSpeak(pin) ? pin : undefined }
        }
        let form: { command?: FormCommand; pin: Promise<FormResult> } | undefined
        if (formVoice) {
          const formId = str('formId'), revision = msg.formRevision, queryId = this.voiceUploadId
          const valid = formId && /^[a-zA-Z0-9-]{1,48}$/.test(formId) &&
            /^[a-zA-Z0-9-]{1,64}$/.test(queryId) && Number.isSafeInteger(revision) &&
            (revision as number) >= 0 && !('agentId' in msg) && !('selectionId' in msg) && !('cmd' in msg) && !carryVoice && !questionVoice && !draftVoice && !searchVoice
          const command: FormCommand | undefined = valid
            ? { formId, op: 'query.begin', revision: revision as number, queryId } : undefined
          this.voiceForm = command
          form = { command, pin: (command && this.host.form ? this.host.form(command)
            : Promise.resolve({ ok: false, active: false, error: 'Open a field and say its name again.' }))
            .catch(() => ({ ok: false, active: false, error: 'Could not open voice search. Try again.' })) }
        }
        let search: { command?: SelectionCommand; pin: Promise<SelectionResult> } | undefined
        if (searchVoice) {
          const selectionId = str('searchId'), revision = msg.searchRevision, agentId = str('agentId')
          const valid = selectionId && /^[a-zA-Z0-9-]{1,48}$/.test(selectionId) && agentId && agentId.length <= 200 &&
            /^[a-zA-Z0-9-]{1,64}$/.test(this.voiceUploadId) && Number.isSafeInteger(revision) &&
            (revision as number) > 0 && (revision as number) <= 0x7fffffff &&
            !formVoice && !questionVoice && !draftVoice && !carryVoice && !('selectionId' in msg) && !('cmd' in msg)
          const command: SelectionCommand | undefined = valid ? { op: 'read', selectionId, revision: revision as number, agentId } : undefined
          this.voiceSearch = command
          search = { command, pin: (command && this.host.selectPassage ? this.host.selectPassage(command)
            : Promise.resolve({ ok: false, error: 'Choose a passage before searching.' } as const))
            .catch(() => ({ ok: false, error: 'Could not open output search. Try again.' })) }
        }
        this.voice = {
          agentId: str('agentId'),
          cmd: str('cmd'),
          lang: str('lang') ?? this.host.voiceLang(),
          // The DIAL's rate, never this side's guess. Describing 8 kHz audio as 16 kHz does not make the
          // speech sound fast — the transcriber is handed a container that lies about itself and answers
          // with nothing at all.
          rate: typeof msg.sr === 'number' && msg.sr > 0 ? msg.sr : DEFAULT_VOICE_RATE,
          chunks: [],
          bytes: 0,
          form,
          carry,
          question,
          draft,
          search,
          ...(!formVoice && !carryVoice && !questionVoice && !draftVoice && !searchVoice && str('selectionId') ? {
            selectionId: str('selectionId'),
            selection: (str('agentId') && this.host.selectPassage
              ? this.host.selectPassage({ op: 'pin', agentId: str('agentId')!, selectionId: str('selectionId'),
                  revision: typeof msg.selectionRevision === 'number' ? msg.selectionRevision : undefined })
              : Promise.resolve({ ok: false as const, error: 'Choose the text again.' }))
                .catch(() => ({ ok: false as const, error: 'Could not attach that text. Choose it again.' })),
          } : {}),
        }
        return
      }
      case 'voice.abort':
        // An abort queued for the previous recording must not cancel its replacement.
        if (str('uploadId') && str('uploadId') !== this.voiceUploadId) return
        if (this.voiceDraftCreation?.uploadId === this.voiceUploadId) {
          this.voiceDraft.cancelCreation(this.voiceDraftCreation.id)
          this.voiceDraftCreation = undefined
        }
        this.cancelFormVoice()
        this.cancelSearchVoice()
        if (this.voice?.selectionId && this.voice.agentId) void this.host.selectPassage?.({
          op: 'cancel', agentId: this.voice.agentId, selectionId: this.voice.selectionId })
        this.voiceGeneration++
        this.voice = null
        this.voiceCarryId = undefined
        return
      case 'voice.end':
        if (str('uploadId') && str('uploadId') !== this.voiceUploadId) return
        await this.finishVoice(msg.review === true)
        return
      case 'voice.confirm':
        if (str('routeId') && str('agentId')) this.host.focus(str('agentId')!)
        return
      case 'settings.state': {
        // The device's answer to a `settings.set`, and also what it sends unprompted after a change made
        // on the glass. Carries the values READ BACK, so a refusal corrects the pane rather than leaving
        // it hopeful — which is why the settings are taken even when `ok` is false.
        const settings = readSettings(msg.settings)
        if (settings) this.greetedSettings = settings
        if (msg.ok === false) this.log(`cable: device refused a settings change: ${str('error') ?? 'no reason given'}`)
        this.report()
        return
      }
      case 'fw.accept':
        // The dial has erased its slot and is expecting bytes. Nothing was sent before this.
        // The window is told NOW rather than at the offer: an offer the dial refuses is nothing to
        // show, and the minute that matters — do not unplug it — starts here.
        this.report({ updating: this.offeringTo })
        await this.transfer?.pump()
        return
      case 'fw.progress':
        // Not only a progress bar: this ack IS the credit that lets the next slices go.
        if (typeof msg.written === 'number') await this.transfer?.onProgress(msg.written)
        return
      case 'fw.done':
        // WHETHER AN UPDATE LANDS is not something the release process can see:
        // a version is published, and after that the only evidence is the next
        // `hello` from a dial that may never have taken it.
        this.transfer?.finish('installed — the dial is rebooting')
        this.transfer = null
        this.offeringTo = ''
        // Still attached from the window's side: the reboot re-greets within seconds and the fw
        // field corrects itself then. Clearing `updating` is what matters.
        this.report()
        return
      case 'fw.error':
        // The outcome is `refused`, not the dial's message: that string is the
        // firmware's own text and this stream carries short codes.
        this.transfer?.finish(`refused: ${str('message') ?? 'no reason given'}`)
        this.transfer = null
        this.offeringTo = ''
        this.report()
        return
      default:
        this.log(`cable: unhandled message '${msg.t}'`)
    }
  }

  /** Offer an update if there is one, the dial is not on it, and this session has not tried it already. */
  /**
   * May this version be written to this dial at all?
   *
   * DEFENCE IN DEPTH, AND IT IS THE LAYER THAT PROTECTS THE HARDWARE. Everything above decides whether a
   * dial is ours; this decides how badly a wrong answer can hurt. An OTA writes three megabytes and
   * reboots, so a pair of daemons that disagree about ownership do not merely argue — they take turns
   * flashing the same board every fifteen seconds, which is about 700 MB an hour into a flash rated in
   * erase cycles. The device is unusable throughout, and nothing about it looks like a loop from either
   * side: each daemon sees a dial on an unexpected version and does the reasonable thing.
   *
   * `offered` alone does not cover it: that set is per SESSION, and every one of those flashes ends in a
   * reboot that starts a new one. This memory is keyed by the dial and outlives the port.
   */
  private mayOffer(mac: string, version: string): boolean {
    const key = `${mac}:${version}`
    if (this.written.has(key)) {
      this.log(`cable: firmware ${version} already written to ${mac} — not offering it again`)
      return false
    }
    const now = Date.now()
    const recent = (this.writeLog.get(mac) ?? []).filter((at) => now - at < 60 * 60 * 1000)
    if (recent.length >= FW_WRITES_PER_HOUR) {
      this.log(`cable: ${mac} has taken ${recent.length} firmware writes this hour — holding off`)
      return false
    }
    this.written.add(key)
    this.writeLog.set(mac, [...recent, now])
    return true
  }

  private async maybeOfferFirmware(runningVersion: string): Promise<void> {
    if (!this.host.firmwareFor || this.transfer || !runningVersion) return
    // The BOARD goes with the version. Which manifest entry this device's image comes from is decided
    // from its own hello, never defaulted — see otaKeyForBoard.
    const candidate = await this.host.firmwareFor(runningVersion, this.greetedHw).catch(() => null)
    // Keyed by DIAL as well as version. Holding bare version strings made this a statement about the
    // image rather than about the board: offer 0.0.42 to one dial, swap in a second still on 0.0.41, and
    // the second was refused because that version had been offered — to someone else. It then sat on the
    // old image with nothing in the log to say why, which is how it was found.
    if (!candidate) return
    const mac = this.greetedMac ?? 'unknown'
    const offerKey = `${mac}:${candidate.version}`
    if (this.offered.has(offerKey)) return
    if (!this.mayOffer(mac, candidate.version)) return
    this.offered.add(offerKey)

    this.log(`cable: offering firmware ${candidate.version} (${candidate.image.length} B)`)
    this.offeringTo = candidate.version
    this.transfer = new FirmwareTransfer(
      candidate.image,
      candidate.version,
      async (slice) => {
        if (!this.link?.isOpen) throw new Error('port closed mid-transfer')
        await this.link.write(encodeCableFrame(CableType.Fw, slice))
      },
      (line) => this.log(line),
    )
    await this.send({ t: 'fw.offer', version: candidate.version, size: candidate.image.length, sha256: candidate.sha256 })
  }

  private onPcm(chunk: Buffer): void {
    if (!this.voice) return // audio outside a turn is a dial that restarted mid-capture
    this.voice.bytes += chunk.length
    if (this.voice.bytes > VOICE_MAX_BYTES) {
      this.log('cable: voice over the length cap, dropped')
      this.cancelFormVoice()
      this.cancelSearchVoice()
      this.voice = null
      return
    }
    this.voice.chunks.push(chunk)
  }

  private async finishVoice(review = false): Promise<void> {
    const turn = this.voice
    const generation = this.voiceGeneration
    const uploadId = this.voiceUploadId
    const current = () => generation === this.voiceGeneration
    const reply = (message: Message) => current()
      ? this.send({ ...message, ...(uploadId ? { uploadId } : {}) })
      : Promise.resolve(false)
    this.voice = null
    if (turn?.draft && (!turn.draft.pin || !this.voiceDraft.current(turn.draft.pin))) {
      await reply({ t: 'voice.error', message: 'That draft changed. Review it again.' }); return
    }
    if (turn?.question && (!turn.question.pin || !this.questionInbox.canSpeak(turn.question.pin) ||
        !this.host.canSpeakQuestion?.(turn.question.pin.agentId))) {
      await reply({ t: 'voice.error', message: 'This question changed. Open it again.' })
      return
    }
    if (turn?.carry && !turn.carry.ok) {
      await reply({ t: 'voice.error', message: turn.carry.error })
      return
    }
    const searchPin = await turn?.search?.pin
    if (!current()) return
    if (turn?.search && (!searchPin?.ok || !turn.search.command)) {
      this.cancelSearchVoice()
      await reply({ t: 'voice.error', message: searchPin && !searchPin.ok ? searchPin.error : 'Choose the passage again.' }); return
    }
    const formPin = await turn?.form?.pin
    if (!current()) return
    if (formPin && (!formPin.ok || !formPin.active || !formPin.canQuery)) {
      this.cancelFormVoice()
      await reply({ t: 'voice.error', message: formPin.error || 'Open the field and try again.' })
      return
    }
    const selection = await turn?.selection
    if (turn?.selectionId && turn.agentId) void this.host.selectPassage?.({
      op: 'cancel', agentId: turn.agentId, selectionId: turn.selectionId })
    if (!current()) return
    if (selection && (!selection.ok || !selection.text)) {
      await reply({ t: 'voice.error', message: selection.ok ? 'Choose the text again.' : selection.error })
      return
    }
    if (!turn || turn.bytes === 0) {
      this.cancelFormVoice()
      this.cancelSearchVoice()
      await reply({ t: 'voice.error', message: "Didn't catch that" })
      return
    }

    const seconds = turn.bytes / (turn.rate * 2)
    this.log(`cable: voice ${seconds.toFixed(1)}s (${Math.round(turn.bytes / 1024)} KB) → stt`)

    let transcript: string
    try {
      transcript = (await this.host.transcribe(Buffer.concat(turn.chunks), turn.rate, turn.lang)).trim()
    } catch (err) {
      if (current()) { this.cancelFormVoice(); this.cancelSearchVoice() }
      await reply({ t: 'voice.error', message: (err as Error).message })
      return
    }
    if (!current()) return
    if (!transcript) {
      this.cancelFormVoice()
      this.cancelSearchVoice()
      await reply({ t: 'voice.error', message: "Didn't catch that" })
      return
    }

    if (turn.search) {
      // Speech service punctuation is not part of a remembered phrase. Preserve
      // all internal punctuation (paths, identifiers, and code) literally.
      const query = transcript.replace(/[.!?]$/, '').trim()
      if (!query || Buffer.byteLength(query, 'utf8') > 120 || /[\x00-\x1f\x7f-\x9f]/.test(query)) {
        this.cancelSearchVoice()
        await reply({ t: 'voice.error', message: 'Say a short phrase to find.' }); return
      }
      const result = await this.host.selectPassage!({ ...turn.search.command!, op: 'search', query })
        .catch(() => ({ ok: false, error: 'Search did not finish. Try again.' } as const))
      if (!current()) return
      if (!result.ok) { this.cancelSearchVoice(); await reply({ t: 'voice.error', message: result.error }); return }
      this.voiceSearch = undefined
      await reply({ t: 'voice.search', agentId: turn.search.command!.agentId, ...result }); return
    }
    if (turn.draft) {
      const state = this.voiceDraft.edit(turn.draft.pin!, transcript)
      if (!state.ok) { await reply({ t: 'voice.error', message: state.error }); return }
      await reply({ t: 'voice.draft', ...state }); return
    }
    if (turn.question) {
      const pin = turn.question.pin!
      const draft = this.host.canSpeakQuestion?.(pin.agentId) ? this.questionInbox.draft(pin, transcript)
        : { ok: false as const, error: 'Use the terminal to answer this question.' }
      if (!draft.ok) { await reply({ t: 'voice.error', message: draft.error }); return }
      await reply({ t: 'voice.question', agentId: pin.agentId, token: pin.token,
        questionIndex: pin.index, draftId: draft.draftId, text: draft.text })
      return
    }

    if (turn.form) {
      const command = turn.form.command
      if (!command || transcript.length > 240) {
        this.cancelFormVoice()
        await reply({ t: 'voice.error', message: 'Say a short harness or project name.' })
        return
      }
      const result = await this.host.form!({ ...command, op: 'query', text: transcript })
        .catch(() => ({ ok: false, active: false, error: 'Search did not finish. Try again.' }))
      if (!current()) return
      this.cancelFormVoice()
      await reply({ t: 'voice.form', formId: command.formId, ...result })
      return
    }

    // Named an agent: the dial was on a tile and there is nothing to decide.
    let agentId = turn.agentId
    let agentName = ''
    const agents = await this.host.listAgents()
    if (!current()) return
    if (review && !agentId) {
      await reply({ t: 'voice.error', message: 'Choose a recipient before drafting.' }); return
    }
    if (!agentId) {
      // NOBODY NAMED, SO THE WINDOW DECIDES. It opens its palette with these words already in the field
      // and runs the route a typed task would have run — the same fifteen candidates, the same trimmed
      // recaps, the same threshold, and the same picker when the answer is not good enough to act on.
      //
      // The window DELIVERS what it picks, so there is nothing left to send here: a `sent` outcome is
      // already on its way to an agent, and calling sendTurn on it would deliver the sentence twice.
      const inWindow = this.host.routeInWindow
        ? await this.host.routeInWindow(transcript, turn.cmd)
        : ({ t: 'unavailable' } as const)
      if (!current()) return
      if (inWindow.t === 'sent') {
        this.log(`cable: the window routed the spoken task → ${inWindow.agentId.slice(0, 8)}`)
        await reply({
          t: 'voice.transcript',
          routeId: '',
          text: transcript,
          agentId: inWindow.agentId,
          // Only a name the DIAL's own list knows: it draws this, and an agent the window reached on a
          // machine the carousel has not been told about yet has no tile here to put a name on. The ring
          // that follows the window's focus brings both along a moment later.
          agentName: agents.find((a) => a.id === inWindow.agentId)?.name ?? '',
          needsConfirm: false,
        })
        return
      }
      if (inWindow.t === 'cancelled') {
        // A person closed the palette. Nothing was sent and nothing should be — but the dial is still
        // showing the sending overlay, so it has to be told, or it sits there until its own watchdog.
        await reply({ t: 'voice.error', message: 'Cancelled in the window' })
        return
      }
      if (inWindow.t === 'abandoned') {
        // It took the words and went quiet. Routing here now would race a pick that may still be coming,
        // and two turns from one sentence is worse than none — so say where the words went instead.
        await reply({ t: 'voice.error', message: 'Still waiting on the window' })
        return
      }
      try {
        const decision = await this.host.route(transcript, agents)
        if (!current()) return
        agentId = decision.agentId
        this.log(`cable: routed → ${agentId} (${decision.reason})`)
      } catch (err) {
        await reply({ t: 'voice.error', message: (err as Error).message })
        return
      }
    }
    agentName = agents.find((a) => a.id === agentId)?.name ?? ''

    if (!agentId) {
      await reply({ t: 'voice.error', message: 'No harness to send that to' })
      return
    }
    const instruction = turn.cmd ? `/${turn.cmd} ${transcript}` : transcript
    const carried = turn.carry?.ok ? turn.carry.passage : undefined
    // An explicit target that vanished never becomes an inferred recipient.
    if (carried && !agents.some(a => a.id === agentId)) {
      await reply({ t: 'voice.error', message: 'That recipient is no longer available. Choose it again.' })
      return
    }
    if (review) {
      const recipient = agentId
      const state = this.voiceDraft.create({ agentId: recipient, name: agentName || 'Harness', text: transcript,
        context: carried ? `With text from ${carried.sourceName}` : selection?.ok && selection.text ? 'With selected text' : '',
        carryId: carried?.id,
        submit: async words => {
          const edited = turn.cmd ? `/${turn.cmd} ${words}` : words
          const text = carried ? withCarriedPassage(edited, carried)
            : selection?.ok && selection.text ? withSelectedPassage(edited, selection.text) : edited
          const result = this.host.sendTurn(recipient, text)
          if (result && !result.ok) return { ok: false, error: 'Could not reach that harness. Check its connection.' }
          if (carried) this.passageCarry.clear(carried.id)
          return { ok: true }
        } })
      if (!state.ok) { await reply({ t: 'voice.error', message: state.error }); return }
      this.voiceDraftCreation = { uploadId, id: state.id }
      await reply({ t: 'voice.draft', ...state }); return
    }
    const text = carried ? withCarriedPassage(instruction, carried)
      : selection?.ok && selection.text ? withSelectedPassage(instruction, selection.text) : instruction
    try {
      const submitted = this.host.sendTurn(agentId, text)
      if (submitted && !submitted.ok) {
        await reply({ t: 'voice.error', message: carried
          ? 'Could not reach that harness. Your carried text is still here.'
          : 'Could not reach that harness. Check its connection and try again.' })
        return
      }
    } catch (_) {
      await reply({ t: 'voice.error', message: 'Could not send. Check the terminal before trying again.' })
      return
    }
    if (carried) {
      this.passageCarry.clear(carried.id)
      this.voiceCarryId = undefined
    }
    await reply({ t: 'voice.transcript', routeId: '', text: transcript, agentId, agentName, needsConfirm: false,
      ...(carried ? { carryId: carried.id } : {}) })
  }

  private cancelSearchVoice(): void {
    const command = this.voiceSearch
    this.voiceSearch = undefined
    if (command) void this.host.selectPassage?.({ ...command, op: 'cancel' }).catch(() => {})
  }

  private cancelFormVoice(): void {
    const command = this.voiceForm
    this.voiceForm = undefined
    if (command) void this.host.form?.({ ...command, op: 'query.cancel' }).catch(() => {})
  }

  // ── outbound ──────────────────────────────────────────────────────────────────────────────────────

  /**
   * Every status line this session emits. It exists so identity and settings ride on all of them: a
   * window that learned the settings from the greeting and then received a bare `{attached:true}` from
   * a firmware transfer would blank the pane in the middle of an update.
   */
  private report(extra: Partial<DialStatus> = {}): void {
    this.host.onDialStatus?.({
      attached: true,
      fw: this.greetedFw ?? undefined,
      ...(this.greetedHw ? { hw: this.greetedHw } : {}),
      ...(this.greetedMac ? { mac: this.greetedMac } : {}),
      ...(this.greetedSettings ? { settings: this.greetedSettings } : {}),
      ...extra,
    })
  }

  /**
   * Ask the device to change the named settings. Absent fields are not sent, so two windows open on the
   * same device cannot overwrite each other with the values each last saw.
   *
   * Resolves when the frame is on the wire, NOT when the device has agreed: the answer is a
   * `settings.state`, which arrives as a status update like any other. A caller that waited here would
   * be waiting on a device that may be asleep.
   */
  async setSettings(patch: DeviceSettingsPatch): Promise<boolean> {
    // `id` addresses the DEVICE; it is not one of its settings and must not be sent as one.
    const fields = Object.entries(patch).filter(([key, value]) => value !== undefined && key !== 'id' && key !== 'companion' && key !== 'companionDetails' && key !== 'companionProtocol')
    if (!fields.length) return true
    const sent = await this.send({ t: 'settings.set', ...Object.fromEntries(fields) })
    if (!sent) this.log('cable: settings change not written — the device is not on the wire')
    return sent
  }

  private async send(msg: Message): Promise<boolean> {
    if (!this.link?.isOpen) return false
    try {
      await this.link.write(encodeCableFrame(CableType.Json, Buffer.from(JSON.stringify(msg), 'utf8')))
      return true
    } catch (err) {
      this.log(`cable: write failed (${(err as Error).message})`)
      await this.link.close('write failed')
      return false
    }
  }

  /**
   * Push the agent list, STREAMED — begin, one message per agent, end.
   *
   * A frame is capped at 8 KB and a hundred agents do not fit in it. One agent per message needs no chunk
   * arithmetic on either side and bounds the message length by construction rather than by hoping the
   * names stay short.
   */
  /** What the dial has been told, as one comparable string. */
  private static agentsKey(agents: CableAgent[]): string {
    // `machine` is in the key, not just `machineId`: the dial DRAWS the name, so a machine being renamed
    // has to reach the screen even though not one agent has changed.
    return agents.map((a) => `${a.id}:${a.name}:${a.engine ?? ''}:${a.model ?? ''}:${a.effort ?? ''}:${a.machineId ?? ''}:${a.machine ?? ''}`).join('|')
  }


  /**
   * Send the agent list IF it differs from what the dial was last told.
   *
   * Called on attach and on every tick. The tick is not belt-and-braces: the list can be wrong through no
   * fault of the dial — a daemon restarting answers `hello` before its registry has finished loading, and
   * the honest answer at that instant is "no agents". Something has to say the true one a second later.
   */
  async syncAgents(force = false): Promise<void> {
    return this.queued(() => this.syncAgentsNow(force))
  }

  private async syncAgentsNow(force: boolean): Promise<void> {
    const snapshot = this.host.listAgentSnapshot ? await this.host.listAgentSnapshot() : {
      agents: await this.host.listAgents(), tab: this.host.activeSwarm(), total: this.host.agentTotal(),
    }
    const { agents, tab, total } = snapshot
    // WHETHER there is a window is in the key, not WHICH tab: an empty tab after the window shut sends the
    // same zero rows and draws a different screen, so that flip has to push. The tab's id does not — the
    // dial names the tab from the `swarms` frame — and keying on it made every tab switch push twice,
    // once when `app_swarms` named the new tab over the old panes and again when `app_panes` arrived.
    const key = `${tab ? 'window' : ''}|${CableSession.agentsKey(agents)}`
    if (!force && key === this.lastAgentsKey) return
    this.lastAgentsKey = key
    // Every push, and only pushes. The dial showing a different number from the daemon is a question this
    // line answers in one look: either the daemon never said it, or it said it and the dial disagreed.
    this.log(`cable: agents → ${agents.length} of ${total}${force ? ' (requested)' : ''}`)

    await this.send({ t: 'agents.begin' })
    for (const a of agents) {
      await this.send({
        t: 'agent',
        id: a.id,
        name: a.name,
        engine: a.engine ?? '',
        model: a.model ?? '',
        effort: a.effort ?? '',
        // Where it lives. The id is what the dial sends back for every action, the name is what it draws
        // under the agent's, and the id is also how a machine row finds its first agent.
        machineId: a.machineId ?? '',
        machine: a.machine ?? '',
      })

    }
    // Every agent sent is walked. What travels beside them: `total`, the account-wide count the overview
    // prints (the rows behind it stay here), and `tab`, the active tab's id — '' with no window, which is
    // how the dial tells "the app is shut" from "this tab is empty" when both send zero agents.
    await this.send({ t: 'agents.end', total, tab })

    // The list just changed shape under the dial, so say again which agent both screens are on.
    //
    // This is the ONLY thing the daemon re-asserts, and it is the current record rather than a second
    // memory of it — see desiredFocus. A re-anchor after a push is silent by design (the dial reports
    // nothing it did not do itself), so without this a dial that landed on the wrong tile would sit there
    // with nobody to notice.
    //
    // Only for an agent the list just sent. The record can name one on another tab — the window focused
    // it there, then switched — and a focus the dial cannot land is a frame it holds for five seconds and
    // a warning per push; the tab switch is what un-focused it, and the next click sets a new record.
    if (this.desiredFocus && agents.some((a) => a.id === this.desiredFocus)) {
      this.expectedAppFocusEcho = this.desiredFocus
      this.expectedAppFocusEchoUntil = Date.now() + APP_FOCUS_SETTLE_MS
      await this.focusAgent(this.desiredFocus)
    }

    // A tile that has just appeared has no history on the dial. The usual case is a remote machine: its
    // agents reach the cache seconds after the greeting, long after the attach pushed everyone else's.
    // Cheap to say on every change — [restored] makes it a no-op for every tile already carrying one.
    this.restoreInBackground()
  }

  /**
   * What each agent was last doing.
   *
   * A tile with a name and no recap has forgotten the work it belongs to, and that is what a dial shows
   * every time it is replugged or the daemon restarts — the summaries were on disk the whole time, nobody
   * had sent them.
   *
   * `restore: true` is the load-bearing part: history, not news. No beep, no notification, no busy state.
   * Without it, plugging the cable in announces every turn that finished while it was unplugged.
   *
   * Sent on attach only. The list is re-sent whenever it changes; the history behind it does not, or every
   * rename would replay a week of recaps.
   */
  /**
   * Agents whose history the dial has already been given.
   *
   * THE DIAL KEEPS WHAT IT IS TOLD. Re-sending a tile's recaps buys nothing and costs 55 frames down a
   * cable that the `focus` somebody just clicked has to share — measured: a switch every second kept the
   * link saturated, and the focus, written in 20 ms, reached the glass 1.7 s later.
   *
   * Cleared on attach, which is the one moment the dial genuinely has nothing: a replug, a reboot, an OTA.
   */
  private readonly restored = new Set<string>()

  /** A background restore already walking the list, so a second trigger joins it rather than racing it. */
  private restoring = false

  async pushRestores(): Promise<void> {
    // READ FIRST, QUEUE SECOND, and the split is the whole point. A remote agent's history is a cloud
    // round trip and there is one per agent; asking for them from INSIDE the push chain holds every frame
    // behind them — including the `focus` the person who just clicked is waiting for. Measured on the
    // desk: a click from a local agent to a remote one took 1.5 s, of which 0.7 s was this loop waiting
    // on the first `agent_recent` while the dial sat on the old tile.
    const rows: Array<{ id: string; past: Array<{ recap: string; text: string }> }> = []
    for (const a of await this.host.listAgents()) {
      // Marked as it is ASKED FOR, not as it is sent: the answer is a cloud round trip, and a tick
      // arriving mid-loop would otherwise start a second walk over the same agents.
      if (this.restored.has(a.id)) continue
      this.restored.add(a.id)
      rows.push({ id: a.id, past: await this.host.recentSummaries(a.id) })
    }
    if (!rows.length) return
    return this.queued(async () => {
      for (const row of rows) {
        // Oldest first, so the newest ends up on top of the tile's stack.
        for (const s of [...row.past].reverse()) {
          if (!s.recap && !s.text) continue
          await this.send({ t: 'summary', agentId: row.id, recap: s.recap, text: s.text, restore: true })
        }
      }
    })
  }

  /**
   * The same history, off the critical path.
   *
   * A machine switch owes the person two things and they are not equally urgent: the tile they clicked,
   * NOW, and what every tile was last doing, eventually. `restore: true` says the second one is history —
   * no beep, no notification — so nothing about it is worth a second of staring at the old tile.
   */
  private restoreInBackground(): void {
    if (this.restoring) return
    this.restoring = true
    void this.pushRestores()
      .catch((err) => this.log(`cable: restores failed (${(err as Error).message})`))
      .finally(() => { this.restoring = false })
  }

  /** Attach: tell the dial everything, whether or not any of it looks unchanged from here. */
  async pushAgents(): Promise<void> {
    // A dial that has just greeted us has no history at all — it rebooted, or the cable was out. This is
    // the one place that says so; everywhere else, [restored] is what keeps the link quiet.
    this.restored.clear()
    // Attach owns this walk. Held across the list push so the trigger inside it does not start the same
    // one from the other end and leave the caller awaiting a restore that has nothing left to send.
    this.restoring = true
    try {
      await this.syncMachines(true)
      await this.syncSwarms(true)
      await this.syncAgents(true)
    } finally {
      this.restoring = false
    }
    await this.pushRestores()
    // …and the drawer, which is the one thing a dial that has just greeted us is KNOWN to have lost:
    // its rows live in RAM. Last, because it names agents the pushes above put on the carousel.
    await this.replaceNotifications(this.host.listUnread())
  }

  // ── swarms ────────────────────────────────────────────────────────────────────────────────────────

  private lastSwarmsKey = ''

  /** Push the window's swarms IF they differ from what the dial was last told. Same rule as the wheel:
   *  the diff is what keeps the link idle while nothing changes. */
  async syncSwarms(force = false): Promise<void> {
    return this.queued(() => this.syncSwarmsNow(force))
  }

  private async syncSwarmsNow(force: boolean): Promise<void> {
    const { selected, swarms, tiles } = this.host.listSwarms()
    // `panes` belongs in the key as much as `agents` does. Opening a terminal on a tab that holds no
    // agent moves only the tile count, and a key blind to it would swallow that push and leave the
    // dial showing a tab it still believes is empty — the very row this field exists to keep.
    // The active tab's SHAPE belongs in the key too, and it is the only part of this that can change
    // with no row changing at all: re-arranging four panes moves every tile and leaves the counts
    // exactly where they were, which a key blind to it would swallow — leaving the device drawing the
    // shape the tab used to have.
    const shape = tiles.map((t) => `${t.x1},${t.y1},${t.x2},${t.y2},${t.agentId}`).join(';')
    const key = `${selected}|${swarms.map((s) => `${s.id}:${s.name}:${s.agents}:${s.panes}`).join('|')}|${shape}`
    if (!force && key === this.lastSwarmsKey) return
    this.lastSwarmsKey = key
    this.log(`cable: swarms → ${swarms.length}${selected ? ` (on ${selected})` : ''}${force ? ' [push]' : ''}`)
    // ONE frame, not a begin/row/end stream: two dozen rows of an id, a name and a count fit in a
    // kilobyte, and the dial replaces the whole list on arrival either way.
    await this.send({
      t: 'swarms', selected,
      items: swarms.map((s) => ({ id: s.id, name: s.name, agents: s.agents, panes: s.panes })),
      // Flat quads plus an id, rather than objects: this is read by a C parser on a device, and four
      // numbers in a row cost it nothing to walk.
      tiles: tiles.map((t) => ({ x1: t.x1, y1: t.y1, x2: t.x2, y2: t.y2, a: t.agentId })),
    })
  }

  // ── machines ──────────────────────────────────────────────────────────────────────────────────────

  /** What the dial has been told about the wheel, as one comparable string. Order counts: it is render
   *  order, so two lists that differ only by a swap are a real change. */
  private static machinesKey(machines: CableMachine[], source: string, selected: string): string {
    return `${source}|${selected}|${machines
      .map((m) => `${m.id}:${m.name}:${m.state}:${m.local ? 1 : 0}`)
      .join('|')}`
  }

  /**
   * Push the machine wheel IF it differs from what the dial was last told.
   *
   * The diff is not an optimisation. `ui_local_machine_set` on the dial once rebuilt its wheel on every
   * arriving greeting, on the USB reader task, and that measured out at 31 session restarts an hour with
   * the agent list wiped each time — the screen sat on "0 agents" while the daemon believed it had said
   * otherwise. The dial hashes the rows again on its side; this is the half that stops the bytes leaving.
   */
  async syncMachines(force = false): Promise<void> {
    return this.queued(() => this.syncMachinesNow(force))
  }

  private async syncMachinesNow(force: boolean): Promise<void> {
    const { machines, source } = await this.host.listMachines()
    const selected = this.host.selectedMachine()
    const key = CableSession.machinesKey(machines, source, selected)
    if (!force && key === this.lastMachinesKey) return
    this.lastMachinesKey = key
    this.log(`cable: machines → ${machines.length} (${source})${force ? ' [push]' : ''}`)

    await this.send({ t: 'machines.begin' })
    for (const m of machines) {
      await this.send({ t: 'machine', id: m.id, name: m.name, state: m.state, local: m.local })
    }
    await this.send({ t: 'machines.end', selected, source })
  }

  /**
   * Switch the dial to another machine.
   *
   * Always answered, including for the machine already selected: silence strands the dial on a spinner
   * until its own deadline, which reads as a hang rather than as "done, nothing changed" — the same rule
   * `models.list` follows.
   */
  private async selectMachine(machineId: string): Promise<void> {
    if (!machineId) return
    if (machineId === this.host.selectedMachine()) {
      await this.send({ t: 'machine.selected', machineId })
      await this.syncAgents()
      this.restoreInBackground()
      return
    }
    const result = await this.host.selectMachine(machineId)
    if (!result.ok) {
      this.log(`cable: machine.select ${machineId} refused (${result.code})`)
      await this.send({ t: 'machine.error', machineId, code: result.code, message: result.message })
      return
    }
    this.log(`cable: machine.select → ${machineId}`)
    await this.send({ t: 'machine.selected', machineId })
    // NOT FORCED, and that is the fix for a switch that felt slow at random.
    //
    // Forcing both was right when the carousel showed ONE machine at a time: selecting another machine
    // replaced every tile, so the list and its history had to be re-streamed. The carousel now spans every
    // machine — `listAgentsFlat` reads the same 22 agents whichever row wears the ✓ — so a forced push
    // re-sends a list and a history the dial already has, 55 frames of it, and the `focus` the person is
    // waiting on queues behind them on the wire. Measured: 20 ms to write the focus, 1.7 s to land it.
    //
    // The diff still sends anything that GENUINELY changed, including a machine whose agents have only
    // just arrived in the cache — and [restored] means those, and only those, bring their history along.
    await this.syncAgents()
    await this.syncMachines()   // the ✓ moved: `machinesKey` carries the selection, so this pushes
    this.restoreInBackground()
  }

  /** One row changed — liveness, a rename, a count. Cheaper than re-streaming the wheel. */
  async machineState(machine: CableMachine): Promise<void> {
    await this.send({ t: 'machine.updated', id: machine.id, name: machine.name, state: machine.state, local: machine.local })
  }

  // Turn state is UNSOLICITED: the daemon reports every turn in every agent, including ones started at the
  // keyboard. A dial that only saw answers to its own sends would sit idle through most of what the
  // machine actually does.
  /**
   * `text` is the status line the tile draws — "Working…", the tool that is running, what it is waiting on.
   * It travels because without it the dial gets a card with a state and nothing to render: the tile knows
   * a turn is live and shows the user nothing that says so.
   */
  async turnStarted(agentId: string, text = ''): Promise<void> {
    this.activityEndedAt.delete(agentId)
    const read = {}
    this.activityReads.set(agentId, read)
    await this.send({ t: 'turn.started', agentId, text })
    if (!this.link?.isOpen || !this.host.activityText) { this.activityReads.delete(agentId); return }
    let activity: string | null = null
    try { activity = await this.host.activityText(agentId) } catch { /* unavailable is not a status */ }
    // A terminal capture must never revive a completed turn or overwrite a newer heartbeat.
    if (this.activityReads.get(agentId) !== read) return
    this.activityReads.delete(agentId)
    await this.send({ t: 'turn.activity', agentId, text: activity ?? '' })
  }
  private readonly activityReads = new Map<string, object>()
  private readonly activityEndedAt = new Map<string, number>()
  private readonly activityLabels = new Map<string, string>()
  private activityRefreshAt = 0
  private activityRefreshAgent = ''
  private activityRefreshPending = false

  /** A turn may predate this bridge, or continue through a transcript compaction. */
  private async refreshFocusedActivity(): Promise<void> {
    const agentId = this.desiredFocus
    const link = this.link
    const now = Date.now()
    if (this.stopped || !this.isConnected || !agentId || !this.host.activityText
        || this.activityRefreshPending || this.activityReads.has(agentId)
        || now - (this.activityEndedAt.get(agentId) ?? -Infinity) < 3_000
        || (this.activityRefreshAgent === agentId && now - this.activityRefreshAt < 3_000)) return
    this.activityRefreshAt = now
    this.activityRefreshAgent = agentId
    this.activityRefreshPending = true
    const read = {}
    this.activityReads.set(agentId, read)
    const current = () => !this.stopped && this.isConnected && this.link === link
      && this.desiredFocus === agentId && this.activityReads.get(agentId) === read
    try {
      const activity = await this.host.activityText(agentId)
      if (!current()) return
      // A visible engine footer is direct evidence of work. Recover liveness even
      // when the transcript's turn.started happened before we attached.
      if (activity) await this.send({ t: 'turn.started', agentId, text: activity })
      if (!current()) return
      await this.send({ t: 'turn.activity', agentId, text: activity ?? '' })
      if (this.activityLabels.get(agentId) !== (activity ?? '')) {
        this.activityLabels.set(agentId, activity ?? '')
        this.log(`cable: terminal activity ${agentId}: ${activity || '(no live footer)'}`)
      }
    } catch { /* A capture failure says nothing about whether the turn ended. */ }
    finally {
      if (this.activityReads.get(agentId) === read) this.activityReads.delete(agentId)
      this.activityRefreshPending = false
    }
  }
  async turnDone(agentId: string): Promise<void> {
    this.activityReads.delete(agentId)
    this.activityEndedAt.set(agentId, Date.now())
    await this.send({ t: 'turn.done', agentId })
  }
  /**
   * A finished turn's recap.
   *
   * `quiet` means the window already has this agent on screen: draw the tile,
   * skip the notification drawer (the beep still sounds). `silent` means the
   * turn was a sub-agent's: draw the tile, skip the beep AND the drawer — the
   * main agent's own end is the one the person is waiting for. Extra fields
   * rather than different frames, so firmware that predates them simply
   * notifies as it always did instead of losing the recap.
   */
  async summary(agentId: string, recap: string, text: string, quiet = false, silent = false): Promise<void> {
    this.activityReads.delete(agentId)
    this.activityEndedAt.set(agentId, Date.now())
    recap = extendShortRecap(recap, text)
    const who = this.whoIs(agentId)
    await this.send({ t: 'summary', agentId, ...who, recap, text, ...(quiet ? { quiet: true } : {}), ...(silent ? { silent: true } : {}) })
  }

  /**
   * The name, engine and machine that ride on every `summary` and `question`.
   *
   * The dial holds ONE TAB's agents, and a turn can finish on any of them — the drawer row and the
   * question card for an agent off this tab have nobody to ask but the frame. Sent on every card rather
   * than only the off-tab ones: the dial then has one path, and a tab switch mid-flight cannot strand a
   * card with an id and no name.
   */
  private whoIs(agentId: string): { name: string; engine: string; machine: string } {
    return this.host.describe(agentId) ?? { name: '', engine: '', machine: '' }
  }
  /**
   * Replace the dial's whole drawer with what the window still has unread.
   *
   * Sent once per attach, because that is the one moment the dial is known to have nothing: its rows
   * live in RAM and an OTA, a replug or a flash takes them. Measured on a flash: a turn ended at
   * 17:46:19, the dial came back at 17:46:26, a question arrived at 17:46:28 — and the pill read 1
   * against the window's 2 from then on, with nothing to bring them back together.
   *
   * The window sends ids and kinds; the name, machine and recap are filled in HERE, from what this
   * daemon already knows, so those never have a second source that can disagree.
   */
  async replaceNotifications(
    items: UnreadNotification[],
  ): Promise<void> {
    const replay = { seen: new Set<string>() }
    this.notificationReplay = replay
    const link = this.link
    const rows = await Promise.all(items.slice(0, 8).map(async (item) => {
      const who = this.whoIs(item.agentId)
      // A QUESTION BRINGS ITS OWN WORDS; a finished turn takes the recap this daemon summarised. The
      // dial cannot supply either after a reboot, and a row with neither renders as the word its type
      // used to assume — "done", on a question nobody has answered.
      let summary = item.text
      if (!item.question && summary.trim().length < 20) {
        try {
          const saved = (await this.host.recentSummaries(item.agentId))[0]
          summary = summary ? extendShortRecap(summary, saved?.text ?? '') : saved?.recap ?? ''
        } catch { /* keep the supplied text if history cannot be read */ }
      }
      return { agentId: item.agentId, name: who.name, machine: who.machine, summary, question: item.question,
        ...(notificationReadToken(item.readToken) ? { readToken: item.readToken } : {}) }
    }))
    if (this.notificationReplay !== replay) return
    this.notificationReplay = undefined
    if (this.link !== link || this.stopped) return
    // Reading clears the notice, not the underlying question. Versioned clears
    // cannot eat a newer turn whose history happened to take longer to load.
    await this.send({ t: 'notif.replace', items: rows.filter(row =>
      (row.question || !replay.seen.has(row.agentId)) && !replay.seen.has(`${row.agentId}\0${row.readToken}`)) })
  }

  /**
   * A harness the window has now looked at — drop its drawer row on the dial.
   *
   * The dial's own gesture is a tap, which already reaches the window as
   * `agent.open`. This is the other direction, and without it the two counts
   * separate the moment somebody switches to the tab a notification was about.
   *
   * Fire and forget, like every other card: a dial that predates the message
   * counts it as unknown and drops it, which is the behaviour it has today.
   */
  async agentSeen(agentId: string, readToken?: string): Promise<void> {
    if (!agentId) return
    if (readToken !== undefined && !notificationReadToken(readToken)) return
    this.notificationReplay?.seen.add(readToken ? `${agentId}\0${readToken}` : agentId)
    await this.send({ t: 'notif.seen', agentId, ...(readToken ? { readToken } : {}) })
  }
  async turnError(agentId: string, message: string): Promise<void> {
    this.activityReads.delete(agentId)
    this.activityEndedAt.set(agentId, Date.now())
    await this.send({ t: 'turn.error', agentId, message })
  }
  /**
   * An agent stopped to ask.
   *
   * NO `quiet` HERE, and the reason is that a question is a job rather than news. A summary's `quiet`
   * asks "is somebody looking at this right now" and that is the whole of what a finished turn needed.
   * A question outlives the glance: it is answered or it is not, and until it is answered it is still
   * owed (owner, 2026-09-24).
   *
   * Asking it anyway was self-defeating besides. Showing a question asks the window to bring that agent
   * forward, so by the time anyone could answer "is it on screen" the answer was yes — every question
   * came through quiet, no row was ever recorded, and looking away later left nothing behind.
   */
  async question(agentId: string, id: string, questions: unknown): Promise<void> {
    this.questionInbox.set(agentId, id, questions)
    await this.send({ t: 'question', agentId, ...this.whoIs(agentId), id, questions })
  }

  /**
   * That question is no longer waiting — answered in the app, or in the pane by hand.
   *
   * Carries the id so a dial showing a DIFFERENT question cannot be closed by a stale message: the two
   * screens are minutes apart on a slow question, and closing the wrong one loses an answer the user was
   * halfway through giving.
   */
  async questionClose(agentId: string, id: string): Promise<void> {
    if (!this.questionInbox.close(agentId, id)) return
    await this.send({ t: 'question.close', agentId, id })
  }

  async focusAgent(agentId: string): Promise<void> {
    this.desiredFocus = agentId
    await this.send({ t: 'focus', agentId })
  }

  /**
   * The desktop window moved to an agent — bring the dial with it.
   *
   * ⚠️ THE `desiredFocus` GUARD IS WHAT KEEPS THIS FROM OSCILLATING. The two screens drive each other: the
   * dial's own carousel reports `focus` up, the daemon hands that to the app, the app opens that agent's
   * terminal, and the app opening a terminal is exactly what calls this. Answering it with another `focus`
   * closes the ring. So: say nothing when the record already names that agent.
   *
   * The record is one field written by both sides (see desiredFocus). It used to be two, and the ring
   * closed through the gap between them.
   *
   * The machine comes first when it differs. Sending `focus` for an agent on a machine the dial is not on
   * would name an id its list has never heard of, and the tile it would have to move to does not exist
   * yet — selectMachine is what streams that list.
   */
  async followApp(machineId: string, agentId: string): Promise<void> {
    if (!this.link?.isOpen || this.greetedMac === null) return
    if (!agentId) return

    const generation = ++this.appFocusGeneration
    const task = this.appFocusTail.then(async () => {
      // A newer desktop selection made this queued one obsolete before it started.
      if (generation !== this.appFocusGeneration) return
      this.drivingSince = Date.now()
      this.drivingAppFocus = true
      try {
        if (machineId && machineId !== this.host.selectedMachine()) {
          this.log(`cable: following the app to machine ${machineId}`)
          await this.selectMachine(machineId)
        }
        // A newer selection can arrive while the remote machine RPC/list push is in flight. Never let
        // this older transaction focus after it finishes.
        // Already where the window is: nothing to command. The record is right either way — this is the
        // window FOLLOWING the dial, and the dial's own report wrote it.
        if (generation !== this.appFocusGeneration || agentId === this.desiredFocus) return
        // Said before the frame goes out, not after: the frame itself succeeds either way.
        const unknown = this.host.knows?.(agentId) === false
        this.log(`cable: following the app to agent ${agentId}${unknown ? ' — NOT in this daemon\'s list, the dial has no tile for it' : ''}`)
        this.expectedAppFocusEcho = agentId
        this.expectedAppFocusEchoUntil = Date.now() + APP_FOCUS_SETTLE_MS
        // THE LIST FIRST, THEN THE FOCUS — the fix for "clicking a rail agent that has no tile does not
        // move the dial".
        //
        // A focus names a tile the dial has to CENTRE, and the dial can only centre what its ring walks.
        // The click that brought us here is usually the very thing that changed the ring: opening an
        // agent that had no tile puts it on the desk, and until that list is pushed the dial is still
        // walking a ring where that agent sits off it — where the device drops the focus, by design, with
        // no column to move to. Racing the two produced exactly the reported symptom: mostly it worked
        // (the tick's push arrived first), sometimes it did not, and nothing in either log said which.
        //
        // The record is written BEFORE the push so the re-assert at the end of syncAgents names the agent
        // we are moving to, not the one we are leaving — otherwise the dial visibly steps onto the old
        // tile on its way. Cheap when nothing changed: syncAgents returns without sending a frame.
        this.desiredFocus = agentId
        await this.syncAgents()
        if (generation !== this.appFocusGeneration) return
        await this.focusAgent(agentId)   // writes the record
      } finally {
        this.drivingAppFocus = false
      }
    })
    // Keep the queue usable after one transport failure. The local websocket intentionally
    // fire-and-forgets followApp, so the session log is the only place an unexpected rejection would
    // otherwise be visible; consume it here rather than creating an unhandled rejection.
    this.appFocusTail = task.catch((err) => {
      this.log(`cable: could not follow app focus (${(err as Error).message})`)
    })
    await this.appFocusTail
  }
  async toast(text: string): Promise<void> {
    await this.send({ t: 'toast', text })
  }
}
