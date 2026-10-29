import type { MessageHold } from '../engines/facets/screen.js'
import type { ProductUsageLaunchSignal } from '../lib/productUsageSignals.js'
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import type { PreparedHandoff, HandoffPermit, HandoffOutcome } from '../lib/handoffAuthority.js'
import type { AgentTokenUsage, AgentUsageTarget } from '../lib/agentUsageWire.js'
import type { CloudHarness } from '../lib/cloudAgents.js'
import type { SharedTrustPeer } from '../lib/sharedMachinesPort.js'
import type { GridAssignmentProcess, GridAssignmentAnswer } from '../lib/gridAssignmentWire.js'
/**
 * The boundary the services stand on (docs/design/2026-10-03-harnessd.md, "The core boundary"):
 * `CoreApi` is what a service may ask of the core, and `CorePorts` is what the core asks of services.
 *
 * Both are in process today. When a service moves into a process of its own, its `CoreApi` calls
 * become requests on the local socket and its port becomes a proxy that sends them; the service's
 * code stays as it is. Members are added as services move behind it, each a call that exists today,
 * never a generic `call(name, args)`.
 *
 * The apps reach a service through the requests it answers (`ServiceRequests`), which its start
 * returns. The core routes them to it; a port is only for what the core itself must ask.
 */
import type { RecentTurn } from '../cable/cableHost.js'
import type { NativeTurnRead } from '../lib/nativeTurnObservations.js'
import type { ReviewedAnswer } from '../cable/questionInbox.js'
import type { AgentEngine } from '../engines/types.js'
import type { AppSwarms } from '../cable/cableSession.js'
import type { UnreadNotification } from '../lib/notificationRead.js'
import type { AutonomousDeviceAgent, AutonomousDeviceDelivery, AutonomousDeviceReceipt } from '../lib/autonomous-device/service.js'
import type { StoreAgent } from '../lib/autonomous-device/store.js'
import type { DshLaunchAnswer, DshLaunchRequest, DshMaterializeAnswer, DshMaterializeRequest } from '../dsh/launchWire.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { GridAccess } from '../lib/gridAttach.js'
import type { createHarnessResourcesReader } from '../lib/harnessResources.js'
import type { createHarnessStorageReader } from '../lib/harnessTelemetry.js'
import type { AgentGridTarget, GridAnnotation } from '../lib/gridAnnotation.js'
import { GRID_FLEET_MAX_TIMEOUT_MS } from '../lib/gridFleetProtocol.js'
import type { GridLaunchAnswer, GridLaunchOverride, GridLaunchRequest } from '../lib/gridLaunchWire.js'
import type { NewAgentModel } from '../lib/newAgentModel.js'
import type { LastTurnText, LiveEvent } from '../engines/kit/events.js'
import type { CreationObservation } from '../lib/creationObservation.js'
import type { SessionRecaps } from '../lib/recapReads.js'
import type { SessionInputDelivery } from '../lib/sessionInput.js'
import type { AgentCloseRequest, AgentCloseResult } from '../lib/closeAgentService.js'
import { projectDisplayName, type registry, type RegisteredSession } from '../lib/registry.js'
import type { RuntimeModelOption } from '../lib/runtimeProfile.js'
import { externalUnavailable, type ExternalSessionAnswer, type ExternalSessionRequest } from '../lib/externalSessionWire.js'
import type { SessionSearchIndex } from '../lib/sessionSearch/indexer.js'
import type { StoppedAgentStore } from '../lib/stoppedAgents.js'
import type { TerminalBinaryClear } from '../lib/terminalBinary.js'
import { VIEWER_UP_TYPES } from '../lib/viewerFrames.js'
import type { RouteAnswer } from '../localWsServer.js'
import type { DeviceInputStatus } from './deviceInput.js'
import { FAIL, later, readFallback, ServiceUnavailableError, type PortFallbacks } from './serviceHost.js'

export type { RouteAnswer }
/** What a service guards its own parts with, as the core guards a service (core/serviceHost.ts): the
 *  devices keep a dial failing from costing ⌘K its routing (services/devices.ts). */
export { FAIL, later, readFallback, ServiceUnavailableError, type PortFallbacks }

/** A service may open a terminal with a literal argv, never shell source. */
export interface TerminalOpen {
  argv: string[]
  cwd: string
}
export type TerminalOpenResult = { ok: true; agentId: string } | { ok: false; error: string; detail?: string }
/** What a viewer is shown of a terminal it watches: a frame, or a terminal's bytes (base64 of the local binary
 *  frame, lib/terminalBinary.ts). */
export type TerminalWatchOutput = { type: string; payload: Record<string, unknown> } | { binary: string }
/**
 * A read-only view of agents' terminals for a feature's own viewers (Share's observers, core/terminalWatch.ts):
 * each viewer's terminal frames in (`terminal_open`, `terminal_ack`, …), what it is shown out. Nothing a
 * viewer sends ever reaches a pane.
 */
export interface TerminalWatch {
  frame(viewer: string, type: string, payload: Record<string, unknown>): Promise<void>
  close(viewer: string): Promise<void>
  onOutput(listener: (viewer: string, output: TerminalWatchOutput) => void): () => void
}
export interface TerminalsPort {
  open(request: TerminalOpen): Promise<TerminalOpenResult>
  /** Fresh registry facts for a shell launch receipt, never a service's cached agent snapshot. */
  describe(agentId: string): Promise<Record<string, unknown> | null>
  /** The exact launched engine has exited, with no newer binding replacing the evidence. */
  visitStatus(agentId: string): Promise<{ exited: boolean }>
  watch: TerminalWatch
}
/** A service without the core's launch call must refuse, never launch outside the core; it watches nothing. */
export const TERMINALS_OFF: TerminalsPort = {
  open: async () => ({ ok: false, error: 'SERVICE_UNAVAILABLE' }),
  describe: async () => null,
  visitStatus: async () => ({ exited: false }),
  watch: { frame: async () => {}, close: async () => {}, onOutput: () => () => {} },
}

/** Read-only conversation facts for the handoff in the edge host. Each lookup asks the core now;
 * a stopped record is never replaced by a stale live-agent list in another process. */
export interface ConversationReads {
  publish(prepared: PreparedHandoff, permit: HandoffPermit): Promise<HandoffOutcome>
  /** A live agent by agent/session id, otherwise the stopped record by agent id. */
  resolve(id: string): Promise<RegisteredSession | null>
  recentAsks(sessionId: string, n: number): Promise<string[]>
  lastFullText(sessionId: string): Promise<string | null>
  recaps(sessionId: string, n: number): Promise<string[]>
  /** The core verifies process birth, ownership and deletion; discovery never binds the agent. */
  discover(agentId: string): Promise<{ engine: AgentEngine; sessionId: string; transcriptPath: string | null } | null>
  findTranscript(engine: AgentEngine, sessionId: string, options: { codexHome?: string }): Promise<string | null>
  transcriptOk(engine: AgentEngine, path: string, codexHome: string | null): Promise<boolean>
}

/** No retained record or history, no discovered session and no permission to read a guessed path. */
export const CONVERSATIONS_OFF: ConversationReads = {
  publish: async () => { throw new Error('handoff publication is unavailable') },
  resolve: async () => null,
  recentAsks: async () => [],
  lastFullText: async () => null,
  recaps: async () => [],
  discover: async () => null,
  findTranscript: async () => null,
  transcriptOk: async () => false,
}

export interface UsagePort {
  read(target: AgentUsageTarget): Promise<Record<string, unknown>>
  stop(): void
}
export const USAGE_FALLBACKS: PortFallbacks<UsagePort> = { read: later(FAIL), stop: undefined }

