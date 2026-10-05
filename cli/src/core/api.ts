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
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { GridAccess } from '../lib/gridAttach.js'
import type { AgentGridTarget } from '../lib/gridModels.js'
import type { LiveEvent } from '../lib/normalize.js'
import { projectDisplayName, type registry, type RegisteredSession } from '../lib/registry.js'
import type { ExternalSessions, OpenSessions } from '../lib/sessionSearch/external.js'
import type { SessionSearchIndex } from '../lib/sessionSearch/indexer.js'
import type { StoppedAgentStore } from '../lib/stoppedAgents.js'
import type { SwarmPromptScopes } from '../teams/promptScope.js'
import { FAIL, later, type PortFallbacks } from './serviceHost.js'

export interface CoreApi {
  /** The daemon's data folder; a service keeps its own files in it. */
  dataDir: string
  agents: {
    /** Every agent on this machine: the live ones, then the stopped ones. */
    all(): RegisteredSession[]
    /** The live agents. */
    live(): RegisteredSession[]
    /** The name the apps show for an agent. */
    displayName(session: RegisteredSession): string
    /** A live agent, by its agent id. */
    byAgent(agentId: string): RegisteredSession | undefined
    /** The live agents the apps are shown. */
    advertised(): RegisteredSession[]
    /** Whether the agent's terminal is attached: a frame without one reads to the apps as "agent gone". */
    terminalAvailable(agentId: string): boolean
    /** Send the agent's frame to the apps again. */
    sync(session: RegisteredSession): void
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
  }
  clients: {
    /** An agent's viewer moved: the windows' viewer panes forward to the new one. */
    viewerChanged(agentId: string): void
    /** The account's grid has a name: the models picker answers with it at once. */
    gridNamed(name: string): void
    /** A harness being installed or updated moved on (`dsh_install_status`): the apps show it in the
     *  create dialog. */
    dshInstallStatus(status: Record<string, unknown>): void
  }
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

/** Each port is filled by the service that owns it when that service starts, and is null while the
 *  service is off: the core never waits on one. */
export interface CorePorts {
  search: SearchPort | null
  viewers: ViewersPort | null
  models: ModelsPort | null
  workspaces: WorkspacesPort | null
  teams: TeamsPort | null
}

export function emptyPorts(): CorePorts {
  return { search: null, viewers: null, models: null, workspaces: null, teams: null }
}

export interface CoreApiDeps {
  dataDir: string
  registry: Pick<typeof registry, 'list' | 'byAgent' | 'advertised' | 'terminalAvailable'>
  stoppedAgents: Pick<StoppedAgentStore, 'list'>
  databaseHistory: CoreApi['transcripts']['databaseHistory']
  externalSessions: CoreApi['external']['sessions']
  openSessions: CoreApi['external']['open']
  syncSession: CoreApi['agents']['sync']
  viewerChanged: CoreApi['clients']['viewerChanged']
  gridNamed: CoreApi['clients']['gridNamed']
  dshInstallStatus: CoreApi['clients']['dshInstallStatus']
  mintGridName: CoreApi['account']['mintGridName']
  accessToken: CoreApi['account']['accessToken']
}

export function createCoreApi({
  dataDir, registry, stoppedAgents, databaseHistory, externalSessions, openSessions, syncSession, viewerChanged,
  gridNamed, dshInstallStatus, mintGridName, accessToken,
}: CoreApiDeps): CoreApi {
  return {
    dataDir,
    agents: {
      all: () => [...registry.list(), ...stoppedAgents.list()],
      live: () => registry.list(),
      displayName: projectDisplayName,
      byAgent: (agentId) => registry.byAgent(agentId),
      advertised: () => registry.advertised(),
      terminalAvailable: (agentId) => registry.terminalAvailable(agentId),
      sync: syncSession,
    },
    transcripts: { databaseHistory },
    external: { sessions: externalSessions, open: openSessions },
    account: { mintGridName, accessToken },
    clients: { viewerChanged, gridNamed, dshInstallStatus },
  }
}
