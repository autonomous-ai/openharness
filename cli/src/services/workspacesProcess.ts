/**
 * Workspaces in their own process (`harness __service workspaces`, with `HARNESSD_SERVICES=workspaces`).
 *
 * The same branch naming and worktree sweep as in the core's process (services/workspaces.ts), on a core
 * API built here. It acts only when the core says so (core/workspacesLink.ts):
 * - It names branches when told to, with the live agents the core sends on each terminal-title pass.
 * - It sweeps when the core's timer says, asking the core at that moment for every agent, live and
 *   stopped, and sweeping with exactly that answer.
 *
 * It never sweeps on its own, never with agents it kept from earlier, never when the core cannot answer,
 * and never two sweeps at once (services/workspaces.ts). After a rename it asks the core to send the
 * agent's frame again. The git work (renames, worktree removals, their timeouts) is this process's
 * alone: a hang or a crash in it costs workspaces, and the master starts them again.
 */
import type { CoreApi } from '../core/api.js'
import { ACCOUNT_BACKEND_OFF, CONVERSATIONS_OFF, AGENT_ACTIONS_OFF, DAEMON_UNKNOWN, DELIVERIES_OFF, emptyPorts, LANE_OFF, resolveAgent, TERMINALS_OFF } from '../core/api.js'
import type { RegisteredSession } from '../lib/registry.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { UNASKED } from './processCoreApi.js'
import { startWorkspaces } from './workspaces.js'

export interface WorkspacesServiceOptions {
  dataDir: string
  socketPath: string
  machineId: string
  token: string
  /** Swapped in tests for one that does not touch the real socket or process. */
  run?: typeof runServiceProcess
  /** Swapped in tests for workspaces that touch no repository. */
  start?: typeof startWorkspaces
}

const isSession = (value: unknown): value is RegisteredSession =>
  !!value && typeof value === 'object' && typeof (value as { agentId?: unknown }).agentId === 'string'

/**
 * The core API workspaces run on in their own process. The live agents are the ones the core last sent.
 * Every agent, live and stopped, is known only while a sweep the core asked for starts; asked at any
 * other time it throws, and a sweep that cannot list the folders in use sweeps nothing. A frame sent
 * again (after a rename) is the core's to send: `renamed` asks it to.
 */
export function workspacesCoreApi(
  dataDir: string,
  view: { live(): RegisteredSession[]; inUse(): RegisteredSession[] | null },
  renamed: (agentId: string) => void,
): CoreApi {
  return {
    dataDir,
    conversations: CONVERSATIONS_OFF,
    terminals: TERMINALS_OFF,
    machine: UNASKED.machine,
    agents: {
      all: () => {
        const agents = view.inUse()
        if (!agents) throw new Error('the core has not said which folders are in use')
        return agents
      },
      live: () => view.live(),
      displayName: () => '',
      byAgent: (agentId) => view.live().find((session) => session.agentId === agentId),
      resolve: (id) => resolveAgent(view.live(), id),
      advertised: () => [],
      terminalAvailable: () => false,
      sync: (session) => renamed(session.agentId),
      runtimeModels: async () => [],
      runtimeProfile: () => null,
      setRuntime: () => {},
      fork: async () => ({ ok: false, error: 'UNSUPPORTED' }),
      ...AGENT_ACTIONS_OFF,
      activityText: UNASKED.activityText,
    },
    // The workspaces drive no agent: these are never asked of them.
    turns: { send: () => {}, stop: () => {}, recent: async () => [], asks: async () => [], ...DELIVERIES_OFF },
    questions: { answer: () => {}, answerReviewed: async () => false },
    transcripts: { databaseHistory: () => undefined, lastTurn: UNASKED.lastTurn },
    external: {
      sessions: { list: () => [], scan: async () => [] },
      open: { known: () => new Map(), fresh: async () => new Map() },
    },
    account: {
      mintGridName: async () => null,
      accessToken: () => Promise.reject(new Error('workspaces hold no credential')),
      lane: LANE_OFF,
      privateGridName: async () => null,
      machineName: () => null,
      ...ACCOUNT_BACKEND_OFF,
      ...UNASKED.account,
    },
    clients: { viewerChanged: () => {}, viewerFrame: () => false, gridNamed: () => {}, gridModelsChanged: () => {}, dshInstallStatus: () => {}, windows: () => {}, observer: () => false, ...UNASKED.clients },
    daemon: DAEMON_UNKNOWN,
    wifi: UNASKED.wifi,
  }
}

export function runWorkspacesService(options: WorkspacesServiceOptions): ServiceProcess {
  let live: RegisteredSession[] = []
  /** Every agent the core named for the sweep starting now; null at every other moment. */
  let inUse: RegisteredSession[] | null = null
  let core: CoreConnection | null = null
  /** A sweep's question to the core is out: a second request meanwhile is the same sweep. */
  let asking = false
  const ports = emptyPorts()
  // Lost only with the connection: the frame then shows the new branch when the core's read of the
  // folder expires (lib/agentProject.ts), seconds later.
  const renamed = (agentId: string): void => { void core?.query('branchNamed', { agentId }).catch(() => {}) }
  ;(options.start ?? startWorkspaces)(workspacesCoreApi(options.dataDir, { live: () => live, inUse: () => inUse }, renamed), ports)
  if (!ports.workspaces) throw new Error('workspaces did not start')
  const workspaces = ports.workspaces

  /** The core's timer says it is time: ask it for every agent now, and sweep with exactly that answer. */
  const sweep = (): void => {
    const connection = core
    if (!connection || asking) return
    asking = true
    void connection.query('agents').then((answer) => {
      // Every entry, as the core sent it: one left out would be a folder in use that looks unused. An
      // answer that is not a list of agents (QUERY_FAILED, when the core could not read them all) is no
      // sweep at all.
      const agents = answer.agents
      if (!Array.isArray(agents) || !agents.every(isSession)) return
      inUse = agents
      try { workspaces.sweepUnused() } catch { /* its own failure: the next timer tries again */ } finally { inUse = null }
    }, () => {}).finally(() => { asking = false })
  }

  const run = options.run ?? runServiceProcess
  const service = run({
    name: 'workspaces',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    // The apps ask workspaces nothing yet: only the core tells it what to do.
    requests: {},
    onEvent: (payload) => {
      if (payload.kind === 'nameBranches' && Array.isArray(payload.agents)) {
        live = payload.agents.filter(isSession)
        workspaces.nameBranches()
      } else if (payload.kind === 'sweep') sweep()
    },
    onConnected: (connection) => { core = connection },
  })
  return { stop: () => service.stop() }
}
