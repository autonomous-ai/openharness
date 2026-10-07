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
import type { ReviewedAnswer } from '../cable/questionInbox.js'
import type { AgentEngine } from '../engines/types.js'
import type { AppSwarms } from '../cable/cableSession.js'
import type { UnreadNotification } from '../lib/notificationRead.js'
import type { AutonomousDeviceAgent, AutonomousDeviceDelivery, AutonomousDeviceReceipt } from '../lib/autonomous-device/service.js'
import type { StoreAgent } from '../lib/autonomous-device/store.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { GridAccess } from '../lib/gridAttach.js'
import type { createHarnessResourcesReader } from '../lib/harnessResources.js'
import type { createHarnessStorageReader } from '../lib/harnessTelemetry.js'
import type { AgentGridTarget, GridAnnotation } from '../lib/gridAnnotation.js'
import { GRID_FLEET_MAX_TIMEOUT_MS } from '../lib/gridFleetProtocol.js'
import type { GridLaunchOverride } from '../lib/gridLaunch.js'
import type { NewAgentModel } from '../lib/newAgentModel.js'
import type { LastTurnText, LiveEvent } from '../lib/normalize.js'
import type { SessionRecaps } from '../lib/recapReads.js'
import type { SessionInputDelivery } from '../lib/sessionInput.js'
import { projectDisplayName, type registry, type RegisteredSession } from '../lib/registry.js'
import type { RuntimeModelOption } from '../lib/runtimeProfile.js'
import type { ExternalSessions, OpenSessions } from '../lib/sessionSearch/external.js'
import type { SessionSearchIndex } from '../lib/sessionSearch/indexer.js'
import type { StoppedAgentStore } from '../lib/stoppedAgents.js'
import type { TerminalBinaryClear } from '../lib/terminalBinary.js'
import { VIEWER_UP_TYPES } from '../lib/viewerFrames.js'
import type { RouteAnswer } from '../localWsServer.js'
import type { SwarmPromptScopes } from '../teams/promptScope.js'
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
  watch: TerminalWatch
}
/** A service without the core's launch call must refuse, never launch outside the core; it watches nothing. */
export const TERMINALS_OFF: TerminalsPort = {
  open: async () => ({ ok: false, error: 'SERVICE_UNAVAILABLE' }),
  watch: { frame: async () => {}, close: async () => {}, onOutput: () => () => {} },
}

/** Read-only conversation facts for the handoff in the edge host. Each lookup asks the core now;
 * a stopped record is never replaced by a stale live-agent list in another process. */
export interface ConversationReads {
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
  resolve: async () => null,
  recentAsks: async () => [],
  lastFullText: async () => null,
  recaps: async () => [],
  discover: async () => null,
  findTranscript: async () => null,
  transcriptOk: async () => false,
}

