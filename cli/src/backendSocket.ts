import type { PurgeAgentService } from './lib/purgeAgentService.js'
import { SHARE_REQUESTS, TEAMS_REQUESTS, type Asker, type LocalWindows, type WindowSurface, type BackendNotice, type GatewayEvents, type GatewayPort, type ModelsPort, type RemoteClient, type RemoteRole, type RemoteTransport } from './core/api.js'
import { ServiceUnavailableError } from './core/serviceHost.js'
import { countWindows } from './lib/windowSurfaces.js'
import type { ViewerStreams } from './core/viewerStreams.js'
import type { ActivityFrame } from './lib/turnActivity.js'
import { MonitorCompletions } from './lib/harnessMonitor.js'
import type { WifiCore } from './core/wifi.js'
/**
 * BackendSocket — the clients' hub and the request dispatch: the windows and tools on this computer
 * (localWsServer.ts), and the remote clients the gateway hands on (gateway/gateway.ts), each in its own
 * order, behind one gate until the daemon is ready.
 *
 * It holds no link and no key. The backend link, the E2EE sessions, the terminals' P2P channels and the
 * Wi-Fi device's direct links are the gateway's (the core boundary, step 10, R1:
 * docs/design/2026-10-06-core-boundary-next.md): a remote client's request reaches this socket opened,
 * with the role its session proved, and everything this socket has for a remote client leaves through
 * the gateway, which seals it.
 */

import { join } from 'path'
import { hostname } from 'os'
import { env } from './config/env.js'
import { registry, projectDisplayName, type RegisteredSession } from './lib/registry.js'
import type { CloseAgentService } from './lib/closeAgentService.js'
import { ENGINES, type AgentEngine } from './engines/types.js'
import { gridCliPresence } from './lib/gridBinary.js'
import { GRID_FLEET_PROTOCOL, GRID_FLEET_MAX_TIMEOUT_MS } from './lib/gridFleetProtocol.js'
import { ApiConnectionError, ApiConnections } from './lib/apiConnections.js'
import { resolveApiTarget } from './lib/apiModels.js'
import { isApiLaunch, parseGridLaunchOverride, type GridLaunchOverride } from './lib/gridLaunch.js'
import type { ScmLaunchRecord } from './scm/types.js'
import { probeEngines } from './lib/engineProbe.js'
import { engineInstallRecipe } from './lib/engineInstall.js'
import { agentFrame, type AgentDshContext, type AgentFrame } from './lib/agentFrame.js'
import { agentTokenUsage } from './lib/agentTokenUsage.js'
import { terminalHandoffRequest } from './lib/terminalHandoff.js'
import { OwnerCommands, OWNER_COMMAND_TYPES, ROUTE_COMMAND_TYPES } from './lib/ownerCommands.js'
import { VIEWER_DOWN_TYPES } from './lib/viewerFrames.js'
import type { TerminalStreamManager } from './lib/terminalStreamManager.js'
import { encodeTerminalLocal, type TerminalBinaryClear } from './lib/terminalBinary.js'
import { BACKEND_ONLY_DOWN_TYPES, GATEWAY_REQUEST_TYPES, isLocalClientId, logSafeType, PAIR_REQUESTS, PLATE_REQUEST, rpcResultType, type DownTransport } from './lib/relayFrames.js'
import { sid, logFrame } from './lib/log.js'

export { isLocalClientId, type DownTransport }

/** Requests one local connection may queue before the daemon is ready (see `openRequests`). The app
 *  sends a handful on connect; hundreds is a client looping, not a person. */
const MAX_REQUESTS_BEFORE_READY = 256
/** The teams' requests, which the frame log leaves out: they carry what agents ask each other. */
const TEAM_REQUESTS: ReadonlySet<string> = new Set(TEAMS_REQUESTS)
/** Share's requests, which the frame log leaves out as well: they carry who a harness is shared with. */
const SHARE_REQUEST_TYPES: ReadonlySet<string> = new Set(SHARE_REQUESTS)

export type Frame = Record<string, unknown>

export interface LocalClientSink {
  sendFrame: (frame: Frame) => boolean
  sendBinary: (frame: Uint8Array) => boolean
}

