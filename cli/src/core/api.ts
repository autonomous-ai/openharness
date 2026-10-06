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
import type { CableAgent, CableMachine, CableMachineSource } from '../cable/cableSession.js'
import type { FleetEvent } from '../cable/machineFleet.js'
import type { AnswerReceipt, ReviewedAnswer } from '../cable/questionInbox.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { GridAccess } from '../lib/gridAttach.js'
import type { createHarnessResourcesReader } from '../lib/harnessResources.js'
import type { createHarnessStorageReader } from '../lib/harnessTelemetry.js'
import type { AgentGridTarget } from '../lib/gridModels.js'
import type { LiveEvent } from '../lib/normalize.js'
import { projectDisplayName, type registry, type RegisteredSession } from '../lib/registry.js'
import type { RuntimeModelOption } from '../lib/runtimeProfile.js'
import type { RouterContinuity } from '../lib/voiceRouter.js'
import type { ExternalSessions, OpenSessions } from '../lib/sessionSearch/external.js'
import type { SessionSearchIndex } from '../lib/sessionSearch/indexer.js'
import type { StoppedAgentStore } from '../lib/stoppedAgents.js'
import type { RouteAnswer } from '../localWsServer.js'
import type { SwarmPromptScopes } from '../teams/promptScope.js'
import { FAIL, later, ServiceUnavailableError, type PortFallbacks } from './serviceHost.js'

export type { RouteAnswer }

/** A service may open a terminal with a literal argv, never shell source. */
export interface TerminalOpen {
  argv: string[]
  cwd: string
}
export type TerminalOpenResult = { ok: true; agentId: string } | { ok: false; error: string; detail?: string }
export interface TerminalsPort { open(request: TerminalOpen): Promise<TerminalOpenResult> }
/** A service without the core's launch call must refuse, never launch outside the core. */
export const TERMINALS_OFF: TerminalsPort = {
  open: async () => ({ ok: false, error: 'SERVICE_UNAVAILABLE' }),
}

export interface CoreApi {
  /** The daemon's data folder; a service keeps its own files in it. */
  dataDir: string
  terminals: TerminalsPort
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
  }
  /** A device's or another machine's turns for an agent on this one: the doors the web and the hooks use. */
  turns: {
    /** Deliver text into a live agent. */
    send(agentId: string, text: string): void
    /** Stop a live agent's turn. */
    stop(agentId: string): void
    /** A live agent's last `n` completed turns, newest first. */
    recent(agentId: string, n: number): RecentTurn[]
    /** The person's own last questions to a live agent, newest first. */
    asks(agentId: string): string[]
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
    /** This machine's harness access token, for handing a sign-in to grid. Rejects when signed out. */
    accessToken(): Promise<string>
    /** The account's private grid: the backend's word when it gave one, else what this machine works
     *  out (`lib/gridDerive.ts`); null when it has none. */
    privateGridName(): Promise<string | null>
    /** This machine's name as the account's Machines list shows it (the backend's `machine_meta`); null
     *  until the first one lands. */
    machineName(): string | null
  }
  clients: {
    /** An agent's viewer moved: the windows' viewer panes forward to the new one. */
    viewerChanged(agentId: string): void
    /** The account's grid has a name: the models picker answers with it at once. */
    gridNamed(name: string): void
    /** What the models picker lists may have changed (a local model started or stopped, grid set up):
     *  the windows on this computer are pushed the list again (`grid_models_changed`). */
    gridModelsChanged(): void
    /** A harness being installed or updated moved on (`dsh_install_status`): the apps show it in the
     *  create dialog. */
    dshInstallStatus(status: Record<string, unknown>): void
  }
}

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
}

/** A request a service answers for the apps: the reply, or a promise of it. A throw or a rejection is
 *  answered `SERVICE_FAILED` by the host and counted against the service. */
export type ServiceRequest = (payload: Record<string, unknown>, asker: Asker) => Record<string, unknown> | Promise<Record<string, unknown>>

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
/** The project and folder readers (services/projects.ts). */
export const PROJECTS_REQUESTS = ['git_pull_request', 'git_project_info', 'project_preview', 'fs_list_dir', 'agent_read_file'] as const
/**
 * Models (services/models.ts).
 *
 * The Model Manager's grid commands, `grid_fleet_run` and `grid_fleet_cancel`, are still the socket's:
 * a command is a job of the connection that started it, and a cancel stops only that connection's job
 * (`lib/gridFleetRpc.ts`), while a request answered by a service knows who asked but not over which
 * connection. Their handshake, `grid_fleet_capabilities`, stays beside them: the Grid harness runs a
 * command only after it, and reads an answer without its protocol as "update Harness".
 * The saved APIs and the Codex profiles came out of the socket's switch (launchTargetRequests).
 */
export const MODELS_REQUESTS = [
  'grid_models_list', 'models_list',
  'grid_fleet_models_list', 'grid_fleet_model_download', 'grid_fleet_model_start', 'grid_fleet_model_stop',
  'api_connections', 'codex_profiles_list', 'codex_profile_link',
] as const