export interface CoreApi {
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
    /** Whether the agent's terminal is attached: a frame without one reads to the apps as "agent gone". */
    terminalAvailable(agentId: string): boolean
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
    /** Deliver text into a live agent under a delivery id of the caller's own, as the Wi-Fi device, a team
     *  and the orchestrator deliver their turns: one path for the three. What becomes of it is heard through
     *  `onDelivery`, under the same id. */
    deliver(agentId: string, text: string, deliveryId: string): void
    /** Take back a delivery not yet being written: true when it was, and it never will be; false for one
     *  the agent's pane is already taking. Answered at once, as the teams and the orchestrator read it in
     *  line: in a service's own process the core is asked and the answer cannot wait, so it is false there,
     *  and a delivery the core did take back is then heard `rejected` (`cancelled`). */
    cancelDelivery(deliveryId: string): boolean
    /** Hear what becomes of each delivery: queued, written, its turn started, refused and why, or past
     *  knowing. Returns how to stop hearing. */
    onDelivery(listener: (event: TurnDelivery) => void): () => void
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
  }
  /** Conversations on this machine that Harness did not start, and which of them a process has open. */
  external: {
    sessions: Pick<ExternalSessions, 'list' | 'scan'>
    open: Pick<OpenSessions, 'known' | 'fresh'>
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
     *  account-wide settings (Tab collaboration's tab channels). A failure is an answer: 502, 504, 401. */
    backend(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }>
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

/** A service in its own process that acts on no agent: it creates none and reads no harness's frame. */
export const AGENT_ACTIONS_OFF: Pick<CoreApi['agents'], 'create' | 'dsh'> = {
  create: async () => ({ ok: false, error: 'SERVICE_UNAVAILABLE' }),
  dsh: () => null,
}

/** The account as a service that reads no backend, hears no notice and signs nothing has it. */
export const ACCOUNT_BACKEND_OFF: Pick<CoreApi['account'], 'backend' | 'onNotice' | 'observerKey'> = {
  backend: async () => ({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } }),
  onNotice: () => () => {},
  observerKey: OBSERVER_KEY_OFF,
}

/** Where a service that was never told runs this daemon from: the installed CLI, on no port it knows. */
export const DAEMON_UNKNOWN: DaemonAddress = { command: 'harness', port: 0, machineId: () => '', autonomousEnv: 'prod' }

/** What became of a delivered turn (`turns.deliver`), as the core's input says it: `queued`, written
 *  (`delivered`), its turn `started`, `rejected` with why, or `unknown`. `sessionId` is the agent it was
 *  delivered to, as the delivery named it. */
export type TurnDelivery = SessionInputDelivery

/** The delivery members of a core that delivers nothing for this service: nothing is written, nothing is
 *  taken back, and nothing is heard. */
export const DELIVERIES_OFF: Pick<CoreApi['turns'], 'deliver' | 'cancelDelivery' | 'onDelivery'> = {
  deliver: () => {},
  cancelDelivery: () => false,
  onDelivery: () => () => {},
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
  /** Whether it may act as this machine's owner: a local process, or the owner's paired app over the
   *  relay. A device or an observer may not. */
  owner: boolean
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
/** The command bar (services/commandBar.ts), an experiment: the socket's `command_bar`, and the hook server's
 *  `/api/command-bar/*`, which it asks as `command_bar_http`. */
export const COMMAND_BAR_REQUESTS = ['command_bar', 'command_bar_http'] as const
/** The project and folder readers (services/projects.ts). */
export const PROJECTS_REQUESTS = ['git_pull_request', 'git_project_info', 'scm_project_info', 'project_preview', 'fs_list_dir', 'agent_read_file'] as const
/** Change agent's handoff file, prepared in the edge host (services/handoff.ts). */
export const HANDOFF_REQUESTS = ['agent_handoff_prepare'] as const
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
  'grid_fleet_run', 'grid_fleet_cancel',
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
 */
export const LONG_ANSWERS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  models: {
    grid_fleet_run: GRID_FLEET_MAX_TIMEOUT_MS + MINUTE,
    grid_fleet_models_list: 15 * MINUTE, grid_fleet_model_download: 15 * MINUTE, grid_fleet_model_start: 15 * MINUTE,
    ensure: 15 * MINUTE, moveTarget: 15 * MINUTE,
    launchTarget: 3 * MINUTE, privateGridName: 2 * MINUTE, lists: 2 * MINUTE,
  },
  store: { dsh_install: 30 * MINUTE, dsh_update: 30 * MINUTE },
}

/** The orchestrator (services/orchestrator.ts): its projects, for the apps and for the agents it runs. */
export const ORCHESTRATOR_REQUESTS = ['orchestrator'] as const
/** Share (services/sharing.ts): an owner's shares of a harness, their links and their comments. */
export const SHARE_REQUESTS = [
  'harness_share_list', 'harness_share_invite', 'harness_share_remove', 'harness_share_link',
  'harness_share_comments', 'harness_share_comment_post', 'harness_share_comment_remove',
] as const

/** Tab collaboration and teams (services/collaboration.ts): the teams' own requests, from the apps, from `harness team`
 *  in an agent's shell and from the other machines' teams. */
export const TEAMS_REQUESTS = ['team', 'team_delivery'] as const

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
  // Tab collaboration and teams, beside the prompt scopes in the teams' process (harnessd/services.ts). Its
  // ledgers and mailboxes: a team was made here, or another machine's team delivered to an agent here.
  collaboration: { requests: TEAMS_REQUESTS, state: ['teams'] },
  // Its invitations and links: a harness was shared from here.
  sharing: { requests: SHARE_REQUESTS, state: ['harness-shares.json', 'harness-collaboration.json'] },
  // Request-only: it keeps nothing, so it is on from its first request until the daemon stops.
  commandBar: { requests: COMMAND_BAR_REQUESTS, state: [] },
}

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
export type SearchPort = Pick<SessionSearchIndex, 'touch' | 'deleteHistory' | 'session' | 'stop'>