export interface CoreApi {
  /** Last aggregate observation, never a transcript read. Optional for services that do not ask. */
  usage?: (target: AgentUsageTarget) => Promise<AgentTokenUsage | null>
  /** An agent's token totals read from its transcript now, not the cached snapshot (the devices' turn tokens);
   *  null for an agent that is not here or whose engine has no usage. */
  usageFresh?: (agentId: string) => Promise<AgentTokenUsage | null>
  /** The daemon's data folder; a service keeps its own files in it. */
  dataDir: string
  terminals: TerminalsPort
  /** This computer, as the dial's wheel and the fleet name it. */
  machine: {
    /** The account's id for this machine, or '' until the daemon has one (signed out). */
    id(): string
    /** This computer's own durable id. */
    computerId(): string
    /** Its display name, else "This machine". */
    name(): string
  }
  conversations: ConversationReads
  agents: {
    /** Every agent on this machine: the live ones, then the stopped ones. */
    all(): RegisteredSession[]
    /** The live agents. */
    live(): RegisteredSession[]
    /** The name the apps show for an agent. */
    displayName(session: RegisteredSession): string
    /** A live agent, by its agent id. */
    byAgent(agentId: string): RegisteredSession | undefined
    /** A live agent, by its agent id or its engine session id: whichever the apps asked by. */
    resolve(id: string): RegisteredSession | undefined
    /** The live agents the apps are shown. */
    advertised(): RegisteredSession[]
    /** The running cloud harnesses (core/agents/cloud.ts) as rows an agent list reads: an id, a start, an
     *  engine and a name, with no pane, transcript or process. Only the lists that show them ask (the dial,
     *  the fleet); absent where a core or process offers none. */
    cloud?(): RegisteredSession[]
    /** Whether the agent's terminal is attached: a frame without one reads to the apps as "agent gone". */
    terminalAvailable(agentId: string): boolean
    /** Fresh native lifecycle evidence. Absence from a live snapshot alone is
     * not a stop: a saved stopped record must also exist in the core. */
    stopped?(agentId: string): Promise<boolean>
    /** The agent is neither live nor kept as a stopped record: closed by hand, or its record deleted. Only for an agent
     * the caller already knows was created; it does not prove an agent that is still starting is gone. */
    gone?(agentId: string): Promise<boolean>
    /** The exact durable native creation receipt. Null means unavailable, never
     * proof that a launch was missing, cancelled or failed. */
    creationStatus?(creationId: string): Promise<CreationObservation | null>
    /** Send the agent's frame to the apps again. */
    sync(session: RegisteredSession): void
    /** The Model/Effort choices an agent's engine offers (opaque `runtime-v1` ids): one agent's, or
     *  every live agent's when none is named. */
    runtimeModels(agentId?: string): Promise<RuntimeModelOption[]>
    /** The opaque runtime-v1 profile an agent runs with: its model and effort, for a picker's chips. */
    runtimeProfile(session: RegisteredSession): string | null
    /** Switch a live agent's model and effort; nothing without a model. */
    setRuntime(agentId: string, model?: string, effort?: string): void
    /** Fork a live agent, as the window's `agent_fork` does: the new agent's id, or the refusal. */
    fork(agentId: string): Promise<{ ok: true; agentId: string } | { ok: false; error: string; detail?: string }>
    /** Create an agent, as the window's `agent_create` does with no grid, profile or model of its own: the
     *  new agent's id, or the refusal. */
    create(request: AgentCreateRequest): Promise<{ ok: true; agentId: string } | { ok: false; error: string; detail?: string }>
    /** What a live agent's frame says about its harness: its name, its viewer and its verdict; null for none. */
    dsh(session: RegisteredSession): AgentDshContext | null
    /** What a live Claude Code or Codex agent's pane footer says it is doing ("Reading 3 files"), or null:
     *  the dial's working card. The pane is read by the core; only the line leaves it. */
    activityText(agentId: string): Promise<string | null>
    /** `activityText` with the footer's timer, for a Harness Pro. Absent in a
     *  core that cannot read them; the dial then gets the footer alone. */
    activitySnapshot?(agentId: string): Promise<{ text: string; elapsedSeconds?: number } | null>
    /** Whether each of these agents is working now, as this computer's windows are told (core/turns/activity.ts):
     *  Agent Messages tells a shared tab's other accounts. An agent that is not live is left out. */
    activity(agentIds: string[]): Promise<Record<string, 'working' | 'idle' | 'unknown'>>
    /** What each of these agents is doing, in one line of at most 120 characters (core/turns/summaries.ts): the prompt
     *  it is running, or its latest recap line. An agent not live, or with nothing known, is left out. */
    summaries(agentIds: string[]): Promise<Record<string, string>>
    /** Close a harness another agent started (`startedBy: agent`) as `agent_close` closes one: its screen saved, its
     *  process stopped, its conversation kept. `idle` refuses one that works, waits for the person or holds a draft
     *  (`SESSION_NOT_IDLE`); `now` does not. Any other harness is refused (`NOT_AGENT_STARTED`): the agent cleanup
     *  (services/agentCleanup.ts) closes those, and nothing else. Absent where the core does not let a service close. */
    closeStarted?(agentId: string, mode: 'idle' | 'now'): Promise<AgentCloseResult>
    /** Close only the recorded native identity started for a Swarm. Missing live sessions are already gone. */
    closeSwarm?(request: { agentId: string; creationId?: string; sessionId?: string; createdAt?: string; expiresAt?: number }): Promise<AgentCloseResult>
    /** Reopen a Swarm Lead whose session is gone, on its own conversation, as a resume does: nothing is typed into it
     *  (superTabs/host.ts keeps Leads alive). Only an agent stopped here that this machine's Super Tab host keeps as the
     *  Lead of an active project (superTabs/retention.ts); a live one is answered ok. */
    keepLeadAlive?(agentId: string): Promise<{ ok: true } | { ok: false; error: string; detail?: string }>
    /** Close, now and keeping its conversation, a Super Tab member whose session the backend ends (its project deleted,
     *  the agent removed). Only a harness this machine's Super Tab host retains as a member, or one whose exact native
     *  creation receipt [creationId] (the Swarm's start) names it; a gone one is closed. */
    closeMember?(agentId: string, creationId?: string): Promise<AgentCloseResult>
    /** When a live agent's conversation last moved, epoch ms: the latest dated work in its transcript
     *  (lib/transcriptActivity.ts), what the apps' `updatedAt` is when there is one. Null for none live, and for an
     *  engine that keeps no dated transcript: a hook's time or the bind's is not when it last answered. Absent where
     *  the core is not asked it. */
    lastActivity?(agentId: string): Promise<number | null>
  }
  /** A device's or another machine's turns for an agent on this one: the doors the web and the hooks use. */
  turns: {
    /** Deliver text into a live agent. */
    send(agentId: string, text: string): void
    /** Stop a live agent's turn. */
    stop(agentId: string): void
    /** A live agent's last `n` completed turns, newest first. A promise, so that the devices in their own
     *  process ask it of the core when they need it. */
    recent(agentId: string, n: number): Promise<RecentTurn[]>
    /** The person's own last questions to a live agent, newest first. */
    asks(agentId: string): Promise<string[]>
    /** Deliver text into a live agent under a delivery id of the caller's own, as the Wi-Fi device, Agent
     *  Messages and the orchestrator deliver their turns: one path for the three. What becomes of it is heard through
     *  `onDelivery`, under the same id. */
    deliver(agentId: string, text: string, deliveryId: string): void
    /** Take back a delivery not yet being written: true when it was, and it never will be; false for one
     *  the agent's pane is already taking. Answered at once, as the orchestrator reads it in
     *  line: in a service's own process the core is asked and the answer cannot wait, so it is false there,
     *  and a delivery the core did take back is then heard `rejected` (`cancelled`). */
    cancelDelivery(deliveryId: string): boolean
    /** Hear what becomes of each delivery: queued, written, its turn started, refused and why, or past
     *  knowing. Returns how to stop hearing. */
    onDelivery(listener: (event: TurnDelivery) => void): () => void
    /** Replace a service's short-lived permission to write queued typed deliveries.
     * IDs use `team:service:<service>:`; expired or absent permission means wait.
     * This guards the final terminal write even when its authorizing service stops. */
    leaseDeliveries(service: string, leases: Record<string, number>): Promise<boolean>
  }
  questions: {
    /** Answer a live agent's question, keyed by the question keys it asked with. */
    answer(agentId: string, requestId: string, answers: Record<string, string>): void
    /** Answer it with the selections a device reviewed; resolves whether the terminal confirmed it. */
    answerReviewed(answer: ReviewedAnswer): Promise<boolean>
  }
  transcripts: {
    /** How to read a conversation its engine keeps in a database instead of a transcript file;
     *  undefined for every other engine. */
    databaseHistory(session: RegisteredSession): (() => Promise<readonly LiveEvent[]>) | undefined
    /** A session's last turn as its engine recorded it: what was asked and the final answer; null when
     *  there is none yet. Read from the end of its transcript, bounded (core/transcripts/lastTurn.ts). */
    lastTurn(sessionId: string): Promise<LastTurnText | null>
    /** Bounded live prompt/answer observations, starting at a requested cursor.
     * An omitted cursor establishes the current boundary, without past history. */
    nativeTurns?: NativeTurnRead
  }
  /** The sign-in the core holds for every service: a service never holds a credential itself. */
  account: {
    /** The account's private grid name, minted and remembered by the backend; null when an older
     *  backend issues none. Bounded in time. */
    mintGridName(): Promise<string | null>
    /** This machine's harness access token, for handing a sign-in to grid, dialling the fleet's lane or a
     *  dial's spoken words to the transcriber. Rejects when signed out. `force` refreshes it (once, after a
     *  401 for `failedToken`): the core's one session manager shares a refresh in flight with the backend link. */
    accessToken(options?: { force?: boolean; failedToken?: string }): Promise<string>
    /** The fleet's lane to the owner's other machines, sealed by the gateway with this machine's E2EE
     *  identity, which no service holds (`LaneSeal`). */
    lane: LaneSeal
    /** This machine's E2EE identity as Share's owner signs with it, held by the gateway (`ObserverKey`). */
    observerKey: ObserverKey
    /** Shared tabs' keys: rosters and key changes signed with this machine's identity, and the sessions to the
     *  tabs' other machines, held by the gateway (`TabKey`). */
    tabKey: TabKey
    /** Shared tabs' relay: a socket per shared tab, held by the gateway (`TabRelay`); what it hears is
     *  `GatewayEvents.tabFrame`, which the core hands to Agent Messages. */
    tabRelay: TabRelay
    /** The account's connected services, sealed and opened by the gateway for its machines (`ConnectorVault`). */
    connectorVault: ConnectorVault
    /** Whether this computer holds an account: a sign-in or sign-out restarts the daemon. */
    signedIn(): boolean
    /** The account's environment (`prod`, …), which the backend checks every request against. */
    environment(): string
    /** The owner's machines, read from the backend now (`GET /api/machines`, or this computer alone signed
     *  out), and kept as the core's own list for the windows and the trust group. Never rejects. */
    machines(): Promise<{ status: number; body: Record<string, unknown> }>
    /** The account's private grid as the backend named it (`machine_meta`), or as grid's set-up just
     *  confirmed it; null before either. Working it out when neither has said is the models service's
     *  (`lib/gridDerive.ts`). */
    privateGridName(): Promise<string | null>
    /** This machine's name as the account's Machines list shows it (the backend's `machine_meta`); null
     *  until the first one lands. */
    machineName(): string | null
    /** A read or write of the account's backend, signed in by the core (`proxyBackend`): an experiment's
     *  account-wide settings, and Agent Messages' tabs. A failure is an answer: 502, 504, 401. */
    backend(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>
    /** The account signed in here, its id and email, as the backend says it (`GET /api/auth/me`), read by the core's own
     *  sign-in; null while it cannot be read, or by a process that cannot ask (`accountIdentity`). */
    identity(): Promise<AccountIdentity | null>
    /** Hear the account's changes the backend announces (`desk_changed`, …). Returns how to stop hearing. */
    onNotice(listener: (notice: BackendNotice) => void): () => void
  }
  clients: {
    /** An agent's viewer moved: the windows' viewer panes forward to the new one. */
    viewerChanged(agentId: string): void
    /** A frame of a viewer stream for the one connection that opened it (`viewer_response`, `viewer_data`,
     *  `viewer_ack`, `viewer_end`, `viewer_close`): false when it cannot reach that connection. Only those
     *  types; the core drops any other. */
    viewerFrame(connId: string, type: string, payload: Record<string, unknown>): boolean
    /** The account's grid has a name: the models picker answers with it at once. */
    gridNamed(name: string): void
    /** What the models picker lists may have changed (a local model started or stopped, grid set up):
     *  the windows on this computer are pushed the list again (`grid_models_changed`). */
    gridModelsChanged(): void
    /** A harness being installed or updated moved on (`dsh_install_status`): the apps show it in the
     *  create dialog. */
    dshInstallStatus(status: Record<string, unknown>): void
    /** A frame for every window on this computer, as an experiment tells them it changed
     *  (`orchestrator_changed`, `team_changed`); never sent off this computer. */
    windows(frame: { type: string; payload: Record<string, unknown> }): void
    /** A frame for one of Share's observers, sealed by Share itself, to the relay through the gateway; false
     *  when it could not be handed over. */
    observer(connId: string, type: string, payload: Record<string, unknown>): boolean
    /** A frame from the devices for every window on this computer, never the cloud: what a hand at this
     *  desk did. Only `DEVICE_WINDOW_FRAMES`; the core drops any other. */
    sendLocal(frame: DeviceWindowFrame): void
    /** A window bridge's ask, to one window on this computer; false when it is gone. Only
     *  `DEVICE_BRIDGE_FRAMES`. */
    sendToWindow(connId: string, frame: DeviceBridgeFrame): boolean
    /** Whether a window on this computer is attached. */
    hasWindow(): boolean
    /** The devices on this computer changed (`harness_devices_changed`): the windows and the owner's apps
     *  show them. */
    devicesChanged(payload: Record<string, unknown>): void
    /** A dial on this computer is watching it, or no longer is: the core then makes the turn cards and
     *  recaps for it, as for a device watching through the backend. */
    dialWatching(watching: boolean): void
    /** A turn's card for the devices (`commander_event`): its progress, and its recap once it ends. */
    turnCard(frame: TurnCardFrame): void
    /** A turn's recap for the apps (`turn_summary`, or `turn_summary_pending` while one is being cut). */
    turnSummary(frame: TurnSummaryFrame): void
  }
  /** How an agent's shell reaches this daemon: the command that runs this harness's CLI, the port the daemon
   *  serves and the machine it serves as. An experiment writes them into the prompts of the agents it runs
   *  (`… orchestrator --port 18473 --machine …`). */
  daemon: DaemonAddress
  /** The cloud agents' doors into the core (services/cloud.ts): absent from a core or a process that offers them none. */
  cloud?: CloudCore
  /** The Super Tab service's door into the core (superTabs/attention.ts): absent from a core or a process that offers it none. */
  superTabs?: SuperTabsCore
  /** The devices' way to the Super Tab service's `super_tabs` requests, for the Swarm cards alone (`cardsWanted`, `cardRecap`,
   *  `cardOpen`; core/devicesLink.ts refuses any other action): its answer, or SERVICE_UNAVAILABLE. Absent from a core or a
   *  process that offers none. */
  superTabRequest?: (payload: Record<string, unknown>) => Promise<Record<string, unknown>>
  /** The Wi-Fi device's doors into the core (services/wifi.ts): each one call it made when it ran here. */
  wifi: {
    /** What it lists and reads in line (`WifiView`), asked again before each request it answers. */
    view(): Promise<WifiView>
    /** A device's prompt into a live agent, through the pane's write lock, as delivery `deliveryId`. Settles
     *  once the lock has taken it: what it said of the prompt meanwhile is the reply's to carry. */
    submit(agentId: string, text: string, deliveryId: string): Promise<void>
    /** A queued delivery the device no longer stands behind (it was unpaired). */
    cancel(deliveryId: string): void
    /** The agent's transcript shows the device's prompt began its turn: the pane's lock moves on. */
    started(agentId: string, text: string): void
    /** Stop a live agent's turn; resolves whether it stopped. */
    stop(agentId: string): Promise<boolean>
    /** Answer a live agent's question, never a permission dialog; resolves whether the terminal took it. */
    answer(agentId: string, requestId: string, answers: Record<string, string>): Promise<boolean>
    /** Start an agent for an installed Store harness in `cwd`, with the device's fixed, safe launch
     *  arguments; refused when another agent works there. */
    create(packageId: string, engine: string, cwd: string): Promise<ForkResult>
    /** Move the window's focus one agent along the desk, the dial's way; 'no_app' without a window. */
    stepFocus(direction: 'next' | 'previous', currentAgentId?: string): Promise<{ machineId: string; agentId: string } | 'no_agents' | 'no_app'>
    /** A stroke on the device's glass for the window's terminal; false without a window. */
    scroll(phase: 'down' | 'move' | 'up', dy: number, velocity: number): boolean
    /** Ask the window to select an agent (`device_focus`); false without a window. */
    focusApp(agentId: string, expiresAt: number, focusRevision: string): boolean
    /** Ask the window to open the agent a Store preparation made (`device_prepare_open`). */
    reveal(operationId: string, agentId: string): void
    /** An answer or event for one device session, sealed to it by the gateway, if the session is still
     *  that identity's device. */
    send(connId: string, identity: string, type: string, payload: Record<string, unknown>): void
    /** Which identity's app said hello on a session (null: it left): the core counts it as watching. */
    hello(connId: string, identity: string | null): void
    /** A device said hello: what the agents are doing is sent again for it. */
    joined(): void
    /** It is built and serving: the gateway may connect the devices' direct links, which a service that
     *  could not be built would leave unanswered. */
    ready(): void
    /** A device asked to be unpaired, over its session: its pairing goes. */
    unpaired(identity: string): void
    /** The focus revision, as it changes: a window's stale selection is refused against it. */
    focus(revision: string): void
    /** It no longer reads this agent's transcript, as of the `seen`th prompt the core told it of. */
    transcripts(agentId: string, seen: number): void
    /** The agents whose transcripts it reads, said as it starts. */
    watching(agentIds: string[]): void
    /** The agents a device subscribed to: their tools' events are sent too, not only the answer's text. */
    streams(agentIds: string[]): void
  }
}

/** An agent to create, as an experiment asks for one (the orchestrator's Director and specialists). */
export interface AgentCreateRequest {
  engine: AgentEngine
  cwd: string
  /** The harness to create it as, installed here; null for the engine alone. */
  dsh: string | null
  /** The message it opens with, already submitted. */
  prompt: string
  name: string
  bypassPermission: boolean
}

/** See `CoreApi.daemon`. */
export interface DaemonAddress {
  command: string
  port: number
  machineId(): string
  /** The account's environment (`prod`, `staging`, …), as the links a feature makes name it. */
  autonomousEnv: string
}

/**
 * This machine's E2EE identity as Share's owner uses it (sharing/crypto.ts `OwnerKey`): its public half, and
 * the signature on a welcome to one observer of one share. The private half is the gateway's alone; a Share in
 * a process of its own asks for each welcome and holds no credential. Base64 throughout.
 */
export interface ObserverKey {
  publicKey(): Promise<string>
  signWelcome(machineId: string, shareId: string, peer: string, ephemeral: string): Promise<string>
}
/** A process with no key of the core's: it signs nothing. */
export const OBSERVER_KEY_OFF: ObserverKey = {
  publicKey: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  signWelcome: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
}

/** A peer in a shared tab: its machine, and the identity key the roster lists for it, vouched for by the caller. */
export interface TabLink { sharedTabId: string; machineId: string; peerPub: string }
/**
 * Shared tabs' keys, held by the gateway with this machine's E2EE identity
 * (docs/superpowers/specs/2026-10-15-agent-messages-across-accounts-design.md): the owner's signature on a roster
 * and on a move to a new key, and a session per peer machine, keyed by tab and machine. Agent Messages, in the edge
 * host, holds no key and asks for each.
 */
export interface TabKey {
  publicKey(): Promise<string>
  signRoster(sharedTabId: string, version: number, body: string): Promise<string>
  signKeyChange(sharedTabId: string, nextPub: string): Promise<string>
  hello(link: TabLink): Promise<Record<string, unknown>>
  welcome(link: TabLink, payload: Record<string, unknown>): Promise<boolean>
  accept(link: TabLink, hello: Record<string, unknown>): Promise<{ welcome: Record<string, unknown> } | { refused: true }>
  seal(link: TabLink, frame: Record<string, unknown>): Promise<LaneSealed>
  open(link: TabLink, frame: Record<string, unknown>): Promise<LaneOpened>
  drop(link: TabLink): void
}
/** A process with no key of the core's: it signs nothing, starts no session and seals nothing. */
export const TAB_KEY_OFF: TabKey = {
  publicKey: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  signRoster: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  signKeyChange: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  hello: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  welcome: async () => false,
  accept: async () => ({ refused: true }),
  seal: async () => ({ lost: true }),
  open: async () => ({ lost: true }),
  drop: () => {},
}

/**
 * What a shared tab's relay said (gateway/tabRelay.ts, the backend's `/api/agent-messages-ws`), handed on to Agent
 * Messages as it arrived: a frame from one of the tab's machines with who the relay says sent it (`from`, stamped by
 * the relay, never the sender's word), a frame it had nobody to deliver to (`undeliverable`, the machine it was for),
 * the relay admitting this machine (`ready`, sent again after each redial), or the socket closed for good (`closed`:
 * 4403 when this machine is not in the tab, 4409 when another socket of it took the tab over).
 */
export interface TabFrame {
  sharedTabId: string
  from?: { machineId: string; userId: string }
  payload?: Record<string, unknown>
  undeliverable?: string
  closed?: { code: number; reason: string }
  ready?: true
}
/**
 * Shared tabs' relay, held by the gateway (gateway/tabRelay.ts): one long-lived socket per shared tab, which carries
 * frames already sealed between the tab's machines (`TabKey`). What it hears comes back as `GatewayEvents.tabFrame`.
 */
export interface TabRelay {
  /** Keep a socket to the shared tab's relay open (idempotent). */
  open(sharedTabId: string): Promise<void>
  /** Send a frame to a machine of the shared tab; false when no socket is open for the tab. */
  send(sharedTabId: string, to: string, payload: Record<string, unknown>): Promise<boolean>
  /** Close the tab's socket and stop reconnecting. */
  close(sharedTabId: string): void
}
/** A process with no relay of the core's: it opens nothing and sends nothing. */
export const TAB_RELAY_OFF: TabRelay = { open: async () => {}, send: async () => false, close: () => {} }

/**
 * The account's connected services sealed for its machines (lib/e2ee/connectorVault.ts), by the gateway,
 * which holds this machine's identity and reads the device key log: `seal` makes an envelope for every
 * machine of the account's log (not suspended, not pending), `open` reads one only if such a machine
 * signed it, and answers null otherwise. `complete` says it was sealed for every such machine: one that
 * is not misses a machine added since, and is sealed again. The envelope is opaque JSON for the backend.
 */
export interface ConnectorVault {
  seal(plaintext: string): Promise<Record<string, unknown>>
  open(envelope: unknown): Promise<{ plaintext: string, complete: boolean } | null>
}
/** A process with no key of the core's: it seals and opens nothing. */
export const CONNECTOR_VAULT_OFF: ConnectorVault = {
  seal: () => Promise.reject(new Error('no key: this process holds no E2EE identity')),
  open: async () => null,
}

/** A service in its own process that acts on no agent: it creates none and reads no harness's frame. */
export const AGENT_ACTIONS_OFF: Pick<CoreApi['agents'], 'create' | 'dsh'> = {
  create: async () => ({ ok: false, error: 'SERVICE_UNAVAILABLE' }),
  dsh: () => null,
}

/** The account signed in here, as Agent Messages' shared tabs name their owner and members by it. */
export interface AccountIdentity { accountId: string; email: string }

/**
 * The account signed in here, read once through the core's own sign-in (`GET /api/auth/me`): a sign-in to another
 * account starts a new core, so what it read stays true. Asked again after a read that failed or said nothing usable.
 * Read by the core rather than by Agent Messages in its process, which may call only `MESSAGES_BACKEND_ROUTES`.
 */
export function accountIdentity(backend: CoreApi['account']['backend']): () => Promise<AccountIdentity | null> {
  let known: AccountIdentity | null = null
  return async () => {
    if (known) return known
    const reply = await backend('GET', '/api/auth/me').catch(() => null)
    const data = reply?.status === 200 && reply.body.success === true ? reply.body.data as { user?: Record<string, unknown> } | undefined : undefined
    const user = data?.user
    if (typeof user?.id !== 'string' || !user.id || typeof user.email !== 'string' || !user.email) return null
    known = { accountId: user.id, email: user.email }
    return known
  }
}

/** The account as a service that reads no backend, hears no notice and signs nothing has it. */
export const ACCOUNT_BACKEND_OFF: Pick<CoreApi['account'], 'backend' | 'identity' | 'onNotice' | 'observerKey' | 'tabKey' | 'tabRelay' | 'connectorVault'> = {
  backend: async () => ({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } }),
  identity: async () => null,
  onNotice: () => () => {},
  observerKey: OBSERVER_KEY_OFF,
  tabKey: TAB_KEY_OFF,
  tabRelay: TAB_RELAY_OFF,
  connectorVault: CONNECTOR_VAULT_OFF,
}

