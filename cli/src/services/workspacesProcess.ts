/**
 * Workspaces in their own process (`harness __service workspaces`, with `HARNESSD_SERVICES=workspaces`).
 *
 * The same branch naming as in the core's process (services/workspaces.ts), on a core API built here. It names branches
 * when the core says so (core/workspacesLink.ts), with the live agents the core sends on each terminal-title pass, and
 * after a rename asks the core to send the agent's frame again. A `sweep` an older core still sends is ignored: no
 * worktree is removed on a timer (#4166). The git work (renames, their timeouts) is this process's alone: a hang or a
 * crash in it costs workspaces, and the master starts them again.
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
 * The core API workspaces run on in their own process. The live agents are the ones the core last sent; stopped ones are
 * never asked for. A frame sent again (after a rename) is the core's to send: `renamed` asks it to.
 */
export function workspacesCoreApi(
  dataDir: string,
  view: { live(): RegisteredSession[] },
  renamed: (agentId: string) => void,
): CoreApi {
  return {
    dataDir,
    conversations: CONVERSATIONS_OFF,
    terminals: TERMINALS_OFF,
    machine: UNASKED.machine,
    agents: {
      all: () => { throw new Error('workspaces never list stopped agents') },
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
      activity: UNASKED.activity,
      summaries: UNASKED.summaries,
    },
    // The workspaces drive no agent: these are never asked of them.
    turns: { send: () => {}, stop: () => {}, recent: async () => [], asks: async () => [], ...DELIVERIES_OFF },
    questions: { answer: () => {}, answerReviewed: async () => false },
    transcripts: { databaseHistory: () => undefined, lastTurn: UNASKED.lastTurn },

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
  let core: CoreConnection | null = null
  const ports = emptyPorts()
  // Lost only with the connection: the frame then shows the new branch when the core's read of the
  // folder expires (lib/agentProject.ts), seconds later.
  const renamed = (agentId: string): void => { void core?.query('branchNamed', { agentId }).catch(() => {}) }
  ;(options.start ?? startWorkspaces)(workspacesCoreApi(options.dataDir, { live: () => live }, renamed), ports)
  if (!ports.workspaces) throw new Error('workspaces did not start')
  const workspaces = ports.workspaces

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
      }
    },
    onConnected: (connection) => { core = connection },
  })
  return { stop: () => service.stop() }
}
