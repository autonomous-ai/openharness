/**
 * The core API a light service runs on in its own process (the edge host: usage, the monitor, the project
 * readers): the agents the core last said, and nothing else. Each process asks the core for what it reads
 * (`service_query live` or `advertised`, core/agentQueries.ts) as each request starts, so it answers as
 * the core's registry would at that moment, never from a copy that waited.
 *
 * What these services never ask (turns, questions, sign-in, the windows) answers as nothing, and a
 * credential is refused: a service holds none (services/AGENTS.md).
 */
import { DELIVERIES_OFF, LANE_OFF, resolveAgent, TERMINALS_OFF, type CoreApi } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'

/** The agents a process was last told of. Those it is never told of read as none. */
export interface AgentsView {
  live?: () => RegisteredSession[]
  advertised?: () => RegisteredSession[]
}

/** Whether what the core sent is an agent. */
export const isSession = (value: unknown): value is RegisteredSession =>
  !!value && typeof value === 'object' && typeof (value as { agentId?: unknown }).agentId === 'string'

/** The agents in a core's answer (`{ agents: [...] }`), or null when it is not one. */
export function agentsIn(answer: Record<string, unknown> | null | undefined): RegisteredSession[] | null {
  return Array.isArray(answer?.agents) ? answer.agents.filter(isSession) : null
}

export function processCoreApi(dataDir: string, service: string, view: AgentsView = {}): CoreApi {
  const live = (): RegisteredSession[] => view.live?.() ?? []
  return {
    dataDir,
    // Terminals are launched by the core alone (the shell service, #893): a service in its own process
    // is refused, never handed a way to start a process outside the core.
    terminals: TERMINALS_OFF,
    agents: {
      // The stopped agents are never sent to these services: none of them reads one.
      all: live,
      live,
      displayName: () => '',
      byAgent: (agentId) => live().find((session) => session.agentId === agentId),
      resolve: (id) => resolveAgent(live(), id),
      advertised: () => view.advertised?.() ?? [],
      terminalAvailable: () => false,
      sync: () => {},
      runtimeModels: async () => [],
      runtimeProfile: () => null,
      setRuntime: () => {},
      fork: async () => ({ ok: false, error: 'UNSUPPORTED' }),
    },
    turns: { send: () => {}, stop: () => {}, recent: () => [], asks: () => [], ...DELIVERIES_OFF },
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
    clients: { viewerChanged: () => {}, gridNamed: () => {}, gridModelsChanged: () => {}, dshInstallStatus: () => {} },
  }
}