/** What the core gets when search fails: nothing indexed and no title. */
export const SEARCH_FALLBACKS: PortFallbacks<SearchPort> = {
  touch: undefined, deleteHistory: undefined, session: undefined, stop: undefined,
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
  /** Its transcript: a Claude sub-agent writes its own beside it, which a held turn end watches. */
  transcriptPath?: string
  /** An Orchestrator specialist's turn, or its director's while specialists are out: nobody's news. Said
   *  where a turn ends, a cancel or a forget (reading it reads the orchestrator); absent, the recaps keep
   *  what they were last told. */
  subagent?: boolean
}

/** Who watches this machine's turn cards: a device at all (through the backend or on the cable), and one
 *  rendering this machine right now. */
export interface RecapWatchers { device: boolean; active: boolean }

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
 *  answered unavailable, and a restart or shutdown goes on. */
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
 * What the core gets when models fails: grid set-up and every target answered with an error (a create on
 * a grid model answers GRID_UNAVAILABLE), frames with no note and no prewarm, the private grid as the
 * backend said it or none, and no push of the lists.
 */
export const MODELS_FALLBACKS: PortFallbacks<ModelsPort> = {
  ensure: later(FAIL), annotation: null, prewarm: undefined, launchTarget: later(FAIL), moveTarget: later(FAIL), moved: undefined,
  privateGridName: later(null), lists: later(FAIL), machines: undefined, signedOut: undefined,
}

