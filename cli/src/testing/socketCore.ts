/**
 * The core's requests answered the way the daemon answers them, for a socket a spec builds on its own.
 * Requests that left the socket's switch for the core are bound by cli.ts, so a bare socket answers them
 * UNSUPPORTED. These bind them the same way, over the registry and the socket's own pieces, read when a
 * request comes in so a spec can still swap a piece after binding.
 */
import { join } from 'node:path'
import type { BackendSocket } from '../backendSocket.js'
import { env } from '../config/env.js'
import { createCloseRequests } from '../core/agents/close.js'
import { createHandoffRequest, type Handoff, type HandoffRequest } from '../services/handoffRequest.js'
import { createLaunchRequests, type LaunchRequestDeps, type RestartAgent, type ResumeAgent } from '../core/agents/launches.js'
import { MODELS_OFF } from '../core/api.js'
import { createPurgeRequest, createStopRequest } from '../core/agents/lifecycle.js'
import { createAgentList, type AgentListDeps } from '../core/agents/list.js'
import { createAgentUpdate } from '../core/agents/update.js'
import { createMessageRequest } from '../core/input.js'
import { createQuestionResponse } from '../core/questions.js'
import { engineTranscriptFor } from '../engines/transcripts.js'
import { createHistory } from '../core/transcripts/history.js'
import { createTerminalRequests, type TerminalRequestDeps } from '../core/terminals/requests.js'
import { createCancelRequest } from '../core/turns/cancel.js'
import { AgentCreationReceipts } from '../lib/agentCreationReceipt.js'
import { createHarnessResourcesReader } from '../lib/harnessResources.js'
import { createHarnessStorageReader } from '../lib/harnessTelemetry.js'
import { hermesDbForSession } from '../lib/hermesHome.js'
import { registry } from '../lib/registry.js'
import { stoppedAgents } from '../lib/stoppedAgents.js'
import { TranscriptPager } from '../lib/transcriptPages.js'
import { tmuxPaneInfo } from '../lib/tmux.js'

/** `session_get` and `sessions_list` (core/transcripts/history.ts), over the registry and the saved
 *  harnesses, and a pager of their own. */
export function bindHistory(socket: BackendSocket): void {
  const history = createHistory({
    readerFor: engineTranscriptFor,
    resolve: (id) => registry.resolve(id),
    stopped: () => stoppedAgents.list(),
    pages: new TranscriptPager(),
    dbs: { opencode: join(env.OPENCODE_DATA_DIR, 'opencode.db'), kilo: join(env.KILO_DATA_DIR, 'kilo.db'), devin: join(env.DEVIN_HOME, 'sessions.db') },
    hermesDb: (s) => hermesDbForSession(s),
  })
  socket.historyProvider = history.sessionGet
  socket.sessionsProvider = history.sessionsList
}

const monitors = new WeakMap<BackendSocket, Pick<AgentListDeps, 'harnessResourcesReader' | 'harnessStorageReader'>>()
/** The monitor's readers for a socket, one of each as the daemon's monitor service holds them
 *  (services/monitor.ts): the list's readings and a purge's forgetting share them. */
function monitorOf(socket: BackendSocket): Pick<AgentListDeps, 'harnessResourcesReader' | 'harnessStorageReader'> {
  let monitor = monitors.get(socket)
  if (!monitor) {
    monitor = { harnessResourcesReader: createHarnessResourcesReader(() => registry.advertised()), harnessStorageReader: createHarnessStorageReader() }
    monitors.set(socket, monitor)
  }
  return monitor
}

/** `agents_list` (core/agents/list.ts). The daemon knows each agent's activity; a bare socket does not,
 *  unless a spec says what it is. */
export function bindAgentList(socket: BackendSocket, over: Partial<AgentListDeps> = {}): void {
  socket.agentsProvider = createAgentList({
    registry,
    stoppedAgents,
    toProject: (s) => socket.toProject(s),
    toStoppedProject: (s) => socket.toStoppedProject(s),
    ...monitorOf(socket),
    monitorActivityProvider: null,
    monitorCompletions: socket.monitorCompletions,
    ...over,
  }).agentsList
}

/** `terminal_info` and `theme_set` (core/terminals/requests.ts). A bare socket paints no panes: a spec
 *  that checks a theme says where it goes. */
export function bindTerminalRequests(socket: BackendSocket, over: Partial<TerminalRequestDeps> = {}): void {
  const requests = createTerminalRequests({ resolve: (id) => registry.resolve(id), paneInfo: (pane) => tmuxPaneInfo(pane), applyTheme: () => {}, ...over })
  socket.terminalInfoProvider = requests.terminalInfo
  socket.themeProvider = requests.themeSet
}

