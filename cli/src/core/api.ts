import { startSettledRecords, QUESTION_OBSERVATION_BYTES, QUESTION_OBSERVATION_TIMEOUT_MS } from './questionObservation.js'
import { boundedJsonBytes } from '../lib/boundedJsonBytes.js'
import type { LocalWindowPermissions } from '../harnessd/services.js'
import type { ClientStreamQuota } from '../lib/clientStreamQueue.js'
import type { ProductUsageMetric } from '../lib/productUsageContract.js'
import type { PreparedHandoff, HandoffPermit, HandoffOutcome } from '../lib/handoffAuthority.js'
import type { AgentTokenUsage, AgentUsageTarget } from '../lib/agentUsageWire.js'
import { OWNER_DOWN, OWNER_REPLY_DOWN, OWNER_ANSWER_DOWN, type SessionOwnerCore, type SessionOwnerPort, type ServiceSessionRow } from '../lib/sessionOwnerWire.js'
import type { SharedTrustPeer } from '../lib/sharedMachinesAccount.js'
import type { GridAssignmentProcess, GridAssignmentAnswer } from '../lib/gridAssignmentWire.js'
import type { QuestionAnswerResult } from '../lib/questionController.js'
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
import type { ObservedEvent } from './observedHook.js'
import type { AppSwarms } from '../cable/cableSession.js'
import type { UnreadNotification } from '../lib/notificationRead.js'
import type { AutonomousDeviceDelivery } from '../lib/autonomous-device/service.js'
import type { DshContextAnswer, DshDescribeAnswer, DshDescribeRequest, DshLaunchRequest, DshMaterializeAnswer, DshMaterializeRequest } from '../dsh/launchWire.js'
import type { AgentDshContext, AgentFacts } from '../lib/agentFrame.js'
import type { createHarnessResourcesReader } from '../lib/harnessResources.js'
import type { createHarnessStorageReader } from '../lib/harnessTelemetry.js'
import type { AgentGridTarget, GridAnnotation } from '../lib/gridAnnotation.js'
import { HACHI_ID } from '../dsh/builtinIds.js'
import { GRID_FLEET_MAX_TIMEOUT_MS } from '../lib/gridFleetProtocol.js'
import type { GridLaunchOverride, GridLaunchRequest } from '../lib/gridLaunchWire.js'
import type { NewAgentModel } from '../lib/newAgentModel.js'
import type { LastTurnText, LiveEvent } from '../engines/kit/events.js'
import type { SessionRecaps } from '../lib/recapReads.js'
import type { SessionInputDelivery, SessionInputProgress } from '../lib/sessionInput.js'
import type { AgentCloseRequest, AgentCloseResult } from '../lib/closeAgentService.js'
import type { GitProjectFolder } from '../lib/projectFolder.js'
import type { WorkspaceInspection, WorkspaceTarget, WorktreeReview } from '../lib/worktreeDeletion.js'
import type { ScmLaunchRecord } from '../scm/types.js'
import { projectDisplayName, type registry, type RegisteredSession } from '../lib/registry.js'
import { sessionForPaneId } from '../lib/terminalRuntime.js'
import type { RuntimeModelOption } from '../lib/runtimeProfile.js'
import { externalUnavailable, type ExternalSessionAnswer, type ExternalSessionRequest } from '../lib/externalSessionWire.js'
import type { SessionSearchIndex } from '../lib/sessionSearch/indexer.js'
import type { StoppedAgentStore } from '../lib/stoppedAgents.js'
import type { TerminalBinaryClear } from '../lib/terminalBinary.js'
import type { DeviceHookPort } from './deviceHookCalls.js'
import { FAIL, later, readFallback, ServiceUnavailableError, type PortFallbacks } from './serviceHost.js'
export { SERVICE_REQUESTS_MAX } from './serviceHost.js'

/** The mod's poll, as the core hands it to the devices: a service reads these types here alone. */
export type { DeviceHookPort, InboxAnswer, InboxPoll } from './deviceHookCalls.js'
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

/** Agent metadata a service may read; the saved credential belongs to launch/restore authority. */
export type AgentView = Omit<RegisteredSession, 'gridLaunch'> & { /** Ephemeral authority for this run, only for a frame publisher. */ readonly frameEpoch?: string }

/** Always copy: a row without a key now may acquire one after an inline service retains its view. */
export function agentView(session: RegisteredSession): AgentView {
  const { gridLaunch: _gridLaunch, ...view } = session
  return view
}

/** Fixed private records avoid repeating property names and equal package strings for every member. */
export type SessionReadLaunch = readonly [state: 'starting' | 'ready']
  | readonly [state: 'failed', error: string, detail: string | false]
  | readonly [state: 'held', service: string, detail: string]
export type SessionReadRegistered = readonly [source: 'registered', agentId: string, sessionId: string, engine: string,
  registeredAt: number, transcriptPath: string | null, lastHookAt: number, active: boolean, cwd: string | null,
  storedDsh: string | null | false, launch: SessionReadLaunch | null, displayName: string, terminalAvailable: boolean,
  selectedModel: string | null, turnRunning: boolean,
  /** false: absent; true: exactly the stored string; otherwise the distinct published string. */ publishedDsh: string | boolean]
export type SessionReadService = readonly [source: 'service', agentId: string, sessionId: string, engine: string,
  registeredAt: number, transcriptPath: string | null, lastHookAt: number, displayName: string, selectedModel: string | null]
export interface SessionReadHeader {
  version: 2
  machine: { id: string; computerId: string; name: string }
  signedIn: boolean
  environment: string
  hasWindow: boolean
}
export type SessionReadValue = SessionReadRegistered | SessionReadService
  | readonly [kind: 'gone', source: 'registered' | 'service', agentId: string]
export type ReadRecord<Header = Record<string, unknown>, Row = Record<string, unknown>> =
  | { type: 'begin'; payload: { header: Header; count: number } }
  | { type: 'row'; payload: { index: number; value: Row } }
  | { type: 'end'; payload: { count: number } }
export type ReadReceiver<Header = Record<string, unknown>, Row = Record<string, unknown>> =
  (record: ReadRecord<Header, Row>, settled: (sent: boolean) => void) => boolean
export type SessionReadScope = 'registered' | 'advertised'
export type SessionReadReceiver = ReadReceiver<SessionReadHeader, SessionReadValue>
/** Provisional logical retention budgets, separate from actual transport credits and measured heap cost. */
export const SESSION_READ_MEMBERS_BYTES = 8 * 1024 * 1024
export const SESSION_READ_HEADER_BYTES = 64 * 1024
export const SESSION_READ_VIEW_BYTES = 64 * 1024 * 1024
export const SESSION_READ_OFF = async (): Promise<void> => { throw new Error('SESSION_READ_UNAVAILABLE') }


/** Read-only conversation facts for the handoff in the edge host. Each lookup asks the core now;
 * a stopped record is never replaced by a stale live-agent list in another process. */
export interface ConversationReads {
  publish(prepared: PreparedHandoff, permit: HandoffPermit): Promise<HandoffOutcome>
  /** A live agent by agent/session id, otherwise the stopped record by agent id. */
  resolve(id: string): Promise<AgentView | null>
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

/** What `hachi_goal_done` tells the windows: Hachi's harness (the pane in view gets no notice), the goal and its title. */
export interface HachiGoalDone { agentId: string; goalId: string; title: string }
/** The longest title a goal keeps (services/goals.ts `GOAL_TITLE_MAX`), and so the longest a notice carries. */
export const HACHI_GOAL_TITLE_MAX = 80

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
    all(): Promise<AgentView[]>
    /** The live agents. */
    live(): AgentView[]
    /** Complete facts for the selected existing membership; rejects when unavailable or too large. */
    readSessions(scope: SessionReadScope, receive: SessionReadReceiver, signal?: AbortSignal): Promise<void>
    /** Current registered display facts; unavailable without their owning core's synchronous reader. */
    facts(session: RegisteredSession): AgentFacts | null
    /** The name the apps show for an agent. */
    displayName(session: RegisteredSession): string
    /** A live agent, by its agent id. */
    byAgent(agentId: string): AgentView | undefined
    /** A live agent, by its agent id or its engine session id: whichever the apps asked by. */
    resolve(id: string): AgentView | undefined
    /** The live agents the apps are shown. */
    advertised(): AgentView[]
    /** Declared service-owned sessions, with no native terminal, transcript or filesystem authority. */
    serviceSessions?(): ServiceSessionRow[]
    /** Whether the agent's terminal is attached: a frame without one reads to the apps as "agent gone". */
    terminalAvailable(agentId: string): boolean
    /** Send the agent's frame to the apps again. */
    sync(session: RegisteredSession): void
    /** Replace this service's declared display fields for the exact followed run. */
    publishFrame?(session: AgentView, fields: Readonly<Record<string, unknown>>): void
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
     *  (`SESSION_NOT_IDLE`), and one that still runs background commands (with `backgroundCommands`) until
     *  [pastCeiling], when it is closed whatever runs and the count comes with it; `now` does not. Any other harness is
     *  refused (`NOT_AGENT_STARTED`): the agent cleanup (services/agentCleanup.ts) closes those, and nothing else. Only
     *  the cleanup reaches this (from its own process through core/agentCleanupLink.ts), so no client can name the
     *  ceiling. Absent where the core does not let a service close. */
    closeStarted?(agentId: string, mode: 'idle' | 'now', pastCeiling?: boolean): Promise<AgentCloseResult>
    /** When a live agent's conversation last moved, epoch ms: the latest dated work in its transcript
     *  (lib/transcriptActivity.ts), what the apps' `updatedAt` is when there is one. Null for none live, and for an
     *  engine that keeps no dated transcript: a hook's time or the bind's is not when it last answered. Absent where
     *  the core is not asked it. */
    lastActivity?(agentId: string): Promise<number | null>
    /** Hear what happens to agents (core/agentLife.ts): told at once every live agent it follows, then each change as it
     *  happens. Returns how to stop hearing. Absent where the core or a process offers it none. */
    follow?(listener: (event: AgentLife) => void, options?: FollowOptions): () => void
    /** The live agent whose terminal is the pane [pane] (`$TMUX_PANE`, `$HARNESS_PANE`), and whether it is a guest's,
     *  or null: `harness browser` in an agent's pane names it so. With [ancestors] (the command's parents' pids), null
     *  unless the pane's own process, read from the daemon's terminal backend, is among them: pane ids restart in every
     *  tmux server, so a private server's pane of the same id is another agent's (re-check 2 of #2093). Without them,
     *  the pane's agent as before, for the `browser-mcp` relays still running (`agent_browser_state`). Delete that on or
     *  after 2026-12-18: 30 days after the CLI release that took the relay away (assumed by 2026-11-18; whoever
     *  releases later moves the date). Absent where the core is not asked it. */
    ofPane?(pane: string, ancestors?: number[]): Promise<{ agentId: string; guest: boolean } | null>
  }
  /** A fixed-name product counter (`GatewayPort.usageCounter`): no id, URL, host, reason or content. Absent where the
   *  core offers a service none. */
  count?(metric: ProductUsageMetric): void
  /** A device's or another machine's turns for an agent on this one: the doors the web and the hooks use. */
  turns: {
    /** Exact open-turn state; absent outside the owning core, never inferred from an activity lease. */
    running?(sessionId: string): boolean
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
    deliver(agentId: string, text: string, deliveryId: string, options?: DeliveryOptions): void
    /** Take back a delivery not yet being written: true when it was, and it never will be; false for one
     *  the agent's pane is already taking. Answered at once, as the orchestrator reads it in
     *  line: in a service's own process the core is asked and the answer cannot wait, so it is false there,
     *  and a delivery the core did take back is then heard `rejected` (`cancelled`). */
    cancelDelivery(deliveryId: string): boolean
    /** Hear what becomes of each delivery: queued, written, its turn started, refused and why, or past
     *  knowing. Returns how to stop hearing. */
    onDelivery(listener: (event: TurnDelivery) => void): () => void
    /** Bounded input facts, without promising a correlated turn from composer evidence. */
    onInput?(listener: (event: SessionInputProgress) => void): () => void
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
    /** Whether account connector sharing is enabled, and a bounded explicit synchronization. */
    connectorSync: ConnectorSync
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
    /** The component's scoped stream adapter; an unscoped API cannot send a stream frame. Core derives the
     *  recipient from its private grant and restores public IDs only at the client's transport. */
    streamFrame(connId: string, type: string, payload: Record<string, unknown>): boolean
    /** An already framed stream payload, forwarded unchanged through the same service scope. */
    streamBytes?(frame: Uint8Array): boolean
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
    /** A declared frame to local windows. The owning service selects all, first or one physical connection.
     *  Acceptance is a handoff, not the app's acknowledgement; unscoped APIs cannot send. */
    sendWindow(delivery: LocalWindowDelivery): boolean
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
    /** A goal the live Hachi harness closed (`harness goal done`, services/goals.ts): one `hachi_goal_done` for every
     *  window of the account, here and on its other computers, which shows its one notice (docs/design/2026-11-12-hachi.md,
     *  "How it tells the person"). Sealed for the relay: the title is the person's words (lib/e2ee/manager.ts). Only the
     *  live Hachi's, decided by the core (`createCoreApi`). Absent where the core offers a service none. */
    hachiGoalDone?(notice: HachiGoalDone): void
  }
  /** How an agent's shell reaches this daemon: the command that runs this harness's CLI, the port the daemon
   *  serves and the machine it serves as. An experiment writes them into the prompts of the agents it runs
   *  (`… orchestrator --port 18473 --machine …`). */
  daemon: DaemonAddress
  /** Bound only by the host to the current authenticated service instance. */
  owners?: SessionOwnerCore
}

