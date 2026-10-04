/**
 * The boundary the services stand on (docs/design/2026-10-03-harnessd.md, "The core boundary"):
 * `CoreApi` is what a service may ask of the core, and `CorePorts` is what the core asks of services.
 *
 * Both are in process today. When a service moves into a process of its own, its `CoreApi` calls
 * become requests on the local socket and its port becomes a proxy that sends them; the service's
 * code stays as it is. Members are added as services move behind it, each a call that exists today,
 * never a generic `call(name, args)`.
 */
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { LiveEvent } from '../lib/normalize.js'
import { projectDisplayName, type registry, type RegisteredSession } from '../lib/registry.js'
import type { ExternalSessions, OpenSessions } from '../lib/sessionSearch/external.js'
import type { SessionSearchIndex } from '../lib/sessionSearch/indexer.js'
import type { StoppedAgentStore } from '../lib/stoppedAgents.js'

export interface CoreApi {
  /** The daemon's data folder; a service keeps its own files in it. */
  dataDir: string
  agents: {
    /** Every agent on this machine: the live ones, then the stopped ones. */
    all(): RegisteredSession[]
    /** The name the apps show for an agent. */
    displayName(session: RegisteredSession): string
    /** A live agent, by its agent id. */
    byAgent(agentId: string): RegisteredSession | undefined
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
  clients: {
    /** An agent's viewer moved: the windows' viewer panes forward to the new one. */
    viewerChanged(agentId: string): void
  }
}

/** The core's calls into session search: index a session at its turn boundaries, forget a purged
 *  conversation, the title it indexed for one being adopted, and the two requests it answers
 *  (`session_search`, `session_tail`). */
export type SearchPort = Pick<SessionSearchIndex, 'touch' | 'deleteHistory' | 'session' | 'search' | 'tail'>

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

/** Each port is filled by the service that owns it when that service starts, and is null while the
 *  service is off: the core never waits on one. */
export interface CorePorts {
  search: SearchPort | null
  viewers: ViewersPort | null
}

export function emptyPorts(): CorePorts {
  return { search: null, viewers: null }
}

export interface CoreApiDeps {
  dataDir: string
  registry: Pick<typeof registry, 'list' | 'byAgent' | 'terminalAvailable'>
  stoppedAgents: Pick<StoppedAgentStore, 'list'>
  databaseHistory: CoreApi['transcripts']['databaseHistory']
  externalSessions: CoreApi['external']['sessions']
  openSessions: CoreApi['external']['open']
  syncSession: CoreApi['agents']['sync']
  viewerChanged: CoreApi['clients']['viewerChanged']
}

export function createCoreApi({
  dataDir, registry, stoppedAgents, databaseHistory, externalSessions, openSessions, syncSession, viewerChanged,
}: CoreApiDeps): CoreApi {
  return {
    dataDir,
    agents: {
      all: () => [...registry.list(), ...stoppedAgents.list()],
      displayName: projectDisplayName,
      byAgent: (agentId) => registry.byAgent(agentId),
      terminalAvailable: (agentId) => registry.terminalAvailable(agentId),
      sync: syncSession,
    },
    transcripts: { databaseHistory },
    external: { sessions: externalSessions, open: openSessions },
    clients: { viewerChanged },
  }
}