/** What the core calls while `ports.models` is null (models is off): its fallbacks' answers. */
export const MODELS_OFF: ModelsPort = {
  ensure: () => Promise.reject(new ServiceUnavailableError('models')),
  annotation: () => null,
  prewarm: () => {},
  launchTarget: () => Promise.reject(new ServiceUnavailableError('models')),
  moveTarget: () => Promise.reject(new ServiceUnavailableError('models')),
  moved: () => {},
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

/** The prompt scopes whole: the core's calls, which team a prompt belongs to, recorded as a message is
 *  written, as a turn starts (from its hook or its transcript), as it is typed into a scoped terminal, and
 *  forgotten with its agent; and the team a prompt came from (`current`), which an agent's answer to a
 *  team's question moves back (`replied`). In the core's process the teams service's own; in their own,
 *  core/teamsLink.ts. */
export type PromptScopes = Pick<SwarmPromptScopes, 'prepare' | 'started' | 'raw' | 'forget' | 'current' | 'replied'>

/** The core's calls into the teams: the prompt scopes' records, and whether a team's delivery still holds
 *  the agent's pane, asked in line as its turn is written (core/input.ts). */
export type TeamsPort = Pick<PromptScopes, 'prepare' | 'started' | 'raw' | 'forget'> & {
  canWrite(deliveryId: string): boolean
}

/** What the core gets when the teams fail: the prompt is written with no team recorded for it, and a team's
 *  delivery holds no pane (it waits, unwritten). */
export const TEAMS_FALLBACKS: PortFallbacks<TeamsPort> = { prepare: () => {}, started: undefined, raw: undefined, forget: undefined, canWrite: false }


/** A change to the prompt scopes, as the core tells the teams' own process (core/teamsLink.ts,
 *  services/teamsProcess.ts): numbered within one core's life, stamped with when it happened, and
 *  given to the process in order, once. `raw` bytes travel as base64. */
export type TeamsEvent = { seq: number; core: string; at: number; agentId: string } & (
  | { kind: 'prepare'; text: string; tabId?: string; deliveryId?: string }
  | { kind: 'unprepare'; of: number }
  | { kind: 'started'; text: string; source: 'hook' | 'transcript'; engine?: string }
  | { kind: 'raw'; bytes: string; tabId?: string; pasted: boolean }
  | { kind: 'forget' }
  | { kind: 'replied'; teamId: string; questionId: string }
)

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
  'voice_route_request',
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
export const DEVICES_REQUESTS = ['harness_devices_list', 'harness_device_settings'] as const

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
  card: undefined, desk: undefined, swarms: undefined, unread: undefined, appFocus: undefined, seen: undefined,
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
  receipt: later({ unavailable: true }), stop: later(undefined),
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

/** A remote client the gateway holds a session with, as the core may know it: its role, the label its
 *  identity was paired under (null for none) for naming it to the person, its identity's public key (the
 *  Wi-Fi device's requests are kept apart by it), and whether it is on a device's direct link rather than
 *  the relay. Nothing here is a secret. */
export interface RemoteClient {
  role: RemoteRole
  label: string | null
  identity: string
  direct: boolean
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

/** What the core asks of the gateway: everything bound for a remote client, and the link's state. */
/** What a person has open on this computer: the desktop app, or `harness tui`. Each is its own presence. */
export type WindowSurface = 'desktop' | 'tui'
export type LocalWindows = Record<WindowSurface, number>
export const WINDOW_SURFACES: readonly WindowSurface[] = ['desktop', 'tui']
/** A surface off the core↔gateway pipe: anything but `tui` is the desktop app. */
export const windowSurfaceOf = (value: unknown): WindowSurface => (value === 'tui' ? 'tui' : 'desktop')
/** Window counts off the core↔gateway pipe; anything unreadable is none. */
export const localWindowsOf = (value: unknown): LocalWindows => {
  const counts = (value ?? {}) as Partial<Record<WindowSurface, unknown>>
  const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0)
  return { desktop: count(counts.desktop), tui: count(counts.tui) }
}

export interface GatewayPort {
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
   *  link is down. */
  broadcast(frame: Record<string, unknown>): void
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
  devicesDismiss(body: { pub?: string; pubs?: string[]; baseline?: boolean }): Promise<HttpAnswer>
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

/** Each port is filled by the service that owns it when that service starts, and is null while the
 *  service is off: the core never waits on one. */
export interface CorePorts {
  search: SearchPort | null
  viewers: ViewersPort | null
  models: ModelsPort | null
  workspaces: WorkspacesPort | null
  teams: TeamsPort | null
  devices: DevicesPort | null
  wifi: WifiPort | null
  monitor: MonitorPort | null
  orchestrator: OrchestratorPort | null
  sharing: SharingPort | null
  recaps: RecapsPort | null
}

export function emptyPorts(): CorePorts {
  return { search: null, viewers: null, models: null, workspaces: null, teams: null, devices: null, wifi: null, monitor: null, orchestrator: null, sharing: null, recaps: null }
}

export interface CoreApiDeps {
  terminals?: TerminalsPort
  conversations?: ConversationReads
  dataDir: string
  registry: Pick<typeof registry, 'list' | 'byAgent' | 'resolve' | 'advertised' | 'terminalAvailable'>
  stoppedAgents: Pick<StoppedAgentStore, 'list'>
  databaseHistory: CoreApi['transcripts']['databaseHistory']
  externalSessions: CoreApi['external']['sessions']
  openSessions: CoreApi['external']['open']
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
  observer: CoreApi['clients']['observer']
  privateGridName: CoreApi['account']['privateGridName']
  machineName: CoreApi['account']['machineName']
  backend: CoreApi['account']['backend']
  onNotice: CoreApi['account']['onNotice']
  create: CoreApi['agents']['create']
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
  lastTurn: CoreApi['transcripts']['lastTurn']
  /** Where a turn's cards and recaps go: the devices, and the apps. Only their own frame types reach these. */
  turnCard: CoreApi['clients']['turnCard']
  turnSummary: CoreApi['clients']['turnSummary']
  log?: (line: string) => void
}

export function createCoreApi({
  dataDir, registry, stoppedAgents, databaseHistory, externalSessions, openSessions, syncSession, runtimeModels, viewerChanged,
  gridNamed, gridModelsChanged, dshInstallStatus, mintGridName, accessToken, lane, observerKey, observer, privateGridName, machineName, backend, onNotice,
  runtimeProfile, setRuntime, fork, create, dsh, windows, daemon, turns, questions, terminals = TERMINALS_OFF, conversations = CONVERSATIONS_OFF, viewerFrame, machine, activityText,
  signedIn, environment, machines, sendLocal, sendToWindow, hasWindow, devicesChanged, dialWatching, wifi, lastTurn, turnCard, turnSummary,
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
      live: () => registry.list(),
      displayName: projectDisplayName,
      byAgent: (agentId) => registry.byAgent(agentId),
      resolve: (id) => registry.resolve(id),
      advertised: () => registry.advertised(),
      terminalAvailable: (agentId) => registry.terminalAvailable(agentId),
      sync: syncSession,
      runtimeModels,
      runtimeProfile,
      setRuntime,
      fork,
      create,
      dsh,
      activityText,
    },
    turns,
    questions,
    transcripts: { databaseHistory, lastTurn },
    external: { sessions: externalSessions, open: openSessions },
    account: { mintGridName, accessToken, lane, observerKey, privateGridName, machineName, backend, onNotice, signedIn, environment, machines },
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
  }
}