/** An ID-only session create for components; launch identity stays with the core. */
export interface AgentCreateRequest {
  engine: AgentEngine
  cwd: string
  /** The harness to create it as, installed here; null for the engine alone. */
  dsh: string | null
  /** The message it opens with, already submitted. */
  prompt: string | null
  name: string | null
  bypassPermission: boolean
  /** Current registered workspace absence, rechecked before native dispatch; not a pending reservation. */
  requireUnusedWorkspace?: true
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

/** Metadata-only account synchronization; connector credentials remain inside the gateway. */
export type ConnectorSync = (refresh: boolean) => Promise<{ shared: boolean }>
export const CONNECTOR_SYNC_OFF: ConnectorSync = async () => { throw new Error('CONNECTORS_SYNC_UNAVAILABLE') }

/** A service in its own process that acts on no agent: it creates none and reads no harness's frame. */
export const AGENT_ACTIONS_OFF: Pick<CoreApi['agents'], 'readSessions' | 'create' | 'dsh' | 'facts'> = {
  readSessions: SESSION_READ_OFF,
  create: async () => ({ ok: false, error: 'SERVICE_UNAVAILABLE' }),
  dsh: () => null,
  facts: () => null,
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
export const ACCOUNT_BACKEND_OFF: Pick<CoreApi['account'], 'backend' | 'identity' | 'onNotice' | 'observerKey' | 'tabKey' | 'tabRelay' | 'connectorSync'> = {
  backend: async () => ({ status: 503, body: { error: 'SERVICE_UNAVAILABLE' } }),
  identity: async () => null,
  onNotice: () => () => {},
  observerKey: OBSERVER_KEY_OFF,
  tabKey: TAB_KEY_OFF,
  tabRelay: TAB_RELAY_OFF,
  connectorSync: CONNECTOR_SYNC_OFF,
}

/** Where a service that was never told runs this daemon from: the installed CLI, on no port it knows. */
export const DAEMON_UNKNOWN: DaemonAddress = { command: 'harness', port: 0, machineId: () => '', autonomousEnv: 'prod' }

/** How a delivery is told apart: `quiet` marks a line a service types for the agent alone: the turn it starts is nobody's
 *  news, and ends with no recap and no notification (core/deliveries.ts, core/turns/recaps.ts). */
export interface DeliveryOptions {
  quiet?: true
  when?: 'composer' | 'turn'
  /** Core-owned connection authority. The wire contract never accepts this member. */
  current?: () => boolean
}

/** What became of a delivered turn (`turns.deliver`), as the core's input says it: `queued`, written
 *  (`delivered`), its turn `started`, `rejected` with why, or `unknown`. `sessionId` is the agent it was
 *  delivered to, as the delivery named it. */
export type TurnDelivery = SessionInputDelivery

/** The delivery members of a core that delivers nothing for this service: nothing is written, nothing is taken back, and
 *  nothing is heard. */
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
export function resolveAgent(agents: readonly AgentView[], id: string): AgentView | undefined {
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
  /** A declared frame alias routed by core/serviceRoutes, never a field a client supplied. */
  rpcRoute?: true
  /** It came through the local door over the daemon's own socket (on Windows its pipe, with the token's proof), where
   *  the filesystem said it is this computer's owner: set by the door (core/serviceRoutes.ts), never by a payload, and
   *  never for a client of the local WebSocket. A route only that socket may ask (`ServiceHttpRoute.door`) is refused
   *  without it. */
  door?: 'socket'
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
/**
 * The agent browser (services/agentBrowser.ts): whether Browser can run here, setting it up (this computer only), a
 * browser's state for the MCP relay of an agent launched before the browser moved to its chat (this computer only),
 * its person's Start and Stop, Retry, the settings and the size of Chrome's window (the machine's own person only,
 * checked by its service), and the agent's own commands, from `harness browser` in its pane (this computer only).
 */
export const AGENT_BROWSER_REQUESTS = ['agent_browser_available', 'agent_browser_setup', 'agent_browser_retry',
  'agent_browser_state', 'agent_browser_settings', 'agent_browser_settings_save', 'agent_browser_proxy_test',
  'agent_browser_start', 'agent_browser_stop', 'agent_browser_run', 'agent_browser_window'] as const
/** The project and folder readers (services/projects.ts). */
export const PROJECTS_REQUESTS = ['git_pull_request', 'git_pull_requests_status', 'git_project_info', 'scm_project_info', 'project_preview', 'fs_list_dir', 'agent_read_file'] as const
/** A window's name for its repo and its work, by a small model in the background (services/windowNames.ts). */
export const WINDOW_NAMES_REQUESTS = ['window_name'] as const
/** Which engines this machine has, asked before a create (services/engineProbe.ts). */
export const ENGINE_PROBE_REQUESTS = ['engines_probe'] as const
/** Hachi's goals (`harness goal`, services/goals.ts), in the edge host: asked by the Hachi harness alone. */
export const GOALS_REQUESTS = ['goal_open', 'goal_add', 'goal_done', 'goal_list'] as const
/** Change agent's handoff file, prepared in the edge host (services/handoff.ts), and the conversation itself moved
 *  between Claude Code and Codex there (services/sessionMigrate.ts). */
export const HANDOFF_REQUESTS = ['agent_handoff_prepare', 'agent_handoff_complete', 'agent_session_migrate'] as const
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
 *  the engine as the guest's own OS user on the guest's own sign-in, the variables to set on the pane, and
 *  `workspace`, where it starts (the guest's workspace or a folder the owner shares). The core opens it and
 *  records whose it is (core/agents/guestCreate.ts).
 *
 *  `guestHostUser` is set where the pane must be made by the guest's own host rather than this account (Windows:
 *  lib/windows/guestHostBackend.ts), whose panes already run as that user; its absence means the owner's backend
 *  starts the pane and a helper hands it to the guest (macOS, Linux). */
export type GuestLaunch =
  | { ok: true; workspace: string; argv: string[]; env: Record<string, string>; guestHostUser?: string }
  | { ok: false; error: string; detail?: string }

/** The core's call into shared machines: a guest's launch (docs/plans/2026-10-19-guest-machine-sharing-plan.md). */
export interface SharedMachinesCorePort {
  /** Untrusted contribution; createGuestCreate checks it against the captured guest request before any effect. */
  guestLaunch(input: GuestLaunchInput): Promise<unknown>
  /** The service stopping: its reads stop. */
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
 *  read what it published and propose to it, each proposal stamped with the machine it came from; and its own
 *  service's routes of the door (`SERVICE_HTTP_ROUTES`). */
export const MACHINE_ADDON_REQUESTS = ['machine_addon', 'machine_addons_http'] as const
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
  'grid_models_list', 'models_list', 'grid_launch_context',
  'grid_fleet_models_list', 'grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop',
  'grid_fleet_run', 'grid_fleet_cancel',
  'api_connections', 'codex_profiles_list', 'codex_profile_link',
  'claude_profiles_list', 'claude_profile_link',
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
 *   hands it this machine's sign-in and makes the account's grid: a Set up, a Get, a Use and
 *   a move onto a grid model (`moveTarget`) each wait for it.
 * - Package context waits eight seconds for setup, then reads the private Grid name.
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
    grid_launch_context: 3 * MINUTE, moveTarget: 15 * MINUTE,
    launchTarget: 3 * MINUTE, privateGridName: 2 * MINUTE, lists: 2 * MINUTE,
  },
  store: { dsh_install: 30 * MINUTE, dsh_update: 30 * MINUTE, dshMaterialize: 6 * MINUTE, dshContext: 3 * MINUTE },
  // A cloud agent's maker answers on its own time: Fo's reply waits 40 s, and a busy Fo is retried for half a
  // minute more. A wait shorter than that said "not running" of words that were then sent anyway.
  cloud: { create: 3 * MINUTE, deliver: 3 * MINUTE, answer: 3 * MINUTE, stopHarness: 2 * MINUTE, cloud_send: 3 * MINUTE },
  // A guest's first harness makes their OS account (`dscl`, a home); turning guest access on waits on the
  // owner at the admin prompt, which gives up after ten minutes (lib/guestHelperInstall.ts).
  sharedMachines: { guestLaunch: 2 * MINUTE, shared_machines: 11 * MINUTE },
  // An agent's browser command runs up to 70 s (navigation's 60 s and the 10 s the service gives a call more), after
  // those before it, and `harness browser` waits at most 75 s: the core waits longer, so the agent reads its own
  // `<command> timed out` rather than an unavailable service.
  agentBrowser: { agent_browser_run: 80_000 },
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
/** A UUID as `randomUUID` and the backend write one: an invitation's id, a share's and a link's. */
const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'
/** A backend route a service in its own process may call through the core's sign-in: one method and a whole path. */
export interface BackendRoute { method: string; path: RegExp }
const routeAllowed = (routes: readonly BackendRoute[], method: unknown, path: unknown): boolean =>
  typeof method === 'string' && typeof path === 'string' && routes.some((r) => r.method === method && r.path.test(path))
const route = (method: string, path: string): BackendRoute => ({ method, path: new RegExp(`^/api/agent-messages${path}$`) })
/**
 * The backend routes Agent Messages in its process may call through the core's sign-in (`backend`), by method and
 * whole path, and no others (backend/src/routes/agentMessages.ts). Its process holds no credential: the core signs
 * each call, so a route left open here is a route any code in that process could call as the account. Anchored, and
 * each id held to the shape the backend gives it, so that no path climbs out (`..`), carries a query or names another
 * route. Shared tabs' were refused by the one GET this allowed before, which left every share action failing in the
 * edge host, where Agent Messages runs.
 */
export const MESSAGES_BACKEND_ROUTES: readonly BackendRoute[] = [
  route('GET', ''),
  route('GET', '/shares'),
  route('PUT', `/shares/${DESK_TAB}/roster`),
  route('POST', `/shares/${SHARED_TAB}/invites`),
  route('GET', '/invites'),
  route('DELETE', `/invites/${UUID}`),
  route('POST', `/invites/${UUID}/accept`),
  route('DELETE', `/shares/${SHARED_TAB}/members/${USER}`),
  route('DELETE', `/shares/${SHARED_TAB}`),
  route('POST', `/shares/${SHARED_TAB}/move`),
  // A desk tab's setting: its leader, which the person chooses for a shared tab from any computer of the account
  // (sharedTabs.ts `setLeader`). The computer that shares the tab signs the roster that follows it.
  route('PATCH', `/tabs/${DESK_TAB}`),
]
/** Whether Agent Messages in its process may make this backend call (`MESSAGES_BACKEND_ROUTES`). */
export const messagesBackendAllowed = (method: unknown, path: unknown): boolean => routeAllowed(MESSAGES_BACKEND_ROUTES, method, path)
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
 * core asks for it (harnessd/services.ts `onDemand`), or the edge startup component finds its saved state.
 * This contract declares requests; saved paths and startup inspection belong to the component.
 * Off, it has no process and none of its code is loaded anywhere. Each may act on the core through the hooks
 * an experiment has (core/experimentQueries.ts, core/deliveries.ts), and no other process may.
 *
 * Adding one: its service (`start<Name>(core, ports)`, returning its requests' handlers) and its process's
 * runner (`SERVICE_RUNNERS`, src/serviceProcess.ts); its process (`SERVICE_HOSTS`, `onDemand: true`); its
 * entry here; the backend routes it may call (`EXPERIMENT_BACKEND_ROUTES`, `[]` for none); and its start for the
 * core's own process (services/inline.ts `EXPERIMENT_STARTS`). Removing one is deleting those.
 */
export const EXPERIMENTS: Readonly<Record<string, { requests: readonly string[] }>> = {
  orchestrator: { requests: ORCHESTRATOR_REQUESTS },
  // Its invitations and links: a harness was shared from here. Or a shared tab held here (Agent Messages' file): the
  // observers its members are granted are derived and renewed by Share, and taken back once one leaves.
  sharing: { requests: SHARE_REQUESTS },
  // Request-only, on from its first request until the daemon stops: another machine's Memories pane asks, and
  // the package's own files are its state.
  memory: { requests: MEMORY_REQUESTS },
  // Request-only too: it keeps nothing, and asks Jev only when a client asks it.
  router: { requests: ROUTER_REQUESTS },
  // Cloud agents. Its harnesses: one was started here, and is watched again as the daemon starts. A New Harness
  // for one, an answer or a message to one wakes it too (its declared session port).
  cloud: { requests: CLOUD_REQUESTS },
}

const each = (methods: readonly string[], path: RegExp): BackendRoute[] => methods.map((method) => ({ method, path }))
/**
 * The backend routes each experiment in its process may call through the core's sign-in (`backend`,
 * core/experimentQueries.ts), and no others. Its process holds no credential: the core signs each call, so a route left
 * open here is a route any code in that process could call as the account. Until the audit of 2026-11-12 every path
 * under `/api/` was signed for every experiment, so a process that reads other accounts' text could have read the
 * account's device keys or the vault of its connected services.
 * - Share: a grant's and a link's publication and removal, each by its id (sharing/owner.ts).
 * - The router: Jev's hosted decision (lib/jev/jevClient.ts).
 * - The orchestrator, Memories and cloud agents call none.
 * A new experiment declares its routes here, if only `[]` (core/experimentQueries.spec.ts).
 */
export const EXPERIMENT_BACKEND_ROUTES: Readonly<Record<string, readonly BackendRoute[]>> = {
  sharing: [
    ...each(['PUT', 'DELETE'], new RegExp(`^/api/harness-shares/${UUID}$`)),
    ...each(['PUT', 'DELETE'], new RegExp(`^/api/harness-links/${UUID}$`)),
  ],
  router: [{ method: 'POST', path: /^\/api\/route\/jev$/ }],
  orchestrator: [],
  memory: [],
  cloud: [],
}
/** Whether [service], an experiment in its process, may make this backend call (`EXPERIMENT_BACKEND_ROUTES`). */
export const experimentBackendAllowed = (service: string, method: unknown, path: unknown): boolean =>
  routeAllowed(EXPERIMENT_BACKEND_ROUTES[service] ?? [], method, path)

/** The services that may write turns into agents from a process of their own (core/deliveries.ts): the experiments,
 *  Agent Messages, which left them for the edge host and still types a message into an idle agent, and the agent
 *  browser, which types its two lines into an agent when its person starts and stops its browser. No other process
 *  may: writing into a pane is no other service's to ask. */
export const TURN_DELIVERERS: readonly string[] = [...Object.keys(EXPERIMENTS), 'messages', 'agentBrowser', 'wifi']

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

/** The core's calls into session search: index a session at its turn boundaries, the title it indexed for one
 *  being adopted, and stopping its sweeps. A purged conversation it forgets as it hears it (`AgentLife` `purged`).
 *  The apps' own requests (`session_search`, `session_tail`) are its `ServiceRequests`, not the core's calls. */
export type SearchPort = Pick<SessionSearchIndex, 'touch' | 'session' | 'stop'> & {
  inspect(request: ExternalSessionRequest): Promise<ExternalSessionAnswer>
}

/** What the core gets when search fails: nothing indexed and no title. */
export const SEARCH_FALLBACKS: PortFallbacks<SearchPort> = {
  touch: undefined, session: undefined, stop: undefined, inspect: later(externalUnavailable()),
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

/** Raw session failure facts; presentation belongs to the lifecycle consumer. */
export interface SessionFailure {
  agentId: string
  sessionId: string
  engine?: string
  message: string
  failureSummary?: string
}

/** The most lifecycle data allowed to wait for the recaps component. */
export const RECAPS_BUFFER_LIMIT = 4 * 1024 * 1024

/** The turn lifecycle, as the core tells the recaps. */
export type TurnLifecycle =
  | { kind: 'failure'; failure: SessionFailure }
  /** A session's events (a turn started, its text, its tools and sub-agents, its end), as one batch. `quiet`: the turn
   *  that ends in this batch was started by a quiet delivery (`DeliveryOptions.quiet`); absent from an older core. */
  | { kind: 'events'; session: RecapSession; events: LiveEvent[]; replay: boolean; quiet?: true }
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
  stop(): Promise<void>
}

/** What the core gets when the recaps fail: nothing told, no recap, and no live card. */
export const RECAPS_FALLBACKS: PortFallbacks<RecapsPort> = { lifecycle: undefined, recaps: null, liveCards: later([]), stop: later(undefined) }

/**
 * The core's calls into the agent cleanup (services/agentCleanup.ts): what happens to the harnesses agents start.
 * Accepted person input is shared through AgentLife; the cleanup retains joined protection in its own process. A
 * harness closed or stopped it hears as every service that follows agents does (`AgentLife` `stopped`), and closes
 * the harnesses that one started.
 */
export interface AgentCleanupPort {
  /** A harness is being deleted: the agent ledger's lines that keep the opening words of what it was told
   *  (`harness tell`) are erased. The one answer a delete waits for here, and for a bounded time: false when they were
   *  not erased, which refuses the delete. The ledger is the agent clients' file, read and locked by the cleanup and
   *  never by the core, whose loop its lock could hold for two seconds (the audit of 2026-11-12). */
  forgetTold(agentId: string): Promise<boolean>
  stop(): void
}
/** What the core gets when the cleanup fails: nothing told, every harness left open, as before it, and no delete of a
 *  harness whose told lines it could not erase. */
export const AGENT_CLEANUP_FALLBACKS: PortFallbacks<AgentCleanupPort> = { forgetTold: later(false), stop: undefined }

/**
 * What happens to agents, as the core tells the services that follow them (core/agentLife.ts, `CoreApi.agents.follow`):
 * one shape, where each service had a port member of its own (the viewers' attach and detach, the agent cleanup's
 * `closed`, search's purged conversations, the agent browser's attached, stopped, deleted and moved).
 */
export type AgentLife =
  /** A live agent here, as the core looked at it: created, forked, resumed, restored at a start, or seen by a scan. */
  | { kind: 'running'; session: AgentView }
  /** It stopped running here: a stop or any other forget, or its engine's own exit. Told to a follower that was told it
   *  running. */
  | { kind: 'ended'; agentId: string }
  /** First accepted person input on a controlling terminal stream; a takeover/reopen supplies a new source. */
  | { kind: 'input'; agentId: string; startedByAgent: boolean; source?: { connection: string; clientKind: string | null } }
  /** A person or an agent stopped it (`agent_close`, Stop Harness, `harness close`, a purge), told once the stop is done,
   *  never while it can still fail. */
  | { kind: 'stopped'; agentId: string }
  /** Deleted for good, with every conversation it had: [sessionIds], the engine's ids of them. */
  | { kind: 'purged'; agentId: string; sessionIds: string[] }
  /** A new agent, [to], took the pane [from] ended in (decision 19). [guest]: [to] is a guest's. */
  | { kind: 'taken'; from: string; to: string; guest?: true }

/** How a follower hears agents run and end (`running`, `ended`). The other kinds it hears whatever it asks. */
export interface FollowOptions {
  /** Receive an ephemeral publication lease on each followed view; no lease is written to the registry. */
  frames?: boolean
  /** Told `running` at every look at an agent, as a harness's viewer is attached; else once each time it starts
   *  running here. */
  each?: boolean
  /** Only the agents whose row has each of these fields set (the viewers: `dsh`). At most `FOLLOW_HAVING_MAX`. */
  having?: readonly string[]
  /** false: never told `running` or `ended` (search, the agent cleanup). */
  running?: boolean
}
/** The most fields a follower may ask an agent's row to have. */
export const FOLLOW_HAVING_MAX = 4
/** The kinds a service in its own process must not miss while it is down: held for it until it hears them, for the
 *  services its process says hear them (harnessd/services.ts `hears`). */
export type { HeldAgentLife } from '../harnessd/services.js'

/** The core's calls into the DSH viewers: each harness agent's viewer server and verdict watch. Which agents have
 *  one they hear as every service that follows agents does (`AgentLife`, `VIEWERS_FOLLOW`). */
export interface ViewersPort {
  /** Where the windows' viewer pane for the agent forwards to. */
  forwardingUrl(agentId: string): string | null
  /** Stop every viewer and watch, for a restart or a shutdown. */
  stop(): Promise<void>
  /** A client's `viewer_surface`: a frame of a viewer rendered for it by a headless browser, or why not. */
  surface(connId: string, payload: Record<string, unknown>): Promise<Record<string, unknown>>

}

/** How the viewers follow agents (core/agentLife.ts), in their process and in the core's: each agent with a harness at
 *  every look at it, as its viewer was attached, since a look may be the first to find its harness and a viewer follows
 *  its harness's update; and its end. */
export const VIEWERS_FOLLOW: FollowOptions = { each: true, having: ['dsh'], frames: true }

/** What a client is told for a surface the viewers cannot render while they are off or failing. */
export const VIEWERS_UNAVAILABLE = { error: 'SERVICE_UNAVAILABLE', service: 'viewers', retryable: true }

/** What the core gets when the viewers fail: no new forwarding target, a client's stream is refused by the shared relay and its surface
 *  answered unavailable, and a restart or shutdown goes on. Their process on demand, before it has
 *  first connected, holds a stream and a surface while it starts instead (core/viewersLink.ts). */
export const VIEWERS_FALLBACKS: PortFallbacks<ViewersPort> = {
  forwardingUrl: null, stop: later(undefined),
  surface: later(VIEWERS_UNAVAILABLE),
}

/**
 * The core's calls into models (grid). Everything an agent's launch, its frame or a keystroke to it needs
 * of grid, so the core never loads grid's code (docs/design/2026-10-06-core-boundary-next.md, step 7):
 * in the core's process the service answers itself; in its own, core/modelsLink.ts does, from what the
 * service last told it for what a frame or a keystroke reads, and by asking it for the rest.
 */
export interface ModelsPort {
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
  /** Untrusted contribution; gridLaunchThrough checks and detaches it in both process and inline modes. */
  gridLaunch(request: GridLaunchRequest): Promise<unknown>
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
  annotation: null, prewarm: undefined, launchTarget: later(FAIL), moveTarget: later(FAIL), moved: undefined,
  gridAssignments: later(FAIL), gridLaunch: later(FAIL), apiTarget: later(FAIL), privateGridName: later(null), lists: later(FAIL), machines: undefined, signedOut: undefined,
}

/** What the core calls while `ports.models` is null (models is off): its fallbacks' answers. */
export const MODELS_OFF: ModelsPort = {
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

/** Upload preparation only. The stream keeps terminal authority; the worker owns bodies and clipboard work. */
export interface PasteUpload {
  generation: string
  connection: string
  streamId: string
}
export interface PasteBegin extends PasteUpload { kind?: 'image' | 'file'; filename: string; totalBytes: number }
export type PasteArtifact = { name: string; version: string }
export interface PasteClipboardRequest extends PasteUpload { artifact: PasteArtifact; corePid?: number }
export type PasteClipboardResult = { state: 'written' } | { state: 'failed' | 'unavailable'; reason: string }
export type PasteResult = { error: string } | { ignored: true }
  | { bytesWritten: number; totalBytes: number; artifact?: PasteArtifact }
export interface PastePort {
  begin(request: PasteBegin): Promise<{ accepted: true } | { error: string }>
  chunk(request: PasteUpload & { seq: number }, bytes: Uint8Array): Promise<PasteResult>
  clipboard(request: PasteClipboardRequest): Promise<PasteClipboardResult>
  releaseClipboard(generation: string, corePid?: number): void
  cancel(generation: string | null): void
  stop(): void | Promise<void>
}
export const PASTE_REQUESTS = [] as const
export const PASTE_OFF: PastePort = {
  begin: async () => ({ error: 'PASTE_UNAVAILABLE' }),
  chunk: async () => ({ error: 'PASTE_UNAVAILABLE' }),
  clipboard: async () => ({ state: 'unavailable', reason: 'PASTE_UNAVAILABLE' }),
  releaseClipboard: () => {},
  cancel: () => {}, stop: () => {},
}
export const PASTE_FALLBACKS: PortFallbacks<PastePort> = {
  begin: later({ error: 'PASTE_UNAVAILABLE' }), chunk: later({ error: 'PASTE_UNAVAILABLE' }),
  clipboard: later({ state: 'unavailable', reason: 'PASTE_UNAVAILABLE' }), releaseClipboard: undefined,
  cancel: undefined, stop: undefined,
}

/** The core's call into connected services (services/connectors.ts), as an agent launches on a profile home (a Claude
 *  profile or Codex profile other than the default): that agent reads that home's MCP config, not the default's, so the
 *  connections' entries are written there first (lib/connectors/agents.ts `syncProfileHome`). The edge host does it, so
 *  the core loads neither the connections nor Codex's profile discovery, and never waits on the vault's lock in line. */
export interface ConnectorsPort {
  /** The connections written into [folder]'s config: none for a default home, or a folder that is no profile here. */
  syncProfileHome(engine: 'claude' | 'codex', folder: string): Promise<string[]>
}

/** What the core gets when connected services fail or are off: nothing written, the entries the profile's config
 *  already holds kept as they are, and the launch goes on. */
export const CONNECTORS_FALLBACKS: PortFallbacks<ConnectorsPort> = { syncProfileHome: later([]) }

/** What the core calls while `ports.connectors` is null (connected services are off): its fallbacks' answer. */
export const CONNECTORS_OFF: ConnectorsPort = { syncProfileHome: async () => [] }

/** The folder git made for a create (`WorkspacesPort.prepareFolder`), with what its every relaunch needs and, for a clone,
 *  the SSH alias it got in through; or why not, in the create's own code and words (`access: 'denied'`: GitHub refused
 *  every way in, which the apps say in their own words). */
export type PreparedFolder = { ok: true; cwd: string; scmLaunchRecord?: ScmLaunchRecord; clonedVia?: { alias: string } }
  | { ok: false; error: string; detail: string; access?: 'denied' }
/** A worktree reviewed for its removal (`WorkspacesPort.reviewWorktree`), or why it may not be removed. */
export type WorktreeAnswer = { ok: true; review: WorktreeReview } | { ok: false; reason: string }

/**
 * The core's calls into workspaces (services/workspaces.ts), the folders agents work in. Each runs git, and git runs in
 * the edge host, never in the core (the audit of 2026-11-12): the folder a create asks git for (a clone, a worktree, the
 * folder itself on another branch), a harness's worktree read and removed at a purge, and the made-up worktree branches
 * named after their sessions, on each terminal-title pass. No worktree is removed on a timer (#4166, #711): the daemon
 * swept clean, week-idle ones twice a day, including those their person chose to keep and the gitignored files in them.
 * A refusal is an answer, never a throw, which would count against the service and could switch it off.
 */
export interface WorkspacesPort {
  stop(): void
  nameBranches(): void
  /** Whether it can make a folder now: a create waits for it (held) while it cannot, rather than failing for the moment a
   *  restart takes. */
  ready(): boolean
  /** The folder git makes for a create. `cloneFallback`: the computer owner's own start, which may try every way this
   *  computer reaches GitHub (lib/gitProjectFolder.ts); a start whose address someone else chose never picks the owner's
   *  accounts. */
  prepareFolder(project: GitProjectFolder, options: { cloneFallback: boolean }): Promise<PreparedFolder>
  /** Best-effort workspace instructions; false means unconfirmed, never a reason to hold an ordinary launch.
   *  [closed] is the process request's cancellation signal, checked before file effects. */
  prepareInstructions(workspace: string, engine: string, closed?: AbortSignal): Promise<boolean>
  /** Where a harness works, for Inspect: a worktree, the main checkout or a plain folder; null when nothing answered.
   *  [others]: the folders every other harness here works in, live or stopped. */
  describeWorkspace(target: WorkspaceTarget, others: readonly string[]): Promise<WorkspaceInspection | null>
  /** A harness's linked worktree, reviewed for its removal: its path, branch, changes and the signature the removal is
   *  held to. */
  reviewWorktree(target: WorkspaceTarget, others: readonly string[]): Promise<WorktreeAnswer>
  /** Removes a reviewed worktree, only while it is still exactly what was reviewed. Never its branch. */
  removeWorktree(review: WorktreeReview, target: WorkspaceTarget, others: readonly string[], discardChanges: boolean): Promise<{ ok: true } | { ok: false; reason: string }>
}

/** What a create and a purge say when workspaces did not answer: down, restarting, switched off, or too old to know. */
export const WORKSPACES_UNAVAILABLE = 'Harness\'s workspaces service did not answer. Try again in a moment.'
const FOLDER_UNAVAILABLE: PreparedFolder = { ok: false, error: 'SERVICE_UNAVAILABLE', detail: `Could not make the project folder. ${WORKSPACES_UNAVAILABLE}` }
const REVIEW_UNAVAILABLE: WorktreeAnswer = { ok: false, reason: `The worktree could not be checked. ${WORKSPACES_UNAVAILABLE}` }
const REMOVAL_UNAVAILABLE = { ok: false as const, reason: `The worktree was kept. ${WORKSPACES_UNAVAILABLE}` }

/** What the core gets when workspaces fails: branches keep their names, a create waits for its folder, and nothing of a
 *  worktree is read or removed. */
export const WORKSPACES_FALLBACKS: PortFallbacks<WorkspacesPort> = {
  stop: undefined,
  nameBranches: undefined, ready: false, prepareInstructions: later(false), prepareFolder: later(FOLDER_UNAVAILABLE), describeWorkspace: later(null),
  reviewWorktree: later(REVIEW_UNAVAILABLE), removeWorktree: later(REMOVAL_UNAVAILABLE),
}

/** What the core calls while `ports.workspaces` is null (workspaces off): its fallbacks' answers. */
export const WORKSPACES_OFF: WorkspacesPort = {
  stop: () => {},
  nameBranches: () => {}, ready: () => false, prepareInstructions: async () => false, prepareFolder: async () => FOLDER_UNAVAILABLE, describeWorkspace: async () => null,
  reviewWorktree: async () => REVIEW_UNAVAILABLE, removeWorktree: async () => REMOVAL_UNAVAILABLE,
}

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

/** One operation contract and fallback for declared session owners, independent of any provider. */
export const OWNER_FALLBACKS: PortFallbacks<SessionOwnerPort> = { create: later(OWNER_REPLY_DOWN), deliver: later(OWNER_DOWN), answer: later(OWNER_ANSWER_DOWN), rename: later(OWNER_REPLY_DOWN), stopHarness: later(OWNER_REPLY_DOWN) }

/** What a delivered turn answers: delivered, or refused with the machine's name and a reason a person can read. */
export type SendResult = { ok: true } | { ok: false; machine: string; reason: string }

/** One candidate, as the window draws it in the picker. */
export interface RouteCandidate {
  agentId: string
  /** Which machine to open the pane on. Names are for reading; this is for acting. */
  machineId: string
  name: string
  /** Which computer it runs on. The list spans every machine, and two agents called "api" on two of them
   *  are otherwise the same row twice. */
  machine: string
  /** What it was last doing — the line under the name when the window has to ask. */
  recent: string
  /** Which CLI it runs on — 'claude', 'codex', … The window draws the same engine mark its rail does, so
   *  a row in the picker and the same agent in the rail are recognisably one thing. */
  engine: string
  /** How well the router thought this one fits, 0..1. DISPLAY ONLY — the pick is [RouteAnswer.agentId]
   *  and the number that gates it is [RouteAnswer.confidence]. 0 means the router said nothing about
   *  this candidate, which the window draws as no bar rather than as an empty one. */
  confidence: number
}

export interface RouteAnswer {
  agentId: string
  machineId: string
  name: string
  confidence: number
  reason: string
  /** The best few, most confident first. Only read when the window decides to ask. */
  candidates: RouteCandidate[]
  /** How many agents were weighed, and across how many computers — what the window shows while it waits.
   *  The candidate list is capped, so this is the only place that says whether the right agent was even
   *  in the running. */
  weighed: number
  machines: number
  /** 'model' when a classifier answered, 'heuristic' when name matching stood in for it. Both land on a
   *  low confidence by design; this is what lets the window say WHICH happened instead of showing the
   *  same sentence for a router that was unsure and one that never ran. */
  via: string
}
/** What a fork answers: the new agent's id, or why not. */
export type ForkResult = { ok: true; agentId: string } | { ok: false; error: string; detail?: string }

/*
 * The devices (services/devices.ts): the dials on USB, the window bridges they speak through, and the
 * fleet's router every turn goes through, ⌘K's included (docs/design/2026-10-06-core-boundary-next.md,
 * "Devices", step 9). They answer the core through `DevicesPort` and reach it through `CoreApi`, so that
 * they can run in a process of their own: a device that fails, hangs or leaks costs the devices, never a
 * session.
 */

export type LocalWindowTarget = { kind: 'all' } | { kind: 'first' } | { kind: 'connection'; connId: string }
export interface LocalWindowDelivery {
  target: LocalWindowTarget
  frame: { type: string; payload: Record<string, unknown> }
}
export const LOCAL_WINDOW_OFF = (_delivery: LocalWindowDelivery): boolean => false

/** Permission comes from the authenticated service's declaration, never the notice payload. */
export function sendLocalWindow(delivery: unknown, permissions: LocalWindowPermissions | undefined,
  send: (delivery: LocalWindowDelivery) => boolean, log: (line: string) => void = line => console.warn(line)): boolean {
  const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object'
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  if (record(delivery) && Object.hasOwn(delivery, 'target') && Object.hasOwn(delivery, 'frame')
    && record(delivery.target) && record(delivery.frame) && Object.hasOwn(delivery.frame, 'payload') && record(delivery.frame.payload)) {
    const target = delivery.target, frame = delivery.frame
    const kind = target.kind
    if (Object.hasOwn(target, 'kind') && Object.hasOwn(frame, 'type') && (kind === 'all' || kind === 'first' || kind === 'connection')
      && typeof frame.type === 'string'
      && (kind === 'connection' ? Object.hasOwn(target, 'connId') && typeof target.connId === 'string' && target.connId.length > 0 && target.connId.length <= 256
        && Object.keys(target).length === 2 : Object.keys(target).length === 1)
      && permissions && Object.hasOwn(permissions, kind) && permissions[kind]?.includes(frame.type)) {
      return send(delivery as unknown as LocalWindowDelivery)
    }
  }
  log('[services] WINDOW_FRAME_REFUSED')
  return false
}

/** Which window has the person's attention, as the local socket last heard (`app_focus` with a focus
 *  revision): where a spoken selection or visit goes (`voice`), and a New Harness form (`form`). */
export interface WindowFocus {
  voice: { machineId: string; agentId: string; connId: string } | null
  form: { machineId: string; connId: string } | null
}


/** The Devices tab (services/devices.ts): the devices on this computer, and a device's settings. Only
 *  the owner, on this computer or through the owner's own app, may manage them. */
export const DEVICES_REQUESTS = ['harness_devices_list', 'harness_device_settings', 'pet_preview', 'pet_apply', 'pet_reset', 'pet_status',
  // A window's frames they answer (`SERVICE_WS_FRAMES`): ⌘K's, and its answer to a spoken task.
  'devices_ws'] as const

/**
 * The core's calls into the devices: what the windows on this computer said that the dial follows, the
 * cards every device is sent, the mod's poll (core/deviceHookCalls.ts), and stopping. Every one is a notice or a request the core never waits on in line: across a process, a hung
 * devices process answers the fallbacks, never a frozen core.
 */
export interface DevicesPort extends DeviceHookPort {
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
  /** A window left. */
  windowGone(connId: string): void
  /** The engines the live agents run: the voice router's worker is one of them. */
  engines(engines: string[]): void
  /** Whether a device watches through the backend: the voice router keeps its worker warm meanwhile. */
  commanders(connected: boolean): void
  /** A paneless agent's hook event, checked by the core and kept nowhere in it; false when the devices did not take it
   *  (not connected), so the core counts it lost. */
  observed(event: ObservedEvent): boolean
  /** Let go of the serial ports and the lane, for a restart or a shutdown. */
  stop(): Promise<void>
}

const DEVICES_UNAVAILABLE = 'the devices service is unavailable'
/** ⌘K's pick, and its send, while the devices give no answer: no agent picked, nothing sent. */
const UNROUTED: RouteAnswer = { agentId: '', machineId: '', name: '', confidence: 0, reason: DEVICES_UNAVAILABLE, candidates: [], weighed: 0, machines: 0, via: '' }
const UNSENT: SendResult = { ok: false, machine: '', reason: DEVICES_UNAVAILABLE }

/**
 * What the core gets when the devices fail: the dial and the window bridges hear nothing, ⌘K says so,
 * picking no agent and sending nothing, the Wi-Fi device finds no desk to walk, the mod's poll is
 * answered as with no dial, and a shutdown goes on.
 */
export const DEVICES_FALLBACKS: PortFallbacks<DevicesPort> = {
  card: undefined, desk: undefined, swarms: undefined, unread: undefined, appFocus: undefined, seen: undefined,
  settings: undefined, windowFocus: undefined, windowReply: undefined, windowGone: undefined,
  engines: undefined, commanders: undefined, observed: false,
  // Off, not an empty hold: the mod asks again in a minute, not at once.
  inboxPoll: later({ off: true }), inboxGone: undefined,
  stop: later(undefined),
}

/*
 * The Wi-Fi device (services/wifi.ts, lib/autonomous-device/): a paired device that speaks its own
 * protocol (docs/autonomous-device-integration.md) over an E2EE session the gateway holds, on its direct
 * link or the relay. It runs beside the dials, in the devices' process. Requests and replies use the
 * authenticated gateway peer; the gateway checks the final E2EE session at each send.
 */

/** The current window focus, said again when the component's core link starts. */
export interface WifiResume {
  focus: { machineId: string; agentId: string; connId: string } | null
}

/** The Wi-Fi device's routes of the door (`SERVICE_HTTP_ROUTES`): `harness device receipt` and its add-ons. */
export const WIFI_REQUESTS = ['wifi_http', 'wifi_serving', 'wifi_focus_current'] as const

/**
 * Input facts and window notifications. Relay sessions, cards, normalized events and transcript evidence
 * are owned and observed outside this port. What a person asks of it (`harness device receipt`, its
 * add-ons) are its routes (`SERVICE_HTTP_ROUTES`).
 */
export interface WifiPort {
  /** What the core holds for it (`WifiResume`), as it starts. Settles once the sessions are served again. */
  resume(state: WifiResume): Promise<void>
  input(event: SessionInputProgress): void
  disconnected(): void
  /** Generic delivery outcomes, including refusal and uncertainty. */
  delivery(event: AutonomousDeviceDelivery): void
  /** A window moved to an agent (null: it left one), by its connection. Settles once it is applied. */
  appFocus(machineId: string, agentId: string | null, connId: string): Promise<void>
  /** A window opened the agent a device's Store preparation made. */
  revealed(operationId: string, agentId: string): void
  stop(): Promise<void>
}

/**
 * What the core gets when the Wi-Fi device's service is off: its devices hear nothing (a request they sent
 * is unanswered, which they retry with the same key, as after a lost frame).
 */
export const WIFI_FALLBACKS: PortFallbacks<WifiPort> = {
  resume: later(undefined), delivery: undefined,
  input: undefined, disconnected: undefined,
  appFocus: later(undefined), revealed: undefined,
  stop: later(undefined),
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

/** What a person has open on this computer, per surface (lib/windowSurfaces.ts). */
export type { LocalWindows, WindowSurface } from '../lib/windowSurfaces.js'
import type { LocalWindows, WindowSurface } from '../lib/windowSurfaces.js'

/**
 * A request the usage report measures, as the core saw it, raw and bounded (core/usageOutcomes.ts): which request, who
 * sent it, and what its answer said. The gateway turns it into the report's fixed counter names
 * (gateway/usageEvents.ts, lib/productUsageSignals.ts): those names are the backend's vocabulary, which the core does not load. Nothing in it
 * goes into a report: a launch's and an agent's ids stay in the gateway's memory, as they did when the core sent them.
 */
export interface UsageRequest {
  type: string
  /** Over the local socket, by a tool there, and the remote client's role (`web`, `device`), as the core knows them. */
  local: boolean
  tool: boolean
  role: string | null
  /** The phone said it is the phone (`usageSurface: 'phone'`). */
  phone?: true
  /** A person opened the list (`userAction`). */
  userAction?: true
  /** A launch's own facts: its durable id, the engine asked for, and whether an agent (Hachi) asked for it. */
  creationId?: string
  engine?: string
  agentStarted?: true
  hachiStarted?: true
  /** A message a person's composer sent (`usageIntent: 'interactive'`), and the agent it is for. */
  interactive?: true
  agentId?: string
}
/** What an answer to it said: its error (`true` for one that is not a string), state and agent, as its reply had them. */
export interface UsageAnswer {
  error?: string | true
  state?: string
  hasAgent?: true
  ok?: false
  /** A refused resume's preparation check (`reason`): `null` for one that is not a string. */
  preparation?: string | null
  /** The created agent's id and launch, as its frame had them; `true` for an agent that is not a frame. */
  agent?: { id?: string; launch?: { state?: string; error?: string } } | true
  /** The service a pending launch waits for. */
  held?: string
  /** What became of a person's message (lib/sessionInput.ts `MessageOutcome`), which nothing else answers. */
  message?: string
}
export type UsageEvent =
  /** A bounded optional counter; core supplies the authenticated originating service, gateway admits its name. */
  | { kind: 'service'; service: string; metric: string }
  | { kind: 'request'; request: UsageRequest }
  /** [first]: the request's first answer, the one its counters count; a later one says only what became of a launch. */
  | { kind: 'answer'; request: UsageRequest; answer: UsageAnswer; first: boolean; elapsedMs: number }
  /** `hn`'s own measurement of its flows (`product_observe`), as it sent it, bounded. */
  | { kind: 'observed'; payload: Record<string, unknown> }

/** What the core asks of the gateway: everything bound for a remote client, and the link's state. */
export interface GatewayPort {
  /** Optional, fixed-name counter to the gateway; no user payload or identifier. */
  usageCounter?(metric: ProductUsageMetric): void
  /** A request the usage report measures, as the core saw it (core/usageOutcomes.ts): the gateway names its counters. */
  usage?(event: UsageEvent): void
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
  target(connId: string, type: string, payload: Record<string, unknown>, quota?: ClientStreamQuota): boolean
  /** A terminal frame for one remote client, sealed to it, over its P2P channel when the stream moved
   *  there; false when it could not be sent. */
  terminal(connId: string, type: string, payload: Record<string, unknown>, quota?: ClientStreamQuota): boolean
  terminalBinary(connId: string, frame: Uint8Array, quota?: ClientStreamQuota): boolean
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
  stop(): Promise<void>
}

/** What the gateway tells the core. In the core's process these are calls; in the gateway's own, frames
 *  on the link the master started it with, which no other process can open. */
export interface GatewayEvents {
  /** A remote client's request, opened and admitted. `role` is the session that sealed it: who asked is
   *  the gateway's word, and the core trusts nothing in the frame for it. Resolves once it is handled. */
  frame(connId: string, frame: Record<string, unknown>, transport: RemoteTransport, role: RemoteRole): Promise<void> | void
  /** A remote client's terminal bytes, opened. */
  binary(connId: string, clear: TerminalBinaryClear, raw?: Uint8Array): Promise<void> | void
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
  /** Something the windows on this computer show of the account's devices (the device key log's notices). */
  toWindows(frame: Record<string, unknown>): void
  /** What a shared tab's relay said (`GatewayOps.tabRelay`), for Agent Messages. */
  tabFrame(event: TabFrame): void
  /** A service stream's transport facts, from the authenticated gateway alone. */
  streamControl(service: string, streamId: string | null, payload: Record<string, unknown>): void
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
  /** A sealed frame from the machine, opened; `unreadable` when it does not open (stale, forged, garbled);
   *  `unknownEpoch` when it is sealed under a group epoch none of the machine's sessions here ever held: the
   *  far daemon restarted, and the session here is with a process that is gone. */
  open(machineId: string, frame: Record<string, unknown>): Promise<LaneOpened>
  /** The lane is done with the machine's session. */
  drop(machineId: string): void
}
export type LaneSealed = { frame: Record<string, unknown> } | { lost: true }
export type LaneOpened = { frame: Record<string, unknown> } | { unreadable: true } | { unknownEpoch: true } | { lost: true }
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
  /** Headers on a route's answer, only those its route declares (`ServiceHttpRoute.headers`, `answerHeaders`). */
  headers?: Record<string, string>
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

/**
 * A route of the local door that a service answers (core/serviceRoutes.ts): asked of it as the request `type`, which
 * that service declares with its others, carrying the method, the target as the client sent it and the body as text.
 * The core holds where the route goes, how long it waits, and what it answers while its service is down or does not
 * answer in time: never what the route does.
 */
export interface ServiceHttpRoute {
  /** The paths it takes, its query left out. */
  path: RegExp
  /** The methods it takes; another goes on to the door's own routes. Every method when absent. */
  methods?: readonly string[]
  /** The methods that write: the door answers one without the local header (`x-adapter-local: 1`, which a page in a
   *  browser cannot send without a preflight the door never allows) with its 403, before its service is asked. */
  writes?: readonly string[]
  type: string
  waitMs: number
  unanswered: HttpAnswer
  /** Headers on every answer of the route: the door's own, and its service's. */
  headers?: Readonly<Record<string, string>>
  /** The headers its service's answer may set, lower case; any other is not written. */
  answerHeaders?: readonly string[]
  /** The most of a body the door reads for it, in bytes: past it the body is empty (the door's own bound when absent). */
  maxBodyBytes?: number
  /** 'socket': only over the daemon's own socket (its Windows pipe). The door answers one over its TCP port with its 403
   *  before its service is asked, and asks with `asker.door`, which no client of the local WebSocket is given. */
  door?: 'socket'
}

/** The gateway's routes of the door (gateway/start.ts): one request, by path. */
export const GATEWAY_REQUESTS = ['gateway_http', 'gateway_ws'] as const

const deviceDown = (status: number, code: string, message: string): HttpAnswer => ({ status, body: { error: { code, message } } })
const DEVICE_LINK_DOWN = deviceDown(503, 'UNAVAILABLE', 'The Wi-Fi device link is not reachable on this computer right now. Try again.')

/**
 * The usage report's vocabulary revision, on every answer of its route (`x-harness-usage-vocabulary`), the door's own
 * too: the Desktop counts a name newer than revision 1 only once a proxy has announced it, since an older CLI refused a
 * whole report for one name it did not know (gateway/accountRoutes.ts, lib/appProductUsageReport.ts), and it reads the
 * revision off every answer, a refusal included. 2: the Desktop's frame-phase counters (`frame_slow_*`,
 * `frame_long_collector`). 3: its Add Phone card (`ui_desktop_phone_offer_*`) and the ways Add Phone opened
 * (`ui_desktop_add_phone_*`). 4: the card offered after work or after time away (`ui_desktop_phone_offer_after_work_*`,
 * `ui_desktop_phone_offer_away_*`). 5: first-arrival episodes and shared-tab invitation outcomes. 6: returning-account
 * phone offers, offer skip reasons and Add Phone pairing sources. 7: Import an agent running on this Mac
 * (`ui_desktop_agent_import_*`, task #2379). 8: How a Team account's removal from the computer ended
 * (`ui_desktop_team_account_removal_*`, 2026-11-10). 9: an agent's Browser panel opened (`agent_browser_opened`).
 * 10: Hachi's window counters (docs/design/2026-11-12-hachi.md, Measures). Raise it with each name the Desktop gates on
 * it (`ProductHealthMeasure.vocabulary`, `ProductFlow.vocabulary`), in the pull request that lets the gateway take it.
 */
export const APP_USAGE_VOCABULARY = 10
export const APP_USAGE_VOCABULARY_HEADER = 'x-harness-usage-vocabulary'

/** What a route of the account answers while the gateway is down or does not answer in time, as it did in the core. */
const GATEWAY_DOWN: HttpAnswer = { status: 503, body: { error: 'GATEWAY_UNAVAILABLE' } }
/** How long a route of the account is waited for: as a backend call through the gateway always was (core/gatewayLink.ts). */
const ACCOUNT_WAIT_MS = 25_000
/** A route of the account (gateway/accountRoutes.ts) that takes [methods], each but GET a write. */
const account = (path: RegExp, methods: readonly string[]): ServiceHttpRoute =>
  ({ path, methods, writes: methods.filter((method) => method !== 'GET'), type: 'gateway_http', waitMs: ACCOUNT_WAIT_MS, unanswered: GATEWAY_DOWN })
/** How long a pairing may take: the code is typed on one screen and checked over the relay, round by round. */
export const PAIR_WAIT_MS = 120_000
/** A route of the keys (gateway/keyRoutes.ts) that takes [method], [local] when it needs the local header; waited for as
 *  the gateway's calls always were (core/serviceLinks.ts, 30 s). */
const keys = (path: RegExp, method: string, local: boolean, waitMs = 30_000): ServiceHttpRoute =>
  ({ path, methods: [method], ...(local ? { writes: [method] } : {}), type: 'gateway_http', waitMs, unanswered: GATEWAY_DOWN })

/**
 * The door's routes each service answers, the first that matches taking a request. Each says what it answered before
 * it left the core's process, word for word, while its service is down (e2e/deviceRoutes.e2e.ts,
 * e2e/accountRoutes.e2e.ts). The door's own checks come first (hookServer.ts, core/serviceRoutes.ts).
 */
export const SERVICE_HTTP_ROUTES: readonly ServiceHttpRoute[] = [
  // The add-ons of a device that is this machine (services/machineAddons.ts): its own service's take waits up to 20 s
  // for the next proposal (lib/autonomous-device/machineAddons.ts `TAKE_WAIT_MAX_MS`).
  { path: /^\/api\/autonomous-device\/machine-addon\//, type: 'machine_addons_http', waitMs: 25_000,
    unanswered: deviceDown(503, 'UNAVAILABLE', 'The add-ons of this machine are not running. See the daemon\'s log.') },
  // A proposal not answered may have reached the device: sent again with the same key, it is sent at most once.
  { path: /^\/api\/autonomous-device\/addon\/propose$/, type: 'wifi_http', waitMs: 5_000,
    unanswered: deviceDown(504, 'OUTCOME_UNKNOWN', 'No answer in time: the proposal may have been sent. Retry with the same key (--key) to send it at most once.') },
  // `harness device receipt` and what the devices publish (services/wifi.ts).
  { path: /^\/api\/autonomous-device\/(receipt$|addon\/)/, type: 'wifi_http', waitMs: 5_000,
    unanswered: deviceDown(503, 'UNAVAILABLE', 'The Wi-Fi device service is not running on this computer. See the daemon\'s log.') },
  // The device's pairings and direct links, the gateway's: a pairing waits for the Wi-Fi device's service to serve (15 s)
  // and then for its code to be checked over the direct link, round by round (two minutes); a look for devices waits
  // for the service, and listens for three seconds.
  { path: /^\/api\/autonomous-device\/pair\/start$/, type: 'gateway_http', waitMs: 140_000, unanswered: DEVICE_LINK_DOWN },
  { path: /^\/api\/autonomous-device\//, type: 'gateway_http', waitMs: 45_000, unanswered: DEVICE_LINK_DOWN },
  // The account's, through this computer's sign-in, which the gateway holds (gateway/accountRoutes.ts,
  // e2e/accountRoutes.e2e.ts): the desk, Agent Messages' tabs, the account's name and the phone half of a sign-in.
  account(/^\/api\/desk$/, ['GET']),
  account(/^\/api\/desk\/ops$/, ['POST']),
  account(/^\/api\/agent-messages$/, ['GET']),
  account(/^\/api\/agent-messages\/tabs\/[A-Za-z0-9_-]{1,64}$/, ['PATCH']),
  account(/^\/api\/auth\/me$/, ['GET', 'PATCH']),
  account(/^\/api\/auth\/qr\/(lookup|approve|deny)$/, ['POST']),
  // The product usage feedback, choice and reports; a busy backend's Retry-After reaches the Desktop, which waits it out.
  account(/^\/api\/product-usage\/feedback$/, ['POST']),
  account(/^\/api\/product-usage\/settings$/, ['GET', 'POST']),
  { ...account(/^\/api\/product-usage\/report$/, ['POST']), maxBodyBytes: 8192,
    headers: { [APP_USAGE_VOCABULARY_HEADER]: String(APP_USAGE_VOCABULARY) }, answerHeaders: ['retry-after'] },
  // A machine's rename and delete, and the Store's ratings and reviews, which answers its other methods itself.
  account(/^\/api\/machines\//, ['PATCH', 'DELETE']),
  { path: /^\/api\/store\//, writes: ['PUT', 'DELETE'], type: 'gateway_http', waitMs: ACCOUNT_WAIT_MS, unanswered: GATEWAY_DOWN },
  // Add Phone's code, which signs a phone in to this account: the one route whose answer is a credential. Not the local
  // header, which any process here can send, but the daemon's own socket, where the filesystem said who this is; another
  // account on a shared computer reaches the port, never the socket.
  { ...account(/^\/api\/auth\/handoff$/, ['POST']), door: 'socket' },
  // Set up Intern 3's ticket, which signs a headless box in to this account: a credential too, behind the same door.
  { ...account(/^\/api\/auth\/box\/ticket$/, ['POST']), door: 'socket' },
  // The keys, which the gateway holds (gateway/keyRoutes.ts, e2e/keyRoutes.e2e.ts): `harness pair`, `pairings`, `unpair`,
  // `remote-password`, `link connect`'s mutual half, `group`, `devices` and the window's Devices list.
  keys(/^\/api\/pair$/, 'POST', true, PAIR_WAIT_MS),
  keys(/^\/api\/pairs$/, 'GET', false),
  keys(/^\/api\/revoke(-all)?$/, 'POST', true),
  keys(/^\/api\/remote-password\/(set|clear)$/, 'POST', true),
  keys(/^\/api\/remote-password\/status$/, 'GET', false),
  keys(/^\/api\/link\/trust-peer$/, 'POST', true),
  keys(/^\/api\/group$/, 'GET', false),
  keys(/^\/api\/group\/(sync|remove)$/, 'POST', true),
  keys(/^\/api\/devices$/, 'GET', false),
  keys(/^\/api\/devices\/(remove|rebaseline|dismiss)$/, 'POST', true),
  // The account's whole device story, and a backend call as this machine behind it: a read, local only.
  keys(/^\/api\/devices\/history$/, 'GET', true),
]

/**
 * A frame of the local WebSocket that a service answers (core/serviceRoutes.ts `frames`): asked of it as the request
 * `type`, carrying `{ frame, payload }` as the window sent them, off the connection's ordered chain, and its answer sent
 * back as the frame `result` under the frame's `requestId`. The core holds where it goes, how long it waits, and what is
 * sent back while its service is down, failing or slow: never what the frame does.
 */
export interface ServiceWsFrame {
  /** The frame's type, as a window sends it. */
  frame: string
  type: string
  /** Also accepted through the authenticated owner RPC router, with its original Asker and RPC result type. */
  rpc?: 'owner' | 'local'
  /** The frame its answer goes back as; none for a frame the window tells, which nothing answers. */
  result?: string
  waitMs: number
  /** What goes back while its service gives no answer. */
  unanswered?: Record<string, unknown>
}

/** A window's frames each service answers, wherever the window's terminals are: they describe a hand at this desk. Each
 *  says what was sent back before it left the core's process, word for word, while its service is down
 *  (e2e/keyRoutes.e2e.ts). */
export const SERVICE_WS_FRAMES: readonly ServiceWsFrame[] = [
  { frame: 'browser_open', type: 'gateway_ws', rpc: 'local', result: 'browser_open_result', waitMs: 5_000, unanswered: { handled: false } },
  { frame: 'browser_callback', type: 'gateway_ws', rpc: 'owner', result: 'browser_callback_result', waitMs: 35_000, unanswered: { error: 'UNSUPPORTED' } },
  // ⌘K: which agent a typed task belongs to, on any of the owner's machines; the classifier has 20 s (services/fleet.ts).
  { frame: 'route_task', type: 'devices_ws', rpc: 'owner', result: 'route_result', waitMs: 25_000, unanswered: { ...UNROUTED } },
  // ⌘K's send, through the fleet's router: the turn delivered on the agent's own machine, or refused with why.
  { frame: 'route_send', type: 'devices_ws', rpc: 'owner', result: 'route_send_result', waitMs: 5_000, unanswered: { ...UNSENT } },
  // Component desk gestures use this same local door, with no relay RPC grant.
  { frame: 'harness_device_step', type: 'devices_ws', result: 'harness_device_step_result', waitMs: 5_000, unanswered: { error: 'DESK_UNAVAILABLE' } },
  { frame: 'harness_device_scroll', type: 'devices_ws', waitMs: 5_000 },
  // The window's answer to a spoken task the devices offered it (cable/windowRoute.ts): taken, then sent or cancelled.
  { frame: 'voice_route_reply', type: 'devices_ws', waitMs: 5_000 },
]

export interface GatewayOps {
  /** The account's token. The gateway renews the sign-in (lib/authRefresh.ts) and the core asks it, so the core calls
   *  no other host (the core audit of 2026-11-12, decision 4). A refusal is the session's own error (`AuthSessionError`). */
  accessToken(opts?: { force?: boolean; failedToken?: string }): Promise<string>
  /** Account HTTP and its cache live with the network, outside the session core. */
  backend(method: string, path: string, body?: unknown): Promise<HttpAnswer>
  machines(fallback?: boolean): Promise<HttpAnswer>
  mintGridName(): Promise<string | null>
  status(): Promise<GatewayStatus>
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
  /** Metadata-only connector synchronization (`core.account.connectorSync`). */
  connectorSync: ConnectorSync
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
  stop(): void
  dshContext(request: DshDescribeRequest): Promise<DshContextAnswer>
  dshDescribe(request: DshDescribeRequest): Promise<DshDescribeAnswer>
  dshMaterialize(request: DshMaterializeRequest): Promise<DshMaterializeAnswer>
  /** Untrusted contribution; dshThrough checks it against captured request and session identity. */
  dshLaunch(request: DshLaunchRequest): Promise<unknown>
}

export const STORE_FALLBACKS: PortFallbacks<StorePort> = { stop: undefined, dshContext: later(FAIL), dshDescribe: later(FAIL), dshMaterialize: later(FAIL), dshLaunch: later(FAIL) }
export const STORE_OFF: StorePort = {
  stop: () => {},
  dshContext: () => Promise.reject(new ServiceUnavailableError('store')),
  dshDescribe: () => Promise.reject(new ServiceUnavailableError('store')),
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
  paste: PastePort | null
  connectors: ConnectorsPort | null
  orchestrator: OrchestratorPort | null
  sharing: SharingPort | null
  recaps: RecapsPort | null
  agentCleanup: AgentCleanupPort | null
  cloud: SessionOwnerPort | null
  sharedMachines: SharedMachinesCorePort | null
}

export function emptyPorts(): CorePorts {
  return { usage: null, store: null, search: null, viewers: null, models: null, workspaces: null, messages: null, devices: null, wifi: null, monitor: null, paste: null, connectors: null, orchestrator: null, sharing: null, recaps: null, agentCleanup: null, cloud: null, sharedMachines: null }
}

export interface CoreApiDeps {
  terminals?: TerminalsPort
  conversations?: ConversationReads
  dataDir: string
  registry: Pick<typeof registry, 'list' | 'rows' | 'byAgent' | 'resolve' | 'advertised' | 'advertisedRows' | 'terminalAvailable'>
  stoppedAgents: Pick<StoppedAgentStore, 'list'>
  databaseHistory: CoreApi['transcripts']['databaseHistory']
  syncSession: CoreApi['agents']['sync']
  runtimeModels: CoreApi['agents']['runtimeModels']
  viewerChanged: CoreApi['clients']['viewerChanged']
  streamFrame?: CoreApi['clients']['streamFrame']
  streamBytes?: NonNullable<CoreApi['clients']['streamBytes']>
  gridNamed: CoreApi['clients']['gridNamed']
  gridModelsChanged: CoreApi['clients']['gridModelsChanged']
  dshInstallStatus: CoreApi['clients']['dshInstallStatus']
  mintGridName: CoreApi['account']['mintGridName']
  accessToken: CoreApi['account']['accessToken']
  lane: CoreApi['account']['lane']
  observerKey: CoreApi['account']['observerKey']
  tabKey: CoreApi['account']['tabKey']
  tabRelay: CoreApi['account']['tabRelay']
  connectorSync: CoreApi['account']['connectorSync']
  observer: CoreApi['clients']['observer']
  privateGridName: CoreApi['account']['privateGridName']
  machineName: CoreApi['account']['machineName']
  backend: CoreApi['account']['backend']
  onNotice: CoreApi['account']['onNotice']
  create: CoreApi['agents']['create']
  dsh: CoreApi['agents']['dsh']
  /** The same per-row capture the app formatter uses; no transport or retained snapshot. */
  facts?: (session: RegisteredSession) => AgentFacts
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
  /** What happens to agents, for the services that follow them (core/agentLife.ts `follow`); absent, none hears it. */
  follow?: CoreApi['agents']['follow']
  /** The process a session's pane runs, from its own terminal backend (`TerminalBackend.paneInfo`), or null: what
   *  `ofPane` holds a command's parents to. Absent, no pane is proven. */
  panePid?: (session: RegisteredSession) => Promise<number | null>
  /** When an agent's conversation last moved (lib/transcriptActivity.ts), for `lastActivity`. */
  activityAt?: (session: RegisteredSession) => Promise<number | null>
  signedIn: CoreApi['account']['signedIn']
  environment: CoreApi['account']['environment']
  machines: CoreApi['account']['machines']
  hasWindow: CoreApi['clients']['hasWindow']
  devicesChanged: CoreApi['clients']['devicesChanged']
  dialWatching: CoreApi['clients']['dialWatching']
  /** A host-bound session owner door; the unbound core API supplies none. */
  owners?: SessionOwnerCore
  /** The service-owned sessions as typed lean list rows. */
  serviceRows?: () => ServiceSessionRow[]
  /** Current service membership and one current row, without a temporary projected catalogue. */
  serviceRead?: { ids(): IterableIterator<string>; row(agentId: string): ServiceSessionRow | undefined }
  lastTurn: CoreApi['transcripts']['lastTurn']
  /** Where a turn's cards and recaps go: the devices, and the apps. Only their own frame types reach these. */
  turnCard: CoreApi['clients']['turnCard']
  turnSummary: CoreApi['clients']['turnSummary']
  /** Where a service's product counters go (`count`); absent, nowhere. */
  count?: CoreApi['count']
  /** Every window of the account, here and away, told a goal Hachi closed (`clients.hachiGoalDone`); absent, none is. */
  hachiGoalDone?: (notice: HachiGoalDone) => void
  log?: (line: string) => void
}

/** Complete membership once; current facts for each member when it is emitted. Never an atomic whole-time view. */
export function readSessions(deps: Pick<CoreApiDeps, 'registry' | 'serviceRead' | 'facts' | 'runtimeProfile' | 'turns' | 'machine' | 'signedIn' | 'environment' | 'hasWindow' | 'log'>,
  receive: SessionReadReceiver, signal?: AbortSignal, scope: SessionReadScope = 'registered'): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = performance.now(), ids: string[] = []
    let sourceFailure: string | undefined
    let finished = false, pump: { cancel(): void } | undefined
    const abort = (): void => { pump?.cancel() }
    const fail = (code: string): never => { sourceFailure = code; throw new Error(code) }
    const finish = (code?: string): void => {
      finished = true
      ids.length = 0
      signal?.removeEventListener('abort', abort)
      if (code) {
        reject(new Error(code))
        try { (deps.log ?? console.warn)(`[sessions] ${code}`) } catch { /* a failed diagnostic cannot leave the read pending */ }
      }
      else resolve()
    }
    try {
      if (signal?.aborted || !deps.turns.running || !deps.facts) return finish('SESSION_READ_UNAVAILABLE')
      const header: SessionReadHeader = { version: 2,
        machine: { id: deps.machine.id(), computerId: deps.machine.computerId(), name: deps.machine.name() },
        signedIn: deps.signedIn(), environment: deps.environment(), hasWindow: deps.hasWindow() }
      if (!header.machine.id) return finish('SESSION_READ_UNAVAILABLE')
      if (boundedJsonBytes(header, SESSION_READ_HEADER_BYTES) === null) return finish('SESSION_READ_TOO_LARGE')
      const current = (): boolean => !signal?.aborted && deps.machine.id() === header.machine.id
        && deps.machine.computerId() === header.machine.computerId && deps.signedIn() === header.signedIn && deps.environment() === header.environment
      let bytes = 0
      const member = (id: string): void => {
        if (performance.now() - started >= QUESTION_OBSERVATION_TIMEOUT_MS) fail('SESSION_READ_TIMEOUT')
        bytes += 48 + 2 * id.length
        if (bytes > SESSION_READ_MEMBERS_BYTES) fail('SESSION_READ_TOO_LARGE')
        ids.push(id)
      }
      for (const row of scope === 'registered' ? deps.registry.rows() : deps.registry.advertisedRows()) member(row.agentId)
      const registeredCount = ids.length
      if (deps.serviceRead) for (const id of deps.serviceRead.ids()) member(id)
      const count = ids.length
      const rows = function* (): Generator<SessionReadValue> {
        for (let index = 0; index < count; index++) {
          const agentId = ids[index]
          if (index >= registeredCount) {
            const row = deps.serviceRead!.row(agentId)
            if (!row) { yield ['gone', 'service', agentId]; continue }
            yield ['service', row.agentId, row.sessionId, row.engine, row.registeredAt, row.transcriptPath, row.lastHookAt,
              typeof row.displayName === 'string' ? row.displayName : '', typeof row.runtimeProfile === 'string' ? row.runtimeProfile : null]
            continue
          }
          const row = deps.registry.byAgent(agentId)
          if (!row) { yield ['gone', 'registered', agentId]; continue }
          const selectedModel = deps.runtimeProfile(row), turnRunning = deps.turns.running!(row.sessionId)
          if (deps.registry.byAgent(agentId) !== row) fail('SESSION_READ_UNAVAILABLE')
          const { agentId: currentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt, active, cwd, dsh } = row
          const state = row.launch
          const launch: SessionReadLaunch | null = !state ? null : state.state === 'failed'
            ? ['failed', state.error, state.detail === undefined ? false : state.detail]
            : state.state === 'held' ? ['held', state.service, state.detail] : [state.state]
          // Shared app facts stay last. No provider is called after this final current-row check.
          const captured = deps.facts!(row)
          if (!captured || deps.registry.byAgent(agentId) !== row) fail('SESSION_READ_UNAVAILABLE')
          if (scope === 'advertised' && !captured.terminalAvailable) { yield ['gone', 'registered', agentId]; continue }
          const publishedDsh = captured.parts.dsh
          yield ['registered', currentId, sessionId, engine, registeredAt, transcriptPath, lastHookAt, active, cwd,
            dsh === undefined ? false : dsh, launch, captured.displayName, captured.terminalAvailable, selectedModel, turnRunning,
            typeof publishedDsh === 'string' ? publishedDsh === dsh ? true : publishedDsh : false]
        }
      }
      let index = 0
      pump = startSettledRecords<SessionReadValue, ReadRecord<SessionReadHeader, SessionReadValue>>({
        rows: rows(), current,
        begin: { type: 'begin', payload: { header, count } },
        row: value => {
          const record: ReadRecord<SessionReadHeader, SessionReadValue> = { type: 'row', payload: { index: index++, value } }
          // All retained row fields above are copied primitives. Admit before the transport serializes the frame.
          // Leave room for the bounded request/generation envelope; the physical sink counts the complete frame again.
          if (boundedJsonBytes(record, QUESTION_OBSERVATION_BYTES - 2048) === null) fail('SESSION_READ_TOO_LARGE')
          return record
        },
        end: { type: 'end', payload: { count } }, send: receive,
        timeoutMs: Math.max(1, QUESTION_OBSERVATION_TIMEOUT_MS - (performance.now() - started)),
        finished: reason => finish(reason === null ? undefined : sourceFailure ?? (reason === 'timeout' ? 'SESSION_READ_TIMEOUT' : 'SESSION_READ_UNAVAILABLE')),
      })
      if (signal?.aborted) pump.cancel()
      else if (!finished) signal?.addEventListener('abort', abort, { once: true })
    } catch (error) {
      finish(error instanceof Error && error.message === 'SESSION_READ_TIMEOUT' ? 'SESSION_READ_TIMEOUT'
        : error instanceof Error && error.message === 'SESSION_READ_TOO_LARGE' ? 'SESSION_READ_TOO_LARGE' : 'SESSION_READ_UNAVAILABLE')
    }
  })
}

export function createCoreApi({
  dataDir, registry, stoppedAgents, databaseHistory, syncSession, runtimeModels, viewerChanged,
  gridNamed, gridModelsChanged, dshInstallStatus, mintGridName, accessToken, lane, observerKey, tabKey, tabRelay, connectorSync, observer, privateGridName, machineName, backend, onNotice,
  runtimeProfile, setRuntime, fork, create, dsh, facts, windows, daemon, turns, questions, terminals = TERMINALS_OFF, conversations = CONVERSATIONS_OFF, streamFrame, streamBytes, machine, activityText, activitySnapshot, activity, summaries,
  closeAgent, activityAt, follow, panePid,
  signedIn, environment, machines, hasWindow, devicesChanged, dialWatching, owners, serviceRows, serviceRead, lastTurn, turnCard, turnSummary,
  count, hachiGoalDone, log = (line) => console.warn(line),
}: CoreApiDeps): CoreApi {
  // The recaps reach the devices and the apps through their own two doors, and only with their own frames.
  const refusedRecap = (type: unknown): void => log(`[services] the recaps sent ${String(type).slice(0, 40)}, which is not theirs to send`)
  // A goals process speaks to the core as a service: a goal's notice goes to every window of the account only for the
  // live Hachi harness here, and only with its three fields, whatever the process sends.
  const goalText = (v: unknown, max: number): v is string => typeof v === 'string' && v.length > 0 && v.length <= max
  const goalDone = hachiGoalDone && ((notice: HachiGoalDone): void => {
    const { agentId, goalId, title } = notice ?? {}
    if (typeof agentId === 'string' && registry.byAgent(agentId)?.dsh === HACHI_ID && goalText(goalId, 128) && goalText(title, HACHI_GOAL_TITLE_MAX)) {
      hachiGoalDone({ agentId, goalId, title })
    } else log('[services] the goals sent a goal done that is not the live Hachi\'s')
  })
  return {
    dataDir,
    terminals,
    machine,
    conversations,
    agents: {
      all: async () => { const stopped = await stoppedAgents.list(); return [...registry.list(), ...stopped].map(agentView) },
      live: () => registry.list().map(agentView),
      readSessions: (scope, receive, signal) => readSessions({ registry, serviceRead, facts, runtimeProfile, turns, machine, signedIn, environment, hasWindow, log }, receive, signal, scope),
      facts: row => { const current = registry.byAgent(row.agentId); return current && facts ? facts(current) : null },
      displayName: projectDisplayName,
      byAgent: (agentId) => { const session = registry.byAgent(agentId); return session && agentView(session) },
      resolve: (id) => { const session = registry.resolve(id); return session && agentView(session) },
      advertised: () => registry.advertised().map(agentView),
      ...(serviceRows ? { serviceSessions: serviceRows } : {}),
      terminalAvailable: (agentId) => registry.terminalAvailable(agentId),
      sync: syncSession,
      runtimeModels,
      runtimeProfile,
      setRuntime,
      fork,
      create,
      dsh,
      activityText,
      activitySnapshot,
      activity: activity ?? (async () => ({})),
      summaries: summaries ?? (async () => ({})),
      // Decided here, not in the service: whatever the cleanup asks, from its process or this one, the core closes only
      // a harness another agent started, the conversation it reviewed (`agent_close`'s identity), and keeps it.
      closeStarted: async (agentId, mode, pastCeiling) => {
        const session = registry.byAgent(agentId)
        if (!session) return { error: 'AGENT_CHANGED' }
        if (session.startedBy !== 'agent') return { error: 'NOT_AGENT_STARTED' }
        if (!closeAgent) return { error: 'UNSUPPORTED' }
        const background = mode === 'idle' ? { background: pastCeiling === true ? 'count' as const : 'refuse' as const } : {}
        return closeAgent({ agentId, sessionId: session.sessionId, createdAt: new Date(session.registeredAt).toISOString(), mode, ...background })
      },
      lastActivity: async (agentId) => {
        const session = registry.byAgent(agentId)
        return session && activityAt ? activityAt(session) : null
      },
      ...(follow ? { follow } : {}),
      ofPane: async (pane, ancestors) => {
        const session = sessionForPaneId(registry.list(), pane)
        if (!session) return null
        if (ancestors) {
          const pid = panePid ? await panePid(session).catch(() => null) : null
          if (pid === null || !ancestors.includes(pid)) return null
        }
        return { agentId: session.agentId, guest: !!session.guest }
      },
    },
    ...(count ? { count } : {}),
    turns,
    questions,
    transcripts: { databaseHistory, lastTurn },
    account: { mintGridName, accessToken, lane, observerKey, tabKey, tabRelay, connectorSync, privateGridName, machineName, backend,
      identity: accountIdentity(backend), onNotice, signedIn, environment, machines },
    clients: {
      viewerChanged, gridNamed, gridModelsChanged, dshInstallStatus, windows, observer, hasWindow, devicesChanged, dialWatching,
      streamFrame: streamFrame ?? (() => false),
      ...(streamBytes ? { streamBytes } : {}),
      sendWindow: LOCAL_WINDOW_OFF,
      turnCard: (frame) => {
        if (!TURN_CARD_TYPES.has(frame?.type)) { refusedRecap(frame?.type); return }
        // A delayed session card cannot describe the agent's replacement conversation.
        const current = typeof frame.agentId === 'string' ? registry.byAgent(frame.agentId) : undefined
        if (typeof frame.dbSessionId === 'string' && frame.dbSessionId && current?.sessionId === frame.dbSessionId) turnCard(frame)
      },
      turnSummary: (frame) => { if (TURN_SUMMARY_TYPES.has(frame?.type)) turnSummary(frame); else refusedRecap(frame?.type) },
      ...(goalDone ? { hachiGoalDone: goalDone } : {}),
    },
    daemon,
    ...(owners ? { owners } : {}),
  }
}
