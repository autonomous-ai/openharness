/**
 * The core API a light service runs on in its own process (the edge host: usage, the monitor, the project
 * readers): the agents the core last said, and nothing else. Each process asks the core for what it reads
 * (`service_query live` or `advertised`, core/agentQueries.ts) as each request starts, so it answers as
 * the core's registry would at that moment, never from a copy that waited.
 *
 * What these services never ask (turns, questions, sign-in, the windows) answers as nothing, and a
 * credential is refused: a service holds none (services/AGENTS.md).
 *
 * An experiment acts on the core as well (core/experimentQueries.ts): it creates agents, stops a turn,
 * delivers turns (services/turnsLink.ts) and tells the windows it changed, each asked of the core over its
 * link (`ask`). The agents it reads come as the apps are shown them (`service_query shown`): each with its
 * name, whether its terminal is there and its harness's viewer.
 */
import { DAEMON_UNKNOWN, DELIVERIES_OFF, LANE_OFF, resolveAgent, TERMINALS_OFF, type CoreApi, type DaemonAddress } from '../core/api.js'
import type { AgentDshContext } from '../lib/agentFrame.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { turnsLink } from './turnsLink.js'

type Payload = Record<string, unknown>

/** An agent as the core shows it to an experiment (core/experimentQueries.ts `shown`). */
export type ShownAgent = RegisteredSession & { displayName?: string; terminalAvailable?: boolean; dshContext?: AgentDshContext | null }

/** The agents a process was last told of, and how it asks the core to act. Those it is never told of read
 *  as none, and with no way to ask, it acts on nothing. */
export interface AgentsView {
  live?: () => ShownAgent[]
  advertised?: () => RegisteredSession[]
  /** Ask the core (`CoreConnection.query`, services/process.ts), for an experiment that acts. */
  ask?: (query: string, payload: Payload) => Promise<Payload>
  /** The delivered turns it makes and hears of, through `ask` (services/turnsLink.ts). */
  deliveries?: ReturnType<typeof turnsLink>
  /** Where this daemon runs, as the core last said (`service_query daemon`). */
  daemon?: () => DaemonAddress | null
}

/** Whether what the core sent is an agent. */
export const isSession = (value: unknown): value is RegisteredSession =>
  !!value && typeof value === 'object' && typeof (value as { agentId?: unknown }).agentId === 'string'

/** The agents in a core's answer (`{ agents: [...] }`), or null when it is not one. */
export function agentsIn(answer: Record<string, unknown> | null | undefined): RegisteredSession[] | null {
  return Array.isArray(answer?.agents) ? answer.agents.filter(isSession) : null
}

/** The daemon's address in a core's answer (`service_query daemon`), or null when it is not one. */
export function daemonIn(answer: Payload | null | undefined): DaemonAddress | null {
  if (typeof answer?.command !== 'string' || typeof answer.port !== 'number' || typeof answer.machineId !== 'string') return null
  const machineId = answer.machineId
  return { command: answer.command, port: answer.port, machineId: () => machineId }
}

export function processCoreApi(dataDir: string, service: string, view: AgentsView = {}): CoreApi {
  const live = (): ShownAgent[] => view.live?.() ?? []
  const ask = view.ask
  const daemon = (): DaemonAddress => view.daemon?.() ?? DAEMON_UNKNOWN
  return {
    dataDir,
    // Terminals are launched by the core alone (the shell service, #893): a service in its own process
    // is refused, never handed a way to start a process outside the core.
    terminals: TERMINALS_OFF,
    agents: {
      // The stopped agents are never sent to these services: none of them reads one.
      all: live,
      live,
      displayName: (session) => (session as ShownAgent).displayName ?? '',
      byAgent: (agentId) => live().find((session) => session.agentId === agentId),
      resolve: (id) => resolveAgent(live(), id),
      advertised: () => view.advertised?.() ?? [],
      terminalAvailable: (agentId) => live().find((session) => session.agentId === agentId)?.terminalAvailable === true,
      sync: () => {},
      runtimeModels: async () => [],
      runtimeProfile: () => null,
      setRuntime: () => {},
      fork: async () => ({ ok: false, error: 'UNSUPPORTED' }),
      create: async (request) => {
        if (!ask) return { ok: false, error: 'SERVICE_UNAVAILABLE' }
        const answer = await ask('create', { ...request }).catch((): Payload => ({ error: 'SERVICE_UNAVAILABLE' }))
        if (answer.ok === true && typeof answer.agentId === 'string') return { ok: true, agentId: answer.agentId }
        return { ok: false, error: typeof answer.error === 'string' ? answer.error : 'CREATE_FAILED', ...(typeof answer.detail === 'string' ? { detail: answer.detail } : {}) }
      },
      dsh: (session) => (session as ShownAgent).dshContext ?? null,
    },
    turns: {
      send: () => {},
      stop: (agentId) => { void ask?.('stop_turn', { agentId }).catch(() => {}) },
      recent: () => [],
      asks: () => [],
      ...(view.deliveries?.turns ?? DELIVERIES_OFF),
    },
    questions: { answer: () => {}, answerReviewed: async () => false },
    transcripts: { databaseHistory: () => undefined },
    external: {
      sessions: { list: () => [], scan: async () => [] },
      open: { known: () => new Map(), fresh: async () => new Map() },
    },
    account: {
      mintGridName: async () => null,
      accessToken: () => Promise.reject(new Error(`${service} holds no credential`)),
      lane: LANE_OFF,
      privateGridName: async () => null,
      machineName: () => null,
    },
    clients: {
      viewerChanged: () => {}, gridNamed: () => {}, gridModelsChanged: () => {}, dshInstallStatus: () => {},
      windows: (frame) => { void ask?.('windows', { frame }).catch(() => {}) },
    },
    daemon: {
      get command() { return daemon().command },
      get port() { return daemon().port },
      machineId: () => daemon().machineId(),
    },
  }
}