/** Where a service that was never told runs this daemon from: the installed CLI, on no port it knows. */
export const DAEMON_UNKNOWN: DaemonAddress = { command: 'harness', port: 0, machineId: () => '', autonomousEnv: 'prod' }

/** What became of a delivered turn (`turns.deliver`), as the core's input says it: `queued`, written
 *  (`delivered`), its turn `started`, `rejected` with why, or `unknown`. `sessionId` is the agent it was
 *  delivered to, as the delivery named it. */
export type TurnDelivery = SessionInputDelivery

/** The delivery members of a core that delivers nothing for this service: nothing is written, nothing is
 *  taken back, and nothing is heard. */
export const DELIVERIES_OFF: Pick<CoreApi['turns'], 'deliver' | 'cancelDelivery' | 'onDelivery' | 'leaseDeliveries'> = {
  deliver: () => {},
  cancelDelivery: () => false,
  onDelivery: () => () => {},
  leaseDeliveries: async () => false,
}

/** A turn's card for the devices: the dial's and the Wi-Fi device's tiles and their notifications. */
export type TurnCardFrame = {
  type: 'commander_event'
  agentId: string
  dbSessionId: string
  name?: string
  payload: Record<string, unknown>
}
/** A turn's recap for the windows and the phone. */
export type TurnSummaryFrame = { type: 'turn_summary' | 'turn_summary_pending' } & Record<string, unknown>
/** The frame types `clients.turnCard` and `clients.turnSummary` carry: the core sends no other for them. */
export const TURN_CARD_TYPES: ReadonlySet<string> = new Set(['commander_event'])
export const TURN_SUMMARY_TYPES: ReadonlySet<string> = new Set(['turn_summary', 'turn_summary_pending'])

/** `agents.resolve` over a service process's own copy of the agents, as the registry answers it: by agent
 *  id, then by engine session id (an agent with none yet is never found by an empty one). */
export function resolveAgent(agents: readonly RegisteredSession[], id: string): RegisteredSession | undefined {
  return agents.find((agent) => agent.agentId === id) ?? (id ? agents.find((agent) => agent.sessionId === id) : undefined)
}

/** Who sent a request, as the core established it. A service trusts this, never a field of the
 *  payload: a payload says whatever its sender wrote. */
export interface Asker {
  /** A process on this machine (the desktop app, `hn`, a script), over the local socket. */
  local: boolean
  /** Whether it may control this machine: a local process, a paired app, or a verified machine share.
   * A device or an observer may not. Account-backed services also check accountOwner. */
  owner: boolean
  /** Authority to use the host account, separately from control of a shared machine.
   * Established by the gateway's pairing record, never by the request payload.
   * Absent in older transports; a local owner remains authoritative. */
  accountOwner?: boolean
  /** A guest's session (RemoteClient.guest): the account it is shared with. Never `owner`. */
  guest?: string
  /** Another of the owner's machines, when the request came over that machine's own link: its id as its pairing
   *  record holds it, and the label it was paired under. Set by the core from the gateway's record, never the payload. */
  machine?: { machineId: string; label: string | null }
  /** The connection it came over (a window's, a remote client's), as the core names it, and the id it
   *  asked under: what a service keys work by that belongs to one connection (the Model Manager's grid
   *  commands, which a cancel on the same connection stops; a limit on how many at once per connection).
   *  The handler hears that connection close through `closed`. Absent when the core itself asks, and from
   *  a core from before it was given: then the request is its own connection. */
  connection?: string
  requestId?: string
}

/**
 * A request a service answers for the apps: the reply, or a promise of it. A throw or a rejection is
 * answered `SERVICE_FAILED` by the host and counted against the service.
 *
 * `closed` is aborted when the connection that asked closes (`Asker.connection`), or when the core that
 * routed it goes: nobody is left to read the answer, so the work for it may stop. A handler that ignores
 * it runs to the end, as every one did before it was given; one called without it (a spec, a wrapper)
 * is never told.
 */
export type ServiceRequest = (payload: Record<string, unknown>, asker: Asker, closed?: AbortSignal) => Record<string, unknown> | Promise<Record<string, unknown>>

/** The requests a service answers, by frame type: what its start returns. */
export type ServiceRequests = Readonly<Record<string, ServiceRequest>>

/*
 * The requests each service answers for the apps, declared here rather than in the service's own module.
 * The core routes them, and answers them SERVICE_UNAVAILABLE while their service is off, from these
 * lists alone: a service that runs in its own process is never loaded into the core's to learn them
 * (docs/design/2026-10-06-core-boundary-next.md, "The target, and its test"). Its module re-exports its own.
 */

/** Session search (services/search.ts). */
export const SEARCH_REQUESTS = ['session_search', 'session_tail'] as const
/** The Harness Store (services/store.ts). */
export const STORE_REQUESTS = ['dsh_list', 'dsh_install', 'dsh_update', 'dsh_remove'] as const
/** Account usage (services/usage.ts). */
export const USAGE_REQUESTS = ['usage_read'] as const
/** The machine monitor (services/monitor.ts). */
export const MONITOR_REQUESTS = ['machine_resources'] as const
/** Memories (services/memory.ts), an experiment: what this machine's agents remember, for the owner's Memories
 *  panes on their other machines, and the About You profile and its on/off choice from them. */
export const MEMORY_REQUESTS = ['memory_snapshot', 'memory_about_put', 'memory_deliver'] as const
/** The router (services/router.ts), an experiment: where a task a person typed or said should go, decided for
 *  the client that asks, which acts on it. */
export const ROUTER_REQUESTS = ['route_decide'] as const
export const SUPER_TAB_REQUESTS = ['super_tabs'] as const
export interface SuperTabsPort { connected(): void; disconnected(): void; stop(): void; swarmRole(harnessId: string): Promise<import('../lib/swarmSkills.js').SwarmSkillGrant | null | undefined> }
export const SUPER_TAB_FALLBACKS: PortFallbacks<SuperTabsPort> = { connected: undefined, disconnected: undefined, stop: undefined, swarmRole: later(undefined) }
/** The project and folder readers (services/projects.ts). */
export const PROJECTS_REQUESTS = ['git_pull_request', 'git_pull_requests_status', 'git_project_info', 'scm_project_info', 'project_preview', 'fs_list_dir', 'agent_read_file'] as const
/** A window's name for its repo and its work, by a small model in the background (services/windowNames.ts). */
export const WINDOW_NAMES_REQUESTS = ['window_name'] as const
/** Change agent's handoff file, prepared in the edge host (services/handoff.ts). */
export const HANDOFF_REQUESTS = ['agent_handoff_prepare', 'agent_handoff_complete'] as const
/** Connected services for every local agent, and their MCP bridge, in the edge host (services/connectors.ts). */
export const CONNECTORS_REQUESTS = ['connectors'] as const
/** Sharing this machine with other accounts, and adding machines shared with this one, in the edge host
 *  (services/sharedMachines.ts). */
export const SHARED_MACHINES_REQUESTS = ['shared_machines', 'guest_folders'] as const

/** What the core asks to start a guest's harness: whose (the email the gateway named the session by), which
 *  engine, and whether it works without asking for each command. */
export interface GuestLaunchInput { email: string; engine: string; bypassPermission: boolean; prompt?: string
  /** The engine's own flags for the permission mode asked for (lib/engineLaunch.ts `permissionModeFlags`), as an
   *  owner's launch passes them; absent, `bypassPermission` alone decides. */
  permissionFlags?: string[]
  /** A folder the owner shares to start in; the guest's workspace when absent or not shared. */
  cwd?: string }
/** A guest's harness as shared machines builds it (services/guestLaunches.ts): the pane's command, which runs
 *  the engine as the guest's own OS user on the owner's subscription, the variables to set on the pane, and
 *  `workspace`, where it starts (the guest's workspace or a folder the owner shares). The core opens it and
 *  records whose it is (core/agents/guestCreate.ts). */
export type GuestLaunch =
  | { ok: true; workspace: string; argv: string[]; env: Record<string, string> }
  | { ok: false; error: string; detail?: string }

/** The core's call into shared machines: a guest's launch (docs/plans/2026-10-19-guest-machine-sharing-plan.md). */
export interface SharedMachinesCorePort {
  guestLaunch(input: GuestLaunchInput): Promise<GuestLaunch>
  /** The service stopping: its subscription relay closes. */
  stop(): Promise<void> | void
}

/** What a guest's New Harness is told while shared machines is off or failing. */
export const GUEST_LAUNCH_UNAVAILABLE: GuestLaunch = {
  ok: false, error: 'GUEST_UNAVAILABLE', detail: 'Sharing isn\'t running on this computer right now. Try again in a moment.',
}
export const SHARED_MACHINES_FALLBACKS: PortFallbacks<SharedMachinesCorePort> = { guestLaunch: later(GUEST_LAUNCH_UNAVAILABLE), stop: undefined }
/** What the core calls while `ports.sharedMachines` is null. */
export const SHARED_MACHINES_OFF: SharedMachinesCorePort = { guestLaunch: async () => GUEST_LAUNCH_UNAVAILABLE, stop: () => {} }
/** A Harness OS computer managed from the owner's phone: whether it runs Harness OS, its update, and its Wi-Fi,
 *  in the edge host (services/osDevice.ts). */
export const OS_DEVICE_REQUESTS = ['os_device'] as const
/** Add-ons for a device that is this Harness machine (lib/autonomous-device/machineAddons.ts): the owner's machines
 *  read what it published and propose to it, each proposal stamped with the machine it came from. */
export const MACHINE_ADDON_REQUESTS = ['machine_addon'] as const
/**
 * Models (services/models.ts).
 *
 * The Model Manager's grid commands, `grid_fleet_run` and `grid_fleet_cancel`, are among them: a command
 * is a job of the connection that started it, and a cancel stops only that connection's own
 * (`lib/gridFleetRpc.ts`), keyed by the connection and request id the core gives every request
 * (`Asker`). Their handshake, `grid_fleet_capabilities`, is still the socket's: the Grid harness runs a
 * command only after it and reads an answer without its protocol as "update Harness", which a models
 * service that is down must not make it say.
 * The saved APIs and the Codex profiles came out of the socket's switch (launchTargetRequests).
 */
export const MODELS_REQUESTS = [
  'grid_models_list', 'models_list',
  'grid_fleet_models_list', 'grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop',
  'grid_fleet_run', 'grid_fleet_cancel', 'grid_swarm_sync', 'grid_swarm_api_share', 'grid_swarm_api_shares', 'grid_swarm_offer', 'grid_swarm_offers', 'grid_swarm_heal',
  'api_connections', 'codex_profiles_list', 'codex_profile_link',
] as const

const MINUTE = 60_000

/**
 * How long the core waits on a service in a process of its own for these answers before it answers
 * SERVICE_UNAVAILABLE, where the half minute it gives any other would cut short what they do
 * (core/serviceLinks.ts). By service, then by request or port call. A wait that runs out answers the
 * asker; the work itself goes on in the service's process.
 *
 * - A grid command runs as long as its caller asked, up to half an hour (`GRID_FLEET_MAX_TIMEOUT_MS`).
 * - Grid's set-up installs `grid` on first use (its installer is given ten minutes, `gridInstall.ts`),
 *   hands it this machine's sign-in and makes the account's grid: a Set up, a Get, a Use, `ensure` and
 *   a move onto a grid model (`moveTarget`) each wait for it.
 * - A launch target, the private grid's name and the lists each run a few `grid` calls of up to 30 s.
 * - The Store's install and update set up a harness's toolchain: minutes.
 *
 * A grid or saved-API launch (`gridLaunch`) is built from what models has in hand, and a saved API's target
 * (`apiTarget`) reads its model list for at most 15 s (lib/apiModels.ts): both take the half minute, which bounds
 * how long a launch on one can wait. A launch on the engine's own login asks models nothing.
 */
export const LONG_ANSWERS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  // Fifty GitHub reads, four at a time, each with an eight-second subprocess deadline.
  projects: { git_pull_requests_status: 120_000 },
  // The device's own service waits up to 20 s for its next proposal (lib/autonomous-device/machineAddons.ts).
  machineAddons: { machine_addon: 30_000 },
  models: {
    grid_fleet_run: GRID_FLEET_MAX_TIMEOUT_MS + MINUTE,
    grid_fleet_models_list: 15 * MINUTE, grid_fleet_model_download: 15 * MINUTE, grid_fleet_model_start: 15 * MINUTE,
    ensure: 15 * MINUTE, moveTarget: 15 * MINUTE,
    launchTarget: 3 * MINUTE, privateGridName: 2 * MINUTE, lists: 2 * MINUTE,
  },
  store: { dsh_install: 30 * MINUTE, dsh_update: 30 * MINUTE, dshMaterialize: 6 * MINUTE },
  // A cloud agent's maker answers on its own time: Fo's reply waits 40 s, and a busy Fo is retried for half a
  // minute more. A wait shorter than that said "not running" of words that were then sent anyway.
  cloud: { create: 3 * MINUTE, deliver: 3 * MINUTE, answer: 3 * MINUTE, stopHarness: 2 * MINUTE, cloud_send: 3 * MINUTE },
  // A guest's first harness makes their OS account (`dscl`, a home); turning guest access on waits on the
  // owner at the admin prompt, which gives up after ten minutes (lib/guestHelperInstall.ts).
  sharedMachines: { guestLaunch: 2 * MINUTE, shared_machines: 11 * MINUTE },
}