/** `question_response` (core/questions.ts), keyed into a dialog by `answer`. */
export function bindQuestionResponse(socket: BackendSocket, answer: Parameters<typeof createQuestionResponse>[0]): void {
  socket.questionProvider = createQuestionResponse(answer)
}

/** `message` (core/input.ts), written into a pane by `submit`. */
export function bindMessageRequest(socket: BackendSocket, submit: Parameters<typeof createMessageRequest>[0]): void {
  socket.messageProvider = createMessageRequest(submit)
}

/** `cancel` (core/turns/cancel.ts), a turn interrupted by `cancel`. */
export function bindCancelRequest(socket: BackendSocket, cancel: Parameters<typeof createCancelRequest>[0]): void {
  socket.cancelProvider = createCancelRequest(cancel)
}

/** `agent_delete` (core/agents/lifecycle.ts), stopped by `stop`. */
export function bindStopRequest(socket: BackendSocket, stop: (agentId: string) => void | Promise<void>): void {
  socket.stopProvider = createStopRequest({ byAgent: (id) => registry.byAgent(id), stop })
}

/** `agents_cleanup_preview` and `agent_close` (core/agents/close.ts), closing through the socket's own close
 *  service, which the daemon also gives it to dispose of. */
export function bindCloseRequests(socket: BackendSocket, cleanupPreview: () => Promise<Record<string, unknown>> = async () => ({ version: 1, agents: [], kept: 0 })): void {
  const requests = createCloseRequests({ cleanupPreview, closeAgentService: () => socket.closeAgentService })
  socket.cleanupPreviewProvider = requests.preview
  socket.closeProvider = requests.close
}

/** `agent_purge` and `agent_worktree_delete` (core/agents/lifecycle.ts), through the socket's own purge service. */
export function bindPurgeRequest(socket: BackendSocket): void {
  socket.purgeProvider = createPurgeRequest({ purgeAgentService: () => socket.purgeAgentService, invalidateStorage: () => { void monitorOf(socket).harnessStorageReader([], true) } })
}

/** `agent_update` (core/agents/update.ts). A bare socket moves no agent to another model and titles no pane. */
export function bindAgentUpdate(socket: BackendSocket): void {
  socket.agentUpdateProvider = createAgentUpdate({
    registry, clients: socket, toProject: (s) => socket.toProject(s), closeAgentService: () => socket.closeAgentService,
    onAgentRename: null, onRuntimeProfileUpdate: null,
  }).agentUpdate
}

/** The handoff service's request through the socket's normal service router. */
export function bindHandoffRequest(socket: BackendSocket, prepare: ((req: HandoffRequest) => Promise<Handoff>) | null): void {
  const previous = socket.serviceRouter
  const answer = createHandoffRequest({ prepare })
  socket.serviceRouter = (type, payload, asker, reply) => {
    if (type !== 'agent_handoff_prepare') return previous?.(type, payload, asker, reply) ?? false
    answer(payload, asker, reply)
    return true
  }
}

type Launcher = { resume: ResumeAgent | null; restart: RestartAgent | null; modelTarget: LaunchRequestDeps['modelTarget'] | null }
const launchers = new WeakMap<BackendSocket, Launcher>()
/** `agent_create`, `agent_create_status`, `agent_resume`, `agent_restart` and `agent_fork`
 *  (core/agents/launches.ts), over the socket's create and fork slots and receipts of their own. A spec
 *  that resumes, restarts or creates on a grid model says through what (with none, models reads as off);
 *  each call adds to what the last one said. */
export function bindLaunchRequests(socket: BackendSocket, over: Partial<Launcher> = {}): void {
  let launcher = launchers.get(socket)
  if (!launcher) {
    const state: Launcher = { resume: null, restart: null, modelTarget: null }
    launcher = state
    launchers.set(socket, state)
    const launches = createLaunchRequests({
      receipts: new AgentCreationReceipts(join(env.ADAPTER_DATA_DIR, 'agent-creations')),
      createAgent: () => socket.onCreateAgent, forkAgent: () => socket.onForkAgent,
      resumeAgent: () => state.resume, restartAgent: () => state.restart,
      byAgent: (id) => registry.byAgent(id), toProject: (s) => socket.toProject(s),
      modelTarget: (selection) => (state.modelTarget ?? MODELS_OFF.launchTarget)(selection),
    })
    socket.createProvider = launches.create
    socket.createStatusProvider = launches.createStatus
    socket.restartProvider = launches.relaunch
    socket.forkProvider = launches.fork
  }
  Object.assign(launcher, over)
}
