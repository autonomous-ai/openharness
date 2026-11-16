/**
 * Workspaces in their own process (`harness __service workspaces`, with `HARNESSD_SERVICES=workspaces`; in the edge host
 * by default).
 *
 * The same workspaces as in the core's process (services/workspaces.ts), on a core API built here. It names branches
 * when the core says so (core/workspacesLink.ts), with the live agents the core sends on each terminal-title pass, and
 * after a rename asks the core to send the agent's frame again. It makes the folder a create asks git for, and reads and
 * removes a harness's worktree for a purge, as the core asks (`prepareFolder`, `describeWorkspace`, `reviewWorktree`,
 * `removeWorktree`), and says it does each time it connects (`folders`): a core from before asks none of it, and a core
 * of this build asks nothing of a process from before. A `sweep` an older core still sends is ignored: no worktree is
 * removed on a timer (#4166). The git work is this process's alone: a hang or a crash in it costs workspaces, and the
 * master starts them again.
 */
import type { AgentView, CoreApi } from '../core/api.js'
import { ACCOUNT_BACKEND_OFF, CONVERSATIONS_OFF, AGENT_ACTIONS_OFF, DAEMON_UNKNOWN, DELIVERIES_OFF, emptyPorts, LANE_OFF, resolveAgent, TERMINALS_OFF } from '../core/api.js'
import { gitProjectFolderOf } from '../lib/gitProjectFolder.js'
import type { RegisteredSession } from '../lib/registry.js'
import type { WorkspaceTarget, WorktreeReview } from '../lib/worktreeDeletion.js'
import { runServiceProcess, type CoreConnection, type ServiceProcess } from './process.js'
import { processCoreApi, UNASKED } from './processCoreApi.js'
import { followLink } from './followLink.js'
import { createFramePublisher } from './framePublisher.js'
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

const pathOrNull = (value: unknown): string | null | undefined => typeof value === 'string' || value === null ? value : undefined
/** The harness a review is of, as the core sent it: its folder and its conversation's files, each a string or none. */
function targetOf(value: unknown): WorkspaceTarget | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const cwd = pathOrNull(v.cwd)
  if (cwd === undefined) return null
  const target: WorkspaceTarget = { cwd }
  for (const key of ['transcriptPath', 'codexHome', 'hermesHome'] as const) {
    const file = pathOrNull(v[key])
    if (file) target[key] = file
  }
  return target
}
/** The folders every other harness works in, as the core sent them: every one, or none and the request is refused. A
 *  list cut short could leave out the harness whose files a removal would take. */
const othersOf = (value: unknown): string[] | null =>
  Array.isArray(value) && value.length <= 10_000 && value.every((cwd) => typeof cwd === 'string') ? value as string[] : null
const refused = { ok: false, reason: 'The request to review this worktree was malformed.' }

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
  let live: AgentView[] = []
  let core: CoreConnection | null = null
  let following = false
  const lifecycle = followLink({ each: true, frames: true })
  lifecycle.follow(event => {
    if (event.kind === 'running') {
      following ||= !!event.session.frameEpoch
      live = [...live.filter(session => session.agentId !== event.session.agentId), event.session]
    } else if (event.kind === 'ended' || event.kind === 'purged') live = live.filter(session => session.agentId !== event.agentId)
  })
  // Before shared publications the core computed Git facts itself. Its existing refresh query is
  // sufficient during that handover; no second Git publication protocol. Delete 2026-12-18.
  const publisher = createFramePublisher(session => ({ query: 'branchNamed', payload: { agentId: session.agentId } }))
  const ports = emptyPorts()
  // Lost only with the connection: the frame then shows the new branch when the core's read of the
  // folder expires (lib/agentProject.ts), seconds later.
  const renamed = (agentId: string): void => { void core?.query('branchNamed', { agentId }).catch(() => {}) }
  const api = workspacesCoreApi(options.dataDir, { live: () => live }, renamed)
  api.agents.follow = lifecycle.follow
  api.usage = processCoreApi(options.dataDir, 'workspaces', {
    ask: (query, payload) => core?.query(query, payload) ?? Promise.resolve({ error: 'SERVICE_UNAVAILABLE' }),
  }).usage
  ;(options.start ?? startWorkspaces)(publisher.scope(api), ports)
  if (!ports.workspaces) throw new Error('workspaces did not start')
  const workspaces = ports.workspaces

  const run = options.run ?? runServiceProcess
  const service = run({
    name: 'workspaces',
    socketPath: options.socketPath,
    machineId: options.machineId,
    token: options.token,
    // The apps ask workspaces nothing: only the core does, for the git it runs none of (core/workspacesLink.ts).
    requests: {
      prepareFolder: (payload) => {
        const project = gitProjectFolderOf(payload.project)
        return project ? workspaces.prepareFolder(project, { cloneFallback: payload.cloneFallback === true })
          : { ok: false, error: 'INVALID_PROJECT_SOURCE', detail: 'Choose a project.' }
      },
      describeWorkspace: async (payload) => {
        const target = targetOf(payload.target), others = othersOf(payload.others)
        return { workspace: target && others ? await workspaces.describeWorkspace(target, others) : null }
      },
      reviewWorktree: (payload) => {
        const target = targetOf(payload.target), others = othersOf(payload.others)
        return target && others ? workspaces.reviewWorktree(target, others) : refused
      },
      removeWorktree: (payload) => {
        const target = targetOf(payload.target), others = othersOf(payload.others)
        // The review is checked against a fresh one of the same worktree before anything is removed
        // (lib/worktreeDeletion.ts `removeReviewedWorktree`): one that is not what it says removes nothing.
        return target && others && payload.review && typeof payload.review === 'object'
          ? workspaces.removeWorktree(payload.review as WorktreeReview, target, others, payload.discardChanges === true) : refused
      },
    },
    onEvent: (payload) => {
      if (lifecycle.heard(payload)) return
      if (payload.kind === 'nameBranches' && Array.isArray(payload.agents)) {
        if (!following) live = payload.agents.filter(isSession)
        workspaces.nameBranches()
      }
    },
    onConnected: (connection) => {
      core = connection
      publisher.connected(connection)
      void lifecycle.connected((query, payload) => connection.query(query, payload))
      // Said on every connection: a core of this build asks a process for folders only once it has said it makes them.
      // The core reads it as it arrives, so only a connection that ends loses it, and the next one says it again; a
      // failure is still said, as creates that need git wait until it is heard.
      void connection.query('folders').catch((error: unknown) => {
        console.warn(`[workspaces] could not tell the core this process makes folders · ${error instanceof Error ? error.message : String(error)}`)
      })
    },
    onDisconnected: () => {
      core = null; following = false
      publisher.disconnected()
      lifecycle.disconnected()
      for (const session of live) lifecycle.heard({ kind: 'agent', event: { kind: 'ended', agentId: session.agentId } })
      live = []
    },
  })
  return { stop: () => { workspaces.stop(); publisher.disconnected(); lifecycle.disconnected(); return service.stop() } }
}