/** The core's calls into session search: index a session at its turn boundaries, forget a purged
 *  conversation, the title it indexed for one being adopted, and stopping its sweeps. The apps' own
 *  requests (`session_search`, `session_tail`) are its `ServiceRequests`, not the core's calls. */
export type SearchPort = Pick<SessionSearchIndex, 'touch' | 'deleteHistory' | 'session' | 'stop'>

/** What the core gets when search fails: nothing indexed and no title. */
export const SEARCH_FALLBACKS: PortFallbacks<SearchPort> = {
  touch: undefined, deleteHistory: undefined, session: undefined, stop: undefined,
}

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
}

/** What the core gets when the viewers fail: agents' frames carry no DSH context and the windows
 *  no viewer, and a restart or shutdown goes on. */
export const VIEWERS_FALLBACKS: PortFallbacks<ViewersPort> = {
  attach: undefined, detach: undefined, frameContext: null, forwardingUrl: null, stop: later(undefined),
}

/** The core's calls into models (grid): have grid ready, whether it is set up, and the two things
 *  the core tells it — someone is typing to an agent on a grid, and the sign-in ended. */
export interface ModelsPort {
  /** Have grid ready for what the caller is about to do; resolves with what happened, never rejects. */
  ensure: GridAccess['ensure']
  /** Offline: is there a `grid` here holding a sign-in? */
  setUp(): boolean
  /** Start the agent's sleeping grid while someone types to it. */
  prewarm(grid: AgentGridTarget): void
  /** The sign-in ended: drop what lives exactly as long as it. */
  signedOut(): void
}

/** What the core gets when models fails: a grid request answered with an error, grid read as not
 *  set up, and no prewarm. */