export class BackendSocket {
  /** This machine's name as Harness shows it (Machines), from the backend's `machine_meta`. Null
   *  until the first one arrives. */
  private machineDisplayName: string | null = null
  private readonly apiConnections = new ApiConnections(env.ADAPTER_DATA_DIR)
  /** The relay and its E2EE (gateway/gateway.ts): the one way to a remote client. Null in a unit test
   *  that has none, which then serves this computer alone. */
  private gatewayPort: GatewayPort | null = null
  /** The core's stop has begun: nothing more is pushed. */
  private closed = false
  /** Signed out: no frame is handed to the gateway, which would only seal it for a link that never opens. */
  private thisComputerOnly = false
  /** Whether the backend link is up, as the gateway last said. */
  private linkUp = false
  private readonly downChains = new Map<string, Promise<void>>()
  /**
   * Requests wait here until the daemon is ready (`openRequests`), each in its connection's own order.
   * The port answers long before start-up has wired every handler and confirmed the agents it
   * restored; a request answered in between met a handler that was not there yet — refused with
   * UNSUPPORTED_ON_REMOTE, or for `message` silently dropped — or a registry not yet reconciled.
   */
  private requestsOpen = true
  private openRequestGate: () => void = () => {}
  private requestGate: Promise<void> = Promise.resolve()
  /** Requests waiting at the gate, per connection: a client that floods a starting daemon is closed. */
  private readonly waitingAtGate = new Map<string, number>()
  private readonly localClients = new Map<string, LocalClientSink>()
  /** The remote clients the gateway holds a session with, by connection: what the core reads of them
   *  synchronously (the label a terminal is named by), as the gateway last said. */
  private readonly remoteClients = new Map<string, RemoteClient>()
  /** The last window found gone when a reply for it came: its queued replies come in a burst, said once. */
  private goneReplyConn = ''
  /**
   * Loopback clients that are TOOLS, not windows (`machine_select { tool: true }`): `harness pair`, the
   * `harnessd` MCP server. They get their RPC replies like any local client, but they are not a person at
   * this computer — not presence, not a window to push to, and never what wakes the pair brain.
   */
  private readonly toolClients = new Set<string>()
  /** The windows that are `harness tui`, not the desktop app: each surface is its own presence. */
  private readonly tuiClients = new Set<string>()
  private terminalStreams: TerminalStreamManager | null = null
  private onStatus: (connected: boolean) => void
  /** Cross-instance commander (device) client count, as the gateway reads it from the backend. */
  private commanderCount = 0
  /** Subset of commanderCount whose device is ACTIVELY rendering this machine (multi-attach). null = the
   *  backend doesn't send the signal (old build) → fall back to hasCommander so streaming isn't gated off. */
  private commanderActive: number | null = null
  /** Called when a commander attach is observed — cli.ts replays live state. */
  onCommanderJoin: (() => void) | null = null
  /** Called only when commander presence crosses zero; drives the disposable recap-worker grace. */
  onCommanderPresenceChanged: ((connected: boolean) => void) | null = null
  /** Cancels an agent's turn, for the teams and the orchestrator (cli.ts binds core/turns/cancel.ts). */
  onCancel: ((sessionId: string) => void) | null = null
  /** Takes a `cancel` frame, a turn interrupted with C-c (cli.ts binds core/turns/cancel.ts). */
  cancelProvider: ((payload: Record<string, unknown>) => void) | null = null
  /** Answers `agent_delete`, Stop Harness: the validated engine process signalled and the session
   *  forgotten, its recap and name kept (cli.ts binds core/agents/lifecycle.ts). Null answers UNSUPPORTED. */
  stopProvider: ((payload: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null
  /** The purge service: an agent being deleted takes no other lifecycle request meanwhile. */
  purgeAgentService: PurgeAgentService | null = null
  /** Answers `agent_purge` and `agent_worktree_delete` through its last argument, for the owner alone
   *  (cli.ts binds core/agents/lifecycle.ts). Null answers UNSUPPORTED. */
  purgeProvider: ((type: string, payload: Record<string, unknown>, asker: { local: boolean; owner: boolean },
    reply: (result: Record<string, unknown>) => void) => void) | null = null
  closeAgentService: CloseAgentService | null = null
  /** Answers `agent_close` through its last argument, once the agent is saved and closed or the close is
   *  refused (cli.ts binds core/agents/close.ts). Null answers UNSUPPORTED. */
  closeProvider: ((payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void) => void) | null = null
  /** Answers `agents_cleanup_preview` through its argument, once every hidden agent was looked at (cli.ts
   *  binds core/agents/close.ts). Null answers UNSUPPORTED. */
  cleanupPreviewProvider: ((reply: (result: Record<string, unknown>) => void) => void) | null = null
  /** Called on `agent_create` — cli.ts spawns a fresh tmux session running the requested engine in the
   *  requested folder and returns its process-agent. Session metadata may bind later through hooks. */
  onCreateAgent: ((input: {
    engine: AgentEngine
    cwd: string
    bypassPermission: boolean
    /** A grid to point this agent at instead of the engine's own login; null when none was chosen. */
    grid: GridLaunchOverride | null
    /** A Codex CODEX_HOME folder to launch this agent against instead of `~/.codex`; codex only. */
    codexHome: string | null
    /** The domain-specific harness to create this agent as (installed here, base engine = `engine`). */
    dsh: string | null
    /** The message the session opens with, already submitted (`FIRST_PROMPT_ARGS` in engineLaunch.ts);
     *  null when the pane opens on an empty input. Validated here — length, and that the engine has a
     *  contract for it — so cli.ts never sees one it cannot hand over. Never logged. */
    prompt: string | null
    /** The name the pane opens under, instead of the next `agent-N`; null to number it. */
    name: string | null
    /** The engine's named agent the pane opens AS (`NAMED_AGENT_ARGS` in engineLaunch.ts; opencode
     *  `--agent <name>`); null for a general session. Validated here — shape, and that the engine has
     *  a contract for it. Unlike `prompt`, kept on the row so a relaunch opens as it again. */
    agent: string | null
    /** A mode from `PERMISSION_MODES` for this engine; null when the client sent only
     *  `bypassPermission`, which then decides. Validated here (`INVALID_PERMISSION_MODE`). */
    permissionMode: string | null
    /** A conversation Harness did not start, to open this harness ON: the engine resumes it, in its own
     *  folder (lib/sessionSearch/external.ts). Null for a new conversation. Shape-checked here; cli.ts
     *  checks it is one it found, not open elsewhere, and not already a harness. */
    resumeSessionId?: string | null
    /** A conversation open in a terminal, taken over from it: `idle` stops that terminal's process
     *  only between turns, `now` whatever it is doing (then tells it to continue), `wait` when its
     *  turn ends. Absent, one open elsewhere is refused and the refusal says whether it is busy. */
    takeOver?: 'idle' | 'now' | 'wait' | null
    /** What the SCM that prepared `cwd` needs on every relaunch (registry `scmLaunch`). Present only
     *  when this create prepared a folder, and null when no SCM made it (a new folder, a clone). */
    scmLaunchRecord?: ScmLaunchRecord | null
  }) =>
    Promise<{ ok: true; session: RegisteredSession } | { ok: false; error: string; detail?: string }>) | null = null
  /** Called on `remote_terminal_handoff` — cli.ts names the agent whose tile is that tmux pane, or null. */
  onTerminalHandoff: ((tmuxPane: string) => string | null) | null = null
  /** Share's observers, as the relay hands their frames over and drops them all with the link (services/sharing.ts,
   *  through its port). Null answers none, as a daemon without Share did. */
  observers: { receive(connId: string, type: string, payload: Record<string, unknown>): Promise<void> | void; closeAll(): void } | null = null
  /** What the daemon knows about an agent's DSH companions (viewer URL, verdict); null when nothing. */
  activityFrameProvider: ((session: RegisteredSession) => ActivityFrame | null) | null = null
  dshFrameProvider: ((session: RegisteredSession) => AgentDshContext | null) | null = null
  /** This machine's viewers, served to a client over its connection: the viewers' (core/viewerStreams.ts). */
  viewerStreams: ViewerStreams | null = null
  /** A viewer stream's frame to the one connection that opened it: false when it cannot reach it. */
  sendViewerFrame(connId: string, type: string, payload: Record<string, unknown>): boolean {
    if (this.localClients.has(connId)) { this.sendTo(connId, { type, payload }); return true }
    return this.throughGateway('viewer', (gateway) => gateway.target(connId, type, payload), false)
  }
  /** Injectable for queue-isolation tests; production uses the machine-local probe. */
  engineProbeProvider: typeof probeEngines = probeEngines
  readonly ownerCommands = new OwnerCommands()
  /** Takes back a delivered turn not yet being written (core/deliveries.ts, cli.ts binds core/input.ts). */
  onCancelOrchestratorMessage: ((deliveryId: string) => boolean) | null = null
  /** Every frame sent to the apps, as it is sent: the orchestrator reads its Directors' turns from them
   *  (services/orchestrator.ts, through its port). One that throws costs it that frame, never the apps. */
  onFrameSent: ((frame: Frame) => void) | null = null
  /** The account's notices the backend announces (`desk_changed`, …), for the experiments that hear them
   *  (Tab collaboration reads its tab channels again), as well as the windows here. */
  onAccountNotice: ((notice: BackendNotice) => void) | null = null
  /**
   * Called on `agent_retarget` — cli.ts re-execs an EXISTING agent's pane against a different grid,
   * or, when `grid` is null, back onto its own login.
   *
   * Separate from `onCreateAgent` because it is a different promise: the pane, its id and its
   * scrollback survive, and only the process is replaced. A running process's environment cannot be
   * edited, so there is no gentler way to move an agent that is already up.
   *
   * Separate from a restart (core/agents/launches.ts) because that one puts the agent back exactly as it
   * was; this one puts it back somewhere else. They share the swap underneath and differ in what they
   * hand it.
   */
  onRetargetAgent: ((input: { agentId: string; grid: GridLaunchOverride | null }) =>
    Promise<{ ok: true } | { ok: false; error: string; detail?: string }>) | null = null
  /** The requests that start an agent's process, answered through their last argument: `agent_create`,
   *  `agent_create_status`, `agent_resume` and `agent_restart`, and `agent_fork` (cli.ts binds
   *  core/agents/launches.ts). Null answers UNSUPPORTED_ON_REMOTE, or UNSUPPORTED for a status. */
  createProvider: ((payload: Record<string, unknown>, asker: { local: boolean; owner: boolean }, reply: (result: Record<string, unknown>) => void) => Promise<void>) | null = null
  createStatusProvider: ((payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void) => Promise<void>) | null = null
  restartProvider: ((type: string, payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void) => Promise<void>) | null = null
  forkProvider: ((payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void) => Promise<void>) | null = null
  /** Opens a NEW agent that starts with `agentId`'s whole history (lib/forkAgent.ts), exactly as
   *  `agent_create` does, for the fork requests and the cable. `level` says what the new agent actually
   *  got: the engine's own fork, or a handoff message. */
  onForkAgent: ((input: { agentId: string; name: string | null; prompt: string | null }) =>
    Promise<
      { ok: true; session: RegisteredSession; level: 'native' | 'handoff' }
      | { ok: false; error: string; detail?: string }
    >) | null = null
  /** Called when the web/device sends chat input to an agent terminal. */
  onMessage: ((sessionId: string, content: string, deliveryId?: string, tabId?: string) => void) | null = null
  /** Takes a `message` frame: text a person typed for an agent, into its pane (cli.ts binds core/input.ts).
   *  The teams and the orchestrator deliver through `onMessage` above. */
  messageProvider: ((payload: Record<string, unknown>) => void) | null = null
  /** Answers `agent_update` through its last argument, before the windows hear of the change: a rename, a
   *  model and effort, or an app opening the agent (cli.ts binds core/agents/update.ts). */
  agentUpdateProvider: ((payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void) => Promise<void>) | null = null
  /** Answers `question_response` through its last argument: a person's answer to an agent's question,
   *  keyed into the CLI's own dialog, since a remote machine has no programmatic answer channel the way
   *  the hosted runtime’s brain does (cli.ts binds core/questions.ts). Null answers nothing. */
  questionProvider: ((payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void) => void) | null = null
  /** Called when this machine was deleted/revoked (a `machine_revoked` down-frame, or a 401/403 on the
   *  upgrade) — CLI clears the saved SSO session and shuts down instead of retrying forever. */
  onRevoked: (() => void) | null = null
  /** Called with the machine's display name (`machine_meta` down-frame: seeded on connect, pushed on a
   *  web rename; null = unnamed) — cli mirrors it to a local file for `harness status`. */
  onMachineMeta: ((name: string | null) => void) | null = null
  /** Called when this machine is already connected from ANOTHER computer (HTTP 409 on the upgrade) — the
   *  SSO session is valid, so CLI keeps it and stops without a retry loop. */
  onBusy: (() => void) | null = null
  /** Answers `agent_recent` with the whole reply: an agent's last turn summaries and the person's last
   *  questions, for a device's tiles (cli.ts binds core/turns/recaps.ts). Null answers UNSUPPORTED. */
  agentRecentProvider: ((payload: Record<string, unknown>) => Record<string, unknown>) | null = null
  /** Answers `agents_list` through its last argument: every agent's frame, and its monitor readings when
   *  asked for (cli.ts binds core/agents/list.ts). The second argument reads the asker's paired role.
   *  Null answers UNSUPPORTED. */
  agentsProvider: ((payload: Record<string, unknown>, sessionRole: () => string | null,
    reply: (result: Record<string, unknown>) => void) => Promise<void>) | null = null
  /** Answers `session_get` with the whole reply: a conversation's history, a page at a time (cli.ts binds
   *  core/transcripts/history.ts). Null answers UNSUPPORTED. */
  historyProvider: ((payload: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null
  /** Answers `sessions_list` with the whole reply: the conversation an agent holds and how many lines it
   *  has (cli.ts binds core/transcripts/history.ts). Null answers UNSUPPORTED. */
  sessionsProvider: ((payload: Record<string, unknown>) => Promise<Record<string, unknown>>) | null = null
  /** How each agent's last turn ended, from the turn frames this socket sends: the monitor's activity
   *  once a turn is over (`agents_list`, core/agents/list.ts). */
  readonly monitorCompletions = new MonitorCompletions()
  /** The windows on this computer that draw row state (`grid_models_list` with `rowState: true`) and so
   *  are pushed labels as `unavailable` rather than in the node text. Kept here, by connection: the
   *  models service answers the list, and a request reaches it without its connection. */
  private readonly rowStateWindows = new Set<string>()
  /** Answers `terminal_info` through its last argument, once tmux has: what a harness's pane runs and
   *  where (cli.ts binds core/terminals/requests.ts). Null answers UNSUPPORTED. */
  terminalInfoProvider: ((payload: Record<string, unknown>, reply: (result: Record<string, unknown>) => void) => void) | null = null
  /** Answers `theme_set` with the whole reply: the desktop's pane colours, to become this machine's tmux
   *  `window-style` (cli.ts binds core/terminals/requests.ts). Null answers UNSUPPORTED. */
  themeProvider: ((payload: Record<string, unknown>) => Record<string, unknown>) | null = null
  runtimeProfileProvider: ((session: RegisteredSession) => string | null) | null = null
  /** Backend-resolved machine id, persisted by the SSO login preflight. */
  readonly machineId: string

  /** True while at least one device (commander) client is connected — gates the LLM recap. */
  hasCommander(): boolean {
    return this.commanderCount > 0
  }

  /** True while at least one connected device is ACTIVELY rendering this machine — gates the full turn-card
   *  STREAM (processing/tool/todos). The recap still runs on hasCommander(), so a BACKGROUND machine gets its
   *  turn-done `summary` card (badge) without the live stream. Falls back to hasCommander() against a
   *  backend that doesn't emit the signal (commanderActive === null). */
  hasActiveCommander(): boolean {
    return this.commanderActive == null ? this.hasCommander() : this.commanderActive > 0
  }

  /** True while a desktop window on THIS computer is attached over loopback.
   *
   *  Separate from `hasCommander()` on purpose: a device and a window are different audiences that
   *  happen to want some of the same work done. The question watcher is the first thing to need it —
   *  polling a pane for a dialog is pointless with nobody rendering it, but "nobody" used to mean
   *  "no device", which left the window unable to learn that an agent was blocked. */
  hasLocalClient(): boolean {
    return this.localClients.size > this.toolClients.size
  }

  /** True after a paired device has completed the E2EE hello/welcome session (`/api/status`). */
  deviceE2eeConnected(): boolean {
    return [...this.remoteClients.values()].some((client) => client.role === 'device')
  }

  /** Live backend link state (`/api/status`), as the gateway last said. */
  isConnected(): boolean {
    return this.linkUp
  }

  /** A remote client the gateway holds a session with: its role and the label it was paired under. */
  remoteClient(connId: string): RemoteClient | null {
    return this.remoteClients.get(connId) ?? null
  }

  constructor(machineId: string, onStatus: (connected: boolean) => void = () => {}) {
    this.onStatus = onStatus
    this.machineId = machineId
  }

  /** The gateway this socket's remote clients come and go through: in this process, or a link to its own. */
  useGateway(gateway: GatewayPort): void {
    this.gatewayPort = gateway
    if (!this.requestsOpen) gateway.holdRequests()
    if (this.thisComputerOnly) gateway.serveThisComputerOnly()
    gateway.localClients(this.localWindows())
  }

  get gateway(): GatewayPort | null { return this.gatewayPort }

  /**
   * What the gateway tells the core. Each member is the core's half of what the socket did itself while it
   * held the link: a remote client's request goes through the same gate and the same per-connection order as
   * a window's, and what the backend said about this machine lands where the socket used to keep it.
   */
  readonly fromGateway: GatewayEvents = {
    frame: (connId, frame, transport, role) => this.enqueueDown(frame, connId, transport, role),
    binary: (connId, clear) => this.enqueueTerminalBinary(connId, clear),
    client: (connId, client) => {
      this.wifi?.session(connId, client)
      if (client) { this.remoteClients.set(connId, client); return }
      if (!this.remoteClients.delete(connId)) return
      this.viewerStreams?.closed(connId); this.ownerCommands.closeConnection(connId); this.onConnectionClosed?.(connId)
    },
    disconnected: async (connId) => {
      this.wifi?.dropped(connId)
      this.remoteClients.delete(connId)
      this.viewerStreams?.closed(connId); this.ownerCommands.closeConnection(connId); this.onConnectionClosed?.(connId)
      await this.terminalStreams?.closeConnection(
        connId,
        'client connection closed',
        false,
      )
    },
    observer: async (connId, type, payload) => { await this.observers?.receive(connId, type, payload) },
    toLocal: (connId, frame) => {
      if (connId) { this.sendLocalTo(connId, frame); return }
      for (const [id, sink] of this.localClients) if (!sink.sendFrame(frame)) void this.unregisterLocalClient(id)
    },
    status: (connected) => {
      this.linkUp = connected
      this.onStatus(connected)
    },
    linkDown: () => {
      this.observers?.closeAll()
      this.viewerStreams?.closedAll(); this.ownerCommands.closeAll(); for (const connId of this.remoteClients.keys()) this.onConnectionClosed?.(connId)
      void this.terminalStreams?.closeConnectionsWhere(
        (connId) => !isLocalClientId(connId),
        'backend disconnected',
        false,
      )
    },
    commanders: (count, active, recheck = false) => {
      const hadCommander = this.commanderCount > 0
      this.commanderCount = count
      this.commanderActive = active
      if (recheck) this.onCommanderPresenceChanged?.(this.hasCommander())
      else if (hadCommander !== (count > 0)) this.onCommanderPresenceChanged?.(count > 0)
    },
    commanderJoined: () => this.onCommanderJoin?.(),
    meta: (meta) => {
      if ('gridName' in meta) this.harnessGridName = meta.gridName ?? null
      if ('name' in meta) this.machineDisplayName = meta.name ?? null
      this.onMachineMeta?.(meta.name ?? null)
    },
    notice: (notice: BackendNotice) => {
      this.onAccountNotice?.(notice)
      this.sendLocal(notice.type === 'machines_changed' ? { type: notice.type, payload: { reason: notice.reason } }
        : notice.type === 'device_keys_changed' ? { type: notice.type, payload: {} }
          : { type: notice.type, payload: { revision: notice.revision } })
    },
    revoked: () => this.onRevoked?.(),
    busy: () => this.onBusy?.(),
    device: (connId, frame, opened) => this.wifi?.request(connId, frame, opened),
    deviceRevoked: (identity) => this.wifi?.revoked(identity),
    toWindows: (frame) => this.sendLocal(frame),
  }

  /** The Wi-Fi device's sessions and requests, as the gateway hands them on, for its service with the
   *  devices (core/wifi.ts, services/wifi.ts). */
  private wifi?: WifiCore['fromGateway']
  useWifi(wifi: WifiCore['fromGateway']): void { this.wifi = wifi }
  /** The Wi-Fi device's answers and events, sealed to one session; and which identity's app said hello on
   *  one. Through the gateway, guarded as every frame of the core's is. */
  deviceFrame(connId: string, type: string, payload: Record<string, unknown>): void {
    this.throughGateway('device', (gateway) => gateway.device(connId, type, payload), false)
  }
  deviceClient(connId: string, identity: string | null): void { this.toGateway('device', (gateway) => gateway.deviceClient(connId, identity)) }

  setTerminalStreamManager(manager: TerminalStreamManager): void {
    this.terminalStreams = manager
  }

  /** The account's private harness grid name, as the backend last reported it. Null until the first
   *  `machine_meta` lands, or when this account has none yet. */
  private harnessGridName: string | null = null

  /**
   * What the socket asks of models (core/api.ts `ModelsPort`): an agent's grid note for its frame, the
   * lists it pushes the windows, and where a move onto a grid model goes. Read on each use, since models
   * can be switched off or run in a process of its own; set by core/main.ts. Unset (tests), it reads as
   * models being off.
   */
  models: (() => Pick<ModelsPort, 'annotation' | 'lists' | 'moveTarget' | 'moved'>) | null = null

  /** Set the account's private grid name from the reconcile that just confirmed it, so the RPCs
   *  answer with it at once rather than waiting for the next `machine_meta` (`lib/gridAttach.ts`). */
  setHarnessGridName(name: string | null): void { this.harnessGridName = name }

  /** Which grid this machine's agents can be pointed at — for `harness status`, the models service, and a
   *  relaunch that names it. The backend's word only: working one out is the models service's. */
  gridName(): string | null { return this.harnessGridName }

  /** This machine's name as the Machines list shows it — what a model it serves is labelled with. */
  machineName(): string | null { return this.machineDisplayName }

  /** `grid_models_changed` to the windows on this computer: the same payload `grid_models_list` answers,
   *  as the models service builds it from its pictures as they stand, each window in the form it asked
   *  for. On the models service's word: a read it did not wait for changed the list, a local model started
   *  or stopped, grid was set up. */
  async pushGridModels(): Promise<void> {
    if (this.closed || this.localClients.size === 0 || !this.models) return
    try {
      const { plain, rowState } = await this.models().lists()
      const forPlain: Frame = { type: 'grid_models_changed', payload: plain }
      const forRowState: Frame = { type: 'grid_models_changed', payload: rowState }
      this.sendLocal((connId) => this.rowStateWindows.has(connId) ? forRowState : forPlain)
    } catch { /* the next ask answers the same thing */ }
  }

  /** Dial the backend, through the gateway: this daemon is signed in. */
  connect(): void {
    this.gatewayPort?.connect()
  }

  async stop(): Promise<void> {
    this.closed = true
    this.closeAgentService?.dispose()
    this.viewerStreams?.closedAll(); this.ownerCommands.closeAll()
    await this.terminalStreams?.stop()
    await this.gatewayPort?.stop()
  }

  /** What the gateway does with a frame of the core's, guarded: a throw there (sealing one, say) costs
   *  the remote clients that frame, and never the windows on this computer or the caller. Before the
   *  gateway was its own part, a throw in the group key's wrap went up through `send()` into the event
   *  funnel and cost every consumer after the app's that turn's events (docs/design/2026-10-06-core-boundary-next.md,
   *  "If it dies"). Said at most once a minute, with how many were not. */
  private toGateway(what: string, call: (gateway: GatewayPort) => void): void {
    this.throughGateway(what, (gateway) => { call(gateway); return true }, false)
  }
  /** The same, for a send whose caller learns whether it went: a throw is a send that did not (a terminal
   *  stream then closes, as it does for a connection with no session). */
  private throughGateway(what: string, call: (gateway: GatewayPort) => boolean, otherwise: boolean): boolean {
    const gateway = this.gatewayPort
    if (!gateway) return otherwise
    try {
      return call(gateway)
    } catch (error) {
      const at = Date.now()
      if (at - this.gatewayFailureSaidAt < 60_000) { this.gatewayFailuresUnsaid++; return otherwise }
      console.error(`[backend] the gateway could not take a ${what} frame · ${error instanceof Error ? error.message : String(error)}${this.gatewayFailuresUnsaid ? ` · ${this.gatewayFailuresUnsaid} more since` : ''}`)
      this.gatewayFailureSaidAt = at
      this.gatewayFailuresUnsaid = 0
      return otherwise
    }
  }
  private gatewayFailureSaidAt = -Infinity
  private gatewayFailuresUnsaid = 0

  /** Send an up-frame (event or RPC reply) to every window here and to the WEB audience: the gateway seals
   *  what carries content and queues it while the link is down. */
  send(frame: Frame): void {
    this.monitorCompletions.observe(frame)
    // The orchestrator's state it cannot read (a full disk: reading makes its folder) must not cost every
    // frame after it (e2e/diskfull.e2e.ts).
    try { this.onFrameSent?.(frame) } catch { /* the frame goes out regardless */ }
    if (env.LOG_FRAMES) logFrame('→', 'web', frame)
    for (const [connId, sink] of this.localClients) {
      if (!sink.sendFrame(frame)) void this.unregisterLocalClient(connId)
    }
    if (!this.thisComputerOnly) this.toGateway('web', (gateway) => gateway.broadcast(frame))
  }

  /** Signed out: the cloud link is never dialed in this process's life (a sign-in restarts it), so nothing
   *  is handed to the gateway to seal or queue for it: every frame, a text_delta's among them, was sealed
   *  and queued for a link that never opens, two thousand deep. */
  serveThisComputerOnly(): void { this.thisComputerOnly = true; this.gatewayPort?.serveThisComputerOnly() }

  /** Send an up-frame to the LOOPBACK clients only — never to the cloud.
   *
   *  For things that describe what is happening at THIS desk rather than what the machine is doing: the
   *  dial is a physical object on one table, and a finger moving on its glass is meaningful to the window
   *  in front of it and to nothing else. `send()` fans out to the web audience as well, which would scroll
   *  a window on a computer the user is not sitting at. */
  /** One frame to every window on this computer — or, given a function, each window its own. */
  sendLocal(frame: Frame | ((connId: string) => Frame)): void {
    for (const [connId, sink] of this.localClients) {
      if (this.toolClients.has(connId)) continue
      const sent = typeof frame === 'function' ? frame(connId) : frame
      if (env.LOG_FRAMES) logFrame('→', 'local', sent)
      if (!sink.sendFrame(sent)) void this.unregisterLocalClient(connId)
    }
  }

  /** One frame to ONE window on this computer, if it is one. Never queued, never to the cloud. */
  sendLocalTo(connId: string, frame: Frame): boolean {
    const sink = this.localClients.get(connId)
    if (!sink) return false
    if (env.LOG_FRAMES) logFrame('→', 'local', frame)
    if (sink.sendFrame(frame)) return true
    void this.unregisterLocalClient(connId)
    return false
  }

  /** Ask one local desktop to select focus, without opening panes in every window. */
  sendFirstLocal(frame: Frame): boolean {
    for (const [connId, sink] of this.localClients) {
      if (this.toolClients.has(connId)) continue
      if (sink.sendFrame(frame)) return true
      void this.unregisterLocalClient(connId)
    }
    return false
  }

  /** Share's frame to one observer: plaintext to the relay, through the gateway. Share seals its own. */
  sendObserver(connId: string, type: string, payload: Record<string, unknown>): boolean {
    return this.throughGateway('observer', (gateway) => gateway.observer(connId, type, payload), false)
  }

  /** A frame to a window on this computer. A remote client's frames go through the gateway, which seals them. */
  sendTo(connId: string, frame: Frame): void {
    const local = this.localClients.get(connId)
    if (!local) return
    if (!local.sendFrame(frame)) void this.unregisterLocalClient(connId)
  }

  /** Pairwise terminal output is never queued across reconnect: the stream/lease is closed on link loss. */
  sendTerminalTo(connId: string, type: string, payload: Record<string, unknown>): boolean {
    const local = this.localClients.get(connId)
    if (local) return local.sendFrame({ type, payload })
    return this.throughGateway('terminal', (gateway) => gateway.terminal(connId, type, payload), false)
  }

  /** Binary terminal output/keyframe: in the clear to a window here, sealed by the gateway for anyone else. */
  sendTerminalBinaryTo(connId: string, clear: TerminalBinaryClear): boolean {
    const local = this.localClients.get(connId)
    if (local) {
      const frame = encodeTerminalLocal(clear)
      return frame ? local.sendBinary(frame) : false
    }
    return this.throughGateway('terminal', (gateway) => gateway.terminalBinary(connId, clear), false)
  }

  /** Send a user-level notification to every logged-in browser that owns this machine. */
  sendUser(frame: Frame): void {
    this.toGateway('user', (gateway) => gateway.user(frame))
  }

  /**
   * A tap on everything bound for a device, taken BEFORE E2EE wrapping.
   *
   * The dial on the USB cable is a second device audience, and it wants exactly what this one gets — the
   * same `commander_event` cards, in the same order, with the same recaps. Teeing here rather than adding
   * a parallel emit at each of the two dozen call sites is what keeps the two surfaces from drifting: a
   * new event kind reaches the cable the day it reaches the socket, without anyone remembering to add it.
   *
   * Plaintext on purpose: E2EE exists because the backend relays those frames. The cable relays nothing —
   * it is a wire the user physically owns, running to a process on their own computer.
   */
  onOutboundCommander?: (frame: Frame) => void

  /** Send a DEVICE-audience frame (commanderEligible, not web): the gateway seals user/data frames under
   *  the group key, so the backend relays only ciphertext; system/presence frames pass through. */
  sendCommander(frame: Frame): void {
    this.onOutboundCommander?.(frame)
    if (env.LOG_FRAMES) logFrame('→', 'device', frame)
    this.toGateway('device', (gateway) => gateway.commander(frame))
  }

  /** Attach one authenticated loopback desktop client to the same RPC and event plane as cloud web. */
  registerLocalClient(connId: string, sink: LocalClientSink, opts: { tool?: boolean; surface?: WindowSurface } = {}): boolean {
    if (!isLocalClientId(connId) || this.localClients.has(connId)) return false
    this.localClients.set(connId, sink)
    if (opts.tool) this.toolClients.add(connId)
    else if (opts.surface === 'tui') this.tuiClients.add(connId)
    this.gatewayPort?.localClients(this.localWindows())
    if (opts.tool) return true
    // The window is the person's session: the backend counts it, now or when the link next comes up.
    this.gatewayPort?.windowOpened(opts.surface ?? 'desktop')
    this.onLocalClient?.(connId, true)
    return true
  }

  /** The windows attached now, per surface; tools are not windows. */
  private localWindows(): LocalWindows { return countWindows(this.localClients.size, this.toolClients.size, this.tuiClients.size) }

  /** A loopback client that said it is a tool (`harness pair`, the MCP server), not a window. */
  isToolClient(connId: string): boolean { return this.toolClients.has(connId) }

  /** The windows attached right now — for a listener that arrives after some of them did. */
  localClientIds(): string[] { return [...this.localClients.keys()].filter((connId) => !this.toolClients.has(connId)) }

  /** Routes a request to the service that answers it, in its own process (core/serviceLinks.ts) or in
   *  this one (core/serviceHost.ts): false when none does and the socket answers it itself. */
  serviceRouter: ((type: string, payload: Record<string, unknown>, asker: Asker, reply: (result: Record<string, unknown>) => void) => boolean) | null = null
  /** A connection that asked the services something closed: they abort what it asked (`Asker.connection`). */
  onConnectionClosed: ((connId: string) => void) | null = null
  /** A window (or `hn`) on this computer attached or went away — the pair brain thinks only while one is here. */
  onLocalClient: ((connId: string, attached: boolean) => void) | null = null

  /** Release all connection-scoped state when the loopback WebSocket closes. */
  async unregisterLocalClient(connId: string): Promise<void> {
    if (!this.localClients.delete(connId)) return
    if (!this.toolClients.delete(connId)) this.onLocalClient?.(connId, false)
    this.tuiClients.delete(connId)
    this.rowStateWindows.delete(connId)
    this.viewerStreams?.closed(connId); this.ownerCommands.closeConnection(connId); this.onConnectionClosed?.(connId)
    // The last one leaving before any link could hear it attach: nothing happened, as far as the backend
    // is concerned, and the gateway does not tell a later link otherwise.
    this.gatewayPort?.localClients(this.localWindows())
    this.downChains.delete(connId)
    await this.terminalStreams?.closeConnection(connId, 'local client disconnected', false)
  }

  /** Route an authenticated local JSON frame through the existing per-client FIFO.
   *
   *  ⚠️ Tagged `'local'`, not left to default to `'relay'`. These frames come from a process on THIS
   *  machine over the local socket, and until they were tagged they arrived at `dispatchDown`
   *  indistinguishable from the backend's own — which let any local process send a frame only the
   *  backend is entitled to send. See the `machine_meta` branch there. */
  handleLocalFrame(connId: string, frame: Frame): void {
    if (!this.localClients.has(connId)) return
    this.enqueueDown(frame, connId, 'local')
  }

  /** The window's focused agent on this local connection — its terminal gets the short output window. */
  setLocalTerminalFocus(connId: string, agentId: string | null): void {
    if (!this.localClients.has(connId)) return
    this.terminalStreams?.setFocusedAgent(connId, agentId)
  }

  /** Route an authenticated local terminal frame without applying cloud E2EE. */
  async handleLocalBinary(connId: string, frame: TerminalBinaryClear): Promise<void> {
    if (!this.localClients.has(connId)) return
    await this.terminalStreams?.handleBinary(connId, frame)
  }

  /** Hold requests at the gate until `openRequests`. The daemon calls this the moment it builds this
   *  socket, before anything can reach it; a socket built without it answers at once. */
  holdRequests(): void {
    if (!this.requestsOpen) return
    this.requestsOpen = false
    this.requestGate = new Promise<void>((resolve) => { this.openRequestGate = resolve })
    this.gatewayPort?.holdRequests()
  }

  /** Let requests through: every handler is wired and the agents the daemon restored are confirmed.
   *  Idempotent. Called once at the end of start-up — and by safe mode, so a daemon that could not
   *  start still answers rather than leaving its clients waiting. */
  openRequests(): void {
    if (this.requestsOpen) return
    this.requestsOpen = true
    this.waitingAtGate.clear()
    this.openRequestGate()
    this.gatewayPort?.openRequests()
  }

  /** A frame into its connection's order, behind the gate: a window's, or a remote client's the gateway
   *  opened, with the role its session proved. Resolves once it is handled. */
  private enqueueDown(frame: Frame, connId: string, transport: DownTransport, role: RemoteRole | null = null): Promise<void> {
    const key = connId || '__backend__'
    if (!this.requestsOpen) {
      const waiting = (this.waitingAtGate.get(key) ?? 0) + 1
      this.waitingAtGate.set(key, waiting)
      if (waiting > MAX_REQUESTS_BEFORE_READY && transport === 'local') {
        console.warn(`[backend] local client ${key} sent ${waiting} requests before the daemon was ready — closing it`)
        this.waitingAtGate.delete(key)
        void this.unregisterLocalClient(connId)
        return Promise.resolve()
      }
    }
    const previous = this.downChains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => { /* prior failure is already logged */ })
      .then(() => this.requestGate)
      .then(() => this.dispatchDown(frame, connId, transport, role))
      .catch((err) => {
        console.error('[backend] down-frame dispatch failed:', err instanceof Error ? err.message : err)
      })
      .finally(() => {
        if (this.downChains.get(key) === next) this.downChains.delete(key)
      })
    this.downChains.set(key, next)
    return next
  }

  /** A remote client's terminal bytes, opened by the gateway, in its connection's order (not gated: a
   *  stream exists only once a request through the gate opened it). */
  private enqueueTerminalBinary(connId: string, clear: TerminalBinaryClear): Promise<void> {
    const key = connId || '__backend__'
    const previous = this.downChains.get(key) ?? Promise.resolve()
    const next = previous
      .catch(() => { /* prior failure is already logged */ })
      .then(async () => { await this.terminalStreams?.handleBinary(connId, clear) })
      .catch((err) => {
        console.error('[backend] binary terminal dispatch failed:', err instanceof Error ? err.message : err)
      })
      .finally(() => {
        if (this.downChains.get(key) === next) this.downChains.delete(key)
      })
    this.downChains.set(key, next)
    return next
  }

  // ── down-frame dispatch (the hosted runtime-role RPC switch) ────────────────────────────────────────────

  /** Emit an RPC reply: in the clear to a window on this computer that asked; through the gateway to a
   *  remote client, which seals it to that client alone, or answers a bare E2EE_REQUIRED when it cannot
   *  (`GatewayPort.reply`). */
  private emitReply(connId: string, type: string, requestId: unknown, payload: Record<string, unknown>): void {
    const resultType = rpcResultType(type)
    // Before the E2EE wrap: an RPC reply is only readable here.
    if (env.LOG_FRAMES && !TEAM_REQUESTS.has(type) && !OWNER_COMMAND_TYPES.has(type) && !type.startsWith('viewer_') && type !== 'phone_pair' && type !== 'api_connections' && type !== 'orchestrator' && !type.startsWith('grid_fleet_') && type !== 'agent_read_file' && type !== 'project_preview' && type !== 'git_project_info' && type !== 'scm_project_info' && type !== 'git_pull_request' && type !== 'agent_handoff_prepare' && !SHARE_REQUEST_TYPES.has(type) && !type.startsWith('pair')) logFrame('→', connId ? `conn:${sid(connId)}` : 'backend', { type: resultType, payload: { requestId, ...payload } })
    if (this.localClients.has(connId)) {
      this.sendTo(connId, { type: resultType, payload: { requestId, ...payload } })
      return
    }
    // A window on this computer that has gone: its reply goes nowhere. What a window asked before it
    // closed is still carried out, and the replies used to fall through to the paths below: a plaintext
    // one such as `terminal_info_result` went out through `send()` to every other window and, unsealed,
    // into the relay's queue; the rest were queued for the relay as errors (e2e/windows.e2e.ts). Said
    // once per window, in the daemon's diagnostic mode only (it has no debug level of its own): a window
    // closing with requests in flight is ordinary.
    if (isLocalClientId(connId)) {
      if (env.LOG_FRAMES && this.goneReplyConn !== connId) console.log(`[backend] conn:${sid(connId)} has gone · its ${resultType} and later replies dropped`)
      this.goneReplyConn = connId
      return
    }
    this.toGateway('reply', (gateway) => gateway.reply(connId, type, requestId, payload))
  }

  /**
   * One frame, in its connection's order and past the gate: a window's or tool's on this computer
   * (`local`), or a remote client's, which the gateway admitted and opened (`relay`, `p2p`) with the role
   * of the session that sealed it. The relay's own rules (the backend's frames, default-deny, the E2EE
   * handshake) were the gateway's to apply before the frame got here (gateway/gateway.ts).
   */
  private async dispatchDown(frame: Frame, connId: string, transport: DownTransport = 'local', role: RemoteRole | null = null): Promise<void> {
    const type = frame.type as string | undefined
    if (!type) return
    // Whether this frame came from a process on THIS machine — the trust boundary the gates below
    // turn on. The membership half is a dispatch-time question about a connection that may already
    // be gone: frames run through a per-connId queue, so a local client that disconnects between
    // sending and being dispatched used to leave `localClients.has()` false, and its already-queued
    // frames were then read as the BACKEND's. The transport half closes that, because it is stamped
    // at enqueue by the caller that had just verified membership. Either one being true is local.
    const local = transport === 'local' || this.localClients.has(connId)
    if (local) {
      // ⚠️ The backend's own instructions, refused from anywhere else. See BACKEND_ONLY_DOWN_TYPES.
      if (BACKEND_ONLY_DOWN_TYPES.has(type)) {
        console.warn(`[backend] ignoring ${type} from ${transport} (${connId}) — only the backend may send it`)
        return
      }
      // The backend hub's own control frames (`__clients`, `__client_disconnected`) are the gateway's to
      // hear, from the backend: a process on this computer was able to set how many devices watch it.
      if (type.startsWith('__')) {
        console.warn(`[backend] ignoring ${logSafeType(type)} from ${transport} (${connId}) — only the backend sends it`)
        return
      }
      // E2EE belongs to the relay: a window here speaks in the clear, and has no handshake to make.
      if (type.startsWith('e2e_')) {
        this.sendTo(connId, { type: 'local_protocol_error', payload: { error: 'LOCAL_E2EE_UNSUPPORTED' } })
        return
      }
      if (type === 'autonomous_device_request') return
    }
    if (type.startsWith('observer_')) return
    // Logged as opened (the gateway unwrapped a remote client's), so a down-frame reads as what the client
    // actually asked for rather than as an opaque __e2e envelope.
    // Terminal frames contain raw keystrokes, paste text and screen bytes after
    // unwrap. Never pass them to the frame logger, even in diagnostic mode.
    if (env.LOG_FRAMES && !TEAM_REQUESTS.has(type) && !OWNER_COMMAND_TYPES.has(type) && !type.startsWith('terminal_') && !type.startsWith('viewer_') && !type.startsWith('grid_fleet_') && type !== 'agent_read_file' && type !== 'project_preview' && type !== 'git_project_info' && type !== 'scm_project_info' && type !== 'git_pull_request' && type !== 'agent_handoff_prepare' && type !== 'orchestrator' && type !== 'api_connections' && type !== 'phone_pair' && !SHARE_REQUEST_TYPES.has(type) && !type.startsWith('pair')) {
      logFrame('←', connId ? `conn:${sid(connId)}` : 'backend', frame)
    }
    const reply = (t: string, rid: unknown, p: Record<string, unknown>): void => this.emitReply(connId, t, rid, p)
    // Who may act as this machine's owner: a process here, or the owner's own paired app or browser, whose
    // session the gateway says is a `web` one. A device or an observer may not.
    const owner = local || role === 'web'
    const lifecycleTarget = (frame.payload as { agentId?: unknown } | undefined)?.agentId
    if (typeof lifecycleTarget === 'string' && this.purgeAgentService?.busy(lifecycleTarget)
      && ['agent_close', 'agent_delete', 'agent_resume', 'agent_restart', 'agent_retarget', 'agent_update'].includes(type)) {
      reply(type, (frame.payload as { requestId?: unknown }).requestId, { error: 'DELETE_IN_PROGRESS' }); return
    }
    const payload = (frame.payload ?? {}) as Record<string, unknown>
    const requestId = payload.requestId
    const answer = (result: Record<string, unknown>): void => reply(type, requestId, result)

    // A paired owner can run the machine's orchestrator; observers and device sessions cannot.
    // Both requests and replies are encrypted, including project artifacts.
    if (ROUTE_COMMAND_TYPES.has(type)) {
      if (!owner) { reply(type, requestId, { error: 'OWNER_REQUIRED' }); return }
      void this.ownerCommands.request(connId, type, payload).then(result => reply(type, requestId, result))
      return
    }

    // Retired optional-feature requests remain reserved. Never reinterpret one as an
    // ordinary command or weaken its existing encryption / local transport boundary.
    if (PAIR_REQUESTS.has(type) || type === 'pair' || type === PLATE_REQUEST) {
      const error = type === 'pair' && !local ? 'LOCAL_ONLY'
        : type !== 'pair' && local ? 'REMOTE_ONLY' : 'UNSUPPORTED'
      reply(type, requestId, { error })
      return
    }

    if (type === 'viewer_surface') {
      if (!owner) return
      // Rendering and input never hold up terminal traffic on the ordered machine queue.
      void (this.viewerStreams?.surface(connId, payload) ?? Promise.reject(new Error('no viewers')))
        .then(result => reply(type, requestId, result))
        .catch(() => reply(type, requestId, { error: 'VIEWER_UNAVAILABLE' }))
      return
    }

    // Trust-group roster exchange: only over an E2EE session, from the identity that session proved, which
    // the gateway answers (gateway/gateway.ts). A window here has no identity to prove.
    if (type === 'group_sync') {
      reply(type, requestId, { error: 'UNSUPPORTED' })
      return
    }

    if (type.startsWith('viewer_')) {
      if (VIEWER_DOWN_TYPES.has(type) && owner) this.viewerStreams?.frame(connId, type, payload)
      return
    }

    // Which of a remote client's terminal streams ride its P2P channel is the gateway's, which noted this
    // frame's route as it opened it.
    if (type.startsWith('terminal_')) {
      const taken = this.terminalStreams ? await this.terminalStreams.handleFrame(connId, type, payload) : false
      // `terminal_info` (what a pane runs and where, which hn asks) is not a stream's: the streams pass
      // it over, and it is answered below. From hn's first release it stopped here unanswered
      // (e2e/compat.e2e.ts found it), and hn waited out its three seconds each time.
      if (taken || type !== 'terminal_info') return
    }

    // A request a service answers, in its own process or in this one: routed to it, or answered
    // SERVICE_UNAVAILABLE while it is off. Never waited on in line: the next frame is not held for it.
    // Who asked is established here, after the gates above, and the service trusts only that.
    const asker: Asker = { local, owner, connection: connId, ...(typeof requestId === 'string' ? { requestId } : {}) }
    // A window that draws row state asks for the models list with `rowState`, and the list's changes are
    // pushed to it in that form (`pushGridModels`). Noted here, by connection: the models service answers
    // the list, and a request reaches it without its connection.
    if (type === 'grid_models_list' && payload.rowState === true && this.localClients.has(connId)) this.rowStateWindows.add(connId)
    if (this.serviceRouter?.(type, payload, asker, (result) => reply(type, requestId, result))) return

    try {
      switch (type) {
        // The Model Manager's grid commands' handshake (their protocol, longest timeout and thinking control),
        // answered here although the commands are the models service's (core/api.ts `MODELS_REQUESTS`): the
        // Grid harness sends `grid_fleet_run` only once it answers protocol 1 and reads anything else as
        // "update Harness", which a models service that is down must not make it say.
        case 'grid_fleet_capabilities':
          reply(type, requestId, { protocol: GRID_FLEET_PROTOCOL, gridCli: gridCliPresence(), maxTimeoutMs: GRID_FLEET_MAX_TIMEOUT_MS, thinkingControl: true })
          return
        // The pairings, which the gateway holds: a window here asks it through the core
        // (GATEWAY_REQUEST_TYPES), and a remote client's own requests never reach this switch.
        case 'device_e2ee_pair':
        case 'phone_pair':
        case 'e2ee_pairings_list':
        case 'e2ee_pairing_unpair':
        case 'e2ee_pairings_unpair_all':
          if (this.gatewayPort && GATEWAY_REQUEST_TYPES.has(type)) await this.gatewayPort.local(connId, frame)
          else if (requestId !== undefined) reply(type, requestId, { error: 'UNSUPPORTED' })
          return

        // The agents on this machine, live and, when asked, stopped (core/agents/list.ts, bound by cli.ts).
        case 'agents_list':
          if (this.agentsProvider) await this.agentsProvider(payload, () => (local ? null : role), answer)
          else reply(type, requestId, { error: 'UNSUPPORTED' })
          return

        // The conversation an agent holds, and how long it is (core/transcripts/history.ts, bound by cli.ts).
        case 'sessions_list':
          reply(type, requestId, this.sessionsProvider ? await this.sessionsProvider(payload) : { error: 'UNSUPPORTED' })
          return

        // A conversation's history, a page at a time (core/transcripts/history.ts, bound by cli.ts).
        case 'session_get':
          reply(type, requestId, this.historyProvider ? await this.historyProvider(payload) : { error: 'UNSUPPORTED' })
          return

        case 'remote_terminal_handoff': {
          // `harness remote`, typed INSIDE one of this machine's terminal tiles, opened a terminal on
          // another machine and asks the window showing the tile to swap it over: the tile it was
          // typed in (named by its tmux pane, the one fact the shell has about itself) becomes the new
          // agent's, and the old shell is ended by the window. Asked over loopback only (the command
          // runs on this machine), but PUSHED to every audience: the window showing a tile of this
          // machine may be on another computer, reached through the relay — nothing in the payload
          // but ids, so it travels plain like dsh_install_status.
          if (!this.localClients.has(connId)) { reply(type, requestId, { error: 'UNSUPPORTED' }); return }
          const handoff = terminalHandoffRequest(payload)
          if (!handoff) { reply(type, requestId, { error: 'INVALID_HANDOFF', detail: 'remote_terminal_handoff needs tmuxPane (%N), machineId and agentId' }); return }
          const fromAgentId = this.onTerminalHandoff?.(handoff.tmuxPane) ?? null
          if (!fromAgentId) { reply(type, requestId, { error: 'NOT_A_HARNESS_PANE', detail: `${handoff.tmuxPane} is not a Harness terminal on this machine` }); return }
          // Who could hear it: other loopback clients (a window on this computer) and the web audience
          // (a window elsewhere, relayed). None means nobody is here to swap the tile.
          const windows = [...this.localClients.keys()].filter((id) => id !== connId).length + this.commanderCount
          this.send({ type: 'remote_terminal_handoff', payload: { fromAgentId, machineId: handoff.machineId, agentId: handoff.agentId } })
          reply(type, requestId, { ok: true, fromAgentId, windows })
          return
        }

        case 'engines_probe': {
          // Which engines this machine has, asked BEFORE a create rather than discovered by one
          // failing. Answered here — on the machine in question — because a Mac and the Docker rig
          // routinely hold different engines, and an availability list computed anywhere else is
          // wrong for exactly the remote case this request exists to serve.
          //
          // `engines` narrows the probe to what the caller is showing; an absent or malformed list
          // means "all of them", so an older app that sends nothing still gets a usable answer.
          const asked = Array.isArray(payload.engines)
            ? payload.engines.filter((id): id is AgentEngine =>
              typeof id === 'string' && (ENGINES as readonly string[]).includes(id))
            : undefined
          // A full probe starts interactive login shells and is intentionally detached from this
          // connection's ordered RPC chain. Request ids make its eventual reply safe to deliver out
          // of order; keeping it awaited here made a Create click sit behind an unrelated sweep.
          void this.engineProbeProvider(asked && asked.length > 0 ? asked : undefined)
            .then((availability) => reply(type, requestId, {
              engines: availability.map((entry) => ({
                engine: entry.engine,
                installed: entry.installed,
                command: entry.command,
                installable: entry.installable,
                installCommand: entry.installable ? engineInstallRecipe(entry.engine)?.command ?? null : null,
                // Static per-CLI-version capability, not a probe result: its mere presence is what
                // lets an older CLI (which never sends the field) keep reading as "unknown" rather
                // than "no", per the desktop app's `EngineAvailability.fromJson`.
                ...(entry.engine === 'codex' ? { supportsCodexHome: true } : {}),
              })),
            }))
            .catch(() => reply(type, requestId, { error: 'ENGINE_PROBE_FAILED' }))
          return
        }

        // An agent's last turn summaries and questions, for a device's tiles (core/turns/recaps.ts, bound by cli.ts).
        case 'agent_recent':
          reply(type, requestId, this.agentRecentProvider ? this.agentRecentProvider(payload) : { error: 'UNSUPPORTED' })
          return

        // A rename, a model and effort, or an app opening the agent (core/agents/update.ts, bound by cli.ts).
        case 'agent_update':
          if (this.agentUpdateProvider) await this.agentUpdateProvider(payload, answer)
          else answer({ error: 'UNSUPPORTED' })
          return

        // What became of a launch a creationId names (core/agents/launches.ts, bound by cli.ts).
        case 'agent_create_status':
          if (this.createStatusProvider) await this.createStatusProvider(payload, answer)
          else answer({ error: 'UNSUPPORTED' })
          return

        // A new agent (core/agents/launches.ts, bound by cli.ts).
        case 'agent_create':
          if (this.createProvider) await this.createProvider(payload, asker, answer)
          else answer({ error: 'UNSUPPORTED_ON_REMOTE' })
          return

        // Move a RUNNING agent onto a grid. The pane survives; its process is re-exec'd with the
        // engine's grid environment and, when one is bound, `--resume <session>` so the conversation
        // comes back. Refused rather than half-applied: see cli.ts for what it checks first.
        case 'agent_retarget': {
          const agentId = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
          if (!agentId) { reply(type, requestId, { error: 'MISSING_AGENT_ID' }); return }
          if (!this.onRetargetAgent) { reply(type, requestId, { error: 'UNSUPPORTED_ON_REMOTE' }); return }
          const clear = payload.clearGrid === true
          // `gridModel` is the header picker's frame: a model id and nothing else. The endpoint and
          // the credential are resolved HERE, from this machine's own signed-in `grid`, so neither
          // ever crosses the relay and the app cannot be the source of truth for an address it does
          // not know. A client that sends the full `grid` object still works unchanged.
          const picked = typeof payload.gridModel === 'string' ? payload.gridModel : ''
          // `apiConnection` + `apiModel`: a model of an API saved on this machine. Same rule as a grid
          // model — the app names it, and the endpoint and key are read here, from the store — and
          // only for whoever may manage those APIs (`api_connections`): this machine's own app, or
          // its owner's paired session. The key itself never leaves this daemon either way.
          const api = typeof payload.apiConnection === 'string' ? payload.apiConnection : ''
          if (api && (picked || payload.grid !== undefined || clear)) {
            reply(type, requestId, { error: 'INVALID_GRID', detail: 'Choose an API model, a grid model or the own login, not several.' })
            return
          }
          if (api) {
            if (!owner) { reply(type, requestId, { error: 'OWNER_REQUIRED' }); return }
            try {
              payload.grid = await resolveApiTarget(this.apiConnections, api, typeof payload.apiModel === 'string' ? payload.apiModel.trim() : '')
            } catch (error) {
              reply(type, requestId, {
                error: 'API_UNAVAILABLE',
                detail: error instanceof ApiConnectionError ? error.message : 'This API could not be used. Try again.',
              })
              return
            }
          }
          if (picked && payload.grid === undefined && !clear) {
            // The grid the model was picked FROM, when the picker says (a shared grid's section); the
            // account's own grid otherwise. The models service sets grid up first and resolves the target.
            const named = typeof payload.gridName === 'string' && payload.gridName.trim() ? payload.gridName.trim() : null
            const moving = this.models ? await this.models().moveTarget({ gridName: named, model: picked }).catch(() => null) : null
            if (!moving || !('target' in moving)) {
              reply(type, requestId, { error: 'GRID_UNAVAILABLE', detail: moving?.detail ?? 'Models are unavailable. Try again.' })
              return
            }
            payload.grid = moving.target
          }
          const target = parseGridLaunchOverride(payload.grid)
          // Exactly one, and `clearGrid` is a separate field rather than `grid: null` on purpose:
          // parseGridLaunchOverride already answers `absent` for both undefined and null, so
          // overloading null would make "I forgot the field" and "I mean own login" the same frame.
          if (clear && target.state !== 'absent') {
            reply(type, requestId, { error: 'INVALID_GRID', detail: 'clearGrid and grid are mutually exclusive' })
            return
          }
          if (!clear && target.state !== 'ok') {
            reply(type, requestId, {
              error: 'INVALID_GRID',
              detail: target.state === 'invalid' ? target.reason : 'grid is required',
            })
            return
          }
          const override = target.state === 'ok' ? target.override : null
          const moved = await this.onRetargetAgent({ agentId, grid: override })
          if (!moved.ok) {
            reply(type, requestId, moved.detail ? { error: moved.error, detail: moved.detail } : { error: moved.error })
            return
          }
          reply(type, requestId, { retargeted: true })
          // The agent is on a grid model now and its pane is restarting: the models service starts that grid
          // meanwhile if it sleeps (issue 03). The move is done and answered. An API has no sleep to wake it
          // from, and is not a grid to look up.
          if (override && !isApiLaunch(override)) this.models?.().moved(override)
          return
        }

        // The agents no window shows, for a person to review before closing them (core/agents/close.ts).
        case 'agents_cleanup_preview':
          if (this.cleanupPreviewProvider) this.cleanupPreviewProvider(answer)
          else answer({ error: 'UNSUPPORTED' })
          return
        // A close now, once idle or after the task (core/agents/close.ts, bound by cli.ts).
        case 'agent_close':
          if (this.closeProvider) this.closeProvider(payload, answer)
          else answer({ error: 'UNSUPPORTED' })
          return
        // Permanent deletion, reviewed first (core/agents/lifecycle.ts, bound by cli.ts).
        case 'agent_worktree_delete':
        case 'agent_purge':
          if (this.purgeProvider) this.purgeProvider(type, payload, asker, answer)
          else answer({ error: 'UNSUPPORTED' })
          return
        // Stop Harness (core/agents/lifecycle.ts, bound by cli.ts).
        case 'agent_delete':
          answer(this.stopProvider ? await this.stopProvider(payload) : { error: 'UNSUPPORTED' })
          return

        // A saved conversation resumed, or a live process relaunched in its pane (core/agents/launches.ts).
        case 'agent_resume':
        case 'agent_restart':
          if (this.restartProvider) await this.restartProvider(type, payload, answer)
          else answer({ error: 'UNSUPPORTED_ON_REMOTE' })
          return

        // A second agent with the first one's history (core/agents/launches.ts, bound by cli.ts).
        case 'agent_fork':
          if (this.forkProvider) await this.forkProvider(payload, answer)
          else answer({ error: 'UNSUPPORTED_ON_REMOTE' })
          return

        // What a harness's pane runs and where (core/terminals/requests.ts, bound by cli.ts).
        case 'terminal_info':
          if (this.terminalInfoProvider) this.terminalInfoProvider(payload, answer)
          else reply(type, requestId, { error: 'UNSUPPORTED' })
          return

        case 'claude_login_status':
          // Legacy RPC name; report the selected agent's actual engine when one was supplied.
          {
            const target = (payload.agentId as string | undefined) || (payload.sessionId as string | undefined)
            reply(type, requestId, { loggedIn: true, engine: (target ? registry.resolve(target)?.engine : undefined) ?? 'claude', account: hostname() })
          }
          return

        // Text typed for an agent, into its pane (core/input.ts, bound by cli.ts).
        case 'message':
          if (this.messageProvider) this.messageProvider(payload)
          else console.warn('[backend] message handler is not wired; terminal input was not dispatched')
          return

        // A person interrupting an agent's turn (core/turns/cancel.ts, bound by cli.ts).
        case 'cancel': this.cancelProvider?.(payload); return

        // A person's answer to an agent's question, keyed into its dialog (core/questions.ts, bound by cli.ts).
        case 'question_response':
          this.questionProvider?.(payload, answer)
          return

        // The colours the desktop paints its panes with (core/terminals/requests.ts, bound by cli.ts).
        case 'theme_set':
          reply(type, requestId, this.themeProvider ? this.themeProvider(payload) : { error: 'UNSUPPORTED' })
          return

        default:
          // Unknown RPC with a requestId: reject fast so the web promise doesn't wait out its 20s.
          if (requestId !== undefined) reply(type, requestId, { error: 'UNSUPPORTED' })
          return
      }
    } catch (err) {
      // A service on the core boundary that failed or is off (core/serviceHost.ts): the host has logged
      // it, and the client may ask again — the service can be back after the daemon restarts.
      if (err instanceof ServiceUnavailableError) {
        console.warn(`[backend] ${type}: ${err.message}`)
        if (requestId !== undefined) reply(type, requestId, { error: 'SERVICE_UNAVAILABLE', service: err.service, retryable: true })
        return
      }
      console.error(`[backend] dispatch ${type} failed:`, err)
      if (requestId !== undefined) reply(type, requestId, { error: 'INTERNAL' })
    }
  }

  async publishStoppedAgent(s: RegisteredSession): Promise<void> {
    this.send({ type: 'agent_synced', payload: { agent: await this.toStoppedProject(s) } })
    this.sendCommander({ type: 'agent_deleted', payload: { agentId: s.agentId } })
  }

  /** A stopped agent's frame: no pane, no terminal, nothing to fork. */
  async toStoppedProject(s: RegisteredSession): Promise<AgentFrame> {
    const frame = await agentFrame(s, { selectedModel: s.model, terminalAvailable: false, dsh: this.dshFrameProvider?.(s) ?? null,
      tokenUsage: agentTokenUsage.get(s), gridAnnotation: this.gridAnnotation })
    return {
      ...frame,
      status: 'stopped',
      tmuxPane: null,
      terminal: { available: false, primary: '', runtimes: [] },
      viewerUrl: null,
      forkable: false,
    }
  }

  /** Map a registered tmux session onto the web's Project shape (tabs in ProjectTabs). */
  toProject(s: RegisteredSession): Promise<AgentFrame> {
    return agentFrame(s, {
      tokenUsage: agentTokenUsage.get(s),
      selectedModel: this.runtimeProfileProvider?.(s) ?? null,
      terminalAvailable: registry.terminalAvailable(s.agentId),
      dsh: this.dshFrameProvider?.(s) ?? null,
      activity: () => this.activityFrameProvider?.(s) ?? null,
      gridAnnotation: this.gridAnnotation,
    })
  }

  /** What an agent's frame says of the grid it is on: the models service's word, from memory. */
  private readonly gridAnnotation = (grid: Parameters<ModelsPort['annotation']>[0]): ReturnType<ModelsPort['annotation']> =>
    this.models?.().annotation(grid) ?? null
}