/** The orchestrator (services/orchestrator.ts): its projects, for the apps and for the agents it runs. */
export const ORCHESTRATOR_REQUESTS = ['orchestrator'] as const
/** Share (services/sharing.ts): an owner's shares of a harness, their links and their comments; and the observers
 *  shared tabs want for this computer's harnesses, derived again from their rosters (`harness_share_rosters`, which
 *  Agent Messages asks through the core as a roster changes, core/messagesLink.ts `observers`). */
export const SHARE_REQUESTS = [
  'harness_share_list', 'harness_share_invite', 'harness_share_remove', 'harness_share_link',
  'harness_share_comments', 'harness_share_comment_post', 'harness_share_comment_remove', 'harness_share_rosters',
] as const

/** Agent Messages (services/messages.ts, messages/service.ts): from `harness send` in an agent's pane, from the
 *  owner's other machines and from the windows. A service in the edge host since 2026-10-12, no longer an
 *  experiment: its own process cost every computer it was on 62 MiB at idle for a few MiB of messaging. */
export const MESSAGES_REQUESTS = ['agent_messages'] as const

/** Cloud agents (services/cloud.ts, cloud/service.ts): a cloud harness's conversation for its chat pane, and
 *  which cloud agents are connected here, for New Harness. */
export const CLOUD_REQUESTS = ['cloud_transcript', 'cloud_send', 'cloud_agents'] as const

/**
 * What Agent Messages in a process of its own may do through the core, and nothing more (core/messagesLink.ts
 * answers it, and checks each): the agents as the apps are shown them (`shown`) and how an agent's shell reaches
 * this daemon (`daemon`), which its roster and its `harness send` read; the account signed in here (`account`, its id
 * and email, which the core reads: `accountIdentity`); the account's backend, only the routes of
 * `MESSAGES_BACKEND_ROUTES` (`backend`): its tabs and their leaders, and shared tabs' shares, rosters, invitations, members and moves; its
 * log's change notice for the windows (`windows`, only `MESSAGES_WINDOW_FRAME`); which of its typed deliveries may be
 * written (`writable`); and shared tabs' keys, which the gateway holds (`tab_key`, one `TabKey` method a call,
 * lib/tabKeyWire.ts), and their relay, whose sockets the gateway holds too (`tab_relay`, one `TabRelay` method a call,
 * lib/tabRelayWire.ts); and that a shared tab's roster changed here (`observers`), which the core hands to Share as
 * `harness_share_rosters`, so that a member removed stops watching this computer's harnesses at once. It writes turns into agents (core/deliveries.ts, `TURN_DELIVERERS`) and hears the account's
 * `desk_changed`. The questions the experiment asked are answered as they were, so a core of either version answers
 * the process of the other (harnessd/services.ts); a core from before `account` answers it `UNKNOWN_QUERY`, and shared
 * tabs are then unavailable while the rest of Agent Messages runs on.
 */
export const MESSAGES_QUERIES = ['writable', 'shown', 'daemon', 'account', 'backend', 'windows', 'tab_key', 'tab_relay', 'observers', 'activity'] as const
/** Each id as the backend makes it: a shared tab's (24 hex), a desk tab's, an invitation's (a UUID) and an account's. */
const SHARED_TAB = '[a-f0-9]{24}', DESK_TAB = '[A-Za-z0-9_-]{1,64}', USER = '[A-Za-z0-9_-]{1,128}'
const INVITE = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
const route = (method: string, path: string) => ({ method, path: new RegExp(`^/api/agent-messages${path}$`) })
/**
 * The backend routes Agent Messages in its process may call through the core's sign-in (`backend`), by method and
 * whole path, and no others (backend/src/routes/agentMessages.ts). Its process holds no credential: the core signs
 * each call, so a route left open here is a route any code in that process could call as the account. Anchored, and
 * each id held to the shape the backend gives it, so that no path climbs out (`..`), carries a query or names another
 * route. Shared tabs' were refused by the one GET this allowed before, which left every share action failing in the
 * edge host, where Agent Messages runs.
 */
export const MESSAGES_BACKEND_ROUTES: ReadonlyArray<{ method: string; path: RegExp }> = [
  route('GET', ''),
  route('GET', '/shares'),
  route('PUT', `/shares/${DESK_TAB}/roster`),
  route('POST', `/shares/${SHARED_TAB}/invites`),
  route('GET', '/invites'),
  route('DELETE', `/invites/${INVITE}`),
  route('POST', `/invites/${INVITE}/accept`),
  route('DELETE', `/shares/${SHARED_TAB}/members/${USER}`),
  route('DELETE', `/shares/${SHARED_TAB}`),
  route('POST', `/shares/${SHARED_TAB}/move`),
  // A desk tab's setting: its leader, which the person chooses for a shared tab from any computer of the account
  // (sharedTabs.ts `setLeader`). The computer that shares the tab signs the roster that follows it.
  route('PATCH', `/tabs/${DESK_TAB}`),
]
/** Whether Agent Messages in its process may make this backend call (`MESSAGES_BACKEND_ROUTES`). */
export const messagesBackendAllowed = (method: unknown, path: unknown): boolean =>
  typeof method === 'string' && typeof path === 'string' && MESSAGES_BACKEND_ROUTES.some((r) => r.method === method && r.path.test(path))
export const MESSAGES_WINDOW_FRAME = 'messages_changed'
/** Shared tabs changed on this computer (a roster, an invitation, an alert, a notice, a waiting request or the
 *  untrusted list): the windows read `shares` again. Only a revision: what changed is read, never pushed. */
export const SHARED_TABS_WINDOW_FRAME = 'shared_tabs_changed'
/** Another account's harness in a shared tab started or stopped working (messages/tabActivity.ts). */
export const SHARED_ACTIVITY_WINDOW_FRAME = 'shared_activity'
/** What Agent Messages may tell this computer's windows (core/messagesLink.ts `windows`), and nothing else. */
export const MESSAGES_WINDOW_FRAMES: readonly string[] = [MESSAGES_WINDOW_FRAME, SHARED_TABS_WINDOW_FRAME, SHARED_ACTIVITY_WINDOW_FRAME]

/**
 * The experiments: services that cost nothing until they are on (docs/design/2026-10-06-core-boundary-next.md,
 * "Experimental features: move only"). Each runs in a process of its own that the master starts only once the
 * core asks for it (harnessd/services.ts `onDemand`): when one of its `requests` arrives, or at start when its
 * saved `state` is in the data folder (paths under it; `dir/*.ext` for a file of that kind in that folder).
 * Off, it has no process and none of its code is loaded anywhere. Each may act on the core through the hooks
 * an experiment has (core/experimentQueries.ts, core/deliveries.ts), and no other process may.
 *
 * Adding one: its service (`start<Name>(core, ports)`, returning its requests' handlers) and its process's
 * runner (`SERVICE_RUNNERS`, src/serviceProcess.ts); its process (`SERVICE_HOSTS`, `onDemand: true`); its
 * entry here; and its start for the core's own process (services/inline.ts `EXPERIMENT_STARTS`). Removing
 * one is deleting those.
 */
export const EXPERIMENTS: Readonly<Record<string, { requests: readonly string[]; state: readonly string[] }>> = {
  orchestrator: { requests: ORCHESTRATOR_REQUESTS, state: ['orchestrator/*.json'] },
  // Its invitations and links: a harness was shared from here. Or a shared tab held here (Agent Messages' file): the
  // observers its members are granted are derived and renewed by Share, and taken back once one leaves.
  sharing: { requests: SHARE_REQUESTS, state: ['harness-shares.json', 'harness-collaboration.json', 'agent-messages/shared-tabs.json', 'super-tabs/host-*.json'] },
  // Request-only, on from its first request until the daemon stops: another machine's Memories pane asks, and
  // the package's own files are its state.
  memory: { requests: MEMORY_REQUESTS, state: [] },
  // Request-only too: it keeps nothing, and asks Jev only when a client asks it.
  router: { requests: ROUTER_REQUESTS, state: [] },
  superTabs: { requests: SUPER_TAB_REQUESTS, state: ['super-tabs/host-*.json'] },
  // Cloud agents. Its harnesses: one was started here, and is watched again as the daemon starts. A New Harness
  // for one, an answer or a message to one wakes it too (its port's calls, core/agents/cloud.ts).
  cloud: { requests: CLOUD_REQUESTS, state: ['cloud/harnesses.json'] },
}

/** The services that may write turns into agents from a process of their own (core/deliveries.ts): the experiments,
 *  and Agent Messages, which left them for the edge host and still types a message into an idle agent. No other
 *  process may: writing into a pane is no other service's to ask. */
export const TURN_DELIVERERS: readonly string[] = [...Object.keys(EXPERIMENTS), 'messages']

/** The core's calls into Share: an observer's frame as the relay handed it over, the relay gone (every observer
 *  with it), and stopping it. */
export interface SharingPort {
  observer(connId: string, type: string, payload: Record<string, unknown>): Promise<void> | void
  linkDown(): void
  stop(): Promise<void> | void
}

/** What the core gets when Share fails: an observer's frame goes unanswered, as it would to a daemon without
 *  Share, and a shutdown goes on. */
export const SHARING_FALLBACKS: PortFallbacks<SharingPort> = { observer: undefined, linkDown: undefined, stop: undefined }

/** What an agent is to the orchestrator's projects: a specialist (`worker`), or a project's Director, and
 *  whether work is still out under it. */
export type OrchestratorRole = { role: 'worker' } | { role: 'director'; busy: boolean }

/** The core's calls into the orchestrator: what an agent is to its projects, asked at every turn's end
 *  (core/turns/recaps.ts), the frames the apps are sent, which its projects read their Directors' turns
 *  from, and stopping it. */
export interface OrchestratorPort {
  roleOf(agentId: string): OrchestratorRole | null
  frame(frame: Record<string, unknown>): void
  stop(): void
}

/** What the core gets when the orchestrator fails: no agent is a specialist or a Director, so every turn's
 *  end is announced; no project hears a frame; a shutdown goes on. */
export const ORCHESTRATOR_FALLBACKS: PortFallbacks<OrchestratorPort> = { roleOf: null, frame: undefined, stop: undefined }

/** The core's calls into session search: index a session at its turn boundaries, forget a purged
 *  conversation, the title it indexed for one being adopted, and stopping its sweeps. The apps' own
 *  requests (`session_search`, `session_tail`) are its `ServiceRequests`, not the core's calls. */
export type SearchPort = Pick<SessionSearchIndex, 'touch' | 'deleteHistory' | 'session' | 'stop'> & {
  inspect(request: ExternalSessionRequest): Promise<ExternalSessionAnswer>
}

/** What the core gets when search fails: nothing indexed and no title. */
export const SEARCH_FALLBACKS: PortFallbacks<SearchPort> = {
  touch: undefined, deleteHistory: undefined, session: undefined, stop: undefined, inspect: later(externalUnavailable()),
}

/*
 * Recaps (services/recaps.ts): each turn's recap, the devices' turn cards and the notifications a finished
 * turn rings, built from the turn's lifecycle. The core tells the recaps that lifecycle as it happens and
 * never waits on them: a session runs the same without them, and a turn they miss simply has no recap.
 */

/** A session as the core knows it when it tells the recaps something: what a card is addressed to. */
export interface RecapSession {
  sessionId: string
  /** The agent that owns it: a card is addressed to the agent, stable across a `/clear`. */
  agentId: string
  /** Its display name, which a summary card carries for a machine whose tile is not loaded. */
  name?: string
  /** Its engine (`claude`, `codex`, …): what a finished turn's tier is decided with (lib/notifyTier.ts). */
  engine?: string
  /** Its transcript: a Claude sub-agent writes its own beside it, which a held turn end watches. */
  transcriptPath?: string
  /** An Orchestrator specialist's turn, or its director's while specialists are out: nobody's news. Said
   *  where a turn ends, a cancel or a forget (reading it reads the orchestrator); absent, the recaps keep
   *  what they were last told. */
  subagent?: boolean
}

/** Who watches this machine's turn cards: a device at all (through the backend or on the cable), and one
 *  rendering this machine right now. `remote`: an app away from this desk (the phone, a browser) holds a session
 *  over the relay, and hears how loudly each turn ends (`turn_summary`'s `tier`); absent from an older core. */
export interface RecapWatchers { device: boolean; active: boolean; remote?: boolean }

/** The turn lifecycle, as the core tells the recaps. */
export type TurnLifecycle =
  /** A session's events (a turn started, its text, its tools and sub-agents, its end), as one batch. */
  | { kind: 'events'; session: RecapSession; events: LiveEvent[]; replay: boolean }
  /** The core's five-second turn heartbeat, and whether the turn is verifiably working right now. */
  | { kind: 'beat'; session: RecapSession; working: boolean }
  /** The turn was cancelled: no turn end comes. */
  | { kind: 'cancelled'; session: RecapSession }
  /** The session was unbound, or its agent removed; what is stored for it is kept for a resume. */
  | { kind: 'forgotten'; session: RecapSession }
  /** The engine's Stop hook: it stopped writing. */
  | { kind: 'stopped'; sessionId: string }
  /** The agent's conversation moved to a new session (a `/clear`, a fork's first turn): its recaps follow. */
  | { kind: 'rebound'; from: string; to: string }
  /** The conversation was purged: everything stored for it goes. */
  | { kind: 'purged'; sessionId: string }
  /** A question was put to the person, or answered: a turn waiting on one is not announced as done. */
  | { kind: 'asked' | 'answered'; sessionId: string; requestId: string }
  /** A device joined: every session's card is said again. `working`: the sessions whose turn is
   *  verifiably working now, whose busy card is said with it. */
  | { kind: 'rejoined'; working: string[] }
  /** The session attached with its last turn already over, so its end was read as history: recapped quietly
   *  if it has none yet (it ended while the daemon was stopped). */
  | { kind: 'settled'; session: RecapSession }

/** The core's calls into the recaps: the lifecycle, and what they hold of a session, read in line. */
export interface RecapsPort {
  /** Something happened to a turn. A notice: the core never waits for it, and one the recaps miss costs
   *  that turn its recap, nothing else. */
  lifecycle(event: TurnLifecycle, watchers: RecapWatchers): void
  /** A session's last turns and asks, and whether its card is busy; null when they hold nothing. */
  recaps(sessionId: string): SessionRecaps | null
  /** The cards of every turn still working or being recapped, for a dial that just attached: asked when it
   *  attaches and sent when they come, never waited for in line. */
  liveCards(): Promise<TurnCardFrame[]>
}

/** What the core gets when the recaps fail: nothing told, no recap, and no live card. */
export const RECAPS_FALLBACKS: PortFallbacks<RecapsPort> = { lifecycle: undefined, recaps: null, liveCards: later([]) }