export const MODELS_FALLBACKS: PortFallbacks<ModelsPort> = {
  ensure: later(FAIL), setUp: false, prewarm: undefined, signedOut: undefined,
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

/** The core's calls into the teams: which team a prompt belongs to, recorded as a message is written,
 *  as a turn starts (from its hook or its transcript), as it is typed into a scoped terminal, and
 *  forgotten with its agent. */
export type TeamsPort = Pick<SwarmPromptScopes, 'prepare' | 'started' | 'raw' | 'forget'>

/** What the core gets when the teams fail: the prompt is written with no team recorded for it. */
export const TEAMS_FALLBACKS: PortFallbacks<TeamsPort> = { prepare: () => {}, started: undefined, raw: undefined, forget: undefined }

/** The prompt scopes whole, as the socket's team features hold them: the core's calls (`TeamsPort`),
 *  and the team a prompt came from (`current`), which an agent's answer to a team's question moves
 *  back (`replied`). In the core's process the socket's own; in their own, core/teamsLink.ts. */
export type PromptScopes = TeamsPort & Pick<SwarmPromptScopes, 'current' | 'replied'>

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
/** A fork and where it was asked: `asked` is false for a refusal made before asking anyone (an agent
 *  never listed, a daemon or a fleet that cannot fork), which nobody needs to hear about. */
export interface ForkOutcome { result: ForkResult; machineId: string; asked: boolean }
/** A machine selected for the dial, or the refusal a person can act on. */
export type SelectResult = { ok: true } | { ok: false; code: string; message: string }

/**
 * Which machine an agent is on, and a turn, a stop or an answer reaching it there: the fleet's router
 * (services/fleetRouter.ts), as the dial asks it. Also the lane to the other machines, which the dial
 * holds while it is plugged in. A refusal is an answer here, never a throw: through the port, a throw is
 * a failure of the fleet service, and counts toward switching it off.
 */
export interface FleetRouting {
  listMachines(): Promise<{ machines: CableMachine[]; source: CableMachineSource }>
  listAgentsFlat(): Promise<CableAgent[]>
  agentTotal(): number
  describe(agentId: string): { name: string; engine: string; machine: string } | undefined
  noteAgent(machineId: string, agentId: string): void
  machineOf(agentId: string): string
  knows(agentId: string): boolean
  isLocalAgent(agentId: string): boolean
  sendTurn(agentId: string, text: string): SendResult
  lastRouted(): RouterContinuity | undefined
  stopTurn(agentId: string): void
  canSpeakQuestion(agentId: string): boolean
  answerReviewed(answer: ReviewedAnswer): Promise<AnswerReceipt>
  answer(agentId: string, requestId: string, answers: Record<string, string>): void
  updateAgent(agentId: string, model?: string, effort?: string): void
  recentSummaries(agentId: string): Promise<Array<{ recap: string; text: string; ask: string }>>
  recentAsks(agentId: string): Promise<string[]>
  listModels(agentId: string): Promise<string[]>
  forkAgent(agentId: string): Promise<ForkOutcome>
  /** Whether a lane to the other machines exists: signed in, with the fleet's own fleet. */
  hasLane(): boolean
  /** Hold the lane for a dial, attached to no machine. Resolves with how it went; never rejects. */
  online(): Promise<{ ok: true } | { ok: false; message: string }>
  select(machineId: string): Promise<SelectResult>
  release(immediate?: boolean): void
}

/** The core's calls into the fleet: ⌘K's two requests — which agent a typed task belongs to, on any of
 *  the owner's machines, and delivering it to that agent's own machine — the routing the dial asks of
 *  it, the cards the other machines send, and stopping the lane to them for a shutdown. */
export interface FleetPort extends FleetRouting {
  routeTask(text: string): Promise<RouteAnswer>
  routeSend(agentId: string, text: string): SendResult
  /** The other machines' cards, for the dial. Returns how to stop hearing them. */
  onEvent(listener: (event: FleetEvent) => void): () => void
  stop(): void
}

const FLEET_UNAVAILABLE = 'the fleet service is unavailable'

/**
 * What the core gets when the fleet fails. ⌘K says so, picking no agent and sending nothing; a shutdown
 * goes on; the cards stop. The dial's routing FAILs: the dial routes this computer by itself then, as it
 * does with the fleet off (cable/cableHost.ts), rather than reading a made-up answer as the fleet's.
 */
export const FLEET_FALLBACKS: PortFallbacks<FleetPort> = {
  routeTask: later({ agentId: '', machineId: '', name: '', confidence: 0, reason: FLEET_UNAVAILABLE, candidates: [], weighed: 0, machines: 0, via: '' }),
  routeSend: { ok: false, machine: '', reason: FLEET_UNAVAILABLE },
  onEvent: () => {},
  stop: undefined,
  listMachines: later(FAIL), listAgentsFlat: later(FAIL), agentTotal: FAIL, describe: FAIL, noteAgent: FAIL,
  machineOf: FAIL, knows: FAIL, isLocalAgent: FAIL, sendTurn: FAIL, lastRouted: FAIL, stopTurn: FAIL,
  canSpeakQuestion: FAIL, answerReviewed: later(FAIL), answer: FAIL, updateAgent: FAIL, recentSummaries: later(FAIL),
  recentAsks: later(FAIL), listModels: later(FAIL), forkAgent: later(FAIL), hasLane: FAIL, online: later(FAIL),
  select: later(FAIL), release: FAIL,
}

/** Each port is filled by the service that owns it when that service starts, and is null while the
 *  service is off: the core never waits on one. */
export interface CorePorts {
  search: SearchPort | null
  viewers: ViewersPort | null
  models: ModelsPort | null
  workspaces: WorkspacesPort | null
  teams: TeamsPort | null
  fleet: FleetPort | null
  monitor: MonitorPort | null
}

export function emptyPorts(): CorePorts {
  return { search: null, viewers: null, models: null, workspaces: null, teams: null, fleet: null, monitor: null }
}

export interface CoreApiDeps {
  terminals?: TerminalsPort
  dataDir: string
  registry: Pick<typeof registry, 'list' | 'byAgent' | 'resolve' | 'advertised' | 'terminalAvailable'>
  stoppedAgents: Pick<StoppedAgentStore, 'list'>
  databaseHistory: CoreApi['transcripts']['databaseHistory']
  externalSessions: CoreApi['external']['sessions']
  openSessions: CoreApi['external']['open']
  syncSession: CoreApi['agents']['sync']
  runtimeModels: CoreApi['agents']['runtimeModels']
  viewerChanged: CoreApi['clients']['viewerChanged']
  gridNamed: CoreApi['clients']['gridNamed']
  gridModelsChanged: CoreApi['clients']['gridModelsChanged']
  dshInstallStatus: CoreApi['clients']['dshInstallStatus']
  mintGridName: CoreApi['account']['mintGridName']
  accessToken: CoreApi['account']['accessToken']
  privateGridName: CoreApi['account']['privateGridName']
  machineName: CoreApi['account']['machineName']
  runtimeProfile: CoreApi['agents']['runtimeProfile']
  setRuntime: CoreApi['agents']['setRuntime']
  fork: CoreApi['agents']['fork']
  turns: CoreApi['turns']
  questions: CoreApi['questions']
}

export function createCoreApi({
  dataDir, registry, stoppedAgents, databaseHistory, externalSessions, openSessions, syncSession, runtimeModels, viewerChanged,
  gridNamed, gridModelsChanged, dshInstallStatus, mintGridName, accessToken, privateGridName, machineName,
  runtimeProfile, setRuntime, fork, turns, questions, terminals = TERMINALS_OFF,
}: CoreApiDeps): CoreApi {
  return {
    dataDir,
    terminals,
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
    },
    turns,
    questions,
    transcripts: { databaseHistory },
    external: { sessions: externalSessions, open: openSessions },
    account: { mintGridName, accessToken, privateGridName, machineName },
    clients: { viewerChanged, gridNamed, gridModelsChanged, dshInstallStatus },
  }
}