/**
 * The core's calls into the agent cleanup (services/agentCleanup.ts): what happens to the harnesses agents start.
 * Notices: the core never waits for them, and one the cleanup misses leaves a harness open, as before it.
 */
export interface AgentCleanupPort {
  /** A harness was closed or stopped (`agent_close`, Stop Harness, a purge): the harnesses it started close too. */
  closed(agentId: string): void
  /** The person typed or pasted into a harness, from a window or the phone (an agent id or a session id): one another
   *  agent started is the person's from then on. */
  typed(id: string): void
  stop(): void
}
/** What the core gets when the cleanup fails: nothing told, and every harness left open, as before it. */
export const AGENT_CLEANUP_FALLBACKS: PortFallbacks<AgentCleanupPort> = { closed: undefined, typed: undefined, stop: undefined }

/** The core's calls into the DSH viewers: each harness agent's viewer server and verdict watch. */
export interface ViewersPort {
  /** Start the agent's viewer and verdict watch when it has a DSH. Idempotent: called on every
   *  observation of the agent. */
  attach(session: RegisteredSession): void
  /** Stop them: the agent was forgotten. */
  detach(agentId: string): void
  /** What the agent's frame says about its DSH: its name, its viewer and its verdict. */
  frameContext(session: RegisteredSession): AgentDshContext | null
  /** Where the windows' viewer pane for the agent forwards to. */
  forwardingUrl(agentId: string): string | null
  /** Stop every viewer and watch, for a restart or a shutdown. */
  stop(): Promise<void>
  /** A client's frame of a viewer stream (`viewer_request`, `viewer_data`, …), from the connection `connId`:
   *  how a client that cannot reach this machine's loopback (a phone, another machine's window) is served
   *  a viewer. False when the viewers did not take it. */
  stream(connId: string, type: string, payload: Record<string, unknown>): boolean
  /** A client's `viewer_surface`: a frame of a viewer rendered for it by a headless browser, or why not. */
  surface(connId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>
  /** A client's connection ended (`connId`), or every one did (none: the link went down, or the socket is
   *  stopping): its viewer streams and surfaces close. */
  closed(connId?: string): void
}

/** What a client is told for a surface the viewers cannot render while they are off or failing. */
export const VIEWERS_UNAVAILABLE = { error: 'SERVICE_UNAVAILABLE', service: 'viewers', retryable: true }

/** What the core gets when the viewers fail: agents' frames carry no DSH context and the windows
 *  no viewer, a client's viewer stream is refused at once (core/viewerStreams.ts) and its surface
 *  answered unavailable, and a restart or shutdown goes on. Their process on demand, before it has
 *  first connected, holds a stream and a surface while it starts instead (core/viewersLink.ts). */
export const VIEWERS_FALLBACKS: PortFallbacks<ViewersPort> = {
  attach: undefined, detach: undefined, frameContext: null, forwardingUrl: null, stop: later(undefined),
  stream: false, surface: later(VIEWERS_UNAVAILABLE), closed: undefined,
}

/**
 * The core's calls into models (grid). Everything an agent's launch, its frame or a keystroke to it needs
 * of grid, so the core never loads grid's code (docs/design/2026-10-06-core-boundary-next.md, step 7):
 * in the core's process the service answers itself; in its own, core/modelsLink.ts does, from what the
 * service last told it for what a frame or a keystroke reads, and by asking it for the rest.
 */
export interface ModelsPort {
  /** Have grid ready for what the caller is about to do; resolves with what happened, never rejects. */
  ensure: GridAccess['ensure']
  /** What an agent's frame says of the grid it is on: from memory, so a frame costs no I/O. */
  annotation(grid: AgentGridTarget): GridAnnotation | null
  /** Someone is typing to an agent on `grid`: start it while they type, if it sleeps. */
  prewarm(grid: AgentGridTarget): void
  /** Where a new agent on `selection` sends its inference, resolved from this machine's own signed-in
   *  grid; null when that grid does not serve the model now. */
  launchTarget(selection: NewAgentModel): Promise<GridLaunchOverride | null>
  /** Where a running agent moved onto `model` sends its inference (`agent_retarget`): grid set up first,
   *  on `gridName` or the account's own; the sentence a person reads when it cannot be. */
  moveTarget(request: { gridName: string | null; model: string }): Promise<{ target: GridLaunchOverride } | { detail: string }>
  /** An agent was just moved onto a grid model: start that grid while its pane restarts, if it sleeps. */
  moved(launch: GridLaunchOverride): void
  /**
   * The launch that points `request.engine` at a grid or a saved API (lib/gridLaunch.ts): what its pane starts
   * with and the config files the core writes for it, with a saved API's endpoint and key as saved now when
   * `refresh`. An engine that cannot be pointed there is answered with the reason. The core builds no grid launch
   * itself (docs/design/2026-10-08-launch-port.md).
   */
  gridLaunch(request: GridLaunchRequest): Promise<GridLaunchAnswer>
  /** Fresh process evidence, batched; core never waits for it to discover or bind a session. */
  gridAssignments(processes: readonly GridAssignmentProcess[]): Promise<GridAssignmentAnswer[]>
  /** Where an agent moved onto a saved API's model sends its inference: the key travels only into its launch. The
   *  sentence a person reads when the API cannot be used. */
  apiTarget(request: { connectionId: string; model: string }): Promise<{ target: GridLaunchOverride; apiBase: string } | { detail: string }>
  /** The account's private grid: the backend's word, else what this machine works out; null for none. */
  privateGridName(): Promise<string | null>
  /** What `grid_models_changed` tells the windows: the list as a window that draws row state reads it,
   *  and as one that does not. */
  lists(): Promise<{ plain: Record<string, unknown>; rowState: Record<string, unknown> }>
  /** The machine list the core just read (null when signed out): which of the account's other computers
   *  seem offline, for the models only they serve. */
  machines(body: Record<string, unknown> | null, computerId: string): void
  /** The sign-in ended: drop what lives exactly as long as it. */
  signedOut(): void
}

/**
 * What the core gets when models fails: grid set-up, every target and every grid or saved-API launch answered
 * with an error (a create on a grid model answers GRID_UNAVAILABLE, and so does a relaunch on one), frames with no
 * note and no prewarm, the private grid as the backend said it or none, and no push of the lists. A launch on the
 * engine's own login never asks models.
 */
export const MODELS_FALLBACKS: PortFallbacks<ModelsPort> = {
  ensure: later(FAIL), annotation: null, prewarm: undefined, launchTarget: later(FAIL), moveTarget: later(FAIL), moved: undefined,
  gridAssignments: later(FAIL), gridLaunch: later(FAIL), apiTarget: later(FAIL), privateGridName: later(null), lists: later(FAIL), machines: undefined, signedOut: undefined,
}

/** What the core calls while `ports.models` is null (models is off): its fallbacks' answers. */
export const MODELS_OFF: ModelsPort = {
  ensure: () => Promise.reject(new ServiceUnavailableError('models')),
  annotation: () => null,
  prewarm: () => {},
  launchTarget: () => Promise.reject(new ServiceUnavailableError('models')),
  moveTarget: () => Promise.reject(new ServiceUnavailableError('models')),
  moved: () => {},
  gridAssignments: () => Promise.reject(new ServiceUnavailableError('models')),
  gridLaunch: () => Promise.reject(new ServiceUnavailableError('models')),
  apiTarget: () => Promise.reject(new ServiceUnavailableError('models')),
  privateGridName: async () => null,
  lists: () => Promise.reject(new ServiceUnavailableError('models')),
  machines: () => {},
  signedOut: () => {},
}

/** The core's calls into the machine monitor: the readings `agents_list` adds to its rows when a window
 *  asks for the monitor, and forgetting what a purged agent's workspace held. The same readers answer the
 *  monitor's own request (`machine_resources`), so the two share one sample and one cache. */
export interface MonitorPort {
  /** Each live agent's processes, and the shared ones (lib/harnessResources.ts). */
  resources: ReturnType<typeof createHarnessResourcesReader>
  /** What each agent's workspace and transcript hold on disk; `invalidate` drops what was measured
   *  (lib/harnessTelemetry.ts). */
  storage: ReturnType<typeof createHarnessStorageReader>
}

/** What the core gets when the monitor fails: the list's rows without readings (core/agents/list.ts
 *  answers a failed sample as none), and nothing measured to forget. */
export const MONITOR_FALLBACKS: PortFallbacks<MonitorPort> = { resources: later(FAIL), storage: later(new Map()) }

/** What the core calls while `ports.monitor` is null (the monitor is off): its fallbacks' answers. */
export const MONITOR_OFF: MonitorPort = {
  resources: () => Promise.reject(new ServiceUnavailableError('monitor')),
  storage: async () => new Map(),
}

/** The core's calls into workspaces: name made-up worktree branches after their sessions, on each
 *  terminal-title pass, and sweep the worktrees nothing uses, when the core says it is time. */
export interface WorkspacesPort {
  nameBranches(): void
  sweepUnused(): void
}

/** What the core gets when workspaces fails: branches keep their names and nothing is swept. */
export const WORKSPACES_FALLBACKS: PortFallbacks<WorkspacesPort> = { nameBranches: undefined, sweepUnused: undefined }

/** The core's calls into Agent Messages: whether one of its typed deliveries (a `team:` id) may still be written,
 *  asked in line as it is written (core/input.ts); and that the core's copy of the account's switch changed
 *  (core/experiments.ts `createAgentSettingsSync`), which wakes it when it is turned on: off, it runs no timer that
 *  would read the file again, and a file never written has nothing to watch (messages/settingWatch.ts). */
export interface MessagesPort {
  canWrite(deliveryId: string): boolean
  settingsChanged(): void
}

/** What the core gets when Agent Messages fails: none of its deliveries may be written (each waits, unwritten), and
 *  a settings write tells it nothing. */
export const MESSAGES_FALLBACKS: PortFallbacks<MessagesPort> = { canWrite: false, settingsChanged: undefined }

/**
 * The cloud agents' doors into the core (docs/design/2026-10-11-cloud-agents.md, "The one core change"): the
 * harnesses its service owns, which have no pane, and the questions they ask. The core lists them beside the
 * terminal agents and tells every client what changed (core/agents/cloud.ts).
 */
export interface CloudCore {
  /** Every cloud harness, replacing the last list. */
  publish(harnesses: CloudHarness[]): void
  /** One waits on the person: shown wherever questions show; the answer comes back through `CloudPort.answer`. */
  ask(agentId: string, requestId: string, question: { text: string; choices: string[] }): void
  /** That question is no longer asked. */
  unask(agentId: string, requestId: string): void
}

/** The request ids of the Super Tab waits on the devices: never an engine's (theirs are its tool ids), so an answer
 *  sent back for one is never typed into a pane (services/devices.ts). */
export const SUPER_TAB_REQUEST_PREFIX = 'supertab:'

/**
 * A Super Tab member on this machine waits on a person: its assignment needs a decision or is stuck
 * (superTabs/attention.ts). Shown on the devices cabled here as a question nobody answers there: display only.
 */
export interface SuperTabAttention {
  /** The local agent (its harness id). */
  agentId: string
  /** `supertab:<assignment>:<status>`: stable for one wait, never an engine's question id. */
  requestId: string
  /** The Super Tab's name, at most 48 bytes. */
  superTab: string
  attention: 'decision' | 'stuck'
  /** What the device reads: the decision asked for, or why it is stuck. */
  text: string
}

/** What the core hands the Swarm's own close and reopen (superTabs/inCore/agents.ts): the live registry, the stopped
 *  records, and the core's close, resume and creation receipts. */
export interface SwarmAgentDeps {
  byAgent(agentId: string): RegisteredSession | undefined
  stoppedIds(): string[]
  closeAgent?: (request: AgentCloseRequest) => Promise<AgentCloseResult>
  resumeAgent?: (agentId: string) => Promise<{ ok: true } | { ok: false; error: string; detail?: string }>
  creationStatus?: (creationId: string) => Promise<CreationObservation | null>
}
export type SwarmAgents = Required<Pick<CoreApi['agents'], 'closeSwarm' | 'keepLeadAlive' | 'closeMember'>>

type SwarmSkill = NonNullable<RegisteredSession['swarmSkill']>
/** The Swarm's part of an agent's start (superTabs/inCore/launch.ts), handed to the launches while the Swarm is on: the
 *  roles and skill modes a start may ask for, the role's skill written into the project folder (what the engine is told
 *  to read), and the Harness GitHub App's git and gh for another person's project work (null where it has none). */
export interface SwarmLaunch {
  role(value: unknown): value is SwarmSkill['role']
  mode(value: unknown): value is NonNullable<SwarmSkill['mode']>
  prepare(cwd: string, skill: SwarmSkill): { instructions: string }
  github(key: string): { env: Record<string, string>; clearEnv: string[] } | null
  /** The engine's arguments for a session the Swarm starts, never for a person's own (lib/swarmEngineArgs.ts). */
  args(engine: string): string[]
  /** Whether a Buddy's launch was told a Swarm id its Codex rule can be written from (lib/buddyCodexRules.ts). */
  tabId(value: unknown): value is string
  /** Let a Codex Buddy's own chat commands leave its sandbox without asking: its Swarm's rule, in the Codex home [home]. */
  codexRules(home: string, tabId: string): void
}

/** Fill a missing Swarm role of an older Swarm session at its restart or resume (superTabs/inCore/adoption.ts): the row
 *  to launch, or null when the launch is no longer this one's. Absent while the Swarm is off. */
export type AdoptSwarmSkill = (session: RegisteredSession, current: () => boolean) => Promise<RegisteredSession | null>

export type LeadState = 'ask' | 'stuck' | 'work' | 'done'
/** One Swarm's Lead on a Harness Pro's card (superTabs/cards.ts). `order`: the project's index in the Swarm (the app's
 *  order), so a dial can show the Leads as the app does whatever their urgency. */
export interface SwarmLead { id: string; projectId: string; project: string; engine: string; owner: string; local: string; state: LeadState; order: number; since?: number; chat?: SwarmChat; notice?: LeadNotice }
/** One Swarm this account is in, as a Harness Pro's card: its Leads, most urgent first. */
export interface SwarmCard { id: string; name: string; count: number; leads: SwarmLead[] }
/** A Lead's last message, for its card; `chatId` when it is the last message of the chat on the round dial's face. */
export interface LeadRecap { tabId: string; leadId: string; text: string; at: number; none: boolean; chatId?: string }
/** A project's three places to chat (design 2026-10-28-round-dial-swarm-chat): its Lead conversation, the reader's private
 *  chat (`pm`: their Buddy chat, where the PM's private lines land since Buddies replaced Chat with PM), and a group. */
export type ChatKind = 'lead' | 'pm' | 'group'
/** The chat on a project's face on the round dial: the Lead's, unless the window has the project's PM chat or a group
 *  open. `working` only for a working group, `since` from one of its agents' turn here. */
export interface SwarmChat { kind: ChatKind; id: string; name: string; working: boolean; since?: number }
/** The newest message the project's Lead wrote in its Lead conversation or the reader's Buddy chat since the baseline: the dial's alert. */
export interface LeadNotice { chat: 'lead' | 'pm'; chatId: string; id: string; text: string; at: number }
/** The conversation the window has open in a Swarm tab. */
export interface CardFocus { tabId: string; conversationId: string }

/** The Super Tab service's door into the core (superTabs/inCore/attention.ts): the waits of its members here. */
export interface SuperTabsCore {
  /** Every wait, replacing the last set: the core raises what is new on the devices and closes what is gone. */
  attention(items: SuperTabAttention[]): void
  /** Every Swarm this account is in, whole, each time it changes: the core keeps the last list for a dial that attaches
   *  later and hands it to the devices (superTabs/inCore/cards.ts). */
  cards(items: SwarmCard[]): void
  /** What one Lead last said, pushed when the recap on a Harness Pro's screen moved on. */
  cardRecap(recap: LeadRecap): void
  /** Members may watch an agent of this machine's: Share must run to invite them (superTabs/observers.ts). Its saved
   *  state wakes it only as the core starts, so a machine that joined a Swarm while running never invited anyone and
   *  each member's pane read "must be online" (River on a contributed machine, 2026-10-23). */
  shareObservers(): void
  /** A member's terminal as plain text for its Lead (superTabs/inCore/terminal.ts): the visible screen, with up to 200 lines
   *  of scrollback when asked, and what the screen reader says it waits on (a permission prompt, a question). */
  screen(agentId: string, scrollback: number): Promise<SuperTabScreen>
  /** Text, then each key by its tmux name, typed into a member's terminal under the pane's write lock. */
  input(agentId: string, text: string, keys: string[]): Promise<SuperTabTyped>
  /** The same keys, sent only if the visible screen, read again under the pane's write lock, is exactly `screen` (superTabs/inCore/
   *  terminal.ts): for a caller that read the screen earlier and must not type into a different one. */
  inputIfScreen(agentId: string, keys: string[], screen: string): Promise<SuperTabTyped>
}
export type SuperTabScreen = { ok: true; text: string; hold: MessageHold | null } | { ok: false; error: string }
export type SuperTabTyped = { ok: true } | { ok: false; error: string }

/** What the cloud service answers the core: done, or why not, in words a person reads. */
export type CloudResult = { ok: true; detail?: string } | { ok: false; error: string; detail?: string }

/** The core's calls into the cloud agents' service: a New Harness for one, a person's words, an answer, a new name, a Stop. */
export interface CloudPort {
  /** `agent_create` for a cloud agent: the new harness's frame, or why not. */
  create(request: Record<string, unknown>): Promise<{ ok: true; agent: Record<string, unknown> } | { ok: false; error: string; detail?: string }>
  deliver(agentId: string, text: string): Promise<CloudResult>
  answer(agentId: string, requestId: string, answers: Record<string, string>): Promise<CloudResult>
  /** Rename Harness: the name Harness shows. The maker's own name for the work stays as it is. */
  rename(agentId: string, name: string): Promise<CloudResult>
  /** Stop Harness. Not `stop`: a service host reads a port's `stop` as stopping the service itself. */
  stopHarness(agentId: string): Promise<CloudResult>
}

/** A call the cloud service could not take: it is off, failing, or slower than the core waits. */
export const CLOUD_DOWN = { ok: false as const, error: 'SERVICE_UNAVAILABLE', detail: 'Cloud agents are not running here. Try again in a moment.' }
/** What the core gets when the cloud service fails: each call is refused with a reason, and nothing is lost but it. */
export const CLOUD_FALLBACKS: PortFallbacks<CloudPort> = { create: later(CLOUD_DOWN), deliver: later(CLOUD_DOWN), answer: later(CLOUD_DOWN), rename: later(CLOUD_DOWN), stopHarness: later(CLOUD_DOWN) }

/** What a delivered turn answers: delivered, or refused with the machine's name and a reason a person can read. */
export type SendResult = { ok: true } | { ok: false; machine: string; reason: string }
/** What a fork answers: the new agent's id, or why not. */
export type ForkResult = { ok: true; agentId: string } | { ok: false; error: string; detail?: string }

/*
 * The devices (services/devices.ts): the dials on USB, the window bridges they speak through, and the
 * fleet's router every turn goes through, ⌘K's included (docs/design/2026-10-06-core-boundary-next.md,
 * "Devices", step 9). They answer the core through `DevicesPort` and reach it through `CoreApi`, so that
 * they can run in a process of their own: a device that fails, hangs or leaks costs the devices, never a
 * session.
 */

/** The frames the devices may send every window on this computer (`clients.sendLocal`): what a hand at
 *  this desk did on a dial, and a spoken task offered to the window's palette. Never to the cloud. */
export const DEVICE_WINDOW_FRAMES = [
  'dial_open', 'dial_notification_read', 'dial_forked', 'dial_focus', 'dial_swarm', 'dial_scroll', 'dial_status',
  'voice_route_request', 'dial_super_tab',
] as const
export type DeviceWindowFrame = { type: (typeof DEVICE_WINDOW_FRAMES)[number]; payload: Record<string, unknown> }

/** The frames the devices may send one window (`clients.sendToWindow`): a window bridge's ask, to the
 *  window that has the person's attention. */
export const DEVICE_BRIDGE_FRAMES = ['dial_selection', 'dial_visit', 'dial_form'] as const
export type DeviceBridgeFrame = { type: (typeof DEVICE_BRIDGE_FRAMES)[number]; payload: Record<string, unknown> }

/** Which window has the person's attention, as the local socket last heard (`app_focus` with a focus
 *  revision): where a spoken selection or visit goes (`voice`), and a New Harness form (`form`). */
export interface WindowFocus {
  voice: { machineId: string; agentId: string; connId: string } | null
  form: { machineId: string; connId: string } | null
}

/** A window's answer to a spoken task it was offered (`voice_route_reply`). */
export type VoiceRouteReply = { t: 'taken' } | { t: 'sent'; agentId: string } | { t: 'cancelled' }

/** The Devices tab (services/devices.ts): the devices on this computer, and a device's settings. Only
 *  the owner, on this computer or through the owner's own app, may manage them. */
export const DEVICES_REQUESTS = ['harness_devices_list', 'harness_device_settings', 'pet_preview', 'pet_apply', 'pet_reset', 'pet_status'] as const

/**
 * The core's calls into the devices: what the windows on this computer said that the dial follows, the
 * cards every device is sent, ⌘K, and stopping. Every one is a notice or a request the core never waits
 * on in line: across a process, a hung devices process answers the fallbacks, never a frozen core.
 */
export interface DevicesPort {
  /** A frame bound for the devices (`commander_event`, `commander_question`, `commander_question_close`):
   *  every one the core sends the Wi-Fi devices, as it is sent, so a dial cannot drift from them. */
  card(frame: Record<string, unknown>): void
  /** The window's tiles on its active tab, in tile order, and whether the window is in front. */
  desk(agentIds: string[], foreground: boolean): void
  /** The window's tabs, or null once it has gone. */
  swarms(swarms: AppSwarms | null): void
  /** The Swarms' cards for a Harness Pro (superTabs/inCore/cards.ts), whole; replayed to a dial that attaches. */
  swarmCards(items: SwarmCard[]): void
  /** One Lead's last message, for the recap a Harness Pro has open. */
  swarmCardRecap(recap: LeadRecap): void
  /** What the window still has unread, newest first. */
  unread(items: UnreadNotification[]): void
  /** The window moved to an agent. */
  appFocus(machineId: string, agentId: string): void
  /** The window looked at an agent. */
  seen(agentId: string, readToken?: string): void
  /** A window changing one device's settings. */
  settings(id: string, patch: Record<string, unknown>): void
  /** Which window has the person's attention now. */
  windowFocus(focus: WindowFocus): void
  /** A window's answer to a bridge's ask. */
  windowReply(kind: 'selection' | 'visit' | 'form', connId: string, machineId: string, payload: Record<string, unknown>): void
  /** A window's answer to a spoken task it was offered. */
  voiceReply(voiceId: string, reply: VoiceRouteReply): void
  /** A window left. */
  windowGone(connId: string): void
  /** ⌘K: which agent a typed task belongs to, on any of the owner's machines. */
  routeTask(text: string): Promise<RouteAnswer>
  /** ⌘K's send: the turn delivered on the agent's own machine, or refused with why. */
  routeSend(agentId: string, text: string): Promise<SendResult>
  /** The Wi-Fi device borrowing the dial's walk along the desk, through the core (`CoreApi.wifi.stepFocus`). */
  stepFocus(direction: 'next' | 'previous', currentAgentId?: string): Promise<{ machineId: string; agentId: string } | 'no_agents'>
  /** The Wi-Fi device borrowing the dial's stroke for the window's terminal. */
  scroll(phase: 'down' | 'move' | 'up', dy: number, velocity: number): void
  /** The engines the live agents run: the voice router's worker is one of them. */
  engines(engines: string[]): void
  /** Whether a device watches through the backend: the voice router keeps its worker warm meanwhile. */
  commanders(connected: boolean): void
  /** Let go of the serial ports and the lane, for a restart or a shutdown. */
  stop(): Promise<void>
}

const DEVICES_UNAVAILABLE = 'the devices service is unavailable'

/**
 * What the core gets when the devices fail: the dial and the window bridges hear nothing, ⌘K says so,
 * picking no agent and sending nothing, the Wi-Fi device finds no desk to walk, and a shutdown goes on.
 */
export const DEVICES_FALLBACKS: PortFallbacks<DevicesPort> = {
  card: undefined, desk: undefined, swarms: undefined, swarmCards: undefined, swarmCardRecap: undefined, unread: undefined, appFocus: undefined, seen: undefined,
  settings: undefined, windowFocus: undefined, windowReply: undefined, voiceReply: undefined, windowGone: undefined,
  routeTask: later({ agentId: '', machineId: '', name: '', confidence: 0, reason: DEVICES_UNAVAILABLE, candidates: [], weighed: 0, machines: 0, via: '' }),
  routeSend: later({ ok: false, machine: '', reason: DEVICES_UNAVAILABLE }),
  stepFocus: later('no_agents'), scroll: undefined, engines: undefined, commanders: undefined, stop: later(undefined),
}

/*
 * The Wi-Fi device (services/wifi.ts, lib/autonomous-device/): a paired device that speaks its own
 * protocol (docs/autonomous-device-integration.md) over an E2EE session the gateway holds, on its direct
 * link or the relay. It runs beside the dials, in the devices' process (step 9, D3): the core tells it
 * what the agents do and the requests its sessions bring, and it answers them through the core, which
 * checks that each answer goes to the session it came from.
 */

/** What the core holds for the Wi-Fi device's service, said again each time it starts: every device
 *  session the gateway holds, which of them said their app's hello (served on, told to resync, as after a
 *  daemon restart), and the window that has the person's attention. */
export interface WifiResume {
  sessions: Array<{ connId: string; client: RemoteClient }>
  helloed: Array<{ connId: string; identity: string }>
  focus: { machineId: string; agentId: string; connId: string } | null
}

/** A receipt the device asked for by `harness device receipt`, or the service is not there to say. */
export type WifiReceipt = { receipt: AutonomousDeviceReceipt | null } | { unavailable: true }

/** `harness autonomous-device addon`: what devices published, a proposal sent, or one read back
 *  (lib/autonomous-device/addons.ts); refused with the add-on layer's own code, or the service is not there. */
export const WIFI_ADDON_OPS = ['state', 'propose', 'proposal'] as const
export type WifiAddonOp = typeof WIFI_ADDON_OPS[number]
export type WifiAddon = { result: Record<string, unknown> } | { error: { code: string; message: string } } | { unavailable: true }

/** What the core lists for the Wi-Fi device, read in line while it answers a request: the agents as it
 *  shows them, the Store's evidence on each, and whether a window is attached to show one. */
export interface WifiView {
  agents: AutonomousDeviceAgent[]
  store: StoreAgent[]
  hasWindow: boolean
}

/**
 * The core's calls into the Wi-Fi device: its sessions and their requests, as the gateway hands them on,
 * and what the agents do that it follows (cards, turns, live text, its own deliveries into the panes and
 * the transcript lines that prove them). All notices but `receipt`, which a person asked for.
 */
export interface WifiPort {
  /** A device session the gateway holds, as it changes (null: it lost its session). */
  session(connId: string, client: RemoteClient | null): void
  /** A device's request, as it arrived sealed and as its session opened it (null: it would not open).
   *  Settles once the service has taken it: what the core says after it is heard after it. */
  request(connId: string, frame: Record<string, unknown>, opened: Record<string, unknown> | null): Promise<void>
  /** A device's connection closed. */
  dropped(connId: string): void
  /** The owner unpaired a device here; its sessions are gone. */
  revoked(identity: string): void
  /** What the core holds for it (`WifiResume`), as it starts. Settles once the sessions are served again. */
  resume(state: WifiResume): Promise<void>
  /** A frame bound for the devices, as it is sent, with the turn's whole answer for a summary. */
  card(frame: Record<string, unknown>, fullText?: string): void
  turnStarted(agentId: string): void
  turnEnded(agentId: string, aborted: boolean): void
  /** An agent's live events, for the devices that subscribed to it. */
  stream(agentId: string, events: readonly LiveEvent[]): void
  /** A transcript line of an agent the device sent a prompt to, which proves what its turn did. */
  transcript(agentId: string, sessionId: string, engine: string, line: string): void
  /** Its own deliveries into the panes, as the pane's write lock moves them on (core/deviceInput.ts). */
  delivery(event: AutonomousDeviceDelivery): void
  dispatched(agentId: string, deliveryId: string, text: string, sessionId?: string): void
  inputStatus(event: DeviceInputStatus): void
  agentGone(agentId: string): void
  /** A window moved to an agent (null: it left one), by its connection. Settles once it is applied. */
  appFocus(machineId: string, agentId: string | null, connId: string): Promise<void>
  /** A window opened the agent a device's Store preparation made. */
  revealed(operationId: string, agentId: string): void
  /** `harness device receipt`: what became of one of a device's requests. */
  receipt(deviceId: string, idempotencyKey: string): Promise<WifiReceipt>
  /** `harness autonomous-device addon`: an agent reads what devices published, or proposes to one. */
  addon(op: WifiAddonOp, input: Record<string, unknown>): Promise<WifiAddon>
  stop(): Promise<void>
}

/** The Wi-Fi device's doors, for a service that is not it: nothing is listed, sent, made or moved. */
export const WIFI_OFF: CoreApi['wifi'] = {
  view: async () => ({ agents: [], store: [], hasWindow: false }),
  submit: async () => {}, cancel: () => {}, started: () => {},
  stop: async () => false, answer: async () => false,
  create: async () => ({ ok: false, error: 'UNSUPPORTED' }),
  stepFocus: async () => 'no_app', scroll: () => false, focusApp: () => false, reveal: () => {},
  send: () => {}, hello: () => {}, joined: () => {}, ready: () => {}, unpaired: () => {}, focus: () => {},
  transcripts: () => {}, watching: () => {}, streams: () => {},
}

/**
 * What the core gets when the Wi-Fi device's service is off: its devices hear nothing (a request they sent
 * is unanswered, which they retry with the same key, as after a lost frame) and `harness device receipt`
 * says it is not running.
 */
export const WIFI_FALLBACKS: PortFallbacks<WifiPort> = {
  session: undefined, request: later(undefined), dropped: undefined, revoked: undefined, resume: later(undefined), card: undefined,
  turnStarted: undefined, turnEnded: undefined, stream: undefined, transcript: undefined, delivery: undefined,
  dispatched: undefined, inputStatus: undefined, agentGone: undefined, appFocus: later(undefined), revealed: undefined,
  receipt: later({ unavailable: true }), addon: later({ unavailable: true }), stop: later(undefined),
}

/*
 * The gateway: the relay and its end-to-end encryption (docs/design/2026-10-06-core-boundary-next.md,
 * "Relay and E2EE", step 10). It holds the backend link, the E2EE sessions and the keys; every remote
 * client (a phone, a browser, another machine's desktop, a device) reaches the core through it, and every
 * frame the core has for one leaves through it. The core speaks plaintext to it, and never sees a key.
 *
 * Unlike a service it is transport: what it tells the core (`GatewayEvents`) is who the remote clients
 * are and what they asked, and what the core asks of it (`GatewayPort`) is to carry frames to them, sealed
 * by its rules (which frames, to whom, what is refused unsealed), which stay the gateway's alone.
 */

/** What a remote client proved with its E2EE session: an owner's app or browser, or a device. */
export type RemoteRole = 'web' | 'device'

/**
 * What the account's own apps away from this desk may ask of this machine and hear from it, beyond what an owner may
 * (backendSocket.ts `remoteAppPolicy`). Set only on a Harness Team daemon, by the Swarm (superTabs/inCore/teamApps.ts):
 * there the account is the Mac's owner's, and another person's Product Manager may run, holding people's private chats.
 */
export interface RemoteAppPolicy {
  /** Why a request is refused, or null to answer it as for any owner. */
  refuse(type: string, payload: Record<string, unknown>): { error: string; message: string } | null
  /** A reply's payload as the apps may see it. */
  reply(type: string, payload: Record<string, unknown>): Record<string, unknown>
  /** An up-frame as the apps may hear it, or null to withhold it. */
  event<F extends { agentId?: unknown; payload?: unknown }>(frame: F): F | null
  /** Whether the apps' terminal streams only watch now: no input, paste or resize reaches a terminal, binary frames included
   *  (lib/terminalStreamManager.ts `watchOnly`). */
  watchOnly(): boolean
  /** Whether a session, by its agent id or its engine's session id, is closed to the apps: its open terminal streams close
   *  (lib/terminalStreamManager.ts `closedTo`). */
  isConfidential(id: string): boolean
}

/** A remote client the gateway holds a session with, as the core may know it: its role, the label its
 *  identity was paired under (null for none) for naming it to the person, its identity's public key (the
 *  Wi-Fi device's requests are kept apart by it), and whether it is on a device's direct link rather than
 *  the relay. Nothing here is a secret. */
export interface RemoteClient {
  role: RemoteRole
  accountOwner?: boolean
  /** Set for a session trusted only because this machine is shared with another account: that account's
   *  email ('' when an older store did not record it). A guest uses its own space and nothing of the
   *  owner's (docs/plans/2026-10-19-guest-machine-sharing-plan.md, core/guestPolicy.ts). */
  guest?: string
  label: string | null
  identity: string
  direct: boolean
  /** The machine this session's identity was paired as, when it is one of the owner's machines (`kind: 'machine'`). */
  machineId?: string
}

/** How a remote client's frame arrived: the backend's relay, or a paired client's own P2P channel. */
export type RemoteTransport = 'relay' | 'p2p'

/** The control frames only the backend sends, as the gateway hands them on once it has checked that the
 *  backend sent them (on its own address, in the clear, over the relay). */
export type BackendNotice =
  | { type: 'desk_changed'; revision: number }
  | { type: 'zoo_changed'; revision: number }
  | { type: 'machines_changed'; reason: string }
  | { type: 'device_keys_changed' }
  | { type: 'connectors_changed'; revision: number }
  /** Work waits for an agent of this machine's (backend lib/adapterWs.ts): its Swarm host reads that agent's deliveries now.
   *  Naming none, the server says it pushes them, and every list is read once (superTabs/host.ts PUSH_LEASE_MS). */
  | { type: 'super_tab_deliveries'; tabId?: string; agentId?: string }
  /** A commit changed what this machine's Swarm host reads (backend lib/swarmHostPushes.ts): it reads its changes now. Naming
   *  none, the server says it pushes them, and the host reads only when told (superTabs/hostFeed.ts HOST_PUSH_LEASE_MS). */
  | { type: 'swarm_host_changed'; tabId?: string; lastChangedAt?: number }
  /** A Swarm the account is in changed (backend lib/swarmClientPushes.ts): this computer's windows read it again. Naming none,
   *  the server says it pushes them (desktop super_tabs/swarm_pushes.dart). */
  | { type: 'swarm_changed'; tabId?: string; lastChangedAt?: number; parts?: Array<'main' | 'machine'> }

/** What a person has open on this computer, per surface (lib/windowSurfaces.ts). */
export type { LocalWindows, WindowSurface } from '../lib/windowSurfaces.js'
import type { LocalWindows, WindowSurface } from '../lib/windowSurfaces.js'

/** What the core asks of the gateway: everything bound for a remote client, and the link's state. */
export interface GatewayPort {
  /** Optional, fixed-name counter to the gateway; no user payload or identifier. */
  usageCounter?(metric: ProductUsageMetric): void
  usageLaunch?(signal: ProductUsageLaunchSignal): void
  /** Dial the backend: this daemon is signed in. */
  connect(): void
  /** Never dial: signed out, so nothing is sealed or queued for a link that will not open. */
  serveThisComputerOnly(): void
  /** Hold remote clients' frames, in order, until `openRequests`: the core is not ready to answer. */
  holdRequests(): void
  openRequests(): void
  /** Whether the backend link is up. */
  connected(): boolean
  /** A frame for the web audience: sealed under the group key when it carries content, queued while the
   *  link is down. [guest]: the guest whose harness it is about, whose sessions get it sealed for each. */
  broadcast(frame: Record<string, unknown>, guest?: string): void
  /** A frame for the devices (the commander audience), sealed the same way. */
  commander(frame: Record<string, unknown>): void
  /** A notification for every browser signed in to the account (the user audience). */
  user(frame: Record<string, unknown>): void
  /** The answer to a remote client's request: to it alone, sealed when its type carries content, and a
   *  bare E2EE_REQUIRED when it cannot be. `connId` '' is the backend's own request. */
  reply(connId: string, type: string, requestId: unknown, payload: Record<string, unknown>): void
  /** A frame for one remote client, sealed to it; false when it holds no session. */
  target(connId: string, type: string, payload: Record<string, unknown>): boolean
  /** A terminal frame for one remote client, sealed to it, over its P2P channel when the stream moved
   *  there; false when it could not be sent. */
  terminal(connId: string, type: string, payload: Record<string, unknown>): boolean
  terminalBinary(connId: string, clear: TerminalBinaryClear): boolean
  /** Share's frame to an observer: plaintext to the relay, sealed by Share itself. */
  observer(connId: string, type: string, payload: Record<string, unknown>): boolean
  /** A window opened on this computer: the backend counts it as the person's session at once, or when
   *  the link next comes up. */
  windowOpened(surface: WindowSurface): void
  /** The windows attached on this computer, per surface — tools (`harness pair`, the MCP server) are
   *  not windows and are not counted. */
  localClients(windows: LocalWindows): void
  /** A local connection's request the gateway answers (the E2EE pairings), answered back to it through
   *  `GatewayEvents.toLocal`. */
  local(connId: string, frame: Record<string, unknown>): Promise<void>
  /** The Wi-Fi device's answer or event for one of its sessions, sealed to it, over its direct link or the
   *  relay; false when that session is gone. */
  device(connId: string, type: string, payload: Record<string, unknown>): boolean
  /** Which identity's app said hello on a Wi-Fi device session (null: it left), so that the gateway can
   *  tell the device it was unpaired while its session still stands. */
  deviceClient(connId: string, identity: string | null): void
  stop(): Promise<void>
}

/** What the gateway tells the core. In the core's process these are calls; in the gateway's own, frames
 *  on the link the master started it with, which no other process can open. */
export interface GatewayEvents {
  /** A remote client's request, opened and admitted. `role` is the session that sealed it: who asked is
   *  the gateway's word, and the core trusts nothing in the frame for it. Resolves once it is handled. */
  frame(connId: string, frame: Record<string, unknown>, transport: RemoteTransport, role: RemoteRole): Promise<void> | void
  /** A remote client's terminal bytes, opened. */
  binary(connId: string, clear: TerminalBinaryClear): Promise<void> | void
  /** A remote client gained a session (its role and label), or lost it (null). */
  client(connId: string, client: RemoteClient | null): void
  /** The relay says a client's connection closed: what it had open goes with it. */
  disconnected(connId: string): Promise<void> | void
  /** Share's observer, relayed: Share opens its own frames. */
  observer(connId: string, type: string, payload: Record<string, unknown>): Promise<void> | void
  /** A frame for a window on this computer that asked the gateway something (`GatewayPort.local`); with
   *  `connId` '', for every process attached here (the answer to the backend's own request, which the
   *  windows heard with every event before the gateway was its own part). */
  toLocal(connId: string, frame: Record<string, unknown>): void
  /** The backend link's state, as it changes. */
  status(connected: boolean): void
  /** The link went down: every remote client with it. */
  linkDown(): void
  /** How many devices watch this machine, and how many of them render it now (null: the backend does not
   *  say). `recheck`: the presence was asked about again, though it may not have changed. */
  commanders(count: number, active: number | null, recheck?: boolean): void
  /** A device attached: the live state is sent again for it. */
  commanderJoined(): void
  /** The backend's word on this machine: its name, the account's private grid. A key that is absent is
   *  unchanged; null is "none". */
  meta(meta: { name?: string | null; gridName?: string | null }): void
  /** The account's other changes, for the windows on this computer. */
  notice(notice: BackendNotice): void
  /** This machine was removed from the account, or its session ended: stop for good. */
  revoked(): void
  /** Another computer holds this machine: stop for good, keeping the session. */
  busy(): void
  /** A Wi-Fi device's request (`autonomous_device_request`), as it arrived sealed and as the session that
   *  sealed it opened it (null when it could not be opened, or was not the device's to send). */
  device(connId: string, frame: Record<string, unknown>, opened: Record<string, unknown> | null): Promise<void> | void
  /** A paired identity was unpaired: the Wi-Fi device service forgets it. */
  deviceRevoked(identity: string): void
  /** Something the windows on this computer show of the account's devices (the device key log's notices). */
  toWindows(frame: Record<string, unknown>): void
  /** What a shared tab's relay said (`GatewayOps.tabRelay`), for Agent Messages. */
  tabFrame(event: TabFrame): void
}

/**
 * The fleet's lane to the owner's other machines (device/deviceLink.ts), sealed by the gateway, which holds
 * this machine's E2EE identity (the one `harness link connect` proves knowledge against). The lane keeps
 * which machines have a session; the session itself, its keys and its counters, is the gateway's, one per
 * machine. A gateway that restarted holds none and says so (`lost`): the lane then starts one again, and
 * sends nothing for that machine in the clear meanwhile.
 */
export interface LaneSeal {
  /** Start a session with a linked machine, pinned to the key `harness link connect` left for it (`peerPub`,
   *  base64): the hello to send it, in the clear. Replaces any session that machine had. Rejects when the
   *  gateway cannot start one (it is not running). */
  hello(machineId: string, peerPub: string): Promise<Record<string, unknown>>
  /** The machine's welcome to that hello: true once the session is up. */
  welcome(machineId: string, payload: Record<string, unknown>): Promise<boolean>
  /** The machine's new keys, for a session that is up. */
  rekey(machineId: string, payload: Record<string, unknown>): Promise<void>
  /** A frame for the machine, sealed as its session seals that type (a type it does not seal goes as it is). */
  seal(machineId: string, frame: Record<string, unknown>): Promise<LaneSealed>
  /** A sealed frame from the machine, opened; `unreadable` when it does not open (stale, forged, garbled). */
  open(machineId: string, frame: Record<string, unknown>): Promise<LaneOpened>
  /** The lane is done with the machine's session. */
  drop(machineId: string): void
}
export type LaneSealed = { frame: Record<string, unknown> } | { lost: true }
export type LaneOpened = { frame: Record<string, unknown> } | { unreadable: true } | { lost: true }
/** A service with no lane of the core's: it starts no session and seals nothing, never sends in the clear. */
export const LANE_OFF: LaneSeal = {
  hello: () => Promise.reject(new Error('no lane: this process holds no E2EE identity')),
  welcome: async () => false,
  rekey: async () => {},
  seal: async () => ({ lost: true }),
  open: async () => ({ lost: true }),
  drop: () => {},
}

/** An HTTP answer for the daemon's own routes (`harness pair`, `harness devices`, …), as the hook server sends it. */
export interface HttpAnswer {
  status: number
  body: Record<string, unknown>
  /** A busy or failing answer's Retry-After, when it had one (gateway/accountHttp.ts). */
  retryAfterMs?: number
}

/** What the core's status reads of the relay: the machine's E2EE fingerprint, its pairings and the one
 *  waiting to pair. */
export interface GatewayStatus {
  fingerprint: string | null
  pairs: Array<Record<string, unknown>>
  pending: Record<string, unknown> | null
}

/** The account's sign-in as the gateway's device key log reads it: no credential, only which sign-in. */
export interface GatewayAccount {
  /** The machine id the backend gave this sign-in; null signed out. */
  machineId: string | null
  /** Which sign-in by hand this is, and the account it was made to (lib/authSession.ts `signInOf`), or null. */
  signIn: { epoch: string; adopted: boolean; at: number | null; acct?: string } | null
  autonomousEnv?: string
}

/** The gateway's last successful machine list, scoped to the account that fetched it. No credentials. */
export interface GatewayMachines {
  owner: string | null
  body: Record<string, unknown> | null
  fetchedAt: number
}

/** A Wi-Fi device operation refused, with the code the device's local API answers it under. */
export interface GatewayRefusal {
  code: string
  message: string
}

/**
 * The daemon's own commands about the keys, which the gateway holds: `harness pair`, `unpair`,
 * `remote-password`, `link connect`, `group`, `devices`, and the Wi-Fi device's pairing. Each answers as
 * the hook server's route does; while the gateway is down, a 503.
 */
export interface GatewayOps {
  /** Account HTTP and its cache live with the network, outside the session core. */
  backend(method: string, path: string, body?: unknown): Promise<HttpAnswer>
  machines(fallback?: boolean): Promise<HttpAnswer>
  mintGridName(): Promise<string | null>
  status(): Promise<GatewayStatus>
  pair(code: string): Promise<HttpAnswer>
  listPairs(): Promise<HttpAnswer>
  revoke(id: string): Promise<HttpAnswer>
  revokeAll(): Promise<HttpAnswer>
  setRemotePassword(password: string): Promise<HttpAnswer>
  clearRemotePassword(): Promise<HttpAnswer>
  remotePasswordStatus(): Promise<HttpAnswer>
  trustLinkedPeer(peer: { pub: string; machineId: string; label: string }): Promise<HttpAnswer>
  groupList(): Promise<HttpAnswer>
  groupSync(): Promise<HttpAnswer>
  groupRemove(selector: string): Promise<HttpAnswer>
  devicesList(): Promise<HttpAnswer>
  devicesRemove(pub: string): Promise<HttpAnswer>
  devicesHistory(): Promise<HttpAnswer>
  /** `confirm`: "It's mine" for the one key named, shared with the account's other devices. */
  devicesDismiss(body: { pub?: string; pubs?: string[]; baseline?: boolean; confirm?: boolean }): Promise<HttpAnswer>
  devicesRebaseline(confirm: boolean, head?: { seq: number; hash: string }): Promise<HttpAnswer>
  /** The Wi-Fi device's direct links: discovered devices, pairing one, and its pairings. A refusal is an
   *  answer (`{ refused }`), as the device's local API words it. */
  wifi(request: { op: 'discover' | 'pair' | 'pairStatus' | 'list' | 'revoke'; device?: string; code?: string; id?: string }):
    Promise<{ result: Record<string, unknown> } | { refused: GatewayRefusal }>
  /** The Wi-Fi device service is up (its direct links start) or gone (they stop). */
  wifiService(on: boolean): void
  /** A Wi-Fi device asked to be unpaired, over its own authenticated session. */
  revokeIdentity(identity: string): void
  /** The account's sign-in, as it is now (after start-up recorded which sign-in it is); the device key log
   *  registers this machine with it. */
  account(account: GatewayAccount): void
  /** The owner's machines the backend last said were online, for the trust group's exchanges; null when
   *  the list is not the backend's. */
  reachable(machineIds: string[] | null): void
  /** The fleet's lane's sessions (`core.account.lane`). */
  lane: LaneSeal
  /** Share's owner's signature on a welcome, with this machine's identity (`core.account.observerKey`). */
  observerKey: ObserverKey
  /** Shared tabs' rosters signed and their sessions, with this machine's identity (`core.account.tabKey`). */
  tabKey: TabKey
  /** Shared tabs' relay sockets (`core.account.tabRelay`); what they hear is `GatewayEvents.tabFrame`. */
  tabRelay: TabRelay
  /** The account's connected services sealed for its machines (`core.account.connectorVault`). */
  connectorVault: ConnectorVault
  /** Machines shared across accounts, made to hold exactly what the shared-machines service says
   *  (gateway/sharedTrust.ts): the ones shared with this account pinned, the machines of the accounts this
   *  one is shared with trusted; a part left out stays as it is. Answers how many of each it holds. */
  sharedTrust(desired: { pins?: SharedTrustPeer[]; keys?: SharedTrustPeer[] }): Promise<{ pins: number; keys: number }>
}


/** A window on this computer working on another of the owner's machines, through the relay: what the
 *  local socket asks of the gateway for it (lib/remoteRelay.ts `RemoteRelayPool`, or its link). */
export interface WindowRelaySession {
  send(frame: Record<string, unknown>): Promise<void>
  sendBinary(clear: TerminalBinaryClear): Promise<void>
  detach(): void
}
export interface WindowRelaySink {
  sendFrame(frame: Record<string, unknown>): boolean
  sendBinary(frame: Uint8Array): boolean
}
export interface WindowRelay {
  acquire(machineId: string, autonomousEnv: string, selectFrame: Record<string, unknown>, sink: WindowRelaySink,
    onClosed: (code: number, reason: string) => void): Promise<WindowRelaySession>
  acquireIsolated(machineId: string, autonomousEnv: string, selectFrame: Record<string, unknown>, sink: WindowRelaySink,
    onClosed: (code: number, reason: string) => void): Promise<WindowRelaySession>
  invalidate(machineId: string): void
  invalidateIsolated(machineId: string): void
  /** A window here watching, read-only, a harness someone shared with this account (sharing/relay.ts, the
   *  Share relay's own socket, `/api/observer-ws`). Fails with the close the window gets: 4403 when the
   *  share ended or was never there, 1013 when it could not be reached just now. The gateway's has it; a
   *  bare pool of sessions to other machines (lib/remoteRelay.ts) does not, and shares nothing. */
  acquireShare?(machineId: string, shareId: string, sink: WindowRelaySink,
    onClosed: (code: number, reason: string) => void): Promise<WindowRelaySession>
}

export interface StorePort {
  dshMaterialize(request: DshMaterializeRequest): Promise<DshMaterializeAnswer>
  dshLaunch(request: DshLaunchRequest): Promise<DshLaunchAnswer>
}

export const STORE_FALLBACKS: PortFallbacks<StorePort> = { dshMaterialize: later(FAIL), dshLaunch: later(FAIL) }
export const STORE_OFF: StorePort = {
  dshMaterialize: () => Promise.reject(new ServiceUnavailableError('store')),
  dshLaunch: () => Promise.reject(new ServiceUnavailableError('store')),
}

/** Each port is filled by the service that owns it when that service starts, and is null while the
 *  service is off: the core never waits on one. */
export interface CorePorts {
  usage: UsagePort | null
  store: StorePort | null
  search: SearchPort | null
  viewers: ViewersPort | null
  models: ModelsPort | null
  workspaces: WorkspacesPort | null
  messages: MessagesPort | null
  devices: DevicesPort | null
  wifi: WifiPort | null
  monitor: MonitorPort | null
  orchestrator: OrchestratorPort | null
  sharing: SharingPort | null
  recaps: RecapsPort | null
  agentCleanup: AgentCleanupPort | null
  cloud: CloudPort | null
  superTabs: SuperTabsPort | null
  sharedMachines: SharedMachinesCorePort | null
}

export function emptyPorts(): CorePorts {
  return { usage: null, store: null, search: null, viewers: null, models: null, workspaces: null, messages: null, devices: null, wifi: null, monitor: null, orchestrator: null, sharing: null, recaps: null, agentCleanup: null, cloud: null, superTabs: null, sharedMachines: null }
}

export interface CoreApiDeps {
  terminals?: TerminalsPort
  conversations?: ConversationReads
  dataDir: string
  registry: Pick<typeof registry, 'list' | 'byAgent' | 'resolve' | 'advertised' | 'terminalAvailable'>
  stoppedAgents: Pick<StoppedAgentStore, 'list' | 'ids'>
  databaseHistory: CoreApi['transcripts']['databaseHistory']
  syncSession: CoreApi['agents']['sync']
  runtimeModels: CoreApi['agents']['runtimeModels']
  viewerChanged: CoreApi['clients']['viewerChanged']
  viewerFrame: CoreApi['clients']['viewerFrame']
  gridNamed: CoreApi['clients']['gridNamed']
  gridModelsChanged: CoreApi['clients']['gridModelsChanged']
  dshInstallStatus: CoreApi['clients']['dshInstallStatus']
  mintGridName: CoreApi['account']['mintGridName']
  accessToken: CoreApi['account']['accessToken']
  lane: CoreApi['account']['lane']
  observerKey: CoreApi['account']['observerKey']
  tabKey: CoreApi['account']['tabKey']
  tabRelay: CoreApi['account']['tabRelay']
  connectorVault: CoreApi['account']['connectorVault']
  observer: CoreApi['clients']['observer']
  privateGridName: CoreApi['account']['privateGridName']
  machineName: CoreApi['account']['machineName']
  backend: CoreApi['account']['backend']
  onNotice: CoreApi['account']['onNotice']
  create: CoreApi['agents']['create']
  creationStatus?: CoreApi['agents']['creationStatus']
  dsh: CoreApi['agents']['dsh']
  windows: CoreApi['clients']['windows']
  daemon: DaemonAddress
  runtimeProfile: CoreApi['agents']['runtimeProfile']
  setRuntime: CoreApi['agents']['setRuntime']
  fork: CoreApi['agents']['fork']
  turns: CoreApi['turns']
  questions: CoreApi['questions']
  machine: CoreApi['machine']
  activityText: CoreApi['agents']['activityText']
  activitySnapshot?: CoreApi['agents']['activitySnapshot']
  /** Whether each agent works now (`activity`); absent, no agent is reported. */
  activity?: CoreApi['agents']['activity']
  /** One line on what each agent does (`summaries`); absent, none is given. */
  summaries?: CoreApi['agents']['summaries']
  /** One `agent_close` (core/agents/close.ts), for `closeStarted`; absent, a service closes nothing. */
  closeAgent?: (request: AgentCloseRequest) => Promise<AgentCloseResult>
  /** When an agent's conversation last moved (lib/transcriptActivity.ts), for `lastActivity`. */
  activityAt?: (session: RegisteredSession) => Promise<number | null>
  /** A resume of a stopped agent (core/agents/lifecycle.ts `resumeAgent`), for `keepLeadAlive`. */
  resumeAgent?: (agentId: string) => Promise<{ ok: true } | { ok: false; error: string; detail?: string }>
  /** The Swarm's `closeSwarm`, `keepLeadAlive` and `closeMember` (superTabs/inCore/agents.ts), built on what the core
   *  reads its agents by; absent while the Swarm is off, and then the core offers none of them. */
  swarmAgents?: (deps: SwarmAgentDeps) => SwarmAgents
  signedIn: CoreApi['account']['signedIn']
  environment: CoreApi['account']['environment']
  machines: CoreApi['account']['machines']
  /** Where the devices' frames go: every window on this computer, or one. Only the devices' own frame
   *  types reach these (`createCoreApi`). */
  sendLocal(frame: { type: string; payload: Record<string, unknown> }): void
  sendToWindow(connId: string, frame: { type: string; payload: Record<string, unknown> }): boolean
  hasWindow: CoreApi['clients']['hasWindow']
  devicesChanged: CoreApi['clients']['devicesChanged']
  dialWatching: CoreApi['clients']['dialWatching']
  /** The Wi-Fi device's doors (core/wifi.ts). */
  wifi: CoreApi['wifi']
  /** The cloud agents' doors (core/agents/cloud.ts). */
  cloud?: CloudCore
  /** The Super Tab service's door (superTabs/inCore/attention.ts). */
  superTabs?: SuperTabsCore
  /** The devices' way to the Super Tab service's card requests. */
  superTabRequest?: CoreApi['superTabRequest']
  /** The running cloud harnesses as list rows (`agents.cloud`). */
  cloudRows?: () => RegisteredSession[]
  lastTurn: CoreApi['transcripts']['lastTurn']
  nativeTurns?: NativeTurnRead
  /** Where a turn's cards and recaps go: the devices, and the apps. Only their own frame types reach these. */
  turnCard: CoreApi['clients']['turnCard']
  turnSummary: CoreApi['clients']['turnSummary']
  log?: (line: string) => void
}

export function createCoreApi({
  dataDir, registry, stoppedAgents, databaseHistory, syncSession, runtimeModels, viewerChanged,
  gridNamed, gridModelsChanged, dshInstallStatus, mintGridName, accessToken, lane, observerKey, tabKey, tabRelay, connectorVault, observer, privateGridName, machineName, backend, onNotice,
  runtimeProfile, setRuntime, fork, create, creationStatus, dsh, windows, daemon, turns, questions, terminals = TERMINALS_OFF, conversations = CONVERSATIONS_OFF, viewerFrame, machine, activityText, activitySnapshot, activity, summaries,
  closeAgent, activityAt, resumeAgent, swarmAgents,
  signedIn, environment, machines, sendLocal, sendToWindow, hasWindow, devicesChanged, dialWatching, wifi, cloud, superTabs, superTabRequest, cloudRows, lastTurn, nativeTurns, turnCard, turnSummary,
  log = (line) => console.warn(line),
}: CoreApiDeps): CoreApi {
  // The devices reach the windows through these alone, and only with their own frames: a devices process
  // speaks to the core as a service, and what it may put in front of a person is decided here, not there.
  const windowFrames = new Set<string>(DEVICE_WINDOW_FRAMES)
  const bridgeFrames = new Set<string>(DEVICE_BRIDGE_FRAMES)
  const refused = (type: unknown): void => log(`[services] the devices sent a window ${String(type).slice(0, 40)}, which is not theirs to send`)
  // The recaps reach the devices and the apps through their own two doors, and only with their own frames.
  const refusedRecap = (type: unknown): void => log(`[services] the recaps sent ${String(type).slice(0, 40)}, which is not theirs to send`)
  return {
    dataDir,
    terminals,
    machine,
    conversations,
    agents: {
      all: () => [...registry.list(), ...stoppedAgents.list()],
      stopped: async id => !registry.byAgent(id) && stoppedAgents.list().some(s => s.agentId === id),
      gone: async id => !registry.byAgent(id) && !stoppedAgents.ids().includes(id),
      live: () => registry.list(),
      displayName: projectDisplayName,
      byAgent: (agentId) => registry.byAgent(agentId),
      resolve: (id) => registry.resolve(id),
      advertised: () => registry.advertised(),
      ...(cloudRows ? { cloud: cloudRows } : {}),
      terminalAvailable: (agentId) => registry.terminalAvailable(agentId),
      sync: syncSession,
      runtimeModels,
      runtimeProfile,
      setRuntime,
      fork,
      create,
      ...(creationStatus ? { creationStatus } : {}),
      dsh,
      activityText,
      activitySnapshot,
      activity: activity ?? (async () => ({})),
      summaries: summaries ?? (async () => ({})),
      // The Swarm's own close and reopen (superTabs/inCore/agents.ts), handed in while it is on.
      ...swarmAgents?.({ byAgent: id => registry.byAgent(id), stoppedIds: () => stoppedAgents.ids(), closeAgent, resumeAgent, creationStatus }),
      // Decided here, not in the service: whatever the cleanup asks, from its process or this one, the core closes only
      // a harness another agent started, the conversation it reviewed (`agent_close`'s identity), and keeps it.
      closeStarted: async (agentId, mode) => {
        const session = registry.byAgent(agentId)
        if (!session) return { error: 'AGENT_CHANGED' }
        if (session.startedBy !== 'agent') return { error: 'NOT_AGENT_STARTED' }
        if (!closeAgent) return { error: 'UNSUPPORTED' }
        return closeAgent({ agentId, sessionId: session.sessionId, createdAt: new Date(session.registeredAt).toISOString(), mode })
      },
      lastActivity: async (agentId) => {
        const session = registry.byAgent(agentId)
        return session && activityAt ? activityAt(session) : null
      },
    },
    turns,
    questions,
    transcripts: { databaseHistory, lastTurn, ...(nativeTurns ? { nativeTurns } : {}) },
    account: { mintGridName, accessToken, lane, observerKey, tabKey, tabRelay, connectorVault, privateGridName, machineName, backend,
      identity: accountIdentity(backend), onNotice, signedIn, environment, machines },
    clients: {
      viewerChanged, gridNamed, gridModelsChanged, dshInstallStatus, windows, observer, hasWindow, devicesChanged, dialWatching,
      // A viewers process speaks to the core as a service: what it may send a client is a viewer stream's
      // frame, decided here, never whatever it names.
      viewerFrame: (connId, type, payload) => VIEWER_UP_TYPES.has(type) && viewerFrame(connId, type, payload),
      sendLocal: (frame) => {
        if (windowFrames.has(frame?.type)) sendLocal(frame)
        else refused(frame?.type)
      },
      sendToWindow: (connId, frame) => {
        if (bridgeFrames.has(frame?.type)) return sendToWindow(connId, frame)
        refused(frame?.type)
        return false
      },
      turnCard: (frame) => { if (TURN_CARD_TYPES.has(frame?.type)) turnCard(frame); else refusedRecap(frame?.type) },
      turnSummary: (frame) => { if (TURN_SUMMARY_TYPES.has(frame?.type)) turnSummary(frame); else refusedRecap(frame?.type) },
    },
    daemon,
    wifi,
    ...(cloud ? { cloud } : {}),
    ...(superTabs ? { superTabs } : {}),
    ...(superTabRequest ? { superTabRequest } : {}),
  }
}
